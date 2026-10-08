import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { money, num, qs } from '../api.js';
import { useFetch, useQueryParams, SearchInput, Pager, Empty, ErrorBox } from '../components/ui.jsx';
import { CustomerFormModal } from './CustomerDetail.jsx';

export default function Customers() {
  const [query, setQuery] = useQueryParams({ sort: 'newest' });
  const { route } = useLocation();
  const [creating, setCreating] = useState(false);
  const { data, error, loading } = useFetch('/customers' + qs(query));
  const t = data?.totals;
  return (
    <>
      <div class="page-head">
        <h1>Customers</h1>
        {t && <span class="muted">{num(t.count)}</span>}
        <span class="spacer" />
        <button class="primary" onClick={() => setCreating(true)}>＋ New customer</button>
      </div>
      <div class="filters">
        <SearchInput value={query.q} onSearch={(q) => setQuery({ q })} placeholder="Name, code or phone" autoFocus />
        <label class="row btn" style="gap:6px">
          <input type="checkbox" checked={query.debt === '1'} onChange={(e) => setQuery({ debt: e.currentTarget.checked ? '1' : '' })} /> Owes money
        </label>
        <select value={query.sort} onChange={(e) => setQuery({ sort: e.currentTarget.value })} aria-label="Sort">
          <option value="newest">Newest</option>
          <option value="name">Name A–Z</option>
          <option value="debt">Highest debt</option>
          <option value="sales">Top buyers</option>
        </select>
      </div>
      <ErrorBox error={error} />
      <div class="card flush" style={{ opacity: loading ? 0.6 : 1 }}>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th class="hide-sm">Code</th><th>Name</th><th class="hide-sm">Phone</th><th class="num">Debt</th><th class="num hide-sm">Total sales</th></tr></thead>
            <tbody>
              {t && <tr class="totals"><td class="hide-sm" /><td /><td class="hide-sm" /><td class="num">{money(t.debt)}</td><td class="num hide-sm">{money(t.total_sales)}</td></tr>}
              {data?.rows.map((c) => (
                <tr key={c.id} class="click" onClick={() => route(`/customers/${c.id}`)}>
                  <td class="code hide-sm">{c.code}</td>
                  <td><a href={`/customers/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.name}</a>{c.type === 'company' && <span class="badge" style="margin-left:6px">Company</span>}<div class="small faint show-sm">{c.phone}</div></td>
                  <td class="hide-sm">{c.phone}</td>
                  <td class={'num ' + (c.debt > 0 ? 'down' : '')}>{money(c.debt)}</td>
                  <td class="num hide-sm">{money(c.total_sales)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !data.rows.length && <Empty>No customers match</Empty>}
        {data && <Pager page={data.page} size={data.size} count={Number(query.page) > 1 ? null : t?.count} more={data.rows.length === data.size} onPage={(page) => setQuery({ page })} />}
      </div>
      {creating && <CustomerFormModal onClose={() => setCreating(false)} onSaved={(c) => route(`/customers/${c.id}`)} />}
    </>
  );
}
