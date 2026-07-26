import { useMemo } from 'react';
import TweetCard from './TweetCard';
import Pagination from './Pagination';

export default function Feed({
  bookmarks, page, pageSize, loading, error,
  searchQuery, readIds, favMap, favFolders,
  notesMap, focusedIdx,
  onToggleRead, onSetFavFolders, onRenameFavFolder, onUpdateNote,
  onBulkRead, onPageChange, ttsConfig, onSpeakBookmark,
}) {
  const start = (page - 1) * pageSize;
  const pageItems = useMemo(() => bookmarks.slice(start, start + pageSize), [bookmarks, start, pageSize]);

  const unreadVisible = useMemo(() => pageItems.filter(b => !readIds.has(b.id)).map(b => b.id), [pageItems, readIds]);

  if (loading) {
    return (
      <div className="loading-spinner">
        <div className="spinner" />
        Loading bookmarks…
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⚠️</div>
        <h3>Could not load bookmarks</h3>
        <p>{error}</p>
        <p style={{ marginTop: 8, fontSize: 13 }}>
          Copy <code>bookmarks.sample.json</code> to <code>bookmarks.json</code> or set <code>DATA_PATH</code> to your file.
        </p>
      </div>
    );
  }

  if (!bookmarks.length) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🔍</div>
        <h3>No results</h3>
        <p>Try a different search or filter</p>
      </div>
    );
  }

  return (
    <>
      {unreadVisible.length > 0 && (
        <div className="bulk-read-bar">
          <span className="bulk-read-info">
            {unreadVisible.length} unread on this page
          </span>
          <button className="bulk-read-btn" onClick={() => onBulkRead(unreadVisible)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
            Mark all read
          </button>
        </div>
      )}

      <div className="feed">
        {pageItems.map((b, i) => (
          <TweetCard
            key={b.id}
            bookmark={b}
            searchQuery={searchQuery}
            isRead={readIds.has(b.id)}
            folders={favMap[b.id] || []}
            allFolders={favFolders}
            note={notesMap[b.id] || null}
            isFocused={i === focusedIdx}
            onToggleRead={onToggleRead}
            onSetFavFolders={onSetFavFolders}
            onRenameFavFolder={onRenameFavFolder}
            onUpdateNote={onUpdateNote}
            onSpeakBookmark={onSpeakBookmark}
          />
        ))}
      </div>
      <Pagination
        total={bookmarks.length}
        currentPage={page}
        pageSize={pageSize}
        onPageChange={onPageChange}
      />
    </>
  );
}
