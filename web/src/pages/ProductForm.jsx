import { useState, useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { get, post, put, toCents, fromCents } from '../api.js';
import { useFetch, ErrorBox, toast } from '../components/ui.jsx';

const blank = { name: '', sku: '', barcode: '', category_name: '', brand: '', price: '', cost: '', min_stock: '0', stock: '', track_serial: false, attrs: [['', '']] };

export default function ProductForm({ params }) {
  const loc = useLocation();
  const editing = params.id;
  const copyFrom = loc.query.copy;
  const [form, setForm] = useState(editing || copyFrom ? null : blank);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: cats } = useFetch('/categories');

  useEffect(() => {
    const src = editing || copyFrom;
    if (!src) return;
    get(`/products/${src}`).then((p) =>
      setForm({
        name: p.name + (copyFrom ? ' (copy)' : ''),
        sku: copyFrom ? '' : p.sku,
        barcode: copyFrom ? '' : p.barcode || '',
        category_name: p.category || '',
        brand: p.brand || '',
        price: fromCents(p.price),
        cost: fromCents(p.cost),
        min_stock: String(p.min_stock),
        stock: '',
        track_serial: !!p.track_serial,
        attrs: [...Object.entries(p.attributes), ['', '']],
      })
    ).catch(setError);
  }, [editing, copyFrom]);

  if (!form) return error ? <ErrorBox error={error} /> : <div class="empty">Loading…</div>;
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
  const setAttr = (i, j, v) => {
    const attrs = form.attrs.map((a, k) => (k === i ? (j ? [a[0], v] : [v, a[1]]) : a));
    if (attrs[attrs.length - 1].some(Boolean)) attrs.push(['', '']);
    setForm({ ...form, attrs });
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: form.name, sku: form.sku, barcode: form.barcode, brand: form.brand,
      category_name: form.category_name || undefined,
      price: toCents(form.price), cost: toCents(form.cost), min_stock: parseInt(form.min_stock, 10) || 0,
      track_serial: form.track_serial,
      attributes: Object.fromEntries(form.attrs.filter(([k, v]) => k && v)),
    };
    if (!editing && form.stock) body.stock = parseInt(form.stock, 10) || 0;
    try {
      if (editing) {
        await put(`/products/${editing}`, body);
        toast('Saved');
        loc.route(`/products/${editing}`);
      } else {
        const r = await post('/products', body);
        toast('Product created');
        loc.route(`/products/${r.id}`);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="stack" onSubmit={submit} style="max-width:900px">
      <div class="detail-head">
        <a href={editing ? `/products/${editing}` : '/products'} class="muted">← Back</a>
        <h1>{editing ? 'Edit product' : 'New product'}</h1>
      </div>
      <ErrorBox error={error} />
      <div class="card stack">
        <label class="field"><span>Name</span><input required autoFocus value={form.name} onInput={set('name')} /></label>
        <div class="form-grid">
          <label class="field"><span>SKU (blank = automatic)</span><input value={form.sku} onInput={set('sku')} /></label>
          <label class="field"><span>Barcode</span><input value={form.barcode} onInput={set('barcode')} /></label>
          <label class="field"><span>Category</span>
            <input list="cats" value={form.category_name} onInput={set('category_name')} placeholder="Pick or type a new one" />
            <datalist id="cats">{cats?.map((c) => <option key={c.id} value={c.name} />)}</datalist>
          </label>
          <label class="field"><span>Brand</span><input value={form.brand} onInput={set('brand')} /></label>
        </div>
        <div class="form-grid">
          <label class="field"><span>Sale price</span><input inputMode="decimal" value={form.price} onInput={set('price')} placeholder="0.00" /></label>
          <label class="field"><span>Cost</span><input inputMode="decimal" value={form.cost} onInput={set('cost')} placeholder="0.00" /></label>
          <label class="field"><span>Minimum stock</span><input inputMode="numeric" value={form.min_stock} onInput={set('min_stock')} /></label>
          {!editing && !form.track_serial && <label class="field"><span>Opening stock</span><input inputMode="numeric" value={form.stock} onInput={set('stock')} placeholder="0" /></label>}
        </div>
        <label class="row" style="gap:8px">
          <input type="checkbox" checked={form.track_serial} onChange={set('track_serial')} />
          <span>Track each unit by serial/IMEI <span class="muted small">(phones, laptops, watches). Stock then comes in through a goods receipt so every serial is recorded.</span></span>
        </label>
      </div>
      <div class="card stack">
        <h2>Attributes</h2>
        <p class="muted small" style="margin:0">Free-form, e.g. STORAGE 256GB, COLOR Midnight, CONDITION New.</p>
        {form.attrs.map(([k, v], i) => (
          <div class="row" key={i} style="flex-wrap:nowrap">
            <input placeholder="Name" value={k} onInput={(e) => setAttr(i, 0, e.currentTarget.value)} aria-label="Attribute name" />
            <input placeholder="Value" value={v} onInput={(e) => setAttr(i, 1, e.currentTarget.value)} aria-label="Attribute value" />
          </div>
        ))}
      </div>
      <div class="row"><span class="spacer" /><button class="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  );
}
