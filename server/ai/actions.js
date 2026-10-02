// Actions the assistant can propose. Nothing here writes on its own: `prepare` checks the request
// against the database and builds a card for the user; only when the user presses Confirm does
// `execute` run, and it goes through the app's own API as that user, so every rule, validation
// and role check the screens have applies to the assistant too.
import { ToolInputError } from './tools.js';

const cents = (v, name) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ToolInputError(`${name} must be a non-negative number`);
  return Math.round(n * 100);
};
const posInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ToolInputError(`${name} must be a whole number of at least 1`);
  return n;
};
const optText = (v, max = 500) => (v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim().slice(0, max));
const METHODS = ['cash', 'card', 'transfer'];
const method = (v) => {
  if (v === undefined || v === null || v === '') return 'cash';
  if (!METHODS.includes(v)) throw new ToolInputError('method must be cash, card or transfer');
  return v;
};

function product(db, id) {
  const p = db.prepare('SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?').get(Number(id));
  if (!p) throw new ToolInputError(`No product with id ${id}. Look it up with find_products first.`);
  return p;
}
function customer(db, id) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
  if (!c) throw new ToolInputError(`No customer with id ${id}. Look it up with find_customers first.`);
  return c;
}
function invoiceByCode(db, code) {
  const inv = db
    .prepare('SELECT i.*, cu.name AS customer_name FROM invoices i LEFT JOIN customers cu ON cu.id = i.customer_id WHERE i.code = ? OR i.id = ?')
    .get(String(code || '').trim().toUpperCase(), Number(code) || -1);
  if (!inv) throw new ToolInputError(`No invoice or order ${code}`);
  return inv;
}

const ID = { type: 'integer', description: 'Database id from find_products / find_customers.' };

// ---------------------------------------------------------------------------------------------

