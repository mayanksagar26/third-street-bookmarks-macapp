// ─────────────────────────────────────────────────────────────────────────────
// A small Markdown renderer for chat answers.
//
// The models answer in Markdown whether or not you ask them to, so a plain <p>
// with pre-wrap showed literal `**What it is**` and raw `[NPR](https://…)`
// pairs — the formatting was there all along, just never rendered.
//
// Written here rather than pulled in, because the needed subset is small
// (emphasis, links, code, lists, headings) and a Markdown library is a large
// dependency with its own escaping story to audit. The order below is the whole
// design, and it is load-bearing:
//
//   1. escape everything first  — this text is a model's summary of content a
//                                 stranger wrote, so it is untrusted twice over
//   2. lift code spans out      — so nothing formats inside them
//   3. links, then bold, then italic
//   4. put the code spans back
//
// Getting 1 wrong is an injection. Getting 2 wrong renders the `**` inside a
// code sample as bold. Getting 3 wrong turns `**bold**` into italics wrapped
// around a stray asterisk.
// ─────────────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Only http(s). A rendered `javascript:` href would be a script the model wrote. */
function safeHref(url) {
  const trimmed = String(url).trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function link(href, label) {
  const safe = safeHref(href);
  if (!safe) return label;
  return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

// Sentinels for text lifted out of the emphasis pass. Control characters,
// written as escapes so they are visible in this file: a literal one here would
// be an invisible byte nobody can see when editing.
const HOLD_OPEN = '\u0001';
const HOLD_CLOSE = '\u0002';

function inline(text) {
  const held = [];
  const hold = (html) => {
    held.push(html);
    return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
  };

  let out = text;

  // 2. Code spans, so no other rule formats inside them.
  out = out.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${code}</code>`));

  // 3a/3b. Links are held too, not just emitted. An anchor written before the
  // emphasis pass gets mangled by it — `target="_blank"` contains a pair of
  // underscores, and the italic rule turns it into `target="<em>blank"`.
  out = out.replace(/\[([^\]\n]*)\]\(\s*([^)\s]*?)\s*\)/g, (m, label, href) => {
    const anchor = link(href, label || href);
    // A rejected scheme leaves the label as plain text rather than a dead link.
    return anchor === (label || href) ? (label || href) : hold(anchor);
  });

  out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+[^\s<>().,;:!?])/g,
    (m, pre, url) => `${pre}${hold(link(url, url))}`);

  // 3c. Bold before italic. Scanning for a single `*` first would consume one
  //     asterisk of each `**` pair and leave the other stranded.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

  // 4. Put everything held back, innermost last.
  out = out.replace(new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, 'g'),
    (_, i) => held[Number(i)]);
  return out;
}

/** Markdown → HTML. The input is escaped before any other rule touches it. */
export function renderMarkdown(src) {
  const text = esc(String(src || '').replace(/\r\n?/g, '\n')).trim();
  if (!text) return '';

  const blocks = text.split(/\n{2,}/);
  const html = [];

  for (const block of blocks) {
    const lines = block.split('\n');

    const heading = /^(#{1,4})\s+(.*)$/.exec(lines[0]);
    if (heading && lines.length === 1) {
      // `#` renders as h3: this sits inside a chat bubble, not a document, and
      // an h1 here would outweigh the app's own headings.
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (lines.every(l => /^\s*[-*+]\s+/.test(l))) {
      html.push(`<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('')}</ul>`);
      continue;
    }

    if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) {
      html.push(`<ol>${lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`);
      continue;
    }

    // `>` has already become `&gt;` by this point.
    if (lines.every(l => /^\s*&gt;\s?/.test(l))) {
      html.push(`<blockquote>${inline(lines.map(l => l.replace(/^\s*&gt;\s?/, '')).join(' '))}</blockquote>`);
      continue;
    }

    // A single newline inside a paragraph stays a line break, the way it looks
    // in the source. Models use them for lists that never got a bullet.
    html.push(`<p>${lines.map(inline).join('<br>')}</p>`);
  }

  return html.join('');
}
