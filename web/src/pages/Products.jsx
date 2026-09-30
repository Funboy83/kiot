import { useLocation } from 'preact-iso';
import { money, num, qs, dateTime } from '../api.js';
import { useFetch, useQueryParams, SearchInput, Pager, Empty, ErrorBox } from '../components/ui.jsx';

export default function Products() {
  const [query, setQuery] = useQueryParams({ sort: 'newest' });
  const { route } = useLocation();
  const { data, error, loading } = useFetch('/products' + qs(query));
  const { data: cats } = useFetch('/categories');
  const totals = data?.totals;
  return (
    <>
      <div class="page-head">
        <h1>Products</h1>
        {totals && <span class="muted">{num(totals.count)} items</span>}
        <span class="spacer" />
        <a class="btn primary" href="/products/new">＋ New product</a>
      </div>
      <div class="filters">
        <SearchInput value={query.q} onSearch={(q) => setQuery({ q })} placeholder="Name, SKU, barcode or IMEI" autoFocus />
        <select value={query.category || ''} onChange={(e) => setQuery({ category: e.currentTarget.value })} aria-label="Category">
          <option value="">All categories</option>
          {cats?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.products})</option>)}
        </select>
        <select value={query.stock || ''} onChange={(e) => setQuery({ stock: e.currentTarget.value })} aria-label="Stock">
          <option value="">Any stock</option>
          <option value="in">In stock</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
          <option value="negative">Negative stock</option>
        </select>
        <select value={query.serial || ''} onChange={(e) => setQuery({ serial: e.currentTarget.value })} aria-label="Tracking">
          <option value="">All products</option>
          <option value="1">Serial/IMEI tracked</option>
        </select>
        <select value={query.sort} onChange={(e) => setQuery({ sort: e.currentTarget.value })} aria-label="Sort">
          <option value="newest">Newest</option>
          <option value="name">Name A–Z</option>
          <option value="stock">Most stock</option>
          <option value="stock_asc">Least stock</option>
          <option value="price">Highest price</option>
        </select>
      </div>
      <ErrorBox error={error} />
      <div class="card flush" style={{ opacity: loading ? 0.6 : 1 }}>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th class="hide-sm">SKU</th>
                <th>Name</th>
                <th class="num">Price</th>
                <th class="num hide-sm">Cost</th>
                <th class="num">Stock</th>
                <th class="hide-md">Category</th>
                <th class="hide-md">Created</th>
              </tr>
            </thead>
            <tbody>
              {totals && (
                <tr class="totals">
                  <td class="hide-sm" />
                  <td>Stock value {money(totals.stock_value)}</td>
                  <td /><td class="hide-sm" />
                  <td class="num">{num(totals.stock)}</td>
                  <td class="hide-md" /><td class="hide-md" />
                </tr>
              )}
              {data?.rows.map((p) => (
                <tr key={p.id} class="click" onClick={() => route(`/products/${p.id}`)}>
                  <td class="code hide-sm">{p.sku}</td>
                  <td>
                    <a href={`/products/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.name}</a>
                    {p.track_serial ? <span class="badge info" style="margin-left:6px">IMEI</span> : null}
                    <div class="small faint show-sm">{p.sku}</div>
                  </td>
                  <td class="num">{money(p.price)}</td>
                  <td class="num hide-sm muted">{money(p.cost)}</td>
                  <td class={'num ' + (p.stock <= 0 ? 'down' : p.stock <= p.min_stock ? 'warn-text' : '')}>{num(p.stock)}</td>
                  <td class="hide-md muted">{p.category}</td>
                  <td class="hide-md muted nowrap">{dateTime(p.created_at).slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !data.rows.length && <Empty>No products match. <a href="/products/new">Add one</a></Empty>}
        {data && <Pager page={data.page} size={data.size} count={query.page > 1 ? null : totals?.count} more={data.rows.length === data.size} onPage={(page) => setQuery({ page })} />}
      </div>
    </>
  );
}
