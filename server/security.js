// ─────────────────────────────────────────────────────────────────────────────
// Local API hardening.
//
// "It's only localhost" is not a threat model. This server holds every bookmark
// you've ever saved and can spawn a coding agent on your machine, so treat it
// as what it is: an authenticated service that happens to have a short network
// path. Three independent controls, because any one of them can be wrong:
//
//   1. Bind loopback only     — takes the LAN off the table entirely
//   2. Per-launch bearer token — takes other local processes and websites off it
//   3. Origin + Host checks    — takes DNS rebinding off it
//
// Layer 2 is the load-bearing one. A browser can reach 127.0.0.1 from any page
// you visit; without a secret it cannot guess, every tab on the internet is a
// client of this API.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Origins allowed to talk to the API. Everything else is refused outright. */
const ALLOWED_ORIGINS = new Set([
  'tauri://localhost',      // the packaged macOS webview
  'http://localhost:5173',  // vite dev
  'http://127.0.0.1:5173',
]);

/** Hostnames that can legitimately appear in a loopback request. */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const TOKEN_FILE = 'auth-token';

/**
 * Resolve the shared secret for this run.
 *
 * The packaged app generates it in Rust and passes it in the environment, so it
 * never touches disk. Standalone runs need somewhere to put it — the data
 * directory, owner-readable only, so the Vite dev proxy can pick it up.
 */
function resolveToken(dataDir) {
  const fromEnv = process.env.TSB_AUTH_TOKEN;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  const tokenPath = path.join(dataDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // No token yet — fall through and mint one.
  }

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  // writeFileSync only applies mode on create; enforce it for pre-existing files.
  try { fs.chmodSync(tokenPath, 0o600); } catch {}
  return token;
}

/** Constant-time compare that tolerates length mismatch without leaking it. */
function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function presentedToken(req) {
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  // Fallback for the few places a header can't travel (media elements, links).
  // Query strings land in logs and Referer headers, so it is not the default.
  if (typeof req.query?.token === 'string') return req.query.token;
  return null;
}

/**
 * Guard every /api route.
 *
 * Order matters: Host before Origin before token, cheapest and most absolute
 * first, so a rebinding probe is rejected before it can even measure timing on
 * the token comparison.
 */
function createGuard({ token }) {
  return function guard(req, res, next) {
    // The readiness probe is deliberately unauthenticated. It reveals only that
    // a server exists — which the open TCP port already reveals — and Boot needs
    // it before the token has reached the webview.
    if (req.path === '/api/health') return next();

    // ── 1. Host — defeats DNS rebinding ─────────────────────────────────────
    // A rebinding attack arrives with the attacker's hostname in Host, since
    // the browser thinks it is still talking to evil.example.
    const host = (req.get('host') || '').toLowerCase();
    const hostname = host.replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(hostname)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // Only the hostname is checked, not the port. A rebinding attack arrives as
    // `evil.example:443` and is already rejected above; asserting the port as
    // well buys nothing an attacker couldn't spoof anyway, and it breaks the
    // legitimate case of the Vite dev proxy forwarding `localhost:5173`.

    // ── 2. Origin — blocks cross-site reads from any page you visit ─────────
    // Absent Origin means a non-browser client (curl, the app's own fetch on
    // some paths); those still have to pass the token check below.
    const origin = req.get('origin');
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // ── 3. Token ────────────────────────────────────────────────────────────
    if (!tokensMatch(presentedToken(req), token)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    return next();
  };
}

/**
 * CORS, scoped to the origins above.
 *
 * Echoing the request's origin rather than sending `*` is required once
 * credentials-ish headers are in play, and it means a disallowed origin gets no
 * ACAO header at all — the browser blocks the read even if the request landed.
 */
function createCors() {
  return function cors(req, res, next) {
    const origin = req.get('origin');
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  };
}

/** Headers that cost nothing and close off whole categories of mistake. */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

/**
 * Validate a user-supplied file path before the server will touch it.
 *
 * `/api/adopt-bookmarks` takes a path from the client, so without this it is an
 * arbitrary-file-read probe: point it anywhere, and the parse result tells you
 * whether the file exists and what shape it is. Symlinks are resolved first,
 * because a link inside the home directory can point anywhere outside it.
 */
function validateBookmarkPath(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096) {
    throw new Error('Invalid path');
  }
  if (input.includes('\0')) throw new Error('Invalid path');

  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(input));
  } catch {
    throw new Error('That file no longer exists');
  }

  const home = fs.realpathSync(os.homedir());
  const withinHome = resolved === home || resolved.startsWith(home + path.sep);
  if (!withinHome) {
    throw new Error('Only files inside your home folder can be used');
  }

  if (path.extname(resolved).toLowerCase() !== '.json') {
    throw new Error('Only .json files can be used');
  }

  const stat = fs.lstatSync(resolved);
  if (!stat.isFile()) throw new Error('Not a regular file');
  if (stat.size > 512 * 1024 * 1024) throw new Error('That file is too large');

  return resolved;
}

/** Reject oversized free-text before it reaches a subprocess argument list. */
function validatePrompt(value, max = 24_000) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('prompt required');
  }
  if (value.length > max) {
    throw new Error(`Prompt too long (max ${max} characters)`);
  }
  return value;
}

module.exports = {
  ALLOWED_ORIGINS,
  createCors,
  createGuard,
  resolveToken,
  securityHeaders,
  validateBookmarkPath,
  validatePrompt,
};
