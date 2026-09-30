// Read-only tools the assistant can call. Every tool only reads; money goes out in currency
// units (not cents) so the model never has to convert. Tools that return lists also return a
// `table` that the chat panel shows in full with sorting and export.
import { storeToday, addDays, isDate, textMatch } from '../lib.js';
import { MAX_ROWS } from './readonly-sql.js';

const LINE_REVENUE = 'CASE WHEN i.subtotal > 0 THEN ii.total * 1.0 * i.total / i.subtotal ELSE 0 END';
const SOLD = "i.kind = 'invoice' AND i.status = 'completed'";
const $ = (cents) => (cents == null ? null : Math.round(cents) / 100);
const pct = (a, b) => (b ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null);

export class ToolInputError extends Error {}

function dateArg(v, name, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (!isDate(v)) throw new ToolInputError(`${name} must be YYYY-MM-DD`);
  return v;
}
function range(db, input, defaultDays = 30) {
  const today = storeToday(db);
  const to = dateArg(input.to, 'to', today);
  const from = dateArg(input.from, 'from', addDays(to, -(defaultDays - 1)));
  if (from > to) throw new ToolInputError('from is after to');
  return { from, to };
}
function limitArg(v, def = 20, max = 500) {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ToolInputError('limit must be a positive whole number');
  return Math.min(n, max);
}
function oneOf(v, name, options, def) {
  if (v === undefined || v === null || v === '') return def;
  if (!options.includes(v)) throw new ToolInputError(`${name} must be one of: ${options.join(', ')}`);
  return v;
}
function text(v, name, { optional = false } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (optional) return null;
    throw new ToolInputError(`${name} is required`);
  }
  return String(v).trim().slice(0, 200);
}

/** column spec helper: [key, label, type] */
const cols = (...specs) => specs.map(([key, label, type = 'text']) => ({ key, label, type }));

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
}

// ---------------------------------------------------------------------------------------------

