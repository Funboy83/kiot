import { hashPassword } from './auth.js';

/** Creates the first admin account on an empty database. */
export function ensureAdmin(db) {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare("INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, 'Admin', ?, 'admin', ?)")
    .run(username, hashPassword(password), Date.now());
  console.log(`Created admin user "${username}"${process.env.ADMIN_PASSWORD ? '' : ' with password "admin123" (change it in Settings)'}`);
}
