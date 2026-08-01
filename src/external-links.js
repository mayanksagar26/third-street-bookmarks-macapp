// Route every external link to the user's real browser.
//
// `target="_blank"` is meaningless inside a webview: there is no tab to open
// into, and the app's CSP blocks navigating away from the bundle, so clicking
// "View on X" simply did nothing. Tauri hands the URL to the OS instead.
//
// This is a single capture-phase listener on the document rather than an
// onClick on each link, for two reasons. Tweet text is rendered through
// `dangerouslySetInnerHTML`, so its inline links are raw HTML that React never
// sees and cannot be given a handler. And catching them centrally means links
// added later work without anyone remembering this file exists.

/** True when running inside the packaged app rather than a browser tab. */
const inDesktopApp = typeof window !== 'undefined' && Boolean(window.__TSB_API_PORT__);

/**
 * Open a URL outside the app.
 *
 * In a browser this is just `window.open`; the desktop build goes through a
 * Rust command that validates the scheme before handing anything to the OS.
 */
export async function openExternal(url) {
  if (!url) return;

  if (!inDesktopApp) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_external', { url });
  } catch (error) {
    // Worth surfacing: a silently dead link is exactly the bug this fixes.
    console.error('[tsb] could not open link', url, error);
  }
}

/** Links that point somewhere other than this app. */
function isExternal(href) {
  return /^https?:\/\//i.test(href);
}

export function installExternalLinkHandler() {
  if (!inDesktopApp) return;

  document.addEventListener(
    'click',
    event => {
      // `composedPath` so this still works if anything ends up in shadow DOM.
      const anchor = event
        .composedPath()
        .find(node => node instanceof HTMLAnchorElement && node.href);
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || !isExternal(anchor.href)) return;

      // Stop both the dead navigation and the card's own click handler, which
      // would otherwise expand the tweet as a side effect of opening a link.
      event.preventDefault();
      event.stopPropagation();
      openExternal(anchor.href);
    },
    // Capture, so this runs before React's delegated handlers get a look.
    true,
  );
}
