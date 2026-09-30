// Child process for the assistant's SQL tool: its own read-only connection to the store database.
// A separate process (not a worker thread) so a runaway query can be killed outright.
import Database from 'better-sqlite3';
import { runChecked } from './readonly-sql.js';

const db = new Database(process.env.KIOT_QUERY_DB, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 2000');
db.pragma('query_only = ON');

process.on('message', ({ id, sql }) => {
  try {
    process.send({ id, result: runChecked(db, sql) });
  } catch (e) {
    process.send({ id, error: e.message });
  }
});
process.on('disconnect', () => process.exit(0));
