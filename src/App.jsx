import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import SortBar from './components/SortBar';
import StatsBar from './components/StatsBar';
import Feed from './components/Feed';
import RightPanel from './components/RightPanel';
import ChatWithBookmarks from './components/ChatWithBookmarks';
import StatsObservations from './components/StatsObservations';
import BookmarkPodcast from './components/BookmarkPodcast';
import VoiceBubble from './components/VoiceBubble';
import Settings from './components/Settings';
import HackerNews from './components/HackerNews';
import AddBookmark from './components/AddBookmark';
import { DEFAULT_SOURCE } from './sources';
import { getBookmarkSource } from './bookmark-sources';

const PAGE_SIZE = 30;

function parseDate(s) {
  try { return new Date(s).getTime() || 0; } catch { return 0; }
}

function sortBookmarks(list, sort) {
  const copy = [...list];
  if (sort === 'newest')    return copy.sort((a, b) => parseDate(b.postedAt) - parseDate(a.postedAt));
  if (sort === 'oldest')    return copy.sort((a, b) => parseDate(a.postedAt) - parseDate(b.postedAt));
  if (sort === 'likes')     return copy.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  if (sort === 'bookmarks') return copy.sort((a, b) => (b.bookmarkCount || 0) - (a.bookmarkCount || 0));
  if (sort === 'reposts')   return copy.sort((a, b) => (b.repostCount || 0) - (a.repostCount || 0));
  if (sort === 'author')    return copy.sort((a, b) => (a.authorHandle || '').localeCompare(b.authorHandle || ''));
  return copy;
}

