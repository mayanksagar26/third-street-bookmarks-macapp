import { useState, useEffect, useRef } from 'react';
import { SourceIcon } from '../bookmark-sources';
import { openExternal } from '../external-links';

// ─────────────────────────────────────────────────────────────────────────────
// The panels that put bookmarks in, one per source.
//
// Extracted so the "Add bookmarks" screen and each source's own Browse tab are
// literally the same code. Two implementations of a YouTube import would drift
// apart within a week, and the one you happened to open would decide whether
// your API key was remembered.
// ─────────────────────────────────────────────────────────────────────────────

export function Result({ result }) {
  if (!result) return null;
  if (result.error) return <div className="add-msg error">{result.error}</div>;
  return <div className="add-msg ok">{result.text}</div>;
}

/**
 * Two-phase export importer, shared by Instagram and YouTube Takeout.
 *
 * Read the file, show what's inside, import only what's ticked. Choosing three
 * collections is the whole reason to prefer an export over a live scrape.
 */
export function ExportImporter({ endpoint, source, accept, extLabel, placeholder, onImported }) {
  const [path, setPath]        = useState('');
  const [collections, setColl] = useState(null);
  const [picked, setPicked]    = useState(new Set());
  const [busy, setBusy]        = useState(false);
  const [result, setResult]    = useState(null);
  // Where the files being read came from. An upload lives in the app's own
  // directory, so the server addresses it rather than trusting a path.
  const [uploaded, setUploaded] = useState(null);
  const fileRef = useRef(null);

  async function post(body) {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'import failed');
    return d;
  }

  /** What the two Read paths have in common once the files are locatable. */
  async function preview(body) {
    const d = await post(body);
    setColl(d.collections);
    setPicked(new Set(Object.keys(d.collections)));
    if (!Object.keys(d.collections).length) setResult({ error: 'Nothing importable found in there.' });
  }

  /**
   * Read the picked files in the browser and hand their text to the server.
   *
   * The webview cannot give a real filesystem path for a chosen file, and the
   * import needs the contents anyway — so they are read here and written into
   * the app's data directory, which is also what makes the export re-readable
   * later without asking you to find it again.
   */
  async function upload(fileList) {
    const files = [...(fileList || [])].filter(f => accept.some(ext => f.name.toLowerCase().endsWith(ext)));
    if (!files.length) {
      setResult({ error: `Pick the ${accept.join(' or ')} files from the unzipped export.` });
      return;
    }
    setBusy(true); setResult(null); setColl(null);
    try {
      const payload = await Promise.all(files.map(async f => ({ name: f.name, content: await f.text() })));
      const r = await fetch('/api/import/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, files: payload }),
      });
      const up = await r.json();
      if (!r.ok) throw new Error(up.error || 'upload failed');
      setUploaded(up.dir);
      setPath('');
      await preview({ uploaded: true });
    } catch (e) { setResult({ error: e.message }); }
    finally { setBusy(false); }
  }

  async function scan() {
    setBusy(true); setResult(null); setColl(null); setUploaded(null);
    try {
      await preview({ path: path.trim() });
    } catch (e) { setResult({ error: e.message }); }
    finally { setBusy(false); }
  }

  async function run() {
    setBusy(true); setResult(null);
    try {
      const d = await post(uploaded ? { uploaded: true, only: [...picked] } : { path: path.trim(), only: [...picked] });
      setResult({ text: `Imported ${d.added} new · ${d.skipped} already saved.` });
      onImported?.();
    } catch (e) { setResult({ error: e.message }); }
    finally { setBusy(false); }
  }

  function toggle(name) {
    setPicked(p => {
      const next = new Set(p);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  return (
    <div className="add-block">
      <label className="add-label">{extLabel}</label>

      {/* Choosing the files is the way in; typing a path is the fallback for
          when the export lives somewhere a picker is awkward to reach. */}
      <div
        className={`add-drop ${busy ? 'is-busy' : ''}`}
        onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('over'); }}
        onDragLeave={e => e.currentTarget.classList.remove('over')}
        onDrop={e => {
          e.preventDefault();
          e.currentTarget.classList.remove('over');
          upload(e.dataTransfer.files);
        }}
        onClick={() => !busy && fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={accept.join(',')}
          hidden
          onChange={e => { upload(e.target.files); e.target.value = ''; }}
        />
        <strong>Choose files</strong> or drop them here
        <span>{accept.join(' / ')} from the unzipped export</span>
      </div>

      {uploaded && (
        <div className="add-hint">Saved into the app’s own folder, so you won’t have to find them again.</div>
      )}

      <details className="add-path">
        <summary>Or point at a folder on disk</summary>
        <div className="add-row" style={{ marginTop: 8 }}>
          <input
            className="add-input"
            placeholder={placeholder}
            value={path}
            onChange={e => { setPath(e.target.value); setColl(null); }}
            onKeyDown={e => { if (e.key === 'Enter' && path.trim()) scan(); }}
          />
          <button className="add-btn" onClick={scan} disabled={busy || !path.trim()}>
            {busy && !collections ? 'Reading…' : 'Read'}
          </button>
        </div>
      </details>

      {collections && Object.keys(collections).length > 0 && (
        <>
          <div className="add-hint">Pick what to import — {Object.keys(collections).length} found.</div>
          <div className="add-colls">
            {Object.entries(collections).sort((a, b) => b[1] - a[1]).map(([name, count]) => (
              <label key={name} className={`add-coll ${picked.has(name) ? 'on' : ''}`}>
                <input type="checkbox" checked={picked.has(name)} onChange={() => toggle(name)} />
                <span className="add-coll-name">{name}</span>
                <span className="add-coll-count">{count}</span>
              </label>
            ))}
          </div>
          <button className="add-btn primary" onClick={run} disabled={busy || !picked.size}>
            {busy ? 'Importing…' : `Import ${[...picked].reduce((n, k) => n + collections[k], 0)} items`}
          </button>
        </>
      )}
      <Result result={result} />
    </div>
  );
}

/** Paste any URL. The path that makes this a bookmark manager, not three integrations. */
export function PasteLink({ onAdded, autoFocus = false }) {
  const [url, setUrl]       = useState('');
  const [busy, setBusy]     = useState(false);
  const [result, setResult] = useState(null);

  async function save() {
    setBusy(true); setResult(null);
    try {
      const r = await fetch('/api/save-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'could not save');
      setResult({ text: d.added ? `Saved “${d.record.title}”.` : `Already saved: “${d.record.title}”.` });
      setUrl('');
      onAdded?.();
    } catch (e) { setResult({ error: e.message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="add-block">
      <label className="add-label">Any link</label>
      <div className="add-row">
        <input
          className="add-input"
          placeholder="https://…"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && url.trim()) save(); }}
          autoFocus={autoFocus}
        />
        <button className="add-btn primary" onClick={save} disabled={busy || !url.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="add-hint">
        Title, description and preview image are read from the page itself. YouTube links get
        channel and thumbnail from YouTube directly — no key needed. Tracking parameters are
        stripped, so the same link saved twice stays one bookmark.
      </div>
      <Result result={result} />
    </div>
  );
}

/** Public playlist import, plus the Takeout route that reaches Watch Later. */
export function YouTubeImport({ onAdded }) {
  const [playlistUrl, setPlUrl] = useState('');
  const [apiKey, setApiKey]     = useState('');
  const [busy, setBusy]         = useState(false);
  const [result, setResult]     = useState(null);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json())
      .then(s => { if (s.youtubeApiKey) setApiKey(s.youtubeApiKey); })
      .catch(() => {});
  }, []);

  async function importPlaylist() {
    setBusy(true); setResult(null);
    try {
      if (apiKey.trim()) {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ youtubeApiKey: apiKey.trim() }),
        });
      }
      const r = await fetch('/api/youtube/playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: playlistUrl.trim(), apiKey: apiKey.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'import failed');
      setResult({ text: `“${d.playlist}” — ${d.added} new, ${d.skipped} already saved.` });
      setPlUrl('');
      onAdded?.();
    } catch (e) { setResult({ error: e.message }); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="add-block">
        <label className="add-label">
          <SourceIcon source="yt" size={14} style={{ color: '#ff0033', verticalAlign: '-2px', marginRight: 6 }} />
          Public playlist
        </label>
        <div className="add-row">
          <input
            className="add-input"
            placeholder="https://www.youtube.com/playlist?list=…"
            value={playlistUrl}
            onChange={e => setPlUrl(e.target.value)}
          />
          <button className="add-btn primary" onClick={importPlaylist} disabled={busy || !playlistUrl.trim()}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
        <input
          className="add-input"
          placeholder="YouTube Data API key"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          style={{ marginTop: 8 }}
        />
        <div className="add-hint">
          An API key reads any <em>public</em> playlist and is saved for next time. There is no
          sign-in step because the read-only YouTube scope needs a Google verification review
          before anyone but you could use it — the export below avoids that entirely.
          <button
            className="add-link"
            onClick={() => openExternal('https://console.cloud.google.com/apis/library/youtube.googleapis.com')}
          >Get a key →</button>
        </div>
        <Result result={result} />
      </div>

      <ExportImporter
        endpoint="/api/import/youtube"
        source="yt"
        accept={['.csv']}
        extLabel="Google Takeout — playlists, Liked, Watch Later"
        placeholder="~/Downloads/Takeout/YouTube and YouTube Music"
        onImported={onAdded}
      />
      <div className="add-hint" style={{ marginTop: -6 }}>
        Watch Later cannot be read by any API — Google removed access in 2016 — so a Takeout
        export is the only way to bring it in. Point this at the unzipped folder.
        <button
          className="add-link"
          onClick={() => openExternal('https://takeout.google.com/settings/takeout/custom/youtube')}
        >Open Google Takeout →</button>
      </div>
    </>
  );
}

