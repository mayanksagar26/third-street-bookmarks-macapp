import { useState, useEffect } from 'react';
import { SourceIcon } from '../bookmark-sources';
import { openExternal } from '../external-links';

// ─────────────────────────────────────────────────────────────────────────────
// Everything that puts a bookmark in without a sync backend.
//
// Three shapes, and they are genuinely different jobs:
//
//   Paste     one URL, right now. The path that makes this a bookmark manager
//             rather than three integrations.
//   Playlist  a public YouTube playlist, via an API key. No OAuth, because a
//             sensitive scope means a Google verification review before anyone
//             but you could use this build.
//   Export    Instagram saved posts and YouTube Takeout. Manual, but it cannot
//             get your account checkpointed the way scraping a logged-in
//             session can — and for Watch Later it is the only route that
//             exists at all.
//
// The exports are two-phase on purpose: read the file, show the collections,
// let you pick. Importing all of it defeats the point of choosing.
// ─────────────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'paste',    label: 'Paste a link' },
  { id: 'youtube',  label: 'YouTube' },
  { id: 'instagram',label: 'Instagram' },
];

function Result({ result }) {
  if (!result) return null;
  if (result.error) return <div className="add-msg error">{result.error}</div>;
  return (
    <div className="add-msg ok">
      {result.text}
    </div>
  );
}

/** Two-phase export importer, shared by Instagram and YouTube Takeout. */
function ExportImporter({ endpoint, extLabel, placeholder, onImported }) {
  const [path, setPath]         = useState('');
  const [collections, setColl]  = useState(null);
  const [picked, setPicked]     = useState(new Set());
  const [busy, setBusy]         = useState(false);
  const [result, setResult]     = useState(null);

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

  async function scan() {
    setBusy(true); setResult(null); setColl(null);
    try {
      const d = await post({ path: path.trim() });
      setColl(d.collections);
      setPicked(new Set(Object.keys(d.collections)));
      if (!Object.keys(d.collections).length) {
        setResult({ error: 'Nothing importable found in there.' });
      }
    } catch (e) {
      setResult({ error: e.message });
    } finally { setBusy(false); }
  }

  async function run() {
    setBusy(true); setResult(null);
    try {
      const d = await post({ path: path.trim(), only: [...picked] });
      setResult({ text: `Imported ${d.added} new · ${d.skipped} already saved.` });
      onImported?.();
    } catch (e) {
      setResult({ error: e.message });
    } finally { setBusy(false); }
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
      <div className="add-row">
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

      {collections && Object.keys(collections).length > 0 && (
        <>
          <div className="add-hint">
            Pick what to import — {Object.keys(collections).length} found.
          </div>
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

export default function AddBookmark({ initialTab = 'paste', onAdded, onClose }) {
  const [tab, setTab]           = useState(initialTab);
  const [url, setUrl]           = useState('');
  const [busy, setBusy]         = useState(false);
  const [result, setResult]     = useState(null);
  const [playlistUrl, setPlUrl] = useState('');
  const [apiKey, setApiKey]     = useState('');
  const [igUrls, setIgUrls]     = useState(null);

  useEffect(() => {
    fetch('/api/instagram/download-urls').then(r => r.json()).then(setIgUrls).catch(() => {});
    fetch('/api/settings').then(r => r.json()).then(s => { if (s.youtubeApiKey) setApiKey(s.youtubeApiKey); }).catch(() => {});
  }, []);

  async function savePasted() {
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
    } catch (e) {
      setResult({ error: e.message });
    } finally { setBusy(false); }
  }

  async function importPlaylist() {
    setBusy(true); setResult(null);
    try {
      // Persist the key so the next import doesn't ask again.
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
    } catch (e) {
      setResult({ error: e.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="add-pane">
      <div className="add-header">
        <h2>Add bookmarks</h2>
        <button className="hn-close" onClick={onClose} title="Back to the feed">✕</button>
      </div>

      <div className="add-tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`add-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => { setTab(t.id); setResult(null); }}
          >{t.label}</button>
        ))}
      </div>

      {tab === 'paste' && (
        <div className="add-block">
          <label className="add-label">Any link</label>
          <div className="add-row">
            <input
              className="add-input"
              placeholder="https://…"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && url.trim()) savePasted(); }}
              autoFocus
            />
            <button className="add-btn primary" onClick={savePasted} disabled={busy || !url.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
          <div className="add-hint">
            Title, description and preview image are read from the page itself. YouTube links
            get channel and thumbnail from YouTube directly — no key needed. Tracking
            parameters are stripped, so the same link saved twice stays one bookmark.
          </div>
          <Result result={result} />
        </div>
      )}

      {tab === 'youtube' && (
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
              An API key reads any <em>public</em> playlist and is saved for next time. There is
              no sign-in step because the read-only YouTube scope needs a Google verification
              review before anyone but you could use it — the export below avoids that entirely.
              <button
                className="add-link"
                onClick={() => openExternal('https://console.cloud.google.com/apis/library/youtube.googleapis.com')}
              >Get a key →</button>
            </div>
            <Result result={result} />
          </div>

          <ExportImporter
            endpoint="/api/import/youtube"
            extLabel="Google Takeout — playlists, Liked, Watch Later"
            placeholder="~/Downloads/Takeout/YouTube and YouTube Music"
            onImported={onAdded}
          />
          <div className="add-hint" style={{ marginTop: -6 }}>
            Watch Later cannot be read by any API — Google removed access in 2016 — so a
            Takeout export is the only way to bring it in. Point this at the unzipped folder.
            <button
              className="add-link"
              onClick={() => openExternal('https://takeout.google.com/settings/takeout/custom/youtube')}
            >Open Google Takeout →</button>
          </div>
        </>
      )}

      {tab === 'instagram' && (
        <>
          <div className="add-block">
            <label className="add-label">
              <SourceIcon source="ig" size={14} style={{ color: '#e1306c', verticalAlign: '-2px', marginRight: 6 }} />
              Step 1 — request your data
            </label>
            <div className="add-hint">
              Instagram has no API for your own saved posts. The official export is the one
              route that cannot get your account flagged, which is why it is the one here.
              Ask for <strong>Saved posts</strong> in JSON; it arrives by email, usually within
              a few hours.
            </div>
            <button
              className="add-btn primary wide"
              onClick={() => openExternal(igUrls?.primary || 'https://accountscenter.instagram.com/info_and_permissions/dyi/')}
            >
              Open Instagram’s download page →
            </button>
            {igUrls?.fallback && (
              <button
                className="add-link"
                onClick={() => openExternal(igUrls.fallback)}
              >Not loading? Try the old page →</button>
            )}
          </div>

          <ExportImporter
            endpoint="/api/import/instagram"
            extLabel="Step 2 — import the unzipped export"
            placeholder="~/Downloads/instagram-yourname-2026-09-04"
            onImported={onAdded}
          />
          <div className="add-hint" style={{ marginTop: -6 }}>
            Your collections come through as folders. The export carries no captions or
            images — Instagram’s thumbnail links expire within days, so a preview here would
            be broken by the time you read it.
          </div>
        </>
      )}
    </div>
  );
}
