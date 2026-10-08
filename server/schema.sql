-- All money is stored as integer cents. All timestamps are epoch milliseconds (UTC).
-- biz_date is the store-local calendar day (YYYY-MM-DD), fixed when the record is created,
-- so daily reports never depend on the server's timezone.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  barcode TEXT COLLATE NOCASE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  brand TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  track_serial INTEGER NOT NULL DEFAULT 0,
  attributes TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS products_active_created ON products(active, created_at DESC);
CREATE INDEX IF NOT EXISTS products_active_name ON products(active, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS products_category ON products(category_id);

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  name, sku, barcode, content='products', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, name, sku, barcode) VALUES (new.id, new.name, new.sku, new.barcode);
END;
CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, sku, barcode) VALUES ('delete', old.id, old.name, old.sku, old.barcode);
END;
CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE OF name, sku, barcode ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, sku, barcode) VALUES ('delete', old.id, old.name, old.sku, old.barcode);
  INSERT INTO products_fts(rowid, name, sku, barcode) VALUES (new.id, new.name, new.sku, new.barcode);
END;

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  type TEXT NOT NULL DEFAULT 'person' CHECK (type IN ('person', 'company')),
  note TEXT,
  debt INTEGER NOT NULL DEFAULT 0,
  total_sales INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS customers_created ON customers(created_at DESC);
CREATE INDEX IF NOT EXISTS customers_debt ON customers(debt DESC) WHERE debt <> 0;
CREATE INDEX IF NOT EXISTS customers_sales ON customers(total_sales DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS customers_fts USING fts5(
  name, code, phone, content='customers', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS customers_ai AFTER INSERT ON customers BEGIN
  INSERT INTO customers_fts(rowid, name, code, phone) VALUES (new.id, new.name, new.code, new.phone);
END;
CREATE TRIGGER IF NOT EXISTS customers_ad AFTER DELETE ON customers BEGIN
  INSERT INTO customers_fts(customers_fts, rowid, name, code, phone) VALUES ('delete', old.id, old.name, old.code, old.phone);
END;
CREATE TRIGGER IF NOT EXISTS customers_au AFTER UPDATE OF name, code, phone ON customers BEGIN
  INSERT INTO customers_fts(customers_fts, rowid, name, code, phone) VALUES ('delete', old.id, old.name, old.code, old.phone);
  INSERT INTO customers_fts(rowid, name, code, phone) VALUES (new.id, new.name, new.code, new.phone);
END;

-- Sales invoices and sales orders share one table.
-- kind='invoice': status completed | cancelled (moves stock, serials and debt)
-- kind='order':   status open | converted | cancelled (reserves nothing)
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'order')),
  status TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  user_id INTEGER REFERENCES users(id),
  order_id INTEGER REFERENCES invoices(id),
  created_at INTEGER NOT NULL,
  biz_date TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  cost_total INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS invoices_kind_created ON invoices(kind, created_at DESC, id DESC);
-- Covering index: date-range totals and daily reports never touch the table itself.
CREATE INDEX IF NOT EXISTS invoices_report ON invoices(kind, status, biz_date, total, paid, subtotal, discount, cost_total, customer_id);
CREATE INDEX IF NOT EXISTS invoices_customer ON invoices(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_unpaid ON invoices(customer_id, created_at)
  WHERE kind = 'invoice' AND status = 'completed' AND paid < total;

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0, -- per unit
  unit_cost INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invoice_items_invoice ON invoice_items(invoice_id, product_id, qty, total, unit_cost);
CREATE INDEX IF NOT EXISTS invoice_items_product ON invoice_items(product_id);

CREATE TABLE IF NOT EXISTS serials (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  serial TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'sold', 'missing')),
  cost INTEGER,
  receipt_id INTEGER REFERENCES receipts(id),
  invoice_id INTEGER REFERENCES invoices(id),
  received_at INTEGER NOT NULL,
  sold_at INTEGER
);
CREATE INDEX IF NOT EXISTS serials_product ON serials(product_id, status);
CREATE INDEX IF NOT EXISTS serials_invoice ON serials(invoice_id);

-- History of which serials went out on which invoice line (kept after a cancel).
CREATE TABLE IF NOT EXISTS invoice_item_serials (
  item_id INTEGER NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  serial_id INTEGER NOT NULL REFERENCES serials(id),
  PRIMARY KEY (item_id, serial_id)
);
CREATE INDEX IF NOT EXISTS invoice_item_serials_serial ON invoice_item_serials(serial_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customers(id),
  invoice_id INTEGER REFERENCES invoices(id),
  amount INTEGER NOT NULL, -- negative for refunds
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'card', 'transfer')),
  created_at INTEGER NOT NULL,
  biz_date TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  note TEXT
);
CREATE INDEX IF NOT EXISTS payments_customer ON payments(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS payments_date ON payments(biz_date);

-- A debt payment not tied to one invoice is spread over the oldest unpaid invoices.
CREATE TABLE IF NOT EXISTS payment_allocations (
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount INTEGER NOT NULL,
  PRIMARY KEY (payment_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS payment_allocations_invoice ON payment_allocations(invoice_id);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  supplier TEXT,
  created_at INTEGER NOT NULL,
  biz_date TEXT NOT NULL,
  total INTEGER NOT NULL,
  note TEXT,
  user_id INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS receipts_created ON receipts(created_at DESC);

CREATE TABLE IF NOT EXISTS receipt_items (
  id INTEGER PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL,
  total INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receipt_items_receipt ON receipt_items(receipt_id);

CREATE TABLE IF NOT EXISTS stock_takes (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'balanced')),
  note TEXT,
  created_at INTEGER NOT NULL,
  balanced_at INTEGER,
  diff_qty INTEGER NOT NULL DEFAULT 0,
  diff_value INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS stock_takes_created ON stock_takes(created_at DESC);

CREATE TABLE IF NOT EXISTS stock_take_items (
  id INTEGER PRIMARY KEY,
  stock_take_id INTEGER NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  system_qty INTEGER, -- filled in when balanced
  actual_qty INTEGER NOT NULL,
  unit_cost INTEGER,
  serials TEXT, -- JSON array of counted serials, for serial-tracked products
  UNIQUE (stock_take_id, product_id)
);

-- Stock card: every change to a product's stock, with the balance after it.
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  created_at INTEGER NOT NULL,
  ref_type TEXT NOT NULL, -- sale | cancel | receipt | stocktake | initial
  ref_id INTEGER,
  ref_code TEXT,
  qty INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  unit_cost INTEGER
);
CREATE INDEX IF NOT EXISTS stock_moves_product ON stock_moves(product_id, id DESC);

-- Assistant conversations. `messages` is the model-facing history (JSON), `display` what the chat panel shows.
CREATE TABLE IF NOT EXISTS ai_chats (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]',
  display TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '[]', -- outcomes of action cards, told to the model with the next question
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_chats_user ON ai_chats(user_id, updated_at DESC);

-- Changes the assistant proposed. They run only when the user confirms the card.
CREATE TABLE IF NOT EXISTS ai_actions (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  input TEXT NOT NULL,
  card TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'cancelled')),
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_actions_chat ON ai_actions(chat_id);
