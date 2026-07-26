import { useState, useRef, useEffect } from 'react';

const SUGGESTIONS = [
  "What topics have I been bookmarking most?",
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

function buildContext(bookmarks, query) {
  const q = query.toLowerCase().replace(/[?!.]/g, '');
  const terms = q.split(/\s+/).filter(w => w.length > 2 && !['find','show','what','which','have','been','from','about','that','with','this','last','give','tell'].includes(w));

  // Score relevance
  const scored = bookmarks.map(b => {
    const text = `${b.text || ''} ${b.authorName || ''} ${b.authorHandle || ''} ${b.primaryCategory || ''} ${(b.categories || []).join(' ')} ${b.note || ''}`.toLowerCase();
    const score = terms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0);
    return { ...b, _score: score };
  });

  const relevant = scored.filter(b => b._score > 0).sort((a, b) => b._score - a._score).slice(0, 15);
  const sample = relevant.length > 0 ? relevant : bookmarks.slice(0, 10);

  return sample.map(b =>
    `[${b.authorHandle}] ${b.text?.slice(0, 200) || ''} (${b.primaryCategory || 'uncategorised'}, ${formatDate(b.bookmarkedAt || b.syncedAt)})`
  ).join('\n');
}

function buildPrompt(bookmarks, query, systemPrompt) {
  const totalCount = bookmarks.length;
  const unread = bookmarks.filter(b => !b.isRead).length;
  const authors = new Set(bookmarks.map(b => b.authorHandle)).size;
  const cats = [...new Set(bookmarks.map(b => b.primaryCategory).filter(Boolean))].join(', ');
  const context = buildContext(bookmarks, query);

  return `${systemPrompt ? systemPrompt + '\n\n' : ''}You are an assistant that helps users explore their X/Twitter bookmark collection.

Collection stats:
- Total bookmarks: ${totalCount}
- Unread: ${unread}
- Unique voices: ${authors}
- Categories: ${cats}

Relevant bookmarks for this query:
${context}

User question: ${query}

Answer concisely and helpfully. Reference specific bookmarks and authors when relevant. Use plain text, no markdown headers.`;
}

function BookmarkCard({ b }) {
  return (
    <a href={b.url} target="_blank" rel="noopener noreferrer" className="chat-bookmark-card">
      <div className="chat-bookmark-author">@{b.authorHandle}</div>
      <div className="chat-bookmark-text">{(b.text || '').slice(0, 160)}{b.text?.length > 160 ? '…' : ''}</div>
      <div className="chat-bookmark-meta">
        {b.primaryCategory && <span className="chat-bookmark-cat">{b.primaryCategory}</span>}
        <span>{formatDate(b.bookmarkedAt || b.syncedAt)}</span>
        {b.likeCount > 0 && <span>♥ {fmt(b.likeCount)}</span>}
      </div>
    </a>
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

    const prompt = buildPrompt(bookmarks, query, systemPrompt);

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

      const finalText = full.trim() || 'No response from AI. Make sure the CLI is installed and authenticated.';
      setMessages(prev => [...prev, { role: 'assistant', type: 'text', text: finalText }]);
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
      setMessages(prev => [...prev, { role: 'assistant', type: 'text', text: streaming }]);
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
                    <p className="chat-assistant-text" style={{ whiteSpace: 'pre-wrap' }}>{streaming}<span className="chat-cursor" /></p>
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
