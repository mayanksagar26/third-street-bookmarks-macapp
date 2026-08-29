import { useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import TweetCard from './TweetCard';
import Pagination from './Pagination';

/** Covers the `slot-collapse` delay plus its duration, from index.css. */
const VANISH_MS = 530;
/**
 * How many cards may leave at once and still be animated.
 *
 * One card dropping out is worth watching leave. "Mark all read" clears the
 * page in one go, and animating thirty cards out at once is just a stall
 * between you and the next screen.
 */
const MAX_VANISH = 8;

/**
 * Keep cards that just left the filtered list on screen long enough to animate
 * out, in the slot they used to hold.
 *
 * This sits below every filter, so it covers all of them without any of them
 * knowing: unread-only, a favourite folder, a category, a search.
 *
 * `viewKey` is what separates "this card left" from "you are looking at
 * something else now". Counting departures alone could not tell them apart:
 * switching to a folder that happens to share most of the current page reads
 * as a handful of removals, and fading those out drags an old view across a
 * new one. A view change re-baselines instead, and swaps instantly.
 */
function useVanishingItems(items, viewKey) {
  // [{ item, index }] — index is where the card sat when it left.
  const [exiting, setExiting] = useState([]);
  const prevRef = useRef(items);
  const timersRef = useRef(new Map());

  useEffect(() => () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current.clear();
  }, []);

  const viewRef = useRef(viewKey);
  // Layout, not passive. A passive effect runs *after* the browser has painted,
  // and the paint it comes after is the one where the card is simply gone: the
  // feed reflows closed, then this effect puts the card back at full height and
  // it reflows open again before the animation even starts. Measured, that was
  // a 621px collapse followed by an 871px rebound — two hard jumps in front of
  // the dissolve that was supposed to replace them. Running before paint means
  // neither intermediate state is ever shown.
  useLayoutEffect(() => {
    const prev = prevRef.current;
    const prevView = viewRef.current;
    prevRef.current = items;
    viewRef.current = viewKey;
    if (prev === items) return;

    if (prevView !== viewKey) {
      timersRef.current.forEach(clearTimeout);
      timersRef.current.clear();
      setExiting(cur => (cur.length ? [] : cur));
      return;
    }

    const liveIds = new Set(items.map(b => b.id));
    // A card that came back (re-starred, marked unread) stops animating away.
    setExiting(cur => cur.filter(e => !liveIds.has(e.item.id)));
    liveIds.forEach(id => {
      const t = timersRef.current.get(id);
      if (t) { clearTimeout(t); timersRef.current.delete(id); }
    });

    const gone = [];
    prev.forEach((b, i) => { if (!liveIds.has(b.id)) gone.push({ item: b, index: i }); });
    if (!gone.length) return;
    if (gone.length > MAX_VANISH) {
      timersRef.current.forEach(clearTimeout);
      timersRef.current.clear();
      setExiting([]);
      return;
    }

    setExiting(cur => [...cur, ...gone]);
    gone.forEach(({ item }) => {
      timersRef.current.set(item.id, setTimeout(() => {
        timersRef.current.delete(item.id);
        setExiting(cur => cur.filter(e => e.item.id !== item.id));
      }, VANISH_MS));
    });
  }, [items, viewKey]);

  // Live cards keep their real index — the one focus and j/k count in — and the
  // leaving ones are slotted back where they were.
  return useMemo(() => {
    const rows = items.map((item, index) => ({ item, index, vanishing: false }));
    if (!exiting.length) return rows;
    exiting.forEach(({ item, index }) => {
      if (rows.some(r => r.item.id === item.id)) return;
      rows.splice(Math.min(index, rows.length), 0, { item, index: -1, vanishing: true });
    });
    return rows;
  }, [items, exiting]);
}

/**
 * The element the collapse animates on, wrapped around a card that is leaving.
 *
 * The height lives out here rather than on the card because the two halves of
 * the animation want different treatment: collapsing a slot is layout work,
 * fading a card is compositor work, and sharing an element forces the second to
 * wait on the first. See the `.tweet-slot` rules in index.css.
 *
 * The measurement has to happen here too — a custom property set on the card
 * would inherit downwards, away from the element that needs to read it.
 */
function VanishSlot({ vanishing, children }) {
  const ref = useRef(null);
  const [armed, setArmed] = useState(false);

  // Two passes, both before paint. Measuring while the animation is already
  // attached is measuring a card the animation has changed: the keyframes open
  // on `max-height: var(--vanish-h, 420px)`, and until the real number lands
  // that fallback is what applies. No card here is 420px — they run 173px to
  // 2080px — so arming first and measuring second would start every collapse
  // from the wrong height, and clamp the tall ones on sight.
  //
  // So pass one measures the card at its natural height, and the state change
  // gives pass two, which attaches the animation to a value already set. React
  // flushes a layout-effect update synchronously, so the two share a frame.
  useLayoutEffect(() => {
    if (!vanishing) { setArmed(false); return; }
    if (!ref.current) return;
    ref.current.style.setProperty('--vanish-h', `${ref.current.scrollHeight}px`);
    setArmed(true);
  }, [vanishing]);

  return (
    <div
      ref={ref}
      className={`tweet-slot${vanishing && armed ? ' is-vanishing' : ''}`}
      aria-hidden={vanishing || undefined}
    >
      {children}
    </div>
  );
}

export default function Feed({
  bookmarks, page, pageSize, loading, error,
  searchQuery, readIds, favMap, favFolders,
  notesMap, focusedIdx, viewKey,
  onToggleRead, onSetFavFolders, onRenameFavFolder, onUpdateNote,
  onBulkRead, onPageChange, ttsConfig, onSpeakBookmark,
}) {
  const start = (page - 1) * pageSize;
  const pageItems = useMemo(() => bookmarks.slice(start, start + pageSize), [bookmarks, start, pageSize]);
  const rows = useVanishingItems(pageItems, `${viewKey}|${page}`);

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

  // Cards still fading out are the only thing left when the last result goes;
  // hold the empty state back until they have finished.
  if (!bookmarks.length && !rows.length) {
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
        {rows.map(({ item: b, index, vanishing }) => (
          <VanishSlot key={b.id} vanishing={vanishing}>
            <TweetCard
              bookmark={b}
              searchQuery={searchQuery}
              isRead={readIds.has(b.id)}
              folders={favMap[b.id] || []}
              allFolders={favFolders}
              note={notesMap[b.id] || null}
              isFocused={index >= 0 && index === focusedIdx}
              onToggleRead={onToggleRead}
              onSetFavFolders={onSetFavFolders}
              onRenameFavFolder={onRenameFavFolder}
              onUpdateNote={onUpdateNote}
              onSpeakBookmark={onSpeakBookmark}
            />
          </VanishSlot>
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
