import { bad, notFound, int, str, paging, nextCode, textMatch } from '../lib.js';
import { moveStock } from '../services/stock.js';

const SORTS = {
  name: 'p.name COLLATE NOCASE ASC',
  newest: 'p.created_at DESC',
  stock: 'p.stock DESC',
  stock_asc: 'p.stock ASC',
  price: 'p.price DESC',
};

function productFilter(query) {
  const where = [query.inactive === '1' ? 'p.active = 0' : 'p.active = 1'];
  const params = [];
  if (query.q) {
    const m = textMatch(query.q, 'products_fts', 'p.id', ['p.name', 'p.sku', 'p.barcode']);
    // A scanned serial/IMEI also finds its product.
    where.push(`(${m.sql} OR p.id IN (SELECT product_id FROM serials WHERE serial = ?))`);
    params.push(...m.params, String(query.q).trim());
  }
  if (query.category) {
    where.push('p.category_id = ?');
    params.push(Number(query.category));
  }
  if (query.stock === 'in') where.push('p.stock > 0');
  if (query.stock === 'out') where.push('p.stock <= 0');
  if (query.stock === 'low') where.push('p.stock <= p.min_stock');
  if (query.stock === 'negative') where.push('p.stock < 0');
  if (query.serial === '1') where.push('p.track_serial = 1');
  return { sql: where.join(' AND '), params };
}

function readProductBody(db, body, existing) {
  const out = {
    name: str(body.name, 'Name', { max: 300 }),
    barcode: str(body.barcode, 'Barcode', { optional: true, max: 100 }),
    brand: str(body.brand, 'Brand', { optional: true, max: 100 }),
    price: int(body.price ?? 0, 'Price', { min: 0 }),
    cost: int(body.cost ?? existing?.cost ?? 0, 'Cost', { min: 0 }),
    min_stock: int(body.min_stock ?? 0, 'Minimum stock', { min: 0 }),
    track_serial: body.track_serial ? 1 : 0,
    attributes: JSON.stringify(cleanAttributes(body.attributes)),
  };
  let sku = str(body.sku, 'SKU', { optional: true, max: 100 });
  if (!sku) sku = existing?.sku ?? nextCode(db, 'SP');
  out.sku = sku;
  const dup = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
  if (dup && dup.id !== existing?.id) throw bad(`SKU ${sku} is already used`);
  if (body.category_name) {
    const name = str(body.category_name, 'Category', { max: 100 });
    db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(name);
    out.category_id = db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
  } else {
    out.category_id = int(body.category_id, 'Category', { min: 1, optional: true }) ?? null;
  }
  return out;
}

function cleanAttributes(attrs) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return {};
  const out = {};
  for (const [k, v] of Object.entries(attrs).slice(0, 30)) {
    const key = String(k).trim().slice(0, 50);
    const val = String(v ?? '').trim().slice(0, 200);
    if (key && val) out[key] = val;
  }
  return out;
}

