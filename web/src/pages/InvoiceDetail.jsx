import { useState } from 'preact/hooks';
import { money, num, dateTime, post, toCents, fromCents } from '../api.js';
import { useFetch, useApp, Status, ErrorBox, Modal, toast } from '../components/ui.jsx';

const METHOD = { cash: 'Cash', card: 'Card', transfer: 'Transfer' };

export default function InvoiceDetail({ params }) {
  const { settings } = useApp();
  const { data: inv, error, reload } = useFetch(`/invoices/${params.id}`);
  const [paying, setPaying] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!inv) return <div class="empty">Loading…</div>;
  const isOrder = inv.kind === 'order';
  const due = inv.total - inv.paid;

  const cancel = async () => {
    const msg = isOrder
      ? `Cancel order ${inv.code}?`
      : `Cancel ${inv.code}? Stock and serials go back on the shelf${inv.paid ? `, and ${money(inv.paid)} is recorded as refunded` : ''}.`;
    if (!confirm(msg)) return;
    try {
      await post(`/invoices/${inv.id}/cancel`);
      toast(`${inv.code} cancelled`);
      reload();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  return (
    <div class="stack" style="max-width:1100px;margin:0 auto">
      <div class="detail-head no-print">
        <a href={isOrder ? '/orders' : '/invoices'} class="muted">← {isOrder ? 'Orders' : 'Invoices'}</a>
        <span class="spacer" />
        {isOrder && inv.status === 'open' && <a class="btn primary" href={`/pos?order=${inv.id}`}>Open in POS to invoice</a>}
        {!isOrder && inv.status === 'completed' && due > 0 && <button class="primary" onClick={() => setPaying(true)}>Collect {money(due)}</button>}
        {((isOrder && inv.status === 'open') || (!isOrder && inv.status === 'completed')) && <button class="danger" onClick={cancel}>Cancel {isOrder ? 'order' : 'invoice'}</button>}
        <button onClick={() => window.print()}>Print</button>
      </div>

      <div class="card">
        <div class="detail-head">
          <div>
            <div class="muted small">{settings.store_name}</div>
            <h1>{isOrder ? 'Sales order' : 'Invoice'} {inv.code}</h1>
          </div>
          <Status value={inv.status} />
          <span class="spacer" />
          <div class="muted" style="text-align:right">{dateTime(inv.created_at)}<div class="small">by {inv.user_name}</div></div>
        </div>
        <div class="grid2">
          <dl class="kv">
            <dt>Customer</dt>
            <dd>{inv.customer_id ? <a href={`/customers/${inv.customer_id}`}>{inv.customer_name}</a> : 'Walk-in customer'} {inv.customer_code && <span class="faint small">{inv.customer_code}</span>}</dd>
            {inv.customer_phone && [<dt key="p">Phone</dt>, <dd key="pv">{inv.customer_phone}</dd>]}
            {inv.customer_address && [<dt key="a">Address</dt>, <dd key="av">{inv.customer_address}</dd>]}
          </dl>
          <dl class="kv">
            {inv.order_code && [<dt key="o">From order</dt>, <dd key="ov"><a href={`/invoices/${inv.order_id}`}>{inv.order_code}</a></dd>]}
            {inv.converted_to && [<dt key="c">Invoiced as</dt>, <dd key="cv"><a href={`/invoices/${inv.converted_to.id}`}>{inv.converted_to.code}</a></dd>]}
            {inv.note && [<dt key="n">Note</dt>, <dd key="nv">{inv.note}</dd>]}
          </dl>
        </div>
      </div>

      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Item</th><th class="num">Qty</th><th class="num hide-sm">Unit price</th><th class="num hide-sm">Discount</th><th class="num">Total</th></tr></thead>
            <tbody>
              {inv.items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <a href={`/products/${it.product_id}`}>{it.name}</a> <span class="faint small">{it.sku}</span>
                    <div class="small muted show-sm">{num(it.qty)} × {money(it.price - it.discount)}</div>
                    {it.serials.length > 0 && <div>{it.serials.map((s) => <span class="chip" key={s}>{s}</span>)}</div>}
                  </td>
                  <td class="num">{num(it.qty)}</td>
                  <td class="num hide-sm">{money(it.price)}</td>
                  <td class="num hide-sm">{it.discount ? money(it.discount) : ''}</td>
                  <td class="num">{money(it.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style="padding:16px;display:flex">
          <div class="sum-box">
            <div class="line"><span>Subtotal</span><span class="num">{money(inv.subtotal)}</span></div>
            {inv.discount > 0 && <div class="line"><span>Discount</span><span class="num">−{money(inv.discount)}</span></div>}
            <div class="line big"><span>Total</span><span class="num">{money(inv.total)}</span></div>
            {!isOrder && <div class="line"><span>Paid</span><span class="num">{money(inv.paid)}</span></div>}
            {!isOrder && due > 0 && inv.status === 'completed' && <div class="line"><span>Still owed</span><b class="num down">{money(due)}</b></div>}
          </div>
        </div>
      </div>

      {inv.payments.length > 0 && (
        <div class="card flush">
          <h2 style="padding:16px 16px 0">Payments</h2>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Code</th><th>Time</th><th>Method</th><th class="num">Amount</th></tr></thead>
              <tbody>
                {inv.payments.map((p, i) => (
                  <tr key={i}>
                    <td class="code">{p.code}</td>
                    <td class="nowrap">{dateTime(p.created_at)}{p.note && <div class="small muted">{p.note}</div>}</td>
                    <td>{METHOD[p.method]}</td>
                    <td class={'num ' + (p.amount < 0 ? 'down' : '')}>{money(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {paying && <PayModal title={`Collect payment for ${inv.code}`} max={due} onClose={() => setPaying(false)}
        onPay={async (body) => { await post(`/invoices/${inv.id}/pay`, body); setPaying(false); toast('Payment recorded'); reload(); }} />}
    </div>
  );
}

export function PayModal({ title, max, onClose, onPay }) {
  const [amount, setAmount] = useState(fromCents(max));
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      await onPay({ amount: toCents(amount), method, note });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button class="primary" disabled={busy} onClick={submit}>Record payment</button></>}>
      <form class="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <label class="field"><span>Amount (up to {money(max)})</span><input autoFocus inputMode="decimal" value={amount} onFocus={(e) => e.currentTarget.select()} onInput={(e) => setAmount(e.currentTarget.value)} /></label>
        <div class="methods">
          {Object.entries(METHOD).map(([k, label]) => <button type="button" key={k} class={method === k ? 'on' : ''} onClick={() => setMethod(k)}>{label}</button>)}
        </div>
        <label class="field"><span>Note</span><input value={note} onInput={(e) => setNote(e.currentTarget.value)} /></label>
        <button hidden />
      </form>
    </Modal>
  );
}
