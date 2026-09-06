// Tests for the multi-source ingest layer.
//
// Scoped deliberately: the parsers and the merge rules, not the routes. Those
// are the parts with real logic, and both bugs found while building this lived
// here — a Takeout import wiping a title an oEmbed lookup had already found,
// and Hacker News HTML arriving on a card as literal `&#x2F;` markup.
//
//   node --test server/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./sources-store');
const hn = require('./ingest/hn');
const yt = require('./ingest/youtube');
const ytTakeout = require('./ingest/youtube-takeout');
const instagram = require('./ingest/instagram');
const { canonical } = require('./ingest/link');
const { buildAgentArgs, CLAUDE_DENIED_TOOLS } = require('./agent-run');
const { safeUploadName } = require('./security');
const { extractWanted } = require('./ingest/zip');
const { execFileSync } = require('child_process');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-test-'));
}

// ── Id namespacing ───────────────────────────────────────────────────────────

test('ids are namespaced per source and round-trip', () => {
  assert.equal(store.nsId('hn', '38104219'), 'hn:38104219');
  assert.equal(store.nsId('hn', 'hn:38104219'), 'hn:38104219', 'idempotent');
  assert.deepEqual(store.splitId('yt:dQw4w9WgXcQ'), { source: 'yt', rawId: 'dQw4w9WgXcQ' });
});

test('a bare id is X — that is every id written before this existed', () => {
  assert.deepEqual(store.splitId('1789012345'), { source: 'x', rawId: '1789012345' });
});

test('an unknown prefix is not treated as a source', () => {
  // Otherwise a tweet whose id somehow contained a colon would vanish from the
  // feed instead of showing up as X.
  assert.deepEqual(store.splitId('evil:123'), { source: 'x', rawId: 'evil:123' });
});

test('the same number from two sources stays two bookmarks', () => {
  assert.notEqual(store.nsId('hn', '12345'), store.nsId('x', '12345'));
});

// ── Merge semantics ──────────────────────────────────────────────────────────

test('a metadata-poor source does not overwrite a rich one', () => {
  const rich = { id: 'yt:a', title: 'Real Title', thumbnailUrl: 'https://i/x.jpg', folderNames: [] };
  const poor = { id: 'yt:a', title: null, thumbnailUrl: null, folderNames: ['Watch later'] };
  const merged = store.mergeRecord(rich, poor);
  assert.equal(merged.title, 'Real Title');
  assert.equal(merged.thumbnailUrl, 'https://i/x.jpg');
});

test('folders union across imports rather than replacing', () => {
  const a = { id: 'yt:a', folderNames: ['AI Talks'] };
  const b = { id: 'yt:a', folderNames: ['Watch later'] };
  assert.deepEqual(store.mergeRecord(a, b).folderNames.sort(), ['AI Talks', 'Watch later']);
});

test('the earlier save date wins — when you kept it is yours', () => {
  const a = { id: 'yt:a', bookmarkedAt: '2022-01-01T00:00:00Z' };
  const b = { id: 'yt:a', bookmarkedAt: '2024-06-01T00:00:00Z' };
  assert.equal(store.mergeRecord(a, b).bookmarkedAt, '2022-01-01T00:00:00Z');
});

test('upsert is idempotent — re-importing is the normal case', () => {
  const dir = tmpdir();
  const rec = [{ id: 'hn:1', rawId: '1', title: 'x', folderNames: [] }];
  assert.equal(store.upsertSource(dir, 'hn', rec).added, 1);
  assert.equal(store.upsertSource(dir, 'hn', rec).added, 0);
  assert.equal(store.readSource(dir, 'hn').length, 1);
});

test('writeAll routes records back to the file each came from', () => {
  const dir = tmpdir();
  let wroteX = null;
  store.writeAll(dir, [
    { id: 'x:1', source: 'x', title: 't' },
    { id: 'hn:2', source: 'hn', title: 'u' },
  ], data => { wroteX = data; });
  assert.equal(wroteX.length, 1);
  assert.equal(wroteX[0].id, '1', 'the namespace is stripped so `ft` still recognises its file');
  assert.equal(store.readSource(dir, 'hn').length, 1);
});

// ── Hacker News ──────────────────────────────────────────────────────────────

