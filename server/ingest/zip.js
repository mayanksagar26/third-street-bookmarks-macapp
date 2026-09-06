// ─────────────────────────────────────────────────────────────────────────────
// Pulling the useful few files out of a platform export.
//
// An Instagram archive is the whole account: every photo you have posted, your
// messages, your login history, your ad interests. The part this app wants is
// two JSON files somewhere inside it. Unzipping the archive and keeping it
// would mean the app's data directory quietly becoming a copy of your entire
// Instagram account, which is not a thing a bookmark manager should hold.
//
// So extraction is selective. `unzip` takes a glob and writes only the entries
// that match; everything else is never decompressed at all, let alone stored.
//
// `unzip` rather than a library because this is a macOS app and /usr/bin/unzip
// is always there — a zip dependency would be a parser for hostile binary input
// in a project whose only other native dependency is SQLite.
//
// `-j` (junk paths) is load-bearing beyond tidiness: it discards the directory
// part of every entry name, so an archive containing `../../../.ssh/id_rsa`
// writes `id_rsa` into the destination instead of escaping it. That is the
// standard defence against zip-slip, and it is why the destination is the only
// path this module ever composes.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * What is worth taking out of each platform's archive.
 *
 * Tried in order, stopping at the first that yields anything, so the narrow
 * pattern wins when the export has the shape we expect and the broad one still
 * catches a layout that has been renamed since.
 */
const PATTERNS = {
  ig: [['*saved_*.json'], ['*saved*.json']],
  yt: [['*playlists/*.csv', '*Playlists/*.csv'], ['*.csv']],
};

/**
 * unzip's own messages name the temporary file we streamed the upload into,
 * which is an internal path the person who dropped a file has no use for and
 * no business seeing. These say what went wrong in terms of the thing they
 * actually handed over.
 */
function friendlyUnzipError(code) {
  if (code === 9) return 'That file is not a zip archive.';
  if (code === 2 || code === 3) return 'That archive looks damaged — try downloading the export again.';
  if (code === 4 || code === 5 || code === 6 || code === 7) return 'Ran out of memory reading that archive.';
  if (code === 50) return 'Ran out of disk space while reading that archive.';
  return 'Could not read that archive.';
}

function runUnzip(zipPath, patterns, destDir, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    // Array args, never a shell string: an archive path is a value, not code.
    const proc = spawn('/usr/bin/unzip', ['-o', '-j', zipPath, ...patterns, '-d', destDir]);
    let err = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('unzip timed out')); }, timeoutMs);
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => { clearTimeout(timer); reject(new Error(`could not run unzip: ${e.message}`)); });
    proc.on('close', code => {
      clearTimeout(timer);
      // 11 is "no matching files", which is a real answer here rather than a
      // failure — it means this pattern found nothing and the next should run.
      if (code === 0 || code === 11) resolve(code);
      else reject(new Error(friendlyUnzipError(code)));
    });
  });
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch { return []; }
}

/**
 * Extract just the wanted entries of an archive into `destDir`.
 *
 * The destination is emptied first: an export means "this is my account now",
 * and files left from a previous one would resurrect posts you have since
 * unsaved with no way to tell where they came from.
 */
async function extractWanted(zipPath, source, destDir, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const patternSets = PATTERNS[source];
  if (!patternSets) throw new Error(`No extraction rules for ${source}`);

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  let files = [];
  for (const patterns of patternSets) {
    await runUnzip(zipPath, patterns, destDir);
    files = listFiles(destDir);
    if (files.length) break;
  }

  if (!files.length) {
    throw new Error('No saved-content files in that archive — is it the right export?');
  }

  // A guard rather than an expectation: these files are lists of URLs and
  // should be small, so anything huge means the pattern matched the wrong thing
  // and the directory is filling with something we did not intend to keep.
  let total = 0;
  for (const name of files) total += fs.statSync(path.join(destDir, name)).size;
  if (total > maxBytes) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw new Error('That archive matched far more than expected — nothing was kept');
  }

  return { files, bytes: total };
}

module.exports = { extractWanted, PATTERNS };
