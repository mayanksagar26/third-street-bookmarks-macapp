import { useState, useEffect, useCallback } from 'react';
import App from './App';
import Onboarding from './components/Onboarding';
import { apiUrl } from './api-base';

// Injected by the Rust side before page load; absent in a plain browser, where
// Vite proxies /api instead.
const port = typeof window !== 'undefined' ? window.__TSB_API_PORT__ : null;

// Gate the app behind sidecar readiness.
//
// Tauri spawns the Express server as a child process at launch. The webview is
// usually painted first, so mounting App immediately means every initial fetch
// races the server's listen() and fails. We poll a cheap endpoint until it
// answers, then hand off.

const POLL_INTERVAL_MS = 150;
const GIVE_UP_AFTER_MS = 30_000;

export default function Boot() {
  const [state, setState] = useState('waiting'); // waiting | onboarding | ready | failed

  // Settings decide which of the two ready states we land in. Read once the
  // server answers, since it's the server that owns settings.json.
  const resolveReady = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/settings'));
      const settings = await res.json();
      setState(settings?.onboarded ? 'ready' : 'onboarding');
    } catch {
      // Settings unreadable — the app itself still works, so don't trap the
      // user in setup over it.
      setState('ready');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    async function poll() {
      if (cancelled) return;
      try {
        // /api/health is the one unauthenticated route — readiness has to be
        // answerable before anything else, and it reveals nothing the open
        // port doesn't already.
        const res = await fetch(apiUrl('/api/health'));
        if (res.ok) {
          if (!cancelled) await resolveReady();
          return;
        }
      } catch {
        // Server not up yet — expected during the first few hundred ms.
      }
      if (cancelled) return;
      if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
        setState('failed');
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    }

    poll();
    return () => { cancelled = true; };
  }, [resolveReady]);

  // Re-runnable from the app, so setup isn't a one-shot you can never see again.
  useEffect(() => {
    const replay = () => setState('onboarding');
    window.addEventListener('tsb:run-onboarding', replay);
    return () => window.removeEventListener('tsb:run-onboarding', replay);
  }, []);

  if (state === 'onboarding') return <Onboarding onFinish={() => setState('ready')} />;
  if (state === 'ready') return <App />;

  return (
    <div className="tsb-boot">
      <div className="tsb-boot-inner">
        <div className="tsb-boot-mark">Third Street</div>
        {state === 'waiting' ? (
          <>
            <div className="tsb-boot-spinner" />
            <div className="tsb-boot-note">Starting local server…</div>
          </>
        ) : (
          <>
            <div className="tsb-boot-error">Couldn’t reach the local server.</div>
            <div className="tsb-boot-note">
              {port ? (
                <>The server was expected on port <code>{port}</code> but never answered.</>
              ) : (
                <>No port reached the window — the app may not have found Node.js 20+.</>
              )}
              <br />
              Check <code>Help → Show Server Log</code> for details.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
