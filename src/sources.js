// ─────────────────────────────────────────────────────────────────────────────
// Sync source registry — single source of truth for which backend feeds the app
// and what each one is capable of. The UI gates features on `provides`, so adding
// a richer backend automatically lights up the tools it can support.
//
// Capabilities:
//   bookmarks  — the core bookmark feed (every source must provide this)
//   likes      — your liked tweets as a separate feed
//   mentions   — AI-ranked mentions / inbox triage
//   media      — locally cached images / video / GIFs on cards
//   threads    — reconstructed full threads on cards
//   digests    — streaming daily / weekly AI digests
//   accounts   — multiple X accounts to switch between
// ─────────────────────────────────────────────────────────────────────────────

export const SOURCES = [
  {
    id: 'fieldtheory',
    label: 'Field Theory',
    icon: '🪁',
    cli: 'ft',
    blurb: 'Bookmark sync backbone by @andrewfarah',
    install: 'npm i -g fieldtheory-cli',
    link: 'https://github.com/afar1/fieldtheory-cli',
    author: { name: 'Andrew Farah', x: 'https://x.com/andrewfarah' },
    provides: ['bookmarks'],
  },
  {
    id: 'birdclaw',
    label: 'birdclaw',
    icon: '🐦',
    cli: 'birdclaw',
    blurb: 'Local-first X workspace by @steipete — unlocks likes, inbox, media & digests',
    install: 'npm i -g birdclaw@latest (needs Node ≥25), then `birdclaw init`',
    link: 'https://birdclaw.sh',
    author: { name: 'Peter Steinberger', x: 'https://x.com/steipete' },
    provides: ['bookmarks', 'likes', 'mentions', 'media', 'threads', 'digests', 'accounts'],
  },
];

export const DEFAULT_SOURCE = 'fieldtheory';

// Human labels for capabilities, used to render "what this unlocks" chips.
export const CAPABILITY_LABELS = {
  bookmarks: 'Bookmarks',
  likes:     'Liked tweets',
  mentions:  'Inbox triage',
  media:     'Media cache',
  threads:   'Full threads',
  digests:   'AI digests',
  accounts:  'Multi-account',
};

// Extra app "modes" (right-panel tools) that a capability unlocks. Core tools
// (chat / stats / podcast) work on any source and live in RightPanel directly.
export const CAPABILITY_TOOLS = [
  { id: 'likes',   cap: 'likes',    label: 'Liked Tweets', desc: 'Browse & search your likes' },
  { id: 'inbox',   cap: 'mentions', label: 'Inbox Triage', desc: 'AI-ranked mentions' },
  { id: 'digests', cap: 'digests',  label: 'AI Digests',   desc: 'Daily / weekly summaries' },
];

export function getSource(id) {
  return SOURCES.find(s => s.id === id) || SOURCES[0];
}

export function sourceProvides(id, cap) {
  return getSource(id).provides.includes(cap);
}
