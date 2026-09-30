import { money, num, qs, today, addDaysIso } from '../api.js';
import { useFetch, useQueryParams, useApp, Pager, Empty, ErrorBox } from '../components/ui.jsx';
import { DailyBars } from '../components/charts.jsx';

function DateRange({ query, setQuery }) {
  const presets = [
    ['Today', today(), today()],
    ['7 days', today(-6), today()],
    ['This month', today().slice(0, 8) + '01', today()],
    ['30 days', today(-29), today()],
    ['90 days', today(-89), today()],
  ];
  return (
    <div class="filters">
      {presets.map(([label, from, to]) => (
        <button key={label} class={query.from === from && query.to === to ? 'primary' : ''} onClick={() => setQuery({ from, to })}>{label}</button>
      ))}
      <input type="date" value={query.from} onChange={(e) => setQuery({ from: e.currentTarget.value })} aria-label="From" />
      <input type="date" value={query.to} onChange={(e) => setQuery({ to: e.currentTarget.value })} aria-label="To" />
    </div>
  );
}

function fillRange(rows, from, to) {
  const map = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addDaysIso(d, 1)) out.push(map.get(d) || { day: d, revenue: 0, invoices: 0 });
  return out;
}

function Sales({ query, setQuery }) {
  const { data, error } = useFetch('/reports/sales' + qs({ from: query.from, to: query.to }));
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div class="empty">Loading…</div>;
  const t = data.totals;
  return (
    <div class="stack">
      <DateRange query={query} setQuery={setQuery} />
      <div class="kpis">
        <div class="card kpi"><div class="label">Revenue</div><div class="value">{money(t.revenue)}</div><div class="sub">{num(t.invoices)} invoices · discounts {money(t.discount)}</div></div>
        <div class="card kpi"><div class="label">Cost of goods</div><div class="value">{money(t.cost)}</div></div>
        <div class="card kpi"><div class="label">Gross profit</div><div class="value">{money(t.profit)}</div><div class="sub">{t.revenue ? ((t.profit / t.revenue) * 100).toFixed(1) : 0}% margin</div></div>
        <div class="card kpi"><div class="label">Collected at sale</div><div class="value">{money(t.paid)}</div><div class="sub">{money(t.revenue - t.paid)} still on credit</div></div>
      </div>
      <div class="card"><h2>Revenue by day</h2><DailyBars days={fillRange(data.rows, data.from, data.to)} /></div>
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Day</th><th class="num">Invoices</th><th class="num">Revenue</th><th class="num hide-sm">Cost</th><th class="num">Profit</th></tr></thead>
            <tbody>
              <tr class="totals"><td>Total</td><td class="num">{num(t.invoices)}</td><td class="num">{money(t.revenue)}</td><td class="num hide-sm">{money(t.cost)}</td><td class="num">{money(t.profit)}</td></tr>
              {data.rows.map((r) => (
                <tr key={r.day}>
                  <td class="nowrap"><a href={`/invoices?range=custom&from=${r.day}&to=${r.day}`}>{r.day}</a></td>
                  <td class="num">{num(r.invoices)}</td>
                  <td class="num">{money(r.revenue)}</td>
                  <td class="num hide-sm">{money(r.cost)}</td>
                  <td class="num">{money(r.profit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.rows.length && <Empty>No sales in this period</Empty>}
      </div>
    </div>
  );
}

function Products({ query, setQuery }) {
  const { data, error } = useFetch('/reports/products' + qs({ from: query.from, to: query.to, sort: query.sort, page: query.page }));
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div class="empty">Loading…</div>;
  const t = data.totals;
  return (
    <div class="stack">
      <DateRange query={query} setQuery={setQuery} />
      <div class="card flush">
        <div class="filters" style="padding:12px 12px 0">
          <select value={query.sort || 'revenue'} onChange={(e) => setQuery({ sort: e.currentTarget.value })} aria-label="Sort">
            <option value="revenue">By revenue</option><option value="qty">By quantity</option><option value="profit">By profit</option>
          </select>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Revenue</th><th class="num hide-sm">Cost</th><th class="num">Profit</th><th class="num hide-sm">Margin</th></tr></thead>
            <tbody>
              {t && <tr class="totals"><td>{num(t.count)} products</td><td class="num">{num(t.qty)}</td><td class="num">{money(t.revenue)}</td><td class="num hide-sm">{money(t.cost)}</td><td class="num">{money(t.profit)}</td><td class="num hide-sm">{t.revenue ? ((t.profit / t.revenue) * 100).toFixed(1) + '%' : ''}</td></tr>}
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/products/${r.id}`}>{r.name}</a> <span class="faint small hide-sm">{r.sku}</span></td>
                  <td class="num">{num(r.qty)}</td>
                  <td class="num">{money(r.revenue)}</td>
                  <td class="num hide-sm">{money(r.cost)}</td>
                  <td class={'num ' + (r.profit < 0 ? 'down' : '')}>{money(r.profit)}</td>
                  <td class="num hide-sm">{r.revenue ? ((r.profit / r.revenue) * 100).toFixed(1) + '%' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.rows.length && <Empty>No sales in this period</Empty>}
        <Pager page={data.page} size={data.size} count={Number(query.page) > 1 ? null : t?.count} more={data.rows.length === data.size} onPage={(page) => setQuery({ page })} />
      </div>
    </div>
  );
}

function Debt() {
  const { data, error } = useFetch('/reports/debt');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div class="empty">Loading…</div>;
  const t = data.totals;
  const buckets = [['d0_30', '0–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90', 'Over 90 days']];
  return (
    <div class="stack">
      <div class="kpis">
        <div class="card kpi"><div class="label">Total owed</div><div class="value">{money(t.debt)}</div><div class="sub">{num(data.rows.length)} customers</div></div>
        {buckets.map(([k, label], i) => (
          <div class="card kpi" key={k}><div class="label">{label}</div><div class={'value ' + (i >= 2 && t[k] > 0 ? 'down' : '')}>{money(t[k])}</div><div class="sub">{t.debt ? ((t[k] / t.debt) * 100).toFixed(0) : 0}% of total</div></div>
        ))}
      </div>
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Customer</th><th class="num">Owes</th>{buckets.map(([k, label]) => <th key={k} class="num hide-sm">{label}</th>)}<th class="hide-md">Oldest unpaid</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/customers/${r.id}`}>{r.name}</a><div class="small faint">{r.phone}</div></td>
                  <td class="num"><b>{money(r.debt)}</b></td>
                  {buckets.map(([k], i) => <td key={k} class={'num hide-sm ' + (i >= 2 && r[k] > 0 ? 'down' : r[k] ? '' : 'faint')}>{r[k] ? money(r[k]) : '—'}</td>)}
                  <td class="hide-md nowrap">{r.oldest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.rows.length && <Empty>No one owes you money</Empty>}
      </div>
    </div>
  );
}

export default function Reports() {
  const { user } = useApp();
  const admin = user.role === 'admin';
  const [query, setQuery] = useQueryParams({ tab: admin ? 'sales' : 'debt', from: today(-29), to: today() });
  const tabs = [...(admin ? [['sales', 'Sales & profit'], ['products', 'By product']] : []), ['debt', 'Customer debt']];
  return (
    <>
      <div class="page-head"><h1>Reports</h1></div>
      <div class="tabs" role="tablist">
        {tabs.map(([k, label]) => <button key={k} role="tab" class={query.tab === k ? 'on' : ''} onClick={() => setQuery({ tab: k })}>{label}</button>)}
      </div>
      {query.tab === 'sales' && admin && <Sales query={query} setQuery={setQuery} />}
      {query.tab === 'products' && admin && <Products query={query} setQuery={setQuery} />}
      {query.tab === 'debt' && <Debt />}
    </>
  );
}
