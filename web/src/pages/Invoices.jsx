import { useLocation } from 'preact-iso';
import { money, num, qs, dateTime, today } from '../api.js';
import { useFetch, useQueryParams, SearchInput, Pager, Empty, Status, ErrorBox } from '../components/ui.jsx';

const RANGES = [
  ['today', 'Today', () => [today(), today()]],
  ['7d', 'Last 7 days', () => [today(-6), today()]],
  ['month', 'This month', () => [today().slice(0, 8) + '01', today()]],
  ['30d', 'Last 30 days', () => [today(-29), today()]],
  ['all', 'All time', () => ['', '']],
];

export default function Invoices({ kind }) {
  const isOrder = kind === 'order';
  const [query, setQuery] = useQueryParams({ range: isOrder ? 'all' : 'month', status: isOrder ? 'open' : '' });
  const { route } = useLocation();
  const range = RANGES.find((r) => r[0] === query.range);
  const [from, to] = range ? range[2]() : [query.from, query.to];
  const params = { kind: isOrder ? 'order' : 'invoice', q: query.q, status: query.status, unpaid: query.unpaid, from, to, page: query.page };
  const { data, error, loading } = useFetch('/invoices' + qs(params));
  const t = data?.totals;
  return (
    <>
      <div class="page-head">
        <h1>{isOrder ? 'Sales orders' : 'Invoices'}</h1>
        {t && <span class="muted">{num(t.count)}</span>}
        <span class="spacer" />
        <a class="btn primary" href="/pos">＋ {isOrder ? 'New order in POS' : 'New sale'}</a>
      </div>
      <div class="filters">
        <SearchInput value={query.q} onSearch={(q) => setQuery({ q })} placeholder="Code, customer, phone or IMEI" />
        <select value={range ? query.range : 'custom'} onChange={(e) => setQuery({ range: e.currentTarget.value })} aria-label="Period">
          {RANGES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          <option value="custom">Custom…</option>
        </select>
        {!range && (
          <>
            <input type="date" value={query.from || ''} onChange={(e) => setQuery({ from: e.currentTarget.value })} aria-label="From" />
            <input type="date" value={query.to || ''} onChange={(e) => setQuery({ to: e.currentTarget.value })} aria-label="To" />
          </>
        )}
        <select value={query.status} onChange={(e) => setQuery({ status: e.currentTarget.value })} aria-label="Status">
          <option value="">Any status</option>
          {isOrder
            ? [<option key="o" value="open">Open</option>, <option key="c" value="converted">Invoiced</option>, <option key="x" value="cancelled">Cancelled</option>]
            : [<option key="c" value="completed">Completed</option>, <option key="x" value="cancelled">Cancelled</option>]}
        </select>
        {!isOrder && (
          <label class="row btn" style="gap:6px">
            <input type="checkbox" checked={query.unpaid === '1'} onChange={(e) => setQuery({ unpaid: e.currentTarget.checked ? '1' : '' })} /> Unpaid only
          </label>
        )}
      </div>
      <ErrorBox error={error} />
      <div class="card flush" style={{ opacity: loading ? 0.6 : 1 }}>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Code</th><th class="hide-sm">Time</th><th>Customer</th>
                <th class="num hide-md">Subtotal</th><th class="num hide-md">Discount</th>
                <th class="num">Total</th><th class="num hide-sm">{isOrder ? '' : 'Paid'}</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {t && (
                <tr class="totals">
                  <td /><td class="hide-sm" /><td />
                  <td class="num hide-md">{money(t.subtotal)}</td><td class="num hide-md">{money(t.discount)}</td>
                  <td class="num">{money(t.total)}</td><td class="num hide-sm">{isOrder ? '' : money(t.paid)}</td><td />
                </tr>
              )}
              {data?.rows.map((i) => (
                <tr key={i.id} class="click" onClick={() => route(`/invoices/${i.id}`)}>
                  <td class="code"><a href={`/invoices/${i.id}`} onClick={(e) => e.stopPropagation()}>{i.code}</a><div class="small faint show-sm">{dateTime(i.created_at)}</div></td>
                  <td class="hide-sm nowrap">{dateTime(i.created_at)}</td>
                  <td>{i.customer_name || <span class="faint">Walk-in</span>}</td>
                  <td class="num hide-md">{money(i.subtotal)}</td>
                  <td class="num hide-md">{i.discount ? money(i.discount) : ''}</td>
                  <td class="num">{money(i.total)}</td>
                  <td class={'num hide-sm ' + (!isOrder && i.status === 'completed' && i.paid < i.total ? 'down' : '')}>{isOrder ? '' : money(i.paid)}</td>
                  <td><Status value={i.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !data.rows.length && <Empty>No {isOrder ? 'orders' : 'invoices'} in this period</Empty>}
        {data && <Pager page={data.page} size={data.size} count={Number(query.page) > 1 ? null : t?.count} more={data.rows.length === data.size} onPage={(page) => setQuery({ page })} />}
      </div>
    </>
  );
}