/** The official export, and a direct link to the page that starts it. */
export function InstagramImport({ onAdded }) {
  const [urls, setUrls] = useState(null);

  useEffect(() => {
    fetch('/api/instagram/download-urls').then(r => r.json()).then(setUrls).catch(() => {});
  }, []);

  return (
    <>
      <div className="add-block">
        <label className="add-label">
          <SourceIcon source="ig" size={14} style={{ color: '#e1306c', verticalAlign: '-2px', marginRight: 6 }} />
          Step 1 — request your data
        </label>
        <div className="add-hint">
          Instagram has no API for your own saved posts. The official export is the one route
          that cannot get your account flagged, which is why it is the one here. Ask for{' '}
          <strong>Saved posts</strong> in JSON; it arrives by email, usually within a few hours.
        </div>
        <button
          className="add-btn primary wide"
          onClick={() => openExternal(urls?.primary || 'https://accountscenter.instagram.com/info_and_permissions/dyi/')}
        >
          Open Instagram’s download page →
        </button>
        {urls?.fallback && (
          <button className="add-link" onClick={() => openExternal(urls.fallback)}>
            Not loading? Try the old page →
          </button>
        )}
      </div>

      <ExportImporter
        endpoint="/api/import/instagram"
        source="ig"
        accept={['.json']}
        extLabel="Step 2 — import the unzipped export"
        placeholder="~/Downloads/instagram-yourname-2026-09-05"
        onImported={onAdded}
      />
      <div className="add-hint" style={{ marginTop: -6 }}>
        Your collections come through as folders. The export carries no captions or images —
        Instagram’s thumbnail links expire within days, so a preview here would be broken by
        the time you read it.
      </div>
    </>
  );
}
