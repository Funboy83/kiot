import { notFound, paging, isDate, textMatch, ftsQuery } from '../lib.js';
import { createSale, cancelInvoice, payInvoice } from '../services/sales.js';

const SOLD_WITH_SERIAL = `SELECT ii.invoice_id FROM serials s JOIN invoice_item_serials x ON x.serial_id = s.id
  JOIN invoice_items ii ON ii.id = x.item_id WHERE s.serial = ?`;

export default function invoices(app, db) {
  app.get('/api/invoices', (c) => {
    const query = c.req.query();
    const { size, offset, page } = paging(query);
    const where = ['i.kind = ?'];
    const params = [query.kind === 'order' ? 'order' : 'invoice'];
    if (query.status) {
      const list = String(query.status).split(',').slice(0, 5);
      where.push(`i.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (isDate(query.from)) {
      where.push('i.biz_date >= ?');
      params.push(query.from);
    }
    if (isDate(query.to)) {
      where.push('i.biz_date <= ?');
      params.push(query.to);
    }
    if (query.customer_id) {
      where.push('i.customer_id = ?');
      params.push(Number(query.customer_id));
    }
    if (query.unpaid === '1') where.push("i.status = 'completed' AND i.paid < i.total");
    let needCustomerJoin = false;
    if (query.q) {
      const q = String(query.q).trim();
      if (/^[a-z]{2}\d{3,}$/i.test(q)) {
        // Looks like a document code (HD000123): exact match on the unique index.
        where.push(`(i.code = ? OR i.id IN (${SOLD_WITH_SERIAL}))`);
        params.push(q.toUpperCase(), q);
      } else {
        const m = textMatch(q, 'customers_fts', 'i.customer_id', ['cu.name', 'cu.code', 'cu.phone']);
        where.push(`(${m.sql} OR i.id IN (${SOLD_WITH_SERIAL})${/^\d+$/.test(q) ? ' OR i.code LIKE ?' : ''})`);
        params.push(...m.params, q);
        if (/^\d+$/.test(q)) params.push('%' + q);
        needCustomerJoin = !ftsQuery(q);
      }
    }
    const w = where.join(' AND ');
    const rows = db
      .prepare(
        `SELECT i.id, i.code, i.kind, i.status, i.created_at, i.subtotal, i.discount, i.total, i.paid,
                cu.id AS customer_id, cu.code AS customer_code, cu.name AS customer_name, u.name AS user_name
         FROM invoices i LEFT JOIN customers cu ON cu.id = i.customer_id LEFT JOIN users u ON u.id = i.user_id
         WHERE ${w} ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, size, offset);
    const totals =
      page === 1
        ? db
            .prepare(
              `SELECT COUNT(*) AS count, COALESCE(SUM(i.subtotal), 0) AS subtotal, COALESCE(SUM(i.discount), 0) AS discount,
                      COALESCE(SUM(i.total), 0) AS total, COALESCE(SUM(i.paid), 0) AS paid
               FROM invoices i ${needCustomerJoin ? 'LEFT JOIN customers cu ON cu.id = i.customer_id' : ''} WHERE ${w}`
            )
            .get(...params)
        : null;
    return c.json({ rows, totals, page, size });
  });

  app.get('/api/invoices/:id', (c) => {
    const id = c.req.param('id');
    const inv = db
      .prepare(
        `SELECT i.*, u.name AS user_name, o.code AS order_code,
                cu.code AS customer_code, cu.name AS customer_name, cu.phone AS customer_phone,
                cu.address AS customer_address, cu.debt AS customer_debt
         FROM invoices i LEFT JOIN users u ON u.id = i.user_id LEFT JOIN invoices o ON o.id = i.order_id
         LEFT JOIN customers cu ON cu.id = i.customer_id
         WHERE ${/^\d+$/.test(id) ? 'i.id = ?' : 'i.code = ?'}`
      )
      .get(id);
    if (!inv) throw notFound('Invoice not found');
    inv.items = db
      .prepare(
        `SELECT ii.*, p.sku, p.track_serial FROM invoice_items ii JOIN products p ON p.id = ii.product_id
         WHERE ii.invoice_id = ? ORDER BY ii.id`
      )
      .all(inv.id);
    const serials = db
      .prepare(
        `SELECT x.item_id, s.serial FROM invoice_item_serials x JOIN serials s ON s.id = x.serial_id
         JOIN invoice_items ii ON ii.id = x.item_id WHERE ii.invoice_id = ? ORDER BY s.serial`
      )
      .all(inv.id);
    for (const it of inv.items) it.serials = serials.filter((s) => s.item_id === it.id).map((s) => s.serial);
    inv.payments = db
      .prepare(
        `SELECT p.code, p.amount, p.method, p.created_at, p.note FROM payments p WHERE p.invoice_id = ?
         UNION ALL
         SELECT p.code, a.amount, p.method, p.created_at, 'Debt payment' FROM payment_allocations a
         JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = ?
         ORDER BY created_at`
      )
      .all(inv.id, inv.id);
    inv.converted_to = inv.kind === 'order'
      ? db.prepare("SELECT id, code FROM invoices WHERE order_id = ? AND status = 'completed'").get(inv.id) ?? null
      : null;
    return c.json(inv);
  });

  app.post('/api/invoices', async (c) => c.json(createSale(db, c.get('user'), await c.req.json()), 201));

  app.post('/api/invoices/:id/cancel', (c) => {
    cancelInvoice(db, c.get('user'), Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  app.post('/api/invoices/:id/pay', async (c) => {
    payInvoice(db, c.get('user'), Number(c.req.param('id')), await c.req.json());
    return c.json({ ok: true });
  });
}
