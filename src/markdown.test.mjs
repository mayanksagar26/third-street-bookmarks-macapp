// Tests for the chat Markdown renderer.
//
// Weighted towards escaping and ordering rather than coverage of Markdown.
// This text is a model's summary of content a stranger wrote, so it is
// untrusted twice over, and every bug found while building this was an
// ordering bug rather than a missing feature.

import test from 'node:test';
import assert from 'node:assert';
import { renderMarkdown } from './markdown.js';

// ── Escaping ─────────────────────────────────────────────────────────────────

test('HTML in the answer is escaped, not rendered', () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'), 'no raw tag survives');
  assert.ok(out.includes('&lt;img'));
});

test('a javascript: href never reaches the DOM', () => {
  const out = renderMarkdown('[click me](javascript:alert(1))');
  assert.ok(!/href/.test(out), 'no anchor at all for a rejected scheme');
  assert.ok(out.includes('click me'), 'the label survives as plain text');
});

test('a data: href is refused too', () => {
  const out = renderMarkdown('[x](data:text/html,<script>alert(1)</script>)');
  assert.ok(!/href=/.test(out));
});

// ── Ordering ─────────────────────────────────────────────────────────────────

test('emphasis does not mangle the anchors it runs after', () => {
  // `target="_blank"` holds a pair of underscores. Emitting anchors before the
  // italic pass turned it into `target="<em>blank"` and broke every link.
  const out = renderMarkdown('See [NPR](https://npr.org/x) for more.');
  assert.ok(out.includes('target="_blank"'), 'the attribute survives intact');
  assert.ok(out.includes('rel="noopener noreferrer"'));
});

test('bold is matched before italic', () => {
  // Scanning single `*` first consumes one asterisk of each pair.
  assert.equal(renderMarkdown('**bold**'), '<p><strong>bold</strong></p>');
  assert.equal(renderMarkdown('*just italic*'), '<p><em>just italic</em></p>');
});

test('nothing formats inside a code span', () => {
  const out = renderMarkdown('Use `**not bold**` here.');
  assert.ok(out.includes('<code>**not bold**</code>'));
  assert.ok(!out.includes('<strong>'));
});

// ── Structure ────────────────────────────────────────────────────────────────

test('bare URLs become links', () => {
  const out = renderMarkdown('See https://example.com/a?b=1 for more.');
  assert.ok(out.includes('href="https://example.com/a?b=1"'));
});

test('trailing punctuation stays out of the href', () => {
  const out = renderMarkdown('Read https://example.com/page.');
  assert.ok(out.includes('href="https://example.com/page"'), out);
});

test('bullet and numbered lists render as lists', () => {
  assert.ok(renderMarkdown('- one\n- two').startsWith('<ul>'));
  assert.ok(renderMarkdown('1. one\n2. two').startsWith('<ol>'));
});

test('a single newline inside a paragraph is a line break', () => {
  assert.equal(renderMarkdown('Line one\nLine two'), '<p>Line one<br>Line two</p>');
});

test('a blank line starts a new paragraph', () => {
  assert.equal(renderMarkdown('One\n\nTwo'), '<p>One</p><p>Two</p>');
});

test('headings render below the app’s own, never as h1', () => {
  assert.ok(/^<h[3-6]>/.test(renderMarkdown('# Title')));
});

test('empty input renders nothing', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

test('the real shape of an explain answer survives', () => {
  const out = renderMarkdown(
    '**What it is** — an *August 2025* interview.\n\n' +
    '**Context** — Per [TechCrunch](https://techcrunch.com/x), it shipped.',
  );
  assert.equal((out.match(/<strong>/g) || []).length, 2);
  assert.equal((out.match(/<em>/g) || []).length, 1);
  assert.equal((out.match(/<a /g) || []).length, 1);
  assert.ok(!out.includes('**'), 'no raw asterisks left on screen');
  assert.ok(!out.includes(']('), 'no raw markdown link syntax left on screen');
});
