import { hashPassword, requireAdmin, publicUser } from '../auth.js';
import { getSettings } from '../db.js';
import { bad, notFound, str } from '../lib.js';

export default function admin(app, db) {
  app.get('/api/settings', (c) => c.json(getSettings(db)));

  app.put('/api/settings', async (c) => {
    requireAdmin(c);
    const body = await c.req.json();
    const next = {
      store_name: str(body.store_name, 'Store name', { max: 100 }),
      timezone: str(body.timezone, 'Timezone', { max: 60 }),
      currency: str(body.currency, 'Currency', { max: 3 }).toUpperCase(),
    };
    try {
      new Intl.DateTimeFormat('en', { timeZone: next.timezone });
      new Intl.NumberFormat('en', { style: 'currency', currency: next.currency });
    } catch {
      throw bad('Unknown timezone or currency code');
    }
    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    db.transaction(() => Object.entries(next).forEach(([k, v]) => set.run(k, v)))();
    return c.json(next);
  });

  app.get('/api/users', (c) => {
    requireAdmin(c);
    return c.json(db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY id').all());
  });

  app.post('/api/users', async (c) => {
    requireAdmin(c);
    const body = await c.req.json();
    const password = str(body.password, 'Password', { max: 200 });
    if (password.length < 6) throw bad('Password must be at least 6 characters');
    const username = str(body.username, 'Username', { max: 50 }).toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('Username is taken');
    const user = db
      .prepare('INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
      .get(username, str(body.name, 'Name', { max: 100 }), hashPassword(password), body.role === 'admin' ? 'admin' : 'staff', Date.now());
    return c.json(publicUser(user), 201);
  });

  app.put('/api/users/:id', async (c) => {
    requireAdmin(c);
    const body = await c.req.json();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(c.req.param('id'));
    if (!user) throw notFound('User not found');
    const role = body.role === 'admin' ? 'admin' : 'staff';
    const active = body.active === false ? 0 : 1;
    if (user.id === c.get('user').id && (role !== 'admin' || !active)) throw bad('You cannot demote or disable yourself');
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(str(body.name, 'Name', { max: 100 }), role, active, user.id);
    if (body.password) {
      if (String(body.password).length < 6) throw bad('Password must be at least 6 characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    }
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return c.json({ ok: true });
  });
}
