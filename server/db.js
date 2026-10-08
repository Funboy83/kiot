import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

const DEFAULT_SETTINGS = {
  store_name: 'My Store',
  timezone: 'America/Los_Angeles',
  currency: 'USD',
  ui_mode: 'simple',
};

export function openDb(file = process.env.DB_FILE || 'data/store.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -32000'); // 32 MB page cache
  db.pragma('temp_store = MEMORY');
  // Databases made before a column existed get it added (CREATE TABLE IF NOT EXISTS leaves them alone).
  const hasTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ai_chats'").get();
  if (hasTable && !db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('ai_chats', 'notes')) {
    db.exec("ALTER TABLE ai_chats ADD COLUMN notes TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec(schema);
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  return db;
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
