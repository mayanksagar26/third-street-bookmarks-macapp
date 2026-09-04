// Google Takeout → YouTube playlists.
//
// The credential-free route, and the only route to Watch Later at all: Google
// removed API access to it in 2016 and never restored it. A Takeout export
// contains one CSV per playlist, Watch Later and Liked among them.
//
// The CSVs have changed shape across Takeout versions — sometimes a metadata
// header block, a blank line, then the video rows; sometimes just the rows. So
// rather than parse a schema, we scan every line for a token that can only be a
// video id. A YouTube video id is exactly 11 characters of [A-Za-z0-9_-], which
// is specific enough to pick out of a CSV row and stable enough to rely on.

const fs = require('fs');
const path = require('path');
const { toRecord } = require('./youtube');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** `Watch later-videos.csv` → `Watch later`. The suffix is Takeout's, not the user's. */
function playlistNameFromFile(file) {
  return path.basename(file, '.csv')
    .replace(/-videos$/i, '')
    .replace(/\s+playlist$/i, '')
    .trim() || 'YouTube playlist';
}

function splitRow(line) {
  // Takeout quotes fields containing commas; playlist rows rarely do, but a
  // title in a header block will.
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseCsv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }

  const folder = playlistNameFromFile(file);
  const seen = new Set();
  const records = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = splitRow(line);
    const id = cells.find(c => VIDEO_ID.test(c));
    if (!id || seen.has(id)) continue;
    // A header row can contain an 11-char word; requiring a plausible date or a
    // first-column match keeps "Description" style rows out.
    const looksLikeHeader = /video id|playlist id|timestamp/i.test(line) && cells[0] !== id;
    if (looksLikeHeader) continue;
    seen.add(id);

    const stamp = cells.find(c => /^\d{4}-\d{2}-\d{2}/.test(c)) || null;
    records.push(toRecord(id, {}, { folder, savedAt: stamp ? new Date(stamp).toISOString() : null }));
  }
  return records;
}

/** Find playlist CSVs under an unzipped Takeout folder (or accept one CSV directly). */
function findPlaylistCsvs(root, { maxDepth = 6, limit = 200 } = {}) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length && out.length < limit) {
    const [dir, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) stack.push([full, depth + 1]); }
      else if (e.name.toLowerCase().endsWith('.csv')) out.push(full);
    }
  }
  return out;
}

/**
 * Read a Takeout export into records, optionally limited to named playlists.
 *
 * Same two-phase shape as the Instagram import: the caller can look at
 * `playlists` first and come back with the handful it actually wants.
 */
function readTakeout(target, { only = null } = {}) {
  const stat = fs.statSync(target);
  const files = stat.isDirectory() ? findPlaylistCsvs(target) : [target];
  if (!files.length) throw new Error('No playlist .csv files found in there');

  const byPlaylist = {};
  for (const file of files) {
    const name = playlistNameFromFile(file);
    const recs = parseCsv(file);
    if (!recs.length) continue;
    byPlaylist[name] = (byPlaylist[name] || []).concat(recs);
  }

  const playlists = Object.fromEntries(Object.entries(byPlaylist).map(([k, v]) => [k, v.length]));
  const wanted = only && only.length ? only : Object.keys(byPlaylist);

  // One video in three playlists is one bookmark carrying three folders.
  const merged = new Map();
  for (const name of wanted) {
    for (const rec of byPlaylist[name] || []) {
      const prev = merged.get(rec.id);
      if (prev) prev.folderNames = [...new Set([...prev.folderNames, ...rec.folderNames])];
      else merged.set(rec.id, rec);
    }
  }

  return { files: files.map(f => path.basename(f)), playlists, records: [...merged.values()] };
}

module.exports = { readTakeout, parseCsv, findPlaylistCsvs, playlistNameFromFile };
