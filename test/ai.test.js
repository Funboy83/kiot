import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { ensureAdmin } from '../server/bootstrap.js';
import { checkQuery } from '../server/ai/readonly-sql.js';

// Scripted stand-in for the Anthropic client: each call to beta.messages.stream() plays the
// next message from `script`, streaming its text and tool calls the way the SDK does.
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const message = script.shift();
          if (!message) throw new Error('No scripted reply left');
          return {
            async *[Symbol.asyncIterator]() {
              for (const [index, block] of message.content.entries()) {
                if (block.type === 'text') {
                  yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
                  for (const piece of block.text.match(/[\s\S]{1,8}/g)) yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } };
                } else {
                  yield { type: 'content_block_start', index, content_block: { ...block, ...(block.type === 'tool_use' ? { input: {} } : {}) } };
                }
                yield { type: 'content_block_stop', index };
              }
            },
            finalMessage: async () => ({ role: 'assistant', ...message }),
          };
        },
      },
    },
  };
}

const toolCall = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }] });

let db, app, client, cookie;

async function api(method, path, body, raw = false) {
  const headers = { cookie: cookie || '', 'x-requested-with': 'fetch' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: raw ? await res.text() : await res.json() };
}

function events(sse) {
  return sse
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => ({
      event: chunk.match(/^event: (.*)$/m)?.[1],
      data: JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? 'null'),
    }));
}

before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db);
  client = fakeClient([]);
  app = createApp(db, { aiClient: client });
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const product = (await api('POST', '/api/products', { name: 'USB-C Cable', price: 1900, cost: 700, stock: 50 })).body.id;
  const customer = (await api('POST', '/api/customers', { name: 'Harbor Mobile LLC', phone: '5551234' })).body.id;
  const sale = await api('POST', '/api/invoices', { customer_id: customer, items: [{ product_id: product, qty: 10 }], paid: 5000 });
  assert.equal(sale.status, 201);
});

test('says how to set it up when there is no API key', async () => {
  const bare = createApp(db);
  const login = await bare.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const c = login.headers.get('set-cookie').split(';')[0];
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return; // configured machine
  const status = await (await bare.request('/api/ai/status', { headers: { cookie: c } })).json();
  assert.equal(status.enabled, false);
  assert.match(status.help, /ANTHROPIC_API_KEY/);
  const res = await bare.request('/api/ai/chat', { method: 'POST', headers: { cookie: c, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
  assert.equal(res.status, 503);
});

let chatId;

test('answers with a tool call, streams the table and saves the conversation', async () => {
  client.calls.length = 0;
  let toolResult;
  client.beta.messages.stream = ((orig) =>
    function (params) {
      const last = params.messages.at(-1);
      if (last.content[0].type === 'tool_result') toolResult = JSON.parse(last.content[0].content);
      return orig.call(this, params);
    })(fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, toolCall('tu1', 'customer_debts', { sort: 'amount' })] },
    reply('Có **1 khách** đang nợ.\n\n```table\n{"ref":"t1","columns":{"name":"Tên khách hàng","debt":"Số nợ"}}\n```\n\n```followups\n["Ai nợ lâu nhất?"]\n```'),
  ]).beta.messages.stream);

  const res = await api('POST', '/api/ai/chat', { message: 'ai con dang no', page: '/customers' }, true);
  assert.equal(res.status, 200);
  const ev = events(res.body);
  chatId = ev.find((e) => e.event === 'chat').data.id;
  assert.deepEqual(ev.find((e) => e.event === 'status').data, { label: 'Checking customer debts' });
  const table = ev.find((e) => e.event === 'table').data;
  assert.equal(table.id, 't1');
  assert.equal(table.rows[0].name, 'Harbor Mobile LLC');
  assert.equal(table.rows[0].debt, 140); // $190 sale, $50 paid
  assert.equal(toolResult.customers_owing, 1);
  assert.equal(toolResult.table_id, 't1');
  const text = ev.filter((e) => e.event === 'text').map((e) => e.data.delta).join('');
  assert.match(text, /^Có \*\*1 khách\*\*/);
  assert.ok(ev.some((e) => e.event === 'done'));

  const saved = (await api('GET', `/api/ai/chats/${chatId}`)).body;
  assert.equal(saved.items.length, 2);
  assert.equal(saved.items[1].tables.t1.rows.length, 1);
  assert.equal((await api('GET', '/api/ai/chats')).body.rows[0].id, chatId);
});

