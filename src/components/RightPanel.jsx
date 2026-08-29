import { useMemo, useState, useRef, useEffect } from 'react';
import { SOURCES, getSource } from '../sources';
// Note: syncSettingsOpen uses simple toggle — no outside-click needed since it's inline

const TOOLS = [
  {
    id: 'chat',
    label: 'Chat with Bookmarks',
    desc: 'Ask questions using AI',
    shortcut: '⌘K',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
      </svg>
    ),
  },
  {
    id: 'stats',
    label: 'Stats & Observations',
    desc: 'Trends, charts, monthly breakdown',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/>
      </svg>
    ),
  },
  {
    id: 'podcast',
    label: 'Bookmark Podcast',
    desc: 'Audio digest of your bookmarks',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 1a9 9 0 0 0-9 9v7c0 1.1.9 2 2 2h1v-8H4v-1a8 8 0 1 1 16 0v1h-2v8h1c1.1 0 2-.9 2-2v-7a9 9 0 0 0-9-9z"/>
      </svg>
    ),
  },
];

// Field Theory reads your X session out of a browser's cookie jar, so the only
// browser that can sync is one you actually read X in. Surfacing how long ago
// each last wrote a cookie turns "why is my sync 401-ing" into something you
// can see: the browser you use says today, the one it was pointed at says weeks.
function lastActiveHint(iso) {
  if (!iso) return 'no session found';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'active today';
  if (days === 1) return 'active yesterday';
  return `last active ${days} days ago`;
}

