import { useState, useEffect, useCallback } from 'react';
import AgentPicker, { useRuntimes } from './AgentPicker';
import BookmarkFinder from './BookmarkFinder';
import { getSource, DEFAULT_SOURCE } from '../sources';

// First-run setup.
//
// Three decisions, in the order they actually depend on each other: which AI
// CLI to drive, where your bookmarks live, and then you're in. The AI step
// comes first because the bookmark step uses it — by the time we offer to find
// your collection, we already know who's being asked to identify it.
//
// Every step is skippable. An onboarding that can't be escaped is a wall, and
// the app degrades honestly without any of these: no CLI means no chat, no
// bookmarks means an empty feed with a prompt to sync.

const STEPS = ['welcome', 'agent', 'bookmarks', 'done'];

function StepDots({ index }) {
  return (
    <div className="ob-dots" role="progressbar" aria-valuenow={index + 1} aria-valuemax={STEPS.length}>
      {STEPS.map((step, i) => (
        <span key={step} className={`ob-dot ${i === index ? 'active' : ''} ${i < index ? 'done' : ''}`} />
      ))}
    </div>
  );
}

/** Field Theory setup — the path for someone with no bookmarks on disk yet. */
function FieldTheorySetup({ onSynced }) {
  const [installed, setInstalled] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [log, setLog] = useState('');
  const [error, setError] = useState(null);
  const source = getSource(DEFAULT_SOURCE);

  const checkInstalled = useCallback(() => {
    setInstalled(null);
    fetch('/api/sources')
      .then(r => r.json())
      .then(d => setInstalled(d.sources?.find(s => s.id === DEFAULT_SOURCE)?.installed ?? false))
      .catch(() => setInstalled(false));
  }, []);

  useEffect(() => { checkInstalled(); }, [checkInstalled]);

  // Sync is fire-and-forget on the server; /api/status is how we learn it ended.
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        setLog(`${data.sync?.log || ''}${data.classify?.log || ''}`.trim());
        const done = data.sync?.status === 'done' && data.classify?.status === 'done';
        const failed = data.sync?.status === 'error' || data.classify?.status === 'error';
        if (done) { setSyncing(false); onSynced?.(); }
        if (failed) { setSyncing(false); setError('Sync failed — see the log above.'); }
      } catch {
        // Transient; the next tick will catch up.
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [syncing, onSynced]);

  const startSync = async () => {
    setError(null);
    setSyncing(true);
    try {
      const res = await fetch('/api/syncall', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) { setSyncing(false); setError(data.msg); }
    } catch (e) {
      setSyncing(false);
      setError(e.message);
    }
  };

  if (installed === null) return <div className="ob-inline-loading">Checking for Field Theory…</div>;

  if (!installed) {
    return (
      <div className="ob-ft">
        <p className="ob-ft-lead">
          Field Theory pulls your bookmarks straight out of X. It isn't installed yet.
        </p>
        <div className="ap-install">
          <code>{source.install}</code>
          <button
            type="button"
            className="ap-copy"
            onClick={() => navigator.clipboard?.writeText(source.install).catch(() => {})}
          >
            Copy
          </button>
        </div>
        <p className="ob-ft-note">
          Install it in a terminal, then come back and press Re-check.
        </p>
        <button type="button" className="bf-secondary" onClick={checkInstalled}>
          Re-check
        </button>
      </div>
    );
  }

  return (
    <div className="ob-ft">
      <p className="ob-ft-lead">
        Field Theory is installed. Syncing opens Chrome to read your bookmarks from X.
      </p>
      <button type="button" className="bf-primary" onClick={startSync} disabled={syncing}>
        {syncing ? 'Syncing…' : 'Sync from X'}
      </button>
      {log && <pre className="ob-ft-log">{log.slice(-600)}</pre>}
      {error && <div className="ob-ft-error">{error}</div>}
    </div>
  );
}

