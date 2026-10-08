import { createContext } from 'preact';
import { useState, useEffect, useRef, useCallback, useContext } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { get, qs } from '../api.js';

export const AppContext = createContext({ user: null, settings: {} });
export const useApp = () => useContext(AppContext);
/** Simple mode (the default) hides screens and options most small shops never need. */
export const useAdvanced = () => useContext(AppContext).settings.ui_mode === 'advanced';

/** Loads a GET endpoint; re-runs when `path` changes. Pass null to skip. */
export function useFetch(path) {
  const [state, setState] = useState({ data: null, error: null, loading: !!path });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    get(path, ctl.signal)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => {
        if (error.name !== 'AbortError') setState((s) => ({ ...s, error, loading: false }));
      });
    return () => ctl.abort();
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function useDebounced(value, ms = 150) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Filters kept in the URL query so back/forward and shared links work. */
export function useQueryParams(defaults = {}) {
  const loc = useLocation();
  const query = { ...defaults, ...loc.query };
  const set = (patch) => {
    const next = { ...loc.query, ...patch };
    if (!('page' in patch)) delete next.page;
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null || next[k] === defaults[k]) delete next[k];
    loc.route(loc.path + qs(next), true);
  };
  return [query, set];
}

/** Text box whose value is pushed to the URL after typing pauses. */
export function SearchInput({ value, onSearch, placeholder, autoFocus }) {
  const [text, setText] = useState(value || '');
  const debounced = useDebounced(text, 250);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    if (debounced !== (value || '')) onSearch(debounced);
  }, [debounced]);
  return (
    <input type="search" value={text} placeholder={placeholder} autoFocus={autoFocus}
      onInput={(e) => setText(e.currentTarget.value)} />
  );
}

export function Pager({ page, size, count, more, onPage }) {
  const p = Number(page) || 1;
  const pages = count != null ? Math.max(1, Math.ceil(count / size)) : null;
  const hasNext = pages != null ? p < pages : more;
  if (p === 1 && !hasNext) return null;
  return (
    <div class="pager">
      <span class="muted small">Page {p}{pages ? ` of ${pages}` : ''}</span>
      <button class="icon-btn" disabled={p <= 1} onClick={() => onPage(p - 1)} aria-label="Previous page">‹</button>
      <button class="icon-btn" disabled={!hasNext} onClick={() => onPage(p + 1)} aria-label="Next page">›</button>
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div class="modal-head">
          <h2>{title}</h2>
          <button class="ghost icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---- toasts ----
let pushToast = () => {};
export const toast = (text, kind = '') => pushToast({ text, kind, id: Math.random() });
export function Toasts() {
  const [list, setList] = useState([]);
  pushToast = (t) => {
    setList((l) => [...l, t]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.kind === 'bad' ? 6000 : 3500);
  };
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map((t) => <div key={t.id} class={'toast ' + t.kind}>{t.text}</div>)}
    </div>
  );
}

const STATUS = {
  completed: ['Completed', 'good'],
  cancelled: ['Cancelled', 'bad'],
  open: ['Open', 'info'],
  converted: ['Invoiced', 'good'],
  draft: ['Draft', 'warn'],
  balanced: ['Balanced', 'good'],
  in_stock: ['In stock', 'good'],
  sold: ['Sold', ''],
  missing: ['Missing', 'bad'],
};
export function Status({ value }) {
  const [label, tone] = STATUS[value] || [value, ''];
  return <span class={'badge ' + tone}>{label}</span>;
}

export function ErrorBox({ error }) {
  return error ? <div class="error">{error.message || String(error)}</div> : null;
}

export function Empty({ children = 'Nothing here yet' }) {
  return <div class="empty">{children}</div>;
}

/**
 * Async search box with a keyboard-navigable dropdown.
 * `load(q, signal)` returns items; `render(item)` draws one; `onPick(item)` fires on click/Enter.
 * `onEnter(q)` runs when Enter is pressed before results arrive (used for barcode scans).
 */
export function SearchSelect({ load, render, onPick, onEnter, placeholder, inputRef, minChars = 1, clearOnPick = true, autoFocus }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const debounced = useDebounced(q, 120);
  const ownRef = useRef();
  const ref = inputRef || ownRef;
  const pending = useRef(false);

  useEffect(() => {
    if (debounced.trim().length < minChars) return setItems([]);
    const ctl = new AbortController();
    pending.current = true;
    load(debounced.trim(), ctl.signal)
      .then((r) => {
        pending.current = false;
        setItems(r);
        setSel(0);
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [debounced]);

  const pick = (item) => {
    onPick(item);
    if (clearOnPick) setQ('');
    setItems([]);
    setOpen(false);
    ref.current?.focus();
  };

  const onKey = async (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const text = e.currentTarget.value.trim();
      if (!text) return;
      // Scanners type fast and press Enter before the debounced search runs: resolve the exact code instead.
      if (onEnter && (text !== debounced.trim() || pending.current || !items.length)) {
        if (await onEnter(text)) {
          setQ('');
          setItems([]);
        }
        return;
      }
      if (items[sel]) pick(items[sel]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div class="search" style="position:relative">
      <input ref={ref} type="search" value={q} placeholder={placeholder} autoFocus={autoFocus} autocomplete="off"
        onInput={(e) => { setQ(e.currentTarget.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKey} />
      {open && items.length > 0 && (
        <div class="dropdown">
          {items.map((it, i) => (
            <div key={i} class={'opt' + (i === sel ? ' sel' : '')} onMouseDown={(e) => { e.preventDefault(); pick(it); }}
              onMouseEnter={() => setSel(i)}>
              {render(it)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
