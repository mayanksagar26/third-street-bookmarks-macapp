import { useState, useRef, useCallback } from 'react';

// The app's party trick: point it at a Mac and it works out where your
// bookmarks already live, then explains its choice in your own words.
//
// The server streams NDJSON so this can narrate the search instead of showing
// an indeterminate spinner for seven seconds — the narration is most of why the
// feature reads as competent rather than slow.

function formatCount(n) {
  return n.toLocaleString();
}

function formatSize(bytes) {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function shortenPath(p) {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

export default function BookmarkFinder({ runtime, agentLabel, onAdopted }) {
  const [phase, setPhase] = useState('idle'); // idle | running | results | adopted | error
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [error, setError] = useState(null);
  const [adopted, setAdopted] = useState(null);
  const abortRef = useRef(null);

  const run = useCallback(async () => {
    setPhase('running');
    setProgress({ stage: 'scan', message: 'Starting…' });
    setResult(null);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/discover-bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime }),
        signal: controller.signal,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // NDJSON: a chunk can split a line, so hold the tail until a newline.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;

          let event;
          try { event = JSON.parse(line); } catch { continue; }

          if (event.type === 'progress') setProgress(event);
          else if (event.type === 'error') { setError(event.message); setPhase('error'); }
          else if (event.type === 'result') {
            setResult(event);
            setChosen(event.pick);
            setPhase(event.candidates.length ? 'results' : 'error');
            if (!event.candidates.length) setError('No bookmark files found on this Mac.');
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setError(e.message || 'Search failed.');
        setPhase('error');
      }
    }
  }, [runtime]);

  const adopt = useCallback(async () => {
    if (!chosen) return;
    try {
      const res = await fetch('/api/adopt-bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: chosen }),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.msg); setPhase('error'); return; }
      setAdopted(data);
      setPhase('adopted');
      onAdopted?.(data);
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  }, [chosen, onAdopted]);

  if (phase === 'idle') {
    return (
      <div className="bf-idle">
        <button type="button" className="bf-primary" onClick={run}>
          <span className="bf-sparkle" aria-hidden="true">✦</span>
          Find my bookmarks
        </button>
        <p className="bf-idle-note">
          Searches the usual places on this Mac, then asks {agentLabel} which file is
          really yours. Nothing leaves your machine.
        </p>
      </div>
    );
  }

  if (phase === 'running') {
    const detail = progress?.dirsWalked
      ? `${formatCount(progress.dirsWalked)} folders checked`
      : null;
    return (
      <div className="bf-running">
        <div className="bf-spinner" />
        <div className="bf-running-text">
          <div className="bf-running-message">{progress?.message || 'Working…'}</div>
          {detail && <div className="bf-running-detail">{detail}</div>}
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="bf-error">
        <div className="bf-error-title">{error}</div>
        <p className="bf-error-note">
          You can still sync from scratch with Field Theory, or drop a
          <code>bookmarks.json</code> into <code>~/.tsb/</code>.
        </p>
        <button type="button" className="bf-secondary" onClick={run}>Try again</button>
      </div>
    );
  }

  if (phase === 'adopted') {
    return (
      <div className="bf-adopted">
        <div className="bf-adopted-check" aria-hidden="true">✓</div>
        <div>
          <div className="bf-adopted-title">
            {formatCount(adopted.count)} bookmarks connected
          </div>
          <div className="bf-adopted-path">{shortenPath(adopted.path)}</div>
        </div>
      </div>
    );
  }

  // results
  const multiple = result.candidates.length > 1;
  return (
    <div className="bf-results">
      {result.reason && (
        <div className="bf-verdict">
          {result.judgedBy && (
            <span className="bf-verdict-badge">
              {result.judgedBy === 'codex' ? '◆' : '✳️'} {agentLabel} picked
            </span>
          )}
          <span className="bf-verdict-text">{result.reason}</span>
        </div>
      )}

      <div className="bf-candidates">
        {result.candidates.map(candidate => {
          const selected = chosen === candidate.path;
          return (
            <button
              type="button"
              key={candidate.path}
              className={`bf-candidate ${selected ? 'selected' : ''}`}
              onClick={() => setChosen(candidate.path)}
            >
              <div className="bf-candidate-head">
                <span className="bf-candidate-count">{formatCount(candidate.count)}</span>
                <span className="bf-candidate-unit">bookmarks</span>
                {candidate.classified && <span className="bf-tag">categorised</span>}
                {selected && <span className="bf-candidate-tick">✓</span>}
              </div>
              <div className="bf-candidate-path">{shortenPath(candidate.path)}</div>
              <div className="bf-candidate-meta">
                {formatSize(candidate.sizeBytes)}
                {candidate.newest && ` · newest ${candidate.newest.slice(0, 10)}`}
              </div>
            </button>
          );
        })}
      </div>

      {multiple && (
        <p className="bf-alt-note">
          Not the right one? Pick another above.
        </p>
      )}

      <button type="button" className="bf-primary" onClick={adopt} disabled={!chosen}>
        Use this collection
      </button>
    </div>
  );
}
