// ─────────────────────────────────────────────────────────────────────────────
// "Find my bookmarks for me."
//
// Three stages, deliberately split by what each is actually good at:
//
//   1. scan     — a bounded filesystem walk turns up every plausible file
//   2. validate — parsing tells us which ones are really X bookmark exports
//   3. judge    — the user's AI CLI picks between the survivors and says why
//
// Stage 3 is the one people notice, but it is not the one doing the finding.
// Asking an agent to search a whole home directory is slow, non-deterministic,
// and blocked by permission prompts in print mode. Asking it to choose between
// four validated candidates is a question it answers well, in one turn, with a
// reason a human can check. When no CLI is installed the scan's own ranking is
// used and the feature degrades to "found it" without the explanation.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { agentEnv, buildAgentArgs, fenceUntrusted } = require('./agent-run');

const HOME = os.homedir();

/** Directories that never hold a user's bookmark export but cost a lot to walk. */
const SKIP_DIRS = new Set([
  'Library', 'Applications', 'System', 'Volumes', '.Trash', 'node_modules',
  '.git', '.svn', '.hg', '.cache', '.npm', '.cargo', '.rustup', '.nvm', '.bun',
  '.gradle', '.m2', '.docker', '.vscode', '.venv', 'venv', '__pycache__',
  'Photos Library.photoslibrary', 'dist', 'build', 'target', '.next',
  // Coding-agent working directories. They accumulate scratch copies of
  // whatever you've been editing, so they surface convincing duplicates of the
  // real thing — exactly the candidates worth not offering.
  '.claude', '.codex', '.cursor', '.gstack', '.continue', '.aider',
]);

/** Where an export realistically lives, best guesses first. */
const ROOTS = [
  path.join(HOME, '.ft-bookmarks'),
  path.join(HOME, '.tsb'),
  path.join(HOME, 'Downloads'),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Public'),
  path.join(HOME, 'Developer'),
  path.join(HOME, 'Projects'),
  path.join(HOME, 'code'),
  HOME,
];

const MAX_DEPTH = 5;
const MAX_DIRS = 6000;      // walk budget, so a huge home directory can't hang us
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const NAME_RE = /^bookmarks?[\w.-]*\.json$/i;

/** Fields that mark a record as an X/Twitter bookmark rather than some other JSON. */
const SIGNAL_FIELDS = [
  ['id', 'id_str', 'tweetId', 'tweet_id'],
  ['text', 'fullText', 'full_text', 'content'],
  ['authorHandle', 'author_handle', 'screenName', 'screen_name', 'username'],
  ['url', 'tweetUrl', 'permalink', 'link'],
  ['postedAt', 'posted_at', 'createdAt', 'created_at', 'date'],
];

function firstPresent(record, names) {
  return names.find(name => record[name] !== undefined && record[name] !== null);
}

/**
 * Walk the likely roots for files whose name looks like a bookmark export.
 *
 * Breadth-first with a hard directory budget: a deep tree gets sampled rather
 * than exhausted, and the roots are ordered so the budget is spent on the
 * likeliest places first.
 */
function scan(onProgress) {
  const found = [];
  const seenDirs = new Set();
  let dirsWalked = 0;

  for (const root of ROOTS) {
    if (dirsWalked >= MAX_DIRS) break;
    let queue = [{ dir: root, depth: 0 }];

    while (queue.length && dirsWalked < MAX_DIRS) {
      const { dir, depth } = queue.shift();

      let real;
      try {
        real = fs.realpathSync(dir);
      } catch {
        continue;
      }
      if (seenDirs.has(real)) continue;   // symlink loops, and roots nested in HOME
      seenDirs.add(real);
      dirsWalked++;

      if (dirsWalked % 250 === 0 && onProgress) {
        onProgress({ stage: 'scan', dirsWalked, found: found.length });
      }

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;      // permission denied on e.g. ~/Library subtrees
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth >= MAX_DEPTH) continue;
          if (SKIP_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith('.') && depth > 0) continue;
          queue.push({ dir: full, depth: depth + 1 });
        } else if (entry.isFile() && NAME_RE.test(entry.name)) {
          found.push(full);
        }
      }
    }
  }

  return { paths: [...new Set(found)], dirsWalked };
}

/**
 * Parse a candidate and score how much it looks like a bookmark export.
 *
 * Returns null for anything unparseable or structurally wrong — those are
 * dropped rather than shown, because a list of maybes is worse than a short
 * list of yeses.
 */
