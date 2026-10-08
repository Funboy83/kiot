import { requireAdmin } from '../auth.js';
import { bad, paging, isDate, storeToday, addDays } from '../lib.js';

function range(query, db) {
  const today = storeToday(db);
  const from = isDate(query.from) ? query.from : addDays(today, -29);
  const to = isDate(query.to) ? query.to : today;
  if (from > to) throw bad('Start date is after end date');
  return { from, to };
}

// Revenue per line after spreading the invoice-level discount over its lines.
const LINE_REVENUE = 'CASE WHEN i.subtotal > 0 THEN ii.total * 1.0 * i.total / i.subtotal ELSE 0 END';

export default function reports(app, db) {
  app.get('/api/reports/dashboard', (c) => {
    const today = storeToday(db);
    const monthStart = today.slice(0, 8) + '01';
    // Same span of days in the previous month, for the "vs last month" comparison.
    const d = new Date(monthStart + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - 1);
    const prevStart = d.toISOString().slice(0, 10);
    const dayOfMonth = Number(today.slice(8));
    const prevEnd = addDays(prevStart, dayOfMonth - 1) >= monthStart ? addDays(monthStart, -1) : addDays(prevStart, dayOfMonth - 1);

    const sum = db.prepare(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(total - cost_total), 0) AS profit
       FROM invoices WHERE kind = 'invoice' AND status = 'completed' AND biz_date BETWEEN ? AND ?`
    );
    const todayStats = sum.get(today, today);
    const month = sum.get(monthStart, today);
    const prevMonth = sum.get(prevStart, prevEnd);
    const daily = db
      .prepare(
        `SELECT biz_date AS day, SUM(total) AS revenue, COUNT(*) AS invoices FROM invoices
         WHERE kind = 'invoice' AND status = 'completed' AND biz_date BETWEEN ? AND ? GROUP BY biz_date ORDER BY biz_date`
      )
      .all(addDays(today, -29), today);
    const topProducts = db
      .prepare(
        `SELECT p.id, p.name, SUM(ii.qty) AS qty, ROUND(SUM(${LINE_REVENUE})) AS revenue
         FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id JOIN products p ON p.id = ii.product_id
         WHERE i.kind = 'invoice' AND i.status = 'completed' AND i.biz_date BETWEEN ? AND ?
         GROUP BY p.id ORDER BY revenue DESC LIMIT 10`
      )
      .all(monthStart, today);
    const topCustomers = db
      .prepare(
        `SELECT cu.id, cu.name, SUM(i.total) AS revenue, COUNT(*) AS invoices
         FROM invoices i JOIN customers cu ON cu.id = i.customer_id
         WHERE i.kind = 'invoice' AND i.status = 'completed' AND i.biz_date BETWEEN ? AND ?
         GROUP BY cu.id ORDER BY revenue DESC LIMIT 10`
      )
      .all(monthStart, today);
    const receivable = db.prepare('SELECT COALESCE(SUM(debt), 0) AS debt, COUNT(*) AS customers FROM customers WHERE debt > 0').get();
    const stock = db
      .prepare(
        `SELECT SUM(stock <= min_stock AND stock > 0) AS low, SUM(stock <= 0) AS out,
                COALESCE(SUM(MAX(stock, 0) * cost), 0) AS value FROM products WHERE active = 1`
      )
      .get();
    const recent = db
      .prepare(
        `SELECT * FROM (
           SELECT 'invoice' AS type, i.id, i.code, i.total AS amount, i.created_at, i.status, cu.name AS party
           FROM invoices i LEFT JOIN customers cu ON cu.id = i.customer_id
           WHERE i.kind = 'invoice' ORDER BY i.created_at DESC LIMIT 12)
         UNION ALL SELECT * FROM (
           SELECT 'receipt', r.id, r.code, r.total, r.created_at, 'completed', r.supplier FROM receipts r
           ORDER BY r.created_at DESC LIMIT 12)
         ORDER BY created_at DESC LIMIT 12`
      )
      .all();
    return c.json({ today, todayStats, month, prevMonth, daily, topProducts, topCustomers, receivable, stock, recent });
  });

  app.get('/api/reports/sales', (c) => {
    requireAdmin(c);
    const { from, to } = range(c.req.query(), db);
    const rows = db
      .prepare(
        `SELECT biz_date AS day, COUNT(*) AS invoices, SUM(subtotal) AS subtotal, SUM(discount) AS discount,
                SUM(total) AS revenue, SUM(cost_total) AS cost, SUM(total - cost_total) AS profit, SUM(paid) AS paid
         FROM invoices WHERE kind = 'invoice' AND status = 'completed' AND biz_date BETWEEN ? AND ?
         GROUP BY biz_date ORDER BY biz_date DESC`
      )
      .all(from, to);
    const totals = rows.reduce(
      (t, r) => {
        for (const k of ['invoices', 'subtotal', 'discount', 'revenue', 'cost', 'profit', 'paid']) t[k] += r[k];
        return t;
      },
      { invoices: 0, subtotal: 0, discount: 0, revenue: 0, cost: 0, profit: 0, paid: 0 }
    );
    return c.json({ from, to, rows, totals });
  });

  app.get('/api/reports/products', (c) => {
    requireAdmin(c);
    const query = c.req.query();
    const { from, to } = range(query, db);
    const { size, offset, page } = paging(query, 50);
    const order = { revenue: 'revenue DESC', qty: 'qty DESC', profit: 'profit DESC' }[query.sort] || 'revenue DESC';
    const base = `FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
                  WHERE i.kind = 'invoice' AND i.status = 'completed' AND i.biz_date BETWEEN ? AND ?`;
    const rows = db
      .prepare(
        `SELECT p.id, p.sku, p.name, t.qty, t.revenue, t.cost, t.revenue - t.cost AS profit FROM (
           SELECT ii.product_id, SUM(ii.qty) AS qty, ROUND(SUM(${LINE_REVENUE})) AS revenue,
                  SUM(ii.qty * ii.unit_cost) AS cost ${base} GROUP BY ii.product_id
         ) t JOIN products p ON p.id = t.product_id ORDER BY ${order} LIMIT ? OFFSET ?`
      )
      .all(from, to, size, offset);
    const totals =
      page === 1
        ? db
            .prepare(
              `SELECT COUNT(DISTINCT ii.product_id) AS count, COALESCE(SUM(ii.qty), 0) AS qty,
                      COALESCE(ROUND(SUM(${LINE_REVENUE})), 0) AS revenue, COALESCE(SUM(ii.qty * ii.unit_cost), 0) AS cost ${base}`
            )
            .get(from, to)
        : null;
    if (totals) totals.profit = totals.revenue - totals.cost;
    return c.json({ from, to, rows, totals, page, size });
  });

  // Receivables ageing: each customer's unpaid balance split by how old the invoice is.
  app.get('/api/reports/debt', (c) => {
    const today = storeToday(db);
    const rows = db
      .prepare(
        `SELECT cu.id, cu.code, cu.name, cu.phone, cu.debt,
                SUM(CASE WHEN age <= 30 THEN due ELSE 0 END) AS d0_30,
                SUM(CASE WHEN age BETWEEN 31 AND 60 THEN due ELSE 0 END) AS d31_60,
                SUM(CASE WHEN age BETWEEN 61 AND 90 THEN due ELSE 0 END) AS d61_90,
                SUM(CASE WHEN age > 90 THEN due ELSE 0 END) AS d90,
                MIN(biz_date) AS oldest
         FROM (SELECT customer_id, total - paid AS due, biz_date,
                      CAST(julianday(?) - julianday(biz_date) AS INTEGER) AS age
               FROM invoices WHERE kind = 'invoice' AND status = 'completed' AND paid < total AND customer_id IS NOT NULL) u
         JOIN customers cu ON cu.id = u.customer_id
         GROUP BY cu.id ORDER BY cu.debt DESC`
      )
      .all(today);
    const totals = rows.reduce(
      (t, r) => {
        for (const k of ['debt', 'd0_30', 'd31_60', 'd61_90', 'd90']) t[k] += r[k];
        return t;
      },
      { debt: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 }
    );
    return c.json({ today, rows, totals });
  });
}
