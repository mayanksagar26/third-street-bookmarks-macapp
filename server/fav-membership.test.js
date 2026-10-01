// Refiling a favourite or renaming its folder must not make it look newly
// favourited: created_at is the only record of when that happened.
//
//   node --test server/

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const { setFolders, renameFolder } = require('./fav-membership');

const T1 = '2026-08-01T10:00:00.000Z';
const T2 = '2026-08-15T10:00:00.000Z';
const NOW = '2026-10-01T10:00:00.000Z';

function db(rows = []) {
  const conn = new Database(':memory:');
  conn.exec(`CREATE TABLE fav_membership (id TEXT, folder TEXT, created_at TEXT, PRIMARY KEY (id, folder))`);
  const ins = conn.prepare('INSERT INTO fav_membership VALUES (?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.folder, r.created_at);
  return conn;
}

const rowsOf = (conn, id) => Object.fromEntries(
  conn.prepare('SELECT folder, created_at FROM fav_membership WHERE id = ? ORDER BY folder').all(id)
    .map(r => [r.folder, r.created_at]),
);

test('a new favourite is dated now', () => {
  const conn = db();
  assert.deepEqual(setFolders(conn, 'x:1', ['A', ' A ', ''], NOW), ['A']);
  assert.deepEqual(rowsOf(conn, 'x:1'), { A: NOW });
});

test('adding a second folder keeps the first one\'s date, and the new one inherits it', () => {
  const conn = db([{ id: 'x:1', folder: 'A', created_at: T1 }]);
  setFolders(conn, 'x:1', ['A', 'B'], NOW);
  assert.deepEqual(rowsOf(conn, 'x:1'), { A: T1, B: T1 });
});

test('moving to another folder keeps the earliest date', () => {
  const conn = db([
    { id: 'x:1', folder: 'A', created_at: T2 },
    { id: 'x:1', folder: 'B', created_at: T1 },
  ]);
  setFolders(conn, 'x:1', ['C'], NOW);
  assert.deepEqual(rowsOf(conn, 'x:1'), { C: T1 });
});

test('unfavouriting then favouriting again starts fresh', () => {
  const conn = db([{ id: 'x:1', folder: 'A', created_at: T1 }]);
  setFolders(conn, 'x:1', [], NOW);
  assert.deepEqual(rowsOf(conn, 'x:1'), {});
  setFolders(conn, 'x:1', ['A'], NOW);
  assert.deepEqual(rowsOf(conn, 'x:1'), { A: NOW });
});

test('other bookmarks are untouched', () => {
  const conn = db([
    { id: 'x:1', folder: 'A', created_at: T1 },
    { id: 'x:2', folder: 'A', created_at: T2 },
  ]);
  setFolders(conn, 'x:1', ['B'], NOW);
  assert.deepEqual(rowsOf(conn, 'x:2'), { A: T2 });
});

test('renaming a folder keeps each membership\'s date', () => {
  const conn = db([
    { id: 'x:1', folder: 'Old', created_at: T1 },
    { id: 'x:2', folder: 'Old', created_at: T2 },
  ]);
  renameFolder(conn, 'Old', 'New');
  assert.deepEqual(rowsOf(conn, 'x:1'), { New: T1 });
  assert.deepEqual(rowsOf(conn, 'x:2'), { New: T2 });
});

test('renaming into an existing folder keeps the earlier of the two dates', () => {
  const conn = db([
    { id: 'x:1', folder: 'Old', created_at: T2 },
    { id: 'x:1', folder: 'New', created_at: T1 },
    { id: 'x:2', folder: 'Old', created_at: T1 },
    { id: 'x:2', folder: 'New', created_at: T2 },
  ]);
  renameFolder(conn, 'Old', 'New');
  assert.deepEqual(rowsOf(conn, 'x:1'), { New: T1 });
  assert.deepEqual(rowsOf(conn, 'x:2'), { New: T1 });
});
