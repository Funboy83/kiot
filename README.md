# Kiot — a fast, lean store manager

A trimmed-down rebuild of the KiotViet admin + POS, built for speed and phones.
It keeps the core (POS, products with serial/IMEI tracking, stock, invoices and
orders, customers with debt, sales and profit reports) and drops the rest.

## Run it

```bash
npm install
npm run seed      # demo data in data/store.db (made up, nothing from the real store)
npm run dev       # API on :3000, app on http://localhost:5173
```

Sign in with `admin` / `admin123`, then change the password under **Settings & staff**.

Production:

```bash
npm run build
ADMIN_PASSWORD='something-strong' npm start      # serves app + API on :3000 (PORT to change)
```

`DB_FILE` sets the database path (default `data/store.db`). Back it up by copying
that file (or `sqlite3 data/store.db ".backup backup.db"` while running).
Restart the server after each `npm run build`.

## Assistant (AI)

Press **✨ Assistant** in the top bar (or Ctrl/Cmd+J) and ask about the store in English or
Vietnamese: "ai còn đang nợ?", "top 10 products this month", "what will run out in two weeks?",
"compare this month with last month". Answers stream in, with the store's own tables (sort,
show all, export to CSV/Excel), small charts, highlights, suggested next steps and follow-up
questions. Conversations are kept per user (☰ to reopen), with 👍/👎 and copy on every answer.

It can also **do the work**. Paste a customer's message ("anh Nam 0909… lấy 2 cáp USB-C với
1 iPhone 17 Pro, ck trước 500, còn lại ghi nợ") and it finds the customer and products and
prepares the invoice; when something is unclear it asks, with clickable answers. It can likewise
prepare payments, cancellations, new or changed customers and products, goods receipts, stock
corrections and (admins only) settings. Every change appears as a card with the parsed details:
customer, lines, serial/IMEI picked, total, paid now, payment method and the debt afterwards.
Paid amount, method and serials can be changed on the card. **Nothing is saved until you press
the card's button**; Dismiss drops it. A confirmed card runs through the app's own API as the
signed-in user, so the same checks and permissions as the screens apply, and the assistant is
told the outcome on the next message. Its read tools never see users, passwords or sessions, and
cashiers get no cost or profit figures.

To switch it on, set an API key from https://console.anthropic.com on the server and restart:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Without a key the panel says how to set it up; the rest of the app is unaffected. Never commit
the key. Optional: `AI_MODEL` (default `claude-opus-5-5`) and `AI_EFFORT` (default `low`,
fastest; `medium` or `high` for harder analysis).

How it works: `server/ai/tools.js` holds purpose-built queries (sales summary and trend, top
products and customers, customer debts with ageing, product and customer lookup, stock health)
plus a guarded `run_sql` fallback for admins (`server/ai/readonly-sql.js`: single SELECT only,
checked against SQLite's own read-only flag and compiled program, run in a separate read-only
process with a 5 s limit). Tables go straight from the tool to the panel, so the model never
retypes rows and numbers are exact. Actions live in `server/ai/actions.js`: each has a
`prepare` (checks the request, builds the card) and an `execute` (calls the app's API), and
`/api/ai/actions/:id/confirm` runs a card at most once.

## Simple and Advanced mode

New stores start in **Simple** mode: the top bar shows Dashboard, Products, Invoices and
Customers, and the sale screen and product form hide per-line discounts, sales orders, SKU,
brand, minimum stock and attributes. **Advanced** mode adds Orders, Inventory (goods receipts,
stock takes) and Reports, and every option. Admins switch from the name menu, on Settings, or by
asking the assistant. Pages hidden in Simple mode still open from links.

## Stack and why it is fast

- **Server:** Node 20+, [Hono](https://hono.dev), SQLite via `better-sqlite3` (WAL mode).
  One process, one file, no network hop to a database. Typical API calls take 1–15 ms.
- **Search:** SQLite FTS5 trigram indexes on products and customers, so "phone 17"
  or part of a phone number matches instantly; exact barcode/SKU/IMEI lookups use
  unique indexes.
- **Lists:** server-side paging (50 rows), totals row computed with covering indexes.
- **App:** Preact + Vite. First load is ~13 KB of JS gzipped; every screen is its own
  small chunk (POS is ~5 KB). Hashed assets are cached for a year.
- **POS:** keyboard first (F3 product, F4 customer, F9 pay, F2 new tab), scanner friendly
  (Enter resolves barcode, SKU or IMEI exactly), several carts open at once, carts
  survive a page reload.

`npm run seed:big` builds a stress database with 20,000 products and ~100,000
invoices. On it, product search is ~6 ms, invoice lists ~7–15 ms, the daily sales
report ~8 ms, and the dashboard ~160 ms.

## What's in it

| Area | Features |
|---|---|
| POS | multi-tab carts, barcode/IMEI scan, per-line price and discount, invoice discount, cash/card/transfer, change or credit to customer debt, save as order |
| Products | categories, brand, free-form attributes (STORAGE, COLOR, CONDITION…), opening stock, hide/restore, copy |
| Serial/IMEI | every unit recorded on receipt, picked at sale, shown on invoice, searchable everywhere, stock take marks unscanned units missing |
| Inventory | goods receipts (moving-average cost), stock takes with draft/balance, stock card per product |
| Sales | invoices and sales orders, cancel (restores stock, serials, debt, records refund), collect payment later, printable invoice |
| Customers | debt and total sales, debt payment applied to oldest invoices first, payment history |
| Reports | dashboard, sales and profit by day, profit by product, debt ageing (0–30/31–60/61–90/90+) |
| Staff | admin and cashier roles; cashiers do not see profit reports or settings |

Money is stored in integer cents. Each sale is stamped with the store-local day
(timezone in Settings), so daily reports never shift with the server's clock.

## Tests

```bash
npm test
```

Covers auth, search, receipts, serial sales, credit and change, FIFO debt payment,
cancel, order conversion, stock takes and report totals, and the assistant (tool loop,
streaming, history, read-only SQL guard, roles) against a scripted stand-in for the API.

## Deploying

Any host that runs Node and keeps a disk works: a small VPS, Fly.io or Railway with
a volume, or a mini PC in the shop. Serverless hosts like Vercel do not keep the
SQLite file between requests, so they are not a fit as-is. A `Dockerfile` is included.
