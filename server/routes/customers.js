import { bad, notFound, str, paging, nextCode, textMatch } from '../lib.js';
import { payCustomerDebt } from '../services/sales.js';

const SORTS = {
  newest: 'c.created_at DESC',
  name: 'c.name COLLATE NOCASE ASC',
  debt: 'c.debt DESC',
  sales: 'c.total_sales DESC',
};

function readCustomer(db, body, existing) {
  const out = {
    name: str(body.name, 'Name', { max: 200 }),
    phone: str(body.phone, 'Phone', { optional: true, max: 50 }),
    email: str(body.email, 'Email', { optional: true, max: 200 }),
    address: str(body.address, 'Address', { optional: true, max: 500 }),
    note: str(body.note, 'Note', { optional: true, max: 1000 }),
    type: body.type === 'company' ? 'company' : 'person',
  };
  const code = str(body.code, 'Code', { optional: true, max: 50 }) || existing?.code || nextCode(db, 'KH');
  const dup = db.prepare('SELECT id FROM customers WHERE code = ?').get(code);
  if (dup && dup.id !== existing?.id) throw bad(`Code ${code} is already used`);
  out.code = code;
  return out;
}

export default function customers(app, db) {
  app.get('/api/customers', (c) => {
    const query = c.req.query();
    const { size, offset, page } = paging(query);
    const where = ['1 = 1'];
    const params = [];
    if (query.q) {
      const m = textMatch(query.q, 'customers_fts', 'c.id', ['c.name', 'c.code', 'c.phone']);
      where.push(m.sql);
      params.push(...m.params);
    }
    if (query.debt === '1') where.push('c.debt <> 0');
    const order = SORTS[query.sort] || SORTS.newest;
    const rows = db
      .prepare(
        `SELECT c.id, c.code, c.name, c.phone, c.type, c.debt, c.total_sales, c.created_at
         FROM customers c WHERE ${where.join(' AND ')} ORDER BY ${order}, c.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, size, offset);
    const totals =
      page === 1
        ? db
            .prepare(
              `SELECT COUNT(*) AS count, COALESCE(SUM(debt), 0) AS debt, COALESCE(SUM(total_sales), 0) AS total_sales
               FROM customers c WHERE ${where.join(' AND ')}`
            )
            .get(...params)
        : null;
    return c.json({ rows, totals, page, size });
  });

  app.get('/api/customers/:id', (c) => {
    const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(c.req.param('id'));
    if (!cust) throw notFound('Customer not found');
    cust.stats = db
      .prepare(
        `SELECT COUNT(*) AS invoices, MAX(created_at) AS last_purchase FROM invoices
         WHERE customer_id = ? AND kind = 'invoice' AND status = 'completed'`
      )
      .get(cust.id);
    return c.json(cust);
  });

  app.post('/api/customers', async (c) => {
    const body = await c.req.json();
    const row = db.transaction(() => {
      const cust = readCustomer(db, body);
      return db
        .prepare(
          `INSERT INTO customers (code, name, phone, email, address, note, type, created_at)
           VALUES (@code, @name, @phone, @email, @address, @note, @type, @now) RETURNING id, code, name, phone, debt`
        )
        .get({ ...cust, now: Date.now() });
    })();
    return c.json(row, 201);
  });

  app.put('/api/customers/:id', async (c) => {
    const body = await c.req.json();
    db.transaction(() => {
      const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(c.req.param('id'));
      if (!existing) throw notFound('Customer not found');
      const cust = readCustomer(db, body, existing);
      db.prepare(
        `UPDATE customers SET code = @code, name = @name, phone = @phone, email = @email, address = @address,
           note = @note, type = @type WHERE id = @id`
      ).run({ ...cust, id: existing.id });
    })();
    return c.json({ ok: true });
  });

  app.get('/api/customers/:id/payments', (c) => {
    const { size, offset, page } = paging(c.req.query(), 30);
    const rows = db
      .prepare(
        `SELECT p.*, i.code AS invoice_code FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
         WHERE p.customer_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`
      )
      .all(c.req.param('id'), size + 1, offset);
    return c.json({ rows: rows.slice(0, size), more: rows.length > size, page, size });
  });

  app.post('/api/customers/:id/payments', async (c) => {
    const pay = payCustomerDebt(db, c.get('user'), Number(c.req.param('id')), await c.req.json());
    return c.json(pay, 201);
  });
}