function validate(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }

  // Accept both a bare array and the common { bookmarks: [...] } wrapper.
  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.bookmarks)
      ? parsed.bookmarks
      : null;
  if (!records || records.length === 0) return null;

  const sample = records.slice(0, 25).filter(r => r && typeof r === 'object');
  if (sample.length === 0) return null;

  // Score on the fraction of signal fields present across the sample.
  let hits = 0;
  for (const group of SIGNAL_FIELDS) {
    const present = sample.filter(r => firstPresent(r, group)).length;
    if (present / sample.length > 0.5) hits++;
  }
  if (hits < 3) return null;   // three of five is the floor for "this is bookmarks"

  const first = sample[0];
  const handleKey = firstPresent(first, SIGNAL_FIELDS[2]);
  const textKey = firstPresent(first, SIGNAL_FIELDS[1]);
  const dateKey = firstPresent(first, SIGNAL_FIELDS[4]);

  const dates = sample
    .map(r => (dateKey ? Date.parse(r[dateKey]) : NaN))
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);

  return {
    path: filePath,
    count: records.length,
    sizeBytes: stat.size,
    modified: stat.mtime.toISOString(),
    signalScore: hits,
    classified: sample.filter(r => r.primaryCategory).length > 0,
    sampleHandle: handleKey ? String(first[handleKey]).slice(0, 40) : null,
    sampleText: textKey ? String(first[textKey]).replace(/\s+/g, ' ').slice(0, 120) : null,
    newest: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
    fields: Object.keys(first).slice(0, 18),
  };
}

/** Deterministic fallback ranking, and the tie-breaker the agent is judged against. */
function rankNatively(candidates) {
  return [...candidates].sort((a, b) => {
    if (b.signalScore !== a.signalScore) return b.signalScore - a.signalScore;
    if (a.classified !== b.classified) return a.classified ? -1 : 1;
    return b.count - a.count;
  });
}

/**
 * Ask the user's CLI which candidate is the real one.
 *
 * Only metadata and a single truncated sample line per file are sent, and only
 * to a process on this machine — the same trust boundary the Chat feature
 * already operates under.
 */
function askAgent({ runtime, binary, candidates, timeoutMs = 90_000 }) {
  return new Promise(resolve => {
    const summary = candidates.map((c, i) => ({
      index: i,
      path: c.path,
      count: c.count,
      sizeMB: +(c.sizeBytes / 1024 / 1024).toFixed(1),
      newestPost: c.newest,
      alreadyClassified: c.classified,
      fields: c.fields,
      sampleAuthor: c.sampleHandle,
      sampleText: c.sampleText,
    }));

    const prompt = [
      'You are helping a bookmarks app pick the right data file on this machine.',
      'Below are candidate JSON files that all parse as arrays of X/Twitter bookmarks.',
      'Pick the ONE that is most likely the user\'s primary, most complete, most current bookmark export.',
      'Prefer larger and more recent collections, and files that already carry category labels.',
      'Ignore samples, fixtures, and test data.',
      '',
      // Paths and sample text come off the disk, so anyone who can drop a file
      // in the home directory can put words in this prompt. Fence them.
      fenceUntrusted('candidate list', JSON.stringify(summary, null, 2)),
      '',
      'Reply with ONLY a JSON object, no prose and no code fence:',
      '{"index": <number>, "reason": "<one short sentence for the user>"}',
    ].join('\n');

    const args = buildAgentArgs(runtime, prompt);
    let output = '';
    let settled = false;

    const child = spawn(binary, args, { env: agentEnv() });

    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(null));
    child.on('close', () => {
      // Models wrap JSON in prose or fences often enough that a strict parse
      // would throw away good answers. Take the last balanced object.
      const matches = output.match(/\{[^{}]*"index"[^{}]*\}/g);
      if (!matches) return finish(null);
      try {
        const parsed = JSON.parse(matches[matches.length - 1]);
        const index = Number(parsed.index);
        if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
          return finish(null);
        }
        finish({ index, reason: String(parsed.reason || '').slice(0, 200) });
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * Full discovery run. `onEvent` receives progress objects as each stage lands,
 * so the UI can narrate rather than spin.
 */
async function discover({ runtime, binary, onEvent = () => {} }) {
  onEvent({ stage: 'scan', message: 'Scanning your files…' });
  const { paths, dirsWalked } = scan(onEvent);

  onEvent({
    stage: 'validate',
    message: `Checking ${paths.length} file${paths.length === 1 ? '' : 's'}…`,
    dirsWalked,
  });

  const candidates = rankNatively(paths.map(validate).filter(Boolean));

  if (candidates.length === 0) {
    onEvent({ stage: 'done', message: 'No bookmark files found.' });
    return { candidates: [], pick: null, reason: null, judgedBy: null };
  }

  if (candidates.length === 1 || !binary) {
    onEvent({ stage: 'done', message: 'Done.' });
    return {
      candidates,
      pick: candidates[0].path,
      reason: candidates.length === 1
        ? 'Only one bookmark export found on this machine.'
        : 'Picked the largest, most complete collection.',
      judgedBy: null,
    };
  }

  onEvent({
    stage: 'judge',
    message: `Asking ${runtime === 'codex' ? 'Codex' : 'Claude'} which one is yours…`,
    candidateCount: candidates.length,
  });

  const verdict = await askAgent({ runtime, binary, candidates });
  onEvent({ stage: 'done', message: 'Done.' });

  if (!verdict) {
    return {
      candidates,
      pick: candidates[0].path,
      reason: 'Picked the largest, most complete collection.',
      judgedBy: null,
    };
  }

  return {
    candidates,
    pick: candidates[verdict.index].path,
    reason: verdict.reason || 'Selected by your AI CLI.',
    judgedBy: runtime,
  };
}

module.exports = { discover, scan, validate, rankNatively };
