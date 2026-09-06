// ─────────────────────────────────────────────────────────────────────────────
// Instagram — via the official data export, deliberately.
//
// There is no API for your own saved posts. The alternatives to an export are
// driving a logged-in browser session or replaying the private web endpoints,
// and both carry the same real cost: Instagram treats automated traffic on a
// logged-in account as suspicious, and the outcome is a checkpoint on your
// account rather than a failed request. The export is slower and manual, but it
// cannot get you locked out of your own account, and it stays entirely local.
//
// The export ships as a ZIP that macOS unpacks on download. We read the
// unpacked folder rather than the archive so the server needs no zip
// dependency — and so the user can point at a single file if they'd rather.
//
// Format drift is assumed. Meta has renamed these keys more than once, so the
// parser walks the JSON looking for anything that resolves to a post URL rather
// than reaching for a fixed path that will be wrong again next year.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

/**
 * Where the user has to go to start the export.
 *
 * Meta moved this into Accounts Center; the instagram.com path still redirects
 * there today but has been the less reliable of the two. Both are surfaced so a
 * broken redirect is a second click rather than a support question.
 */
const DOWNLOAD_URLS = {
  primary: 'https://accountscenter.instagram.com/info_and_permissions/dyi/',
  fallback: 'https://www.instagram.com/download/request/',
};

const POST_RE = /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

/**
 * Filenames Instagram has used for the saved export, across versions.
 *
 * HTML as well as JSON, because HTML is what the download page gives you unless
 * you notice the format switch — and a real export named `saved_collections.html`
 * matched none of the JSON-only patterns this started with, so the import found
 * nothing and reported the archive as the wrong one.
 *
 * Posts and collections only. The same folder holds `saved_music`, which is a
 * list of audio tracks and not a thing this app has any use for.
 */
const SAVED_FILE_RE = /^saved[_-](posts|collections)\b.*\.(json|html?)$/i;

