import { useState } from 'preact/hooks';
import { money, num, dateTime, post, put } from '../api.js';
import { useFetch, Status, ErrorBox, Modal, Pager, Empty, toast } from '../components/ui.jsx';
import { PayModal } from './InvoiceDetail.jsx';

const METHOD = { cash: 'Cash', card: 'Card', transfer: 'Transfer' };

export default function CustomerDetail({ params }) {
  const { data: c, error, reload } = useFetch(`/customers/${params.id}`);
  const [tab, setTab] = useState('invoices');
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [bump, setBump] = useState(0);
  if (error) return <ErrorBox error={error} />;
  if (!c) return <div class="empty">Loading…</div>;
  return (
    <div class="stack">
      <div class="detail-head">
        <a href="/customers" class="muted">← Customers</a>
        <h1>{c.name}</h1>
        <span class="faint">{c.code}</span>
        <span class="spacer" />
        <button onClick={() => setEditing(true)}>Edit</button>
        {c.debt > 0 && <button class="primary" onClick={() => setPaying(true)}>Collect payment</button>}
      </div>
      <div class="kpis">
        <div class="card kpi"><div class="label">Owes</div><div class={'value ' + (c.debt > 0 ? 'down' : '')}>{money(c.debt)}</div></div>
        <div class="card kpi"><div class="label">Total sales</div><div class="value">{money(c.total_sales)}</div><div class="sub">{num(c.stats.invoices)} invoices</div></div>
        <div class="card kpi"><div class="label">Last purchase</div><div class="value" style="font-size:16px">{c.stats.last_purchase ? dateTime(c.stats.last_purchase) : '—'}</div></div>
        <div class="card kpi">
          <div class="label">Contact</div>
          <div>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : '—'}</div>
          {c.email && <div class="small">{c.email}</div>}
          {c.address && <div class="small muted">{c.address}</div>}
        </div>
      </div>
      {c.note && <div class="card muted">{c.note}</div>}
      <div class="card">
        <div class="tabs" role="tablist">
          <button role="tab" class={tab === 'invoices' ? 'on' : ''} onClick={() => setTab('invoices')}>Invoices</button>
          <button role="tab" class={tab === 'unpaid' ? 'on' : ''} onClick={() => setTab('unpaid')}>Unpaid</button>
          <button role="tab" class={tab === 'payments' ? 'on' : ''} onClick={() => setTab('payments')}>Payments</button>
        </div>
        {tab === 'payments' ? <Payments id={c.id} key={bump} /> : <CustomerInvoices id={c.id} unpaid={tab === 'unpaid'} key={tab + bump} />}
      </div>
      {paying && <PayModal title={`Collect payment from ${c.name}`} max={c.debt} onClose={() => setPaying(false)}
        onPay={async (body) => { const r = await post(`/customers/${c.id}/payments`, body); setPaying(false); toast(`Payment ${r.code} applied to oldest invoices`); reload(); setBump((b) => b + 1); }} />}
      {editing && <CustomerFormModal customer={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </div>
  );
}

function CustomerInvoices({ id, unpaid }) {
  const [page, setPage] = useState(1);
  const { data } = useFetch(`/invoices?customer_id=${id}&page=${page}&size=20${unpaid ? '&unpaid=1' : ''}`);
  if (!data) return <div class="empty">Loading…</div>;
  if (!data.rows.length) return <Empty>{unpaid ? 'Nothing unpaid' : 'No invoices yet'}</Empty>;
  return (
    <>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Code</th><th class="hide-sm">Time</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Owed</th><th>Status</th></tr></thead>
          <tbody>
            {data.rows.map((i) => (
              <tr key={i.id}>
                <td class="code"><a href={`/invoices/${i.id}`}>{i.code}</a></td>
                <td class="hide-sm nowrap">{dateTime(i.created_at)}</td>
                <td class="num">{money(i.total)}</td>
                <td class="num">{money(i.paid)}</td>
                <td class={'num ' + (i.status === 'completed' && i.total > i.paid ? 'down' : 'faint')}>{i.status === 'completed' ? money(i.total - i.paid) : '—'}</td>
                <td><Status value={i.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} size={data.size} count={page === 1 ? data.totals?.count : null} more={data.rows.length === data.size} onPage={setPage} />
    </>
  );
}

function Payments({ id }) {
  const [page, setPage] = useState(1);
  const { data } = useFetch(`/customers/${id}/payments?page=${page}`);
  if (!data) return <div class="empty">Loading…</div>;
  if (!data.rows.length) return <Empty>No payments yet</Empty>;
  return (
    <>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Code</th><th>Time</th><th class="hide-sm">For</th><th>Method</th><th class="num">Amount</th></tr></thead>
          <tbody>
            {data.rows.map((p) => (
              <tr key={p.id}>
                <td class="code">{p.code}</td>
                <td class="nowrap">{dateTime(p.created_at)}</td>
                <td class="hide-sm">{p.invoice_id ? <a href={`/invoices/${p.invoice_id}`}>{p.invoice_code}</a> : 'Debt payment'}{p.note && <div class="small muted">{p.note}</div>}</td>
                <td>{METHOD[p.method]}</td>
                <td class={'num ' + (p.amount < 0 ? 'down' : '')}>{money(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} size={data.size} more={data.more} onPage={setPage} />
    </>
  );
}

export function CustomerFormModal({ customer, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', code: '', phone: '', email: '', address: '', note: '', type: 'person', ...(customer || {}) });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });
  const save = async (e) => {
    e?.preventDefault();
    try {
      if (customer) {
        await put(`/customers/${customer.id}`, form);
        onSaved(customer);
      } else onSaved(await post('/customers', form));
      toast('Saved');
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title={customer ? 'Edit customer' : 'New customer'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button class="primary" onClick={save}>Save</button></>}>
      <form class="stack" onSubmit={save}>
        <ErrorBox error={error} />
        <label class="field"><span>Name</span><input autoFocus value={form.name} onInput={set('name')} /></label>
        <div class="form-grid">
          <label class="field"><span>Phone</span><input type="tel" value={form.phone || ''} onInput={set('phone')} /></label>
          <label class="field"><span>Code (blank = automatic)</span><input value={form.code || ''} onInput={set('code')} /></label>
          <label class="field"><span>Email</span><input type="email" value={form.email || ''} onInput={set('email')} /></label>
          <label class="field"><span>Type</span>
            <select value={form.type} onChange={set('type')}><option value="person">Person</option><option value="company">Company</option></select>
          </label>
        </div>
        <label class="field"><span>Address</span><input value={form.address || ''} onInput={set('address')} /></label>
        <label class="field"><span>Note</span><textarea rows="2" value={form.note || ''} onInput={set('note')} /></label>
        <button hidden />
      </form>
    </Modal>
  );
}
