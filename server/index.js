const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { detectRuntimes, findBinary } = require('./agents');
const { discover } = require('./discover');
const { agentEnv, buildAgentArgs } = require('./agent-run');
const {
  createCors,
  createGuard,
  resolveToken,
  securityHeaders,
  validateBookmarkPath,
  validatePrompt,
} = require('./security');

// When the desktop app supervises us, our stdin is a pipe held open by the
// parent. EOF means the parent is gone — including the case where it was
// SIGKILLed and never got to shut us down — so we exit rather than linger,
// holding a port and a SQLite handle nobody can reach.
if (process.env.TSB_SUPERVISED === '1') {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
}

const app = express();
const PORT = process.env.PORT || 3456;

// Two roots, because the desktop build splits what the repo layout merged.
//
//   DATA_DIR   — writable: bookmarks.json, settings.json, state.db
//   SCRIPT_DIR — read-only: the bundled Python helpers
//
// Inside the .app, resources live in a signed read-only bundle and anything
// written must go to Application Support. Tauri sets both env vars at spawn.
// Unset (plain `node server/index.js`) falls back to the original repo layout,
// so this file still runs standalone.
const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.TSB_DATA_DIR
  ? path.resolve(process.env.TSB_DATA_DIR)
  : REPO_ROOT;
const SCRIPT_DIR = process.env.TSB_SCRIPT_DIR
  ? path.resolve(process.env.TSB_SCRIPT_DIR)
  : REPO_ROOT;

fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_BOOKMARKS_JSON = path.join(DATA_DIR, 'bookmarks.json');

// Resolved per call rather than frozen at boot: onboarding can point the app at
// a collection it discovered elsewhere on disk, and that has to take effect
// without a restart. Precedence is explicit override, then the user's choice,
// then the app's own directory.
function bookmarksPath() {
  if (process.env.DATA_PATH) return path.resolve(process.env.DATA_PATH);
  try {
    const chosen = readSettings().bookmarksPath;
    if (chosen && fs.existsSync(chosen)) return path.resolve(chosen);
  } catch {
    // Unreadable settings shouldn't take the feed down with them.
  }
  return DEFAULT_BOOKMARKS_JSON;
}

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const FT = path.join(os.homedir(), '.npm-global/bin/ft');
const CLASSIFY_PY = path.join(SCRIPT_DIR, 'classify.py');

// ── Sync source registry ──────────────────────────────────────────────────────
// Must mirror client/src/sources.js. `bin` candidates are probed so the UI can
// show an "installed" hint, but selection is manual — you can pick a source even
// if it isn't installed yet (the sync just reports it's missing).
const SOURCES = {
  fieldtheory: {
    id: 'fieldtheory',
    label: 'Field Theory',
    provides: ['bookmarks'],
    bins: [FT, path.join(os.homedir(), '.npm-global/bin/ft'), '/usr/local/bin/ft', '/opt/homebrew/bin/ft'],
  },
};

function resolveBin(source) {
  return (SOURCES[source]?.bins || []).find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
const EXTRA_PATH = '/usr/local/bin:/opt/homebrew/bin:' + path.join(os.homedir(), '.local/bin') +
  ':' + path.join(os.homedir(), '.npm-global/bin') +
  ':' + path.join(os.homedir(), '.nvm/versions/node/v20.0.0/bin');
const DB_PATH = process.env.FT_DB
  ? path.resolve(process.env.FT_DB)
  : path.join(os.homedir(), '.ft-bookmarks', 'bookmarks.db');

// The desktop webview is served from tauri://localhost, so every API call is
// cross-origin — something the browser build never had to deal with, since
// there the UI and the API shared :3456. That makes CORS mandatory, and makes
// getting it right mandatory too: a permissive policy here would hand every
// page you visit a client for this API.
const AUTH_TOKEN = resolveToken(DATA_DIR);

app.disable('x-powered-by');
app.use(securityHeaders);
app.use(createCors());
app.use(express.json({ limit: '10mb' }));

// Readiness, before the guard, revealing nothing the open port doesn't.
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', createGuard({ token: AUTH_TOKEN }));

// ── Field Theory's SQLite (read-only here: used once to migrate legacy UI state
//    into the app-owned state.db below) ────────────────────────────────────────
let db = null;

function openDb() {
  if (db) return db;
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);
    // Ensure columns exist (safe to run multiple times)
    db.exec(`
      CREATE TABLE IF NOT EXISTS bookmark_ui_state (id TEXT PRIMARY KEY, is_read INTEGER DEFAULT 0, fav_folder TEXT);
      ALTER TABLE bookmark_ui_state ADD COLUMN color_label TEXT;
    `);
  } catch {
    // ALTER TABLE fails if column already exists — that's fine
    try {
      const Database = require('better-sqlite3');
      db = new Database(DB_PATH);
    } catch { db = null; }
  }
  return db;
}


