import { useState, useEffect, useCallback } from 'react';
import AgentPicker, { useRuntimes } from './AgentPicker';
import BookmarkFinder from './BookmarkFinder';

// Settings is onboarding without the sequence.
//
// The AI picker and the bookmark finder are literally the same components used
// in first-run, so the control you met on day one is the control you edit on
// day ninety. Buzz does this with its runtime settings and it's the reason
// changing agents there never feels like a different feature from choosing one.

const SECTIONS = [
  { id: 'ai', label: 'AI' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'window', label: 'Window' },
  { id: 'about', label: 'About' },
];

const VIEW_MODES = [
  { id: 'expanded', label: 'Expanded', hint: 'Full width, three columns' },
  { id: 'popup', label: 'Popup', hint: 'Narrow, floats above other apps' },
];

/**
 * Resize the native window.
 *
 * Only meaningful inside Tauri; in a browser there is no window to resize, so
 * the control is hidden rather than being present and inert.
 */
async function applyViewMode(mode) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_view_mode', { mode });
  } catch {
    // Not running under Tauri, or the command is unavailable.
  }
}

const isDesktop = typeof window !== 'undefined' && Boolean(window.__TSB_API_PORT__);

function shortenPath(p) {
  return p ? p.replace(/^\/Users\/[^/]+/, '~') : null;
}

export default function Settings({ onClose }) {
  const [section, setSection] = useState('ai');
  const [settings, setSettings] = useState(null);
  const { runtimes, loading, active, refresh } = useRuntimes();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      setSettings(await res.json());
    } catch {
      setSettings({});
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Escape closes, like every other sheet on this platform.
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const patch = useCallback(async (changes) => {
    setSettings(s => ({ ...s, ...changes }));
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    }).catch(() => {});
  }, []);

  const backend = settings?.aiBackend || active || 'claude';
  const agentLabel = backend === 'codex' ? 'Codex' : 'Claude';

  return (
    <div className="set-overlay" onClick={onClose}>
      <div
        className="set-panel"
        role="dialog"
        aria-label="Settings"
        onClick={e => e.stopPropagation()}
      >
        <header className="set-head">
          <h2 className="set-title">Settings</h2>
          <button type="button" className="set-close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <nav className="set-tabs" role="tablist">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              className={`ob-tab ${section === s.id ? 'active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="set-body">
          {section === 'ai' && (
            <>
              <p className="set-lead">
                Powers chat, the podcast, and auto-categorising. Runs on this Mac
                against the subscription you already pay for.
              </p>
              <AgentPicker
                runtimes={runtimes}
                loading={loading}
                value={backend}
                onChange={id => patch({ aiBackend: id })}
                onRefresh={refresh}
              />

              <div className="set-divider" />

              <div className="set-field">
                <div className="set-field-label">Categorise with</div>
                <div className="set-choices">
                  {[
                    { id: 'python', label: 'Python', hint: 'Offline regex — fast, free' },
                    { id: 'claude', label: 'Claude', hint: 'Better labels, slower' },
                    { id: 'codex', label: 'Codex', hint: 'Better labels, slower' },
                  ].map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`set-choice ${settings?.classifyBackend === opt.id ? 'active' : ''}`}
                      onClick={() => patch({ classifyBackend: opt.id })}
                    >
                      <span className="set-choice-label">{opt.label}</span>
                      <span className="set-choice-hint">{opt.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {section === 'bookmarks' && (
            <>
              <div className="set-field">
                <div className="set-field-label">Current collection</div>
                <div className="set-path">
                  {shortenPath(settings?.bookmarksPath) || '~/.tsb/bookmarks.json (default)'}
                </div>
              </div>

              <div className="set-divider" />

              <p className="set-lead">
                Point the app somewhere else. It searches this Mac, then asks
                {' '}{agentLabel} which file is really yours.
              </p>
              <BookmarkFinder
                runtime={backend}
                agentLabel={agentLabel}
                onAdopted={data => setSettings(s => ({ ...s, bookmarksPath: data.path }))}
              />
            </>
          )}

          {section === 'window' && (
            <>
              <p className="set-lead">
                Expanded is the reading layout. Popup is a narrow companion you
                keep beside whatever you're working on — it floats above other
                windows and drops the side panels.
              </p>
              <div className="set-field">
                <div className="set-field-label">View</div>
                <div className="set-choices">
                  {VIEW_MODES.map(mode => (
                    <button
                      key={mode.id}
                      type="button"
                      className={`set-choice ${settings?.viewMode === mode.id ? 'active' : ''}`}
                      onClick={() => { patch({ viewMode: mode.id }); applyViewMode(mode.id); }}
                      disabled={!isDesktop}
                    >
                      <span className="set-choice-label">{mode.label}</span>
                      <span className="set-choice-hint">{mode.hint}</span>
                    </button>
                  ))}
                </div>
                <p className="set-lead" style={{ fontSize: 12 }}>
                  Also on <code>⌘1</code> and <code>⌘2</code>, under the View menu.
                  Dragging the window narrow switches layout on its own.
                </p>
              </div>
            </>
          )}

          {section === 'about' && (
            <>
              <p className="set-lead">
                Third Street Bookmarks reads your X bookmarks locally. Nothing is
                uploaded, and the AI features run entirely on CLIs installed on
                this Mac.
              </p>
              <div className="set-field">
                <div className="set-field-label">Where your data lives</div>
                <div className="set-path">~/.tsb/state.db — read, favourites, labels, notes</div>
                <div className="set-path">{shortenPath(settings?.bookmarksPath) || '~/.tsb/bookmarks.json'} — the collection</div>
              </div>

              <div className="set-divider" />

              <button
                type="button"
                className="bf-secondary"
                onClick={() => {
                  onClose?.();
                  window.dispatchEvent(new CustomEvent('tsb:run-onboarding'));
                }}
              >
                Run setup again
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
