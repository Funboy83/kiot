import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { post, money, toCents, fromCents } from '../api.js';
import { ErrorBox, toast } from '../components/ui.jsx';
import { ProductAdder, splitSerials } from '../components/inventory.jsx';

export default function ReceiptForm() {
  const { route } = useLocation();
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const add = (p, serial) =>
    setLines((ls) => {
      const existing = ls.find((l) => l.product_id === p.id);
      if (existing) {
        if (!p.track_serial) return ls.map((l) => (l === existing ? { ...l, qty: String((parseInt(l.qty, 10) || 0) + 1) } : l));
        return ls;
      }
      return [{ product_id: p.id, name: p.name, sku: p.sku, track_serial: !!p.track_serial, qty: '1', cost: fromCents(p.cost), serialText: serial || '' }, ...ls];
    });
  const patch = (l, v) => setLines((ls) => ls.map((x) => (x === l ? { ...x, ...v } : x)));
  const qtyOf = (l) => (l.track_serial ? splitSerials(l.serialText).length : parseInt(l.qty, 10) || 0);
  const total = lines.reduce((a, l) => a + qtyOf(l) * toCents(l.cost), 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/receipts', {
        supplier, note,
        items: lines.map((l) => ({ product_id: l.product_id, qty: qtyOf(l), unit_cost: toCents(l.cost), serials: l.track_serial ? splitSerials(l.serialText) : undefined })),
      });
      toast(`Receipt ${r.code} saved`);
      route(`/inventory/receipts/${r.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack" style="max-width:1000px">
      <div class="detail-head">
        <a href="/inventory" class="muted">← Inventory</a>
        <h1>Receive goods</h1>
      </div>
      <div class="card form-grid">
        <label class="field"><span>Supplier</span><input value={supplier} onInput={(e) => setSupplier(e.currentTarget.value)} /></label>
        <label class="field"><span>Note</span><input value={note} onInput={(e) => setNote(e.currentTarget.value)} /></label>
      </div>
      <div class="card stack">
        <ProductAdder onAdd={add} />
        {!lines.length && <div class="empty">Add the products you received. Serial-tracked items need one serial/IMEI per unit.</div>}
        {lines.map((l) => (
          <div key={l.product_id} style="border-top:1px solid var(--border);padding-top:12px">
            <div class="row">
              <b style="flex:1">{l.name}</b><span class="faint small">{l.sku}</span>
              <button class="ghost icon-btn danger" onClick={() => setLines((ls) => ls.filter((x) => x !== l))} aria-label={`Remove ${l.name}`}>🗑</button>
            </div>
            <div class="row" style="margin-top:8px">
              <label class="field" style="width:110px"><span>Qty</span>
                {l.track_serial ? <input value={qtyOf(l)} disabled /> : <input inputMode="numeric" value={l.qty} onInput={(e) => patch(l, { qty: e.currentTarget.value })} />}
              </label>
              <label class="field" style="width:140px"><span>Unit cost</span><input inputMode="decimal" value={l.cost} onInput={(e) => patch(l, { cost: e.currentTarget.value })} /></label>
              <span class="spacer" />
              <b class="num">{money(qtyOf(l) * toCents(l.cost))}</b>
            </div>
            {l.track_serial && (
              <label class="field" style="margin-top:8px"><span>Serial/IMEI, one per line (scan them in)</span>
                <textarea rows={Math.min(8, Math.max(2, splitSerials(l.serialText).length + 1))} value={l.serialText} onInput={(e) => patch(l, { serialText: e.currentTarget.value })} />
              </label>
            )}
          </div>
        ))}
      </div>
      <ErrorBox error={error} />
      <div class="row">
        <span class="muted">Total cost</span><b class="num" style="font-size:18px">{money(total)}</b>
        <span class="spacer" />
        <button class="primary" disabled={busy || !lines.length} onClick={save}>{busy ? 'Saving…' : 'Save receipt'}</button>
      </div>
    </div>
  );
}
