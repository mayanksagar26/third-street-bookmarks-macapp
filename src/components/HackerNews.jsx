import { useState, useEffect, useCallback } from 'react';
import { SourceIcon } from '../bookmark-sources';
import { openExternal } from '../external-links';

// ─────────────────────────────────────────────────────────────────────────────
// Hacker News, as a place you browse rather than a thing that syncs.
//
// Nothing on this screen is in your collection until you press Save. That is
// the whole reason it is a separate surface instead of another source filter:
// thirty front-page stories arriving in the feed every morning would bury the
// things you actually chose, and make the unread count meaningless inside a
// week.
// ─────────────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'ai',    label: 'AI',         hint: 'AI stories from the last week, by points' },
  { id: 'front', label: 'Front Page', hint: 'What is on the front page right now' },
  { id: 'new',   label: 'New',        hint: 'Newest submissions' },
];

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(diff)) return '';
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function HackerNews({ onSaved, onClose }) {
  const [tab, setTab]         = useState('ai');
  const [stories, setStories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [saving, setSaving]   = useState({});
  const [query, setQuery]     = useState('');

  const load = useCallback((which) => {
    setLoading(true);
    setError(null);
    fetch(`/api/hn/top?tab=${which}&limit=50`)
      .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(d.error)))
      .then(data => { setStories(data); setLoading(false); })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  async function save(story) {
    setSaving(s => ({ ...s, [story.id]: 'saving' }));
    try {
      const r = await fetch('/api/hn/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: story }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'save failed');
      setSaving(s => ({ ...s, [story.id]: 'saved' }));
      setStories(list => list.map(x => x.id === story.id ? { ...x, alreadySaved: true } : x));
      onSaved?.(d.record);
    } catch (e) {
      setSaving(s => ({ ...s, [story.id]: 'error' }));
    }
  }

  const q = query.trim().toLowerCase();
  const visible = q
    ? stories.filter(s => `${s.title} ${s.authorHandle} ${s.domain}`.toLowerCase().includes(q))
    : stories;

  return (
    <div className="hn-pane">
      <div className="hn-header">
        <div className="hn-title">
          <SourceIcon source="hn" size={20} style={{ color: '#ff6600' }} />
          <div>
            <h2>Hacker News</h2>
            <span className="hn-sub">{TABS.find(t => t.id === tab)?.hint}</span>
          </div>
        </div>
        <button className="hn-close" onClick={onClose} title="Back to the feed">✕</button>
      </div>

      <div className="hn-toolbar">
        <div className="hn-tabs">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`hn-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >{t.label}</button>
          ))}
        </div>
        <input
          className="hn-search"
          placeholder="Filter these stories…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }}
        />
        <button className="hn-refresh" onClick={() => load(tab)} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="hn-error">
          {error}
          <button onClick={() => load(tab)}>Try again</button>
        </div>
      )}

      {loading && !stories.length && <div className="hn-empty">Fetching stories…</div>}
      {!loading && !error && !visible.length && (
        <div className="hn-empty">{q ? 'Nothing matches that.' : 'No stories came back.'}</div>
      )}

      <div className="hn-list">
        {visible.map((s, i) => {
          const state = saving[s.id];
          const saved = s.alreadySaved || state === 'saved';
          return (
            <div className={`hn-row ${saved ? 'is-saved' : ''}`} key={s.id}>
              <span className="hn-rank">{i + 1}</span>
              <div className="hn-body">
                <a
                  className="hn-story-title"
                  href={s.url}
                  onClick={e => { e.preventDefault(); openExternal(s.url); }}
                >
                  {s.title}
                </a>
                {s.domain && <span className="hn-domain">{s.domain}</span>}
                <div className="hn-meta">
                  <span className="hn-points">{s.points} points</span>
                  <span>by {s.authorHandle}</span>
                  <span>{timeAgo(s.postedAt)}</span>
                  <a
                    href={s.commentsUrl}
                    onClick={e => { e.preventDefault(); openExternal(s.commentsUrl); }}
                  >{s.commentCount} comments</a>
                </div>
              </div>
              <button
                className={`hn-save ${saved ? 'saved' : ''}`}
                onClick={() => !saved && save(s)}
                disabled={saved || state === 'saving'}
              >
                {saved ? 'Saved' : state === 'saving' ? '…' : state === 'error' ? 'Retry' : 'Save'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
