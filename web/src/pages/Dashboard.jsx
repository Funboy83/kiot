import { useFetch } from '../components/ui.jsx';
import { DailyBars, RankBars } from '../components/charts.jsx';
import { money, num, dateTime, addDaysIso } from '../api.js';

function fillDays(daily, today) {
  const map = new Map(daily.map((d) => [d.day, d]));
  const out = [];
  for (let i = 29; i >= 0; i--) {
    const day = addDaysIso(today, -i);
    out.push(map.get(day) || { day, revenue: 0, invoices: 0 });
  }
  return out;
}

function Change({ now, before }) {
  if (!before) return <span class="faint">no sales same period last month</span>;
  const pct = ((now - before) / before) * 100;
  return (
    <span class={pct >= 0 ? 'up' : 'down'}>
      {pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}% vs same days last month
    </span>
  );
}

export default function Dashboard() {
  const { data: d, error } = useFetch('/reports/dashboard');
  if (error) return <div class="error">{error.message}</div>;
  if (!d) return <div class="empty">Loading…</div>;
  return (
    <div class="stack">
      <div class="kpis">
        <div class="card kpi">
          <div class="label">Revenue today</div>
          <div class="value">{money(d.todayStats.revenue)}</div>
          <div class="sub">{num(d.todayStats.invoices)} invoices · profit {money(d.todayStats.profit)}</div>
        </div>
        <div class="card kpi">
          <div class="label">Revenue this month</div>
          <div class="value">{money(d.month.revenue)}</div>
          <div class="sub"><Change now={d.month.revenue} before={d.prevMonth.revenue} /></div>
        </div>
        <div class="card kpi">
          <div class="label">Gross profit this month</div>
          <div class="value">{money(d.month.profit)}</div>
          <div class="sub">{d.month.revenue ? ((d.month.profit / d.month.revenue) * 100).toFixed(1) : 0}% margin</div>
        </div>
        <a class="card kpi" href="/reports?tab=debt" style="color:inherit;text-decoration:none">
          <div class="label">Customers owe you</div>
          <div class="value">{money(d.receivable.debt)}</div>
          <div class="sub">{num(d.receivable.customers)} customers · see ageing →</div>
        </a>
        <a class="card kpi" href="/products?stock=low" style="color:inherit;text-decoration:none">
          <div class="label">Stock value</div>
          <div class="value">{money(d.stock.value)}</div>
          <div class="sub">{num(d.stock.low)} low · {num(d.stock.out)} out of stock →</div>
        </a>
      </div>

      <div class="card">
        <h2>Revenue, last 30 days</h2>
        <DailyBars days={fillDays(d.daily, d.today)} />
      </div>

      <div class="grid2">
        <div class="card">
          <h2>Top products this month</h2>
          <RankBars rows={d.topProducts.map((p) => ({ label: p.name, value: p.revenue, href: `/products/${p.id}` }))} />
        </div>
        <div class="card">
          <h2>Top customers this month</h2>
          <RankBars rows={d.topCustomers.map((c) => ({ label: c.name, value: c.revenue, href: `/customers/${c.id}` }))} />
        </div>
      </div>

      <div class="card flush">
        <h2 style="padding:16px 16px 0">Recent activity</h2>
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {d.recent.map((r) => (
                <tr key={r.type + r.id}>
                  <td class="code"><a href={r.type === 'invoice' ? `/invoices/${r.id}` : `/inventory/receipts/${r.id}`}>{r.code}</a></td>
                  <td>{r.type === 'invoice' ? 'Sale' : 'Goods received'}{r.party ? ` · ${r.party}` : ''} {r.status === 'cancelled' && <span class="badge bad">Cancelled</span>}</td>
                  <td class="num">{money(r.amount)}</td>
                  <td class="muted hide-sm nowrap">{dateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