const createInvoice = {
  def: {
    name: 'create_invoice',
    description:
      'Prepare a sales invoice (or a sales order) for the user to confirm. Use it when the user wants to sell something, including when they paste a customer\'s message such as "2 cases of Red Bull and 1 iPhone 17 Pro for Mr. Nam, will pay next week". First resolve every product with find_products and the customer with find_customers (or pass new_customer). If a product, quantity or the customer is unclear, ask the user instead of guessing. Prices default to the product\'s selling price. Serial/IMEI products get the oldest units in stock unless serials are given; the user can change them on the card.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['invoice', 'order'], description: 'invoice (default) sells now and moves stock; order only records a request.' },
        customer_id: ID,
        new_customer: {
          type: 'object',
          description: 'Create this customer together with the invoice when they are not in the system yet.',
          properties: { name: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' }, type: { type: 'string', enum: ['person', 'company'] } },
          required: ['name'],
        },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              product_id: ID,
              qty: { type: 'integer', minimum: 1 },
              price: { type: 'number', description: 'Unit price in currency units, only if different from the list price.' },
              discount: { type: 'number', description: 'Discount per unit in currency units.' },
              serials: { type: 'array', items: { type: 'string' }, description: 'Specific serial/IMEI numbers, if the user named them.' },
            },
            required: ['product_id', 'qty'],
          },
        },
        discount: { type: 'number', description: 'Discount on the whole invoice, currency units.' },
        paid: { type: 'number', description: 'Amount the customer pays now, currency units. Omit when paying in full; 0 when it all goes on credit.' },
        method: { type: 'string', enum: METHODS },
        note: { type: 'string' },
      },
      required: ['items'],
    },
  },
  prepare(db, input, edits = {}) {
    const kind = input.kind === 'order' ? 'order' : 'invoice';
    if (!Array.isArray(input.items) || !input.items.length) throw new ToolInputError('items must list at least one product');
    if (input.items.length > 100) throw new ToolInputError('Too many lines');
    const warnings = [];
    let cust = null;
    let newCustomer = null;
    if (input.customer_id != null) cust = customer(db, input.customer_id);
    else if (input.new_customer?.name) {
      const phone = optText(input.new_customer.phone, 50);
      const existing = phone && db.prepare("SELECT * FROM customers WHERE replace(replace(replace(phone, ' ', ''), '-', ''), '.', '') = ?").get(phone.replace(/[\s.-]/g, ''));
      if (existing) {
        cust = existing;
        warnings.push(`Phone ${phone} already belongs to ${existing.name} (${existing.code}); using that customer.`);
      } else {
        newCustomer = { name: optText(input.new_customer.name, 200), phone, address: optText(input.new_customer.address), type: input.new_customer.type === 'company' ? 'company' : 'person' };
      }
    }

    const inStock = db.prepare("SELECT serial FROM serials WHERE product_id = ? AND status = 'in_stock' ORDER BY received_at, id");
    const used = new Set();
    const lines = input.items.map((it, i) => {
      const p = product(db, it.product_id);
      if (!p.active) throw new ToolInputError(`${p.name} is hidden (no longer sold)`);
      const qty = posInt(it.qty, `Line ${i + 1} qty`);
      const price = cents(it.price, 'price') ?? p.price;
      const discount = Math.min(cents(it.discount, 'discount') ?? 0, price);
      const line = { product_id: p.id, name: p.name, sku: p.sku, qty, price, discount, total: qty * (price - discount), track_serial: !!p.track_serial, stock: p.stock };
      if (p.track_serial && kind === 'invoice') {
        const options = inStock.all(p.id).map((r) => r.serial);
        if (options.length < qty) throw new ToolInputError(`${p.name}: only ${options.length} unit(s) in stock with a serial/IMEI, ${qty} asked`);
        const wanted = edits.serials?.[i] ?? it.serials;
        let picked = Array.isArray(wanted) && wanted.length ? wanted.map(String) : options.filter((s) => !used.has(s)).slice(0, qty);
        if (picked.length !== qty) throw new ToolInputError(`${p.name}: pick exactly ${qty} serial/IMEI`);
        for (const s of picked) {
          if (!options.includes(s)) throw new ToolInputError(`Serial ${s} is not an in-stock unit of ${p.name}`);
          if (used.has(s)) throw new ToolInputError(`Serial ${s} is used twice`);
          used.add(s);
        }
        line.serials = picked;
        line.serial_options = options;
      } else if (kind === 'invoice' && p.stock < qty) {
        warnings.push(`${p.name}: only ${p.stock} in stock, ${qty} on this invoice (stock will go below zero).`);
      }
      if (price < p.price) warnings.push(`${p.name}: selling at ${(price / 100).toFixed(2)}, below the list price ${(p.price / 100).toFixed(2)}.`);
      return line;
    });
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const discount = Math.min(cents(input.discount, 'discount') ?? 0, subtotal);
    const total = subtotal - discount;
    const paid = kind === 'order' ? 0 : Math.min(edits.paid != null ? Math.max(0, Math.round(Number(edits.paid))) : cents(input.paid, 'paid') ?? total, total);
    const pay = method(edits.method ?? input.method);
    if (kind === 'invoice' && paid < total && !cust && !newCustomer) {
      throw new ToolInputError('Selling on credit needs a customer. Ask who the customer is.');
    }
    const custView = cust
      ? { id: cust.id, name: cust.name, code: cust.code, phone: cust.phone, debt: cust.debt }
      : newCustomer
        ? { ...newCustomer, is_new: true, debt: 0 }
        : null;
    return {
      title: kind === 'order' ? 'New sales order' : 'New invoice',
      icon: '🧾',
      customer: custView,
      lines: lines.map(({ serial_options, ...l }) => ({ ...l, serial_options })),
      totals: { subtotal, discount, total, paid, method: pay, debt_after: custView ? (custView.debt || 0) + (kind === 'invoice' ? total - paid : 0) : null },
      editable: kind === 'invoice' ? ['paid', 'method', 'serials'] : [],
      note: optText(input.note, 1000),
      warnings,
      confirm: kind === 'order' ? 'Save order' : 'Create invoice',
      _body: {
        kind,
        customer_id: cust?.id,
        items: lines.map((l) => ({ product_id: l.product_id, qty: l.qty, price: l.price, discount: l.discount, serials: l.serials })),
        discount,
        paid,
        method: pay,
        note: optText(input.note, 1000),
      },
      _newCustomer: newCustomer,
    };
  },
  async execute(api, prep) {
    const body = { ...prep._body };
    let created = null;
    if (prep._newCustomer) {
      created = await api('POST', '/api/customers', prep._newCustomer);
      body.customer_id = created.id;
    }
    const r = await api('POST', '/api/invoices', body);
    return {
      message: `${body.kind === 'order' ? 'Order' : 'Invoice'} ${r.code} saved${created ? `, new customer ${created.code} added` : ''}`,
      link: `/invoices/${r.id}`,
      code: r.code,
    };
  },
};

