export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { 'x-requested-with': 'fetch' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch('/api' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const get = (path, signal) => api(path, { signal });
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

// ---- formatting ----
let moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
let timeZone = undefined;
export function configureFormats(settings) {
  moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: settings.currency || 'USD' });
  timeZone = settings.timezone;
  dtFmt = new Intl.DateTimeFormat('en-US', { timeZone, month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  dFmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
}
let dtFmt = new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
let dFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });

/** cents -> "$1,234.50" */
export const money = (cents) => moneyFmt.format((cents || 0) / 100);
export const num = (n) => (n || 0).toLocaleString('en-US');
export const dateTime = (ms) => (ms ? dtFmt.format(ms) : '');
/** Store-local YYYY-MM-DD for today (or offset by days). */
export const today = (offsetDays = 0) => dFmt.format(Date.now() + offsetDays * 864e5);
export const shortDay = (iso) => iso.slice(5).replace('-', '/');

/** "1,299.5" -> 129950 cents. Returns NaN for junk. */
export function toCents(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  const s = String(v ?? '').replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return 0;
  return Math.round(parseFloat(s) * 100);
}
export const fromCents = (c) => ((c || 0) / 100).toFixed(2).replace(/\.00$/, '');

export function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
