import { getSettings } from '../db.js';
import { bad, notFound, nextCode, bizDate, int, str } from '../lib.js';
import { moveStock } from './stock.js';

const cleanSerials = (list) => [...new Set((list || []).map((s) => String(s).trim()).filter(Boolean))];

/** Goods receipt: adds stock, registers serial/IMEI numbers and updates the moving-average cost. */
export function createReceipt(db, user, body, opts = {}) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw bad('Add at least one product');
  const tz = getSettings(db).timezone;
  return db.transaction(() => {
    const at = opts.at ?? Date.now();
    const getProduct = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
    const getSerial = db.prepare('SELECT * FROM serials WHERE serial = ?');
    const seen = new Set();
    const lines = items.map((it, i) => {
      const product = getProduct.get(int(it.product_id, `Line ${i + 1} product`, { min: 1 }));
      if (!product) throw bad(`Line ${i + 1}: product not found`);
      const qty = int(it.qty, `Line ${i + 1} quantity`, { min: 1, max: 1000000 });
      const unitCost = int(it.unit_cost ?? product.cost, `Line ${i + 1} cost`, { min: 0 });
      let serials = [];
      if (product.track_serial) {
        serials = cleanSerials(it.serials);
        if (serials.length !== qty) throw bad(`${product.name}: enter ${qty} serial/IMEI (got ${serials.length})`);
        for (const s of serials) {
          const key = s.toLowerCase();
          if (seen.has(key)) throw bad(`Serial ${s} is entered twice`);
          seen.add(key);
          const row = getSerial.get(s);
          if (row && row.status === 'in_stock') throw bad(`Serial ${s} is already in stock`);
          if (row && row.product_id !== product.id) throw bad(`Serial ${s} belongs to another product`);
        }
      }
      return { product, qty, unitCost, serials };
    });

    const total = lines.reduce((a, l) => a + l.qty * l.unitCost, 0);
    const code = nextCode(db, 'PN');
    const { id } = db
      .prepare(
        `INSERT INTO receipts (code, supplier, created_at, biz_date, total, note, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(code, str(body.supplier, 'Supplier', { optional: true, max: 200 }), at, bizDate(at, tz), total,
        str(body.note, 'Note', { optional: true, max: 1000 }), user.id);

    const insItem = db.prepare('INSERT INTO receipt_items (receipt_id, product_id, qty, unit_cost, total) VALUES (?, ?, ?, ?, ?)');
    const upsertSerial = db.prepare(
      `INSERT INTO serials (product_id, serial, status, cost, receipt_id, received_at)
       VALUES (?, ?, 'in_stock', ?, ?, ?)
       ON CONFLICT(serial) DO UPDATE SET status = 'in_stock', cost = excluded.cost,
         receipt_id = excluded.receipt_id, received_at = excluded.received_at, invoice_id = NULL, sold_at = NULL`
    );
    const setCost = db.prepare('UPDATE products SET cost = ? WHERE id = ?');
    for (const l of lines) {
      insItem.run(id, l.product.id, l.qty, l.unitCost, l.qty * l.unitCost);
      const current = db.prepare('SELECT stock, cost FROM products WHERE id = ?').get(l.product.id);
      const onHand = Math.max(current.stock, 0);
      setCost.run(Math.round((onHand * current.cost + l.qty * l.unitCost) / (onHand + l.qty)), l.product.id);
      moveStock(db, l.product.id, l.qty, { type: 'receipt', id, code, unitCost: l.unitCost, at });
      for (const s of l.serials) upsertSerial.run(l.product.id, s, l.unitCost, id, at);
    }
    return { id, code, total };
  })();
}

function normaliseCountItems(db, items) {
  if (!Array.isArray(items) || !items.length) throw bad('Count at least one product');
  const getProduct = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  const getSerial = db.prepare('SELECT * FROM serials WHERE serial = ?');
  const seenProducts = new Set();
  return items.map((it, i) => {
    const product = getProduct.get(int(it.product_id, `Line ${i + 1} product`, { min: 1 }));
    if (!product) throw bad(`Line ${i + 1}: product not found`);
    if (seenProducts.has(product.id)) throw bad(`${product.name} is listed twice`);
    seenProducts.add(product.id);
    if (!product.track_serial) {
      return { product, actual: int(it.actual_qty, `${product.name} count`, { min: 0 }), serials: null };
    }
    const serials = cleanSerials(it.serials).map((s) => {
      const row = getSerial.get(s);
      if (!row || row.product_id !== product.id) throw bad(`Serial ${s} is not registered for ${product.name}`);
      if (row.status === 'sold') throw bad(`Serial ${s} was sold, it cannot be on the shelf`);
      return row.serial;
    });
    return { product, actual: serials.length, serials };
  });
}

function writeCountItems(db, stockTakeId, lines) {
  db.prepare('DELETE FROM stock_take_items WHERE stock_take_id = ?').run(stockTakeId);
  const ins = db.prepare('INSERT INTO stock_take_items (stock_take_id, product_id, actual_qty, serials) VALUES (?, ?, ?, ?)');
  for (const l of lines) ins.run(stockTakeId, l.product.id, l.actual, l.serials ? JSON.stringify(l.serials) : null);
}

export function createStockTake(db, user, body, opts = {}) {
  return db.transaction(() => {
    const lines = normaliseCountItems(db, body.items);
    const code = nextCode(db, 'KK');
    const { id } = db
      .prepare('INSERT INTO stock_takes (code, note, created_at, user_id) VALUES (?, ?, ?, ?) RETURNING id')
      .get(code, str(body.note, 'Note', { optional: true, max: 1000 }), opts.at ?? Date.now(), user.id);
    writeCountItems(db, id, lines);
    if (body.balance) balance(db, id, opts);
    return { id, code };
  })();
}

export function updateStockTake(db, user, id, body, opts = {}) {
  return db.transaction(() => {
    const st = db.prepare('SELECT * FROM stock_takes WHERE id = ?').get(id);
    if (!st) throw notFound('Stock take not found');
    if (st.status !== 'draft') throw bad('This stock take is already balanced');
    const lines = normaliseCountItems(db, body.items);
    db.prepare('UPDATE stock_takes SET note = ? WHERE id = ?').run(str(body.note, 'Note', { optional: true, max: 1000 }), id);
    writeCountItems(db, id, lines);
    if (body.balance) balance(db, id, opts);
  })();
}

/** Sets stock to the counted quantity. For serial products, unscanned in-stock serials become 'missing'. */
function balance(db, id, opts = {}) {
  const st = db.prepare('SELECT * FROM stock_takes WHERE id = ?').get(id);
  if (st.status !== 'draft') throw bad('This stock take is already balanced');
  const at = opts.at ?? Date.now();
  const items = db
    .prepare(
      `SELECT i.*, p.stock, p.cost, p.track_serial FROM stock_take_items i
       JOIN products p ON p.id = i.product_id WHERE i.stock_take_id = ?`
    )
    .all(id);
  let diffQty = 0;
  let diffValue = 0;
  const setItem = db.prepare('UPDATE stock_take_items SET system_qty = ?, unit_cost = ? WHERE id = ?');
  for (const it of items) {
    setItem.run(it.stock, it.cost, it.id);
    if (it.track_serial) {
      const counted = JSON.parse(it.serials || '[]');
      const placeholders = counted.map(() => '?').join(',') || "''";
      db.prepare(
        `UPDATE serials SET status = 'missing'
         WHERE product_id = ? AND status = 'in_stock' AND serial NOT IN (${placeholders})`
      ).run(it.product_id, ...counted);
      if (counted.length) {
        db.prepare(`UPDATE serials SET status = 'in_stock' WHERE status = 'missing' AND serial IN (${placeholders})`).run(...counted);
      }
    }
    const diff = it.actual_qty - it.stock;
    if (diff !== 0) moveStock(db, it.product_id, diff, { type: 'stocktake', id, code: st.code, unitCost: it.cost, at });
    diffQty += diff;
    diffValue += diff * it.cost;
  }
  db.prepare("UPDATE stock_takes SET status = 'balanced', balanced_at = ?, diff_qty = ?, diff_value = ? WHERE id = ?")
    .run(at, diffQty, diffValue, id);
}