test('HTML bodies are flattened to text', () => {
  // HN renders the URL as the link text, not just the href — that visible copy
  // is the part that has to survive, entity-decoded.
  const out = hn.htmlToText('Card: <a href="/x" rel="nofollow">https:&#x2F;&#x2F;x.com&#x2F;a<&#x2F;a>');
  assert.ok(!out.includes('<'), 'no markup survives');
  assert.ok(out.includes('https://x.com/a'), 'hex entities decode');
});

test('an href is dropped rather than shown as text', () => {
  assert.equal(hn.htmlToText('<a href="https://tracker.example">click</a>'), 'click');
});

test('stripping a tag leaves a word boundary', () => {
  // `</a><p>` deleted outright welded "…astra" onto "Related".
  assert.ok(/astra\s+Related/.test(hn.htmlToText('<a>astra</a><p>Related')));
});

test('the AI filter catches model names, not just the word AI', () => {
  assert.ok(hn.isAI({ title: 'Claude Opus 5 released' }));
  assert.ok(hn.isAI({ title: 'Fine-tuning Llama on one GPU' }));
  assert.ok(!hn.isAI({ title: 'A new CSS layout algorithm' }));
});

// ── YouTube ──────────────────────────────────────────────────────────────────

test('video ids survive every share shape YouTube hands out', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=TRACKINGPARAM',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
  ]) {
    assert.equal(yt.videoId(url), 'dQw4w9WgXcQ', url);
  }
});

test('a non-YouTube URL yields no video id', () => {
  assert.equal(yt.videoId('https://vimeo.com/12345'), null);
  assert.equal(yt.videoId('https://notyoutube.com/watch?v=abc'), null);
});

test('durations render the way a card shows them', () => {
  assert.equal(yt.humanDuration('PT4M13S'), '4:13');
  assert.equal(yt.humanDuration('PT1H2M13S'), '1:02:13');
  assert.equal(yt.humanDuration(null), null);
});

test('Takeout CSVs merge one video across playlists', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'Watch later-videos.csv'),
    'Video ID,Playlist Video Creation Timestamp\ndQw4w9WgXcQ,2023-04-01T10:00:00+00:00\n');
  fs.writeFileSync(path.join(dir, 'AI Talks-videos.csv'),
    'Video ID,Playlist Video Creation Timestamp\ndQw4w9WgXcQ,2022-01-01T10:00:00+00:00\n');
  const { playlists, records } = ytTakeout.readTakeout(dir);
  assert.deepEqual(Object.keys(playlists).sort(), ['AI Talks', 'Watch later']);
  assert.equal(records.length, 1, 'one video in two playlists is one bookmark');
  assert.deepEqual(records[0].folderNames.sort(), ['AI Talks', 'Watch later']);
});

test('only the named playlists are imported', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'Keep-videos.csv'), 'Video ID\ndQw4w9WgXcQ\n');
  fs.writeFileSync(path.join(dir, 'Skip-videos.csv'), 'Video ID\naaaaaaaaaaa\n');
  const { records } = ytTakeout.readTakeout(dir, { only: ['Keep'] });
  assert.equal(records.length, 1);
  assert.equal(records[0].rawId, 'dQw4w9WgXcQ');
});

// ── Instagram ────────────────────────────────────────────────────────────────

