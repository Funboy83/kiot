// Read-only SQL for the assistant. Three layers keep it from changing or leaking anything:
//  1. only a single SELECT/WITH statement that SQLite itself reports as read-only is accepted;
//  2. the compiled program (EXPLAIN) may not open any page of the private tables (users, sessions, chats);
//  3. on a file database the query runs in a child process on a read-only connection with a time limit,
//     so a runaway query can neither write nor stall the POS, and is killed when it takes too long.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PRIVATE_TABLES = ['users', 'sessions', 'ai_chats'];
export const MAX_ROWS = 2000;
const TIMEOUT_MS = 5000;

export class QueryError extends Error {}

/** Throws QueryError when `sql` is not a safe read-only query for this connection. */
export function checkQuery(db, sql) {
  const text = String(sql || '').trim().replace(/;\s*$/, '');
  if (!text) throw new QueryError('Empty query');
  const bare = text.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*/g, '').trimStart();
  if (!/^(select|with)\b/i.test(bare)) throw new QueryError('Only SELECT queries are allowed');
  let stmt;
  try {
    stmt = db.prepare(text); // throws on more than one statement
  } catch (e) {
    throw new QueryError(e.message);
  }
  if (!stmt.readonly || !stmt.reader) throw new QueryError('Only read-only SELECT queries are allowed');
  const roots = new Set(
    db
      .prepare(`SELECT rootpage FROM sqlite_schema WHERE tbl_name IN (${PRIVATE_TABLES.map(() => '?').join(',')}) AND rootpage > 0`)
      .pluck()
      .all(...PRIVATE_TABLES)
  );
  for (const op of db.prepare('EXPLAIN ' + text).all()) {
    if ((op.opcode === 'OpenRead' || op.opcode === 'ReopenIdx') && op.p3 === 0 && roots.has(op.p2)) {
      throw new QueryError('That table is private and cannot be queried');
    }
    if (op.opcode === 'OpenWrite') throw new QueryError('Only read-only SELECT queries are allowed');
  }
  return { text, stmt };
}

/** Runs a checked query in this thread. Returns { columns, rows, truncated }. */
export function runChecked(db, sql, maxRows = MAX_ROWS) {
  const { stmt } = checkQuery(db, sql);
  const columns = stmt.columns().map((c) => c.name);
  const rows = [];
  let truncated = false;
  for (const row of stmt.iterate()) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    rows.push(row);
  }
  return { columns, rows, truncated };
}

/**
 * Returns an async `query(sql)` for the given database. File databases get a child process with
 * its own read-only connection and a hard time limit; in-memory ones (tests) run inline.
 */
export function createQueryRunner(db) {
  if (db.memory) return async (sql) => runChecked(db, sql);

  let child = null;
  let seq = 0;
  const pending = new Map();
  const failAll = (proc, msg) => {
    for (const [id, p] of pending) {
      if (p.proc !== proc) continue;
      clearTimeout(p.timer);
      p.reject(new QueryError(msg));
      pending.delete(id);
    }
  };
  const spawn = () => {
    const proc = fork(fileURLToPath(new URL('./readonly-child.js', import.meta.url)), [], {
      env: { ...process.env, KIOT_QUERY_DB: db.name },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    proc.on('message', ({ id, result, error }) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (error) p.reject(new QueryError(error));
      else p.resolve(result);
    });
    proc.on('exit', () => {
      if (child === proc) child = null;
      failAll(proc, 'The query process stopped');
    });
    proc.unref();
    proc.channel?.unref();
    return proc;
  };
  process.on('exit', () => child?.kill('SIGKILL'));

  return (sql) =>
    new Promise((resolve, reject) => {
      child ??= spawn();
      const proc = child;
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new QueryError(`Query took longer than ${TIMEOUT_MS / 1000}s and was stopped; aggregate more or add a date filter`));
        if (child === proc) child = null;
        proc.kill('SIGKILL'); // a running SQLite statement cannot be interrupted any other way
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, proc });
      proc.send({ id, sql });
    });
}