const salesSummary = {
  def: {
    name: 'sales_summary',
    description:
      'Totals for completed sales invoices in a date range (inclusive, store-local days): revenue, invoice count, average invoice, discounts, amount paid vs left as debt, cancelled invoices, and the same figures for the previous period of equal length with % change. Use for "how did we do today/this week/this month", comparisons, and KPIs.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start day YYYY-MM-DD. Defaults to 30 days before `to`.' },
        to: { type: 'string', description: 'End day YYYY-MM-DD. Defaults to today.' },
        compare_from: { type: 'string', description: 'Optional start of a custom comparison period (YYYY-MM-DD); with compare_to.' },
        compare_to: { type: 'string', description: 'Optional end of the custom comparison period.' },
      },
    },
  },
  run(db, input, { admin }) {
    const { from, to } = range(db, input);
    const span = daysBetween(from, to) + 1;
    const cFrom = dateArg(input.compare_from, 'compare_from', addDays(from, -span));
    const cTo = dateArg(input.compare_to, 'compare_to', addDays(from, -1));
    const q = db.prepare(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(discount), 0) AS discount,
              COALESCE(SUM(paid), 0) AS paid, COALESCE(SUM(total - cost_total), 0) AS profit,
              COUNT(DISTINCT customer_id) AS customers
       FROM invoices WHERE kind = 'invoice' AND status = 'completed' AND biz_date BETWEEN ? AND ?`
    );
    const cancelled = db.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM invoices WHERE kind = 'invoice' AND status = 'cancelled' AND biz_date BETWEEN ? AND ?"
    );
    const shape = (r, c) => {
      const out = {
        revenue: $(r.revenue),
        invoices: r.invoices,
        average_invoice: r.invoices ? $(r.revenue / r.invoices) : 0,
        discounts_given: $(r.discount),
        collected_at_sale: $(r.paid),
        left_as_customer_debt: $(r.revenue - r.paid),
        named_customers: r.customers,
        cancelled_invoices: c.n,
        cancelled_value: $(c.total),
      };
      if (admin) {
        out.gross_profit = $(r.profit);
        out.margin_pct = r.revenue ? Math.round((r.profit / r.revenue) * 1000) / 10 : null;
      }
      return out;
    };
    const cur = shape(q.get(from, to), cancelled.get(from, to));
    const prev = shape(q.get(cFrom, cTo), cancelled.get(cFrom, cTo));
    const change = {};
    for (const k of ['revenue', 'invoices', 'average_invoice', 'gross_profit']) if (k in cur) change[k + '_pct'] = pct(cur[k], prev[k]);
    return { period: { from, to, days: span }, ...cur, previous_period: { from: cFrom, to: cTo, ...prev }, change_vs_previous: change };
  },
};

const salesTrend = {
  def: {
    name: 'sales_trend',
    description:
      'Revenue and invoice count over time, grouped by day, ISO week, month, hour of day, or weekday. Good for charts and spotting busy/slow periods.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start day YYYY-MM-DD (default 30 days before `to`).' },
        to: { type: 'string', description: 'End day YYYY-MM-DD (default today).' },
        by: { type: 'string', enum: ['day', 'week', 'month', 'hour', 'weekday'], description: 'Grouping (default day).' },
      },
    },
  },
  run(db, input, { admin, tz }) {
    const { from, to } = range(db, input);
    const by = oneOf(input.by, 'by', ['day', 'week', 'month', 'hour', 'weekday'], 'day');
    const profit = admin ? ', SUM(total - cost_total) AS profit' : '';
    let rows;
    if (by === 'hour' || by === 'weekday') {
      // Hour/weekday need the store-local clock time, which SQLite cannot convert; group in JS.
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
      const buckets = new Map();
      const order = by === 'hour' ? [...Array(24).keys()].map(String) : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      for (const k of order) buckets.set(k, { period: by === 'hour' ? `${k.padStart(2, '0')}:00` : k, revenue: 0, invoices: 0, profit: 0 });
      const it = db
        .prepare("SELECT created_at, total, cost_total FROM invoices WHERE kind = 'invoice' AND status = 'completed' AND biz_date BETWEEN ? AND ?")
        .iterate(from, to);
      for (const r of it) {
        const parts = Object.fromEntries(fmt.formatToParts(r.created_at).map((p) => [p.type, p.value]));
        const b = buckets.get(by === 'hour' ? String(Number(parts.hour)) : parts.weekday);
        b.revenue += r.total;
        b.invoices += 1;
        b.profit += r.total - r.cost_total;
      }
      rows = [...buckets.values()].filter((b) => by === 'weekday' || b.invoices > 0);
    } else {
      const key = { day: 'biz_date', week: "strftime('%Y-W%W', biz_date)", month: "substr(biz_date, 1, 7)" }[by];
      rows = db
        .prepare(
          `SELECT ${key} AS period, SUM(total) AS revenue, COUNT(*) AS invoices${profit}
           FROM invoices WHERE kind = 'invoice' AND status = 'completed' AND biz_date BETWEEN ? AND ?
           GROUP BY period ORDER BY period`
        )
        .all(from, to);
      if (by === 'day') {
        // Fill empty days so charts show gaps honestly.
        const map = new Map(rows.map((r) => [r.period, r]));
        rows = [];
        for (let d = from; d <= to; d = addDays(d, 1)) rows.push(map.get(d) || { period: d, revenue: 0, invoices: 0, profit: 0 });
      }
    }
    rows = rows.map((r) => ({ period: r.period, revenue: $(r.revenue), invoices: r.invoices, ...(admin ? { profit: $(r.profit || 0) } : {}) }));
    return {
      summary: { from, to, by, total_revenue: Math.round(rows.reduce((s, r) => s + r.revenue, 0) * 100) / 100 },
      table: {
        title: `Sales by ${by}, ${from} – ${to}`,
        columns: cols(['period', by === 'day' ? 'Day' : 'Period', 'text'], ['revenue', 'Revenue', 'money'], ['invoices', 'Invoices', 'number'], ...(admin ? [['profit', 'Profit', 'money']] : [])),
        rows,
      },
    };
  },
};

const topProducts = {
  def: {
    name: 'top_products',
    description:
      'Best (or worst) selling products in a date range by revenue, quantity or profit, optionally within one category. Includes quantity sold, revenue, current stock and share of total revenue.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start day YYYY-MM-DD (default 30 days before `to`).' },
        to: { type: 'string', description: 'End day YYYY-MM-DD (default today).' },
        sort: { type: 'string', enum: ['revenue', 'qty', 'profit'], description: 'Ranking measure (default revenue).' },
        order: { type: 'string', enum: ['top', 'bottom'], description: 'top = best sellers (default), bottom = weakest among products that sold.' },
        category: { type: 'string', description: 'Optional category name, e.g. "iPhone".' },
        limit: { type: 'integer', description: 'Rows to return (default 10).' },
      },
    },
  },
  run(db, input, { admin }) {
    const { from, to } = range(db, input);
    let sort = oneOf(input.sort, 'sort', ['revenue', 'qty', 'profit'], 'revenue');
    if (sort === 'profit' && !admin) sort = 'revenue';
    const dir = oneOf(input.order, 'order', ['top', 'bottom'], 'top') === 'top' ? 'DESC' : 'ASC';
    const limit = limitArg(input.limit, 10);
    const category = text(input.category, 'category', { optional: true });
    const params = [from, to];
    let catSql = '';
    if (category) {
      catSql = 'AND p.category_id IN (SELECT id FROM categories WHERE name LIKE ?)';
      params.push(category);
    }
    const base = `FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id JOIN products p ON p.id = ii.product_id
                  WHERE ${SOLD} AND i.biz_date BETWEEN ? AND ? ${catSql}`;
    const total = db.prepare(`SELECT COALESCE(SUM(${LINE_REVENUE}), 0) AS revenue ${base}`).get(...params).revenue;
    const rows = db
      .prepare(
        `SELECT p.sku, p.name, c.name AS category, SUM(ii.qty) AS qty, SUM(${LINE_REVENUE}) AS revenue,
                SUM(${LINE_REVENUE}) - SUM(ii.qty * ii.unit_cost) AS profit, p.stock
         ${base.replace('JOIN products p ON p.id = ii.product_id', 'JOIN products p ON p.id = ii.product_id LEFT JOIN categories c ON c.id = p.category_id')}
         GROUP BY p.id ORDER BY ${sort} ${dir} LIMIT ?`
      )
      .all(...params, limit)
      .map((r) => ({
        sku: r.sku,
        name: r.name,
        category: r.category,
        qty: r.qty,
        revenue: $(r.revenue),
        ...(admin ? { profit: $(r.profit) } : {}),
        share_pct: total ? Math.round((r.revenue / total) * 1000) / 10 : 0,
        stock: r.stock,
      }));
    return {
      summary: { from, to, sort, order: dir === 'DESC' ? 'top' : 'bottom', category, total_revenue_in_scope: $(total) },
      table: {
        title: `${dir === 'DESC' ? 'Top' : 'Bottom'} products by ${sort}, ${from} – ${to}`,
        columns: cols(['name', 'Product'], ['sku', 'SKU'], ['category', 'Category'], ['qty', 'Qty sold', 'number'], ['revenue', 'Revenue', 'money'], ...(admin ? [['profit', 'Profit', 'money']] : []), ['share_pct', 'Share %', 'percent'], ['stock', 'In stock', 'number']),
        rows,
      },
    };
  },
};

const topCustomers = {
  def: {
    name: 'top_customers',
    description: 'Customers ranked by what they bought in a date range, with invoice count, last purchase day and current debt.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start day YYYY-MM-DD (default 30 days before `to`).' },
        to: { type: 'string', description: 'End day YYYY-MM-DD (default today).' },
        limit: { type: 'integer', description: 'Rows (default 10).' },
      },
    },
  },
  run(db, input) {
    const { from, to } = range(db, input);
    const rows = db
      .prepare(
        `SELECT cu.code, cu.name, cu.phone, COUNT(*) AS invoices, SUM(i.total) AS revenue, MAX(i.biz_date) AS last_purchase, cu.debt
         FROM invoices i JOIN customers cu ON cu.id = i.customer_id
         WHERE ${SOLD} AND i.biz_date BETWEEN ? AND ?
         GROUP BY cu.id ORDER BY revenue DESC LIMIT ?`
      )
      .all(from, to, limitArg(input.limit, 10))
      .map((r) => ({ ...r, revenue: $(r.revenue), debt: $(r.debt) }));
    return {
      summary: { from, to },
      table: {
        title: `Top customers, ${from} – ${to}`,
        columns: cols(['name', 'Customer'], ['code', 'Code'], ['phone', 'Phone'], ['invoices', 'Invoices', 'number'], ['revenue', 'Bought', 'money'], ['last_purchase', 'Last purchase', 'date'], ['debt', 'Owes now', 'money']),
        rows,
      },
    };
  },
};

const customerDebts = {
  def: {
    name: 'customer_debts',
    description:
      'Customers who currently owe money (receivables). For each: amount owed, number of unpaid invoices, oldest unpaid invoice day and how many days it has been open, the ageing split (0-30 / 31-60 / 61-90 / over 90 days), last payment day and phone. Also returns totals. Use for "who owes me", "ai còn nợ", collections priorities.',
    input_schema: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['amount', 'age'], description: 'amount = biggest debt first (default), age = oldest debt first.' },
        min_days: { type: 'integer', description: 'Only customers whose oldest unpaid invoice is at least this many days old.' },
        min_amount: { type: 'number', description: 'Only debts of at least this amount (currency units).' },
        limit: { type: 'integer', description: 'Max rows (default 100).' },
      },
    },
  },
  run(db, input) {
    const today = storeToday(db);
    const sort = oneOf(input.sort, 'sort', ['amount', 'age'], 'amount');
    const minDays = input.min_days == null ? 0 : limitArg(input.min_days, 0, 100000);
    const minAmount = input.min_amount == null ? 0 : Math.round(Number(input.min_amount) * 100);
    if (!Number.isFinite(minAmount)) throw new ToolInputError('min_amount must be a number');
    const all = db
      .prepare(
        `SELECT cu.code, cu.name, cu.phone, cu.debt, COUNT(*) AS unpaid_invoices, MIN(u.biz_date) AS oldest_unpaid,
                SUM(CASE WHEN age <= 30 THEN due ELSE 0 END) AS d0_30,
                SUM(CASE WHEN age BETWEEN 31 AND 60 THEN due ELSE 0 END) AS d31_60,
                SUM(CASE WHEN age BETWEEN 61 AND 90 THEN due ELSE 0 END) AS d61_90,
                SUM(CASE WHEN age > 90 THEN due ELSE 0 END) AS d90,
                (SELECT MAX(p.biz_date) FROM payments p WHERE p.customer_id = cu.id AND p.amount > 0) AS last_payment
         FROM (SELECT customer_id, total - paid AS due, biz_date, CAST(julianday(?) - julianday(biz_date) AS INTEGER) AS age
               FROM invoices WHERE kind = 'invoice' AND status = 'completed' AND paid < total AND customer_id IS NOT NULL) u
         JOIN customers cu ON cu.id = u.customer_id
         WHERE cu.debt > 0
         GROUP BY cu.id`
      )
      .all(today)
      .map((r) => ({ ...r, days_owed: daysBetween(r.oldest_unpaid, today) }));
    // Debt not tied to an unpaid invoice (e.g. opening balances) still counts.
    const loose = db
      .prepare(
        `SELECT code, name, phone, debt FROM customers c WHERE debt > 0 AND NOT EXISTS (
           SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.kind = 'invoice' AND i.status = 'completed' AND i.paid < i.total)`
      )
      .all()
      .map((r) => ({ ...r, unpaid_invoices: 0, oldest_unpaid: null, days_owed: null, d0_30: 0, d31_60: 0, d61_90: 0, d90: 0, last_payment: null }));
    let rows = [...all, ...loose].filter((r) => r.debt >= minAmount && (minDays === 0 || (r.days_owed ?? 0) >= minDays));
    rows.sort(sort === 'age' ? (a, b) => (b.days_owed ?? -1) - (a.days_owed ?? -1) : (a, b) => b.debt - a.debt);
    const totals = rows.reduce(
      (t, r) => {
        t.customers++;
        for (const k of ['debt', 'd0_30', 'd31_60', 'd61_90', 'd90']) t[k] += r[k];
        return t;
      },
      { customers: 0, debt: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 }
    );
    rows = rows.slice(0, limitArg(input.limit, 100));
    const money = (r) => ({ ...r, debt: $(r.debt), d0_30: $(r.d0_30), d31_60: $(r.d31_60), d61_90: $(r.d61_90), d90: $(r.d90) });
    return {
      summary: {
        today,
        customers_owing: totals.customers,
        total_owed: $(totals.debt),
        ageing: { '0_30_days': $(totals.d0_30), '31_60_days': $(totals.d31_60), '61_90_days': $(totals.d61_90), over_90_days: $(totals.d90) },
      },
      table: {
        title: 'Customers with outstanding debt',
        columns: cols(['name', 'Customer'], ['code', 'Code'], ['phone', 'Phone'], ['debt', 'Owes', 'money'], ['days_owed', 'Days owed', 'number'], ['oldest_unpaid', 'Oldest unpaid', 'date'], ['unpaid_invoices', 'Unpaid invoices', 'number'], ['d0_30', '0–30 d', 'money'], ['d31_60', '31–60 d', 'money'], ['d61_90', '61–90 d', 'money'], ['d90', '> 90 d', 'money'], ['last_payment', 'Last payment', 'date']),
        rows: rows.map(money),
      },
    };
  },
};

const findCustomers = {
  def: {
    name: 'find_customers',
    description:
      'Look up customers by name, code or phone (partial match). Returns contact info, lifetime purchases, invoice count, first/last purchase, current debt, and their unpaid invoices.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name, code (KH…) or phone digits.' } },
      required: ['query'],
    },
  },
  run(db, input) {
    const q = text(input.query, 'query');
    const m = textMatch(q, 'customers_fts', 'c.id', ['c.name', 'c.code', 'c.phone']);
    const found = db
      .prepare(`SELECT c.id, c.code, c.name, c.phone, c.email, c.address, c.type, c.debt, c.total_sales, c.note FROM customers c WHERE ${m.sql} ORDER BY c.total_sales DESC LIMIT 5`)
      .all(...m.params);
    const stats = db.prepare(
      `SELECT COUNT(*) AS invoices, MIN(biz_date) AS first_purchase, MAX(biz_date) AS last_purchase
       FROM invoices WHERE customer_id = ? AND kind = 'invoice' AND status = 'completed'`
    );
    const unpaid = db.prepare(
      `SELECT code, biz_date, total, paid FROM invoices WHERE customer_id = ? AND kind = 'invoice' AND status = 'completed' AND paid < total ORDER BY created_at LIMIT 20`
    );
    return {
      matches: found.map((c) => ({
        code: c.code,
        name: c.name,
        phone: c.phone,
        email: c.email,
        address: c.address,
        type: c.type,
        note: c.note,
        owes: $(c.debt),
        lifetime_purchases: $(c.total_sales),
        ...stats.get(c.id),
        unpaid_invoices: unpaid.all(c.id).map((i) => ({ code: i.code, day: i.biz_date, total: $(i.total), still_due: $(i.total - i.paid) })),
      })),
    };
  },
};

const findProducts = {
  def: {
    name: 'find_products',
    description:
      'Look up products by name, SKU or barcode (partial match). Returns price, stock, minimum stock, category, serial/IMEI units in stock, units sold in the last 30 days and days of stock left at that pace.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Product name words, SKU or barcode.' } },
      required: ['query'],
    },
  },
  run(db, input, { admin }) {
    const q = text(input.query, 'query');
    const m = textMatch(q, 'products_fts', 'p.id', ['p.name', 'p.sku', 'p.barcode']);
    const since = addDays(storeToday(db), -29);
    const rows = db
      .prepare(
        `SELECT p.id, p.sku, p.barcode, p.name, c.name AS category, p.brand, p.price, p.cost, p.stock, p.min_stock, p.track_serial, p.active, p.attributes,
                (SELECT COALESCE(SUM(ii.qty), 0) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                  WHERE ii.product_id = p.id AND ${SOLD} AND i.biz_date >= ?) AS sold_30d,
                (SELECT MAX(i.biz_date) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ii.product_id = p.id AND ${SOLD}) AS last_sold
         FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE ${m.sql} ORDER BY p.active DESC, sold_30d DESC LIMIT 10`
      )
      .all(since, ...m.params);
    const serials = db.prepare("SELECT serial FROM serials WHERE product_id = ? AND status = 'in_stock' ORDER BY received_at LIMIT 20");
    return {
      matches: rows.map((p) => ({
        sku: p.sku,
        barcode: p.barcode,
        name: p.name,
        category: p.category,
        brand: p.brand,
        attributes: JSON.parse(p.attributes || '{}'),
        price: $(p.price),
        ...(admin ? { cost: $(p.cost), margin_pct: p.price ? Math.round(((p.price - p.cost) / p.price) * 1000) / 10 : null } : {}),
        stock: p.stock,
        min_stock: p.min_stock,
        hidden: !p.active,
        sold_last_30_days: p.sold_30d,
        last_sold: p.last_sold,
        days_of_stock_left: p.sold_30d > 0 ? Math.round((p.stock / (p.sold_30d / 30)) * 10) / 10 : null,
        ...(p.track_serial ? { serials_in_stock: serials.all(p.id).map((s) => s.serial) } : {}),
      })),
    };
  },
};

const inventoryStatus = {
  def: {
    name: 'inventory_status',
    description:
      'Stock health. filter: "low" (at or below minimum stock), "out" (none left), "reorder" (will run out within `days` at the last 30 days\' sales pace), "slow" (in stock but nothing sold in `days` days — dead stock), "value" (biggest stock value). Returns stock, sales pace, days left and stock value.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['low', 'out', 'reorder', 'slow', 'value'] },
        days: { type: 'integer', description: 'Window for "reorder" (default 14) and "slow" (default 60).' },
        category: { type: 'string', description: 'Optional category name.' },
        limit: { type: 'integer', description: 'Max rows (default 50).' },
      },
      required: ['filter'],
    },
  },
  run(db, input, { admin }) {
    const filter = oneOf(input.filter, 'filter', ['low', 'out', 'reorder', 'slow', 'value']);
    const days = input.days == null ? (filter === 'slow' ? 60 : 14) : limitArg(input.days, 14, 3650);
    const limit = limitArg(input.limit, 50);
    const today = storeToday(db);
    const category = text(input.category, 'category', { optional: true });
    const params = { m30: addDays(today, -29), win: addDays(today, -(days - 1)), cat: category };
    const where = 'p.active = 1' + (category ? ' AND c.name LIKE @cat' : '');
    const all = db
      .prepare(
        `SELECT p.sku, p.name, c.name AS category, p.stock, p.min_stock, p.cost, p.price,
                COALESCE(s.sold_30d, 0) AS sold_30d, COALESCE(s.sold_window, 0) AS sold_window, s.last_sold
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN (SELECT ii.product_id, SUM(CASE WHEN i.biz_date >= @m30 THEN ii.qty ELSE 0 END) AS sold_30d,
                           SUM(CASE WHEN i.biz_date >= @win THEN ii.qty ELSE 0 END) AS sold_window, MAX(i.biz_date) AS last_sold
                    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ${SOLD} GROUP BY ii.product_id) s ON s.product_id = p.id
         WHERE ${where}`
      )
      .all(category ? params : { m30: params.m30, win: params.win });
    const withPace = all.map((p) => {
      const perDay = p.sold_30d / 30;
      return { ...p, days_left: perDay > 0 ? Math.round((Math.max(p.stock, 0) / perDay) * 10) / 10 : null, stock_value: Math.max(p.stock, 0) * p.cost };
    });
    const pick = {
      low: (p) => p.stock <= p.min_stock && p.stock > 0,
      out: (p) => p.stock <= 0,
      reorder: (p) => p.days_left !== null && p.days_left <= days,
      slow: (p) => p.stock > 0 && p.sold_window === 0,
      value: (p) => p.stock > 0,
    }[filter];
    const sorter = {
      low: (a, b) => a.stock - a.min_stock - (b.stock - b.min_stock),
      out: (a, b) => b.sold_30d - a.sold_30d,
      reorder: (a, b) => a.days_left - b.days_left,
      slow: (a, b) => b.stock_value - a.stock_value,
      value: (a, b) => b.stock_value - a.stock_value,
    }[filter];
    const matched = withPace.filter(pick).sort(sorter);
    const rows = matched.slice(0, limit).map((p) => ({
      name: p.name,
      sku: p.sku,
      category: p.category,
      stock: p.stock,
      min_stock: p.min_stock,
      sold_30d: p.sold_30d,
      days_left: p.days_left,
      last_sold: p.last_sold,
      ...(admin ? { stock_value: $(p.stock_value) } : {}),
    }));
    return {
      summary: {
        filter,
        days,
        products_matching: matched.length,
        ...(admin ? { stock_value_matching: $(matched.reduce((s, p) => s + p.stock_value, 0)) } : {}),
      },
      table: {
        title: { low: 'Low stock', out: 'Out of stock', reorder: `Will run out within ${days} days`, slow: `No sales in ${days} days`, value: 'Stock value by product' }[filter],
        columns: cols(['name', 'Product'], ['sku', 'SKU'], ['category', 'Category'], ['stock', 'Stock', 'number'], ['min_stock', 'Min', 'number'], ['sold_30d', 'Sold 30d', 'number'], ['days_left', 'Days left', 'number'], ['last_sold', 'Last sold', 'date'], ...(admin ? [['stock_value', 'Stock value', 'money']] : [])),
        rows,
      },
    };
  },
};

const runSql = {
  def: {
    name: 'run_sql',
    description:
      'Run one read-only SQLite SELECT against the store database when no other tool fits (e.g. specific invoices, a serial/IMEI history, payments by method, custom groupings). See the schema in the system prompt. Money columns are integer cents: divide by 100.0 in SQL. Filter dates with biz_date (YYYY-MM-DD, store-local). Always aggregate or LIMIT; at most 2000 rows come back and only the first 60 are shown to you.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT (or WITH … SELECT) statement.' },
        title: { type: 'string', description: 'Short title for the result table, in the user\'s language.' },
        money_columns: { type: 'array', items: { type: 'string' }, description: 'Result columns that hold money already divided to currency units, so the table formats them as money.' },
      },
      required: ['sql', 'title'],
    },
  },
  admin: true,
  async run(db, input, { query }) {
    if (typeof input.sql !== 'string' || !input.sql.trim()) throw new ToolInputError('sql is required');
    const sql = input.sql.trim();
    if (sql.length > 8000) throw new ToolInputError('sql is too long');
    const res = await query(sql);
    const money = new Set(Array.isArray(input.money_columns) ? input.money_columns : []);
    const columns = res.columns.map((k) => {
      const sample = res.rows.find((r) => r[k] != null)?.[k];
      return { key: k, label: k, type: money.has(k) ? 'money' : typeof sample === 'number' ? 'number' : 'text' };
    });
    return {
      summary: { row_count: res.rows.length, truncated_at_2000: res.truncated },
      table: { title: text(input.title, 'title', { optional: true }) || 'Query result', columns, rows: res.rows, sql },
    };
  },
};

export const TOOLS = [salesSummary, salesTrend, topProducts, topCustomers, customerDebts, findCustomers, findProducts, inventoryStatus, runSql];

export function toolsFor(user) {
  return TOOLS.filter((t) => !t.admin || user.role === 'admin');
}

export { MAX_ROWS };