function findSavedFiles(root, { maxDepth = 6, limit = 40 } = {}) {
  const found = [];
  const stack = [[root, 0]];
  while (stack.length && found.length < limit) {
    const [dir, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) stack.push([full, depth + 1]);
      } else if (SAVED_FILE_RE.test(e.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

// ── HTML exports ─────────────────────────────────────────────────────────────
//
// Meta's HTML export is a nest of `div.pam` blocks whose leaves are two-column
// tables of label/value pairs. Parsing it as a tree would need a DOM library;
// it does not need one, because the document is strictly ordered and the shape
// that matters is a sequence:
//
//   Name / Type / Privacy / Update time   ← a collection begins here
//   …its items…                            ← until the next such header
//
// So the file is read as a token stream in document order and folded back into
// collections, which is both shorter than tree-walking and immune to the
// class-name churn that a CSS-selector approach would break on.

// The cell captures must not be allowed to cross their own `</td>`.
//
// A plain `[\s\S]*?` looks non-greedy but will happily extend past the closing
// tag hunting for a `</td>` that *is* followed by a value cell — bridging whole
// nested tables in the process, swallowing the post links inside them, and
// yielding one absurd token labelled "MediaURLhttps://…Caption". `(?!<\/td>)`
// pins each capture inside its own cell.
//
// The URL alternative comes first so a link is claimed as a link before any
// cell pattern gets the chance to reach over it.
const CELL_RE = new RegExp(
  '(https?:\\/\\/(?:www\\.)?instagram\\.com\\/(?:p|reel|reels|tv)\\/[A-Za-z0-9_-]+)' +
  '|<td[^>]*class="_a6_q"[^>]*>((?:(?!<\\/td>)[\\s\\S])*?)<\\/td>' +
  '\\s*<td[^>]*class="_2piu[^"]*"[^>]*>((?:(?!<\\/td>)[\\s\\S])*?)<\\/td>',
  'g',
);

function stripTags(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse one HTML export file into the same shape `parseFile` returns.
 *
 * `isCollectionFile` decides whether a `Name` row can open a collection. In
 * saved_posts.html the same label is the *owner's* display name, and treating
 * that as a collection would turn every account you saved from into a folder.
 */
function parseHtml(file, isCollectionFile) {
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch { return []; }

  const tokens = [];
  CELL_RE.lastIndex = 0;
  let m;
  while ((m = CELL_RE.exec(html)) !== null) {
    if (m[1]) tokens.push({ kind: 'url', value: m[1] });
    else tokens.push({ kind: stripTags(m[2]), value: stripTags(m[3]) });
  }

  const out = [];
  let collection = null;
  let pending = null;   // the shortcode still waiting to learn who posted it

  const flush = () => { if (pending) { out.push(pending); pending = null; } };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // A collection header: Name immediately followed by Type.
    if (isCollectionFile && t.kind === 'Name' && tokens[i + 1]?.kind === 'Type') {
      flush();
      collection = t.value || null;
      continue;
    }

    if (t.kind === 'url') {
      const code = shortcodeOf(t.value);
      if (!code) continue;
      // The same post appears twice per item — once as the href and once as the
      // anchor's text. Only the first opens a new item.
      if (pending && pending.shortcode === code) continue;
      flush();
      pending = {
        shortcode: code, url: t.value, timestamp: null, collection,
        author: null, authorName: null, caption: null,
      };
      continue;
    }

    // Caption, owner name and handle all follow the item's links, so they
    // attach backwards to the item still open. Each is taken once: Instagram
    // repeats the caption for posts with several images, and the second copy
    // would otherwise overwrite the first with the same text for no reason.
    if (!pending) continue;
    if (t.kind === 'Caption'  && !pending.caption)    pending.caption    = t.value || null;
    if (t.kind === 'Name'     && !pending.authorName) pending.authorName = t.value || null;
    if (t.kind === 'Username' && !pending.author)     pending.author     = t.value || null;
  }
  flush();
  return out;
}

function shortcodeOf(str) {
  const m = POST_RE.exec(String(str || ''));
  return m ? m[1] : null;
}

/**
 * Pull `{ href, timestamp, label }` out of one export entry.
 *
 * Entries are `{ title, string_map_data: { "<Label>": { href, timestamp, value } } }`
 * in every version seen so far, but the label under which the href sits has
 * changed ("Saved on", "Added Time", "Photo"), so we take whichever one carries
 * a post URL instead of naming it.
 */
function readEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const maps = [entry.string_map_data, entry.string_list_data, entry.media_map_data]
    .filter(v => v && typeof v === 'object');

  let href = null, timestamp = null;

  for (const map of maps) {
    const values = Array.isArray(map) ? map : Object.values(map);
    for (const v of values) {
      if (!v || typeof v !== 'object') continue;
      const candidate = v.href || v.value || v.uri;
      if (!href && shortcodeOf(candidate)) href = candidate;
      if (!timestamp && typeof v.timestamp === 'number') timestamp = v.timestamp;
    }
  }

  // Some exports put the URL directly on the entry.
  if (!href) href = [entry.href, entry.uri, entry.value].find(v => shortcodeOf(v)) || null;
  if (!timestamp && typeof entry.timestamp === 'number') timestamp = entry.timestamp;

  if (!href) return null;
  return { href, timestamp, title: typeof entry.title === 'string' ? entry.title : null };
}

/**
 * Parse one export file.
 *
 * The container key decides what `title` means, and getting this backwards is
 * the difference between collection names and usernames in your sidebar:
 *
 *   saved_saved_media        → title is the *poster's* handle, no collection
 *   saved_saved_collections  → title is the *collection's* name
 */
function parseFile(file) {
  const isCollectionFile = /collection/i.test(path.basename(file));
  if (/\.html?$/i.test(file)) return parseHtml(file, isCollectionFile);

  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }

  const out = [];
  const containers = Array.isArray(parsed)
    ? [['', parsed]]
    : Object.entries(parsed).filter(([, v]) => Array.isArray(v));

  for (const [key, list] of containers) {
    const isCollection = /collection/i.test(key) || /collection/i.test(path.basename(file));
    for (const entry of list) {
      const read = readEntry(entry);
      if (!read) continue;
      out.push({
        shortcode: shortcodeOf(read.href),
        url: read.href,
        timestamp: read.timestamp,
        collection: isCollection ? read.title : null,
        author: isCollection ? null : read.title,
        authorName: null,
        caption: null,
      });
    }
  }
  return out;
}

function toRecord(item) {
  const now = new Date().toISOString();
  const savedAt = item.timestamp ? new Date(item.timestamp * 1000).toISOString() : now;
  const url = `https://www.instagram.com/p/${item.shortcode}/`;
  return {
    id: `ig:${item.shortcode}`,
    rawId: item.shortcode,
    source: 'ig',
    sourceLabel: 'Instagram',
    url,
    // The caption is the content, so it goes in the body and the card gets no
    // separate heading — a title reading "Instagram post" above the actual post
    // is a row of furniture. Without a caption the URL becomes the heading, so
    // the card still says something.
    title: null,
    text: item.caption || '',
    authorHandle: item.author || null,
    authorName: item.authorName || item.author || null,
    authorProfileImageUrl: null,
    // Instagram's CDN thumbnail URLs are signed and expire within days, so the
    // export's image links are worthless by the time you read them. No preview
    // is honest; a permanently broken one is not.
    thumbnailUrl: null,
    domain: 'instagram.com',
    postedAt: savedAt,
    bookmarkedAt: savedAt,
    syncedAt: now,
    likeCount: 0, replyCount: 0, repostCount: 0, bookmarkCount: 0,
    categories: [], primaryCategory: null,
    // Collections are containers Instagram owns — the same slot as X's bookmark
    // folders and YouTube's playlists.
    folderNames: item.collection ? [item.collection] : [],
    folderIds: [],
    isRead: false, favFolders: [], favFolder: null, colorLabel: null, note: null,
  };
}

/**
 * Read an unpacked export (or a single saved_*.json) into records.
 *
 * `collections` is returned separately from the records so the UI can offer the
 * folder list first and let the user import only the ones they want — the whole
 * point of doing this at all is that you keep three collections, not everything
 * you ever tapped save on.
 */
function readExport(target, { only = null } = {}) {
  const stat = fs.statSync(target);
  const files = stat.isDirectory() ? findSavedFiles(target) : [target];
  if (!files.length) {
    throw new Error('No saved_posts or saved_collections file in there — pick the export folder');
  }

  const byShortcode = new Map();
  for (const file of files) {
    for (const item of parseFile(file)) {
      if (!item.shortcode) continue;
      const prev = byShortcode.get(item.shortcode);
      // A post can appear in the flat saved list and in a collection. The
      // collection membership is the more useful of the two, so it wins.
      if (!prev) { byShortcode.set(item.shortcode, item); continue; }
      // A post can appear in the flat saved list and in a collection. Take the
      // collection membership from whichever copy has it, and fill in any
      // detail the other copy was missing rather than letting a sparser record
      // overwrite a fuller one.
      if (!prev.collection && item.collection) prev.collection = item.collection;
      if (!prev.author && item.author) prev.author = item.author;
      if (!prev.authorName && item.authorName) prev.authorName = item.authorName;
      if (!prev.caption && item.caption) prev.caption = item.caption;
      if (!prev.timestamp && item.timestamp) prev.timestamp = item.timestamp;
    }
  }

  const all = [...byShortcode.values()];
  const collections = {};
  for (const item of all) {
    const name = item.collection || 'All Saved';
    collections[name] = (collections[name] || 0) + 1;
  }

  const wanted = only && only.length
    ? all.filter(i => only.includes(i.collection || 'All Saved'))
    : all;

  return {
    files: files.map(f => path.basename(f)),
    collections,
    records: wanted.map(toRecord),
  };
}

module.exports = { readExport, parseFile, parseHtml, toRecord, findSavedFiles, DOWNLOAD_URLS };
