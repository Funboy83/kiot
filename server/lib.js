import { getSettings } from './db.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (message) => new HttpError(400, message);
export const notFound = (what = 'Not found') => new HttpError(404, what);

const formatters = new Map();

/** Store-local calendar day (YYYY-MM-DD) for an epoch-ms timestamp. */
export function bizDate(ms, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f.format(ms);
}

export function storeToday(db, now = Date.now()) {
  return bizDate(now, getSettings(db).timezone);
}

export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Next document code for a prefix, e.g. HD000001. Must run inside a transaction. */
export function nextCode(db, prefix) {
  const row = db
    .prepare(
      `INSERT INTO counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`
    )
    .get(prefix);
  return prefix + String(row.value).padStart(6, '0');
}

export function paging(query, defaultSize = 50) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.min(200, Math.max(1, parseInt(query.size, 10) || defaultSize));
  return { page, size, offset: (page - 1) * size };
}

export function int(v, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw bad(`${name} is required`);
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number`);
  if (n < min || n > max) throw bad(`${name} is out of range`);
  return n;
}

export function str(v, name, { max = 500, optional = false } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (optional) return null;
    throw bad(`${name} is required`);
  }
  const s = String(v).trim();
  if (s.length > max) throw bad(`${name} is too long`);
  return s;
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Turns free text into an FTS5 trigram query. Returns null when a term is shorter
 * than 3 characters (trigram cannot index it) so callers fall back to LIKE.
 */
export function ftsQuery(q) {
  const terms = String(q || '').trim().split(/\s+/).filter(Boolean);
  if (!terms.length || terms.some((t) => t.length < 3)) return null;
  return terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' AND ');
}

export const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

/**
 * WHERE fragment matching free text against an FTS5 trigram table, falling back to
 * LIKE over the given columns for very short terms.
 */
export function textMatch(q, ftsTable, idCol, likeCols) {
  const fts = ftsQuery(q);
  if (fts) return { sql: `${idCol} IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ?)`, params: [fts] };
  const terms = String(q).trim().split(/\s+/).filter(Boolean);
  const parts = [];
  const params = [];
  for (const t of terms) {
    parts.push('(' + likeCols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    for (let i = 0; i < likeCols.length; i++) params.push('%' + likeEscape(t) + '%');
  }
  return { sql: parts.join(' AND '), params };
}
