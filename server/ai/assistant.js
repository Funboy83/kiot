// The store assistant: a streamed Claude tool-use loop over read-only store data.
import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from '../db.js';
import { storeToday } from '../lib.js';
import { toolsFor, ToolInputError } from './tools.js';
import { actionsFor, publicCard } from './actions.js';
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

const SYSTEM = `You are the built-in assistant of a retail store management app (point of sale, products with serial/IMEI tracking, stock, invoices, customers and debt, reports). You help the owner and staff run the store: you answer questions from the store's own data and you do the work for them — create invoices, record payments, add or change customers and products, receive goods, correct stock, change settings.

How to work:
- Answer from the data. Call the tools to get numbers; never guess or invent figures, names, ids or codes. If the data cannot answer, say so and say what would.
- Resolve relative dates ("today", "this week", "tháng này", "last month") from the context line in the user's message. Weeks start on Monday.
- Prefer the specific tools; use run_sql only when none fits. Make independent tool calls in parallel.
- Be fast: one round of tool calls is usually enough.

Doing things (actions):
- Action tools (create_invoice, record_payment, cancel_invoice, save_customer, save_product, receive_goods, set_stock, update_settings) never change anything by themselves. Each one puts a card in front of the user with the details; it happens only when the user presses the button on the card. The user can also edit the payment and serials on an invoice card.
- So after calling an action tool, write one short line in the user's language pointing to the card (e.g. "Hóa đơn đã soạn xong, kiểm tra rồi bấm **Create invoice**."). Do not repeat the card's details, and never say it is done. You learn the outcome from an <action_updates> note in a later message.
- Actions need database ids: look products up with find_products and customers with find_customers first (in parallel). Tool errors tell you what to fix; fix and retry, or ask.
- Pasted customer messages (Zalo, SMS, Facebook, often Vietnamese without accents, e.g. "a oi lay cho e 2 thung redbull voi 1 ip 17 pro max 256 nha, ck sau"): work out the customer, each product and quantity, special prices, and whether they pay now or later ("ck" = chuyển khoản/transfer, "ghi nợ"/"thiếu"/"tuần sau trả" = on credit, "tiền mặt"/"tm" = cash). Then call create_invoice straight away if everything is clear.
- If something is unclear (a product matches several items, a product or customer is not found, a quantity is missing), do not guess: ask one short question and offer the choices as buttons:
\`\`\`options
{"question":"Which iPhone 17 Pro?","options":["iPhone 17 Pro 256GB — $1,099","iPhone 17 Pro Max 256GB — $1,199"]}
\`\`\`
  Clicking a button sends its text as the user's reply. Ask about everything unclear at once, one block per question.
- A customer the system does not know: pass new_customer with what the message gives (name, phone); the card shows they will be added.
- Changing several things at once is fine: call several action tools; each gets its own card.

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
- For questions about data: after the data, add a short "highlights" list (2–4 bullets) of what stands out: biggest items, oldest items, unusual changes, risks. Then, when useful, 1–3 concrete suggested actions. Skip either when there is nothing real to say.
- End every answer about data with 2–3 natural follow-up questions the user is likely to ask next, in their language, as:
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
  create_invoice: 'Preparing the invoice',
  record_payment: 'Preparing the payment',
  cancel_invoice: 'Preparing the cancellation',
  save_customer: 'Preparing the customer',
  save_product: 'Preparing the product',
  receive_goods: 'Preparing the goods receipt',
  set_stock: 'Preparing the stock correction',
  update_settings: 'Preparing the settings change',
};

function contextLine(db, user, page) {
  const s = getSettings(db);
  const today = storeToday(db);
  const weekday = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const parts = [
    `Today is ${weekday} ${today} (store time zone ${s.timezone}).`,
    `Store: ${s.store_name}. Currency: ${s.currency}.`,
    `User: ${user.name} (${user.role === 'admin' ? 'owner/admin' : 'cashier: no cost or profit data'}).`,
    `App mode: ${s.ui_mode === 'advanced' ? 'advanced' : 'simple'}.`,
  ];
  if (page) parts.push(`They are looking at the app page ${String(page).slice(0, 200)}.`);
  return `<context>${parts.join(' ')}</context>`;
}

/**
 * Runs one question. `emit(event, data)` streams to the panel:
 *   status {label} · text {delta} · table {id, title, columns, rows} · action {id, type, status, card} · error {message}
 * `updates` are notes about cards the user confirmed or dismissed since the last question.
 * `proposeAction(type, input, card)` stores a proposed action and returns its id.
 * Returns { messages, answer, tables, actions } where messages is the new model-facing history.
 */
export async function runTurn({ client, db, user, history, question, page, updates = [], query, nextTableId, proposeAction, emit, signal }) {
  const tools = toolsFor(user);
  const actions = actionsFor(user);
  const byName = new Map(tools.map((t) => [t.def.name, t]));
  const actionByName = new Map(actions.map((a) => [a.def.name, a]));
  const toolDefs = [...tools, ...actions].map((t) => ({ ...t.def, eager_input_streaming: true }));
  const settings = getSettings(db);
  const ctx = { admin: user.role === 'admin', tz: settings.timezone, query, settings, user };

  const messages = trimHistory(history).map((m) => (m.role === 'assistant' && Array.isArray(m.content) ? { ...m, content: forHistory(m.content) } : m));
  const content = [{ type: 'text', text: contextLine(db, user, page) }];
  if (updates.length) content.push({ type: 'text', text: `<action_updates>\n${updates.join('\n')}\n</action_updates>` });
  content.push({ type: 'text', text: question });
  messages.push({ role: 'user', content });

  let answer = '';
  const tables = {};
  const proposed = [];
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
        const action = actionByName.get(call.name);
        try {
          if (!tool && !action) throw new ToolInputError(`Unknown tool ${call.name}`);
          if (typeof call.input !== 'object' || call.input === null || Array.isArray(call.input)) {
            throw new ToolInputError('INVALID_JSON: tool input must be an object');
          }
          if (action) {
            const card = publicCard(action.prepare(db, call.input, {}, ctx));
            const id = proposeAction(call.name, call.input, card);
            proposed.push(id);
            emit('action', { id, type: call.name, status: 'pending', card });
            return {
              type: 'tool_result',
              tool_use_id: call.id,
              content: JSON.stringify({ status: 'waiting_for_user', action_id: id, card: card.title, warnings: card.warnings, note: 'Shown to the user as a card with a confirm button. Nothing has changed yet.' }),
            };
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
  return { messages, answer: answer.trim(), tables, actions: proposed };
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
