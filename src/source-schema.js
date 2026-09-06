// ─────────────────────────────────────────────────────────────────────────────
// What each source can actually be measured and sorted by.
//
// Data, not markup, and deliberately in its own file: the backend schema is
// uniform — every record carries the same fields — but the interface must only
// offer what a given source really reports. A tweet has reposts, a Hacker News
// story has points, an Instagram export has neither, and presenting all three
// everywhere invites you to sort by a number that is zero on every row.
//
// Separate from `bookmark-sources.jsx` because that file holds SVG icons and
// cannot be imported by a test runner.
// ─────────────────────────────────────────────────────────────────────────────

/** Every sort the feed knows how to do, and its neutral label. */
export const SORT_DEFS = {
  newest:    'Newest',
  oldest:    'Oldest',
  likes:     'Most Liked',
  bookmarks: 'Most Bookmarked',
  reposts:   'Most Reposted',
  replies:   'Most Replies',
  author:    'By Author',
};

export const SOURCE_SCHEMA = {
  x: {
    metrics: [
      { field: 'replyCount',    icon: 'reply' },
      { field: 'repostCount',   icon: 'repost' },
      { field: 'likeCount',     icon: 'like' },
      { field: 'bookmarkCount', icon: 'bookmark' },
    ],
    sorts: ['newest', 'oldest', 'likes', 'bookmarks', 'reposts', 'author'],
  },
  hn: {
    metrics: [
      { field: 'likeCount',  icon: 'points',  title: 'points' },
      { field: 'replyCount', icon: 'comment', title: 'comments' },
    ],
    sorts: ['newest', 'oldest', 'likes', 'replies', 'author'],
    sortLabels: { likes: 'Most Points', replies: 'Most Comments', author: 'By Poster' },
  },
  yt: {
    metrics: [],
    sorts: ['newest', 'oldest', 'author'],
    sortLabels: { author: 'By Channel' },
  },
  ig: {
    metrics: [],
    sorts: ['newest', 'oldest', 'author'],
    sortLabels: { author: 'By Account' },
  },
  link: {
    metrics: [],
    sorts: ['newest', 'oldest', 'author'],
    sortLabels: { author: 'By Site' },
  },
};

function schemaFor(id) {
  return SOURCE_SCHEMA[id] || SOURCE_SCHEMA.link;
}

/**
 * The sorts worth offering for a set of sources.
 *
 * The union of what the sources on screen support, in a stable order, so a
 * mixed feed keeps X's sorts while a Hacker News view drops the two that would
 * do nothing. Sorting by a field every visible row reports as zero is a control
 * that appears to be broken.
 */
export function sortsForSources(sourceIds) {
  const ids = sourceIds.length ? sourceIds : Object.keys(SOURCE_SCHEMA);
  const keys = new Set();
  for (const id of ids) for (const k of (schemaFor(id).sorts || [])) keys.add(k);
  const order = Object.keys(SORT_DEFS);
  return order.filter(k => keys.has(k)).map(key => ({
    key,
    // One source on screen gets to name its own metric; a mixed feed falls back
    // to the neutral label, since "Most Points" over tweets would be wrong.
    label: (ids.length === 1 && schemaFor(ids[0]).sortLabels?.[key]) || SORT_DEFS[key],
  }));
}
