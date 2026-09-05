import { useState } from 'react';
import { PasteLink, YouTubeImport, InstagramImport } from './SourcePanels';

// ─────────────────────────────────────────────────────────────────────────────
// Everything that puts a bookmark in without a sync backend, in one screen.
//
// The same panels live on each source's own Browse tab; this is the shortcut
// for when you know what you want to add and not which source it belongs to.
// Both mount the identical components from SourcePanels — two implementations
// of a YouTube import would drift within a week, and whichever one you happened
// to open would decide whether your API key was remembered.
// ─────────────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'paste',     label: 'Paste a link' },
  { id: 'youtube',   label: 'YouTube' },
  { id: 'instagram', label: 'Instagram' },
];

export default function AddBookmark({ initialTab = 'paste', onAdded, onClose }) {
  const [tab, setTab] = useState(initialTab);

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
            onClick={() => setTab(t.id)}
          >{t.label}</button>
        ))}
      </div>

      {tab === 'paste'     && <PasteLink onAdded={onAdded} autoFocus />}
      {tab === 'youtube'   && <YouTubeImport onAdded={onAdded} />}
      {tab === 'instagram' && <InstagramImport onAdded={onAdded} />}
    </div>
  );
}
