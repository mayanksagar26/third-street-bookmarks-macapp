import { useMemo } from 'react';
import { getBookmarkSource, SourceIcon } from '../bookmark-sources';
import HackerNews from './HackerNews';
import { PasteLink, YouTubeImport, InstagramImport } from './SourcePanels';

// ─────────────────────────────────────────────────────────────────────────────
// One source, two tabs.
//
//   Saved   what you kept from this source — the ordinary feed, narrowed
//   Browse  the surface that puts things in: Hacker News' front page, your
//           YouTube playlists, your Instagram collections, a paste box
//
// Before this, browsing lived in the Tools menu and the source rows were only
// filters, so "look at Hacker News" and "look at what I kept from Hacker News"
// were two unrelated places reached two different ways. They are one place now,
// and the source row in the sidebar is how you get to it.
//
// The read scope (All / Unread) stays in the sidebar and applies to the Saved
// tab, because it is a different question from which source you are looking at
// and the two should compose rather than replace each other.
// ─────────────────────────────────────────────────────────────────────────────

/** Containers this source owns — YouTube playlists, Instagram collections. */
function useSourceFolders(bookmarks, sourceId) {
  return useMemo(() => {
    const counts = {};
    for (const b of bookmarks) {
      if ((b.source || 'x') !== sourceId) continue;
      for (const f of (b.folderNames || [])) counts[f] = (counts[f] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [bookmarks, sourceId]);
}

function FolderList({ folders, label, empty, activeFolder, onPick }) {
  if (!folders.length) return <div className="add-hint">{empty}</div>;
  return (
    <div className="add-block">
      <label className="add-label">{label}</label>
      <div className="src-folders">
        {folders.map(([name, count]) => (
          <button
            key={name}
            className={`src-folder ${activeFolder === name ? 'on' : ''}`}
            onClick={() => onPick(activeFolder === name ? null : name)}
            title={`Show the ${count} saved from “${name}”`}
          >
            <span className="src-folder-name">{name}</span>
            <span className="src-folder-count">{count}</span>
          </button>
        ))}
      </div>
      <div className="add-hint">
        Pick one to narrow the Saved tab to it. These come from the service, so a
        re-import updates them; your Favourites are separate and never touched.
      </div>
    </div>
  );
}

export default function SourceView({
  sourceId, tab, onTabChange, onClose,
  bookmarks, savedCount, onAdded,
  activeFolder, onPickFolder,
  children,
}) {
  const src = getBookmarkSource(sourceId);
  const folders = useSourceFolders(bookmarks, sourceId);

  function browsePanel() {
    if (sourceId === 'hn') return <HackerNews embedded onSaved={onAdded} />;
    if (sourceId === 'yt') return (
      <div className="source-browse">
        <FolderList
          folders={folders}
          label="Your playlists"
          empty="No playlists yet. Import one below and it will appear here."
          activeFolder={activeFolder}
          onPick={onPickFolder}
        />
        <YouTubeImport onAdded={onAdded} />
      </div>
    );
    if (sourceId === 'ig') return (
      <div className="source-browse">
        <FolderList
          folders={folders}
          label="Your collections"
          empty="No collections yet. Import your export below and they will appear here."
          activeFolder={activeFolder}
          onPick={onPickFolder}
        />
        <InstagramImport onAdded={onAdded} />
      </div>
    );
    if (sourceId === 'link') return (
      <div className="source-browse">
        <PasteLink onAdded={onAdded} autoFocus />
      </div>
    );
    return null;
  }

  return (
    <div className="source-view">
      <div className="source-view-head">
        <div className="source-view-title">
          <SourceIcon source={sourceId} size={20} style={{ color: src.accent }} />
          <h2>{src.label}</h2>
        </div>
        <button className="hn-close" onClick={onClose} title={`Stop filtering by ${src.label}`}>✕</button>
      </div>

      <div className="source-tabs">
        <button
          className={`source-tab ${tab === 'saved' ? 'active' : ''}`}
          onClick={() => onTabChange('saved')}
        >
          Saved<span className="source-tab-count">{savedCount}</span>
        </button>
        {src.browseLabel && (
          <button
            className={`source-tab ${tab === 'browse' ? 'active' : ''}`}
            onClick={() => onTabChange('browse')}
          >
            {src.browseLabel}
          </button>
        )}
      </div>

      {activeFolder && tab === 'saved' && (
        <div className="src-folder-chip">
          {activeFolder}
          <button onClick={() => onPickFolder(null)} title="Show everything from this source">×</button>
        </div>
      )}

      {tab === 'saved' ? children : browsePanel()}
    </div>
  );
}
