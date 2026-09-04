// ─────────────────────────────────────────────────────────────────────────────
// Multi-source bookmark storage.
//
// The app started as a mirror of one thing: `ft` writes bookmarks.json, we read
// it. Every other source breaks that assumption in the same two ways — it owns
// its own export, and its ids mean nothing to anybody else. So:
//
//   bookmarks.json          still belongs to Field Theory. Untouched shape.
//   ~/.tsb/sources/*.json   one file per additional source, owned by this app.
//
// and every id is namespaced on the way in (`hn:38104219`, `yt:dQw4w9WgXcQ`).
// Without that, Hacker News item 12345 eventually collides with a tweet id and
// silently inherits its read/favourite state — a bug that would look like
// corruption and be near-impossible to trace back here.
//
// Namespacing is applied at read time rather than baked into the files, because
// `ft export` rewrites bookmarks.json wholesale and would drop any prefix we
// persisted there. `denormalize()` is the inverse, applied on write.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

/** Sources that keep their own file under sources/. X is not one: `ft` owns it. */
const MANAGED = ['hn', 'yt', 'ig', 'link'];

const SOURCE_META = {
  x:    { label: 'X',            short: 'X'         },
  hn:   { label: 'Hacker News',  short: 'HN'        },
  yt:   { label: 'YouTube',      short: 'YouTube'   },
  ig:   { label: 'Instagram',    short: 'Instagram' },
  link: { label: 'Saved Links',  short: 'Link'      },
};

/** `hn` + `38104219` → `hn:38104219`. Idempotent. */
function nsId(source, rawId) {
  const raw = String(rawId);
  return raw.startsWith(`${source}:`) ? raw : `${source}:${raw}`;
}

/**
 * Split a namespaced id back into its parts.
 *
 * A bare id is X by definition — that is every id written before this module
 * existed, and tweet ids are pure digits so they can never contain the
 * separator we're looking for.
 */
function splitId(id) {
  const s = String(id || '');
  const i = s.indexOf(':');
  if (i === -1) return { source: 'x', rawId: s };
  const source = s.slice(0, i);
  if (!SOURCE_META[source]) return { source: 'x', rawId: s };
  return { source, rawId: s.slice(i + 1) };
}

function sourceOf(bookmark) {
  return bookmark.source || splitId(bookmark.id).source;
}

// ── Files ────────────────────────────────────────────────────────────────────

function sourcesDir(dataDir) {
  return path.join(dataDir, 'sources');
}

function sourceFile(dataDir, source) {
  return path.join(sourcesDir(dataDir), `${source}.json`);
}

function readSource(dataDir, source) {
  const file = sourceFile(dataDir, source);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A half-written file shouldn't take the whole feed down with it.
    return [];
  }
}

function writeSource(dataDir, source, records) {
  const dir = sourcesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = sourceFile(dataDir, source);
  // Write-then-rename: a crash mid-write leaves the previous list intact
  // rather than a truncated file that parses as an empty collection.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Add records to a source, replacing any already present by id.
 *
 * Re-import is the normal case, not the exception — you re-run a playlist sync,
 * you re-drop the same Instagram export. Upserting keeps that idempotent while
 * letting a refreshed record carry newer metadata (a retitled video, a story
 * that has since gained points).
 */
function upsertSource(dataDir, source, incoming) {
  const existing = readSource(dataDir, source);
  const byId = new Map(existing.map(r => [r.id, r]));
  let added = 0;
  for (const rec of incoming) {
    if (!byId.has(rec.id)) added++;
    const prev = byId.get(rec.id);
    byId.set(rec.id, prev ? mergeRecord(prev, rec) : rec);
  }
  const merged = [...byId.values()];
  writeSource(dataDir, source, merged);
  return { added, total: merged.length };
}

/**
 * Fields that belong to you, not to the source that supplied the record.
 *
 * state.db is the authority for these, and `applyState` overwrites them on
 * every read — but the JSON is what's left when a state row is missing, so an
 * ingest must not be allowed to write them either. Saving the same Hacker News
 * story twice hands us `isRead: false`, and `false` is a real value rather than
 * an absent one, so a field-by-field merge would happily reset a story you had
 * already read. That is exactly the thing this app promises cannot happen: no
 * sync from any source can reset your history.
 */
const USER_FIELDS = new Set(['isRead', 'favFolders', 'favFolder', 'colorLabel', 'note']);

/**
 * Merge an incoming record over an existing one, field by field.
 *
 * A blanket spread loses data whenever the sources differ in richness: a
 * Takeout CSV carries nothing but a video id, so re-importing a playlist would
 * wipe the title and thumbnail an oEmbed lookup had already found. So an empty
 * incoming value never overwrites a populated one.
 *
 * Two fields get their own rule:
 *   bookmarkedAt  the earlier wins — when you first kept a thing is yours
 *   folderNames   union — one video in three playlists is one bookmark in
 *                 three folders, and importing the second must not drop the first
 *   USER_FIELDS   never written by an ingest at all, see above
 */
function mergeRecord(prev, next) {
  const out = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (USER_FIELDS.has(key)) continue;
    const empty = value === null || value === undefined || value === ''
      || (Array.isArray(value) && value.length === 0);
    if (empty) continue;
    out[key] = value;
  }
  out.folderNames = [...new Set([...(prev.folderNames || []), ...(next.folderNames || [])])];
  const stamps = [prev.bookmarkedAt, next.bookmarkedAt].filter(Boolean).sort();
  if (stamps.length) out.bookmarkedAt = stamps[0];
  return out;
}