const recordPayment = {
  def: {
    name: 'record_payment',
    description:
      'Prepare collecting money from a customer: either against their overall debt (applied to the oldest unpaid invoices first) or against one invoice by code.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: ID,
        invoice_code: { type: 'string', description: 'Pay this invoice instead of the oldest debts.' },
        amount: { type: 'number', description: 'Currency units. Omit to collect everything owed.' },
        method: { type: 'string', enum: METHODS },
        note: { type: 'string' },
      },
    },
  },
  prepare(db, input, edits = {}) {
    const pay = method(edits.method ?? input.method);
    if (input.invoice_code) {
      const inv = invoiceByCode(db, input.invoice_code);
      if (inv.kind !== 'invoice' || inv.status !== 'completed') throw new ToolInputError(`${inv.code} is not an open invoice`);
      const due = inv.total - inv.paid;
      if (due <= 0) throw new ToolInputError(`${inv.code} is already paid in full`);
      const amount = Math.min(edits.paid ?? cents(input.amount, 'amount') ?? due, due);
      return {
        title: 'Collect payment',
        icon: '💵',
        fields: [['Invoice', inv.code], ['Customer', inv.customer_name || 'Walk-in'], ['Still due', due, 'money'], ['Collect now', amount, 'money'], ['Left after', due - amount, 'money']],
        totals: { paid: amount, method: pay },
        editable: ['paid', 'method'],
        confirm: 'Record payment',
        warnings: [],
        _path: `/api/invoices/${inv.id}/pay`,
        _body: { amount, method: pay, note: optText(input.note) },
        _code: inv.code,
      };
    }
    if (input.customer_id == null) throw new ToolInputError('Give customer_id or invoice_code');
    const c = customer(db, input.customer_id);
    if (c.debt <= 0) throw new ToolInputError(`${c.name} owes nothing`);
    const amount = Math.min(edits.paid ?? cents(input.amount, 'amount') ?? c.debt, c.debt);
    return {
      title: 'Collect debt payment',
      icon: '💵',
      fields: [['Customer', `${c.name} (${c.code})`], ['Owes', c.debt, 'money'], ['Collect now', amount, 'money'], ['Owes after', c.debt - amount, 'money']],
      totals: { paid: amount, method: pay },
      editable: ['paid', 'method'],
      confirm: 'Record payment',
      warnings: [],
      _path: `/api/customers/${c.id}/payments`,
      _body: { amount, method: pay, note: optText(input.note) },
    };
  },
  async execute(api, prep) {
    const r = await api('POST', prep._path, prep._body);
    return { message: `Payment ${r?.code || ''} recorded`.replace('  ', ' ') };
  },
};

const cancelInvoice = {
  def: {
    name: 'cancel_invoice',
    description: 'Prepare cancelling an invoice or sales order by code. Cancelling an invoice puts stock and serials back, removes its unpaid part from the customer\'s debt and refunds what was paid.',
    input_schema: { type: 'object', properties: { code: { type: 'string', description: 'e.g. HD000123 or DH000004' } }, required: ['code'] },
  },
  prepare(db, input) {
    const inv = invoiceByCode(db, input.code);
    const open = inv.kind === 'order' ? inv.status === 'open' : inv.status === 'completed';
    if (!open) throw new ToolInputError(`${inv.code} is already ${inv.status}`);
    return {
      title: `Cancel ${inv.kind === 'order' ? 'order' : 'invoice'} ${inv.code}`,
      icon: '⛔',
      danger: true,
      fields: [['Customer', inv.customer_name || 'Walk-in'], ['Day', inv.biz_date], ['Total', inv.total, 'money'], ...(inv.kind === 'invoice' ? [['Refund', inv.paid, 'money']] : [])],
      warnings: inv.kind === 'invoice' ? ['Stock and serials go back on the shelf and the paid amount is recorded as refunded.'] : [],
      confirm: 'Cancel it',
      _path: `/api/invoices/${inv.id}/cancel`,
      _code: inv.code,
      _id: inv.id,
    };
  },
  async execute(api, prep) {
    await api('POST', prep._path, {});
    return { message: `${prep._code} cancelled`, link: `/invoices/${prep._id}` };
  },
};

