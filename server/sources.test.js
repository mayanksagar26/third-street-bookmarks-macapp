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