function igFixture() {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'saved_posts.json'), JSON.stringify({
    saved_saved_media: [
      { title: 'naval', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/p/ABC123xyz/', timestamp: 1699999999 } } },
      { title: 'pmarca', string_map_data: { 'Saved on': { href: 'https://www.instagram.com/reel/DEF456uvw/', timestamp: 1700000999 } } },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'saved_collections.json'), JSON.stringify({
    saved_saved_collections: [
      { title: 'Design Refs', string_map_data: { 'Added Time': { timestamp: 1700111111 }, Photo: { href: 'https://www.instagram.com/p/ABC123xyz/' } } },
    ],
  }));
  return dir;
}

test('collections and authors come from the right file', () => {
  // The container key decides what `title` means. Getting it backwards puts
  // usernames in the sidebar where collection names belong.
  const { collections, records } = instagram.readExport(igFixture());
  assert.equal(collections['Design Refs'], 1);
  const filed = records.find(r => r.rawId === 'ABC123xyz');
  assert.deepEqual(filed.folderNames, ['Design Refs']);
  assert.equal(filed.authorHandle, 'naval', 'author survives the merge with the collections file');
});

test('picking one collection imports only that one', () => {
  const { records } = instagram.readExport(igFixture(), { only: ['Design Refs'] });
  assert.equal(records.length, 1);
});

test('reels and posts both resolve to a shortcode', () => {
  const { records } = instagram.readExport(igFixture());
  assert.ok(records.some(r => r.rawId === 'DEF456uvw'));
});

test('no thumbnail is recorded — the CDN links expire within days', () => {
  const { records } = instagram.readExport(igFixture());
  assert.ok(records.every(r => r.thumbnailUrl === null));
});

// ── Read and favourite state across sources ─────────────────────────────────
//
// These are the operations a namespaced id has to survive. A colon in the id
// travels through a URL path (`/api/read/hn:49550772`), a SQLite primary key,
// and a `find` over the merged list, and a break anywhere in that chain looks
// to the user like "marking it read did nothing".

test('a namespaced id is a legal single URL path segment', () => {
  for (const id of ['x:1789012345', 'hn:49550772', 'yt:dQw4w9WgXcQ', 'link:f68066d5', 'ig:ABC_-123']) {
    const url = new URL(`http://127.0.0.1/api/read/${id}`);
    assert.equal(decodeURIComponent(url.pathname.split('/').pop()), id, id);
  }
});

test('every source produces ids that survive a round trip through the store', () => {
  const dir = tmpdir();
  const recs = [
    { id: 'hn:1', rawId: '1', folderNames: [] },
    { id: 'yt:dQw4w9WgXcQ', rawId: 'dQw4w9WgXcQ', folderNames: [] },
    { id: 'ig:ABC_-123', rawId: 'ABC_-123', folderNames: [] },
    { id: 'link:deadbeef', rawId: 'deadbeef', folderNames: [] },
  ];
  for (const r of recs) {
    const source = store.splitId(r.id).source;
    store.upsertSource(dir, source, [r]);
    const back = store.readSource(dir, source).find(x => x.id === r.id);
    assert.ok(back, `${r.id} did not come back`);
    assert.equal(store.normalizeManaged(back, source).id, r.id, 'id is stable across normalise');
  }
});

test('merging a re-save does not resurrect an item as unread', () => {
  // Saving the same HN story twice must not clear the read state you set — the
  // incoming record always carries isRead:false, and `false` is a real value
  // rather than an absent one.
  const merged = store.mergeRecord(
    { id: 'hn:1', isRead: true, folderNames: [] },
    { id: 'hn:1', isRead: false, folderNames: [] },
  );
  assert.equal(merged.isRead, true);
});

test('an ingest never writes favourites, notes or labels either', () => {
  const mine = {
    id: 'yt:a', isRead: true, favFolders: ['To Watch'], favFolder: 'To Watch',
    note: 'start at 4:20', colorLabel: 'amber', folderNames: [],
  };
  const incoming = {
    id: 'yt:a', isRead: false, favFolders: [], favFolder: null,
    note: null, colorLabel: null, title: 'A better title', folderNames: [],
  };
  const merged = store.mergeRecord(mine, incoming);
  assert.equal(merged.favFolder, 'To Watch');
  assert.deepEqual(merged.favFolders, ['To Watch']);
  assert.equal(merged.note, 'start at 4:20');
  assert.equal(merged.colorLabel, 'amber');
  assert.equal(merged.title, 'A better title', 'source-owned fields still update');
});

// ── Link canonicalisation ────────────────────────────────────────────────────

test('tracking parameters are stripped so one link stays one bookmark', () => {
  assert.equal(
    canonical('https://www.example.com/post/?utm_source=x&si=abc&id=7#frag'),
    'https://example.com/post?id=7',
  );
});

test('the same video shared two ways canonicalises the same', () => {
  assert.equal(
    yt.videoId('https://youtu.be/abc_-123XYZ?si=one'),
    yt.videoId('https://www.youtube.com/watch?v=abc_-123XYZ&t=90'),
  );
});


// ── Agent permissions ────────────────────────────────────────────────────────
//
// Every prompt this app builds contains text a stranger wrote, so which tools
// the CLI is refused is the part of the security model that actually holds.
// A regression here is silent and only visible in a shell history.

test('the default call denies every capability that reaches out or writes', () => {
  const args = buildAgentArgs('claude', 'hi');
  for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']) {
    assert.ok(args.includes(tool), `${tool} should be denied by default`);
  }
});

