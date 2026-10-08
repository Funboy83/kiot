// Fills a fresh database with made-up demo data: an electronics + convenience store.
// Usage: node server/seed.js [--big]   (--big adds 20k products and ~100k invoices for speed testing)
import { rmSync, existsSync } from 'node:fs';
import { openDb } from './db.js';
import { ensureAdmin } from './bootstrap.js';
import { createReceipt, createStockTake } from './services/inventory.js';
import { createSale, payCustomerDebt, cancelInvoice } from './services/sales.js';

const big = process.argv.includes('--big');
const file = process.env.DB_FILE || 'data/store.db';
for (const f of [file, file + '-wal', file + '-shm']) if (existsSync(f)) rmSync(f);
const db = openDb(file);
ensureAdmin(db);
const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();

// Deterministic random numbers so every seed looks the same.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rand() * a.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const $ = (dollars) => Math.round(dollars * 100);
const DAY = 864e5;

const CATALOG = [
  // [category, name, price, cost, serial?, attributes]
  ['iPhone', 'iPhone 17 Pro Max 256GB', 1199, 1040, true, { STORAGE: '256GB', CONDITION: 'New' }],
  ['iPhone', 'iPhone 17 Pro 256GB', 1099, 950, true, { STORAGE: '256GB', CONDITION: 'New' }],
  ['iPhone', 'iPhone 17 128GB', 799, 690, true, { STORAGE: '128GB', CONDITION: 'New' }],
  ['iPhone', 'iPhone 16 128GB', 699, 590, true, { STORAGE: '128GB', CONDITION: 'New' }],
  ['iPhone', 'iPhone 15 Pro 256GB - Used A', 649, 520, true, { STORAGE: '256GB', CONDITION: 'Used A' }],
  ['iPad', 'iPad Air 11-inch M4 256GB Wi-Fi', 749, 640, true, { STORAGE: '256GB' }],
  ['iPad', 'iPad Air 13-inch M4 128GB Wi-Fi', 799, 690, true, { STORAGE: '128GB' }],
  ['iPad', 'iPad Pro 13-inch M5 512GB Wi-Fi', 1499, 1310, true, { STORAGE: '512GB' }],
  ['iPad', 'iPad 11th gen 128GB Wi-Fi', 349, 290, true, { STORAGE: '128GB' }],
  ['iPad', 'iPad mini A17 Pro 128GB', 499, 420, true, { STORAGE: '128GB' }],
  ['MacBook', 'MacBook Air 13-inch M5 16GB 512GB', 1299, 1140, true, { STORAGE: '512GB' }],
  ['MacBook', 'MacBook Air 15-inch M5 16GB 512GB', 1499, 1320, true, { STORAGE: '512GB' }],
  ['MacBook', 'MacBook Pro 14-inch M5 16GB 1TB', 1799, 1580, true, { STORAGE: '1TB' }],
  ['MacBook', 'MacBook Pro 16-inch M5 Pro 48GB 1TB', 2899, 2560, true, { STORAGE: '1TB' }],
  ['Apple Watch', 'Apple Watch Series 11 45mm GPS', 429, 360, true, { MAU: 'Midnight' }],
  ['Apple Watch', 'Apple Watch SE 3 40mm GPS', 249, 205, true, { MAU: 'Starlight' }],
  ['Apple Watch', 'Apple Watch Ultra 3 49mm Cellular', 799, 690, true, { MAU: 'Natural Ti' }],
  ['AirPods', 'AirPods Pro 3', 249, 198, true, {}],
  ['AirPods', 'AirPods 4 with ANC', 179, 142, true, {}],
  ['Accessories', 'USB-C 20W Power Adapter', 19, 9, false, {}],
  ['Accessories', 'USB-C to Lightning Cable 1m', 19, 7, false, {}],
  ['Accessories', 'USB-C Woven Charge Cable 1m', 19, 7, false, {}],
  ['Accessories', 'MagSafe Charger 1m', 39, 24, false, {}],
  ['Accessories', 'Clear Case iPhone 17 Pro', 29, 8, false, {}],
  ['Accessories', 'Tempered Glass iPhone 17 Pro', 12, 2, false, {}],
  ['Accessories', 'Apple Pencil Pro', 129, 104, false, {}],
  ['Drinks', 'Red Bull 250ml (24 pack)', 42, 31, false, {}],
  ['Drinks', 'Red Bull 250ml can', 2.5, 1.3, false, {}],
  ['Drinks', 'Yakult Original (5 pack)', 4.5, 2.9, false, {}],
  ['Drinks', 'Coconut Water 500ml', 3, 1.6, false, {}],
  ['Drinks', 'Sparkling Water 12 pack', 7, 4.2, false, {}],
  ['Drinks', 'Cold Brew Coffee 325ml', 4, 2.1, false, {}],
  ['Drinks', 'Bottled Water 24 pack', 6, 3.5, false, {}],
  ['Drinks', 'Oolong Tea 500ml', 2.75, 1.4, false, {}],
  ['Snacks', 'Seaweed Snack (12 pack)', 9, 5.4, false, {}],
  ['Snacks', 'Shrimp Chips 200g', 3.5, 1.9, false, {}],
  ['Snacks', 'Dried Mango 500g', 8, 4.8, false, {}],
  ['Snacks', 'Instant Noodles Box (30)', 15, 9.5, false, {}],
];

