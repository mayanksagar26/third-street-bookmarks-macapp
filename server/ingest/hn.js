// ─────────────────────────────────────────────────────────────────────────────
// Hacker News.
//
// Unlike X, Instagram and YouTube, this is not a mirror of things you already
// saved — there is nothing on HN's side to sync. It is a *browse* source: you
// read the front page and decide what's worth keeping.
//
// That distinction is the whole design. If the front page landed in your
// collection every morning, 30 stories a day would bury the things you actually
// chose, and the unread count would stop meaning anything inside a week. So
// browsing hits the API live and stores nothing; only an explicit save writes.
//
// Reads go through Algolia rather than the Firebase API: the front page arrives
// in one request with points, author and comment count attached, where Firebase
// needs one call for the id list plus one per item.
// ─────────────────────────────────────────────────────────────────────────────

const { fetchJson } = require('./net');

const ALGOLIA = 'https://hn.algolia.com/api/v1';

/**
 * What counts as AI for the AI tab.
 *
 * Deliberately a keyword list and not a model call: this runs on every tab
 * switch, and spending an agent round-trip to decide whether a title containing
 * "GPT-5" is about AI is the kind of cleverness that makes a UI feel slow.
 */
const AI_PATTERN = new RegExp([
  '\\bAI\\b', '\\bAGI\\b', '\\bLLMs?\\b', '\\bML\\b', 'machine learning',
  'neural', 'transformer', 'diffusion', 'embedding', 'inference',
  'GPT', 'Claude', 'Anthropic', 'OpenAI', 'Gemini', 'Llama', 'Mistral',
  'DeepSeek', 'Qwen', 'Hugging ?Face', 'PyTorch', 'TensorFlow',
  'fine.?tun', 'prompt', 'RAG\\b', 'agentic', '\\bagents?\\b',
  'copilot', 'chatbot', 'deep learning', 'reinforcement learning',
].join('|'), 'i');

function isAI(hit) {
  return AI_PATTERN.test(`${hit.title || ''} ${hit.story_text || ''} ${(hit._tags || []).join(' ')}`);
}

function hnUrl(id) {
  return `https://news.ycombinator.com/item?id=${id}`;
}

/**
 * One Algolia hit → the app's shared bookmark shape.
 *
 * `url` is the story's own destination when it has one and the HN thread when
 * it doesn't (an Ask HN has no external link). `commentsUrl` is always the
 * thread, because on HN the comments are frequently the reason to save it.
 */
function toRecord(hit, { savedAt } = {}) {
  const rawId = String(hit.objectID);
  const points = hit.points ?? 0;
  const comments = hit.num_comments ?? 0;
  const now = new Date().toISOString();
  return {
    id: `hn:${rawId}`,
    rawId,
    source: 'hn',
    sourceLabel: 'Hacker News',
    url: hit.url || hnUrl(rawId),
    commentsUrl: hnUrl(rawId),
    title: hit.title || hit.story_title || '(untitled)',
    text: htmlToText(hit.story_text || hit.comment_text || ''),
    authorHandle: hit.author || null,
    authorName: hit.author || null,
    authorProfileImageUrl: null,
    thumbnailUrl: null,
    domain: hit.url ? safeHost(hit.url) : 'news.ycombinator.com',
    postedAt: hit.created_at || now,
    bookmarkedAt: savedAt || now,
    syncedAt: now,
    // Feeds the existing sort bar: HN points and comments are the closest
    // analogue to likes and replies, so the same controls keep working.
    likeCount: points,
    replyCount: comments,
    repostCount: 0,
    bookmarkCount: 0,
    points,
    commentCount: comments,
    categories: [],
    primaryCategory: null,
    folderNames: [],
    folderIds: [],
    isRead: false,
    favFolders: [],
    favFolder: null,
    colorLabel: null,
    note: null,
  };
}

/**
 * Algolia returns story and comment bodies as HTML.
 *
 * The feed renders bookmark text through `dangerouslySetInnerHTML` after
 * escaping it, so an HTML body arrived on screen as literal `&#x2F;` and
 * `<a href=…>` markup. Flattening to text here keeps the escaping honest and
 * means every source hands the card the same kind of string.
 */
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/?\s*p\s*>/gi, '\n\n')
    // Remaining tags become a space, not nothing: HN bodies are full of
    // `</a><p>` boundaries, and deleting them outright welded the end of a link
    // onto the start of the next sentence ("…gpt-6-astraRelated ongoing").
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; }
}

/**
 * Fetch a tab's worth of stories.
 *
 *   front — the actual front page right now
 *   new   — recent stories, unfiltered
 *   ai    — recent stories with a points floor, filtered to AI subject matter
 *
 * The AI tab casts a wide net server-side (a week, 20+ points, up to 200 hits)
 * and narrows locally, because Algolia's query parameter is full-text search
 * over one string and cannot express "any of these thirty terms".
 */
async function topStories({ tab = 'front', limit = 30 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 30, 1), 100);

  if (tab === 'front') {
    const data = await fetchJson(`${ALGOLIA}/search?tags=front_page&hitsPerPage=${cap}`);
    return (data.hits || []).map(h => toRecord(h));
  }

  if (tab === 'new') {
    const data = await fetchJson(`${ALGOLIA}/search_by_date?tags=story&hitsPerPage=${cap}`);
    return (data.hits || []).map(h => toRecord(h));
  }

  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const data = await fetchJson(
    `${ALGOLIA}/search?tags=story&numericFilters=created_at_i>${weekAgo},points>20&hitsPerPage=200`,
  );
  return (data.hits || [])
    .filter(isAI)
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .slice(0, cap)
    .map(h => toRecord(h));
}

/** Re-fetch one story by id, so a save records current points rather than stale ones. */
async function storyById(id) {
  const hit = await fetchJson(`${ALGOLIA}/items/${encodeURIComponent(id)}`);
  return toRecord({
    objectID: hit.id,
    title: hit.title,
    url: hit.url,
    author: hit.author,
    points: hit.points,
    num_comments: countComments(hit),
    created_at: hit.created_at,
    story_text: hit.text,
  });
}

function countComments(node) {
  const kids = node.children || [];
  return kids.reduce((n, k) => n + 1 + countComments(k), 0);
}

module.exports = { topStories, storyById, toRecord, isAI, AI_PATTERN, htmlToText };