export default function RightPanel({
  bookmarks, currentVoice, onVoiceClick,
  syncState, onSync,
  activeMode, setActiveMode,
  aiBackend, onSetAiBackend,
  classifyBackend, onSetClassifyBackend,
  syncSource, onSetSyncSource, sourceInfo = [],
  syncBrowser, onSetSyncBrowser, browserInfo = [],
  onOpenSettings,
}) {
  const source = getSource(syncSource);
  const installedMap = Object.fromEntries(sourceInfo.map(s => [s.id, s.installed]));
  const [menuOpen, setMenuOpen]               = useState(false);
  const [syncSettingsOpen, setSyncSettingsOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  const authors = useMemo(() => {
    const count = {};
    const meta = {};
    bookmarks.forEach(b => {
      count[b.authorHandle] = (count[b.authorHandle] || 0) + 1;
      if (!meta[b.authorHandle]) meta[b.authorHandle] = { name: b.authorName, img: b.authorProfileImageUrl };
    });
    return Object.entries(count).sort((a, b) => b[1] - a[1]).map(([handle, c]) => ({
      handle, count: c, ...meta[handle],
    }));
  }, [bookmarks]);

  const btnClass = `action-btn ${syncState.status !== 'idle' ? syncState.status : ''}`.trim();

  /**
   * Return to first-run setup.
   *
   * There is no account to sign out of — the "session" is just the onboarded
   * flag, so clearing it is the whole operation. Nothing is destroyed: read
   * state, favourites, notes and the bookmarks path all live on and are still
   * there when setup finishes. The flag is cleared on the server rather than
   * only in memory, so quitting from the setup screen lands back on setup
   * rather than silently letting you back in.
   */
  async function handleLogOut() {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onboarded: false }),
      });
    } catch {
      // Even if the write fails, honour the click for this session.
    }
    window.dispatchEvent(new CustomEvent('tsb:run-onboarding'));
  }

  return (
    <aside className="right-panel">
      {/* Profile / Tools */}
      <div className="panel-card profile-card" ref={menuRef}>
        <button className="profile-btn" onClick={() => setMenuOpen(p => !p)}>
          <div className="profile-avatar" style={{background:'transparent',border:'none',padding:0,overflow:'hidden',borderRadius:'50%',width:32,height:32,flexShrink:0}}>
            <img src="/tj.png" alt="TJ" style={{width:'100%',height:'100%',objectFit:'cover',borderRadius:'50%'}}/>
          </div>
          <span className="profile-btn-label">Profile</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 'auto', color: 'var(--text-tertiary)', transform: menuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
            <path d="M7 10l5 5 5-5z"/>
          </svg>
        </button>

        {menuOpen && (
          <div className="profile-menu">
            {TOOLS.map(tool => (
              <button
                key={tool.id}
                className={`profile-menu-item ${activeMode === tool.id ? 'active' : ''}`}
                onClick={() => { setActiveMode(activeMode === tool.id ? null : tool.id); setMenuOpen(false); }}
              >
                <span className="profile-menu-icon">{tool.icon}</span>
                <div className="profile-menu-info">
                  <div className="profile-menu-label">{tool.label}</div>
                  <div className="profile-menu-desc">{tool.desc}</div>
                </div>
                {tool.shortcut && activeMode !== tool.id && (
                  <span className="profile-menu-kbd">{tool.shortcut}</span>
                )}
                {activeMode === tool.id && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--accent)"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                )}
              </button>
            ))}

            <div className="profile-menu-divider"><span>App</span></div>
            <button
              className="profile-menu-item"
              onClick={() => { setMenuOpen(false); onOpenSettings?.(); }}
            >
              <span className="profile-menu-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19.14 12.94a7.6 7.6 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.62l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.12.55-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.67 8.86a.5.5 0 0 0 .12.62l2.03 1.58a7.6 7.6 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.62l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.62zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/>
                </svg>
              </span>
              <div className="profile-menu-info">
                <div className="profile-menu-label">Settings</div>
                <div className="profile-menu-desc">AI, bookmarks, data</div>
              </div>
            </button>

            <button
              className="profile-menu-item danger"
              onClick={() => { setMenuOpen(false); handleLogOut(); }}
            >
              <span className="profile-menu-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.59L17 17l5-5-5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4V5z"/>
                </svg>
              </span>
              <div className="profile-menu-info">
                <div className="profile-menu-label">Log out</div>
                <div className="profile-menu-desc">Back to setup</div>
              </div>
            </button>
          </div>
        )}
      </div>

      {/* Voices */}
      <div className="panel-card">
        <div className="panel-card-title">Voices</div>
        <div className="voices-list">
          {authors.map(a => (
            <div
              key={a.handle}
              className={`top-author ${currentVoice === a.handle ? 'active' : ''}`}
              onClick={() => onVoiceClick(a.handle)}
              title={currentVoice === a.handle
                ? `Showing only @${a.handle} — click to clear`
                : `Show only @${a.handle}`}
            >
              <div className="top-author-avatar">
                {a.img && <img src={a.img} alt="" loading="lazy" onError={e => e.target.style.display='none'} />}
              </div>
              <div className="top-author-info">
                <div className="top-author-name">{a.name || a.handle}</div>
                <div className="top-author-handle">@{a.handle}</div>
              </div>
              <div className="top-author-count">{a.count}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Sync & Classify */}
      <div className="panel-card">
        <div className="panel-card-title">
          Sync &amp; Classify
          <button
            className={`sync-settings-gear ${syncSettingsOpen ? 'open' : ''}`}
            onClick={() => setSyncSettingsOpen(p => !p)}
            title="Classify engine settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          </button>
        </div>

        {/* Inline source + classify pickers — expand when gear is open */}
        {syncSettingsOpen && (
          <>
          <div className="sync-section-label">Source</div>
          <div className="sync-backend-list" style={{ marginBottom: 10 }}>
            {SOURCES.map(s => (
              <button
                key={s.id}
                className={`sync-backend-item ${syncSource === s.id ? 'active' : ''}`}
                onClick={() => onSetSyncSource(s.id)}
              >
                <span>{s.icon} {s.label}{installedMap[s.id] === false ? ' · not installed' : ''}</span>
                <span className="sync-backend-hint">{s.blurb}</span>
              </button>
            ))}
          </div>
          {browserInfo.length > 0 && (
            <>
            <div className="sync-section-label">Browser session</div>
            <div className="sync-backend-list" style={{ marginBottom: 10 }}>
            {browserInfo.map(b => (
              <button
                key={b.id}
                className={`sync-backend-item ${syncBrowser === b.id ? 'active' : ''}`}
                onClick={() => onSetSyncBrowser(b.id)}
              >
                <span>{b.label}</span>
                <span className="sync-backend-hint">{lastActiveHint(b.lastActive)}</span>
              </button>
            ))}
            </div>
            </>
          )}
          <div className="sync-section-label">Classify engine</div>
          <div className="sync-backend-list" style={{ marginBottom: 12 }}>
            {[
              { id: 'python', label: '🐍 Python', hint: 'regex + optional OpenAI key' },
              { id: 'claude', label: '⚡ Claude Code CLI', hint: 'local claude -p' },
              { id: 'codex',  label: '🤖 Codex CLI',      hint: 'local codex exec, read-only' },
            ].map(b => (
              <button
                key={b.id}
                className={`sync-backend-item ${classifyBackend === b.id ? 'active' : ''}`}
                onClick={() => onSetClassifyBackend(b.id)}
              >
                <span>{b.label}</span>
                <span className="sync-backend-hint">{b.hint}</span>
              </button>
            ))}
          </div>
          </>
        )}

        <button className={btnClass} onClick={onSync}>
          <svg viewBox="0 0 24 24" fill="currentColor" className={syncState.status === 'running' ? 'spin' : ''}>
            <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
          </svg>
          Sync via {source.label}
        </button>
        {syncState.msg && (
          <div
            className={`action-status ${syncState.status === 'error' ? 'error' : ''}`.trim()}
            style={{ marginTop: 6 }}
          >
            {syncState.msg}
          </div>
        )}
      </div>
    </aside>
  );
}
