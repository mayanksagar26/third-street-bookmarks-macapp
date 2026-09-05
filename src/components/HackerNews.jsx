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

export default function HackerNews({ onSaved, onClose, embedded = false }) {
  const [tab, setTab]         = useState('ai');
  const [stories, setStories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [saving, setSaving]   = useState({});
  const [query, setQuery]     = useState('');
  // Stories already in your collection drop out of the list. Leaving them in —
  // even dimmed — means every visit re-offers the same twenty things you
  // already dealt with, and the front page barely moves day to day.
  const [showSaved, setShowSaved] = useState(false);

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
      // A short beat before it leaves the list: an instant disappearance reads
      // as the click having gone wrong.
      setTimeout(() => {
        setStories(list => list.map(x => x.id === story.id ? { ...x, alreadySaved: true } : x));
      }, 420);
      onSaved?.(d.record);
    } catch (e) {
      setSaving(s => ({ ...s, [story.id]: 'error' }));
    }
  }

  const q = query.trim().toLowerCase();
  const matching = q
    ? stories.filter(s => `${s.title} ${s.authorHandle} ${s.domain}`.toLowerCase().includes(q))
    : stories;
  // `saving[id] === 'saved'` rather than `alreadySaved` for the row you just
  // clicked, so it leaves on a beat you can see instead of vanishing mid-click.
  const savedCount = matching.filter(s => s.alreadySaved).length;
  const visible = showSaved ? matching : matching.filter(s => !s.alreadySaved);

  return (
    <div className={embedded ? 'hn-pane is-embedded' : 'hn-pane'}>
      {/* Embedded inside a source view, the surrounding view already names the
          source and owns the close button. Only the tab's own hint is left. */}
      {embedded ? (
        <div className="hn-sub embedded-sub">{TABS.find(t => t.id === tab)?.hint}</div>
      ) : (
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
      )}

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

      {savedCount > 0 && (
        <div className="hn-saved-note">
          {savedCount} already saved {showSaved ? 'shown' : 'hidden'}
          <button onClick={() => setShowSaved(v => !v)}>
            {showSaved ? 'Hide them' : 'Show them'}
          </button>
        </div>
      )}

      {error && (
        <div className="hn-error">
          {error}
          <button onClick={() => load(tab)}>Try again</button>
        </div>
      )}

      {loading && !stories.length && <div className="hn-empty">Fetching stories…</div>}
      {!loading && !error && !visible.length && (
        <div className="hn-empty">
          {q ? 'Nothing matches that.'
            : savedCount ? 'You have saved everything here. Try another tab, or Refresh.'
            : 'No stories came back.'}
        </div>
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