test('opting into web opens WebSearch and nothing else', () => {
  const args = buildAgentArgs('claude', 'hi', { web: true });
  assert.ok(!args.includes('WebSearch'), 'WebSearch is what web:true is for');
  // The one that matters: a fetch goes to a URL an attacker picks, a search
  // query goes to a search engine and comes back as results.
  assert.ok(args.includes('WebFetch'), 'WebFetch must stay denied even with web:true');
  for (const tool of ['Bash', 'Write', 'Edit', 'Task']) {
    assert.ok(args.includes(tool), `${tool} must stay denied with web:true`);
  }
});

test('the prompt is passed as text, not parsed as flags', () => {
  const args = buildAgentArgs('claude', '--help me');
  assert.equal(args[args.length - 2], '--', 'the terminator precedes the prompt');
  assert.equal(args[args.length - 1], '--help me');
});

test('codex stays read-only regardless of the web flag', () => {
  const plain = buildAgentArgs('codex', 'hi');
  const web = buildAgentArgs('codex', 'hi', { web: true });
  assert.deepEqual(plain, web);
  assert.ok(plain.includes('read-only'));
});


// ── Uploaded export file names ───────────────────────────────────────────────
//
// This route writes files to disk from a name the browser supplied, so the
// sanitiser is the only thing standing between an upload and an arbitrary
// write. Everything it rejects, it must reject by refusing rather than by
// rewriting — a rewritten name is a name someone can still steer.

test('a bare name with the right extension passes through', () => {
  assert.equal(safeUploadName('saved_posts.json', ['.json']), 'saved_posts.json');
  assert.equal(safeUploadName('Watch later-videos.csv', ['.csv']), 'Watch later-videos.csv');
});

test('traversal cannot escape the import directory', () => {
  assert.equal(safeUploadName('../../../.ssh/authorized_keys.json', ['.json']), 'authorized_keys.json');
  assert.equal(safeUploadName('..\\..\\windows\\evil.json', ['.json']), 'evil.json');
});

test('an absolute path is reduced to its basename', () => {
  assert.equal(safeUploadName('/etc/passwd.json', ['.json']), 'passwd.json');
});

test('a webkitdirectory relative path keeps only the file', () => {
  assert.equal(safeUploadName('Takeout/YouTube/playlists/Likes.csv', ['.csv']), 'Likes.csv');
});

test('the wrong extension is refused, not corrected', () => {
  assert.throws(() => safeUploadName('payload.sh', ['.json']), /not a \.json file/);
  assert.throws(() => safeUploadName('notes.csv', ['.json']), /not a \.json file/);
  assert.throws(() => safeUploadName('noextension', ['.json']));
});

test('shell metacharacters in a name are refused', () => {
  assert.throws(() => safeUploadName('a;rm -rf ~.json', ['.json']), /Unusual file name/);
  assert.throws(() => safeUploadName('$(whoami).json', ['.json']), /Unusual file name/);
  assert.throws(() => safeUploadName('a`id`.json', ['.json']), /Unusual file name/);
});

test('empty and dot names are refused', () => {
  for (const bad of ['', null, undefined, '.', '..', '   ']) {
    assert.throws(() => safeUploadName(bad, ['.json']));
  }
});


// ── Extracting a platform archive ────────────────────────────────────────────
//
// An Instagram export is the whole account. These tests are about what does
// *not* come out of it: the photos, the messages, and anything an archive
// claims lives outside the destination directory.

/** Build a zip from a {path: contents} map, using the `zip` that ships with macOS. */
function makeZip(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-zip-'));
  const build = path.join(root, 'build');
  for (const [rel, body] of Object.entries(entries)) {
    const full = path.join(build, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const zipPath = path.join(root, 'export.zip');
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: build });
  return zipPath;
}

const IG_ARCHIVE = {
  'your_instagram_activity/saved/saved_posts.json':
    '{"saved_saved_media":[{"title":"naval","string_map_data":{"Saved on":{"href":"https://www.instagram.com/p/AAA111/","timestamp":1717000000}}}]}',
  'your_instagram_activity/saved/saved_collections.json':
    '{"saved_saved_collections":[{"title":"Design Refs","string_map_data":{"Photo":{"href":"https://www.instagram.com/p/AAA111/"},"Added Time":{"timestamp":1717300000}}}]}',
  'media/posts/photo1.jpg': 'BINARYPHOTODATA',
  'media/posts/photo2.jpg': 'MOREPHOTODATA',
  'messages/inbox/thread.json': '{"messages":["private"]}',
  'ads_information/interests.json': '{"ads":["interest data"]}',
  'personal_information/profile.json': '{"email":"me@example.com"}',
};