const CUSTOMER_FIELDS = { name: 200, phone: 50, email: 200, address: 500, note: 1000 };

const saveCustomer = {
  def: {
    name: 'save_customer',
    description: 'Prepare adding a new customer, or changing an existing one (pass customer_id and only the fields that change).',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'integer', description: 'Existing customer to change; omit to add a new one.' },
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        address: { type: 'string' },
        note: { type: 'string' },
        type: { type: 'string', enum: ['person', 'company'] },
      },
    },
  },
  prepare(db, input) {
    const existing = input.customer_id != null ? customer(db, input.customer_id) : null;
    const next = { ...(existing ? { name: existing.name, phone: existing.phone, email: existing.email, address: existing.address, note: existing.note, type: existing.type, code: existing.code } : {}) };
    for (const [k, max] of Object.entries(CUSTOMER_FIELDS)) if (input[k] !== undefined) next[k] = optText(input[k], max) ?? null;
    if (input.type) next.type = input.type === 'company' ? 'company' : 'person';
    if (!next.name) throw new ToolInputError('A customer needs a name');
    const changes = Object.keys(CUSTOMER_FIELDS).concat('type').filter((k) => !existing || (next[k] ?? null) !== (existing[k] ?? null));
    if (existing && !changes.length) throw new ToolInputError('Nothing to change');
    const warnings = [];
    if (!existing && next.phone) {
      const dup = db.prepare('SELECT name, code FROM customers WHERE phone = ?').get(next.phone);
      if (dup) warnings.push(`${dup.name} (${dup.code}) already has this phone number.`);
    }
    return {
      title: existing ? `Update customer ${existing.code}` : 'New customer',
      icon: '👤',
      fields: changes.map((k) => [k[0].toUpperCase() + k.slice(1), existing ? `${existing[k] ?? '—'} → ${next[k] ?? '—'}` : next[k] ?? '—']),
      warnings,
      confirm: existing ? 'Save changes' : 'Add customer',
      _method: existing ? 'PUT' : 'POST',
      _path: existing ? `/api/customers/${existing.id}` : '/api/customers',
      _body: next,
      _id: existing?.id,
    };
  },
  async execute(api, prep) {
    const r = await api(prep._method, prep._path, prep._body);
    const id = prep._id ?? r.id;
    return { message: prep._id ? 'Customer updated' : `Customer ${r.code} added`, link: `/customers/${id}` };
  },
};