// ── App-owned State DB (source of truth for YOUR actions) ─────────────────────
// Lives at ~/.tsb/state.db, independent of the sync source. Owns read,
// favourite, colour-label, note and per-author voice prefs, keyed by tweet id.
// Applied on every read, so no sync from any source can ever reset your history.
const STATE_DB_PATH = process.env.STATE_DB
  ? path.resolve(process.env.STATE_DB)
  : path.join(os.homedir(), '.tsb', 'state.db');
const STATE_DIR = path.dirname(STATE_DB_PATH);
let stateDb = null;

function openStateDb() {
  if (stateDb) return stateDb;
  try {
    const Database = require('better-sqlite3');
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    stateDb = new Database(STATE_DB_PATH);
    stateDb.exec(`
      CREATE TABLE IF NOT EXISTS user_state (
        id TEXT PRIMARY KEY,
        is_read INTEGER DEFAULT 0,
        fav_folder TEXT,
        color_label TEXT,
        note TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS voice_pref (
        author_handle TEXT PRIMARY KEY,
        provider TEXT,
        voice_id TEXT,
        updated_at TEXT
      );
      -- A bookmark can live in many favourite folders (many-to-many).
      CREATE TABLE IF NOT EXISTS fav_membership (
        id TEXT,
        folder TEXT,
        created_at TEXT,
        PRIMARY KEY (id, folder)
      );
      CREATE INDEX IF NOT EXISTS idx_fav_folder ON fav_membership (folder);
    `);
    migrateState(stateDb);
  } catch { stateDb = null; }
  return stateDb;
}

