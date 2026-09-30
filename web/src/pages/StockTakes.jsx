import { useLocation } from 'preact-iso';
import { money, num, dateTime } from '../api.js';
import { useFetch, useQueryParams, Pager, Empty, Status, ErrorBox } from '../components/ui.jsx';
import { InventoryTabs } from '../components/inventory.jsx';

export default function StockTakes() {
  const [query, setQuery] = useQueryParams({ page: '1' });
  const { route } = useLocation();
  const { data, error } = useFetch('/stocktakes?page=' + query.page);
  return (
    <>
      <div class="page-head">
        <h1>Inventory</h1>
        <span class="spacer" />
        <a class="btn primary" href="/stocktakes/new">＋ New stock take</a>
      </div>
      <InventoryTabs active="stocktakes" />
      <ErrorBox error={error} />
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Code</th><th>Created</th><th>Status</th><th class="num hide-sm">Lines</th><th class="num">Qty difference</th><th class="num hide-sm">Value difference</th><th class="hide-md">Note</th></tr></thead>
            <tbody>
              {data?.rows.map((s) => (
                <tr key={s.id} class="click" onClick={() => route(`/stocktakes/${s.id}`)}>
                  <td class="code"><a href={`/stocktakes/${s.id}`}>{s.code}</a></td>
                  <td class="nowrap">{dateTime(s.created_at)}</td>
                  <td><Status value={s.status} /></td>
                  <td class="num hide-sm">{num(s.lines)}</td>
                  <td class={'num ' + (s.diff_qty < 0 ? 'down' : s.diff_qty > 0 ? 'up' : '')}>{s.status === 'balanced' ? num(s.diff_qty) : '—'}</td>
                  <td class="num hide-sm">{s.status === 'balanced' ? money(s.diff_value) : '—'}</td>
                  <td class="hide-md muted">{s.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !data.rows.length && <Empty>No stock takes yet</Empty>}
        {data && <Pager page={data.page} size={data.size} more={data.more} onPage={(page) => setQuery({ page: String(page) })} />}
      </div>
    </>
  );
}
