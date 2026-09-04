// ─────────────────────────────────────────────────────────────────────────────
// YouTube.
//
// Three ways in, ordered by how much the user has to set up:
//
//   1. oEmbed      — one video, no credentials at all. Title, channel and
//                    thumbnail for any public video.
//   2. API key     — any *public* playlist, yours or anyone's. One key pasted
//                    into Settings, no consent screen.
//   3. Takeout     — everything, including Watch Later and Liked, via the
//                    playlist CSVs in a Google export. Handled in takeout.js.
//
// OAuth is deliberately absent. `youtube.readonly` is a sensitive scope: an
// unverified app is capped at 100 hand-added test users, and going past that
// means a Google verification review. For an app people clone and build
// themselves, that turns setup into a support channel. Takeout covers the same
// data with no credentials at all.
//
// Watch Later is not reachable by any API. Google removed access in 2016 and
// never restored it, so the export is the only route to it — which is why
// Takeout is a first-class path here rather than a fallback.
// ─────────────────────────────────────────────────────────────────────────────

const { fetchJson } = require('./net');

const OEMBED = 'https://www.youtube.com/oembed';
const API = 'https://www.googleapis.com/youtube/v3';

/**
 * Pull a video id out of any of the shapes YouTube hands out.
 *
 * The `si=` parameter the share button now appends is the one that matters
 * most: without stripping it, the same video saved from the app and from a
 * shared link are two different bookmarks.
 */
function videoId(url) {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host !== 'youtube.com') return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?#]+)/);
    return m ? m[2] : null;
  } catch { return null; }
}

function playlistId(url) {
  try {
    const u = new URL(url);
    if (!u.host.replace(/^(www|m|music)\./, '').startsWith('youtube.com')) return null;
    return u.searchParams.get('list');
  } catch {
    // Bare ids are a reasonable thing to paste.
    return /^[A-Za-z0-9_-]{12,}$/.test(String(url || '').trim()) ? String(url).trim() : null;
  }
}

function isYouTube(url) {
  return Boolean(videoId(url) || playlistId(url));
}

/** The canonical form every YouTube record is keyed and deduped on. */
function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

function toRecord(id, meta = {}, { folder = null, savedAt = null } = {}) {
  const now = new Date().toISOString();
  return {
    id: `yt:${id}`,
    rawId: id,
    source: 'yt',
    sourceLabel: 'YouTube',
    url: watchUrl(id),
    title: meta.title || null,
    text: meta.description || '',
    authorHandle: meta.channelTitle || null,
    authorName: meta.channelTitle || null,
    authorProfileImageUrl: null,
    thumbnailUrl: meta.thumbnailUrl || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    duration: meta.duration || null,
    channelId: meta.channelId || null,
    domain: 'youtube.com',
    postedAt: meta.publishedAt || savedAt || now,
    bookmarkedAt: savedAt || now,
    syncedAt: now,
    likeCount: 0, replyCount: 0, repostCount: 0, bookmarkCount: 0,
    categories: [],
    primaryCategory: null,
    // A playlist is a container the remote service owns — the same thing X's
    // bookmark folders are, and it lands in the same field so the existing
    // Folders section in the sidebar renders it with no new concepts.
    folderNames: folder ? [folder] : [],
    folderIds: [],
    isRead: false,
    favFolders: [],
    favFolder: null,
    colorLabel: null,
    note: null,
  };
}

/** One video, no credentials. Thumbnails come free; duration does not. */
async function viaOembed(url) {
  const id = videoId(url);
  if (!id) throw new Error('not a YouTube video URL');
  const data = await fetchJson(`${OEMBED}?url=${encodeURIComponent(watchUrl(id))}&format=json`);
  return toRecord(id, {
    title: data.title,
    channelTitle: data.author_name,
    thumbnailUrl: data.thumbnail_url,
  });
}

