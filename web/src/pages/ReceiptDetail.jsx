import { money, num, dateTime } from '../api.js';
import { useFetch, ErrorBox } from '../components/ui.jsx';

export default function ReceiptDetail({ params }) {
  const { data: r, error } = useFetch(`/receipts/${params.id}`);
  if (error) return <ErrorBox error={error} />;
  if (!r) return <div class="empty">Loading…</div>;
  return (
    <div class="stack">
      <div class="detail-head">
        <a href="/inventory" class="muted no-print">← Inventory</a>
        <h1>Goods receipt {r.code}</h1>
        <span class="spacer" />
        <button class="no-print" onClick={() => window.print()}>Print</button>
      </div>
      <div class="card">
        <dl class="kv">
          <dt>Supplier</dt><dd>{r.supplier || '—'}</dd>
          <dt>Time</dt><dd>{dateTime(r.created_at)}</dd>
          <dt>By</dt><dd>{r.user_name}</dd>
          {r.note && [<dt key="n">Note</dt>, <dd key="nv">{r.note}</dd>]}
        </dl>
      </div>
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Total</th></tr></thead>
            <tbody>
              {r.items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <a href={`/products/${it.product_id}`}>{it.name}</a> <span class="faint small">{it.sku}</span>
                    {it.serials.length > 0 && <div>{it.serials.map((s) => <span class="chip" key={s}>{s}</span>)}</div>}
                  </td>
                  <td class="num">{num(it.qty)}</td>
                  <td class="num">{money(it.unit_cost)}</td>
                  <td class="num">{money(it.total)}</td>
                </tr>
              ))}
              <tr class="totals"><td>Total</td><td class="num">{num(r.items.reduce((a, i) => a + i.qty, 0))}</td><td /><td class="num">{money(r.total)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