const saveProduct = {
  def: {
    name: 'save_product',
    description:
      'Prepare adding a product, or changing one (pass product_id and only what changes: price, cost, name, category, barcode, brand, sku, min_stock). Use hidden=true to stop selling a product, hidden=false to bring it back.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'Existing product to change; omit to add a new one.' },
        name: { type: 'string' },
        price: { type: 'number', description: 'Selling price, currency units.' },
        cost: { type: 'number', description: 'Cost price, currency units.' },
        category: { type: 'string' },
        sku: { type: 'string' },
        barcode: { type: 'string' },
        brand: { type: 'string' },
        min_stock: { type: 'integer' },
        track_serial: { type: 'boolean', description: 'New products only: track each unit by serial/IMEI.' },
        opening_stock: { type: 'integer', description: 'New non-serial products only.' },
        hidden: { type: 'boolean' },
      },
    },
  },
  prepare(db, input) {
    const existing = input.product_id != null ? product(db, input.product_id) : null;
    if (existing && typeof input.hidden === 'boolean' && Object.keys(input).filter((k) => k !== 'product_id' && k !== 'hidden').length === 0) {
      return {
        title: `${input.hidden ? 'Hide' : 'Restore'} ${existing.name}`,
        icon: '📦',
        fields: [['Product', `${existing.name} (${existing.sku})`], ['Stock', String(existing.stock)]],
        warnings: input.hidden ? ['Hidden products disappear from sales and lists; history stays.'] : [],
        confirm: input.hidden ? 'Hide product' : 'Restore product',
        _method: input.hidden ? 'DELETE' : 'POST',
        _path: input.hidden ? `/api/products/${existing.id}` : `/api/products/${existing.id}/restore`,
        _id: existing.id,
      };
    }
    const body = existing
      ? { name: existing.name, sku: existing.sku, barcode: existing.barcode, brand: existing.brand, price: existing.price, cost: existing.cost, min_stock: existing.min_stock, track_serial: !!existing.track_serial, attributes: JSON.parse(existing.attributes || '{}'), category_id: existing.category_id }
      : { price: 0, cost: 0, min_stock: 0, track_serial: false };
    const shown = [];
    const set = (key, label, value, fmt = (v) => v ?? '—') => {
      if (value === undefined) return;
      shown.push([label, existing ? `${fmt(body[key])} → ${fmt(value)}` : fmt(value), typeof value === 'number' && (key === 'price' || key === 'cost') && !existing ? 'money' : undefined]);
      body[key] = value;
    };
    const m = (v) => (v == null ? '—' : (v / 100).toFixed(2));
    set('name', 'Name', optText(input.name, 300));
    set('price', 'Price', cents(input.price, 'price'), existing ? m : undefined);
    set('cost', 'Cost', cents(input.cost, 'cost'), existing ? m : undefined);
    set('sku', 'SKU', optText(input.sku, 100));
    set('barcode', 'Barcode', optText(input.barcode, 100));
    set('brand', 'Brand', optText(input.brand, 100));
    if (input.min_stock != null) set('min_stock', 'Min stock', Math.max(0, Math.round(Number(input.min_stock)) || 0));
    if (input.category) {
      shown.push(['Category', existing ? `${existing.category ?? '—'} → ${input.category}` : input.category]);
      body.category_name = optText(input.category, 100);
    }
    if (!existing) {
      body.track_serial = !!input.track_serial;
      if (body.track_serial) shown.push(['Serial/IMEI', 'tracked per unit']);
      if (input.opening_stock) {
        if (body.track_serial) throw new ToolInputError('Serial products get stock through receive_goods with their serials');
        body.stock = posInt(input.opening_stock, 'opening_stock');
        shown.push(['Opening stock', String(body.stock)]);
      }
      if (!body.name) throw new ToolInputError('A product needs a name');
    }
    if (!shown.length) throw new ToolInputError('Nothing to change');
    const warnings = [];
    if (body.cost > body.price && body.price > 0) warnings.push('Cost is higher than the selling price.');
    return {
      title: existing ? `Update ${existing.name}` : 'New product',
      icon: '📦',
      fields: shown,
      warnings,
      confirm: existing ? 'Save changes' : 'Add product',
      _method: existing ? 'PUT' : 'POST',
      _path: existing ? `/api/products/${existing.id}` : '/api/products',
      _body: body,
      _id: existing?.id,
    };
  },
  async execute(api, prep) {
    const r = await api(prep._method, prep._path, prep._body);
    const id = prep._id ?? r.id;
    return { message: prep._id ? 'Product saved' : 'Product added', link: `/products/${id}` };
  },
};

const receiveGoods = {
  def: {
    name: 'receive_goods',
    description: 'Prepare a goods receipt (stock coming in from a supplier). Serial/IMEI products need one serial per unit; ask the user for them if missing.',
    input_schema: {
      type: 'object',
      properties: {
        supplier: { type: 'string' },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              product_id: ID,
              qty: { type: 'integer', minimum: 1 },
              unit_cost: { type: 'number', description: 'Currency units; defaults to the current cost.' },
              serials: { type: 'array', items: { type: 'string' } },
            },
            required: ['product_id', 'qty'],
          },
        },
        note: { type: 'string' },
      },
      required: ['items'],
    },
  },
  prepare(db, input) {
    if (!Array.isArray(input.items) || !input.items.length) throw new ToolInputError('items must list at least one product');
    const lines = input.items.map((it, i) => {
      const p = product(db, it.product_id);
      const qty = posInt(it.qty, `Line ${i + 1} qty`);
      const unitCost = cents(it.unit_cost, 'unit_cost') ?? p.cost;
      const serials = Array.isArray(it.serials) ? it.serials.map((s) => String(s).trim()).filter(Boolean) : [];
      if (p.track_serial && serials.length !== qty) throw new ToolInputError(`${p.name} tracks serial/IMEI: give ${qty} serial number(s) (got ${serials.length})`);
      return { product_id: p.id, name: p.name, sku: p.sku, qty, price: unitCost, discount: 0, total: qty * unitCost, serials: p.track_serial ? serials : undefined, stock: p.stock };
    });
    const total = lines.reduce((s, l) => s + l.total, 0);
    return {
      title: 'Receive goods',
      icon: '📥',
      fields: input.supplier ? [['Supplier', optText(input.supplier, 200)]] : [],
      lines,
      line_price_label: 'Unit cost',
      totals: { total },
      warnings: [],
      confirm: 'Add to stock',
      _body: { supplier: optText(input.supplier, 200), note: optText(input.note, 1000), items: lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_cost: l.price, serials: l.serials })) },
    };
  },
  async execute(api, prep) {
    const r = await api('POST', '/api/receipts', prep._body);
    return { message: `Goods receipt ${r.code} saved, stock updated`, link: `/inventory/receipts/${r.id}` };
  },
};

