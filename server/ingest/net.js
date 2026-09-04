// Shared outbound HTTP for the ingest adapters.
//
// This is the first code in the app that reaches the network at all — every
// other feature reads local files or spawns a local process. So the rules are
// explicit rather than assumed: https only, a hard timeout, and a byte cap on
// responses so a hostile or broken endpoint can't stream until we run out of
// memory.

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

const UA = 'ThirdStreetBookmarks/1.0 (local bookmark manager)';

function assertHttps(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`refusing non-http scheme: ${parsed.protocol}`);
  }
  return parsed;
}

async function fetchText(url, { headers = {}, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  assertHttps(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, ...headers },
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      err.status = res.status;
      throw err;
    }
    // Read incrementally so the cap applies to what actually arrives, not to a
    // content-length header the server is free to lie about.
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { await reader.cancel(); break; }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, { headers: { accept: 'application/json' }, ...opts });
  return JSON.parse(text);
}

module.exports = { fetchText, fetchJson, assertHttps };