test('follow-up question sends earlier turns without their reasoning blocks', async () => {
  const fake = fakeClient([reply('Harbor Mobile LLC, since today.')]);
  client.beta.messages.stream = fake.beta.messages.stream;
  const res = await api('POST', '/api/ai/chat', { message: 'Ai nợ lâu nhất?', chat_id: chatId }, true);
  assert.equal(res.status, 200);
  const sent = fake.calls[0];
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.tools.every((t) => t.eager_input_streaming), true);
  const earlier = sent.messages.slice(0, -1);
  assert.ok(earlier.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use')));
  assert.ok(!earlier.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'thinking')));
  const q = sent.messages.at(-1).content;
  assert.match(q[0].text, /^<context>Today is \w+ \d{4}-\d{2}-\d{2}/);
  assert.equal(q[1].text, 'Ai nợ lâu nhất?');
  const tables = events(res.body).filter((e) => e.event === 'table');
  assert.equal(tables.length, 0);
});

test('bad tool input and unknown tools come back to the model as errors', async () => {
  const fake = fakeClient([
    { stop_reason: 'tool_use', content: [toolCall('a', 'sales_summary', { from: 'last week' }), toolCall('b', 'drop_tables', {})] },
    reply('Sorry.'),
  ]);
  client.beta.messages.stream = fake.beta.messages.stream;
  const res = await api('POST', '/api/ai/chat', { message: 'sales?' }, true);
  assert.equal(res.status, 200);
  const results = fake.calls[1].messages.at(-1).content;
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.is_error));
  assert.match(results[0].content, /YYYY-MM-DD/);
});

test('SQL tool reads data but never private tables or writes', () => {
  assert.doesNotThrow(() => checkQuery(db, "SELECT name, debt / 100.0 AS owes FROM customers WHERE debt > 0"));
  for (const sql of [
    'SELECT * FROM users',
    'SELECT token FROM sessions',
    'WITH u AS (SELECT password_hash FROM users) SELECT * FROM u',
    'SELECT * FROM customers WHERE id IN (SELECT user_id FROM ai_chats)',
    'DELETE FROM customers',
    "UPDATE products SET price = 0",
    'SELECT 1; DROP TABLE customers',
    'PRAGMA writable_schema = 1',
    "ATTACH DATABASE 'x.db' AS x",
  ]) {
    assert.throws(() => checkQuery(db, sql), undefined, sql);
  }
});

test('a pasted order becomes an invoice card that only runs when the user confirms it', async () => {
  const phone = (await api('POST', '/api/products', { name: 'iPhone 17', price: 99900, cost: 80000, track_serial: true })).body.id;
  assert.equal((await api('POST', '/api/receipts', { items: [{ product_id: phone, qty: 2, unit_cost: 80000, serials: ['IMEI-A', 'IMEI-B'] }] })).status, 201);
  const cable = db.prepare("SELECT id FROM products WHERE name = 'USB-C Cable'").get().id;
  const invoicesBefore = db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;

  const fake = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [toolCall('c1', 'create_invoice', { new_customer: { name: 'Anh Nam', phone: '0909 123 456' }, items: [{ product_id: phone, qty: 1 }, { product_id: cable, qty: 2 }], paid: 0, method: 'transfer' })],
    },
    reply('Hóa đơn đã soạn xong, kiểm tra rồi bấm **Create invoice**.'),
  ]);
  client.beta.messages.stream = fake.beta.messages.stream;
  const res = await api('POST', '/api/ai/chat', { message: 'anh Nam 0909123456 lấy 1 ip17 + 2 cáp, ck tuần sau' }, true);
  const ev = events(res.body);
  const action = ev.find((e) => e.event === 'action').data;
  assert.equal(action.status, 'pending');
  assert.equal(action.card.customer.is_new, true);
  assert.deepEqual(action.card.lines[0].serials, ['IMEI-A']); // oldest unit picked
  assert.deepEqual(action.card.lines[0].serial_options, ['IMEI-A', 'IMEI-B']);
  assert.equal(action.card.totals.total, 99900 + 3800);
  assert.equal(action.card.totals.debt_after, 99900 + 3800);
  assert.ok(!Object.keys(action.card).some((k) => k.startsWith('_')));
  const toolResult = JSON.parse(fake.calls[1].messages.at(-1).content[0].content);
  assert.equal(toolResult.status, 'waiting_for_user');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, invoicesBefore); // nothing written yet

  const chat = ev.find((e) => e.event === 'chat').data.id;
  const saved = (await api('GET', `/api/ai/chats/${chat}`)).body;
  assert.equal(saved.actions[action.id].status, 'pending');
  assert.deepEqual(saved.items[1].actions, [action.id]);

  // The user switches the unit, pays part in cash, and confirms.
  const done = await api('POST', `/api/ai/actions/${action.id}/confirm`, { paid: 50000, method: 'cash', serials: { 0: ['IMEI-B'] } });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'done');
  assert.match(done.body.result.message, /^Invoice HD\d+ saved, new customer KH\d+ added$/);
  const inv = db.prepare('SELECT * FROM invoices WHERE code = ?').get(done.body.result.code);
  assert.equal(inv.paid, 50000);
  assert.equal(db.prepare('SELECT status FROM serials WHERE serial = ?').get('IMEI-B').status, 'sold');
  assert.equal(db.prepare('SELECT status FROM serials WHERE serial = ?').get('IMEI-A').status, 'in_stock');
  assert.equal(db.prepare('SELECT debt FROM customers WHERE phone = ?').get('0909 123 456').debt, 99900 + 3800 - 50000);
  assert.equal((await api('POST', `/api/ai/actions/${action.id}/confirm`, {})).status, 400); // no double run

  // A dismissed card changes nothing, and the next question tells the model what happened.
  const next = fakeClient([{ stop_reason: 'tool_use', content: [toolCall('x', 'cancel_invoice', { code: inv.code })] }, reply('Bấm **Cancel it** để hủy.')]);
  client.beta.messages.stream = next.beta.messages.stream;
  const cancelCard = events((await api('POST', '/api/ai/chat', { message: 'hủy hóa đơn đó', chat_id: chat }, true)).body).find((e) => e.event === 'action').data;
  assert.match(next.calls[0].messages.at(-1).content[1].text, /<action_updates>[\s\S]*confirmed and done: Invoice HD/);
  assert.equal((await api('POST', `/api/ai/actions/${cancelCard.id}/cancel`, {})).status, 200);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id).status, 'completed');
  assert.equal((await api('POST', `/api/ai/actions/${cancelCard.id}/confirm`, {})).status, 400);
  const after = fakeClient([reply('Ok.')]);
  client.beta.messages.stream = after.beta.messages.stream;
  await api('POST', '/api/ai/chat', { message: 'ok', chat_id: chat }, true);
  const q = after.calls[0].messages.at(-1).content;
  assert.match(q[1].text, /dismissed by the user/);
  assert.doesNotMatch(q[1].text, /confirmed and done/); // notes are delivered once
});

