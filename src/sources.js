// ─────────────────────────────────────────────────────────────────────────────
// Sync source registry — single source of truth for which backend feeds the app.
//
// The desktop build ships Field Theory only. The browser build also carries a
// birdclaw source; it's dropped here because birdclaw needs Node ≥25 and its own
// `birdclaw init`, which turns a two-click onboarding into a support thread. The
// registry stays a list so a second source can be added back without reshaping
// the UI around it.
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
];

export const DEFAULT_SOURCE = 'fieldtheory';

export function getSource(id) {
  return SOURCES.find(s => s.id === id) || SOURCES[0];
}

export function sourceProvides(id, cap) {
  return getSource(id).provides.includes(cap);
}
