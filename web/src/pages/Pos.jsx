import { useState, useEffect, useRef } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { get, post, money, toCents, fromCents, dateTime } from '../api.js';
import { SearchSelect, Modal, toast, useApp, ErrorBox } from '../components/ui.jsx';

const STORAGE_KEY = 'pos-carts-v1';
let nextId = 1;
const newCart = (n) => ({ id: Date.now() + nextId++, name: `Invoice ${n}`, items: [], customer: null, discount: '', paid: null, method: 'cash', note: '', order_id: null });

function loadCarts() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved?.carts) && saved.carts.length) return saved;
  } catch {}
  return { carts: [newCart(1)], active: 0 };
}

const lineTotal = (l) => l.qty * (l.price - l.discount);

export default function Pos() {
  const { user } = useApp();
  const loc = useLocation();
  const [state, setState] = useState(loadCarts);
  const [serialFor, setSerialFor] = useState(null); // product id whose serial picker is open
  const [newCustomer, setNewCustomer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const productRef = useRef();
  const customerRef = useRef();
  const { carts, active } = state;
  const cart = carts[Math.min(active, carts.length - 1)];

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }, [state]);

  const update = (patch) =>
    setState((s) => ({ ...s, carts: s.carts.map((c, i) => (i === s.active ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c)) }));
  const setItems = (fn) => update((c) => ({ items: fn(c.items) }));

  // Open a saved sales order in a new tab: /pos?order=ID
  useEffect(() => {
    const id = loc.query.order;
    if (!id) return;
    get(`/invoices/${id}`).then((o) => {
      if (o.kind !== 'order' || o.status !== 'open') return toast(`Order ${o.code} is ${o.status}`, 'bad');
      setState((s) => {
        const c = { ...newCart(s.carts.length + 1), name: o.code, order_id: o.id,
          customer: o.customer_id ? { id: o.customer_id, name: o.customer_name, phone: o.customer_phone, debt: o.customer_debt } : null,
          discount: o.discount ? fromCents(o.discount) : '', note: o.note || '',
          items: o.items.map((it) => ({ product_id: it.product_id, sku: it.sku, name: it.name, price: it.price, discount: it.discount, qty: it.track_serial ? 0 : it.qty, want: it.qty, track_serial: !!it.track_serial, serials: [] })) };
        return { carts: [...s.carts, c], active: s.carts.length };
      });
      loc.route('/pos', true);
    }).catch((e) => toast(e.message, 'bad'));
  }, [loc.query.order]);

  // Keyboard shortcuts, as in KiotViet: F3 product, F4 customer, F9 pay, F2 new invoice tab.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F3') { e.preventDefault(); productRef.current?.focus(); }
      if (e.key === 'F4') { e.preventDefault(); customerRef.current?.focus(); }
      if (e.key === 'F2') { e.preventDefault(); addTab(); }
      if (e.key === 'F9') { e.preventDefault(); document.getElementById('checkout')?.click(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const addTab = () => setState((s) => ({ carts: [...s.carts, newCart(s.carts.length + 1)], active: s.carts.length }));
  const closeTab = (i) =>
    setState((s) => {
      const carts = s.carts.filter((_, j) => j !== i);
      if (!carts.length) carts.push(newCart(1));
      return { carts, active: Math.min(s.active >= i ? Math.max(0, s.active - 1) : s.active, carts.length - 1) };
    });

  const addProduct = (p, serial) => {
    setError(null);
    setItems((items) => {
      const idx = items.findIndex((l) => l.product_id === p.id);
      if (idx >= 0) {
        const l = items[idx];
        let next;
        if (p.track_serial) {
          if (!serial) return items;
          if (l.serials.some((s) => s.toLowerCase() === serial.toLowerCase())) {
            toast(`${serial} is already in the cart`);
            return items;
          }
          next = { ...l, serials: [...l.serials, serial], qty: l.serials.length + 1 };
        } else next = { ...l, qty: l.qty + 1 };
        return [next, ...items.filter((_, i) => i !== idx)];
      }
      return [{ product_id: p.id, sku: p.sku, name: p.name, price: p.price, discount: 0, qty: p.track_serial ? (serial ? 1 : 0) : 1, track_serial: !!p.track_serial, stock: p.stock, serials: serial ? [serial] : [] }, ...items];
    });
    if (p.track_serial && !serial) setSerialFor(p.id);
  };

  // Enter in the product box: exact barcode / SKU / serial first (scanner), otherwise the top search hit.
  const scan = async (code) => {
    try {
      const { product, serial } = await get('/products/lookup?code=' + encodeURIComponent(code));
      if (serial && serial.status !== 'in_stock') {
        toast(`${serial.serial} is ${serial.status.replace('_', ' ')}`, 'bad');
        return true;
      }
      addProduct(product, serial?.serial);
      return true;
    } catch {
      const r = await get('/products?size=1&q=' + encodeURIComponent(code));
      if (r.rows[0]) {
        addProduct(r.rows[0]);
        return true;
      }
      toast(`Nothing matches “${code}”`, 'bad');
      return false;
    }
  };

  const subtotal = cart.items.reduce((a, l) => a + lineTotal(l), 0);
  const discount = Math.min(Math.max(0, toCents(cart.discount)), subtotal);
  const total = subtotal - discount;
  const paid = cart.paid === null ? total : Math.max(0, toCents(cart.paid));
  const change = paid - total;

  const checkout = async (kind = 'invoice') => {
    setError(null);
    if (!cart.items.length) return setError(new Error('The cart is empty'));
    const missing = kind === 'invoice' && cart.items.find((l) => l.track_serial && (l.qty === 0 || l.serials.length !== l.qty));
    if (missing) {
      setSerialFor(missing.product_id);
      return setError(new Error(`Pick the serial/IMEI for ${missing.name}`));
    }
    setBusy(true);
    try {
      const r = await post('/invoices', {
        kind,
        order_id: kind === 'invoice' ? cart.order_id : undefined,
        customer_id: cart.customer?.id,
        items: cart.items.map((l) => ({ product_id: l.product_id, qty: kind === 'order' && l.track_serial ? Math.max(l.qty, l.want || 1) : l.qty, price: l.price, discount: l.discount, serials: l.serials })),
        discount,
        paid,
        method: cart.method,
        note: cart.note,
      });
      toast(
        <span>
          {kind === 'order' ? 'Order' : 'Invoice'} <a href={`/invoices/${r.id}`} style="color:inherit;text-decoration:underline">{r.code}</a> saved
          {r.change > 0 && ` · change ${money(r.change)}`}
        </span>
      );
      setState((s) => {
        const carts = s.carts.map((c, i) => (i === s.active ? newCart(i + 1) : c));
        return { ...s, carts };
      });
      productRef.current?.focus();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const loadProducts = async (q, signal) => (await get('/products?size=15&sort=name&q=' + encodeURIComponent(q), signal)).rows;
  const loadCustomers = async (q, signal) => (await get('/customers?size=10&q=' + encodeURIComponent(q), signal)).rows;
  const serialLine = cart.items.find((l) => l.product_id === serialFor);

  return (
    <div class="pos">
      <div class="pos-top">
        <div class="search">
          <SearchSelect inputRef={productRef} autoFocus placeholder="Scan or search product, SKU, IMEI (F3)"
            load={loadProducts} onEnter={scan} onPick={(p) => addProduct(p)}
            render={(p) => (
              <>
                <span class="grow">{p.name} <span class="faint small">{p.sku}</span></span>
                <span class={'small ' + (p.stock > 0 ? 'muted' : 'down')}>stock {p.stock}</span>
                <span class="num">{money(p.price)}</span>
              </>
            )} />
        </div>
        <div class="pos-tabs" role="tablist">
          {carts.map((c, i) => (
            <button key={c.id} role="tab" aria-selected={i === active} class={'pos-tab' + (i === active ? ' on' : '')} onClick={() => setState((s) => ({ ...s, active: i }))}>
              {c.name}{c.items.length > 0 && ` (${c.items.length})`}
              <span class="x" role="button" aria-label={`Close ${c.name}`} onClick={(e) => { e.stopPropagation(); if (!c.items.length || confirm(`Discard ${c.name}?`)) closeTab(i); }}>✕</span>
            </button>
          ))}
          <button class="pos-tab" onClick={addTab} title="New invoice (F2)" aria-label="New invoice">＋</button>
        </div>
        <a class="btn pos-tab" href="/" title="Back to admin">Admin</a>
      </div>

      <div class="pos-body">
        <div class="card cart">
          {!cart.items.length && <div class="empty">Scan a barcode or IMEI, or search for a product.<br /><span class="small faint">F3 search · F4 customer · F9 pay · F2 new tab</span></div>}
          {cart.items.map((l, i) => (
            <div class="cart-line" key={l.product_id}>
              <div class="idx">{cart.items.length - i}</div>
              <div>
                <div class="name">{l.name}</div>
                <div class="small faint">{l.sku}{l.stock != null && !l.track_serial && l.stock < l.qty && <span class="down"> · only {l.stock} in stock</span>}</div>
              </div>
              <div class="num" style="font-weight:600">{money(lineTotal(l))}</div>
              <div class="controls">
                {l.track_serial ? (
                  <button class={l.serials.length ? '' : 'danger'} onClick={() => setSerialFor(l.product_id)}>
                    {l.serials.length ? `${l.serials.length} serial/IMEI` : 'Pick serial/IMEI'}
                  </button>
                ) : (
                  <div class="qty">
                    <button onClick={() => setItems((its) => its.map((x) => (x === l ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))} aria-label="Decrease">−</button>
                    <input inputMode="numeric" value={l.qty} aria-label="Quantity"
                      onChange={(e) => { const q = Math.max(1, parseInt(e.currentTarget.value, 10) || 1); setItems((its) => its.map((x) => (x === l ? { ...x, qty: q } : x))); }} />
                    <button onClick={() => setItems((its) => its.map((x) => (x === l ? { ...x, qty: x.qty + 1 } : x)))} aria-label="Increase">+</button>
                  </div>
                )}
                <label class="small muted row" style="gap:4px">× <input inputMode="decimal" aria-label="Unit price" value={fromCents(l.price)}
                  onChange={(e) => { const v = Math.max(0, toCents(e.currentTarget.value)); setItems((its) => its.map((x) => (x === l ? { ...x, price: v, discount: Math.min(x.discount, v) } : x))); }} /></label>
                <label class="small muted row" style="gap:4px">− <input inputMode="decimal" aria-label="Discount per unit" placeholder="discount" value={l.discount ? fromCents(l.discount) : ''}
                  onChange={(e) => { const v = Math.max(0, toCents(e.currentTarget.value)); setItems((its) => its.map((x) => (x === l ? { ...x, discount: Math.min(v, x.price) } : x))); }} /></label>
                <span class="spacer" />
                <button class="ghost icon-btn danger" onClick={() => setItems((its) => its.filter((x) => x !== l))} aria-label={`Remove ${l.name}`}>🗑</button>
              </div>
              {l.serials.length > 0 && (
                <div style="grid-column:2/4">
                  {l.serials.map((s) => (
                    <span class="chip" key={s}>{s}<button aria-label={`Remove ${s}`} onClick={() => setItems((its) => its.map((x) => (x === l ? { ...x, serials: x.serials.filter((y) => y !== s), qty: x.serials.length - 1 } : x)))}>✕</button></span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div class="card pay">
          <div class="row small muted">
            <span>{user.name}</span><span class="spacer" /><span>{dateTime(Date.now())}</span>
          </div>
          <div class="cust-pick">
            {cart.customer ? (
              <div class="row" style="flex-wrap:nowrap">
                <div style="flex:1;min-width:0">
                  <a href={`/customers/${cart.customer.id}`} target="_blank"><b>{cart.customer.name}</b></a>
                  <div class="small muted">{cart.customer.phone}{cart.customer.debt > 0 && <span class="down"> · owes {money(cart.customer.debt)}</span>}</div>
                </div>
                <button class="ghost icon-btn" onClick={() => update({ customer: null })} aria-label="Remove customer">✕</button>
              </div>
            ) : (
              <div class="row" style="flex-wrap:nowrap">
                <div style="flex:1">
                  <SearchSelect inputRef={customerRef} placeholder="Customer name or phone (F4)" load={loadCustomers}
                    onPick={(c) => update({ customer: c })}
                    render={(c) => (<><span class="grow">{c.name}</span><span class="small muted">{c.phone}</span></>)} />
                </div>
                <button class="icon-btn" onClick={() => setNewCustomer(true)} title="New customer" aria-label="New customer">＋</button>
              </div>
            )}
          </div>
          {cart.order_id && <div class="badge info">Completing order {cart.name}</div>}

          <div class="sum-line"><span>Subtotal ({cart.items.reduce((a, l) => a + l.qty, 0)} items)</span><b class="num">{money(subtotal)}</b></div>
          <label class="sum-line"><span>Discount</span>
            <input inputMode="decimal" value={cart.discount} placeholder="0" onInput={(e) => update({ discount: e.currentTarget.value })} /></label>
          <div class="sum-line"><span>Customer pays</span><span class="due num">{money(total)}</span></div>
          <div class="methods" role="radiogroup" aria-label="Payment method">
            {[['cash', 'Cash'], ['card', 'Card'], ['transfer', 'Transfer']].map(([m, label]) => (
              <button key={m} role="radio" aria-checked={cart.method === m} class={cart.method === m ? 'on' : ''} onClick={() => update({ method: m })}>{label}</button>
            ))}
          </div>
          <label class="sum-line"><span>Amount received</span>
            <input inputMode="decimal" value={cart.paid === null ? fromCents(total) : cart.paid} onFocus={(e) => e.currentTarget.select()} onInput={(e) => update({ paid: e.currentTarget.value })} /></label>
          {change > 0 && <div class="sum-line"><span>Change</span><b class="num up">{money(change)}</b></div>}
          {change < 0 && <div class="sum-line"><span>Added to customer debt</span><b class="num down">{money(-change)}</b></div>}
          <input placeholder="Note" value={cart.note} onInput={(e) => update({ note: e.currentTarget.value })} />
          <ErrorBox error={error} />
          <span class="spacer" />
          <button class="ghost" disabled={busy || !cart.items.length || !!cart.order_id} onClick={() => checkout('order')}>Save as order (no stock change)</button>
          <button id="checkout" class="primary checkout" disabled={busy} onClick={() => checkout('invoice')}>
            {busy ? 'Saving…' : `Pay ${money(total)}`} <span class="kbd" style="color:inherit;border-color:currentColor">F9</span>
          </button>
        </div>
      </div>

      {serialLine && (
        <SerialPicker line={serialLine} onClose={() => { setSerialFor(null); productRef.current?.focus(); }}
          onSave={(serials) => { setItems((its) => its.map((x) => (x === serialLine ? { ...x, serials, qty: serials.length } : x))); setSerialFor(null); productRef.current?.focus(); }} />
      )}
      {newCustomer && <QuickCustomer onClose={() => setNewCustomer(false)} onCreated={(c) => { update({ customer: c }); setNewCustomer(false); }} />}
    </div>
  );
}

function SerialPicker({ line, onClose, onSave }) {
  const [picked, setPicked] = useState(line.serials);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => get(`/products/${line.product_id}/serials?status=in_stock&size=100&q=${encodeURIComponent(q)}`, ctl.signal).then((r) => setRows(r.rows)).catch(() => {}), 120);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);
  const toggle = (s) => setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));
  const onKey = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const exact = rows?.find((r) => r.serial.toLowerCase() === q.trim().toLowerCase()) || (rows?.length === 1 ? rows[0] : null);
    if (exact) {
      if (!picked.includes(exact.serial)) setPicked((p) => [...p, exact.serial]);
      setQ('');
    } else toast(`${q} is not in stock for this product`, 'bad');
  };
  return (
    <Modal title={`Serial/IMEI · ${line.name}`} onClose={onClose}
      footer={<><span class="muted">{picked.length} picked{line.want ? ` (order asked for ${line.want})` : ''}</span><span class="spacer" /><button onClick={onClose}>Cancel</button><button class="primary" onClick={() => onSave(picked)}>Done</button></>}>
      <input autoFocus placeholder="Scan or type serial/IMEI, Enter to add" value={q} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} />
      <div style="margin:10px 0">{picked.map((s) => <span class="chip" key={s}>{s}<button onClick={() => toggle(s)} aria-label={`Remove ${s}`}>✕</button></span>)}</div>
      <div style="max-height:45vh;overflow:auto">
        {rows === null && <div class="empty">Loading…</div>}
        {rows?.length === 0 && <div class="empty">No serials in stock{q && ' matching that'}. Receive stock first.</div>}
        {rows?.map((r) => (
          <label key={r.id} class="row" style="padding:6px 4px;border-bottom:1px solid var(--border);cursor:pointer">
            <input type="checkbox" checked={picked.includes(r.serial)} onChange={() => toggle(r.serial)} />
            <span class="chip">{r.serial}</span>
            <span class="spacer" />
            <span class="small faint">received {dateTime(r.received_at).slice(0, 10)}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

export function QuickCustomer({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', phone: '' });
  const [error, setError] = useState(null);
  const save = async (e) => {
    e?.preventDefault();
    try {
      onCreated(await post('/customers', form));
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title="New customer" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button class="primary" onClick={save}>Save</button></>}>
      <form class="stack" onSubmit={save}>
        <ErrorBox error={error} />
        <label class="field"><span>Name</span><input autoFocus value={form.name} onInput={(e) => setForm({ ...form, name: e.currentTarget.value })} /></label>
        <label class="field"><span>Phone</span><input type="tel" value={form.phone} onInput={(e) => setForm({ ...form, phone: e.currentTarget.value })} /></label>
        <button hidden />
      </form>
    </Modal>
  );
}