export default function Onboarding({ onFinish }) {
  const [index, setIndex] = useState(0);
  const [backend, setBackend] = useState('claude');
  const [connected, setConnected] = useState(null);
  const [path, setPath] = useState('find'); // find | fieldtheory
  const { runtimes, loading, active, refresh } = useRuntimes();

  const step = STEPS[index];

  // Default to whichever CLI is actually usable, preferring any saved choice.
  useEffect(() => {
    if (loading) return;
    const usable = runtimes.filter(r => r.installed);
    const preferred =
      usable.find(r => r.id === active) || usable.find(r => r.authenticated !== false) || usable[0];
    if (preferred) setBackend(preferred.id);
  }, [loading, runtimes, active]);

  const saveBackend = useCallback(async (id) => {
    setBackend(id);
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiBackend: id }),
    }).catch(() => {});
  }, []);

  const finish = useCallback(async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboarded: true, aiBackend: backend }),
    }).catch(() => {});
    onFinish?.();
  }, [backend, onFinish]);

  const next = () => setIndex(i => Math.min(i + 1, STEPS.length - 1));
  const back = () => setIndex(i => Math.max(i - 1, 0));

  const agentLabel = backend === 'codex' ? 'Codex' : 'Claude';
  const anyInstalled = runtimes.some(r => r.installed);

  return (
    <div className="ob-root">
      <div className="ob-glass" aria-hidden="true" />

      <div className="ob-shell">
        <header className="ob-head">
          <div className="ob-mark">Third Street</div>
          <StepDots index={index} />
        </header>

        <main className="ob-body" key={step}>
          {step === 'welcome' && (
            <section className="ob-step ob-welcome">
              <h1 className="ob-title">Your bookmarks, on your Mac.</h1>
              <p className="ob-lead">
                Third Street reads your X bookmarks locally — searchable, categorised,
                and listenable. Nothing is uploaded. The AI features run on coding CLIs
                you already have installed.
              </p>
              <ul className="ob-bullets">
                <li><span aria-hidden="true">✦</span> Ask questions about six years of saved posts</li>
                <li><span aria-hidden="true">✦</span> Generate an audio digest from any topic</li>
                <li><span aria-hidden="true">✦</span> Your read and favourite history stays yours</li>
              </ul>
              <p className="ob-timing">Takes about a minute.</p>
            </section>
          )}

          {step === 'agent' && (
            <section className="ob-step">
              <h1 className="ob-title">Choose your AI</h1>
              <p className="ob-lead">
                Chat, podcasts and auto-categorising run through a coding CLI on this Mac.
                No API key — it uses the subscription you already pay for.
              </p>
              <AgentPicker
                runtimes={runtimes}
                loading={loading}
                value={backend}
                onChange={saveBackend}
                onRefresh={refresh}
              />
              {!loading && !anyInstalled && (
                <p className="ob-skip-note">
                  You can skip this — everything except the AI features works without one.
                </p>
              )}
            </section>
          )}

          {step === 'bookmarks' && (
            <section className="ob-step">
              <h1 className="ob-title">Connect your bookmarks</h1>

              <div className="ob-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={path === 'find'}
                  className={`ob-tab ${path === 'find' ? 'active' : ''}`}
                  onClick={() => setPath('find')}
                >
                  I already have some
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={path === 'fieldtheory'}
                  className={`ob-tab ${path === 'fieldtheory' ? 'active' : ''}`}
                  onClick={() => setPath('fieldtheory')}
                >
                  Sync from X
                </button>
              </div>

              {path === 'find' ? (
                <BookmarkFinder
                  runtime={backend}
                  agentLabel={agentLabel}
                  onAdopted={setConnected}
                />
              ) : (
                <FieldTheorySetup onSynced={() => setConnected({ count: null })} />
              )}
            </section>
          )}

          {step === 'done' && (
            <section className="ob-step ob-done">
              <div className="ob-done-mark" aria-hidden="true">✦</div>
              <h1 className="ob-title">You're set.</h1>
              <p className="ob-lead">
                {connected?.count
                  ? `${connected.count.toLocaleString()} bookmarks connected, running on ${agentLabel}.`
                  : connected
                    ? `Bookmarks connected, running on ${agentLabel}.`
                    : 'You can connect bookmarks any time from the Sync panel.'}
              </p>
              <p className="ob-timing">
                Everything here is changeable later under Settings.
              </p>
            </section>
          )}
        </main>

        <footer className="ob-foot">
          <button
            type="button"
            className="ob-ghost"
            onClick={back}
            disabled={index === 0}
          >
            Back
          </button>

          <div className="ob-foot-right">
            {step !== 'done' && (
              <button type="button" className="ob-ghost" onClick={finish}>
                Skip setup
              </button>
            )}
            {step === 'done' ? (
              <button type="button" className="ob-next" onClick={finish}>
                Open my bookmarks
              </button>
            ) : (
              <button type="button" className="ob-next" onClick={next}>
                Continue
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
