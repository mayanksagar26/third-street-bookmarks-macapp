import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';

/** Folder count past which the picker is worth a search box. */
const FOLDER_SEARCH_FROM = 5;

const POPUP_WIDTH = 240;
const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 6;

/**
 * Star button and its multi-folder picker, shared by the feed and the chat.
 *
 * The popup goes through a portal rather than sitting next to the button: the
 * chat's result list is a scroll container with `overflow: hidden` above it,
 * which clipped an absolutely positioned popup to nothing. Fixed coordinates
 * off the trigger's rect work the same in both places.
 */
export default function FavFolderPicker({
  folders = [],
  allFolders = [],
  onSetFolders,
  onRenameFolder,
  buttonClassName = 'tw-btn star-btn',
}) {
  const [open, setOpen] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [renameText, setRenameText] = useState('');
  const [folderSearch, setFolderSearch] = useState('');
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const wrapRef = useRef(null);
  const popupRef = useRef(null);
  const newFolderRef = useRef(null);
  const searchRef = useRef(null);

  const isFav = folders.length > 0;

  // allFolders arrives most-recently-used first; keep that order rather than
  // sorting, so the folders you actually reach for sit at the top.
  const pickerFolders = useMemo(
    () => [...new Set([...allFolders, ...folders])],
    [allFolders, folders],
  );

  const folderQuery = folderSearch.trim().toLowerCase();
  // Ticked folders lead, so a bookmark's own folders are the first thing you
  // see (and can untick) without scrolling for them.
  const visibleFolders = useMemo(() => {
    const matching = folderQuery
      ? pickerFolders.filter(f => f.toLowerCase().includes(folderQuery))
      : pickerFolders;
    const ticked = matching.filter(f => folders.includes(f));
    const rest = matching.filter(f => !folders.includes(f));
    return [...ticked, ...rest];
  }, [pickerFolders, folders, folderQuery]);

  function placeFromTrigger() {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(r.right - POPUP_WIDTH, window.innerWidth - POPUP_WIDTH - VIEWPORT_MARGIN),
    );
    // Flip above the trigger when the popup would run off the bottom. Height is
    // only known once it has rendered, so the first open falls back to below and
    // the layout effect corrects it.
    const h = popupRef.current?.offsetHeight || 0;
    let top = r.bottom + TRIGGER_GAP;
    if (h && top + h > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, r.top - TRIGGER_GAP - h);
    }
    setPos({ top, left });
  }

  useEffect(() => {
    if (!open) {
      // Next open starts clean rather than mid-search from last time.
      setFolderSearch('');
      setRenaming(null);
      return;
    }
    // Search wins the caret when it exists: with a long list, typing is far
    // more likely to mean "find a folder" than "name a new one".
    const t = setTimeout(() => (searchRef.current || newFolderRef.current)?.focus(), 50);
    const close = (e) => {
      if (popupRef.current?.contains(e.target) || wrapRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const reposition = () => placeFromTrigger();
    // A fixed popup does not travel with the page, so it has to be re-placed on
    // every scroll. Closing instead was wrong twice over: scrolling the folder
    // list itself reaches this in the capture phase and shut the popup mid-drag,
    // and a wheel over a short list scrolls the feed behind, which shut it too.
    const onScroll = (e) => {
      if (popupRef.current?.contains(e.target)) return;
      const r = wrapRef.current?.getBoundingClientRect();
      // Only give up once the star itself has left the viewport, where there is
      // nothing left to anchor to.
      if (!r || r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return; }
      placeFromTrigger();
    };
    document.addEventListener('click', close);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', close);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // Correct the first placement, and any later one where the list grew or shrank
  // enough to change which side of the trigger fits.
  useLayoutEffect(() => {
    if (!open || !popupRef.current || !wrapRef.current) return;
    const h = popupRef.current.offsetHeight;
    const r = wrapRef.current.getBoundingClientRect();
    const overflowsBottom = pos.top + h > window.innerHeight - VIEWPORT_MARGIN;
    if (!overflowsBottom) return;
    const above = r.top - TRIGGER_GAP - h;
    setPos(p => ({ ...p, top: Math.max(VIEWPORT_MARGIN, above) }));
  }, [open, pos.top, visibleFolders.length]);

  function toggleFolder(folder) {
    const next = folders.includes(folder) ? folders.filter(f => f !== folder) : [...folders, folder];
    onSetFolders(next);   // keeps the popup open for multi-select
  }

  function addNewFolder() {
    const name = newFolder.trim();
    if (!name) return;
    if (!folders.includes(name)) onSetFolders([...folders, name]);
    setNewFolder('');
  }

  function commitRename() {
    const to = renameText.trim();
    if (renaming && to && to !== renaming) onRenameFolder?.(renaming, to);
    setRenaming(null);
    setRenameText('');
  }

  return (
    <span className="star-wrap" ref={wrapRef}>
      <button
        className={`${buttonClassName}${isFav ? ' active' : ''}`}
        title={isFav ? `In: ${folders.join(', ')}` : 'Add to favourites'}
        onClick={e => {
          e.stopPropagation();
          if (!open) placeFromTrigger();
          setOpen(p => !p);
        }}
      >
        {isFav
          ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        }
      </button>

      {open && createPortal(
        <div
          className="fav-popup fav-popup-fixed"
          ref={popupRef}
          style={{ top: pos.top, left: pos.left, width: POPUP_WIDTH }}
          onClick={e => e.stopPropagation()}
        >
          <div className="fav-popup-title">Save in folders</div>

          {pickerFolders.length > FOLDER_SEARCH_FROM && (
            <input
              ref={searchRef}
              className="fav-popup-search"
              placeholder={`Search ${pickerFolders.length} folders…`}
              value={folderSearch}
              onChange={e => setFolderSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setFolderSearch(''); }}
            />
          )}

          <div className="fav-popup-list">
            {visibleFolders.length === 0 && (
              <div className="fav-popup-empty">No folders match</div>
            )}
            {visibleFolders.map(f => (
              <div key={f} className="fav-popup-folder">
                {renaming === f ? (
                  <input
                    className="fav-rename-input"
                    autoFocus
                    value={renameText}
                    onChange={e => setRenameText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename();
                      else if (e.key === 'Escape') { setRenaming(null); setRenameText(''); }
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <>
                    {/* A button, not a <label> wrapping a checkbox: the label
                        forwarded activation to the nested input, so clicking the
                        box or the icon fired this twice across two renders and
                        the folder toggled straight back off. */}
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={folders.includes(f)}
                      className="fav-folder-check"
                      onClick={() => toggleFolder(f)}
                    >
                      <span className={`fav-check-box${folders.includes(f) ? ' checked' : ''}`}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4">
                          <path d="M4 12l6 6L20 6"/>
                        </svg>
                      </span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#f59e0b">
                        <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                      </svg>
                      <span className="fav-folder-name">{f}</span>
                    </button>
                    {onRenameFolder && (
                      <button
                        className="fav-rename-btn"
                        title="Rename folder"
                        onClick={() => { setRenaming(f); setRenameText(f); }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          {pickerFolders.length > 0 && <div className="fav-popup-divider" />}
          <input
            ref={newFolderRef}
            className="fav-popup-input"
            placeholder="New folder…"
            value={newFolder}
            onChange={e => setNewFolder(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addNewFolder(); } }}
          />
          <div className="fav-popup-actions">
            <button className="fav-popup-add" onClick={addNewFolder}>Add</button>
            <button className="fav-popup-done" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