export default function products(app, db) {
  app.get('/api/categories', (c) =>
    c.json(
      db.prepare(
        `SELECT c.id, c.name, COUNT(p.id) AS products FROM categories c
         LEFT JOIN products p ON p.category_id = c.id AND p.active = 1
         GROUP BY c.id ORDER BY c.name COLLATE NOCASE`
      ).all()
    )
  );

  app.post('/api/categories', async (c) => {
    const name = str((await c.req.json()).name, 'Name', { max: 100 });
    db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(name);
    return c.json(db.prepare('SELECT * FROM categories WHERE name = ?').get(name));
  });

  app.get('/api/products', (c) => {
    const query = c.req.query();
    const { size, offset, page } = paging(query);
    const f = productFilter(query);
    const order = SORTS[query.sort] || SORTS.newest;
    const rows = db
      .prepare(
        `SELECT p.id, p.sku, p.barcode, p.name, p.price, p.cost, p.stock, p.min_stock, p.track_serial,
                p.brand, p.created_at, c.name AS category
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         WHERE ${f.sql} ORDER BY ${order}, p.id DESC LIMIT ? OFFSET ?`
      )
      .all(...f.params, size, offset);
    // Totals row (KiotViet shows these above the table); skipped on later pages to keep paging cheap.
    const totals =
      page === 1 || query.totals === '1'
        ? db
            .prepare(
              `SELECT COUNT(*) AS count, COALESCE(SUM(p.stock), 0) AS stock,
                      COALESCE(SUM(MAX(p.stock, 0) * p.cost), 0) AS stock_value
               FROM products p WHERE ${f.sql}`
            )
            .get(...f.params)
        : null;
    return c.json({ rows, totals, page, size });
  });

  app.get('/api/products/lookup', (c) => {
    const code = String(c.req.query('code') || '').trim();
    if (!code) throw bad('Code is required');
    const cols = 'id, sku, barcode, name, price, cost, stock, track_serial';
    let product = db.prepare(`SELECT ${cols} FROM products WHERE active = 1 AND (barcode = ? OR sku = ?) LIMIT 1`).get(code, code);
    let serial = null;
    if (!product) {
      const s = db.prepare('SELECT serial, status, product_id FROM serials WHERE serial = ?').get(code);
      if (s) {
        product = db.prepare(`SELECT ${cols} FROM products WHERE id = ? AND active = 1`).get(s.product_id);
        serial = { serial: s.serial, status: s.status };
      }
    }
    if (!product) throw notFound(`Nothing matches ${code}`);
    return c.json({ product, serial });
  });

  app.get('/api/products/:id', (c) => {
    const p = db
      .prepare(
        `SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`
      )
      .get(c.req.param('id'));
    if (!p) throw notFound('Product not found');
    p.attributes = JSON.parse(p.attributes || '{}');
    p.serial_counts = Object.fromEntries(
      db.prepare('SELECT status, COUNT(*) AS n FROM serials WHERE product_id = ? GROUP BY status').all(p.id).map((r) => [r.status, r.n])
    );
    return c.json(p);
  });

  app.get('/api/products/:id/moves', (c) => {
    const { size, offset, page } = paging(c.req.query(), 30);
    const rows = db
      .prepare('SELECT * FROM stock_moves WHERE product_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(c.req.param('id'), size + 1, offset);
    return c.json({ rows: rows.slice(0, size), more: rows.length > size, page, size });
  });

  app.get('/api/products/:id/serials', (c) => {
    const query = c.req.query();
    const { size, offset, page } = paging(query, 50);
    const where = ['s.product_id = ?'];
    const params = [c.req.param('id')];
    if (query.status) {
      where.push('s.status = ?');
      params.push(query.status);
    }
    if (query.q) {
      where.push("s.serial LIKE ? ESCAPE '\\'");
      params.push('%' + String(query.q).replace(/[\\%_]/g, (m) => '\\' + m) + '%');
    }
    const rows = db
      .prepare(
        `SELECT s.id, s.serial, s.status, s.cost, s.received_at, s.sold_at, s.invoice_id,
                i.code AS invoice_code, r.code AS receipt_code, s.receipt_id
         FROM serials s LEFT JOIN invoices i ON i.id = s.invoice_id LEFT JOIN receipts r ON r.id = s.receipt_id
         WHERE ${where.join(' AND ')} ORDER BY s.status = 'in_stock' DESC, s.received_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, size + 1, offset);
    return c.json({ rows: rows.slice(0, size), more: rows.length > size, page, size });
  });

  app.post('/api/products', async (c) => {
    const body = await c.req.json();
    const id = db.transaction(() => {
      const p = readProductBody(db, body);
      const now = Date.now();
      const { id } = db
        .prepare(
          `INSERT INTO products (sku, barcode, name, category_id, brand, price, cost, min_stock, track_serial, attributes, created_at, updated_at)
           VALUES (@sku, @barcode, @name, @category_id, @brand, @price, @cost, @min_stock, @track_serial, @attributes, @now, @now) RETURNING id`
        )
        .get({ ...p, now });
      const opening = int(body.stock ?? 0, 'Opening stock', { min: 0 });
      if (opening > 0) {
        if (p.track_serial) throw bad('Serial products get stock through a goods receipt, so their serials are recorded');
        moveStock(db, id, opening, { type: 'initial', unitCost: p.cost, at: now });
      }
      return id;
    })();
    return c.json({ id }, 201);
  });

  app.put('/api/products/:id', async (c) => {
    const body = await c.req.json();
    db.transaction(() => {
      const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(c.req.param('id'));
      if (!existing) throw notFound('Product not found');
      const p = readProductBody(db, body, existing);
      if (p.track_serial !== existing.track_serial && existing.stock !== 0) {
        throw bad('Serial tracking can only be switched while stock is 0');
      }
      db.prepare(
        `UPDATE products SET sku = @sku, barcode = @barcode, name = @name, category_id = @category_id, brand = @brand,
           price = @price, cost = @cost, min_stock = @min_stock, track_serial = @track_serial, attributes = @attributes,
           updated_at = @now WHERE id = @id`
      ).run({ ...p, id: existing.id, now: Date.now() });
    })();
    return c.json({ ok: true });
  });

  app.delete('/api/products/:id', (c) => {
    const r = db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(Date.now(), c.req.param('id'));
    if (!r.changes) throw notFound('Product not found');
    return c.json({ ok: true });
  });

  app.post('/api/products/:id/restore', (c) => {
    db.prepare('UPDATE products SET active = 1, updated_at = ? WHERE id = ?').run(Date.now(), c.req.param('id'));
    return c.json({ ok: true });
  });
}
