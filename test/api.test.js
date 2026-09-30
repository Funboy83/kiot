import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { ensureAdmin } from '../server/bootstrap.js';

let db, app, cookie;

async function api(method, path, body) {
  const headers = { cookie: cookie || '', 'x-requested-with': 'fetch' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json() };
}
const ok = async (...args) => {
  const r = await api(...args);
  assert.ok(r.status < 300, `${args[0]} ${args[1]} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db);
  app = createApp(db);
});

test('rejects anonymous requests and bad passwords', async () => {
  assert.equal((await api('GET', '/api/products')).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).status, 401);
  const me = await ok('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal(me.role, 'admin');
});

test('non-JSON mutations are refused (CSRF guard)', async () => {
  const res = await app.request('/api/customers', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
});

let phone, cable, customer;

test('creates products and finds them by trigram search, barcode and short prefix', async () => {
  phone = (await ok('POST', '/api/products', { name: 'iPhone 17 Pro 256GB', sku: 'IP17P', barcode: '1234567890123', price: 109900, cost: 95000, track_serial: true, category_name: 'iPhone', attributes: { STORAGE: '256GB' } })).id;
  cable = (await ok('POST', '/api/products', { name: 'USB-C Cable', price: 1900, cost: 700, stock: 50 })).id;
  const found = await ok('GET', '/api/products?q=phone%2017');
  assert.deepEqual(found.rows.map((r) => r.id), [phone]);
  assert.equal((await ok('GET', '/api/products?q=US')).rows[0].id, cable);
  assert.equal((await ok('GET', '/api/products/lookup?code=1234567890123')).product.id, phone);
  const c = await ok('GET', `/api/products/${cable}`);
  assert.equal(c.stock, 50);
  assert.match(c.sku, /^SP\d{6}$/);
  assert.equal((await api('POST', '/api/products', { name: 'Dup', sku: 'ip17p' })).status, 400);
});

test('goods receipt registers serials and averages cost', async () => {
  const r = await ok('POST', '/api/receipts', { supplier: 'Distributor', items: [{ product_id: phone, qty: 3, unit_cost: 96000, serials: ['IMEI001', 'IMEI002', 'IMEI003'] }] });
  assert.match(r.code, /^PN/);
  const p = await ok('GET', `/api/products/${phone}`);
  assert.equal(p.stock, 3);
  assert.equal(p.cost, 96000);
  assert.equal(p.serial_counts.in_stock, 3);
  const dupe = await api('POST', '/api/receipts', { items: [{ product_id: phone, qty: 1, serials: ['imei001'] }] });
  assert.equal(dupe.status, 400);
  assert.equal((await ok('GET', '/api/products/lookup?code=IMEI002')).serial.status, 'in_stock');
});

test('walk-in sale must be paid in full; credit sale needs a customer', async () => {
  const r = await api('POST', '/api/invoices', { items: [{ product_id: cable, qty: 1 }], paid: 0 });
  assert.equal(r.status, 400);
  customer = (await ok('POST', '/api/customers', { name: 'Harbor Mobile LLC', phone: '5551234', type: 'company' })).id;
});

let invoiceId;

test('sale moves stock, sells serials, records debt and change', async () => {
  const bad = await api('POST', '/api/invoices', { customer_id: customer, items: [{ product_id: phone, qty: 2, serials: ['IMEI001'] }] });
  assert.equal(bad.status, 400, 'serial count must match qty');
  const sale = await ok('POST', '/api/invoices', {
    customer_id: customer,
    items: [
      { product_id: phone, qty: 2, price: 109900, discount: 900, serials: ['IMEI001', 'imei002'] },
      { product_id: cable, qty: 3 },
    ],
    discount: 700,
    paid: 100000,
  });
  invoiceId = sale.id;
  assert.equal(sale.total, 2 * 109000 + 3 * 1900 - 700);
  assert.equal(sale.paid, 100000);
  const inv = await ok('GET', `/api/invoices/${sale.id}`);
  assert.deepEqual(inv.items[0].serials, ['IMEI001', 'IMEI002']);
  assert.equal(inv.cost_total, 2 * 96000 + 3 * 700);
  const cust = await ok('GET', `/api/customers/${customer}`);
  assert.equal(cust.debt, sale.total - 100000);
  assert.equal((await ok('GET', `/api/products/${phone}`)).stock, 1);
  const again = await api('POST', '/api/invoices', { customer_id: customer, items: [{ product_id: phone, qty: 1, serials: ['IMEI001'] }] });
  assert.equal(again.status, 400, 'sold serial cannot be sold twice');
  const change = await ok('POST', '/api/invoices', { items: [{ product_id: cable, qty: 1 }], paid: 2000 });
  assert.equal(change.change, 100);
  const bySerial = await ok('GET', '/api/invoices?q=IMEI002');
  assert.deepEqual(bySerial.rows.map((r) => r.id), [sale.id]);
});

test('debt payment is applied to the oldest invoices first', async () => {
  const second = await ok('POST', '/api/invoices', { customer_id: customer, items: [{ product_id: cable, qty: 10 }], paid: 0 });
  const before = (await ok('GET', `/api/customers/${customer}`)).debt;
  const first = await ok('GET', `/api/invoices/${invoiceId}`);
  const firstDue = first.total - first.paid;
  await ok('POST', `/api/customers/${customer}/payments`, { amount: firstDue + 500, method: 'transfer' });
  assert.equal((await ok('GET', `/api/invoices/${invoiceId}`)).paid, first.total);
  assert.equal((await ok('GET', `/api/invoices/${second.id}`)).paid, 500);
  assert.equal((await ok('GET', `/api/customers/${customer}`)).debt, before - firstDue - 500);
  assert.equal((await api('POST', `/api/customers/${customer}/payments`, { amount: 10 ** 9 })).status, 400);
  const aging = await ok('GET', '/api/reports/debt');
  assert.equal(aging.totals.debt, before - firstDue - 500);
  assert.equal(aging.rows[0].d0_30, aging.rows[0].debt);
});

test('cancelling an invoice restores stock, serials and debt', async () => {
  const stockBefore = (await ok('GET', `/api/products/${cable}`)).stock;
  const debtBefore = (await ok('GET', `/api/customers/${customer}`)).debt;
  const inv = await ok('GET', `/api/invoices/${invoiceId}`);
  await ok('POST', `/api/invoices/${invoiceId}/cancel`, {});
  assert.equal((await ok('GET', `/api/products/${cable}`)).stock, stockBefore + 3);
  assert.equal((await ok('GET', '/api/products/lookup?code=IMEI001')).serial.status, 'in_stock');
  assert.equal((await ok('GET', `/api/customers/${customer}`)).debt, debtBefore - (inv.total - inv.paid));
  assert.equal((await api('POST', `/api/invoices/${invoiceId}/cancel`, {})).status, 400);
  const moves = await ok('GET', `/api/products/${cable}/moves`);
  assert.equal(moves.rows[0].ref_type, 'cancel');
  assert.equal(moves.rows[0].balance, stockBefore + 3);
});

test('sales order converts into an invoice once', async () => {
  const order = await ok('POST', '/api/invoices', { kind: 'order', customer_id: customer, items: [{ product_id: phone, qty: 1 }] });
  assert.match(order.code, /^DH/);
  assert.equal((await ok('GET', `/api/products/${phone}`)).stock, 3, 'orders do not move stock');
  await ok('POST', '/api/invoices', { order_id: order.id, customer_id: customer, items: [{ product_id: phone, qty: 1, serials: ['IMEI003'] }] });
  assert.equal((await ok('GET', `/api/invoices/${order.id}`)).status, 'converted');
  const twice = await api('POST', '/api/invoices', { order_id: order.id, customer_id: customer, items: [{ product_id: cable, qty: 1 }] });
  assert.equal(twice.status, 400);
});

test('stock take sets counted stock and flags unscanned serials missing', async () => {
  const st = await ok('POST', '/api/stocktakes', {
    note: 'Shelf',
    balance: true,
    items: [
      { product_id: cable, actual_qty: 20 },
      { product_id: phone, serials: ['IMEI001'] },
    ],
  });
  const detail = await ok('GET', `/api/stocktakes/${st.id}`);
  assert.equal(detail.status, 'balanced');
  assert.equal((await ok('GET', `/api/products/${cable}`)).stock, 20);
  const p = await ok('GET', `/api/products/${phone}`);
  assert.equal(p.stock, 1);
  assert.equal(p.serial_counts.missing, 1);
  assert.equal((await api('PUT', `/api/stocktakes/${st.id}`, { items: [{ product_id: cable, actual_qty: 1 }] })).status, 400);
});

test('reports add up', async () => {
  const sales = await ok('GET', '/api/reports/sales');
  const invoices = await ok('GET', '/api/invoices?status=completed');
  assert.equal(sales.totals.revenue, invoices.totals.total);
  const prod = await ok('GET', '/api/reports/products');
  assert.equal(prod.totals.revenue, sales.totals.revenue);
  const dash = await ok('GET', '/api/reports/dashboard');
  assert.equal(dash.todayStats.revenue, sales.totals.revenue);
  const s = await ok('GET', '/api/search?q=IMEI00');
  assert.equal(s.serials.length, 3);
});

test('staff cannot open profit reports or manage users', async () => {
  await ok('POST', '/api/users', { username: 'cashier', name: 'Cashier', password: 'secret1', role: 'staff' });
  await ok('POST', '/api/auth/logout', {});
  await ok('POST', '/api/auth/login', { username: 'cashier', password: 'secret1' });
  assert.equal((await api('GET', '/api/reports/sales')).status, 403);
  assert.equal((await api('GET', '/api/users')).status, 403);
  assert.equal((await api('GET', '/api/products')).status, 200);
});
