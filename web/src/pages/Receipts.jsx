import { useLocation } from 'preact-iso';
import { money, num, dateTime } from '../api.js';
import { useFetch, useQueryParams, Pager, Empty, ErrorBox } from '../components/ui.jsx';
import { InventoryTabs } from '../components/inventory.jsx';

export default function Receipts() {
  const [query, setQuery] = useQueryParams({ page: '1' });
  const { route } = useLocation();
  const { data, error } = useFetch('/receipts?page=' + query.page);
  return (
    <>
      <div class="page-head">
        <h1>Inventory</h1>
        <span class="spacer" />
        <a class="btn primary" href="/inventory/receipts/new">＋ Receive goods</a>
      </div>
      <InventoryTabs active="receipts" />
      <ErrorBox error={error} />
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Code</th><th>Time</th><th class="hide-sm">Supplier</th><th class="num">Qty</th><th class="num">Total cost</th><th class="hide-md">By</th></tr></thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id} class="click" onClick={() => route(`/inventory/receipts/${r.id}`)}>
                  <td class="code"><a href={`/inventory/receipts/${r.id}`}>{r.code}</a></td>
                  <td class="nowrap">{dateTime(r.created_at)}</td>
                  <td class="hide-sm">{r.supplier}</td>
                  <td class="num">{num(r.qty)}</td>
                  <td class="num">{money(r.total)}</td>
                  <td class="hide-md muted">{r.user_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !data.rows.length && <Empty>No goods received yet</Empty>}
        {data && <Pager page={data.page} size={data.size} more={data.more} onPage={(page) => setQuery({ page: String(page) })} />}
      </div>
    </>
  );
}
