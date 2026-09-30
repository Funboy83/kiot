import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HttpError } from './lib.js';

const SESSION_DAYS = 30;
const COOKIE = 'sid';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

// Small in-memory brute-force guard: 10 failed logins per username per 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60 * 1000;

function tooManyFailures(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW) return false;
  return f.count >= 10;
}

function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

export function login(c, db, username, password) {
  const key = String(username || '').toLowerCase();
  if (tooManyFailures(key)) throw new HttpError(429, 'Too many attempts, try again in a few minutes');
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(key);
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    recordFailure(key);
    throw new HttpError(401, 'Wrong username or password');
  }
  failures.delete(key);
  const token = randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
  return publicUser(user);
}

export function logout(c, db) {
  const token = getCookie(c, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  deleteCookie(c, COOKIE, { path: '/' });
}

export function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role };
}

/** Resolves the signed-in user, or throws 401. */
export function sessionUser(c, db) {
  const token = getCookie(c, COOKIE);
  if (!token) throw new HttpError(401, 'Please sign in');
  const user = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`
    )
    .get(token, Date.now());
  if (!user) throw new HttpError(401, 'Please sign in');
  return publicUser(user);
}

export function requireAdmin(c) {
  if (c.get('user')?.role !== 'admin') throw new HttpError(403, 'Only an admin can do this');
}
