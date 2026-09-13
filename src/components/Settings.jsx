import { useState, useEffect, useCallback, useRef } from 'react';
import { FONTS, DEFAULT_FONT, applyFont } from '../fonts';
import AgentPicker, { useRuntimes } from './AgentPicker';
import BookmarkFinder from './BookmarkFinder';
import {
  AVATARS,
  CUSTOM_AVATAR,
  DEFAULT_AVATAR,
  announceAvatarChange,
  loadCustomAvatar,
  squareImage,
} from '../avatars';

// Settings is onboarding without the sequence.
//
// The AI picker and the bookmark finder are literally the same components used
// in first-run, so the control you met on day one is the control you edit on
// day ninety. Buzz does this with its runtime settings and it's the reason
// changing agents there never feels like a different feature from choosing one.

const SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'ai', label: 'AI' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'window', label: 'Window' },
  { id: 'appearance', label: 'Appearance' },
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

/** Everything inside `root` that a Tab can land on, in document order. */
function focusables(root) {
  return [...root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter(el => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Pick a profile picture: TJ (the default), another Recess character, or a
 * picture of your own.
 */
function AvatarPicker({ value, hasUpload, onPick }) {
  const [customSrc, setCustomSrc] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  // Bumped on each successful upload, so replacing a picture re-fetches it.
  const [uploadVersion, setUploadVersion] = useState(0);
  const fileRef = useRef(null);

  // Show an earlier upload as a choice even while a character is selected, so
  // switching back to it doesn't mean uploading it again.
  useEffect(() => {
    if (!hasUpload) return undefined;
    let src = null;
    let cancelled = false;
    loadCustomAvatar()
      .then(url => {
        if (cancelled) { if (url) URL.revokeObjectURL(url); return; }
        src = url;
        setCustomSrc(prev => { if (prev && prev !== url) URL.revokeObjectURL(prev); return url; });
      })
      .catch(() => {});
    return () => { cancelled = true; if (src) URL.revokeObjectURL(src); };
  }, [hasUpload, uploadVersion]);

  async function upload(file) {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('Pick an image file — PNG, JPEG, WebP or similar.');
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await squareImage(file);
      const res = await fetch('/api/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Upload failed');
      setUploadVersion(v => v + 1);
      onPick(CUSTOM_AVATAR, { saved: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const current = value || DEFAULT_AVATAR;

  return (
    <div className="avatar-picker">
    <div className="avatar-grid">
      <div
        className="avatar-options"
        role="radiogroup"
        aria-label="Profile picture"
        onKeyDown={e => {
          // Arrow keys move between choices, as a radio group promises.
          const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
          if (!step) return;
          const radios = [...e.currentTarget.querySelectorAll('[role="radio"]')];
          const idx = radios.indexOf(document.activeElement);
          if (idx < 0) return;
          e.preventDefault();
          const next = radios[(idx + step + radios.length) % radios.length];
          next.focus();
          next.click();
        }}
      >
      {AVATARS.map(a => (
        <button
          key={a.id}
          type="button"
          role="radio"
          aria-checked={current === a.id}
          className={`avatar-choice ${current === a.id ? 'active' : ''}`}
          onClick={() => onPick(a.id)}
        >
          <img src={a.src} alt="" className="avatar-choice-img" />
          <span className="avatar-choice-label">
            {a.label}{a.id === DEFAULT_AVATAR ? ' · default' : ''}
          </span>
        </button>
      ))}

      {customSrc && (
        <button
          type="button"
          role="radio"
          aria-checked={current === CUSTOM_AVATAR}
          className={`avatar-choice ${current === CUSTOM_AVATAR ? 'active' : ''}`}
          onClick={() => onPick(CUSTOM_AVATAR)}
        >
          <img src={customSrc} alt="" className="avatar-choice-img" />
          <span className="avatar-choice-label">Your picture</span>
        </button>
      )}
      </div>

      <button
        type="button"
        className="avatar-choice avatar-upload"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        aria-describedby={error ? 'avatar-upload-error' : undefined}
      >
        <span className="avatar-choice-img avatar-upload-icon" aria-hidden="true">
          {uploading ? '…' : '+'}
        </span>
        <span className="avatar-choice-label">
          {uploading ? 'Uploading' : customSrc ? 'Replace yours' : 'Upload'}
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={e => upload(e.target.files?.[0])}
      />

    </div>
      {error && <p id="avatar-upload-error" className="avatar-error" role="alert">{error}</p>}
    </div>
  );
}

export default function Settings({ onClose, initialSection }) {
  const [section, setSection] = useState(
    SECTIONS.some(s => s.id === initialSection) ? initialSection : 'profile',
  );
  const [settings, setSettings] = useState(null);
  const { runtimes, loading, active, refresh } = useRuntimes();
  const panelRef = useRef(null);

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

  /**
   * Keep the keyboard inside the dialog while it is open.
   *
   * A modal that only *looks* modal is the worst of both: the page behind it is
   * dimmed and inert to the mouse, but Tab walks straight out into it, and a
   * screen reader user ends up reading a feed they cannot see. So: focus moves
   * in on open, Tab and Shift-Tab wrap at the ends, and whatever was focused
   * before gets it back on close.
   *
   * Hand-rolled rather than pulled from a library — this app ships three
   * runtime dependencies, and a focus trap is fifteen lines.
   */
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previous = document.activeElement;
    (focusables(panel)[0] || panel).focus();

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusables(panel);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      // Focus that has escaped the panel entirely comes back to an end of it.
      if (!panel.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, []);

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
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
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
              id={`set-tab-${s.id}`}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              aria-controls="set-tabpanel"
              className={`ob-tab ${section === s.id ? 'active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div
          className="set-body"
          id="set-tabpanel"
          role="tabpanel"
          aria-labelledby={`set-tab-${section}`}
        >
          {section === 'profile' && (
            <>
              <p className="set-lead">
                The picture on your Profile button. TJ is the default; the rest
                of the Recess gang are here too, or upload your own. An upload is
                cropped to a square and kept in your data folder.
              </p>
              <AvatarPicker
                value={settings?.avatar}
                hasUpload={!!settings?.avatarUploaded}
                onPick={(id, { saved } = {}) => {
                  if (saved) setSettings(s => ({ ...s, avatar: id, avatarUploaded: true }));
                  const done = saved ? Promise.resolve() : patch({ avatar: id });
                  done.then(announceAvatarChange);
                }}
              />
            </>
          )}

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
                      aria-pressed={settings?.classifyBackend === opt.id}
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
                      aria-pressed={settings?.viewMode === mode.id}
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

          {section === 'appearance' && (
            <>
              <p className="set-lead">
                Applies to the text you read — bookmarks, chat answers, story
                titles. The sidebar and buttons keep the system font, because a
                hand-drawn interface is a novelty where a hand-drawn page is a
                reading choice.
              </p>
              <div className="set-field">
                <div className="set-field-label">Reading font</div>
                <div className="set-choices">
                  {FONTS.map(font => (
                    <button
                      key={font.id}
                      type="button"
                      className={`set-choice ${(settings?.readingFont || DEFAULT_FONT) === font.id ? 'active' : ''}`}
                      aria-pressed={(settings?.readingFont || DEFAULT_FONT) === font.id}
                      onClick={() => { patch({ readingFont: font.id }); applyFont(font.id); }}
                    >
                      <span className="set-choice-label">{font.label}</span>
                      <span className="set-choice-hint">{font.hint}</span>
                      {/* Previewed in itself — a name alone tells you nothing. */}
                      <span
                        className="font-choice-sample"
                        style={{ fontFamily: font.stack }}
                      >
                        The quick brown fox jumps over the lazy dog
                      </span>
                    </button>
                  ))}
                </div>
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
