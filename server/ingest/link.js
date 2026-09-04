// Save any URL.
//
// The source that makes this a bookmark manager rather than three integrations:
// a paste box that keeps whatever you point it at. YouTube gets its own adapter
// because oEmbed gives better data than scraping; everything else lands here.
//
// Metadata comes from Open Graph tags with a <title> fallback. Parsing is
// regex-over-the-head rather than a DOM library because we only want four
// fields out of the first few KB, and adding a parser dependency to a
// native-module-averse server is a poor trade for that.

const crypto = require('crypto');
const { fetchText } = require('./net');

/**
 * Strip the parts of a URL that identify the click rather than the page, so the
 * same article saved from a tweet and from HN collapses to one bookmark.
 */
function canonical(raw) {
  const u = new URL(raw);
  u.hash = '';
  const junk = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'ref_url',
    'si', 'igshid', 'igsh', 's', 't', 'spm', '_hsenc', '_hsmi',
  ];
  for (const k of junk) u.searchParams.delete(k);
  u.host = u.host.replace(/^www\./, '');
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/** Stable id from the canonical URL — the same link always lands on the same row. */
function linkId(canonicalUrl) {
  return crypto.createHash('sha1').update(canonicalUrl).digest('hex').slice(0, 16);
}

function meta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1].trim()) return decodeEntities(m[1].trim());
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function absolute(maybeRelative, base) {
  if (!maybeRelative) return null;
  try { return new URL(maybeRelative, base).toString(); } catch { return null; }
}

async function saveUrl(raw) {
  const url = canonical(String(raw || '').trim());
  const host = new URL(url).host;
  const now = new Date().toISOString();

  let html = '';
  try {
    html = await fetchText(url, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      maxBytes: 512 * 1024,   // metadata lives in <head>; the body is wasted bytes
    });
  } catch {
    // An unreachable page is still a bookmark worth keeping — you saved the
    // link, not the fetch. It just arrives with the host as its title.
  }

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title =
    meta(html, 'og:title') || meta(html, 'twitter:title') ||
    (titleTag ? decodeEntities(titleTag[1].trim()) : null) || host;

  return {
    id: `link:${linkId(url)}`,
    rawId: linkId(url),
    source: 'link',
    sourceLabel: 'Saved Links',
    url,
    title,
    text: meta(html, 'og:description') || meta(html, 'description') || meta(html, 'twitter:description') || '',
    authorHandle: meta(html, 'og:site_name') || host.replace(/^www\./, ''),
    authorName: meta(html, 'og:site_name') || host.replace(/^www\./, ''),
    authorProfileImageUrl: null,
    thumbnailUrl: absolute(meta(html, 'og:image') || meta(html, 'twitter:image'), url),
    domain: host.replace(/^www\./, ''),
    postedAt: meta(html, 'article:published_time') || now,
    bookmarkedAt: now,
    syncedAt: now,
    likeCount: 0, replyCount: 0, repostCount: 0, bookmarkCount: 0,
    categories: [], primaryCategory: null,
    folderNames: [], folderIds: [],
    isRead: false, favFolders: [], favFolder: null, colorLabel: null, note: null,
  };
}

module.exports = { saveUrl, canonical, linkId };