/** ISO 8601 duration (`PT4M13S`) → `4:13`, which is what a card wants to show. */
function humanDuration(iso) {
  if (!iso) return null;
  const m = /^P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m.map(v => (v ? Number(v) : 0));
  const total = d * 86400 + h * 3600 + min * 60 + s;
  if (!total) return null;
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = Math.floor(total % 60);
  return hh
    ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${mm}:${String(ss).padStart(2, '0')}`;
}

function bestThumb(thumbs = {}) {
  return (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default || {}).url || null;
}

/**
 * Import a public playlist.
 *
 * Paginated at 50 — the API's maximum — and capped, because a "watch it later"
 * playlist with four thousand entries is a mistake to mirror in full, not a
 * feature. 1 quota unit per page against a 10,000/day budget means the cap is
 * about the collection staying useful, not about the quota.
 */
async function importPlaylist({ url, apiKey, max = 500 }) {
  const list = playlistId(url);
  if (!list) throw new Error('could not find a playlist id in that URL');
  if (!apiKey) throw new Error('a YouTube API key is needed for playlists');

  let title = 'YouTube playlist';
  try {
    const meta = await fetchJson(
      `${API}/playlists?part=snippet&id=${encodeURIComponent(list)}&key=${encodeURIComponent(apiKey)}`,
    );
    if (meta.items?.[0]?.snippet?.title) title = meta.items[0].snippet.title;
  } catch {
    // A private or deleted playlist still fails informatively below.
  }

  const records = [];
  const durations = new Map();
  let pageToken = '';
  while (records.length < max) {
    const page = await fetchJson(
      `${API}/playlistItems?part=snippet,contentDetails&maxResults=50` +
      `&playlistId=${encodeURIComponent(list)}&key=${encodeURIComponent(apiKey)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''),
    );
    for (const item of page.items || []) {
      const sn = item.snippet || {};
      const id = item.contentDetails?.videoId || sn.resourceId?.videoId;
      // Deleted and private entries stay in a playlist as tombstones with no
      // usable title. Importing them would be importing a row that says
      // "Private video".
      if (!id || sn.title === 'Private video' || sn.title === 'Deleted video') continue;
      records.push(toRecord(id, {
        title: sn.title,
        description: sn.description,
        channelTitle: sn.videoOwnerChannelTitle || sn.channelTitle,
        channelId: sn.videoOwnerChannelId || sn.channelId,
        thumbnailUrl: bestThumb(sn.thumbnails),
        publishedAt: item.contentDetails?.videoPublishedAt || sn.publishedAt,
      }, { folder: title, savedAt: sn.publishedAt }));
    }
    pageToken = page.nextPageToken || '';
    if (!pageToken) break;
  }

  // Durations need a second endpoint; batched 50 at a time, best-effort. A
  // missing duration costs a badge on the card, not the import.
  try {
    for (let i = 0; i < records.length; i += 50) {
      const ids = records.slice(i, i + 50).map(r => r.rawId).join(',');
      const data = await fetchJson(
        `${API}/videos?part=contentDetails&id=${encodeURIComponent(ids)}&key=${encodeURIComponent(apiKey)}`,
      );
      for (const v of data.items || []) durations.set(v.id, humanDuration(v.contentDetails?.duration));
    }
    for (const r of records) if (durations.has(r.rawId)) r.duration = durations.get(r.rawId);
  } catch {}

  return { title, records };
}

/**
 * Fill in titles for records that arrived without one.
 *
 * A Takeout CSV is nothing but video ids, so an unenriched Watch Later import
 * is a list of rows that all look identical — technically imported, practically
 * useless. oEmbed needs no credentials, so this costs nothing but time.
 *
 * Bounded and best-effort by design: a 2,000-video Watch Later would otherwise
 * hold the import open for minutes, and a video that has since been deleted
 * simply keeps no title rather than failing the whole run.
 */
async function enrichTitles(records, { limit = 150, concurrency = 6 } = {}) {
  const pending = records.filter(r => !r.title).slice(0, limit);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= pending.length) return;
      const rec = pending[i];
      try {
        const meta = await viaOembed(rec.url);
        rec.title = meta.title;
        rec.authorHandle = rec.authorHandle || meta.authorHandle;
        rec.authorName = rec.authorName || meta.authorName;
        rec.thumbnailUrl = meta.thumbnailUrl || rec.thumbnailUrl;
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return records;
}

module.exports = {
  videoId, playlistId, isYouTube, watchUrl, toRecord,
  viaOembed, importPlaylist, humanDuration, enrichTitles,
};
