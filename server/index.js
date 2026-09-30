import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { compress } from 'hono/compress';
import { readFileSync, existsSync } from 'node:fs';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureAdmin } from './bootstrap.js';

const db = openDb();
ensureAdmin(db);
const app = createApp(db);

const dist = 'dist';
if (existsSync(dist)) {
  const indexHtml = readFileSync(`${dist}/index.html`, 'utf8');
  app.use('*', compress());
  // Hashed build assets never change, so browsers can keep them for a year.
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('/*', serveStatic({ root: dist }));
  app.get('*', (c) => c.html(indexHtml, 200, { 'Cache-Control': 'no-cache' }));
}

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => console.log(`Store running on http://localhost:${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}