// One-time seed: pull existing user state from bookmarks.json + Field Theory's
// DB into state.db so nothing is lost on the switch. Non-destructive.
function migrateState(conn) {
  const now = new Date().toISOString();
  const userStateEmpty = (() => { try { return conn.prepare('SELECT COUNT(*) c FROM user_state').get().c === 0; } catch { return false; } })();

  if (userStateEmpty) {
    let seeded = 0;
    try {
      const data = JSON.parse(fs.readFileSync(bookmarksPath(), 'utf8'));
      const ins = conn.prepare(`INSERT OR IGNORE INTO user_state (id, is_read, fav_folder, color_label, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
      const tx = conn.transaction(rows => {
        for (const b of rows) {
          if (b.isRead || b.favFolder || (b.favFolders && b.favFolders.length) || b.colorLabel || b.note) {
            ins.run(b.id, b.isRead ? 1 : 0, b.favFolder || (b.favFolders && b.favFolders[0]) || null, b.colorLabel || null, b.note || null, now);
            seeded++;
          }
        }
      });
      tx(data);
    } catch {}
    try {
      const ftDb = openDb();
      if (ftDb) {
        const rows = ftDb.prepare('SELECT id, is_read, fav_folder, color_label FROM bookmark_ui_state').all();
        const up = conn.prepare(`INSERT INTO user_state (id, is_read, fav_folder, color_label, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            is_read     = COALESCE(excluded.is_read,     is_read),
            fav_folder  = COALESCE(excluded.fav_folder,  fav_folder),
            color_label = COALESCE(excluded.color_label, color_label)`);
        const tx = conn.transaction(rs => { for (const r of rs) up.run(r.id, r.is_read, r.fav_folder, r.color_label, now); });
        tx(rows);
      }
    } catch {}
    console.log(`  [state.db] seeded user state for ${seeded} bookmarks`);
  }

  // Backfill fav_membership from the legacy single-folder column + any favFolders
  // arrays already in bookmarks.json. Runs until membership has rows, so it also
  // upgrades a state.db created by an earlier (single-folder) build.
  try {
    if (conn.prepare('SELECT COUNT(*) c FROM fav_membership').get().c === 0) {
      const ins = conn.prepare('INSERT OR IGNORE INTO fav_membership (id, folder, created_at) VALUES (?, ?, ?)');
      const tx = conn.transaction(() => {
        for (const r of conn.prepare('SELECT id, fav_folder FROM user_state WHERE fav_folder IS NOT NULL').all()) {
          ins.run(r.id, r.fav_folder, now);
        }
        try {
          const data = JSON.parse(fs.readFileSync(bookmarksPath(), 'utf8'));
          for (const b of data) for (const f of (b.favFolders || [])) if (f) ins.run(b.id, f, now);
        } catch {}
      });
      tx();
      console.log(`  [state.db] fav_membership rows: ${conn.prepare('SELECT COUNT(*) c FROM fav_membership').get().c}`);
    }
  } catch {}
}

// Partial upsert: only writes the fields present in `fields`, so null is a real
// value (un-favourite, clear note) rather than "leave unchanged".
function stateUpsert(id, fields) {
  const conn = openStateDb();
  if (!conn) return;
  try {
    conn.prepare('INSERT OR IGNORE INTO user_state (id, updated_at) VALUES (?, ?)').run(id, new Date().toISOString());
    const map = { isRead: 'is_read', colorLabel: 'color_label', note: 'note' };  // folders → fav_membership
    const sets = [], vals = [];
    for (const [key, col] of Object.entries(map)) {
      if (key in fields) {
        sets.push(`${col} = ?`);
        vals.push(key === 'isRead' ? (fields.isRead ? 1 : 0) : (fields[key] || null));
      }
    }
    if (!sets.length) return;
    sets.push('updated_at = ?'); vals.push(new Date().toISOString());
    vals.push(id);
    conn.prepare(`UPDATE user_state SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  } catch {}
}

// ── Favourite folders (many-to-many) ─────────────────────────────────────────
function favGetFolders(id) {
  const conn = openStateDb();
  if (!conn) return [];
  try { return conn.prepare('SELECT folder FROM fav_membership WHERE id = ? ORDER BY folder').all(id).map(r => r.folder); }
  catch { return []; }
}

// Replace a bookmark's folder set with `folders` (the desired full list).
function favSetFolders(id, folders) {
  const conn = openStateDb();
  if (!conn) return [];
  const clean = [...new Set((folders || []).map(f => String(f).trim()).filter(Boolean))];
  try {
    const tx = conn.transaction(() => {
      conn.prepare('DELETE FROM fav_membership WHERE id = ?').run(id);
      const ins = conn.prepare('INSERT OR IGNORE INTO fav_membership (id, folder, created_at) VALUES (?, ?, ?)');
      const now = new Date().toISOString();
      for (const f of clean) ins.run(id, f, now);
    });
    tx();
  } catch {}
  return clean;
}

// Rename a folder everywhere; merges into `to` if it already exists.
function favRenameFolder(from, to) {
  const conn = openStateDb();
  if (!conn) return;
  const f = String(from || '').trim(), t = String(to || '').trim();
  if (!f || !t || f === t) return;
  try {
    const tx = conn.transaction(() => {
      const ids = conn.prepare('SELECT id FROM fav_membership WHERE folder = ?').all(f).map(r => r.id);
      const ins = conn.prepare('INSERT OR IGNORE INTO fav_membership (id, folder, created_at) VALUES (?, ?, ?)');
      const now = new Date().toISOString();
      for (const id of ids) ins.run(id, t, now);
      conn.prepare('DELETE FROM fav_membership WHERE folder = ?').run(f);
    });
    tx();
  } catch {}
}

// Overlay state.db onto a bookmark array by id — the DB wins, always.
function applyState(list) {
  const conn = openStateDb();
  if (!conn) return list;
  try {
    const m = new Map(conn.prepare('SELECT * FROM user_state').all().map(r => [r.id, r]));
    const favs = {};
    for (const r of conn.prepare('SELECT id, folder FROM fav_membership').all()) {
      (favs[r.id] = favs[r.id] || []).push(r.folder);
    }
    for (const b of list) {
      const s = m.get(b.id);
      if (s) {
        b.isRead     = !!s.is_read;
        b.colorLabel = s.color_label || null;
        b.note       = s.note        || null;
      }
      // favourites come solely from membership; fall back to legacy JSON fields
      const folders = favs[b.id] || (b.favFolders && b.favFolders.length ? b.favFolders : (b.favFolder ? [b.favFolder] : []));
      b.favFolders = [...folders].sort();
      b.favFolder  = b.favFolders[0] || null;   // legacy single-folder consumers
    }
  } catch {}
  return list;
}

// Under Tauri the webview serves the frontend and this stays unused (the path
// won't exist, so the guard below skips it). Set TSB_DIST to serve the built
// UI from Express instead — the browser-only workflow.
const DIST = process.env.TSB_DIST
  ? path.resolve(process.env.TSB_DIST)
  : path.join(REPO_ROOT, 'client', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
}

// ── Process tracking ──────────────────────────────────────────────────────────
const procs  = { sync: null, classify: null };
const logs   = { sync: [], classify: [] };
const status = { sync: 'idle', classify: 'idle' };

function runProc(key, cmd, args, onDone) {
  if (procs[key]) return false;
  logs[key] = [];
  status[key] = 'running';
  const proc = spawn(cmd, args, {
    env: { ...process.env, PATH: process.env.PATH + ':' + EXTRA_PATH },
  });
  procs[key] = proc;
  proc.stdout.on('data', d => logs[key].push(d.toString()));
  proc.stderr.on('data', d => logs[key].push(d.toString()));
  proc.on('close', code => {
    status[key] = code === 0 ? 'done' : 'error';
    procs[key] = null;
    if (onDone) onDone(code);
  });
  return true;
}

// ── Settings I/O ──────────────────────────────────────────────────────────────
const SETTINGS_DEFAULTS = {
  aiBackend: 'claude',
  classifyBackend: 'python',
  syncSource: 'fieldtheory',
};

function readSettings() {
  let stored;
  try { stored = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return { ...SETTINGS_DEFAULTS }; }

  const settings = { ...SETTINGS_DEFAULTS, ...stored };

  // Settings outlive the code that wrote them. A source that has since been
  // removed — birdclaw, in the desktop build — would otherwise leave the UI
  // pointing at a backend that no longer exists.
  if (!SOURCES[settings.syncSource]) settings.syncSource = SETTINGS_DEFAULTS.syncSource;

  return settings;
}

function writeSettings(data) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
}

// ── Bookmarks I/O ─────────────────────────────────────────────────────────────
function readBookmarks() {
  // A fresh install has no collection yet — that's an empty feed, not a 500.
  // The UI's empty state tells the user to run a sync.
  if (!fs.existsSync(bookmarksPath())) return [];
  return JSON.parse(fs.readFileSync(bookmarksPath(), 'utf8'));
}

function writeBookmarks(data) {
  fs.writeFileSync(bookmarksPath(), JSON.stringify(data, null, 2));
}

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json(readSettings());
});

