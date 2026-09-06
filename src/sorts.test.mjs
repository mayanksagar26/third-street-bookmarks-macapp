// Which sorts a view is allowed to offer.
//
// A control that re-orders nothing is worse than one that isn't there: every
// source used to get X's six, so a Hacker News view offered "Most Reposted"
// and an Instagram one "Most Bookmarked", over rows that all report zero.

import test from 'node:test';
import assert from 'node:assert';
import { SOURCE_SCHEMA, sortsForSources } from './source-schema.js';

const getBookmarkSource = id => SOURCE_SCHEMA[id] || SOURCE_SCHEMA.link;

const keys = ids => sortsForSources(ids).map(s => s.key);
const labels = ids => sortsForSources(ids).map(s => s.label);

test('X keeps the sorts X actually reports', () => {
  assert.deepEqual(keys(['x']), ['newest', 'oldest', 'likes', 'bookmarks', 'reposts', 'author']);
});

test('Hacker News is not offered reposts or bookmarks', () => {
  const k = keys(['hn']);
  assert.ok(!k.includes('reposts'), 'HN has no reposts');
  assert.ok(!k.includes('bookmarks'), 'HN has no bookmark count');
  assert.ok(k.includes('likes') && k.includes('replies'));
});

test('a single source names its own metric', () => {
  assert.ok(labels(['hn']).includes('Most Points'), 'points, not likes');
  assert.ok(labels(['hn']).includes('Most Comments'));
  assert.ok(labels(['yt']).includes('By Channel'));
  assert.ok(labels(['ig']).includes('By Account'));
});

test('a mixed feed falls back to neutral labels', () => {
  // "Most Points" over a list containing tweets would be wrong.
  assert.ok(labels(['x', 'hn']).includes('Most Liked'));
  assert.ok(!labels(['x', 'hn']).includes('Most Points'));
});

test('export-only sources offer just date and author', () => {
  for (const id of ['yt', 'ig', 'link']) {
    assert.deepEqual(keys([id]), ['newest', 'oldest', 'author'], id);
  }
});

test('a mixed feed offers the union, in a stable order', () => {
  const k = keys(['x', 'hn', 'ig']);
  assert.deepEqual(k, ['newest', 'oldest', 'likes', 'bookmarks', 'reposts', 'replies', 'author']);
});

test('no source selected still yields something usable', () => {
  assert.ok(keys([]).length >= 3);
});

// ── Card metrics ─────────────────────────────────────────────────────────────

test('only X declares the four X counters', () => {
  assert.deepEqual(
    getBookmarkSource('x').metrics.map(m => m.field),
    ['replyCount', 'repostCount', 'likeCount', 'bookmarkCount'],
  );
});

test('Hacker News declares points and comments, under its own names', () => {
  const m = getBookmarkSource('hn').metrics;
  assert.deepEqual(m.map(x => x.icon), ['points', 'comment']);
  assert.equal(m[0].title, 'points');
});

test('sources whose exports carry no engagement declare none', () => {
  // Zeros for four counters made every video look like nobody had watched it.
  for (const id of ['yt', 'ig', 'link']) {
    assert.deepEqual(getBookmarkSource(id).metrics, [], id);
  }
});
