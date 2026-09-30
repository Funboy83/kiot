import { getSettings } from '../db.js';
import { bad, notFound, nextCode, bizDate, int, str } from '../lib.js';
import { moveStock } from './stock.js';

const METHODS = ['cash', 'card', 'transfer'];

function method(v) {
  const m = v || 'cash';
  if (!METHODS.includes(m)) throw bad('Unknown payment method');
  return m;
}

function insertPayment(db, { customerId, invoiceId, amount, method, userId, note, at, tz }) {
  const code = nextCode(db, amount < 0 ? 'HT' : 'TT');
  const { id } = db
    .prepare(
      `INSERT INTO payments (code, customer_id, invoice_id, amount, method, created_at, biz_date, user_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(code, customerId, invoiceId, amount, method, at, bizDate(at, tz), userId, note);
  return { id, code };
}

/**
 * Creates a sales invoice (moves stock, serials and customer debt) or a sales order
 * (records the request only). Body amounts are integer cents.
 */
export function createSale(db, user, body, opts = {}) {
  const kind = body.kind === 'order' ? 'order' : 'invoice';
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw bad('Add at least one product');
  if (items.length > 500) throw bad('Too many lines');
  const tz = getSettings(db).timezone;

  return db.transaction(() => {
    const at = opts.at ?? Date.now();
    const customerId = int(body.customer_id, 'Customer', { min: 1, optional: true }) ?? null;
    if (customerId && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) {
      throw bad('Customer not found');
    }
    let order = null;
    if (body.order_id != null) {
      order = db.prepare("SELECT * FROM invoices WHERE id = ? AND kind = 'order'").get(body.order_id);
      if (!order) throw bad('Order not found');
      if (order.status !== 'open') throw bad(`Order ${order.code} is already ${order.status}`);
      if (kind !== 'invoice') throw bad('An order can only be turned into an invoice');
    }

    const getProduct = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
    const getSerial = db.prepare('SELECT * FROM serials WHERE serial = ?');
    const lines = items.map((it, i) => {
      const n = `Line ${i + 1}`;
      const product = getProduct.get(int(it.product_id, `${n} product`, { min: 1 }));
      if (!product) throw bad(`${n}: product not found`);
      const qty = int(it.qty, `${n} quantity`, { min: 1, max: 100000 });
      const price = int(it.price ?? product.price, `${n} price`, { min: 0 });
      const discount = int(it.discount ?? 0, `${n} discount`, { min: 0, max: price });
      let serials = [];
      if (kind === 'invoice' && product.track_serial) {
        const list = [...new Set((it.serials || []).map((s) => String(s).trim()).filter(Boolean))];
        if (list.length !== qty) throw bad(`${product.name}: pick ${qty} serial/IMEI (got ${list.length})`);
        serials = list.map((s) => {
          const row = getSerial.get(s);
          if (!row || row.product_id !== product.id) throw bad(`Serial ${s} does not belong to ${product.name}`);
          if (row.status !== 'in_stock') throw bad(`Serial ${s} is not in stock (${row.status})`);
          return row;
        });
      }
      const unitCost = serials.length
        ? Math.round(serials.reduce((a, s) => a + (s.cost ?? product.cost), 0) / serials.length)
        : product.cost;
      return { product, qty, price, discount, serials, unitCost, total: qty * (price - discount) };
    });

    const subtotal = lines.reduce((a, l) => a + l.total, 0);
    const discount = int(body.discount ?? 0, 'Discount', { min: 0, max: subtotal });
    const total = subtotal - discount;
    const given = kind === 'invoice' ? int(body.paid ?? total, 'Paid', { min: 0 }) : 0;
    const paid = Math.min(given, total);
    if (kind === 'invoice' && paid < total && !customerId) {
      throw bad('Pick a customer to sell on credit');
    }
    const costTotal = lines.reduce((a, l) => a + l.unitCost * l.qty, 0);
    const code = nextCode(db, kind === 'order' ? 'DH' : 'HD');
    const status = kind === 'order' ? 'open' : 'completed';
    const note = str(body.note, 'Note', { optional: true, max: 1000 });

    const { id } = db
      .prepare(
        `INSERT INTO invoices (code, kind, status, customer_id, user_id, order_id, created_at, biz_date,
           subtotal, discount, total, paid, cost_total, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(code, kind, status, customerId, user.id, order?.id ?? null, at, bizDate(at, tz),
        subtotal, discount, total, paid, kind === 'invoice' ? costTotal : 0, note);

    const insItem = db.prepare(
      `INSERT INTO invoice_items (invoice_id, product_id, name, qty, price, discount, unit_cost, total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    );
    const sellSerial = db.prepare("UPDATE serials SET status = 'sold', invoice_id = ?, sold_at = ? WHERE id = ?");
    const linkSerial = db.prepare('INSERT INTO invoice_item_serials (item_id, serial_id) VALUES (?, ?)');
    for (const l of lines) {
      const item = insItem.get(id, l.product.id, l.product.name, l.qty, l.price, l.discount, l.unitCost, l.total);
      if (kind !== 'invoice') continue;
      moveStock(db, l.product.id, -l.qty, { type: 'sale', id, code, unitCost: l.unitCost, at });
      for (const s of l.serials) {
        sellSerial.run(id, at, s.id);
        linkSerial.run(item.id, s.id);
      }
    }

    if (kind === 'invoice') {
      if (paid > 0) {
        insertPayment(db, { customerId, invoiceId: id, amount: paid, method: method(body.method), userId: user.id, note: null, at, tz });
      }
      if (customerId) {
        db.prepare('UPDATE customers SET debt = debt + ?, total_sales = total_sales + ? WHERE id = ?')
          .run(total - paid, total, customerId);
      }
      if (order) db.prepare("UPDATE invoices SET status = 'converted' WHERE id = ?").run(order.id);
    }
    return { id, code, total, paid, change: given - paid };
  })();
}

/** Cancels an invoice: stock and serials go back, unpaid balance leaves the customer's debt, paid amount is refunded. */
export function cancelInvoice(db, user, invoiceId, opts = {}) {
  const tz = getSettings(db).timezone;
  return db.transaction(() => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!inv) throw notFound('Invoice not found');
    if (inv.kind === 'order') {
      if (inv.status !== 'open') throw bad(`Order is already ${inv.status}`);
      db.prepare("UPDATE invoices SET status = 'cancelled' WHERE id = ?").run(inv.id);
      return;
    }
    if (inv.status !== 'completed') throw bad('Invoice is already cancelled');
    const at = opts.at ?? Date.now();
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(inv.id);
    for (const it of items) {
      moveStock(db, it.product_id, it.qty, { type: 'cancel', id: inv.id, code: inv.code, unitCost: it.unit_cost, at });
    }
    db.prepare(
      `UPDATE serials SET status = 'in_stock', invoice_id = NULL, sold_at = NULL
       WHERE invoice_id = ? AND status = 'sold'`
    ).run(inv.id);
    if (inv.customer_id) {
      db.prepare('UPDATE customers SET debt = debt - ?, total_sales = total_sales - ? WHERE id = ?')
        .run(inv.total - inv.paid, inv.total, inv.customer_id);
    }
    if (inv.paid > 0) {
      insertPayment(db, { customerId: inv.customer_id, invoiceId: inv.id, amount: -inv.paid, method: 'cash', userId: user.id, note: `Refund for cancelled ${inv.code}`, at, tz });
    }
    db.prepare("UPDATE invoices SET status = 'cancelled' WHERE id = ?").run(inv.id);
    if (inv.order_id) db.prepare("UPDATE invoices SET status = 'open' WHERE id = ? AND status = 'converted'").run(inv.order_id);
  })();
}

/** Collects money against one invoice. */
export function payInvoice(db, user, invoiceId, body, opts = {}) {
  const tz = getSettings(db).timezone;
  return db.transaction(() => {
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ? AND kind = 'invoice'").get(invoiceId);
    if (!inv) throw notFound('Invoice not found');
    if (inv.status !== 'completed') throw bad('Invoice is cancelled');
    const due = inv.total - inv.paid;
    const amount = int(body.amount, 'Amount', { min: 1, max: due });
    const at = opts.at ?? Date.now();
    insertPayment(db, { customerId: inv.customer_id, invoiceId: inv.id, amount, method: method(body.method), userId: user.id, note: str(body.note, 'Note', { optional: true }), at, tz });
    db.prepare('UPDATE invoices SET paid = paid + ? WHERE id = ?').run(amount, inv.id);
    if (inv.customer_id) db.prepare('UPDATE customers SET debt = debt - ? WHERE id = ?').run(amount, inv.customer_id);
  })();
}

/** Collects a debt payment from a customer and applies it to their oldest unpaid invoices first. */
export function payCustomerDebt(db, user, customerId, body, opts = {}) {
  const tz = getSettings(db).timezone;
  return db.transaction(() => {
    const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!cust) throw notFound('Customer not found');
    if (cust.debt <= 0) throw bad('This customer owes nothing');
    const amount = int(body.amount, 'Amount', { min: 1, max: cust.debt });
    const at = opts.at ?? Date.now();
    const pay = insertPayment(db, { customerId, invoiceId: null, amount, method: method(body.method), userId: user.id, note: str(body.note, 'Note', { optional: true }), at, tz });
    const unpaid = db
      .prepare(
        `SELECT id, total - paid AS due FROM invoices
         WHERE customer_id = ? AND kind = 'invoice' AND status = 'completed' AND paid < total
         ORDER BY created_at, id`
      )
      .all(customerId);
    let left = amount;
    const alloc = db.prepare('INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)');
    const bump = db.prepare('UPDATE invoices SET paid = paid + ? WHERE id = ?');
    for (const inv of unpaid) {
      if (left <= 0) break;
      const a = Math.min(left, inv.due);
      alloc.run(pay.id, inv.id, a);
      bump.run(a, inv.id);
      left -= a;
    }
    db.prepare('UPDATE customers SET debt = debt - ? WHERE id = ?').run(amount, customerId);
    return pay;
  })();
}
