import { get, money } from '../api.js';
import { SearchSelect } from './ui.jsx';

export function InventoryTabs({ active }) {
  return (
    <div class="tabs" style="margin-bottom:16px">
      <a class={'btn ghost' + (active === 'receipts' ? ' on-link' : '')} href="/inventory">Goods receipts</a>
      <a class={'btn ghost' + (active === 'stocktakes' ? ' on-link' : '')} href="/stocktakes">Stock takes</a>
    </div>
  );
}

/** Product search used on receipt and stock-take forms; Enter resolves an exact barcode/SKU/serial. */
export function ProductAdder({ onAdd, placeholder = 'Scan or search a product to add' }) {
  const load = async (q, signal) => (await get('/products?size=12&sort=name&q=' + encodeURIComponent(q), signal)).rows;
  const onEnter = async (code) => {
    try {
      const r = await get('/products/lookup?code=' + encodeURIComponent(code));
      onAdd(r.product, r.serial?.serial);
      return true;
    } catch {
      const r = await get('/products?size=1&q=' + encodeURIComponent(code));
      if (r.rows[0]) onAdd(r.rows[0]);
      return !!r.rows[0];
    }
  };
  return (
    <SearchSelect load={load} onEnter={onEnter} onPick={(p) => onAdd(p)} placeholder={placeholder}
      render={(p) => (<><span class="grow">{p.name} <span class="faint small">{p.sku}</span></span><span class="small muted">stock {p.stock}</span><span class="num">{money(p.cost)}</span></>)} />
  );
}

/** Splits pasted/scanned text into serial numbers. */
export const splitSerials = (text) => [...new Set(String(text).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