function cleanForVoice(text) {
  return (text || '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\bhttp\S+/g, 'link')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function loadTtsConfig() {
  try { return JSON.parse(localStorage.getItem('ttsConfig') || 'null'); } catch { return null; }
}

function saveTtsConfig(cfg) {
  localStorage.setItem('ttsConfig', cfg ? JSON.stringify(cfg) : 'null');
}

export default function App() {
  const [allBookmarks, setAllBookmarks]         = useState([]);
  const [loading, setLoading]                   = useState(true);
  const [error, setError]                       = useState(null);
  const [currentFilter, setCurrentFilter]       = useState('all');
  const [currentSort, setCurrentSort]           = useState('newest');
  const [currentPage, setCurrentPage]           = useState(1);
  const [searchQuery, setSearchQuery]           = useState('');
  const [readIds, setReadIds]                   = useState(new Set());
  const [favMap, setFavMap]                     = useState({});
  // [{ folder, count, lastUsed }] from state.db, most recently used first.
  const [knownFolders, setKnownFolders]         = useState([]);
  const [notesMap, setNotesMap]                 = useState({});
  const [currentVoice, setCurrentVoice]         = useState(null);
  const [showUnreadOnly, setShowUnreadOnly]     = useState(true);
  const [selectedCategories, setSelectedCats]   = useState(new Set());
  const [syncState, setSyncState]               = useState({ status: 'idle', msg: '' });
  const [activeMode, setActiveMode]             = useState(null);
  const [settingsOpen, setSettingsOpen]         = useState(false);
  // Which tab the add pane opens on when a source row sends you there.
  const [addTab, setAddTab]                     = useState('paste');

  // The native menu's Settings item (Cmd+,) reaches React through an event,
  // since the menu lives in Rust and has no other handle on this tree.
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener('tsb:open-settings', open);
    return () => window.removeEventListener('tsb:open-settings', open);
  }, []);
  const [aiBackend, setAiBackend]               = useState('claude');
  const [classifyBackend, setClassifyBackend]   = useState('python');
  const [syncSource, setSyncSource]             = useState(DEFAULT_SOURCE);
  const [syncBrowser, setSyncBrowser]           = useState('chrome');
  const [browserInfo, setBrowserInfo]           = useState([]);
  const [sourceInfo, setSourceInfo]             = useState([]); // [{id,label,provides,installed}]
  const [ttsConfig, setTtsConfigState]          = useState(loadTtsConfig);
  const [showVoiceSetup, setShowVoiceSetup]     = useState(false);
  const [voicePlaying, setVoicePlaying]         = useState(false);
  const [voiceIdx, setVoiceIdx]                 = useState(0);
  const [focusedIdx, setFocusedIdx]             = useState(-1);
  const voiceScriptRef                          = useRef([]);
  const audioRef                                = useRef(null);

  // Load bookmarks. Extracted so anything that adds to the collection — a
  // Hacker News save, a pasted link, an export import — can pull the merged
  // list again rather than trying to splice a record in by hand.
  const loadBookmarks = useCallback(() => {
    return fetch('/api/bookmarks')
      .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(d.error || 'Failed to load')))
      .then(data => {
        setAllBookmarks(data);
        setReadIds(new Set(data.filter(b => b.isRead).map(b => b.id)));
        const fav = {}, notes = {};
        data.forEach(b => {
          const ff = b.favFolders?.length ? b.favFolders : (b.favFolder ? [b.favFolder] : []);
          if (ff.length) fav[b.id] = ff;
          if (b.note) notes[b.id] = b.note;
        });
        setFavMap(fav);
        setNotesMap(notes);
        setLoading(false);
      })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, []);

  useEffect(() => { loadBookmarks(); }, [loadBookmarks]);

  // The full folder list, including folders with no member in this collection.
  useEffect(() => {
    fetch('/api/fav-folders')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setKnownFolders(d); })
      .catch(() => {});
  }, []);

  // Load settings
  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(d => {
      if (d.aiBackend) setAiBackend(d.aiBackend);
      if (d.classifyBackend) setClassifyBackend(d.classifyBackend);
      if (d.syncSource) setSyncSource(d.syncSource);
      if (d.syncBrowser) setSyncBrowser(d.syncBrowser);
    }).catch(() => {});
  }, []);

  // Load source registry (capabilities + install hints)
  useEffect(() => {
    fetch('/api/sources').then(r => r.json()).then(d => {
      if (d.sources) setSourceInfo(d.sources);
    }).catch(() => {});
    fetch('/api/browsers').then(r => r.json()).then(d => {
      if (d.browsers) setBrowserInfo(d.browsers);
    }).catch(() => {});
  }, []);

  // Check initial sync status
  useEffect(() => {
    fetch('/api/status').then(r => r.json()).then(d => {
      if (d.sync.status === 'running' || d.classify.status === 'running') {
        setSyncState({ status: 'running', msg: d.classify.status === 'running' ? (d.classify.progress || 'Classifying…') : 'Syncing…' });
      }
    }).catch(() => {});
  }, []);

  // Poll sync status while running
  useEffect(() => {
    if (syncState.status !== 'running') return;
    const timer = setInterval(() => {
      fetch('/api/status').then(r => r.json()).then(d => {
        if (d.sync.status === 'running') {
          const msg = d.sync.log ? d.sync.log.split('\n').filter(Boolean).pop()?.trim().slice(0, 40) : '';
          setSyncState({ status: 'running', msg: msg || 'Syncing bookmarks…' });
        } else if (d.classify.status === 'running') {
          setSyncState({ status: 'running', msg: d.classify.progress || 'Classifying…' });
        } else if (d.sync.status === 'error' || d.classify.status === 'error') {
          // ft names the cause and the remedy; both beat "Something went wrong",
          // which sent you looking at this app for a problem that is usually an
          // expired X session in whichever browser the sync reads.
          const detail = [d.sync.error, d.sync.fix].filter(Boolean).join(' ');
          setSyncState({ status: 'error', msg: detail || 'Something went wrong' });
          clearInterval(timer);
        } else {
          setSyncState({ status: 'done', msg: 'Done ✓ — reloading…' });
          clearInterval(timer);
          setTimeout(() => {
            fetch('/api/bookmarks?t=' + Date.now()).then(r => r.json()).then(data => {
              setAllBookmarks(data);
              setSyncState({ status: 'idle', msg: '' });
            }).catch(() => {});
          }, 1500);
        }
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [syncState.status]);

  // Latest feed state for the key handler below, which attaches once and so
  // must not close over any of it. Pinned to the first render, `filtered` was
  // still empty, `pageItems.length - 1` was -1, and focus could never leave
  // -1: j/k/r/f did nothing until some unrelated change forced a re-subscribe.
  const keyStateRef = useRef({ pageItems: [], favMap: {}, activeMode: null, focusedIdx: -1 });
  useEffect(() => {
    keyStateRef.current = {
      pageItems: filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
      favMap,
      activeMode,
      focusedIdx,
    };
  });

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      const { pageItems, favMap: favs, activeMode: mode, focusedIdx: focused } = keyStateRef.current;
      // Ahead of the typing guard below: ⌘K reaches the chat from anywhere,
      // including with the cursor still in the search box. Checked before the
      // bare-k feed navigation so the two don't collide.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setActiveMode(m => (m === 'chat' ? null : 'chat'));
        return;
      }

      if (e.key === 'Escape') {
        if (mode) {
          e.preventDefault();
          setActiveMode(null);
        } else {
          document.activeElement?.blur();
        }
        return;
      }

      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        document.querySelector('.search-input')?.focus();
        return;
      }

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIdx(i => Math.min(i + 1, pageItems.length - 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'r' && focused >= 0) {
        const bm = pageItems[focused];
        if (bm) handleToggleRead(bm.id);
      } else if (e.key === 'f' && focused >= 0) {
        const bm = pageItems[focused];
        if (bm) {
          const cur = favs[bm.id] || [];
          const next = cur.includes('Favourites') ? cur.filter(f => f !== 'Favourites') : [...cur, 'Favourites'];
          handleSetFavFolders(bm.id, next);
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line -- live state comes from keyStateRef, not the closure

  // Computed: filtered + sorted
  const filtered = useMemo(() => {
    let result = [...allBookmarks];

    if (selectedCategories.size > 0) {
      result = result.filter(b => {
        const cats = b.categories?.length ? b.categories : [b.primaryCategory];
        return cats.some(c => selectedCategories.has(c));
      });
    }

    if (currentFilter !== 'all') {
      if (currentFilter.startsWith('folder:')) {
        const folder = currentFilter.slice(7);
        result = result.filter(b => (b.folderNames || []).includes(folder));
      } else if (currentFilter === 'fav:all') {
        result = result.filter(b => favMap[b.id]?.length);
      } else if (currentFilter.startsWith('fav:')) {
        const folder = currentFilter.slice(4);
        result = result.filter(b => favMap[b.id]?.includes(folder));
      } else if (currentFilter.startsWith('source:')) {
        const src = currentFilter.slice(7);
        result = result.filter(b => (b.source || 'x') === src);
      }
    }

    if (currentVoice) result = result.filter(b => b.authorHandle === currentVoice);
    if (showUnreadOnly) result = result.filter(b => !readIds.has(b.id));

    if (searchQuery) {
      const q = searchQuery;
      result = result.filter(b =>
        (b.text || '').toLowerCase().includes(q) ||
        (b.authorHandle || '').toLowerCase().includes(q.replace('@', '')) ||
        (b.authorName || '').toLowerCase().includes(q) ||
        (b.articleTitle || '').toLowerCase().includes(q) ||
        (b.title || '').toLowerCase().includes(q) ||
        (b.domain || '').toLowerCase().includes(q) ||
        (b.primaryCategory || '').toLowerCase().includes(q) ||
        (notesMap[b.id] || '').toLowerCase().includes(q)
      );
    }

    return sortBookmarks(result, currentSort);
  }, [allBookmarks, currentFilter, currentSort, searchQuery, readIds, favMap, notesMap, currentVoice, showUnreadOnly, selectedCategories]);

  /**
   * Identity of the current view, for the feed's leave animation.
   *
   * A card that drops out while this holds still left because of something you
   * did to it, and is worth animating away. When this changes you asked for a
   * different set of bookmarks, and the feed should just show them.
   */
  const viewKey = useMemo(
    () => [
      currentFilter, currentSort, searchQuery, showUnreadOnly ? 'unread' : 'all',
      currentVoice || '', [...selectedCategories].sort().join('+'),
    ].join('|'),
    [currentFilter, currentSort, searchQuery, showUnreadOnly, currentVoice, selectedCategories],
  );

  const unreadCount = useMemo(() => allBookmarks.filter(b => !readIds.has(b.id)).length, [allBookmarks, readIds]);
  /**
   * Every folder that exists, most recently used first.
   *
   * Deriving this from favMap alone hid folders whose members all sit outside
   * the loaded collection: they dropped out of the picker entirely, so there
   * was no way to file anything into them again. state.db is authoritative;
   * favMap only tops it up with folders created since the last fetch.
   */
  const favFolders = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const { folder } of knownFolders) {
      if (folder && !seen.has(folder)) { seen.add(folder); out.push(folder); }
    }
    for (const folder of Object.values(favMap).flat()) {
      if (folder && !seen.has(folder)) { seen.add(folder); out.push(folder); }
    }
    return out;
  }, [knownFolders, favMap]);

  const catCounts = useMemo(() => {
    const counts = {};
    allBookmarks.forEach(b => {
      const cats = b.categories?.length ? b.categories : [b.primaryCategory || 'unclassified'];
      cats.forEach(c => { if (c && c !== 'unclassified') counts[c] = (counts[c] || 0) + 1; });
    });
    return counts;
  }, [allBookmarks]);

  const folderCounts = useMemo(() => {
    const counts = {};
    allBookmarks.forEach(b => (b.folderNames || []).forEach(f => { counts[f] = (counts[f] || 0) + 1; }));
    return counts;
  }, [allBookmarks]);

  const sourceCounts = useMemo(() => {
    const counts = {};
    allBookmarks.forEach(b => { const s = b.source || 'x'; counts[s] = (counts[s] || 0) + 1; });
    return counts;
  }, [allBookmarks]);

  // Handlers
  const handleToggleRead = useCallback(async (id) => {
    try {
      const r = await fetch(`/api/read/${id}`, { method: 'POST' });
      const d = await r.json();
      setReadIds(prev => {
        const next = new Set(prev);
        d.isRead ? next.add(id) : next.delete(id);
        return next;
      });
    } catch {}
  }, []);

  // Set a bookmark's full favourite-folder set (a bookmark can be in many folders)
  const handleSetFavFolders = useCallback(async (id, folders) => {
    const clean = [...new Set((folders || []).map(f => f.trim()).filter(Boolean))];
    setFavMap(prev => {
      const next = { ...prev };
      clean.length ? (next[id] = clean) : delete next[id];
      return next;
    });
    // Move what was just used to the front, so the picker's "recent" list
    // reflects this click rather than the last fetch.
    if (clean.length) {
      setKnownFolders(prev => {
        const touched = new Set(clean);
        const bumped = clean.map(f => prev.find(k => k.folder === f) || { folder: f, count: 0, lastUsed: null });
        return [...bumped, ...prev.filter(k => !touched.has(k.folder))];
      });
    }
    try {
      await fetch(`/api/fav/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folders: clean }),
      });
    } catch {}
  }, []);

  // Rename a favourite folder everywhere (like renaming a folder)
  const handleRenameFavFolder = useCallback(async (from, to) => {
    const f = (from || '').trim(), t = (to || '').trim();
    if (!f || !t || f === t) return;
    setFavMap(prev => {
      const next = {};
      for (const [id, arr] of Object.entries(prev)) {
        next[id] = [...new Set(arr.map(x => x === f ? t : x))];
      }
      return next;
    });
    setKnownFolders(prev => {
      const merged = [];
      for (const k of prev) {
        const folder = k.folder === f ? t : k.folder;
        const hit = merged.find(m => m.folder === folder);
        // Renaming onto an existing name merges the two, as the server does.
        if (hit) hit.count += k.count || 0;
        else merged.push({ ...k, folder });
      }
      return merged;
    });
    setCurrentFilter(prev => prev === `fav:${f}` ? `fav:${t}` : prev);
    try {
      await fetch('/api/fav-rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: f, to: t }),
      });
    } catch {}
  }, []);


  const handleUpdateNote = useCallback(async (id, note) => {
    try {
      await fetch(`/api/note/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      setNotesMap(prev => {
        const next = { ...prev };
        note ? (next[id] = note) : delete next[id];
        return next;
      });
    } catch {}
  }, []);

  const handleBulkRead = useCallback(async (ids) => {
    try {
      await fetch('/api/read/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, read: true }),
      });
      setReadIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.add(id));
        return next;
      });
    } catch {}
  }, []);

  const handleSync = useCallback(async () => {
    if (syncState.status === 'running') return;
    try {
      const r = await fetch('/api/syncall', { method: 'POST' });
      const d = await r.json();
      if (!d.ok) { setSyncState({ status: 'error', msg: d.msg }); return; }
      setSyncState({ status: 'running', msg: 'Connecting to X…' });
    } catch {
      setSyncState({ status: 'error', msg: 'Server not reachable' });
    }
  }, [syncState.status]);

  const handleSetAiBackend = useCallback(async (backend) => {
    setAiBackend(backend);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiBackend: backend }),
    }).catch(() => {});
  }, []);

  const handleSetClassifyBackend = useCallback(async (backend) => {
    setClassifyBackend(backend);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classifyBackend: backend }),
    }).catch(() => {});
  }, []);

  const handleSetSyncSource = useCallback(async (source) => {
    setSyncSource(source);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncSource: source }),
    }).catch(() => {});
  }, []);

  const handleSetSyncBrowser = useCallback(async (browser) => {
    setSyncBrowser(browser);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncBrowser: browser }),
    }).catch(() => {});
  }, []);

  const handleSetTtsConfig = useCallback((cfg) => {
    setTtsConfigState(cfg);
    saveTtsConfig(cfg);
  }, []);

  // TTS voice playback — proxied through local server to avoid CORS
  const handleTtsSpeak = useCallback(async (text) => {
    if (!ttsConfig || !text) return;
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: ttsConfig.provider, text, key: ttsConfig.key, voiceId: ttsConfig.voice }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `TTS error ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; }
      audioRef.current = new Audio(url);
      audioRef.current.play();
      return audioRef.current;
    } catch (e) {
      console.error('TTS error:', e);
      const utter = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.speak(utter);
    }
  }, [ttsConfig]);

  // Play through feed with voice
  const handleVoicePlay = useCallback(async () => {
    if (voicePlaying) {
      if (audioRef.current) audioRef.current.pause();
      window.speechSynthesis.cancel();
      setVoicePlaying(false);
      return;
    }
    const items = filtered.slice(0, 20).filter(b => b.text);
    voiceScriptRef.current = items;
    setVoicePlaying(true);
    setVoiceIdx(0);
  }, [voicePlaying, filtered]);

  // Auto-advance voice
  useEffect(() => {
    if (!voicePlaying || voiceScriptRef.current.length === 0) return;
    const bm = voiceScriptRef.current[voiceIdx];
    if (!bm) { setVoicePlaying(false); return; }

    const text = `From ${bm.authorName || bm.authorHandle}: ${cleanForVoice(bm.text)}`;

    if (ttsConfig) {
      handleTtsSpeak(text).then(audio => {
        if (!audio) return;
        audio.onended = () => {
          setVoiceIdx(i => {
            const next = i + 1;
            if (next >= voiceScriptRef.current.length) { setVoicePlaying(false); return i; }
            return next;
          });
        };
      });
    } else {
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 0.95;
      utter.onend = () => {
        setVoiceIdx(i => {
          const next = i + 1;
          if (next >= voiceScriptRef.current.length) { setVoicePlaying(false); return i; }
          return next;
        });
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    }
  }, [voicePlaying, voiceIdx]); // eslint-disable-line

  const handleFilterChange = useCallback((filter) => {
    setCurrentFilter(prev => (prev === filter && filter !== 'all') ? 'all' : filter);
    // 'all' and favourites views show everything (read + unread); favourites are
    // never hidden by read state.
    if (filter === 'all' || filter.startsWith('fav:')) setShowUnreadOnly(false);
    setCurrentPage(1);
    setFocusedIdx(-1);
  }, []);

  const handleToggleCategory = useCallback((cat) => {
    setSelectedCats(prev => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
    setCurrentPage(1);
  }, []);

  /**
   * Clicking a source that has nothing in it yet.
   *
   * Filtering to an empty feed would tell you nothing you didn't already know
   * from the greyed-out row, so these go to the surface that fills the source
   * instead. X is the exception: its only route in is a Field Theory sync,
   * which lives in the right panel, so that row stays inert and says so in its
   * tooltip.
   */
  const handleSourceAction = useCallback((action) => {
    if (!action) return;
    if (action === 'hn') { setActiveMode('hn'); return; }
    if (action.startsWith('add:')) {
      setAddTab(action.slice(4));
      setActiveMode('add');
    }
  }, []);

  const handleVoiceClick = useCallback((handle) => {
    setCurrentVoice(prev => prev === handle ? null : handle);
    setCurrentPage(1);
  }, []);

  return (
    <div className="layout">
      <Sidebar
        total={allBookmarks.length}
        unreadCount={unreadCount}
        currentFilter={currentFilter}
        onFilterChange={handleFilterChange}
        showUnreadOnly={showUnreadOnly}
        onToggleUnread={() => { setCurrentFilter('all'); setShowUnreadOnly(p => !p); setCurrentPage(1); setFocusedIdx(-1); }}
        catCounts={catCounts}
        selectedCategories={selectedCategories}
        onToggleCategory={handleToggleCategory}
        onClearCategories={() => { setSelectedCats(new Set()); setCurrentPage(1); }}
        favMap={favMap}
        favFolders={favFolders}
        folderCounts={folderCounts}
        sourceCounts={sourceCounts}
        onSourceAction={handleSourceAction}
        onRenameFavFolder={handleRenameFavFolder}
        syncSource={syncSource}
      />
      <main className="main">
        {activeMode === 'chat' ? (
          <ChatWithBookmarks
            bookmarks={allBookmarks}
            aiBackend={aiBackend}
            favMap={favMap}
            favFolders={favFolders}
            onSetFavFolders={handleSetFavFolders}
            onRenameFavFolder={handleRenameFavFolder}
            onClose={() => setActiveMode(null)}
          />
        ) : activeMode === 'stats' ? (
          <StatsObservations bookmarks={allBookmarks} onClose={() => setActiveMode(null)} />
        ) : activeMode === 'hn' ? (
          <HackerNews onSaved={loadBookmarks} onClose={() => setActiveMode(null)} />
        ) : activeMode === 'add' ? (
          <AddBookmark initialTab={addTab} onAdded={loadBookmarks} onClose={() => setActiveMode(null)} />
        ) : activeMode === 'podcast' ? (
          <BookmarkPodcast bookmarks={allBookmarks} ttsConfig={ttsConfig} onSetTtsConfig={handleSetTtsConfig} aiBackend={aiBackend} onClose={() => setActiveMode(null)} />
        ) : (
          <>
            <Header
              searchQuery={searchQuery}
              onSearch={(q) => { setSearchQuery(q.trim().toLowerCase()); setCurrentPage(1); }}
              resultCount={filtered.length !== allBookmarks.length ? filtered.length : null}
              ttsConfig={ttsConfig}
              voicePlaying={voicePlaying}
              showVoiceSetup={showVoiceSetup}
              onVoiceToggle={handleVoicePlay}
              onShowVoiceSetup={() => setShowVoiceSetup(p => !p)}
              onSetTtsConfig={handleSetTtsConfig}
              onCloseVoiceSetup={() => setShowVoiceSetup(false)}
            />
            <SortBar currentSort={currentSort} onSort={(s) => { setCurrentSort(s); setCurrentPage(1); }} />
            {!loading && !error && <StatsBar bookmarks={allBookmarks} />}
            <Feed
              bookmarks={filtered}
              page={currentPage}
              pageSize={PAGE_SIZE}
              loading={loading}
              error={error}
              searchQuery={searchQuery}
              readIds={readIds}
              favMap={favMap}
              favFolders={favFolders}
              notesMap={notesMap}
              focusedIdx={focusedIdx}
              viewKey={viewKey}
              onToggleRead={handleToggleRead}
              onSetFavFolders={handleSetFavFolders}
              onRenameFavFolder={handleRenameFavFolder}
              onUpdateNote={handleUpdateNote}
              onBulkRead={handleBulkRead}
              onPageChange={(p) => { setCurrentPage(p); setFocusedIdx(-1); }}
              ttsConfig={ttsConfig}
              onSpeakBookmark={(bm) => handleTtsSpeak(`From ${bm.authorName || bm.authorHandle}: ${cleanForVoice(bm.text)}`)}
            />
          </>
        )}
      </main>
      <RightPanel
        onOpenSettings={() => setSettingsOpen(true)}
        bookmarks={allBookmarks}
        currentVoice={currentVoice}
        onVoiceClick={handleVoiceClick}
        syncState={syncState}
        onSync={handleSync}
        activeMode={activeMode}
        setActiveMode={setActiveMode}
        aiBackend={aiBackend}
        onSetAiBackend={handleSetAiBackend}
        classifyBackend={classifyBackend}
        onSetClassifyBackend={handleSetClassifyBackend}
        syncSource={syncSource}
        onSetSyncSource={handleSetSyncSource}
        syncBrowser={syncBrowser}
        onSetSyncBrowser={handleSetSyncBrowser}
        browserInfo={browserInfo}
        sourceInfo={sourceInfo}
      />
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {voicePlaying && (
        <VoiceBubble
          isPlaying={voicePlaying}
          currentText={voiceScriptRef.current[voiceIdx]?.text || ''}
          onPlayPause={() => {
            if (audioRef.current) audioRef.current.pause();
            window.speechSynthesis.cancel();
            setVoicePlaying(false);
          }}
          onSkip={() => setVoiceIdx(i => Math.min(i + 1, voiceScriptRef.current.length - 1))}
          onClose={() => {
            if (audioRef.current) audioRef.current.pause();
            window.speechSynthesis.cancel();
            setVoicePlaying(false);
          }}
        />
      )}
    </div>
  );
}
