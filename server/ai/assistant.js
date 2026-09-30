// The store assistant: a streamed Claude tool-use loop over read-only store data.
import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from '../db.js';
import { storeToday } from '../lib.js';
import { toolsFor, ToolInputError } from './tools.js';
import { QueryError } from './readonly-sql.js';

export const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.AI_EFFORT || 'low';
const MAX_ROUNDS = 8; // tool round trips per question
const ROWS_TO_MODEL = 60; // the panel gets the full table; the model sees this many rows
const HISTORY_TURNS = 12; // earlier questions kept as context

export function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let sharedClient = null;
export function defaultClient() {
  if (!aiConfigured()) return null;
  sharedClient ??= new Anthropic({ maxRetries: 2, timeout: 120_000 });
  return sharedClient;
}

const SCHEMA = `invoices(id, code 'HD…', kind 'invoice'|'order', status: invoice completed|cancelled, order open|converted|cancelled, customer_id, user_id, created_at epoch ms, biz_date 'YYYY-MM-DD' store-local, subtotal, discount, total, paid, cost_total, note)
invoice_items(invoice_id, product_id, name, qty, price, discount per unit, unit_cost, total)
products(id, sku, barcode, name, category_id, brand, price, cost, stock, min_stock, track_serial 0|1, attributes JSON text, active 0|1, created_at)
categories(id, name)
customers(id, code 'KH…', name, phone, email, address, type person|company, note, debt, total_sales, created_at)
payments(id, code, customer_id, invoice_id, amount (negative = refund), method cash|card|transfer, created_at, biz_date, user_id, note)
payment_allocations(payment_id, invoice_id, amount)  -- debt payments spread over unpaid invoices, oldest first
serials(id, product_id, serial (IMEI/serial number), status in_stock|sold|missing, cost, receipt_id, invoice_id, received_at, sold_at)
receipts(id, code 'PN…', supplier, created_at, biz_date, total, note)  -- goods received from suppliers
receipt_items(receipt_id, product_id, qty, unit_cost, total)
stock_takes(id, code, status draft|balanced, created_at, balanced_at, diff_qty, diff_value)
stock_moves(product_id, created_at, ref_type sale|cancel|receipt|stocktake|initial, ref_code, qty, balance, unit_cost)
Money columns are integer cents. Sales = invoices WHERE kind='invoice' AND status='completed'. A customer's unpaid amount on an invoice is total - paid.`;

const SYSTEM = `You are the built-in assistant of a retail store management app (point of sale, products with serial/IMEI tracking, stock, invoices, customers and debt, reports). You help the owner and staff understand their business from the store's own data.

How to work:
- Answer from the data. Call the tools to get numbers; never guess or invent figures, names or codes. If the data cannot answer, say so and say what would.
- You can only read. You cannot create, change or delete anything (sales, prices, stock, payments). If asked to, explain where in the app to do it.
- Resolve relative dates ("today", "this week", "tháng này", "last month") from the context line in the user's message. Weeks start on Monday.
- Prefer the specific tools; use run_sql only when none fits. Make independent tool calls in parallel.
- Be fast: one round of tool calls is usually enough.

How to answer:
- Reply in the language the user writes in (Vietnamese or English, or whatever they use). Keep the store's names and codes as they are.
- Lead with the direct answer in one sentence with the key number in bold. Then the detail. Keep it tight; no preamble, no restating the question.
- Money: format in the store currency given in the context (e.g. $1,234.50). Tool results already give money in currency units.
- To show a list, embed the tool's table instead of retyping rows: put a fenced block on its own lines:
\`\`\`table
{"ref":"t1","title":"Short title","columns":{"name":"Customer","debt":"Owes"}}
\`\`\`
  "ref" is the table_id from the tool result. "columns" is optional: it picks which columns to show, in order, and renames them (write labels in the user's language). The panel shows every row with sorting and file export, so don't also list those rows in text. For 3 rows or fewer, plain text is fine.
- When a trend or comparison is clearer as a picture, add a chart from a table:
\`\`\`chart
{"ref":"t2","type":"bar","x":"period","y":["revenue"],"title":"Revenue by day"}
\`\`\`
  type is "bar", "line" or "hbar" (ranked horizontal bars, good for top-N). y is 1–3 numeric columns. Only chart tables with 2 or more rows.
- After the data, add a short "highlights" list (2–4 bullets) of what stands out: biggest items, oldest items, unusual changes, risks. Then, when useful, 1–3 concrete suggested actions. Skip either when there is nothing real to say.
- End every answer with 2–3 natural follow-up questions the user is likely to ask next, in their language, as:
\`\`\`followups
["First question?","Second question?"]
\`\`\`
- Use Markdown: **bold**, short lists, ### headings only for longer answers. No HTML.

Database schema for run_sql (SQLite):
${SCHEMA}`;

/** Removes reasoning blocks from earlier turns; everything else goes back unchanged. */
function forHistory(content) {
  return content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
}

/** Keeps the last HISTORY_TURNS questions, cutting only at the start of a question. */
export function trimHistory(messages) {
  const starts = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))) starts.push(i);
  });
  if (starts.length <= HISTORY_TURNS) return messages;
  return messages.slice(starts[starts.length - HISTORY_TURNS]);
}

