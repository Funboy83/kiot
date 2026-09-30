import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { money, num, dateTime, del, post } from '../api.js';
import { useFetch, useQueryParams, Status, Pager, Empty, ErrorBox, toast, SearchInput } from '../components/ui.jsx';

const MOVE_LABEL = { sale: 'Sale', cancel: 'Invoice cancelled', receipt: 'Goods received', stocktake: 'Stock take', initial: 'Opening stock' };

function refHref(m) {
  if (m.ref_type === 'sale' || m.ref_type === 'cancel') return `/invoices/${m.ref_id}`;
  if (m.ref_type === 'receipt') return `/inventory/receipts/${m.ref_id}`;
  if (m.ref_type === 'stocktake') return `/stocktakes/${m.ref_id}`;
  return null;
}

export default function ProductDetail({ params }) {
  const { route } = useLocation();
  const [query, setQuery] = useQueryParams({ tab: 'info' });
  const { data: p, error, reload } = useFetch(`/products/${params.id}`);
  if (error) return <ErrorBox error={error} />;
  if (!p) return <div class="empty">Loading…</div>;
  const tabs = [['info', 'Details'], ['moves', 'Stock card'], ...(p.track_serial ? [['serials', `Serial/IMEI (${p.serial_counts.in_stock || 0} in stock)`]] : [])];

  const remove = async () => {
    if (!confirm(`Hide ${p.name}? It stays on past invoices and can be restored.`)) return;
    await del(`/products/${p.id}`);
    toast('Product hidden');
    route('/products');
  };
  const restore = async () => {
    await post(`/products/${p.id}/restore`);
    reload();
  };

  return (
    <div class="stack">
      <div class="detail-head">
        <a href="/products" class="muted">← Products</a>
        <h1>{p.name}</h1>
        {p.track_serial ? <span class="badge info">Serial/IMEI tracked</span> : null}
        {!p.active && <span class="badge bad">Hidden</span>}
        <span class="spacer" />
        {p.active ? <button class="danger" onClick={remove}>Hide</button> : <button onClick={restore}>Restore</button>}
        <a class="btn" href={`/products/new?copy=${p.id}`}>Copy</a>
        <a class="btn primary" href={`/products/${p.id}/edit`}>Edit</a>
      </div>
      <div class="kpis">
        <div class="card kpi"><div class="label">Price</div><div class="value">{money(p.price)}</div></div>
        <div class="card kpi"><div class="label">Average cost</div><div class="value">{money(p.cost)}</div><div class="sub">margin {p.price ? (((p.price - p.cost) / p.price) * 100).toFixed(1) : 0}%</div></div>
        <div class="card kpi"><div class="label">In stock</div><div class={'value ' + (p.stock <= 0 ? 'down' : '')}>{num(p.stock)}</div><div class="sub">min {p.min_stock} · value {money(Math.max(p.stock, 0) * p.cost)}</div></div>
      </div>
      <div class="card">
        <div class="tabs" role="tablist">
          {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={query.tab === k} class={query.tab === k ? 'on' : ''} onClick={() => setQuery({ tab: k })}>{label}</button>)}
        </div>
        {query.tab === 'info' && (
          <dl class="kv">
            <dt>SKU</dt><dd>{p.sku}</dd>
            <dt>Barcode</dt><dd>{p.barcode || '—'}</dd>
            <dt>Category</dt><dd>{p.category || '—'}</dd>
            <dt>Brand</dt><dd>{p.brand || '—'}</dd>
            {Object.entries(p.attributes).map(([k, v]) => [<dt key={k}>{k}</dt>, <dd key={k + 'v'}>{v}</dd>])}
            <dt>Created</dt><dd>{dateTime(p.created_at)}</dd>
            <dt>Updated</dt><dd>{dateTime(p.updated_at)}</dd>
          </dl>
        )}
        {query.tab === 'moves' && <Moves id={p.id} />}
        {query.tab === 'serials' && <Serials id={p.id} counts={p.serial_counts} />}
      </div>
    </div>
  );
}

function Moves({ id }) {
  const [page, setPage] = useState(1);
  const { data } = useFetch(`/products/${id}/moves?page=${page}`);
  if (!data) return <div class="empty">Loading…</div>;
  if (!data.rows.length) return <Empty>No stock movement yet</Empty>;
  return (
    <>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Document</th><th>Type</th><th class="hide-sm">Time</th><th class="num">Change</th><th class="num">Balance</th></tr></thead>
          <tbody>
            {data.rows.map((m) => (
              <tr key={m.id}>
                <td class="code">{refHref(m) ? <a href={refHref(m)}>{m.ref_code}</a> : m.ref_code || '—'}</td>
                <td>{MOVE_LABEL[m.ref_type] || m.ref_type}</td>
                <td class="hide-sm muted nowrap">{dateTime(m.created_at)}</td>
                <td class={'num ' + (m.qty < 0 ? 'down' : 'up')}>{m.qty > 0 ? '+' : ''}{num(m.qty)}</td>
                <td class="num">{num(m.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} size={data.size} more={data.more} onPage={setPage} />
    </>
  );
}

function Serials({ id, counts }) {
  const [status, setStatus] = useState('in_stock');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data } = useFetch(`/products/${id}/serials?page=${page}&status=${status}&q=${encodeURIComponent(q)}`);
  return (
    <>
      <div class="filters">
        <SearchInput value={q} onSearch={(v) => { setQ(v); setPage(1); }} placeholder="Find serial/IMEI" />
        <select value={status} onChange={(e) => { setStatus(e.currentTarget.value); setPage(1); }} aria-label="Status">
          <option value="in_stock">In stock ({counts.in_stock || 0})</option>
          <option value="sold">Sold ({counts.sold || 0})</option>
          <option value="missing">Missing ({counts.missing || 0})</option>
          <option value="">All</option>
        </select>
      </div>
      {!data ? <div class="empty">Loading…</div> : !data.rows.length ? <Empty>No serials here</Empty> : (
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Serial/IMEI</th><th>Status</th><th class="num hide-sm">Cost</th><th class="hide-sm">Received</th><th>Sold on</th></tr></thead>
            <tbody>
              {data.rows.map((s) => (
                <tr key={s.id}>
                  <td><span class="chip">{s.serial}</span></td>
                  <td><Status value={s.status} /></td>
                  <td class="num hide-sm">{s.cost != null ? money(s.cost) : '—'}</td>
                  <td class="hide-sm muted nowrap">{s.receipt_id ? <a href={`/inventory/receipts/${s.receipt_id}`}>{s.receipt_code}</a> : ''} {dateTime(s.received_at).slice(0, 10)}</td>
                  <td>{s.invoice_id ? <a href={`/invoices/${s.invoice_id}`}>{s.invoice_code}</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={page} size={data.size} more={data.more} onPage={setPage} />}
    </>
  );
}
