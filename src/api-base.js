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

export const API_ORIGIN = port ? `http://127.0.0.1:${port}` : '';

export function apiUrl(path) {
  if (!API_ORIGIN) return path;
  return path.startsWith('/api') ? API_ORIGIN + path : path;
}

if (API_ORIGIN) {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input, init) => {
    // String or URL target — the common case throughout the app.
    if (typeof input === 'string') return nativeFetch(apiUrl(input), init);
    if (input instanceof URL) return nativeFetch(apiUrl(input.toString()), init);

    // Request object — rebuild it against the rewritten URL. Only relative /api
    // targets need this; anything absolute already points where it should.
    if (typeof Request !== 'undefined' && input instanceof Request) {
      const rewritten = apiUrl(input.url.replace(window.location.origin, ''));
      if (rewritten === input.url) return nativeFetch(input, init);
      return nativeFetch(new Request(rewritten, input), init);
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
