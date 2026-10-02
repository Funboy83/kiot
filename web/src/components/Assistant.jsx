// Store assistant side panel: streamed answers over the store's own data, with live tables
// (sort, show all, export), small charts, follow-up questions, feedback and history. It can also
// prepare work (invoices, payments, customers, products, stock): each one arrives as a card that
// does nothing until the user presses its confirm button.
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { get, post, del, money, num } from '../api.js';
import { toast, useApp } from './ui.jsx';
import { Markdown, splitBlocks } from './markdown.jsx';

const SUGGESTIONS = [
  'Chị Lan 0912 345 678 lấy 2 cáp USB-C, chuyển khoản',
  'Ai còn đang nợ?',
  'Doanh thu hôm nay thế nào so với hôm qua?',
  'Top 10 sản phẩm bán chạy tháng này',
  'Which products will run out in the next 2 weeks?',
  'Compare this month with last month',
  'What hours and weekdays are busiest?',
];

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

// ---------- formatting & export ----------

function fmt(v, type) {
  if (v == null || v === '') return '';
  if (type === 'money') return money(Math.round(v * 100));
  if (type === 'number') return typeof v === 'number' ? num(v) : String(v);
  if (type === 'percent') return `${v}%`;
  return String(v);
}
const isNumeric = (type) => type === 'money' || type === 'number' || type === 'percent';

function viewColumns(table, spec) {
  const byKey = new Map(table.columns.map((c) => [c.key, c]));
  const pick = spec?.columns;
  if (pick && typeof pick === 'object') {
    const keys = Array.isArray(pick) ? pick : Object.keys(pick);
    const cols = keys.filter((k) => byKey.has(k)).map((k) => ({ ...byKey.get(k), label: Array.isArray(pick) ? byKey.get(k).label : String(pick[k]) }));
    if (cols.length) return cols;
  }
  return table.columns;
}

function toCsv(columns, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.map((c) => esc(c.label)), ...rows.map((r) => columns.map((c) => esc(r[c.key])))].map((l) => l.join(',')).join('\r\n');
}

function download(name, text) {
  // BOM so Excel opens Vietnamese text correctly.
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s) => String(s || 'table').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'table';

// ---------- data table ----------

function DataTable({ table, spec }) {
  const columns = useMemo(() => viewColumns(table, spec), [table, spec]);
  const [sort, setSort] = useState(null);
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    if (!sort) return table.rows;
    const { key, dir } = sort;
    return [...table.rows].sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [table, sort]);
  const shown = all ? rows : rows.slice(0, 10);
  const title = spec?.title || table.title;
  const toggle = (key) => setSort((s) => (s?.key === key ? (s.dir === -1 ? { key, dir: 1 } : null) : { key, dir: -1 }));
  return (
    <div class="ai-table">
      <div class="ai-table-head">
        <b>{title}</b>
        <span class="faint small">{num(rows.length)} rows</span>
        <span class="spacer" />
        <button class="ghost icon-btn small" onClick={() => download(slug(title) + '.csv', toCsv(columns, rows))} title="Download as a CSV file (opens in Excel)">⬇ Export</button>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} class={isNumeric(c.type) ? 'num sortable' : 'sortable'} onClick={() => toggle(c.key)} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                  {c.label}
                  <span class="faint">{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => <td key={c.key} class={isNumeric(c.type) ? 'num' : ''}>{fmt(r[c.key], c.type)}</td>)}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={columns.length} class="faint">No rows</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length > 10 && (
        <button class="ghost small ai-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${num(rows.length)} rows`}</button>
      )}
    </div>
  );
}

// ---------- chart ----------

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const SERIES = ['var(--chart)', 'var(--good)', 'var(--warn)'];