test('only the saved-content files come out of a full account archive', async () => {
  const zip = makeZip(IG_ARCHIVE);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-out-'));
  const { files } = await extractWanted(zip, 'ig', dest);
  assert.deepEqual(files.sort(), ['saved_collections.json', 'saved_posts.json']);
});

test('photos, messages and profile data are never written to disk', async () => {
  const zip = makeZip(IG_ARCHIVE);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-out-'));
  await extractWanted(zip, 'ig', dest);
  const written = fs.readdirSync(dest);
  for (const leak of ['photo1.jpg', 'photo2.jpg', 'thread.json', 'interests.json', 'profile.json']) {
    assert.ok(!written.includes(leak), `${leak} should never be extracted`);
  }
  assert.equal(written.length, 2, 'nothing beyond the two saved files');
});

test('an archive entry cannot escape the destination', async () => {
  // Zip-slip. The traversal has to be written as a literal entry *name* inside
  // the archive — creating it through the filesystem would escape the build
  // directory during setup and never reach the zip at all, which is the trap
  // the first version of this test fell into.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-slip-'));
  const zip = path.join(root, 'evil.zip');
  // Named to match the extraction pattern, so this exercises the flattening
  // rather than just being skipped for not matching.
  const marker = path.join(root, 'saved_collections.json');
  execFileSync('python3', ['-c', [
    'import zipfile,sys',
    'z=zipfile.ZipFile(sys.argv[1],"w")',
    'z.writestr("keep_saved_posts.json",\'{"saved_saved_media":[]}\')',
    'z.writestr(sys.argv[2],"{}")',
    'z.close()',
  ].join('\n'), zip, `../../../../../../../..${marker}`]);

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-out-'));
  await extractWanted(zip, 'ig', dest);

  assert.ok(!fs.existsSync(marker), 'nothing was written outside the destination');
  assert.ok(fs.readdirSync(dest).includes('saved_collections.json'),
    'the traversal was flattened into the destination rather than followed');
});

test('an archive with nothing relevant is refused rather than half-imported', async () => {
  const zip = makeZip({ 'readme.txt': 'hello', 'media/photo.jpg': 'data' });
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-out-'));
  await assert.rejects(() => extractWanted(zip, 'ig', dest), /No saved_posts or saved_collections/);
});

test('a file that is not a zip fails without leaking the temp path', async () => {
  const notZip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-nz-')), 'x.zip');
  fs.writeFileSync(notZip, 'this is not a zip archive');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-out-'));
  await assert.rejects(
    () => extractWanted(notZip, 'ig', dest),
    (e) => /not a zip archive/.test(e.message) && !/\/tmp|\.upload-/.test(e.message),
  );
});

test('a second archive replaces the first rather than merging into it', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-out-'));
  await extractWanted(makeZip(IG_ARCHIVE), 'ig', dest);
  await extractWanted(makeZip({ 'saved_posts.json': '{"saved_saved_media":[]}' }), 'ig', dest);
  assert.deepEqual(fs.readdirSync(dest), ['saved_posts.json'],
    'the previous export’s collections file is gone, not left behind');
});

test('Takeout playlists are pulled from a YouTube archive', async () => {
  const zip = makeZip({
    'Takeout/YouTube and YouTube Music/playlists/Watch later-videos.csv': 'Video ID\ndQw4w9WgXcQ\n',
    'Takeout/YouTube and YouTube Music/videos/myvideo.mp4': 'VIDEODATA',
    'Takeout/archive_browser.html': '<html></html>',
  });
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-out-'));
  const { files } = await extractWanted(zip, 'yt', dest);
  assert.deepEqual(files, ['Watch later-videos.csv']);
});


// ── Instagram's HTML export ──────────────────────────────────────────────────
//
// The download page hands you HTML unless you notice the format switch, so this
// is the shape a real export actually has. The JSON-only parser this started
// with matched none of it and reported the archive as the wrong one.
//
// The markup below is Meta's, reduced to the parts the parser keys on: nested
// `div.pam` blocks whose leaves are two-column label/value tables, with a
// `Name` + `Type` pair opening each collection.

function igCell(label, value) {
  return `<td class="_a6_q">${label}</td><td class="_2piu _a6_r">${value}</td>`;
}

