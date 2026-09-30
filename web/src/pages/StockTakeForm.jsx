import { useState, useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { get, post, put, money, num, dateTime } from '../api.js';
import { ErrorBox, Status, toast } from '../components/ui.jsx';
import { ProductAdder, splitSerials } from '../components/inventory.jsx';

export default function StockTakeForm({ params }) {
  const { route } = useLocation();
  const id = params.id;
  const [doc, setDoc] = useState(id ? null : { status: 'draft', note: '', items: [] });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    get(`/stocktakes/${id}`)
      .then((st) => setDoc({ ...st, items: st.items.map((it) => ({ ...it, stock: it.current_stock, actual: String(it.actual_qty), serialText: (it.serials || []).join('\n') })) }))
      .catch(setError);
  }, [id]);

  if (!doc) return error ? <ErrorBox error={error} /> : <div class="empty">Loading…</div>;
  const readOnly = doc.status === 'balanced';
  const counted = (it) => (it.track_serial ? splitSerials(it.serialText).length : parseInt(it.actual, 10) || 0);
  const systemQty = (it) => (readOnly ? it.system_qty : it.stock);

  const add = (p, serial) =>
    setDoc((d) => {
      const existing = d.items.find((it) => it.product_id === p.id);
      if (existing) {
        const items = d.items.map((it) => {
          if (it !== existing) return it;
          if (it.track_serial) return serial && !splitSerials(it.serialText).includes(serial) ? { ...it, serialText: (it.serialText ? it.serialText + '\n' : '') + serial } : it;
          return { ...it, actual: String((parseInt(it.actual, 10) || 0) + 1) };
        });
        return { ...d, items: [existing && items.find((x) => x.product_id === p.id), ...items.filter((x) => x.product_id !== p.id)] };
      }
      return { ...d, items: [{ product_id: p.id, name: p.name, sku: p.sku, track_serial: !!p.track_serial, stock: p.stock, current_cost: p.cost, actual: p.track_serial ? '' : '1', serialText: serial || '' }, ...d.items] };
    });
  const patch = (it, v) => setDoc((d) => ({ ...d, items: d.items.map((x) => (x === it ? { ...x, ...v } : x)) }));

  const save = async (balance) => {
    if (balance && !confirm('Balance now? Stock will be set to the counted quantities and cannot be edited after.')) return;
    setBusy(true);
    setError(null);
    const body = {
      note: doc.note,
      balance,
      items: doc.items.map((it) => (it.track_serial ? { product_id: it.product_id, serials: splitSerials(it.serialText) } : { product_id: it.product_id, actual_qty: counted(it) })),
    };
    try {
      if (id) {
        await put(`/stocktakes/${id}`, body);
        toast(balance ? 'Stock balanced' : 'Saved');
        location.reload();
      } else {
        const r = await post('/stocktakes', body);
        toast(balance ? `${r.code} balanced` : `${r.code} saved as draft`);
        route(`/stocktakes/${r.id}`);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const diffQty = doc.items.reduce((a, it) => a + counted(it) - systemQty(it), 0);
  const diffValue = doc.items.reduce((a, it) => a + (counted(it) - systemQty(it)) * ((readOnly ? it.unit_cost : it.current_cost) || 0), 0);

  return (
    <div class="stack" style="max-width:1000px">
      <div class="detail-head">
        <a href="/stocktakes" class="muted">← Stock takes</a>
        <h1>{doc.code ? `Stock take ${doc.code}` : 'New stock take'}</h1>
        {doc.code && <Status value={doc.status} />}
        {doc.balanced_at && <span class="muted small">balanced {dateTime(doc.balanced_at)}</span>}
      </div>
      <div class="card">
        <label class="field"><span>Note</span><input value={doc.note || ''} disabled={readOnly} onInput={(e) => setDoc({ ...doc, note: e.currentTarget.value })} /></label>
      </div>
      <div class="card stack">
        {!readOnly && <ProductAdder onAdd={add} placeholder="Scan barcodes / IMEIs or search products you counted" />}
        {!doc.items.length && <div class="empty">Scan each item on the shelf. For serial-tracked products, scan every serial/IMEI; unscanned ones are marked missing when you balance.</div>}
        {doc.items.length > 0 && (
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Product</th><th class="num">{readOnly ? 'System' : 'In system'}</th><th class="num">Counted</th><th class="num">Difference</th>{!readOnly && <th />}</tr></thead>
              <tbody>
                {doc.items.map((it) => {
                  const diff = counted(it) - systemQty(it);
                  return (
                    <tr key={it.product_id}>
                      <td>
                        <a href={`/products/${it.product_id}`}>{it.name}</a> <span class="faint small">{it.sku}</span>
                        {it.track_serial && (readOnly
                          ? <div>{splitSerials(it.serialText).map((s) => <span class="chip" key={s}>{s}</span>)}</div>
                          : <textarea rows="2" style="margin-top:6px" placeholder="Scan serial/IMEI, one per line" value={it.serialText} onInput={(e) => patch(it, { serialText: e.currentTarget.value })} />)}
                      </td>
                      <td class="num">{num(systemQty(it))}</td>
                      <td class="num">{it.track_serial || readOnly ? num(counted(it)) : <input style="width:90px;text-align:right" inputMode="numeric" value={it.actual} onInput={(e) => patch(it, { actual: e.currentTarget.value })} aria-label={`Counted ${it.name}`} />}</td>
                      <td class={'num ' + (diff < 0 ? 'down' : diff > 0 ? 'up' : '')}>{diff > 0 ? '+' : ''}{num(diff)}</td>
                      {!readOnly && <td><button class="ghost icon-btn danger" onClick={() => setDoc((d) => ({ ...d, items: d.items.filter((x) => x !== it) }))} aria-label={`Remove ${it.name}`}>🗑</button></td>}
                    </tr>
                  );
                })}
                <tr class="totals"><td>Difference</td><td /><td /><td class="num">{num(diffQty)}<div class="small">{money(diffValue)}</div></td>{!readOnly && <td />}</tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ErrorBox error={error} />
      {!readOnly && (
        <div class="row">
          <span class="spacer" />
          <button disabled={busy || !doc.items.length} onClick={() => save(false)}>Save draft</button>
          <button class="primary" disabled={busy || !doc.items.length} onClick={() => save(true)}>Balance stock</button>
        </div>
      )}
    </div>
  );
}