function removeFromSource(dataDir, source, id) {
  const existing = readSource(dataDir, source);
  const next = existing.filter(r => r.id !== id);
  if (next.length !== existing.length) writeSource(dataDir, source, next);
  return existing.length - next.length;
}

// ── Normalisation ────────────────────────────────────────────────────────────

/**
 * Bring a Field Theory record into the shared shape.
 *
 * Deliberately additive. Every existing consumer reads `authorHandle`, `text`,
 * `likeCount` and friends, so those names stay exactly where they were and the
 * new fields sit alongside. Generalising by renaming would have meant touching
 * thirty call sites across the feed, stats, chat and podcast for no user-facing
 * gain.
 */
function normalizeX(rec) {
  const rawId = rec.tweetId || rec.id;
  return {
    ...rec,
    id: nsId('x', rec.id),
    rawId: String(rawId),
    source: 'x',
    sourceLabel: SOURCE_META.x.label,
    title: rec.articleTitle || null,
    thumbnailUrl: rec.thumbnailUrl || null,
    url: rec.url || (rec.authorHandle && rawId ? `https://x.com/${rec.authorHandle}/status/${rawId}` : null),
  };
}

/** Records from managed sources are written in the shared shape already. */
function normalizeManaged(rec, source) {
  return {
    ...rec,
    id: nsId(source, rec.rawId || rec.id),
    source,
    sourceLabel: SOURCE_META[source]?.label || source,
  };
}

/**
 * Strip the namespace back off X records so bookmarks.json stays a file `ft`
 * still recognises. The added fields are harmless noise there — `ft export`
 * overwrites them on the next sync anyway.
 */
function denormalizeX(rec) {
  const { rawId, source, sourceLabel, ...rest } = rec;
  return { ...rest, id: splitId(rec.id).rawId };
}

/** Every record from every source, namespaced and merged. */
function readAll(dataDir, readX) {
  const out = [];
  try {
    for (const rec of readX()) out.push(normalizeX(rec));
  } catch {
    // No X collection yet is an empty feed, not an error.
  }
  for (const source of MANAGED) {
    for (const rec of readSource(dataDir, source)) out.push(normalizeManaged(rec, source));
  }
  return out;
}

/**
 * Route a merged list back to the files it came from.
 *
 * Callers mutate one record inside the whole collection and hand the array
 * back, so the split has to happen here rather than at each call site.
 */
function writeAll(dataDir, list, writeX) {
  const buckets = { x: [] };
  for (const source of MANAGED) buckets[source] = [];
  for (const rec of list) {
    const source = sourceOf(rec);
    (buckets[source] || buckets.x).push(rec);
  }
  if (buckets.x.length) writeX(buckets.x.map(denormalizeX));
  for (const source of MANAGED) {
    // Only rewrite a source we actually hold records for, so a merged list that
    // predates a source can't blank its file.
    if (buckets[source].length) writeSource(dataDir, source, buckets[source]);
  }
}

function counts(list) {
  const out = { all: list.length };
  for (const rec of list) {
    const s = sourceOf(rec);
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}

module.exports = {
  MANAGED, SOURCE_META,
  nsId, splitId, sourceOf,
  sourcesDir, sourceFile, readSource, writeSource, upsertSource, removeFromSource, mergeRecord,
  normalizeX, normalizeManaged, denormalizeX, USER_FIELDS,
  readAll, writeAll, counts,
};