function igItem(shortcode, username) {
  // Meta's real shape: the link sits in a full-width `_a6_q` cell with no value
  // cell beside it, which is precisely why the label/value pattern steps over
  // it and the URL alternative gets to claim it. It appears twice — once as the
  // href, once as the anchor text.
  const url = `https://www.instagram.com/p/${shortcode}/`;
  return '<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_a6-p"><table style="table-layout: fixed;">' +
    `<tr><td colspan="2" class="_a6_q">URL<div><a target="_blank" href="${url}">${url}</a></div></td></tr>` +
    `<tr>${igCell('Caption', 'some caption text')}</tr>` +
    `<tr>${igCell('Name', 'Display Name')}</tr>` +
    `<tr>${igCell('Username', username)}</tr>` +
    '</table></div></div>';
}

function igCollectionsHtml(collections) {
  const body = collections.map(([name, items]) =>
    '<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_a6-p"><table>' +
    `<tr>${igCell('Name', name)}</tr>` +
    `<tr>${igCell('Type', 'Default')}</tr>` +
    `<tr>${igCell('Privacy', 'Private')}</tr>` +
    `<tr>${igCell('Update time', 'Dec 02, 2025')}</tr>` +
    '</table>' + items.map(([c, u]) => igItem(c, u)).join('') + '</div></div>',
  ).join('');
  return `<html><body><div class="pam"><h2>Media</h2>${body}</div></body></html>`;
}

function writeIgHtml(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-ightml-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test('an HTML export is parsed, not just JSON', () => {
  const dir = writeIgHtml({
    'saved_collections.html': igCollectionsHtml([['Design Refs', [['AAA111aaa', 'designmilk']]]]),
  });
  const { collections, records } = instagram.readExport(dir);
  assert.equal(collections['Design Refs'], 1);
  assert.equal(records[0].rawId, 'AAA111aaa');
  assert.equal(records[0].authorHandle, 'designmilk');
});

test('a Name row only opens a collection when Type follows it', () => {
  // In saved_posts.html the same label is the *owner's* display name. Treating
  // it as a collection would turn every account you saved from into a folder.
  const dir = writeIgHtml({
    'saved_posts.html':
      `<html><body>${igItem('BBB222bbb', 'naval')}${igItem('CCC333ccc', 'pmarca')}</body></html>`,
  });
  const { collections, records } = instagram.readExport(dir);
  assert.deepEqual(Object.keys(collections), ['All Saved']);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(r => r.authorHandle).sort(), ['naval', 'pmarca']);
});

test('items are attributed to the collection they sit under', () => {
  const dir = writeIgHtml({
    'saved_collections.html': igCollectionsHtml([
      ['Design Refs', [['AAA111aaa', 'designmilk'], ['BBB222bbb', 'swissmiss']]],
      ['Space', [['CCC333ccc', 'nasa']]],
    ]),
  });
  const { collections } = instagram.readExport(dir);
  assert.equal(collections['Design Refs'], 2);
  assert.equal(collections['Space'], 1);
});

test('the duplicated link per item is counted once', () => {
  const dir = writeIgHtml({
    'saved_collections.html': igCollectionsHtml([['Solo', [['AAA111aaa', 'naval']]]]),
  });
  assert.equal(instagram.readExport(dir).records.length, 1);
});

test('a cell capture cannot swallow the links between cells', () => {
  // The bug this replaced: a plain non-greedy capture reached past its own
  // </td> hunting for a value cell, absorbing whole nested tables — and every
  // post link inside them — into one nonsense token.
  const rows = instagram.parseHtml.length; // arity check keeps the export honest
  assert.equal(rows, 2);
  const dir = writeIgHtml({
    'saved_collections.html': igCollectionsHtml([['Big', [
      ['AAA111aaa', 'a'], ['BBB222bbb', 'b'], ['CCC333ccc', 'c'],
    ]]]),
  });
  assert.equal(instagram.readExport(dir).collections['Big'], 3);
});

test('saved_music is not treated as saved posts', () => {
  const dir = writeIgHtml({
    'saved_collections.html': igCollectionsHtml([['Keep', [['AAA111aaa', 'naval']]]]),
    'saved_music.html': igCollectionsHtml([['Tracks', [['ZZZ999zzz', 'artist']]]]),
  });
  const { files, collections } = instagram.readExport(dir);
  assert.ok(!files.includes('saved_music.html'), 'the music list is not a saved-posts file');
  assert.ok(!collections['Tracks']);
});
