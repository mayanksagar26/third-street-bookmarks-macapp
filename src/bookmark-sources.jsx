// ─────────────────────────────────────────────────────────────────────────────
// What each source looks like in the UI.
//
// Separate from `sources.js`, which is about *sync backends* — which CLI feeds
// the app. This one is about provenance: which service a bookmark came from,
// how its badge reads, and what colour the card's edge takes.
//
// `all` is deliberately not X. When the sidebar said "All Bookmarks" and wore
// an X logo it was making a claim about its contents that stopped being true
// the moment a second source existed.
//
// `browseLabel` names a source's second tab — the surface that puts things in.
// A source without one (X, whose only route in is a sync) shows just its saved list.
//
// `emptyHint` and `action` are what a source shows before you have put anything
// in it. Every source is listed from the first launch, greyed until it has
// something, because a source you cannot see is a source you will not know
// exists — and a greyed row that filtered to an empty feed would just be a dead
// end. So the empty row is the way in instead.
// ─────────────────────────────────────────────────────────────────────────────

export const BOOKMARK_SOURCES = {
  x: {
    id: 'x', label: 'X', accent: '#1d9bf0',
    emptyHint: 'Sync via Field Theory to fill this', action: null,
    browseLabel: null,
    icon: <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>,
  },
  hn: {
    id: 'hn', label: 'Hacker News', short: 'HN', accent: '#ff6600',
    emptyHint: 'Browse today’s stories and save what you want', action: 'hn',
    browseLabel: 'Browse Hacker News',
    icon: <path d="M3 3h18v18H3V3zm9.5 10.5L16 7h-1.9l-2.1 4.2L9.9 7H8l3.5 6.5V17h1v-3.5z"/>,
  },
  yt: {
    id: 'yt', label: 'YouTube', accent: '#ff0033',
    emptyHint: 'Paste a video, import a playlist or a Takeout export', action: 'add:youtube',
    browseLabel: 'Playlists & Import',
    icon: <path d="M21.6 7.2s-.2-1.4-.8-2c-.75-.8-1.6-.8-2-.85C16 4.2 12 4.2 12 4.2h-.01s-4 0-6.8.2c-.4.05-1.25.05-2 .85-.6.6-.8 2-.8 2S2.2 8.8 2.2 10.5v1.6c0 1.6.2 3.3.2 3.3s.2 1.4.8 2c.75.8 1.75.77 2.2.86 1.6.15 6.8.2 6.8.2s4 0 6.8-.21c.4-.05 1.25-.05 2-.85.6-.6.8-2 .8-2s.2-1.6.2-3.3v-1.6c0-1.6-.2-3.3-.2-3.3zM9.9 14.1V8.4l5.2 2.86-5.2 2.84z"/>,
  },
  ig: {
    id: 'ig', label: 'Instagram', accent: '#e1306c',
    emptyHint: 'Import your Instagram data export', action: 'add:instagram',
    browseLabel: 'Collections & Import',
    icon: <path d="M12 2.2c3.2 0 3.6 0 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.25.07 1.65.07 4.85s0 3.6-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.25.06-1.65.07-4.85.07s-3.6 0-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.8 3.8 0 0 1-1.38-.9 3.8 3.8 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.2 15.6 2.2 15.2 2.2 12s0-3.6.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.4 2.2 8.8 2.2 12 2.2zm0 3.13A6.67 6.67 0 1 0 18.67 12 6.67 6.67 0 0 0 12 5.33zm0 11A4.33 4.33 0 1 1 16.33 12 4.33 4.33 0 0 1 12 16.33zm6.94-11.2a1.56 1.56 0 1 1-1.56-1.55 1.56 1.56 0 0 1 1.56 1.56z"/>,
  },
  link: {
    id: 'link', label: 'Saved Links', short: 'Link', accent: '#8b5cf6',
    emptyHint: 'Paste any link to save it', action: 'add:paste',
    browseLabel: 'Add a Link',
    icon: <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 0-10z"/>,
  },
};

/** The order sources appear in the sidebar: the ones you'll have most, first. */
export const SOURCE_ORDER = ['x', 'hn', 'yt', 'ig', 'link'];

export function getBookmarkSource(id) {
  return BOOKMARK_SOURCES[id] || BOOKMARK_SOURCES.link;
}

/** Icon for a source at a given size. `all` gets a neutral book, never a logo. */
export function SourceIcon({ source, size = 16, style }) {
  const s = BOOKMARK_SOURCES[source];
  if (!s) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style}>
        <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style}>
      {s.icon}
    </svg>
  );
}
