import { useEffect, useState, useCallback } from 'react';

// Shared between onboarding and settings — the same control in both places, so
// the choice made on day one is the choice you edit on day ninety. Buzz does
// the same thing with its runtime picker, and it's the reason changing agents
// there never feels like a different feature from choosing one.

export function useRuntimes() {
  const [state, setState] = useState({ loading: true, runtimes: [], active: null });

  const refresh = useCallback(async () => {
    setState(s => ({ ...s, loading: true }));
    try {
      const res = await fetch('/api/agents/detect');
      const data = await res.json();
      setState({ loading: false, runtimes: data.runtimes || [], active: data.active });
    } catch {
      setState({ loading: false, runtimes: [], active: null });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { ...state, refresh };
}

function StatusChip({ runtime }) {
  if (!runtime.installed) return <span className="ap-chip ap-chip-missing">Not installed</span>;
  if (runtime.authenticated === false) {
    return <span className="ap-chip ap-chip-warn">Signed out</span>;
  }
  return <span className="ap-chip ap-chip-ok">Ready</span>;
}

export default function AgentPicker({ runtimes, loading, value, onChange, onRefresh }) {
  const [copied, setCopied] = useState(null);

  const copy = async (text, id) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(c => (c === id ? null : c)), 1600);
    } catch {
      // Clipboard can be denied; the command is visible either way.
    }
  };

  if (loading) {
    return (
      <div className="ap-loading">
        <div className="ap-spinner" />
        <span>Looking for coding CLIs on this Mac…</span>
      </div>
    );
  }

  return (
    <div className="ap-list">
      {runtimes.map(runtime => {
        const selected = value === runtime.id;
        const usable = runtime.installed;
        return (
          <div
            key={runtime.id}
            className={`ap-card ${selected ? 'selected' : ''} ${usable ? '' : 'unavailable'}`}
            role="radio"
            aria-checked={selected}
            tabIndex={usable ? 0 : -1}
            onClick={() => usable && onChange(runtime.id)}
            onKeyDown={e => {
              if (usable && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onChange(runtime.id);
              }
            }}
          >
            <div className="ap-card-main">
              <span className="ap-icon" aria-hidden="true">{runtime.icon}</span>
              <div className="ap-card-text">
                <div className="ap-card-title">
                  {runtime.label}
                  <span className="ap-vendor">{runtime.vendor}</span>
                </div>
                <div className="ap-card-blurb">{runtime.blurb}</div>
                {runtime.installed && runtime.version && (
                  <div className="ap-card-meta">{runtime.version}</div>
                )}
              </div>
              <div className="ap-card-right">
                <StatusChip runtime={runtime} />
                {selected && (
                  <svg className="ap-check" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                )}
              </div>
            </div>

            {!runtime.installed && (
              <div className="ap-install">
                <code>{runtime.installCommand}</code>
                <button
                  type="button"
                  className="ap-copy"
                  onClick={e => { e.stopPropagation(); copy(runtime.installCommand, runtime.id); }}
                >
                  {copied === runtime.id ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}

            {runtime.installed && runtime.authenticated === false && (
              <div className="ap-install ap-install-warn">
                <code>{runtime.loginHint}</code>
              </div>
            )}
          </div>
        );
      })}

      <button type="button" className="ap-recheck" onClick={onRefresh}>
        Re-check
      </button>
    </div>
  );
}