function MiniChart({ table, spec }) {
  const [hot, setHot] = useState(null);
  const type = ['bar', 'line', 'hbar'].includes(spec.type) ? spec.type : 'bar';
  const colByKey = new Map(table.columns.map((c) => [c.key, c]));
  const x = colByKey.has(spec.x) ? spec.x : table.columns[0].key;
  const ys = (Array.isArray(spec.y) ? spec.y : [spec.y]).filter((k) => colByKey.has(k)).slice(0, 3);
  if (!ys.length || table.rows.length < 2) return null;
  const rows = type === 'hbar' ? table.rows.slice(0, 12) : table.rows.slice(0, 120);
  const moneyish = colByKey.get(ys[0]).type === 'money';
  const tick = (v) => (moneyish ? '$' : '') + compact.format(v);
  const max = Math.max(...rows.flatMap((r) => ys.map((k) => Number(r[k]) || 0)), 0) || 1;

  const title = spec.title && <div class="ai-chart-title">{spec.title}</div>;
  const legend = ys.length > 1 && (
    <div class="ai-legend">{ys.map((k, i) => <span key={k}><i style={{ background: SERIES[i] }} />{colByKey.get(k).label}</span>)}</div>
  );

  if (type === 'hbar') {
    return (
      <div class="ai-chart">
        {title}
        <div class="hbars">
          {rows.map((r, i) => (
            <div class="hbar" key={i}>
              <div class="top"><span class="grow">{String(r[x])}</span><span class="num">{fmt(r[ys[0]], colByKey.get(ys[0]).type)}</span></div>
              <div class="track"><div class="fill" style={{ width: `${((Number(r[ys[0]]) || 0) / max) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const W = 400, H = 170, L = 38, B = 20, T = 6;
  const step = (W - L) / rows.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const every = Math.ceil(rows.length / 6);
  const label = (v) => String(v).replace(/^\d{4}-(\d{2})-(\d{2})$/, '$1/$2');
  return (
    <div class="ai-chart" onMouseLeave={() => setHot(null)}>
      {title}
      {legend}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title || 'Chart'}>
        <g class="grid">{[0, 0.5, 1].map((f) => <line key={f} x1={L} x2={W} y1={y(f * max)} y2={y(f * max)} />)}</g>
        <g class="axis">
          {[0, 0.5, 1].map((f) => <text key={f} x={L - 4} y={y(f * max) + 3} text-anchor="end">{tick(f * max)}</text>)}
          {rows.map((r, i) => i % every === 0 && <text key={i} x={L + i * step + step / 2} y={H - 5} text-anchor="middle">{label(r[x])}</text>)}
        </g>
        {type === 'bar'
          ? rows.map((r, i) => {
              const bw = Math.max(1.5, Math.min(22, step / ys.length - 2));
              return (
                <g key={i} onMouseEnter={() => setHot(i)}>
                  <rect x={L + i * step} y={T} width={step} height={H - T - B} fill="transparent" />
                  {ys.map((k, j) => {
                    const v = Number(r[k]) || 0;
                    const top = y(v);
                    return <rect key={k} x={L + i * step + (step - bw * ys.length) / 2 + j * bw} y={top} width={bw - 0.5} height={Math.max(0, H - B - top)} rx={Math.min(3, bw / 2)} style={{ fill: SERIES[j], opacity: hot === null || hot === i ? 1 : 0.55 }} />;
                  })}
                </g>
              );
            })
          : ys.map((k, j) => (
              <polyline key={k} fill="none" stroke-width="2" style={{ stroke: SERIES[j] }}
                points={rows.map((r, i) => `${L + i * step + step / 2},${y(Number(r[k]) || 0)}`).join(' ')} />
            ))}
        {type === 'line' && rows.map((r, i) => <rect key={i} x={L + i * step} y={T} width={step} height={H - T - B} fill="transparent" onMouseEnter={() => setHot(i)} />)}
        {type === 'line' && hot !== null && <line x1={L + hot * step + step / 2} x2={L + hot * step + step / 2} y1={T} y2={H - B} stroke="var(--border)" />}
      </svg>
      {hot !== null && (
        <div class="tip" style={{ left: `${((L + hot * step + step / 2) / W) * 100}%`, top: '20%' }}>
          {String(rows[hot][x])}: {ys.map((k) => fmt(rows[hot][k], colByKey.get(k).type)).join(' · ')}
        </div>
      )}
    </div>
  );
}

// ---------- action cards ----------

const METHODS = [['cash', 'Cash'], ['transfer', 'Transfer'], ['card', 'Card']];
const STATE = { done: 'Done', cancelled: 'Dismissed' };

function ActionCard({ action, onChange }) {
  const { reloadSettings } = useApp();
  const { card, status, result } = action;
  const t = card.totals || {};
  const open = status === 'pending';
  const can = (k) => open && card.editable?.includes(k);
  const [paid, setPaid] = useState(t.paid != null ? String(t.paid / 100) : '');
  const [method, setMethod] = useState(t.method || 'cash');
  const [serials, setSerials] = useState(() => Object.fromEntries((card.lines || []).map((l, i) => [i, l.serials])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const paidCents = paid === '' ? 0 : Math.max(0, Math.round(Number(paid) * 100) || 0);
  const shownPaid = can('paid') ? Math.min(paidCents, t.total ?? paidCents) : t.paid;
  const debtAfter = t.debt_after != null && t.total != null ? t.debt_after - (t.total - t.paid) + (t.total - shownPaid) : null;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const edits = {};
      if (can('paid')) edits.paid = shownPaid;
      if (can('method')) edits.method = method;
      if (can('serials')) edits.serials = serials;
      const next = await post(`/ai/actions/${action.id}/confirm`, edits);
      onChange(next);
      if (next.result?.reload) await reloadSettings();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    try {
      onChange(await post(`/ai/actions/${action.id}/cancel`));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const pickSerial = (line, slot, value) =>
    setSerials((s) => ({ ...s, [line]: s[line].map((v, k) => (k === slot ? value : v)) }));

  return (
    <div class={'ai-card' + (card.danger ? ' danger' : '') + (open ? '' : ' ' + status)}>
      <div class="ai-card-head">
        <span class="ai-card-icon">{card.icon}</span>
        <b class="grow">{card.title}</b>
        {!open && <span class={'badge ' + (status === 'done' ? 'good' : '')}>{STATE[status] || status}</span>}
      </div>

      {card.customer && (
        <div class="ai-card-cust">
          <span>👤 <b>{card.customer.name}</b>{card.customer.code ? <span class="faint"> · {card.customer.code}</span> : null}</span>
          {card.customer.phone && <span class="faint">{card.customer.phone}</span>}
          {card.customer.is_new && <span class="badge warn">new customer</span>}
        </div>
      )}

      {card.lines?.length > 0 && (
        <table class="ai-card-lines">
          <tbody>
            {card.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <div>{l.name}</div>
                  <div class="faint small">
                    {l.qty} × {money(l.price - (l.discount || 0))}
                    {l.discount ? <s class="faint"> {money(l.price)}</s> : null}
                  </div>
                  {l.serials?.length > 0 && (
                    <div class="ai-serials">
                      {(serials[i] || l.serials).map((sn, k) =>
                        can('serials') && l.serial_options ? (
                          <select key={k} value={sn} onChange={(e) => pickSerial(i, k, e.currentTarget.value)} aria-label={`Serial ${k + 1} for ${l.name}`}>
                            {l.serial_options.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : (
                          <code key={k}>{sn}</code>
                        )
                      )}
                    </div>
                  )}
                </td>
                <td class="num">{money(l.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {card.fields?.length > 0 && (
        <dl class="ai-card-fields">
          {card.fields.map(([k, v, type], i) => (
            <div key={i}><dt>{k}</dt><dd>{type === 'money' ? money(v) : v}</dd></div>
          ))}
        </dl>
      )}

      {t.total != null && (
        <div class="ai-card-totals">
          {t.discount > 0 && <div><span>Subtotal</span><span>{money(t.subtotal)}</span></div>}
          {t.discount > 0 && <div><span>Discount</span><span>−{money(t.discount)}</span></div>}
          <div class="big"><span>Total</span><span>{money(t.total)}</span></div>
          {t.paid != null && (
            <div>
              <span>Paid now</span>
              {can('paid') ? (
                <input class="ai-paid" type="number" min="0" step="any" value={paid} onInput={(e) => setPaid(e.currentTarget.value)} aria-label="Paid now" />
              ) : (
                <span>{money(t.paid)}</span>
              )}
            </div>
          )}
          {t.paid != null && t.total - shownPaid > 0 && <div class="warn-text"><span>On credit</span><span>{money(t.total - shownPaid)}</span></div>}
          {debtAfter != null && <div class="faint"><span>Customer owes after</span><span>{money(debtAfter)}</span></div>}
        </div>
      )}

      {can('method') && shownPaid > 0 && (
        <div class="ai-seg" role="group" aria-label="Payment method">
          {METHODS.map(([k, label]) => (
            <button key={k} class={method === k ? 'on' : ''} onClick={() => setMethod(k)}>{label}</button>
          ))}
        </div>
      )}

      {card.note && <div class="faint small">📝 {card.note}</div>}
      {open && card.warnings?.map((w) => <div key={w} class="ai-warn">⚠ {w}</div>)}
      {error && <div class="error small">{error}</div>}

      {open ? (
        <div class="ai-card-buttons">
          <button class={card.danger ? 'danger' : 'primary'} disabled={busy} onClick={confirm}>{busy ? 'Working…' : card.confirm || 'Confirm'}</button>
          <button class="ghost" disabled={busy} onClick={dismiss}>Dismiss</button>
        </div>
      ) : (
        result && (
          <div class="ai-card-result">
            ✓ {result.message}
            {result.link && <a href={result.link}>Open →</a>}
          </div>
        )
      )}
    </div>
  );
}

/** A question with clickable answers: ```options {"question": "...", "options": ["...", ...]} */
function Options({ spec, onAsk, live }) {
  if (!spec || !Array.isArray(spec.options)) return null;
  return (
    <div class="ai-options">
      {spec.question && <div class="ai-options-q">{spec.question}</div>}
      {spec.options.filter((o) => typeof o === 'string').slice(0, 8).map((o) => (
        <button key={o} class="ai-option" disabled={!live} onClick={() => onAsk(o)}>{o}</button>
      ))}
    </div>
  );
}

// ---------- one answer ----------

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function Answer({ item, onAsk, live, actions, onAction }) {
  const blocks = useMemo(() => splitBlocks(item.text || ''), [item.text]);
  const followups = [];
  const body = blocks.map((b, i) => {
    if (b.type === 'md') return <Markdown key={i} lines={b.lines} />;
    if (b.lang === 'followups') {
      if (!b.open) {
        const list = parseJson(b.body);
        if (Array.isArray(list)) followups.push(...list.filter((q) => typeof q === 'string').slice(0, 4));
      }
      return null;
    }
    if (b.lang === 'options') return b.open ? null : <Options key={i} spec={parseJson(b.body)} onAsk={onAsk} live={live} />;
    if (b.lang === 'table' || b.lang === 'chart') {
      if (b.open) return <div key={i} class="ai-skeleton">{b.lang === 'table' ? 'Preparing table…' : 'Drawing chart…'}</div>;
      const spec = parseJson(b.body);
      const table = spec && item.tables?.[spec.ref];
      if (!table) return null;
      return b.lang === 'table' ? <DataTable key={i} table={table} spec={spec} /> : <MiniChart key={i} table={table} spec={spec} />;
    }
    return <pre key={i} class="ai-code">{b.body}</pre>;
  });
  return (
    <>
      <div class="ai-md">{body}</div>
      {item.actions?.map((id) => actions[id] && <ActionCard key={id} action={actions[id]} onChange={onAction} />)}
      {item.streaming && item.status && <div class="ai-status"><span class="ai-dot" />{item.status}…</div>}
      {item.streaming && !item.status && !item.text && <div class="ai-status"><span class="ai-dot" />Thinking…</div>}
      {item.error && <div class="error small">{item.error}</div>}
      {!item.streaming && followups.length > 0 && (
        <div class="ai-followups">
          {followups.map((q) => <button key={q} class="ai-chip" onClick={() => onAsk(q)}>↳ {q}</button>)}
        </div>
      )}
    </>
  );
}

/** Answer text for the clipboard: prose kept, tables as tab-separated rows, directives dropped. */
function plainText(item) {
  return splitBlocks(item.text || '')
    .map((b) => {
      if (b.type === 'md') return b.lines.join('\n');
      if (b.lang === 'table') {
        const spec = parseJson(b.body);
        const t = spec && item.tables?.[spec.ref];
        if (!t) return '';
        const cols = viewColumns(t, spec);
        return [cols.map((c) => c.label).join('\t'), ...t.rows.map((r) => cols.map((c) => fmt(r[c.key], c.type)).join('\t'))].join('\n');
      }
      if (b.lang === 'options') {
        const spec = parseJson(b.body);
        return spec ? [spec.question, ...(spec.options || []).map((o) => '- ' + o)].filter(Boolean).join('\n') : '';
      }
      return b.lang === 'chart' || b.lang === 'followups' ? '' : b.body;
    })
    .join('\n')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- streaming request ----------

async function streamChat(body, signal, on) {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: JSON.stringify(body),
    signal,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) on(event, JSON.parse(data));
    }
  }
}

// ---------- panel ----------

export default function Assistant({ onClose }) {
  const [status, setStatus] = useState(null);
  const [chatId, setChatId] = useState(() => Number(store.get('ai.chat')) || null);
  const [title, setTitle] = useState('');
  const [items, setItems] = useState([]);
  const [actions, setActions] = useState({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState(null);
  const ctl = useRef(null);
  const scroller = useRef();
  const stick = useRef(true);
  const inputRef = useRef();

  useEffect(() => {
    get('/ai/status').then(setStatus).catch((e) => setStatus({ enabled: false, help: e.message }));
    inputRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && !e.defaultPrevented && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      ctl.current?.abort();
    };
  }, []);

  useEffect(() => {
    store.set('ai.chat', chatId);
    if (!chatId || items.length) return;
    get('/ai/chats/' + chatId)
      .then((c) => {
        setTitle(c.title);
        setItems(c.items.map((it, index) => ({ ...it, index })));
        setActions(c.actions || {});
      })
      .catch(() => setChatId(null));
  }, [chatId]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const patchLast = (fn) => setItems((list) => list.map((it, i) => (i === list.length - 1 ? { ...it, ...fn(it) } : it)));

  const ask = async (question) => {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    setBusy(true);
    stick.current = true;
    setItems((list) => [...list, { role: 'user', text: q }, { role: 'assistant', text: '', tables: {}, streaming: true }]);
    const controller = new AbortController();
    ctl.current = controller;
    try {
      await streamChat({ message: q, chat_id: chatId, page: location.pathname + location.search }, controller.signal, (event, data) => {
        if (event === 'chat') {
          setChatId(data.id);
          setTitle(data.title);
        } else if (event === 'status') patchLast(() => ({ status: data.label }));
        else if (event === 'text') patchLast((it) => ({ text: it.text + data.delta, status: null }));
        else if (event === 'reset') patchLast((it) => ({ text: it.text.slice(0, data.length) }));
        else if (event === 'table') patchLast((it) => ({ tables: { ...it.tables, [data.id]: data } }));
        else if (event === 'action') {
          setActions((a) => ({ ...a, [data.id]: data }));
          patchLast((it) => ({ actions: [...(it.actions || []), data.id] }));
        }
        else if (event === 'error') patchLast(() => ({ error: data.message }));
        else if (event === 'done') patchLast(() => ({ index: data.index }));
      });
    } catch (e) {
      if (e.name !== 'AbortError') patchLast(() => ({ error: e.message }));
    } finally {
      patchLast((it) => ({ streaming: false, status: null, text: it.text || (controller.signal.aborted ? '_Stopped._' : '') }));
      setBusy(false);
      ctl.current = null;
      setHistory(null);
    }
  };

  const newChat = () => {
    ctl.current?.abort();
    setChatId(null);
    setItems([]);
    setActions({});
    setTitle('');
    setShowHistory(false);
    inputRef.current?.focus();
  };

  const openHistory = () => {
    setShowHistory(!showHistory);
    if (!history) get('/ai/chats').then((r) => setHistory(r.rows)).catch(() => setHistory([]));
  };

  const pickChat = (id) => {
    ctl.current?.abort();
    setItems([]);
    setChatId(id);
    setShowHistory(false);
  };

  const removeChat = async (id) => {
    await del('/ai/chats/' + id).catch(() => {});
    setHistory((h) => h.filter((c) => c.id !== id));
    if (id === chatId) newChat();
  };

  const feedback = async (i, value) => {
    const it = items[i];
    const next = it.feedback === value ? 0 : value;
    setItems((list) => list.map((x, k) => (k === i ? { ...x, feedback: next || undefined } : x)));
    // `index` is the answer's position in the saved conversation (from loading it, or from `done`).
    if (chatId && it.index != null) await post(`/ai/chats/${chatId}/feedback`, { index: it.index, value: next }).catch(() => {});
    if (next === -1) toast('Thanks — noted. Try rephrasing, or ask for the exact numbers you need.');
  };

  const copy = async (it) => {
    try {
      await navigator.clipboard.writeText(plainText(it));
      toast('Copied');
    } catch {
      toast('Could not copy', 'bad');
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask(input);
    }
  };

  const disabled = status && !status.enabled;

  return (
    <aside class="ai-panel" role="dialog" aria-label="Store assistant">
      <header class="ai-top">
        <button class="ghost icon-btn" onClick={openHistory} title="Past conversations" aria-label="Past conversations">☰</button>
        <div class="ai-title">{title || 'Assistant'}</div>
        <button class="ghost icon-btn" onClick={newChat} title="New conversation" aria-label="New conversation">✎</button>
        <button class="ghost icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
      </header>

      {showHistory && (
        <div class="ai-history">
          <div class="faint small" style="padding:4px 8px">Past conversations</div>
          {!history && <div class="faint small" style="padding:8px">Loading…</div>}
          {history?.length === 0 && <div class="faint small" style="padding:8px">No conversations yet</div>}
          {history?.map((c) => (
            <div key={c.id} class={'ai-hrow' + (c.id === chatId ? ' on' : '')}>
              <button class="ghost grow" onClick={() => pickChat(c.id)}>{c.title}</button>
              <button class="ghost icon-btn faint" onClick={() => removeChat(c.id)} aria-label="Delete conversation" title="Delete">🗑</button>
            </div>
          ))}
        </div>
      )}

      <div class="ai-body" ref={scroller} onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}>
        {disabled && (
          <div class="ai-setup">
            <b>The assistant isn’t switched on yet.</b>
            <p>{status.help}</p>
          </div>
        )}
        {!disabled && !items.length && (
          <div class="ai-empty">
            <div class="ai-hello">✨</div>
            <h3>Ask or tell me what to do</h3>
            <p class="muted">Paste a customer’s message to make an invoice, or ask about sales, debts and stock. English or Tiếng Việt. Nothing changes until you confirm it.</p>
            <div class="ai-suggest">
              {SUGGESTIONS.map((s) => <button key={s} class="ai-chip" onClick={() => ask(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {items.map((it, i) =>
          it.role === 'user' ? (
            <div key={i} class="ai-q">{it.text}</div>
          ) : (
            <div key={i} class="ai-a">
              <Answer item={it} onAsk={ask} live={!busy && i === items.length - 1} actions={actions} onAction={(a) => setActions((m) => ({ ...m, [a.id]: a }))} />
              {!it.streaming && it.text && (
                <div class="ai-actions">
                  <button class={'ghost icon-btn' + (it.feedback === 1 ? ' on' : '')} onClick={() => feedback(i, 1)} title="Good answer" aria-label="Good answer">👍</button>
                  <button class={'ghost icon-btn' + (it.feedback === -1 ? ' on' : '')} onClick={() => feedback(i, -1)} title="Bad answer" aria-label="Bad answer">👎</button>
                  <button class="ghost icon-btn" onClick={() => copy(it)} title="Copy answer" aria-label="Copy answer">⧉</button>
                </div>
              )}
            </div>
          )
        )}
      </div>

      <footer class="ai-foot">
        <div class="ai-input">
          <textarea ref={inputRef} rows={1} value={input} disabled={disabled} placeholder="Ask, or paste a customer’s order…"
            onInput={(e) => {
              setInput(e.currentTarget.value);
              e.currentTarget.style.height = 'auto';
              e.currentTarget.style.height = Math.min(140, e.currentTarget.scrollHeight) + 'px';
            }}
            onKeyDown={onKeyDown} />
          {busy ? (
            <button class="ai-send" onClick={() => ctl.current?.abort()} title="Stop" aria-label="Stop">■</button>
          ) : (
            <button class="ai-send primary" disabled={disabled || !input.trim()} onClick={() => ask(input)} title="Send (Enter)" aria-label="Send">↑</button>
          )}
        </div>
        <div class="ai-note">AI can make mistakes. Check each card before you confirm it.</div>
      </footer>
    </aside>
  );
}
