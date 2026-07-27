// Rewrites the app's relative `/api/...` calls onto the local Express sidecar.
//
// In a browser (`npm run dev`) Vite proxies /api, so this is a no-op. Inside the
// Tauri webview the page is served from tauri://localhost and relative URLs
// resolve against that origin, which has no server behind it. The Rust side
// picks a free port at launch and injects it as `window.__TSB_API_PORT__`
// before any app code runs; we prefix matching requests with it.
//
// Patching fetch rather than editing 14 components keeps this fork a
// zero-diff overlay on the upstream client — upstream changes still merge clean.

const port = typeof window !== 'undefined' ? window.__TSB_API_PORT__ : null;

// Per-launch shared secret, injected alongside the port. The server refuses
// every /api call without it, which is what stops a page you happen to visit
// from reading your bookmarks off 127.0.0.1 — the browser can reach the port,
// but it cannot guess this.
const token = typeof window !== 'undefined' ? window.__TSB_API_TOKEN__ : null;

export const API_ORIGIN = port ? `http://127.0.0.1:${port}` : '';

export function apiUrl(path) {
  if (!API_ORIGIN) return path;
  return path.startsWith('/api') ? API_ORIGIN + path : path;
}

/** Attach the bearer token to requests aimed at our own API, and nothing else. */
function authorize(url, init) {
  if (!token) return init;
  const target = String(url);
  const isOurApi = API_ORIGIN
    ? target.startsWith(`${API_ORIGIN}/api`)
    : target.startsWith('/api');
  if (!isOurApi) return init;

  const headers = new Headers(init?.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

if (API_ORIGIN) {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input, init) => {
    // String or URL target — the common case throughout the app.
    if (typeof input === 'string') {
      const url = apiUrl(input);
      return nativeFetch(url, authorize(url, init));
    }
    if (input instanceof URL) {
      const url = apiUrl(input.toString());
      return nativeFetch(url, authorize(url, init));
    }

    // Request object — rebuild it against the rewritten URL. Only relative /api
    // targets need this; anything absolute already points where it should.
    if (typeof Request !== 'undefined' && input instanceof Request) {
      const rewritten = apiUrl(input.url.replace(window.location.origin, ''));
      const request = rewritten === input.url ? input : new Request(rewritten, input);
      return nativeFetch(request, authorize(rewritten, init));
    }

    return nativeFetch(input, init);
  };

  // Audio/media elements take the same treatment — the podcast and TTS players
  // set `src` to /api paths directly, bypassing fetch.
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'src',
  );
  if (descriptor?.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      ...descriptor,
      set(value) {
        descriptor.set.call(this, typeof value === 'string' ? apiUrl(value) : value);
      },
    });
  }
}
