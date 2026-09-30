import { textMatch } from '../lib.js';

/** One search box for everything: products, customers, invoice codes and serial/IMEI numbers. */
export default function search(app, db) {
  app.get('/api/search', (c) => {
    const q = String(c.req.query('q') || '').trim();
    if (!q) return c.json({ products: [], customers: [], invoices: [], serials: [] });
    const pm = textMatch(q, 'products_fts', 'id', ['name', 'sku', 'barcode']);
    const cm = textMatch(q, 'customers_fts', 'id', ['name', 'code', 'phone']);
    const upper = q.toUpperCase();
    return c.json({
      products: db
        .prepare(`SELECT id, sku, name, price, stock FROM products WHERE active = 1 AND ${pm.sql} ORDER BY name LIMIT 6`)
        .all(...pm.params),
      customers: db
        .prepare(`SELECT id, code, name, phone, debt FROM customers WHERE ${cm.sql} ORDER BY name LIMIT 6`)
        .all(...cm.params),
      invoices: /\d/.test(q)
        ? db
            .prepare(
              `SELECT id, code, kind, status, total, created_at FROM invoices WHERE code = ? OR code LIKE ?
               ORDER BY created_at DESC LIMIT 6`
            )
            .all(upper, '%' + upper.replace(/[\\%_]/g, '')) 
        : [],
      serials: q.length >= 4
        ? db
            .prepare(
              `SELECT s.serial, s.status, s.product_id, p.name, s.invoice_id, i.code AS invoice_code
               FROM serials s JOIN products p ON p.id = s.product_id LEFT JOIN invoices i ON i.id = s.invoice_id
               WHERE s.serial LIKE ? ESCAPE '\\' LIMIT 6`
            )
            .all(q.replace(/[\\%_]/g, (m) => '\\' + m) + '%')
        : [],
    });
  });
}
