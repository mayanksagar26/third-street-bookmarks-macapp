// ─────────────────────────────────────────────────────────────────────────────
// Writes that survive a second process.
//
// The browser build and the desktop app can both run a server against the same
// ~/.tsb. Without these, one of them rewriting a JSON file in place lets the
// other read half of it, and two read-modify-writes that overlap keep only the
// last — a favourite or a note silently gone.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');

/**
 * Replace `file` with `data` as JSON, all or nothing.
 *
 * rename() is atomic within a filesystem, so a reader sees the old file or the
 * new one, never a truncated one. The tmp name carries the pid so two
 * processes writing the same file can't interleave into one tmp.
 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}   // best effort; the write error is what matters
    throw e;
  }
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run `fn` while holding an exclusive lockfile at `lockPath`.
 *
 * Synchronous on purpose: every read-modify-write it guards is synchronous, so
 * the lock is held for milliseconds. A lock older than LOCK_STALE_MS belongs to
 * a process that died holding it and is taken over. Only our own servers honour
 * it — `ft export` and the Python helpers still write bookmarks.json unlocked.
 */
function withFileLock(lockPath, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { continue; }   // released meanwhile
      if (age > LOCK_STALE_MS) { try { fs.unlinkSync(lockPath); } catch {} continue; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockPath}`);
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

/**
 * Open a SQLite file for writing by more than one process.
 *
 * busy_timeout makes a writer that finds the database locked wait instead of
 * failing at once with SQLITE_BUSY. WAL lets readers carry on while one
 * connection writes, but it is a property of the file that persists once set
 * and moves recent writes into -wal/-shm sidecars, so pass `{ wal: false }`
 * for any database this app doesn't own (Field Theory's): a backup that copies
 * only the .db would miss them.
 */
function openWritableDb(file, { wal = true } = {}) {
  const Database = require('better-sqlite3');
  const conn = new Database(file);
  // busy_timeout first: switching to WAL takes a lock another process may hold.
  conn.pragma('busy_timeout = 5000');
  if (wal) conn.pragma('journal_mode = WAL');
  return conn;
}

module.exports = { writeJsonAtomic, withFileLock, openWritableDb };