const FIRST = ['Alex', 'Sam', 'Jamie', 'Taylor', 'Jordan', 'Casey', 'Riley', 'Morgan', 'Avery', 'Quinn', 'Linh', 'Minh', 'Hoa', 'Tuan', 'Mai', 'Bao', 'Khanh', 'Phuong', 'Duc', 'Thao'];
const LAST = ['Nguyen', 'Tran', 'Le', 'Pham', 'Smith', 'Garcia', 'Johnson', 'Lee', 'Martinez', 'Brown', 'Vo', 'Dang'];
const COMPANIES = ['Harbor Mobile LLC', 'Pacific Gadget Traders', 'Sunset Phone Repair', 'Bayview Electronics', 'Golden Tech Supply', 'Corner Juice Bar', 'Lotus Tea House', 'Mesa Wireless', 'Northside Deli', 'Blue Door Cafe'];

const now = Date.now();
const start = now - 95 * DAY;
const at = (t) => ({ at: Math.min(t, now) });

console.log('Seeding catalogue…');
const insCat = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
const catId = (n) => (insCat.run(n), db.prepare('SELECT id FROM categories WHERE name = ?').get(n).id);
const insProduct = db.prepare(
  `INSERT INTO products (sku, barcode, name, category_id, brand, price, cost, min_stock, track_serial, attributes, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
);
const products = db.transaction(() =>
  CATALOG.map(([cat, name, price, cost, serial, attrs], i) => {
    const sku = serial ? 'M' + (1000 + i) + 'LL/A' : 'SP' + String(i + 1).padStart(5, '0');
    const barcode = String(190199000000 + i * 7919);
    const brand = ['Drinks', 'Snacks'].includes(cat) ? null : 'Apple';
    const { id } = insProduct.get(sku, barcode, name, catId(cat), brand, $(price), $(cost), serial ? 2 : 12, serial ? 1 : 0, JSON.stringify(attrs), start, start);
    return { id, name, price: $(price), cost: $(cost), serial, cat };
  })
)();

let serialNo = 0;
const makeSerial = (p) => {
  serialNo++;
  if (p.cat === 'iPhone') return '35' + String(4000000000000 + serialNo * 7777).slice(0, 13);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(rand() * chars.length)];
  return 'S' + s;
};

function receive(t, lines, supplier) {
  return createReceipt(
    db,
    admin,
    {
      supplier,
      items: lines.map(({ p, qty }) => ({
        product_id: p.id,
        qty,
        unit_cost: Math.round(p.cost * (0.95 + rand() * 0.1)),
        serials: p.serial ? Array.from({ length: qty }, () => makeSerial(p)) : undefined,
      })),
    },
    at(t)
  );
}

console.log('Seeding customers…');
const insCustomer = db.prepare(
  `INSERT INTO customers (code, name, phone, email, type, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, type`
);
const customers = db.transaction(() => {
  const list = [];
  for (let i = 0; i < 55; i++) {
    const company = i < COMPANIES.length;
    const name = company ? COMPANIES[i] : `${pick(FIRST)} ${pick(LAST)}`;
    const phone = `(555) ${between(200, 999)}-${String(between(0, 9999)).padStart(4, '0')}`;
    const email = company ? null : name.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com';
    list.push(insCustomer.get('KH' + String(i + 1).padStart(6, '0'), name, phone, email, company ? 'company' : 'person', start + i * 3600e3));
  }
  db.prepare("INSERT INTO counters (name, value) VALUES ('KH', 55) ON CONFLICT(name) DO UPDATE SET value = 55").run();
  return list;
})();

console.log('Seeding stock and sales…');
const suppliers = ['Apple Authorized Distributor', 'West Coast Wholesale', 'Asian Foods Supply'];
const serialProducts = products.filter((p) => p.serial);
const plainProducts = products.filter((p) => !p.serial);
receive(start, serialProducts.map((p) => ({ p, qty: between(4, 10) })), suppliers[0]);
receive(start, plainProducts.map((p) => ({ p, qty: between(40, 120) })), suppliers[1]);

const inStock = db.prepare("SELECT serial FROM serials WHERE product_id = ? AND status = 'in_stock' LIMIT ?");
const stockOf = db.prepare('SELECT stock FROM products WHERE id = ?');
const companies = customers.filter((c) => c.type === 'company');

db.transaction(() => {
  for (let day = 94; day >= 0; day--) {
    const dayStart = now - day * DAY - ((now - day * DAY) % DAY);
    if (day % 14 === 0) {
      const low = serialProducts.filter((p) => stockOf.get(p.id).stock < 4);
      if (low.length) receive(dayStart + 15 * 3600e3, low.map((p) => ({ p, qty: between(3, 8) })), suppliers[0]);
      const lowPlain = plainProducts.filter((p) => stockOf.get(p.id).stock < 30);
      if (lowPlain.length) receive(dayStart + 15 * 3600e3, lowPlain.map((p) => ({ p, qty: between(40, 100) })), pick(suppliers.slice(1)));
    }
    const count = between(2, 9);
    for (let n = 0; n < count; n++) {
      const t = dayStart + between(16, 27) * 3600e3 + between(0, 3599) * 1000;
      if (t > now) continue;
      const lines = [];
      const used = new Set();
      for (let k = between(1, 3); k > 0; k--) {
        const p = rand() < 0.45 ? pick(serialProducts) : pick(plainProducts);
        if (used.has(p.id)) continue;
        used.add(p.id);
        let qty = p.serial ? between(1, 2) : between(1, 6);
        let serials;
        if (p.serial) {
          serials = inStock.all(p.id, qty).map((r) => r.serial);
          if (!serials.length) continue;
          qty = serials.length;
        }
        const discount = p.serial && rand() < 0.3 ? Math.round(p.price * 0.02 / 100) * 100 : 0;
        lines.push({ product_id: p.id, qty, price: p.price, discount, serials });
      }
      if (!lines.length) continue;
      const wholesale = rand() < 0.25;
      const customer = wholesale ? pick(companies) : rand() < 0.6 ? pick(customers) : null;
      const total = lines.reduce((a, l) => a + l.qty * (l.price - l.discount), 0);
      const paid = wholesale && rand() < 0.6 ? Math.round((total * between(0, 5)) / 10 / 100) * 100 : total;
      createSale(db, admin, { customer_id: customer?.id, items: lines, paid, method: pick(['cash', 'card', 'transfer']) }, at(t));
    }
    // Some companies settle part of their tab each week.
    if (day % 7 === 3) {
      for (const c of companies) {
        const { debt } = db.prepare('SELECT debt FROM customers WHERE id = ?').get(c.id);
        if (debt > 0 && rand() < 0.5) {
          payCustomerDebt(db, admin, c.id, { amount: Math.max(100, Math.round((debt * between(3, 8)) / 10 / 100) * 100), method: 'transfer' }, at(dayStart + 24 * 3600e3));
        }
      }
    }
  }
  // One cancelled invoice and one open sales order, so those screens have something to show.
  const last = db.prepare("SELECT id FROM invoices WHERE kind = 'invoice' ORDER BY id DESC LIMIT 1 OFFSET 5").get();
  cancelInvoice(db, admin, last.id, at(now - 2 * 3600e3));
  const p = serialProducts[0];
  createSale(db, admin, { kind: 'order', customer_id: companies[0].id, items: [{ product_id: p.id, qty: 2, price: p.price }], note: 'Pick up Friday' }, at(now - 3600e3));
  // A stock take on the drinks shelf.
  const drinks = plainProducts.filter((x) => x.cat === 'Drinks').slice(0, 4);
  createStockTake(db, admin, {
    note: 'Drinks fridge count',
    balance: true,
    items: drinks.map((x) => ({ product_id: x.id, actual_qty: Math.max(0, stockOf.get(x.id).stock - between(0, 2)) })),
  }, at(now - 26 * 3600e3));
})();

if (big) {
  console.log('Adding 20,000 products and ~100,000 invoices for speed testing (this takes a minute)…');
  const bigCat = catId('Bulk test items');
  const bulk = db.transaction(() => {
    const ids = [];
    for (let i = 0; i < 20000; i++) {
      const price = between(100, 50000);
      const { id } = insProduct.get('BULK' + String(i).padStart(6, '0'), String(8900000000000 + i), `Test item ${i} ${pick(['red', 'blue', 'green', 'large', 'small', 'mini', 'pro'])} ${pick(['cable', 'case', 'snack', 'drink', 'charger', 'toy', 'mug'])}`, bigCat, null, price, Math.round(price * 0.6), 5, 0, '{}', start, start);
      ids.push({ id, price });
    }
    return ids;
  })();
  db.transaction(() => {
    for (let i = 0; i < 20000; i += 500) {
      const chunk = bulk.slice(i, i + 500);
      createReceipt(db, admin, { supplier: 'Bulk', items: chunk.map((p) => ({ product_id: p.id, qty: 1000, unit_cost: Math.round(p.price * 0.6) })) }, at(start));
    }
  })();
  db.transaction(() => {
    for (let n = 0; n < 100000; n++) {
      const t = start + Math.floor(rand() * (now - start));
      const lines = [];
      for (let k = between(1, 4); k > 0; k--) {
        const p = pick(bulk);
        if (!lines.some((l) => l.product_id === p.id)) lines.push({ product_id: p.id, qty: between(1, 3), price: p.price });
      }
      createSale(db, admin, { customer_id: rand() < 0.5 ? pick(customers).id : undefined, items: lines }, at(t));
    }
  })();
}

db.pragma('optimize');
const counts = db.prepare(
  `SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM customers) AS customers,
          (SELECT COUNT(*) FROM invoices WHERE kind = 'invoice') AS invoices, (SELECT COUNT(*) FROM serials) AS serials`
).get();
console.log('Done:', counts);
db.close();