const setStock = {
  def: {
    name: 'set_stock',
    description: 'Prepare a stock count that sets products to the quantity actually on the shelf (non-serial products). Use when the user says the real count differs.',
    input_schema: {
      type: 'object',
      properties: {
        items: { type: 'array', minItems: 1, items: { type: 'object', properties: { product_id: ID, actual_qty: { type: 'integer', minimum: 0 } }, required: ['product_id', 'actual_qty'] } },
        note: { type: 'string' },
      },
      required: ['items'],
    },
  },
  prepare(db, input) {
    if (!Array.isArray(input.items) || !input.items.length) throw new ToolInputError('items must list at least one product');
    const rows = input.items.map((it) => {
      const p = product(db, it.product_id);
      if (p.track_serial) throw new ToolInputError(`${p.name} is counted by scanning serials on the Stock takes screen`);
      const actual = Number(it.actual_qty);
      if (!Number.isInteger(actual) || actual < 0) throw new ToolInputError('actual_qty must be a whole number, 0 or more');
      return { p, actual };
    });
    return {
      title: 'Correct stock',
      icon: '📋',
      fields: rows.map(({ p, actual }) => [p.name, `${p.stock} → ${actual}`]),
      warnings: [],
      confirm: 'Set stock',
      _body: { note: optText(input.note, 1000) || 'From assistant', balance: true, items: rows.map(({ p, actual }) => ({ product_id: p.id, actual_qty: actual })) },
    };
  },
  async execute(api, prep) {
    const r = await api('POST', '/api/stocktakes', prep._body);
    return { message: `Stock count ${r.code} balanced`, link: `/stocktakes/${r.id}` };
  },
};

const updateSettings = {
  def: {
    name: 'update_settings',
    description: 'Prepare changing store settings: store name, time zone, currency, or the app mode (simple hides advanced screens and options, advanced shows everything).',
    input_schema: {
      type: 'object',
      properties: {
        store_name: { type: 'string' },
        timezone: { type: 'string', description: 'IANA name, e.g. America/Los_Angeles' },
        currency: { type: 'string', description: 'ISO code, e.g. USD or VND' },
        ui_mode: { type: 'string', enum: ['simple', 'advanced'] },
      },
    },
  },
  admin: true,
  prepare(db, input, edits, { settings }) {
    const changes = {};
    for (const k of ['store_name', 'timezone', 'currency', 'ui_mode']) {
      const v = optText(input[k], 100);
      if (v !== undefined && v !== settings[k]) changes[k] = k === 'currency' ? v.toUpperCase() : v;
    }
    if (!Object.keys(changes).length) throw new ToolInputError('Nothing to change');
    const label = { store_name: 'Store name', timezone: 'Time zone', currency: 'Currency', ui_mode: 'App mode' };
    return {
      title: 'Change settings',
      icon: '⚙️',
      fields: Object.entries(changes).map(([k, v]) => [label[k], `${settings[k] ?? '—'} → ${v}`]),
      warnings: [],
      confirm: 'Save settings',
      reload: true,
      _body: { ...settings, ...changes },
    };
  },
  async execute(api, prep) {
    await api('PUT', '/api/settings', prep._body);
    return { message: 'Settings saved', reload: true };
  },
};

export const ACTIONS = [createInvoice, recordPayment, cancelInvoice, saveCustomer, saveProduct, receiveGoods, setStock, updateSettings];

export function actionsFor(user) {
  return ACTIONS.filter((a) => !a.admin || user.role === 'admin');
}

/** The card the panel shows: everything except the private `_` fields used to execute. */
export function publicCard(prep) {
  return Object.fromEntries(Object.entries(prep).filter(([k]) => !k.startsWith('_')));
}
