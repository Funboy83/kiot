import { Hono } from 'hono';
import { login, logout, sessionUser } from './auth.js';
import { HttpError } from './lib.js';
import products from './routes/products.js';
import customers from './routes/customers.js';
import invoices from './routes/invoices.js';
import inventory from './routes/inventory.js';
import reports from './routes/reports.js';
import admin from './routes/admin.js';
import search from './routes/search.js';

export function createApp(db) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof SyntaxError) return c.json({ error: 'Invalid JSON body' }, 400);
    console.error(err);
    return c.json({ error: 'Something went wrong' }, 500);
  });

  app.post('/api/auth/login', async (c) => {
    const { username, password } = await c.req.json();
    return c.json(login(c, db, username, password));
  });

  app.use('/api/*', async (c, next) => {
    // Mutations must be JSON: browsers cannot send that cross-site without CORS, which blocks CSRF.
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'DELETE') {
      if (!String(c.req.header('content-type')).startsWith('application/json')) {
        throw new HttpError(415, 'Expected a JSON body');
      }
    }
    if (c.req.method === 'DELETE' && !c.req.header('x-requested-with')) {
      throw new HttpError(403, 'Missing request header');
    }
    c.set('user', sessionUser(c, db));
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.post('/api/auth/logout', (c) => {
    logout(c, db);
    return c.json({ ok: true });
  });
  app.get('/api/auth/me', (c) => c.json(c.get('user')));

  for (const mount of [products, customers, invoices, inventory, reports, admin, search]) mount(app, db);

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  return app;
}