const STATUS = {
  sales_summary: 'Adding up sales',
  sales_trend: 'Looking at the sales trend',
  top_products: 'Ranking products',
  top_customers: 'Ranking customers',
  customer_debts: 'Checking customer debts',
  find_customers: 'Looking up the customer',
  find_products: 'Looking up products',
  inventory_status: 'Checking stock',
  run_sql: 'Querying the store data',
};

function contextLine(db, user, page) {
  const s = getSettings(db);
  const today = storeToday(db);
  const weekday = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const parts = [
    `Today is ${weekday} ${today} (store time zone ${s.timezone}).`,
    `Store: ${s.store_name}. Currency: ${s.currency}.`,
    `User: ${user.name} (${user.role === 'admin' ? 'owner/admin' : 'cashier: no cost or profit data'}).`,
  ];
  if (page) parts.push(`They are looking at the app page ${String(page).slice(0, 200)}.`);
  return `<context>${parts.join(' ')}</context>`;
}

/**
 * Runs one question. `emit(event, data)` streams to the panel:
 *   status {label} · text {delta} · table {id, title, columns, rows} · error {message}
 * Returns { messages, answer, tables } where messages is the new model-facing history.
 */
export async function runTurn({ client, db, user, history, question, page, query, nextTableId, emit, signal }) {
  const tools = toolsFor(user);
  const byName = new Map(tools.map((t) => [t.def.name, t]));
  const toolDefs = tools.map((t) => ({ ...t.def, eager_input_streaming: true }));
  const settings = getSettings(db);
  const ctx = { admin: user.role === 'admin', tz: settings.timezone, query };

  const messages = trimHistory(history).map((m) => (m.role === 'assistant' && Array.isArray(m.content) ? { ...m, content: forHistory(m.content) } : m));
  messages.push({ role: 'user', content: [{ type: 'text', text: contextLine(db, user, page) }, { type: 'text', text: question }] });

  let answer = '';
  const tables = {};
  let parseRetries = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let message;
    let roundText = '';
    try {
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 16000,
          system: SYSTEM,
          tools: toolDefs,
          messages,
          output_config: { effort: EFFORT },
          cache_control: { type: 'ephemeral' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal }
      );
      for await (const ev of stream) {
        if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
          emit('status', { label: STATUS[ev.content_block.name] || 'Working' });
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          roundText += ev.delta.text;
          emit('text', { delta: ev.delta.text });
        }
      }
      message = await stream.finalMessage();
    } catch (err) {
      // With eager input streaming a tool input can arrive as JSON the SDK cannot parse. Re-ask
      // (a couple of times at most); real API errors go up to the caller.
      if (err instanceof Anthropic.APIError || signal?.aborted || parseRetries >= 2) throw err;
      parseRetries++;
      if (roundText) emit('reset', { length: answer.length });
      round--;
      continue;
    }
    answer += roundText;

    if (message.stop_reason === 'refusal') {
      const msg = '\n\nI can’t help with that request.';
      answer += msg;
      emit('text', { delta: msg });
      messages.push({ role: 'assistant', content: message.content });
      break;
    }

    messages.push({ role: 'assistant', content: message.content });
    const calls = message.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) break;
    if (message.stop_reason === 'max_tokens') {
      // A tool call cut off mid-input is not safe to run.
      messages.pop();
      const msg = '\n\n(The answer got too long. Try a narrower question.)';
      answer += msg;
      emit('text', { delta: msg });
      break;
    }

    const results = await Promise.all(
      calls.map(async (call) => {
        const tool = byName.get(call.name);
        try {
          if (!tool) throw new ToolInputError(`Unknown tool ${call.name}`);
          if (typeof call.input !== 'object' || call.input === null || Array.isArray(call.input)) {
            throw new ToolInputError('INVALID_JSON: tool input must be an object');
          }
          const out = await tool.run(db, call.input, ctx);
          return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(present(out, tables, nextTableId, emit)) };
        } catch (e) {
          if (!(e instanceof ToolInputError || e instanceof QueryError)) console.error('assistant tool failed', call.name, e);
          const message = e instanceof ToolInputError || e instanceof QueryError ? e.message : 'The tool failed unexpectedly';
          return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: message };
        }
      })
    );
    messages.push({ role: 'user', content: results });
    if (answer && !answer.endsWith('\n')) {
      answer += '\n\n';
      emit('text', { delta: '\n\n' });
    }
    if (round === MAX_ROUNDS - 1) {
      const msg = 'I needed too many steps for this one. Try asking in a more specific way.';
      answer += msg;
      emit('text', { delta: msg });
    }
  }
  return { messages, answer: answer.trim(), tables };
}

/** Moves a tool's table to the panel and gives the model a compact view of it. */
function present(out, tables, nextTableId, emit) {
  if (!out.table) return out;
  const id = nextTableId();
  const { rows, columns, title } = out.table;
  const table = { id, title, columns, rows };
  tables[id] = table;
  emit('table', table);
  return {
    ...out.summary,
    table_id: id,
    row_count: rows.length,
    columns: columns.map((c) => c.key),
    rows: rows.slice(0, ROWS_TO_MODEL),
    ...(rows.length > ROWS_TO_MODEL ? { note: `Only the first ${ROWS_TO_MODEL} of ${rows.length} rows are shown here; the user sees all of them in the embedded table.` } : {}),
  };
}
