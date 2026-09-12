// ─────────────────────────────────────────────────────────────────────────────
// Reading typefaces.
//
// The app sets one custom property, `--app-font`, and everything that reads
// bookmark text inherits it. The chrome — sidebar, buttons, counts — deliberately
// does not: a hand-drawn interface is a novelty, a hand-drawn *page* is a mood.
//
// All four are bundled as latin woff2 subsets (~130KB total) rather than pulled
// from a CDN, because this app renders with no network and a font that silently
// falls back to Helvetica on a plane is not a font you chose.
// ─────────────────────────────────────────────────────────────────────────────

export const FONTS = [
  {
    id: 'system',
    label: 'System',
    hint: 'What macOS uses everywhere else',
    stack: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
  },
  {
    id: 'inter',
    label: 'Inter',
    hint: 'Neutral and tight, built for screens',
    stack: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
  },
  {
    id: 'literata',
    label: 'Literata',
    hint: 'A serif for long reading',
    stack: '"Literata", Georgia, "Times New Roman", serif',
  },
  {
    id: 'handdrawn',
    label: 'Hand-drawn',
    hint: 'The Excalidraw look',
    stack: '"Architects Daughter", "Comic Sans MS", cursive',
    // Drawn small by design, so it needs a nudge to sit at the same optical
    // size as the others rather than looking like fine print.
    scale: 1.06,
  },
  {
    id: 'mono',
    label: 'Mono',
    hint: 'Fixed width, for code-heavy saves',
    stack: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    scale: 0.94,
  },
];

export const DEFAULT_FONT = 'system';

export function getFont(id) {
  return FONTS.find(f => f.id === id) || FONTS[0];
}

/**
 * Put the choice on the document.
 *
 * Two properties rather than one: the stack, and a scale factor, because these
 * faces do not agree on what a 15px em looks like. Applied to the root so a
 * change is one repaint and needs no component to re-render.
 */
export function applyFont(id) {
  const font = getFont(id);
  const root = document.documentElement;
  root.style.setProperty('--app-font', font.stack);
  root.style.setProperty('--app-font-scale', String(font.scale || 1));
  root.setAttribute('data-font', font.id);
}
