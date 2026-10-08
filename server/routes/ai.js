import Anthropic from '@anthropic-ai/sdk';
import { streamSSE } from 'hono/streaming';
import { HttpError, bad, notFound } from '../lib.js';
import { runTurn, aiConfigured, defaultClient, MODEL } from '../ai/assistant.js';
import { ACTIONS, publicCard } from '../ai/actions.js';
import { ToolInputError } from '../ai/tools.js';
import { getSettings } from '../db.js';
import { createQueryRunner } from '../ai/readonly-sql.js';

const SETUP_HELP =
  'The assistant is not set up yet. Set the ANTHROPIC_API_KEY environment variable on the server (get a key at https://console.anthropic.com) and restart it.';

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return 'The AI key on the server was not accepted. Check ANTHROPIC_API_KEY.';
  }
  if (err instanceof Anthropic.RateLimitError) return 'The assistant is busy right now. Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the AI service. Check the server’s internet connection.';
  if (err instanceof Anthropic.APIError && (err.status === 529 || err.status >= 500)) return 'The AI service is overloaded. Try again shortly.';
  if (err instanceof Anthropic.APIError) return `The AI service refused the request (${err.status}).`;
  return 'Something went wrong while answering.';
}

export default function ai(app, db, opts = {}) {
  const getClient = opts.aiClient ? () => opts.aiClient : defaultClient;
  const enabled = () => Boolean(opts.aiClient) || aiConfigured();
  const query = createQueryRunner(db);
  const running = new Set();

  const own = (c) => {
    const chat = db.prepare('SELECT * FROM ai_chats WHERE id = ? AND user_id = ?').get(c.req.param('id'), c.get('user').id);
    if (!chat) throw notFound('Conversation not found');
    return chat;
  };

  app.get('/api/ai/status', (c) => c.json({ enabled: enabled(), model: enabled() ? MODEL : null, help: enabled() ? null : SETUP_HELP }));

  app.get('/api/ai/chats', (c) => {
    const rows = db
      .prepare('SELECT id, title, updated_at FROM ai_chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50')
      .all(c.get('user').id);
    return c.json({ rows });
  });

  const actionView = (a) => ({ id: a.id, type: a.type, status: a.status === 'running' ? 'pending' : a.status, card: JSON.parse(a.card), result: a.result ? JSON.parse(a.result) : null });

  app.get('/api/ai/chats/:id', (c) => {
    const chat = own(c);
    const actions = Object.fromEntries(
      db.prepare('SELECT * FROM ai_actions WHERE chat_id = ?').all(chat.id).map((a) => [a.id, actionView(a)])
    );
    return c.json({ id: chat.id, title: chat.title, items: JSON.parse(chat.display), actions });
  });

  // ---- action cards: nothing proposed by the assistant runs until the user confirms it here ----

  const ownAction = (c) => {
    const a = db.prepare('SELECT * FROM ai_actions WHERE id = ? AND user_id = ?').get(c.req.param('id'), c.get('user').id);
    if (!a) throw notFound('That card no longer exists');
    return a;
  };
  const addNote = (chatId, note) => {
    db.prepare("UPDATE ai_chats SET notes = json_insert(notes, '$[#]', ?), updated_at = ? WHERE id = ?").run(note, Date.now(), chatId);
  };

  app.post('/api/ai/actions/:id/confirm', async (c) => {
    const a = ownAction(c);
    const user = c.get('user');
    const def = ACTIONS.find((x) => x.def.name === a.type);
    if (!def || (def.admin && user.role !== 'admin')) throw new HttpError(403, 'You are not allowed to do this');
    const edits = (await c.req.json().catch(() => ({}))) || {};
    // Claim the card first, so a double click cannot run it twice.
    const claimed = db.prepare("UPDATE ai_actions SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), a.id);
    if (!claimed.changes) throw bad(a.status === 'done' ? 'This was already done' : a.status === 'cancelled' ? 'This card was dismissed' : 'This card is already being processed');
    // Runs through the app's own API as this user, so the same checks as the screens apply.
    const call = async (method, path, body) => {
      const res = await app.request(path, {
        method,
        headers: { cookie: c.req.header('cookie') || '', 'content-type': 'application/json', 'x-requested-with': 'assistant' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new HttpError(res.status, data.error || `Request failed (${res.status})`);
      return data;
    };
    try {
      const prep = def.prepare(db, JSON.parse(a.input), {
        paid: edits.paid,
        method: edits.method,
        serials: edits.serials && typeof edits.serials === 'object' ? edits.serials : undefined,
      }, { settings: getSettings(db), user, admin: user.role === 'admin' });
      const result = await def.execute(call, prep);
      const card = publicCard(prep);
      db.prepare("UPDATE ai_actions SET status = 'done', card = ?, result = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(card), JSON.stringify(result), Date.now(), a.id);
      addNote(a.chat_id, `Card ${a.id} (${a.type}) was confirmed and done: ${result.message}.`);
      return c.json(actionView({ ...a, status: 'done', card: JSON.stringify(card), result: JSON.stringify(result) }));
    } catch (err) {
      db.prepare("UPDATE ai_actions SET status = 'pending', updated_at = ? WHERE id = ?").run(Date.now(), a.id);
      if (err instanceof ToolInputError) throw bad(err.message);
      throw err;
    }
  });

  app.post('/api/ai/actions/:id/cancel', (c) => {
    const a = ownAction(c);
    const r = db.prepare("UPDATE ai_actions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), a.id);
    if (!r.changes) throw bad('This card can no longer be dismissed');
    addNote(a.chat_id, `Card ${a.id} (${a.type}) was dismissed by the user; nothing was changed.`);
    return c.json(actionView({ ...a, status: 'cancelled' }));
  });

  app.delete('/api/ai/chats/:id', (c) => {
    own(c);
    db.prepare('DELETE FROM ai_chats WHERE id = ?').run(c.req.param('id'));
    return c.json({ ok: true });
  });

  // Thumbs up/down on one answer: value 1, -1 or 0 (clear).
  app.post('/api/ai/chats/:id/feedback', async (c) => {
    const chat = own(c);
    const { index, value } = await c.req.json();
    const items = JSON.parse(chat.display);
    if (!Number.isInteger(index) || items[index]?.role !== 'assistant') throw bad('No such answer');
    if (![1, -1, 0].includes(value)) throw bad('Feedback must be 1, -1 or 0');
    items[index].feedback = value || undefined;
    db.prepare('UPDATE ai_chats SET display = ? WHERE id = ?').run(JSON.stringify(items), chat.id);
    return c.json({ ok: true });
  });

  app.post('/api/ai/chat', async (c) => {
    if (!enabled()) throw new HttpError(503, SETUP_HELP);
    const user = c.get('user');
    const body = await c.req.json();
    const question = String(body.message ?? '').trim();
    if (!question) throw bad('Type a question');
    if (question.length > 8000) throw bad('That message is too long');
    if (running.has(user.id)) throw new HttpError(429, 'Wait for the current answer to finish');

    let chat = null;
    if (body.chat_id != null) {
      chat = db.prepare('SELECT * FROM ai_chats WHERE id = ? AND user_id = ?').get(body.chat_id, user.id);
      if (!chat) throw notFound('Conversation not found');
    } else {
      const now = Date.now();
      const title = question.replace(/\s+/g, ' ').slice(0, 80);
      chat = db
        .prepare('INSERT INTO ai_chats (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING *')
        .get(user.id, title, now, now);
    }
    const display = JSON.parse(chat.display);
    let tableCount = display.reduce((n, it) => n + Object.keys(it.tables || {}).length, 0);
    const nextTableId = () => `t${++tableCount}`;

    running.add(user.id);
    c.header('X-Accel-Buffering', 'no'); // keep nginx and similar proxies from holding the stream
    return streamSSE(c, async (stream) => {
      const ctl = new AbortController();
      stream.onAbort(() => ctl.abort());
      let chain = Promise.resolve();
      const emit = (event, data) => {
        chain = chain.then(() => (ctl.signal.aborted ? null : stream.writeSSE({ event, data: JSON.stringify(data) }))).catch(() => {});
      };
      emit('chat', { id: chat.id, title: chat.title });
      display.push({ role: 'user', text: question });
      const updates = JSON.parse(db.prepare('SELECT notes FROM ai_chats WHERE id = ?').get(chat.id).notes);
      const proposed = [];
      const proposeAction = (type, input, card) => {
        const now = Date.now();
        const { id } = db
          .prepare('INSERT INTO ai_actions (chat_id, user_id, type, input, card, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
          .get(chat.id, user.id, type, JSON.stringify(input), JSON.stringify(card), now, now);
        proposed.push(id);
        return id;
      };
      try {
        const result = await runTurn({
          client: getClient(),
          db,
          user,
          history: JSON.parse(chat.messages),
          question,
          page: typeof body.page === 'string' ? body.page : null,
          updates,
          query,
          nextTableId,
          proposeAction,
          emit,
          signal: ctl.signal,
        });
        display.push({ role: 'assistant', text: result.answer, tables: result.tables, ...(proposed.length ? { actions: proposed } : {}) });
        db.transaction(() => {
          // Notes the model has now seen are dropped; any that arrived meanwhile stay for next time.
          const notes = JSON.parse(db.prepare('SELECT notes FROM ai_chats WHERE id = ?').get(chat.id).notes).slice(updates.length);
          db.prepare('UPDATE ai_chats SET messages = ?, display = ?, notes = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(result.messages),
            JSON.stringify(display),
            JSON.stringify(notes),
            Date.now(),
            chat.id
          );
        })();
        emit('done', { index: display.length - 1 });
      } catch (err) {
        if (!ctl.signal.aborted) {
          if (!(err instanceof Anthropic.APIError)) console.error('assistant failed', err);
          emit('error', { message: friendlyError(err) });
        }
        if (proposed.length) {
          // Cards already shown stay usable even though the answer broke off.
          display.push({ role: 'assistant', text: '', error: friendlyError(err), actions: proposed });
          db.prepare('UPDATE ai_chats SET display = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(display), Date.now(), chat.id);
        } else if (display.length === 1) {
          // A brand-new conversation that never got an answer is not worth keeping.
          db.prepare('DELETE FROM ai_chats WHERE id = ?').run(chat.id);
        }
      } finally {
        running.delete(user.id);
        await chain;
      }
    });
  });
}
