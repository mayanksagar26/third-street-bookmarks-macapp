import { useState, useRef, useEffect } from 'react';

const SUGGESTIONS = [
  "Show me everything I saved about AI agents",
  "Which authors do I bookmark most?",
  "Find AI tools in my bookmarks",
  "Summarise my unread bookmarks",
];

function fmt(n) { return Number(n || 0).toLocaleString(); }

function formatDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
}

/** How many bookmarks get sent as context and offered back as cards. */
const MAX_CONTEXT = 24;

const STOP_WORDS = new Set([
  'find','show','what','which','have','been','from','about','that','with','this',
  'last','give','tell','some','tweets','tweet','bookmark','bookmarks','anything',
  'related','regarding','were','they','them','their','more','most','please','list',
]);

/**
 * The bookmarks a question is actually about.
 *
 * Returns them rather than a formatted blob, because the same set is used
 * twice: flattened into the prompt, and rendered back as cards under the
 * answer. `matched` distinguishes a real hit from the "here's a sample of your
 * collection" fallback — showing that fallback as sources would be a lie.
 */
function selectRelevant(bookmarks, query) {
  const q = query.toLowerCase().replace(/[?!.,"']/g, ' ');
  const terms = [...new Set(q.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w)))];
  if (!terms.length) return { items: bookmarks.slice(0, 10), matched: false };

  const scored = bookmarks.map(b => {
    const haystack = `${b.text || ''} ${b.authorName || ''} ${b.authorHandle || ''} ${b.primaryCategory || ''} ${(b.categories || []).join(' ')} ${b.note || ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (!haystack.includes(t)) continue;
      score += 1;
      // An author named in the question is a stronger signal than the word
      // turning up somewhere in a tweet's body.
      if ((b.authorHandle || '').toLowerCase().includes(t)) score += 2;
      if ((b.primaryCategory || '').toLowerCase().includes(t)) score += 1;
    }
    return { b, score };
  });

  const hits = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (!hits.length) return { items: bookmarks.slice(0, 10), matched: false };
  return { items: hits.slice(0, MAX_CONTEXT).map(x => x.b), matched: true };
}

function buildPrompt(bookmarks, query, systemPrompt, relevant) {
  const totalCount = bookmarks.length;
  const unread = bookmarks.filter(b => !b.isRead).length;
  const authors = new Set(bookmarks.map(b => b.authorHandle)).size;
  const cats = [...new Set(bookmarks.map(b => b.primaryCategory).filter(Boolean))].join(', ');

  // Numbered, so the answer can point back at specific entries and the UI can
  // show exactly the ones it used.
  const context = relevant.items.map((b, i) =>
    `[${i + 1}] @${b.authorHandle}: ${b.text?.slice(0, 220) || ''} (${b.primaryCategory || 'uncategorised'}, ${formatDate(b.bookmarkedAt || b.syncedAt)})`
  ).join('\n');

  return `${systemPrompt ? systemPrompt + '\n\n' : ''}You are an assistant that helps users explore their X/Twitter bookmark collection.

Collection stats:
- Total bookmarks: ${totalCount}
- Unread: ${unread}
- Unique voices: ${authors}
- Categories: ${cats}

Candidate bookmarks for this query:
${context}

User question: ${query}

Answer concisely and helpfully. Reference bookmarks by their number, like [3].
Use plain text, no markdown headers.
On the very last line, list every candidate number that is genuinely relevant to
the question, in the form: SOURCES: 1, 4, 9
If none are relevant, write: SOURCES: none`;
}

/**
 * Split the trailing SOURCES line off an answer.
 *
 * The line is an instruction to the UI, not something the user should read, so
 * it never reaches the screen. Matching is anchored to the end and tolerates a
 * half-written line so nothing flickers mid-stream.
 */
function splitSources(raw) {
  const text = (raw || '').trimEnd();
  const full = text.match(/\n?\s*SOURCES?\s*:\s*([0-9,\s]*(?:none)?)\s*$/i);
  if (full) {
    const numbers = (full[1] || '')
      .split(',')
      .map(n => parseInt(n.trim(), 10))
      .filter(n => Number.isInteger(n) && n > 0);
    return { text: text.slice(0, full.index).trimEnd(), numbers, complete: true };
  }
  // Mid-stream: the label has arrived but the numbers haven't. Hide it early.
  const partial = text.match(/\n\s*S(?:O(?:U(?:R(?:C(?:E(?:S?)?)?)?)?)?)?\s*:?\s*$/i);
  if (partial) return { text: text.slice(0, partial.index).trimEnd(), numbers: [], complete: false };
  return { text, numbers: [], complete: false };
}

function tweetUrl(b) {
  if (b.url) return b.url;
  const id = b.tweetId || b.id;
  if (b.authorHandle && id) return `https://x.com/${b.authorHandle}/status/${id}`;
  return null;
}

const TRUNCATE_AT = 280;

/** A bookmark rendered the way it looks in the feed, sized for a chat answer. */
function ChatTweet({ b }) {
  const [expanded, setExpanded] = useState(false);
  const text = b.text || '';
  const long = text.length > TRUNCATE_AT;
  const url = tweetUrl(b);
  const name = b.authorName || b.authorHandle || 'Unknown';

  return (
    <div className="chat-tweet">
      <div className="chat-tweet-avatar">
        {b.authorProfileImageUrl
          ? <img src={b.authorProfileImageUrl} alt="" loading="lazy" onError={e => { e.target.style.display = 'none'; }} />
          : (name[0] || '?').toUpperCase()}
      </div>
      <div className="chat-tweet-body">
        <div className="chat-tweet-head">
          <span className="chat-tweet-name">{name}</span>
          <span className="chat-tweet-handle">@{b.authorHandle}</span>
          <span className="chat-tweet-date">{formatDate(b.postedAt || b.bookmarkedAt || b.syncedAt)}</span>
        </div>
        <div className="chat-tweet-text">
          {expanded || !long ? text : `${text.slice(0, TRUNCATE_AT).trimEnd()}…`}
        </div>
        {long && (
          <button className="chat-tweet-more" onClick={() => setExpanded(p => !p)}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <div className="chat-tweet-foot">
          {b.primaryCategory && b.primaryCategory !== 'unclassified' && (
            <span className="chat-tweet-cat">{b.primaryCategory}</span>
          )}
          {b.likeCount > 0 && <span className="chat-tweet-stat">♥ {fmt(b.likeCount)}</span>}
          {b.bookmarkCount > 0 && <span className="chat-tweet-stat">🔖 {fmt(b.bookmarkCount)}</span>}
          {url && (
            <a className="chat-tweet-view" href={url} target="_blank" rel="noopener noreferrer">View</a>
          )}
        </div>
      </div>
    </div>
  );
}

/** The scrollable stack of bookmarks an answer drew on. */
function ChatResults({ items }) {
  if (!items?.length) return null;
  return (
    <div className="chat-results">
      <div className="chat-results-head">
        <span className="chat-results-count">{items.length}</span>
        <span>{items.length === 1 ? 'bookmark' : 'bookmarks'} from your collection</span>
        {items.length > 3 && <span className="chat-results-hint">scroll for more</span>}
      </div>
      <div className="chat-results-scroll">
        {items.map(b => <ChatTweet key={b.id} b={b} />)}
      </div>
    </div>
  );
}

const DEFAULT_SYSTEM = 'Be concise. 2-3 sentences max unless asked for more. Reference specific bookmarks and authors.';

function loadSystemPrompt() {
  try { return localStorage.getItem('chatSystemPrompt') || DEFAULT_SYSTEM; } catch { return DEFAULT_SYSTEM; }
}

export default function ChatWithBookmarks({ bookmarks, aiBackend: initialBackend, onClose }) {
  const [aiBackend, setAiBackendLocal]  = useState(initialBackend || 'claude');
  const [showSysPrompt, setShowSysPrompt] = useState(false);
  const [systemPrompt, setSystemPrompt]   = useState(loadSystemPrompt);

  function saveSystemPrompt(val) {
    setSystemPrompt(val);
    try { localStorage.setItem('chatSystemPrompt', val); } catch {}
  }

  async function switchBackend(b) {
    setAiBackendLocal(b);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiBackend: b }),
    }).catch(() => {});
  }
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  // What the in-flight question matched, so a stopped answer still keeps its
  // bookmarks.
  const relevantRef = useRef({ items: [], matched: false });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  async function sendQuery(query) {
    if (!query.trim() || loading) return;
    setInput('');
    const userMsg = { role: 'user', text: query };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    setStreaming('');

    const relevant = selectRelevant(bookmarks, query);
    relevantRef.current = relevant;
    const prompt = buildPrompt(bookmarks, query, systemPrompt, relevant);

    try {
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: ctrl.signal,
      });

      if (!resp.ok) throw new Error(`Server error ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let full = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        full += chunk;
        setStreaming(full);
      }

      const { text: answer, numbers } = splitSources(full);
      const finalText = answer.trim() || 'No response from AI. Make sure the CLI is installed and authenticated.';

      // Cited entries when the model picked some; otherwise the matches it was
      // given, so a question about a set of tweets still comes back with them.
      const cited = numbers
        .map(n => relevant.items[n - 1])
        .filter(Boolean);
      const sources = cited.length
        ? [...new Map(cited.map(b => [b.id, b])).values()]
        : (relevant.matched ? relevant.items : []);

      setMessages(prev => [...prev, { role: 'assistant', type: 'text', text: finalText, sources }]);
      setStreaming('');
    } catch (e) {
      if (e.name !== 'AbortError') {
        setMessages(prev => [...prev, {
          role: 'assistant',
          type: 'text',
          text: `Error: ${e.message}. Make sure ${aiBackend === 'codex' ? 'Codex' : 'Claude Code'} CLI is installed and authenticated.`,
        }]);
        setStreaming('');
      }
    } finally {
      setLoading(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    if (streaming) {
      const { text, numbers } = splitSources(streaming);
      const relevant = relevantRef.current;
      const cited = numbers.map(n => relevant.items[n - 1]).filter(Boolean);
      setMessages(prev => [...prev, {
        role: 'assistant',
        type: 'text',
        text,
        sources: cited.length ? cited : (relevant.matched ? relevant.items : []),
      }]);
      setStreaming('');
    }
    setLoading(false);
  }

  function handleSurprise() {
    const unread = bookmarks.filter(b => !b.isRead && b.text);
    const pool = unread.length > 5 ? unread : bookmarks.filter(b => b.text);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick) sendQuery(`Tell me more about this bookmark and why it might be interesting: "${(pick.text || '').slice(0, 200)}" by @${pick.authorHandle}`);
  }

  const isEmpty = messages.length === 0 && !streaming;
  const backend = aiBackend === 'codex' ? 'Codex CLI' : 'Claude Code CLI';

  return (
    <div className="mode-container">
      <div className="mode-topbar">
        <button className="mode-back-btn" onClick={() => { handleStop(); onClose(); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          Back
        </button>
        <h2 className="mode-title">Chat with Bookmarks</h2>
        <span className="chat-backend-badge">{backend}</span>
        <button
          className={`chat-sys-btn ${showSysPrompt ? 'active' : ''}`}
          onClick={() => setShowSysPrompt(p => !p)}
          title="System instructions"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
          Instructions
        </button>
      </div>

      {showSysPrompt && (
        <div className="chat-sys-panel">
          <div className="chat-sys-label">System instructions — tell the AI how to respond</div>
          <textarea
            className="chat-sys-textarea"
            value={systemPrompt}
            onChange={e => saveSystemPrompt(e.target.value)}
            rows={3}
            placeholder="e.g. Be concise. Max 2 sentences. Use bullet points."
          />
          <div className="chat-sys-actions">
            <button className="chat-sys-reset" onClick={() => saveSystemPrompt(DEFAULT_SYSTEM)}>Reset to default</button>
            <button className="chat-sys-close" onClick={() => setShowSysPrompt(false)}>Done</button>
          </div>
        </div>
      )}

      <div className="chat-container">
        {isEmpty ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="var(--accent)">
                <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
              </svg>
            </div>
            <h2 className="chat-title">Chat with your Bookmarks</h2>

            {/* AI backend picker */}
            <div className="chat-backend-picker">
              <span className="chat-backend-picker-label">AI Engine</span>
              <button
                className={`chat-backend-pill ${aiBackend === 'claude' ? 'active' : ''}`}
                onClick={() => switchBackend('claude')}
              >⚡ Claude Code CLI</button>
              <button
                className={`chat-backend-pill ${aiBackend === 'codex' ? 'active' : ''}`}
                onClick={() => switchBackend('codex')}
              >🤖 Codex CLI</button>
            </div>

            <p className="chat-desc">Ask anything about your collection. The AI searches relevant bookmarks and answers in context.</p>
            <div className="chat-chips-grid">
              {SUGGESTIONS.map(s => (
                <button key={s} className="chat-chip-item" onClick={() => sendQuery(s)}>{s}</button>
              ))}
            </div>
            <button className="chat-surprise-btn" onClick={handleSurprise}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
              Surprise me
            </button>
          </div>
        ) : (
          <div className="chat-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`chat-message ${msg.role}`}>
                {msg.role === 'user' ? (
                  <div className="chat-bubble user">{msg.text}</div>
                ) : (
                  <div className="chat-assistant-msg">
                    <div className="chat-assistant-icon">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>
                    </div>
                    <div className="chat-assistant-body">
                      <p className="chat-assistant-text" style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</p>
                      <ChatResults items={msg.sources} />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Streaming message */}
            {streaming && (
              <div className="chat-message assistant">
                <div className="chat-assistant-msg">
                  <div className="chat-assistant-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>
                  </div>
                  <div className="chat-assistant-body">
                    <p className="chat-assistant-text" style={{ whiteSpace: 'pre-wrap' }}>{splitSources(streaming).text}<span className="chat-cursor" /></p>
                  </div>
                </div>
              </div>
            )}

            {loading && !streaming && (
              <div className="chat-message assistant">
                <div className="chat-assistant-msg">
                  <div className="chat-assistant-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>
                  </div>
                  <div className="chat-typing"><span/><span/><span/></div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        <div className="chat-input-area">
          <input
            ref={inputRef}
            className="chat-input"
            placeholder={`Ask ${backend}…`}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendQuery(input)}
            disabled={loading}
          />
          {loading ? (
            <button className="chat-send-btn stop" onClick={handleStop} title="Stop">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            </button>
          ) : (
            <button className="chat-send-btn" onClick={() => sendQuery(input)} disabled={!input.trim()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