test('bad action input goes back to the model, and the app mode is a setting', async () => {
  const fake = fakeClient([{ stop_reason: 'tool_use', content: [toolCall('b', 'create_invoice', { items: [{ product_id: 99999, qty: 1 }] })] }, reply('Không tìm thấy.')]);
  client.beta.messages.stream = fake.beta.messages.stream;
  const ev = events((await api('POST', '/api/ai/chat', { message: 'bán 1 cái' }, true)).body);
  assert.ok(!ev.some((e) => e.event === 'action'));
  const r = fake.calls[1].messages.at(-1).content[0];
  assert.equal(r.is_error, true);
  assert.match(r.content, /find_products/);

  assert.equal((await api('GET', '/api/settings')).body.ui_mode, 'simple');
  assert.equal((await api('PUT', '/api/settings', { ui_mode: 'advanced' })).status, 200);
  const s = (await api('GET', '/api/settings')).body;
  assert.equal(s.ui_mode, 'advanced');
  assert.ok(s.store_name); // other settings kept
});

test('run_sql is admin-only and feedback is saved; other users cannot see the chat', async () => {
  const fake = fakeClient([
    { stop_reason: 'tool_use', content: [toolCall('s', 'run_sql', { sql: 'SELECT COUNT(*) AS n FROM invoices', title: 'Count' })] },
    reply('1 invoice.'),
  ]);
  client.beta.messages.stream = fake.beta.messages.stream;
  const res = await api('POST', '/api/ai/chat', { message: 'how many invoices', chat_id: chatId }, true);
  const table = events(res.body).find((e) => e.event === 'table').data;
  assert.equal(table.id, 't2'); // ids keep counting within a conversation
  assert.deepEqual(table.rows, [{ n: db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n }]);
  assert.ok(fake.calls[0].tools.some((t) => t.name === 'run_sql'));

  assert.equal((await api('POST', `/api/ai/chats/${chatId}/feedback`, { index: 1, value: 1 })).status, 200);
  assert.equal((await api('GET', `/api/ai/chats/${chatId}`)).body.items[1].feedback, 1);
  assert.equal((await api('POST', `/api/ai/chats/${chatId}/feedback`, { index: 0, value: 1 })).status, 400);

  await api('POST', '/api/users', { username: 'cashier', name: 'Cashier', password: 'secret1', role: 'staff' });
  await api('POST', '/api/auth/logout', {});
  await api('POST', '/api/auth/login', { username: 'cashier', password: 'secret1' });
  assert.equal((await api('GET', `/api/ai/chats/${chatId}`)).status, 404);
  const staff = fakeClient([reply('ok')]);
  client.beta.messages.stream = staff.beta.messages.stream;
  await api('POST', '/api/ai/chat', { message: 'hi' }, true);
  const names = staff.calls[0].tools.map((t) => t.name);
  assert.ok(!names.includes('run_sql'));
  assert.ok(names.includes('create_invoice') && !names.includes('update_settings'));
  assert.match(staff.calls[0].messages.at(-1).content[0].text, /cashier: no cost or profit data/);
});
