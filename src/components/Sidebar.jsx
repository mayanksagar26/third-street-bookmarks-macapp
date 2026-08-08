import { useState } from 'react';
import { getSource } from '../sources';

const CAT_DOT_COLORS = {
  technology:'#1d9bf0', tech:'#1d9bf0', ai:'#a855f7',
  'artificial intelligence':'#a855f7', 'machine learning':'#a855f7',
  business:'#f59e0b', science:'#10b981', design:'#f91880',
  product:'#00ba7c', startup:'#ff7b54', startups:'#ff7b54',
  engineering:'#60a5fa', finance:'#34d399', philosophy:'#c084fc',
  productivity:'#fbbf24', health:'#fb923c',
};


function getDotColor(cat) {
  return CAT_DOT_COLORS[cat.toLowerCase()] || '#71767b';
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

/** Folder count past which the section is worth a search box. */
const FAV_SEARCH_FROM = 5;

export default function Sidebar({
  total, unreadCount, gemsCount,
  currentFilter, onFilterChange,
  showUnreadOnly, onToggleUnread,
  catCounts, selectedCategories, onToggleCategory, onClearCategories,
  favMap, favFolders, folderCounts, onRenameFavFolder,
  syncSource,
}) {
  const [catSearch, setCatSearch] = useState('');
  const [favSearch, setFavSearch] = useState('');
  const [renamingFav, setRenamingFav] = useState(null);
  const [renameText, setRenameText]   = useState('');
  const source = getSource(syncSource);

  // favMap values are arrays of folders (a bookmark can be in several)
  const favTotal = Object.values(favMap).filter(a => a && a.length).length;
  const favCounts = {};
  Object.values(favMap).forEach(arr => (arr || []).forEach(f => { favCounts[f] = (favCounts[f] || 0) + 1; }));

  function commitFavRename() {
    const to = renameText.trim();
    if (renamingFav && to && to !== renamingFav) onRenameFavFolder?.(renamingFav, to);
    setRenamingFav(null);
    setRenameText('');
  }

  // Busiest folders first, all of them, in a list that scrolls on its own —
  // the same shape as the categories below.
  const sortedFavs = Object.entries(favCounts).sort((a, b) => b[1] - a[1]);
  const favQuery = favSearch.trim().toLowerCase();
  const visibleFavs = favQuery
    ? sortedFavs.filter(([folder]) => folder.toLowerCase().includes(favQuery))
    : sortedFavs;

  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
  const q = catSearch.trim().toLowerCase();
  const visibleCats = q ? sortedCats.filter(([cat]) => cat.toLowerCase().includes(q)) : sortedCats;
  const selected = visibleCats.filter(([cat]) => selectedCategories.has(cat));
  const rest = visibleCats.filter(([cat]) => !selectedCategories.has(cat));
  const orderedCats = [...selected, ...rest];

  return (
    <nav className="sidebar">
      <div className="sidebar-logo">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
        </svg>
        <div className="sidebar-logo-block">
          <span className="sidebar-logo-text">TSB</span>
          <span className="sidebar-logo-sub">
            Powered by{' '}
            <a href={source.link} target="_blank" rel="noopener noreferrer" className="sidebar-logo-link">
              {source.label}
            </a>
            {' '}by{' '}
            <a href={source.author.x} target="_blank" rel="noopener noreferrer" className="sidebar-logo-link">
              {source.author.name}
            </a>
          </span>
        </div>
      </div>

      {/* Filter */}
      <div className="sidebar-section">
        <div className="sidebar-section-title">Filter</div>
        <div
          className={`sidebar-item ${currentFilter === 'all' && !showUnreadOnly ? 'active' : ''}`}
          onClick={() => onFilterChange('all')}
        >
          <span className="sidebar-item-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
            </svg>
            All Bookmarks
          </span>
          <span className="sidebar-badge">{total}</span>
        </div>

        <div
          className={`sidebar-item ${showUnreadOnly ? 'active' : ''}`}
          onClick={onToggleUnread}
        >
          <span className="sidebar-item-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
            </svg>
            Unread Only
          </span>
          <span className="sidebar-badge">{unreadCount}</span>
        </div>

        <div
          className={`sidebar-item ${currentFilter === 'gems' ? 'active' : ''}`}
          onClick={() => onFilterChange('gems')}
        >
          <span className="sidebar-item-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 4l5 2.18V11c0 3.5-2.33 6.79-5 7.93C9.33 17.79 7 14.5 7 11V7.18L12 5z"/>
            </svg>
            Forgotten Gems
          </span>
          <span className="sidebar-badge gems-badge">{gemsCount}</span>
        </div>
      </div>

      {/* Favourites */}
      {favTotal > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-title">Favourites</div>
          <div
            className={`sidebar-fav-item ${currentFilter === 'fav:all' ? 'active' : ''}`}
            onClick={() => onFilterChange('fav:all')}
          >
            <span className="sidebar-item-left">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#f59e0b">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
              All Favourites
            </span>
            <span className="fav-badge">{favTotal}</span>
          </div>
          {sortedFavs.length > FAV_SEARCH_FROM && (
            <div className="cat-search-wrap">
              <input
                className="cat-search-input"
                placeholder={`Search ${sortedFavs.length} folders…`}
                value={favSearch}
                onChange={e => setFavSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') setFavSearch(''); }}
              />
              <button
                className={`cat-search-clear ${favSearch ? 'visible' : ''}`}
                onClick={() => setFavSearch('')}
              >✕</button>
            </div>
          )}

          <div className="fav-list">
            {visibleFavs.length === 0
              ? <div className="cat-no-results">No folders match</div>
              : visibleFavs.map(([folder, count]) => (
                <div
                  key={folder}
                  className={`sidebar-fav-item ${currentFilter === `fav:${folder}` ? 'active' : ''}`}
                  onClick={() => renamingFav !== folder && onFilterChange(`fav:${folder}`)}
                  onDoubleClick={() => { setRenamingFav(folder); setRenameText(folder); }}
                  title="Double-click to rename"
                >
                  <span className="sidebar-item-left">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="#f59e0b">
                      <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                    </svg>
                    {renamingFav === folder ? (
                      <input
                        className="fav-rename-input"
                        autoFocus
                        value={renameText}
                        onClick={e => e.stopPropagation()}
                        onChange={e => setRenameText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitFavRename();
                          else if (e.key === 'Escape') { setRenamingFav(null); setRenameText(''); }
                        }}
                        onBlur={commitFavRename}
                      />
                    ) : folder}
                  </span>
                  <span className="fav-badge">{count}</span>
                </div>
              ))
            }
          </div>

        </div>
      )}

      {/* Categories */}
      <div className="sidebar-section">
        <div className="sidebar-section-title">Categories</div>
        <div className="cat-search-wrap">
          <input
            className="cat-search-input"
            placeholder="Search categories…"
            value={catSearch}
            onChange={e => setCatSearch(e.target.value)}
          />
          <button
            className={`cat-search-clear ${catSearch ? 'visible' : ''}`}
            onClick={() => setCatSearch('')}
          >✕</button>
        </div>

        {selectedCategories.size > 0 && (
          <>
            <div className="cat-chips">
              {[...selectedCategories].map(cat => (
                <span key={cat} className="cat-chip" onClick={() => onToggleCategory(cat)}>
                  {cap(cat)}<span className="cat-chip-x">×</span>
                </span>
              ))}
            </div>
            <span className="cat-clear-all" onClick={onClearCategories}>Clear all</span>
          </>
        )}

        <div className="category-list">
          {orderedCats.length === 0
            ? <div className="cat-no-results">No categories match</div>
            : orderedCats.map(([cat, count]) => (
              <div
                key={cat}
                className={`sidebar-item cat-item ${selectedCategories.has(cat) ? 'active' : ''}`}
                onClick={() => onToggleCategory(cat)}
              >
                <span className="sidebar-item-left">
                  <span className="sidebar-dot" style={{ background: getDotColor(cat) }} />
                  {cap(cat)}
                </span>
                <span className="sidebar-badge">{count}</span>
              </div>
            ))
          }
        </div>
      </div>

      {/* Folders */}
      {Object.keys(folderCounts).length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-title">Folders</div>
          {Object.entries(folderCounts).sort((a, b) => b[1] - a[1]).map(([folder, count]) => (
            <div
              key={folder}
              className={`sidebar-item ${currentFilter === `folder:${folder}` ? 'active' : ''}`}
              onClick={() => onFilterChange(`folder:${folder}`)}
            >
              <span className="sidebar-item-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                </svg>
                {folder}
              </span>
              <span className="sidebar-badge">{count}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Keyboard shortcuts hint */}
      <div className="sidebar-shortcuts">
        <span><kbd>j</kbd><kbd>k</kbd> navigate</span>
        <span><kbd>r</kbd> read</span>
        <span><kbd>f</kbd> fav</span>
        <span><kbd>/</kbd> search</span>
      </div>
    </nav>
  );
}
