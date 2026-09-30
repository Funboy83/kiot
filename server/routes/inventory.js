import { notFound, paging } from '../lib.js';
import { createReceipt, createStockTake, updateStockTake } from '../services/inventory.js';

export default function inventory(app, db) {
  app.get('/api/receipts', (c) => {
    const { size, offset, page } = paging(c.req.query());
    const rows = db
      .prepare(
        `SELECT r.*, u.name AS user_name, (SELECT SUM(qty) FROM receipt_items WHERE receipt_id = r.id) AS qty
         FROM receipts r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`
      )
      .all(size + 1, offset);
    return c.json({ rows: rows.slice(0, size), more: rows.length > size, page, size });
  });

  app.get('/api/receipts/:id', (c) => {
    const r = db
      .prepare('SELECT r.*, u.name AS user_name FROM receipts r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?')
      .get(c.req.param('id'));
    if (!r) throw notFound('Receipt not found');
    r.items = db
      .prepare(
        `SELECT ri.*, p.name, p.sku FROM receipt_items ri JOIN products p ON p.id = ri.product_id
         WHERE ri.receipt_id = ? ORDER BY ri.id`
      )
      .all(r.id);
    const serials = db.prepare('SELECT product_id, serial FROM serials WHERE receipt_id = ? ORDER BY serial').all(r.id);
    for (const it of r.items) it.serials = serials.filter((s) => s.product_id === it.product_id).map((s) => s.serial);
    return c.json(r);
  });

  app.post('/api/receipts', async (c) => c.json(createReceipt(db, c.get('user'), await c.req.json()), 201));

  app.get('/api/stocktakes', (c) => {
    const { size, offset, page } = paging(c.req.query());
    const rows = db
      .prepare(
        `SELECT st.*, u.name AS user_name, (SELECT COUNT(*) FROM stock_take_items WHERE stock_take_id = st.id) AS lines
         FROM stock_takes st LEFT JOIN users u ON u.id = st.user_id
         ORDER BY st.created_at DESC, st.id DESC LIMIT ? OFFSET ?`
      )
      .all(size + 1, offset);
    return c.json({ rows: rows.slice(0, size), more: rows.length > size, page, size });
  });

  app.get('/api/stocktakes/:id', (c) => {
    const st = db
      .prepare('SELECT st.*, u.name AS user_name FROM stock_takes st LEFT JOIN users u ON u.id = st.user_id WHERE st.id = ?')
      .get(c.req.param('id'));
    if (!st) throw notFound('Stock take not found');
    st.items = db
      .prepare(
        `SELECT i.*, p.name, p.sku, p.track_serial, p.stock AS current_stock, p.cost AS current_cost
         FROM stock_take_items i JOIN products p ON p.id = i.product_id WHERE i.stock_take_id = ? ORDER BY i.id`
      )
      .all(st.id)
      .map((it) => ({ ...it, serials: it.serials ? JSON.parse(it.serials) : null }));
    return c.json(st);
  });

  app.post('/api/stocktakes', async (c) => c.json(createStockTake(db, c.get('user'), await c.req.json()), 201));

  app.put('/api/stocktakes/:id', async (c) => {
    updateStockTake(db, c.get('user'), Number(c.req.param('id')), await c.req.json());
    return c.json({ ok: true });
  });
}
