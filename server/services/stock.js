/** Changes a product's stock by `qty` and writes a stock-card line. Call inside a transaction. */
export function moveStock(db, productId, qty, { type, id = null, code = null, unitCost = null, at = Date.now() }) {
  const { stock } = db
    .prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ? RETURNING stock')
    .get(qty, at, productId);
  db.prepare(
    `INSERT INTO stock_moves (product_id, created_at, ref_type, ref_id, ref_code, qty, balance, unit_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(productId, at, type, id, code, qty, stock, unitCost);
  return stock;
}
