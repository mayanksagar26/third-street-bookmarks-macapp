// Two servers sharing ~/.tsb: the writes each makes must all land, and nothing
// either leaves behind may be half a file. Every test here runs real separate
// processes, because the failures only exist between processes.
//
//   node --test server/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { writeJsonAtomic, openWritableDb } = require('./durable');

const DURABLE = path.join(__dirname, 'durable.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-durable-'));
}

// Run `body` in a fresh node process with `durable` in scope; resolves on exit.
function child(body, args = []) {
  const script = `const durable = require(${JSON.stringify(DURABLE)});\n${body}`;
  const proc = spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  const done = new Promise((resolve, reject) => {
    proc.on('close', (code, signal) => (code === 0 || signal ? resolve() : reject(new Error(err || `exit ${code}`))));
  });
  return { proc, done };
}

test('two processes writing state.db at once lose nothing', async () => {
  const file = path.join(tmpdir(), 'state.db');
  const setup = openWritableDb(file);
  setup.exec('CREATE TABLE user_state (id TEXT PRIMARY KEY, note TEXT); CREATE TABLE counter (n INTEGER); INSERT INTO counter VALUES (0);');
  assert.equal(setup.pragma('journal_mode', { simple: true }), 'wal');
  setup.close();

  const PER = 300;
  const writer = tag => child(`
    const db = durable.openWritableDb(${JSON.stringify(file)});
    const ins = db.prepare('INSERT INTO user_state (id, note) VALUES (?, ?)');
    const bump = db.prepare('UPDATE counter SET n = n + 1');
    // One transaction per write, as the server does, so the two interleave.
    const one = db.transaction(i => { ins.run('${tag}:' + i, 'note'); bump.run(); });
    for (let i = 0; i < ${PER}; i++) one(i);
    db.close();
  `);
  const a = writer('a'), b = writer('b');
  await Promise.all([a.done, b.done]);

  const db = openWritableDb(file);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM user_state').get().c, PER * 2);
  assert.equal(db.prepare('SELECT n FROM counter').get().n, PER * 2);
  db.close();
});

test('opening a database the app does not own leaves its journal mode alone', () => {
  const file = path.join(tmpdir(), 'bookmarks.db');
  const Database = require('better-sqlite3');
  const seed = new Database(file);
  seed.exec('CREATE TABLE bookmarks (id TEXT PRIMARY KEY)');
  const before = seed.pragma('journal_mode', { simple: true });
  seed.close();
  assert.notEqual(before, 'wal');

  const conn = openWritableDb(file, { wal: false });
  conn.prepare('INSERT INTO bookmarks VALUES (?)').run('1');
  assert.equal(conn.pragma('busy_timeout', { simple: true }), 5000);
  conn.close();

  const after = new Database(file, { readonly: true });
  assert.equal(after.pragma('journal_mode', { simple: true }), before);
  after.close();
  assert.ok(!fs.existsSync(`${file}-wal`), 'left a -wal sidecar');
});

test('a JSON write killed midway leaves the previous file whole', async () => {
  const file = path.join(tmpdir(), 'bookmarks.json');
  // Large enough that a single write takes real time to land.
  const big = n => Array.from({ length: 20000 }, (_, i) => ({ id: String(i), gen: n, text: 'x'.repeat(40) }));
  writeJsonAtomic(file, big(0));

  const w = child(`
    const big = n => Array.from({ length: 20000 }, (_, i) => ({ id: String(i), gen: n, text: 'x'.repeat(40) }));
    for (let n = 1; ; n++) durable.writeJsonAtomic(${JSON.stringify(file)}, big(n));
  `);

  // Read while it writes: every read must parse to a complete collection.
  const until = Date.now() + 800;
  let reads = 0;
  try {
    while (Date.now() < until) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.length, 20000);
      reads++;
      await new Promise(r => setImmediate(r));
    }
  } finally {
    w.proc.kill('SIGKILL');   // the writer loops forever; never leave it running
    await w.done;
  }

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.length, 20000);
  assert.ok(after.every(r => r.gen === after[0].gen), 'file mixes two generations');
  assert.ok(reads > 0);
});

test('locked read-modify-write from two processes keeps every update', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'bookmarks.json');
  const lock = path.join(dir, 'bookmarks.lock');
  writeJsonAtomic(file, { n: 0, seen: [] });

  const PER = 100;
  const worker = tag => child(`
    const fs = require('fs');
    for (let i = 0; i < ${PER}; i++) {
      durable.withFileLock(${JSON.stringify(lock)}, () => {
        const data = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
        data.n++;
        data.seen.push('${tag}' + i);
        durable.writeJsonAtomic(${JSON.stringify(file)}, data);
      });
    }
  `);
  const a = worker('a'), b = worker('b');
  await Promise.all([a.done, b.done]);

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.n, PER * 2);
  assert.equal(new Set(data.seen).size, PER * 2);
  assert.ok(!fs.existsSync(lock), 'lock left behind');
});

test('a lock abandoned by a dead process is taken over', () => {
  const dir = tmpdir();
  const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const { withFileLock } = require('./durable');
  assert.equal(withFileLock(lock, () => 'ran'), 'ran');
});

test('a failed JSON write throws and leaves no tmp file', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'missing-dir', 'settings.json');
  assert.throws(() => writeJsonAtomic(file, { a: 1 }));
  assert.deepEqual(fs.readdirSync(dir), []);
});