app.post('/api/settings', (req, res) => {
  try {
    const settings = { ...readSettings(), ...req.body };
    writeSettings(settings);
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Which sources exist + whether their CLI is detected on this machine. The UI
// uses `installed` only for a hint; the user still picks the source manually.
app.get('/api/sources', (req, res) => {
  const active = readSettings().syncSource || 'fieldtheory';
  res.json({
    active,
    sources: Object.values(SOURCES).map(s => ({
      id: s.id, label: s.label, provides: s.provides, installed: !!resolveBin(s.id),
    })),
  });
});

// ── AI runtimes ───────────────────────────────────────────────────────────────
// Which coding CLIs are on this machine, which version, and whether they're
// signed in. Onboarding blocks on this, so it must always answer.
app.get('/api/agents/detect', async (req, res) => {
  try {
    const runtimes = await detectRuntimes();
    const settings = readSettings();
    res.json({ runtimes, active: settings.aiBackend || 'claude' });
  } catch (e) {
    res.status(500).json({ error: e.message, runtimes: [] });
  }
});

// ── Bookmark discovery ────────────────────────────────────────────────────────
// Streams NDJSON progress events, then a final `{ type: 'result', ... }` line.
// A plain JSON response would leave the user watching a spinner for the length
// of a filesystem walk plus an agent turn.
app.post('/api/discover-bookmarks', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const settings = readSettings();
  const runtime = req.body?.runtime || settings.aiBackend || 'claude';
  const binary = findBinary(runtime === 'codex' ? 'codex' : 'claude');

  const send = obj => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
  };

  try {
    const result = await discover({
      runtime,
      binary,
      onEvent: event => send({ type: 'progress', ...event }),
    });
    send({ type: 'result', ...result, agentAvailable: Boolean(binary) });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  if (!res.writableEnded) res.end();
});

// Point the app at a discovered collection. Stores the path rather than copying
// the file, so a later `ft sync` still writes where the user expects.
app.post('/api/adopt-bookmarks', (req, res) => {
  let resolved;
  try {
    // Symlink-resolved, home-scoped, .json only. Without this the endpoint is
    // an arbitrary-file-read probe: the parse result tells a caller whether any
    // path on the machine exists and what shape it has.
    resolved = validateBookmarkPath(req.body?.path);
  } catch (e) {
    return res.status(400).json({ ok: false, msg: e.message });
  }

  let count = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : parsed?.bookmarks;
    if (!Array.isArray(records)) throw new Error('not a bookmark array');
    count = records.length;
  } catch (e) {
    return res.status(400).json({ ok: false, msg: `Could not read that file: ${e.message}` });
  }

  writeSettings({ ...readSettings(), bookmarksPath: resolved });
  res.json({ ok: true, path: resolved, count });
});

// ── Voice preferences (per-author → TTS provider/voice), owned by state.db ─────
app.get('/api/voice-pref', (req, res) => {
  const conn = openStateDb();
  if (!conn) return res.json({});
  try {
    const out = {};
    for (const r of conn.prepare('SELECT * FROM voice_pref').all()) {
      out[r.author_handle] = { provider: r.provider, voiceId: r.voice_id };
    }
    res.json(out);
  } catch { res.json({}); }
});

app.post('/api/voice-pref', (req, res) => {
  const { authorHandle, provider, voiceId } = req.body || {};
  if (!authorHandle) return res.status(400).json({ error: 'authorHandle required' });
  const conn = openStateDb();
  if (!conn) return res.status(500).json({ error: 'state db unavailable' });
  try {
    conn.prepare(`INSERT INTO voice_pref (author_handle, provider, voice_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(author_handle) DO UPDATE SET provider = excluded.provider, voice_id = excluded.voice_id, updated_at = excluded.updated_at`)
      .run(authorHandle, provider || null, voiceId || null, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bookmarks ─────────────────────────────────────────────────────────────────
app.get('/api/bookmarks', (req, res) => {
  try {
    res.json(applyState(readBookmarks()));   // state.db is authoritative for read/fav/label/note
  } catch {
    res.status(404).json({ error: 'bookmarks.json not found — copy bookmarks.sample.json to bookmarks.json to get started' });
  }
});

app.post('/api/read/:id', (req, res) => {
  try {
    const { id } = req.params;
    const data = readBookmarks();
    const bm = data.find(b => b.id === id || b.tweetId === id);
    if (!bm) return res.status(404).json({ error: 'Not found' });
    bm.isRead = !bm.isRead;
    writeBookmarks(data);
    stateUpsert(bm.id, { isRead: bm.isRead });
    res.json({ isRead: bm.isRead });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/read/bulk', (req, res) => {
  try {
    const { ids, read } = req.body;
    const data = readBookmarks();
    const updated = [];
    (ids || []).forEach(id => {
      const bm = data.find(b => b.id === id || b.tweetId === id);
      if (bm) { bm.isRead = read !== false; updated.push(bm.id); }
    });
    writeBookmarks(data);
    updated.forEach(id => stateUpsert(id, { isRead: read !== false }));
    res.json({ updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rename a folder across every bookmark (defined before /:id so it isn't shadowed).
app.post('/api/fav-rename', (req, res) => {
  try {
    const { from, to } = req.body || {};
    favRenameFolder(from, to);
    // keep the JSON cache in sync
    const data = readBookmarks();
    const f = String(from || '').trim(), t = String(to || '').trim();
    for (const b of data) {
      if (Array.isArray(b.favFolders)) {
        b.favFolders = [...new Set(b.favFolders.map(x => x === f ? t : x))];
        b.favFolder = b.favFolders[0] || null;
      } else if (b.favFolder === f) {
        b.favFolder = t; b.favFolders = [t];
      }
    }
    writeBookmarks(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Set a bookmark's full favourite-folder set: { folders: ["A","B"] } (empty = unfav).
app.post('/api/fav/:id', (req, res) => {
  try {
    const { id } = req.params;
    let { folders, folder } = req.body || {};
    if (!Array.isArray(folders)) folders = folder ? [folder] : [];   // back-compat
    const data = readBookmarks();
    const bm = data.find(b => b.id === id || b.tweetId === id);
    if (!bm) return res.status(404).json({ error: 'Not found' });
    const saved = favSetFolders(bm.id, folders);
    bm.favFolders = saved;
    bm.favFolder = saved[0] || null;
    writeBookmarks(data);
    res.json({ folders: saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/label/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { color } = req.body;
    const data = readBookmarks();
    const bm = data.find(b => b.id === id || b.tweetId === id);
    if (!bm) return res.status(404).json({ error: 'Not found' });
    bm.colorLabel = color || null;
    writeBookmarks(data);
    stateUpsert(bm.id, { colorLabel: bm.colorLabel });
    res.json({ colorLabel: bm.colorLabel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/note/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const data = readBookmarks();
    const bm = data.find(b => b.id === id || b.tweetId === id);
    if (!bm) return res.status(404).json({ error: 'Not found' });
    bm.note = note || null;
    writeBookmarks(data);
    stateUpsert(bm.id, { note: bm.note });
    res.json({ note: bm.note });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TTS proxy (avoids browser CORS restrictions) ─────────────────────────────
app.post('/api/tts', async (req, res) => {
  const { provider, text, key, voiceId } = req.body;
  if (!text || !key) return res.status(400).json({ error: 'text and key required' });

  try {
    if (provider === 'elevenlabs') {
      const vid = voiceId || '21m00Tcm4TlvDq8ikWAM';
      const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
        method: 'POST',
        headers: {
          'xi-api-key': key,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: text.slice(0, 1000),
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });
      if (!upstream.ok) {
        const err = await upstream.text();
        return res.status(upstream.status).json({ error: err });
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      const buf = await upstream.arrayBuffer();
      res.send(Buffer.from(buf));

    } else if (provider === 'sarvam') {
      const upstream = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: [text.slice(0, 500)],
          target_language_code: 'en-IN',
          speaker: voiceId || 'meera',
          enable_preprocessing: true,
        }),
      });
      if (!upstream.ok) {
        const err = await upstream.text();
        return res.status(upstream.status).json({ error: err });
      }
      const data = await upstream.json();
      const b64 = data.audios?.[0];
      if (!b64) return res.status(500).json({ error: 'No audio returned from Sarvam' });
      res.setHeader('Content-Type', 'audio/wav');
      res.send(Buffer.from(b64, 'base64'));

    } else {
      res.status(400).json({ error: 'Unknown provider' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Fetch available voices for a TTS provider ────────────────────────────────
app.get('/api/tts/voices', async (req, res) => {
  const { provider, key } = req.query;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    if (provider === 'elevenlabs') {
      const upstream = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': key },
      });
      if (!upstream.ok) {
        const err = await upstream.text();
        return res.status(upstream.status).json({ error: err });
      }
      const data = await upstream.json();
      // Only return voices usable on free tier — exclude library/professional voices
      const voices = (data.voices || [])
        .filter(v => v.category !== 'library' && v.category !== 'professional')
        .map(v => ({ id: v.voice_id, name: v.name, category: v.category }));
      res.json({ voices });
    } else {
      res.json({ voices: [] });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI Chat ───────────────────────────────────────────────────────────────────
app.post('/api/chat', (req, res) => {
  let prompt;
  try {
    prompt = validatePrompt(req.body?.prompt);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const settings = readSettings();
  const backend = settings.aiBackend || 'claude';

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const cmd = backend === 'codex' ? 'codex' : 'claude';
  const proc = spawn(cmd, buildAgentArgs(backend, prompt), {
    env: agentEnv(EXTRA_PATH),
  });

  proc.stdout.on('data', d => { if (!res.writableEnded) res.write(d); });
  proc.stderr.on('data', () => {});
  proc.on('close', () => { if (!res.writableEnded) res.end(); });
  proc.on('error', () => {
    const msg = `\n\n⚠️ ${backend} CLI not found. Install it or switch AI backend in settings.`;
    if (!res.writableEnded) { res.write(msg); res.end(); }
  });
});

// ── AI Classify ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  'ai-news','tool','technique','launch','startup','research','career','opinion',
  'education','finance','security','health','design','productivity','culture',
  'personal-story','humor','media','business','commerce','demo','entertainment',
  'travel','sports','books','food','history','self-improvement','community',
  'leadership','marketing','policy','science','misc',
];

app.post('/api/classify-ai', (req, res) => {
  const settings = readSettings();
  const backend = settings.aiBackend || 'claude';

  let data;
  try { data = readBookmarks(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const unclassified = data.filter(b =>
    !b.primaryCategory || b.primaryCategory === '' || b.primaryCategory === 'unclassified'
  );

  if (!unclassified.length) return res.json({ ok: true, classified: 0, msg: 'Nothing to classify' });

  const batchSize = 20;
  let done = 0;

  function processBatch(i, callback) {
    if (i >= unclassified.length) return callback(null);
    const batch = unclassified.slice(i, i + batchSize);
    const lines = batch.map((b, idx) => `${idx + 1}. ${(b.text || '').slice(0, 300)}`).join('\n');
    const prompt = `You classify tweets/bookmarks into exactly one category.\n\nCategories: ${CATEGORIES.join(', ')}\n\nRules:\n- Return ONLY a JSON array of category strings, one per tweet, in input order.\n- Pick the most specific category that fits.\n- Use "misc" only when nothing else fits.\n- No explanations, no extra text, no markdown fences.\n\nTweets:\n${lines}`;

    let cmd, args;
    if (backend === 'codex') {
      cmd = 'codex'; args = buildAgentArgs('codex', prompt);
    } else {
      cmd = 'claude'; args = buildAgentArgs('claude', prompt);
    }

    const proc = spawn(cmd, args, {
      env: { ...process.env, PATH: process.env.PATH + ':' + EXTRA_PATH },
    });

    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        try {
          const clean = out.trim().replace(/^```[a-z]*\n?/, '').replace(/```$/, '').trim();
          const cats = JSON.parse(clean);
          batch.forEach((b, idx) => {
            const cat = cats[idx];
            const valid = CATEGORIES.includes(cat) ? cat : 'misc';
            const bm = data.find(d => d.id === b.id);
            if (bm) { bm.primaryCategory = valid; bm.categories = [valid]; }
          });
          done += batch.length;
        } catch {}
      }
      processBatch(i + batchSize, callback);
    });
    proc.on('error', () => processBatch(i + batchSize, callback));
  }

  processBatch(0, () => {
    try { writeBookmarks(data); } catch {}
    res.json({ ok: true, classified: done });
  });
});

// ── Sync & Classify ───────────────────────────────────────────────────────────
const EXPORT_PY = path.join(SCRIPT_DIR, 'export.py');

function runExport(onDone) {
  // export.py reads SQLite → bookmarks.json, preserving colorLabel/note/isRead/favFolder
  const proc = spawn('python3', [EXPORT_PY, bookmarksPath()], {
    env: { ...process.env, PATH: process.env.PATH + ':' + EXTRA_PATH },
  });
  proc.stdout.on('data', d => logs.classify.push(d.toString()));
  proc.stderr.on('data', d => logs.classify.push(d.toString()));
  proc.on('close', code => { if (onDone) onDone(code); });
  proc.on('error', e => { logs.classify.push(`Export error: ${e.message}\n`); if (onDone) onDone(1); });
}

// Classify a bookmarks.json in place (source-agnostic). Maps the UI's classify
// backend onto classify.py's --backend flag. python → regex (offline/OpenAI key).
function runJsonClassify(classifyBackend, onDone) {
  const backend = classifyBackend === 'codex' ? 'codex' : classifyBackend === 'claude' ? 'claude' : 'regex';
  const proc = spawn('python3', [CLASSIFY_PY, `--json=${bookmarksPath()}`, `--backend=${backend}`], {
    env: { ...process.env, PATH: process.env.PATH + ':' + EXTRA_PATH },
  });
  proc.stdout.on('data', d => logs.classify.push(d.toString()));
  proc.stderr.on('data', d => logs.classify.push(d.toString()));
  proc.on('close', code => { if (onDone) onDone(code); });
  proc.on('error', e => { logs.classify.push(`Classify error: ${e.message}\n`); if (onDone) onDone(1); });
}

app.post('/api/syncall', (req, res) => {
  if (status.sync === 'running' || status.classify === 'running') {
    return res.json({ ok: false, msg: 'Already running' });
  }

  const settings = readSettings();
  for (const key of ['sync', 'classify']) { logs[key] = []; status[key] = 'idle'; }

  // ── Field Theory (default) ──
  if (!resolveBin('fieldtheory')) {
    return res.json({ ok: false, msg: 'ft not installed — bring your own bookmarks.json' });
  }
  runFieldTheorySync(settings);
  res.json({ ok: true });
});

function runFieldTheorySync(settings) {
  const FT_BIN = resolveBin('fieldtheory') || FT;
  runProc('sync', FT_BIN, ['sync', '--browser', 'chrome', '--yes'], () => {
    const classifyBackend = settings.classifyBackend || 'python';
    status.classify = 'running';

    if (classifyBackend === 'python') {
      // 1. classify in SQLite via classify.py, 2. export to bookmarks.json
      runProc('classify', 'python3', [CLASSIFY_PY], () => {
        runExport(() => { status.classify = 'done'; });
      });
    } else {
      // 1. export first so we have JSON to classify
      // 2. classify with AI CLI, 3. write categories back
      const aiCmd = classifyBackend === 'codex' ? 'codex' : 'claude';
      logs.classify.push(`Exporting bookmarks…\n`);

      runExport(() => {
        let data;
        try { data = readBookmarks(); } catch { status.classify = 'error'; return; }

        const unclassified = data.filter(b =>
          !b.primaryCategory || b.primaryCategory === '' || b.primaryCategory === 'unclassified'
        );

        if (!unclassified.length) { status.classify = 'done'; return; }

        logs.classify.push(`Classifying ${unclassified.length} bookmarks with ${aiCmd}…\n`);
        const batchSize = 20;
        let done = 0;

        function runBatch(i) {
          if (i >= unclassified.length) {
            try { writeBookmarks(data); } catch {}
            status.classify = 'done';
            logs.classify.push(`Done. ${done} classified.\n`);
            return;
          }
          const batch = unclassified.slice(i, i + batchSize);
          const lines = batch.map((b, idx) => `${idx + 1}. ${(b.text || '').slice(0, 300)}`).join('\n');
          const prompt = `Classify tweets into one of: ${CATEGORIES.join(', ')}. Return ONLY a JSON array. No markdown.\n\n${lines}`;
          const args2 = buildAgentArgs(classifyBackend === 'codex' ? 'codex' : 'claude', prompt);

          const proc = spawn(aiCmd, args2, {
            env: { ...process.env, PATH: process.env.PATH + ':' + EXTRA_PATH },
          });
          let out = '';
          proc.stdout.on('data', d => { out += d.toString(); });
          proc.on('close', code => {
            if (code === 0) {
              try {
                const clean = out.trim().replace(/^```[a-z]*\n?/, '').replace(/```$/, '').trim();
                const cats = JSON.parse(clean);
                batch.forEach((b, idx) => {
                  const cat = cats[idx];
                  const valid = CATEGORIES.includes(cat) ? cat : 'misc';
                  const bm = data.find(d => d.id === b.id);
                  if (bm) { bm.primaryCategory = valid; bm.categories = [valid]; }
                });
                done += batch.length;
              } catch {}
            }
            logs.classify.push(`Categories: ${Math.min(i + batchSize, unclassified.length)}/${unclassified.length}\n`);
            runBatch(i + batchSize);
          });
          proc.on('error', () => { status.classify = 'error'; });
        }
        runBatch(0);
      });
    }
  });
}

app.get('/api/status', (req, res) => {
  const classifyLog = logs.classify.join('');
  const m = classifyLog.match(/Categories:\s+\d+\/\d+/g);
  res.json({
    sync:     { status: status.sync,     log: logs.sync.slice(-5).join('') },
    classify: { status: status.classify, log: logs.classify.slice(-3).join(''), progress: m ? m[m.length - 1] : null },
  });
});

if (fs.existsSync(DIST)) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

// Loopback only. The default (all interfaces) put every bookmark on the local
// network — verified reachable from another device on the same Wi-Fi — and
// exposed /api/chat, which spawns a coding agent, to anyone who could reach it.
app.listen(PORT, '127.0.0.1', () => {
  openStateDb();   // create + migrate the state DB on boot
  console.log(`\n  Bookmark server → http://127.0.0.1:${PORT} (loopback only)`);
  console.log(`  Data:  ${bookmarksPath()}`);
  console.log(`  State: ${STATE_DB_PATH}\n`);
  // The token is deliberately absent from this log; it is the credential.
});
