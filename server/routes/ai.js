import Anthropic from '@anthropic-ai/sdk';
import { streamSSE } from 'hono/streaming';
import { HttpError, bad, notFound } from '../lib.js';
import { runTurn, aiConfigured, defaultClient, MODEL } from '../ai/assistant.js';
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

  app.get('/api/ai/chats/:id', (c) => {
    const chat = own(c);
    return c.json({ id: chat.id, title: chat.title, items: JSON.parse(chat.display) });
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
    if (question.length > 4000) throw bad('That question is too long');
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
      try {
        const result = await runTurn({
          client: getClient(),
          db,
          user,
          history: JSON.parse(chat.messages),
          question,
          page: typeof body.page === 'string' ? body.page : null,
          query,
          nextTableId,
          emit,
          signal: ctl.signal,
        });
        display.push({ role: 'assistant', text: result.answer, tables: result.tables });
        db.prepare('UPDATE ai_chats SET messages = ?, display = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(result.messages),
          JSON.stringify(display),
          Date.now(),
          chat.id
        );
        emit('done', { index: display.length - 1 });
      } catch (err) {
        if (!ctl.signal.aborted) {
          if (!(err instanceof Anthropic.APIError)) console.error('assistant failed', err);
          emit('error', { message: friendlyError(err) });
        }
        // A brand-new conversation that never got an answer is not worth keeping.
        if (display.length === 1) db.prepare('DELETE FROM ai_chats WHERE id = ?').run(chat.id);
      } finally {
        running.delete(user.id);
        await chain;
      }
    });
  });
}
