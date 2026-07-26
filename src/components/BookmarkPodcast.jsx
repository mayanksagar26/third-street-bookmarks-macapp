import { useState, useRef, useEffect, useMemo } from 'react';
import VoiceBubble from './VoiceBubble';

const PROVIDERS = [
  { id: 'browser',    name: 'Browser TTS', desc: 'Free, built-in.',              icon: '🔊', needsKey: false, voices: [] },
  { id: 'elevenlabs', name: 'ElevenLabs',  desc: 'High quality AI voices.',      icon: '🎙️', needsKey: true,
    placeholder: 'sk_…', keyLabel: 'ElevenLabs API Key',
    voices: [
      { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
      { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi' },
      { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella' },
      { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni' },
      { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh' },
    ],
  },
  { id: 'sarvam', name: 'Sarvam AI', desc: 'Indian AI voices.',           icon: '🌏', needsKey: true,
    placeholder: 'your-sarvam-api-key', keyLabel: 'Sarvam API Key',
    voices: [
      { id: 'meera', name: 'Meera (F)' }, { id: 'pavithra', name: 'Pavithra (F)' },
      { id: 'maitreyi', name: 'Maitreyi (F)' }, { id: 'arvind', name: 'Arvind (M)' },
      { id: 'amol', name: 'Amol (M)' },
    ],
  },
];

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function buildPodcastPrompt(bookmarks, sourceType, topic, customPrompt) {
  const lines = bookmarks.map((b, i) => {
    const urls = (b.text || '').match(/https?:\/\/\S+/g) || [];
    const cleanText = (b.text || '').replace(/https?:\/\/\S+/g, (url) => {
      const d = extractDomain(url);
      return d ? `[link to ${d}]` : '[link]';
    });
    const engagement = b.likeCount > 1000 ? ` (${Math.round(b.likeCount / 1000)}k likes)` : '';
    return `${i + 1}. @${b.authorHandle}${engagement}: ${cleanText}`;
  }).join('\n');

  let focus = '';
  if (sourceType === 'topic' && topic) focus = `Focus on the theme: "${topic}". `;
  else if (sourceType === 'prompt' && customPrompt) focus = `User request: "${customPrompt}". `;

  return `You are the host of "Third Street Bookmarks", a personal podcast from someone's saved tweets.

${focus}Write a natural, spoken podcast script. Rules:
- Conversational spoken language — this will be read aloud by text-to-speech
- For [link to domain] references: briefly infer what the link is about from context (e.g., "a link to an article on their GitHub" or "linking to their product demo on vercel") — never say the URL
- Group related bookmarks thematically with smooth transitions
- Highlight interesting engagement numbers when notable
- Target 3-5 minutes when read aloud

Return ONLY a valid JSON array, no markdown fences, no explanation:
[{"text": "spoken text", "type": "intro|segment|outro"}]

Bookmarks:
${lines}`;
}

function parseScript(raw) {
  const match = raw.match(/\[[\s\S]*?\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  // Fallback: split into lines
  return raw.split('\n').filter(l => l.trim().length > 20).map(l => ({ text: l.trim(), type: 'segment' }));
}

// Both providers go through local server proxy to avoid CORS
async function speakViaTTS(provider, text, key, voiceId) {
  const resp = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, text, key, voiceId }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `TTS error ${resp.status}`);
  }
  return new Audio(URL.createObjectURL(await resp.blob()));
}

// Multi-select topic dropdown
function TopicPicker({ bookmarks, selectedTopics, onToggle, onClear }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const cats = useMemo(() => {
    const c = {};
    bookmarks.forEach(b => { if (b.primaryCategory && b.primaryCategory !== 'unclassified') c[b.primaryCategory] = (c[b.primaryCategory]||0)+1; });
    return Object.entries(c).sort((a,b) => b[1]-a[1]).map(([cat, count]) => ({ id: `cat:${cat}`, label: cat, badge: count, group: 'Categories' }));
  }, [bookmarks]);

  const favFolders = useMemo(() => {
    const f = new Set(bookmarks.map(b => b.favFolder).filter(Boolean));
    return [...f].map(folder => ({ id: `fav:${folder}`, label: `⭐ ${folder}`, badge: bookmarks.filter(b => b.favFolder===folder).length, group: 'Favourites' }));
  }, [bookmarks]);

  const allOptions = [...favFolders, ...cats];
  const grouped = allOptions.reduce((acc, o) => { (acc[o.group] = acc[o.group]||[]).push(o); return acc; }, {});

  const selCount = selectedTopics.length;
  const label = selCount === 0 ? 'Select topics, folders…' : selectedTopics.map(t => t.label.replace('⭐ ','')).join(', ');

  return (
    <div className="topic-picker" ref={ref}>
      <button className={`topic-picker-trigger ${open?'open':''}`} onClick={() => setOpen(p=>!p)}>
        <span className="topic-picker-label" title={label}>{label}</span>
        {selCount > 0 && <span className="topic-picker-count">{selCount}</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{flexShrink:0,opacity:0.5,transform:open?'rotate(180deg)':'none',transition:'transform 0.15s'}}><path d="M7 10l5 5 5-5z"/></svg>
      </button>
      {open && (
        <div className="topic-picker-dropdown">
          {selCount > 0 && (
            <div className="topic-picker-clear" onClick={() => { onClear(); setOpen(false); }}>Clear all</div>
          )}
          {Object.entries(grouped).map(([group, opts]) => (
            <div key={group}>
              <div className="topic-picker-group">{group}</div>
              {opts.map(opt => {
                const isSelected = selectedTopics.some(t => t.id === opt.id);
                return (
                  <div key={opt.id} className={`topic-picker-option ${isSelected?'selected':''}`} onClick={() => onToggle(opt)}>
                    <span className="topic-picker-check">{isSelected ? '✓' : ''}</span>
                    <span className="topic-picker-opt-label">{opt.label}</span>
                    <span className="topic-picker-opt-badge">{opt.badge}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BookmarkPodcast({ bookmarks, ttsConfig, onSetTtsConfig, aiBackend, onClose }) {
  const [mode, setMode]               = useState('setup');
  const [sourceType, setSourceType]   = useState('recent');
  const [count, setCount]             = useState(15);
  const [selectedTopics, setSelectedTopics] = useState([]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [generationText, setGenerationText] = useState('');
  const [genError, setGenError]       = useState('');

  const initProvider = ttsConfig ? (PROVIDERS.find(p => p.id === ttsConfig.provider) || PROVIDERS[0]) : PROVIDERS[0];
  const [selectedProvider, setSelectedProvider] = useState(initProvider);
  const [apiKey, setApiKey]           = useState(ttsConfig?.key || '');
  const [selectedVoice, setSelectedVoice] = useState(ttsConfig?.voice || '');

  const [script, setScript]           = useState([]);
  const [currentIdx, setCurrentIdx]   = useState(0);
  const [isPlaying, setIsPlaying]     = useState(false);
  const [playError, setPlayError]     = useState('');
  const [speed, setSpeed]             = useState(1);
  const speedRef                      = useRef(1);

  const audioRef        = useRef(null);
  const synthRef        = useRef(window.speechSynthesis);
  const playingRef      = useRef(false);
  const abortRef        = useRef(null);
  const scrollRef       = useRef(null);
  const currentSegRef   = useRef(null);
  const waveRef         = useRef(null);
  const waveAnimRef     = useRef(null);
  const userScrolledRef = useRef(false);
  const userScrollTimer = useRef(null);

  // ── Waveform animation (direct DOM, no state) ──────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(waveAnimRef.current);
      const bars = waveRef.current?.children;
      if (bars) Array.from(bars).forEach(b => { b.style.height = '4px'; b.style.opacity = '0.3'; });
      return;
    }
    let phase = 0;
    const N = 48;
    // Pre-compute stable seeds so bars have consistent personalities
    const seeds = Array.from({length: N}, (_, i) => Math.abs(Math.sin(i * 7.391 + 3.14) % 1));

    function tick() {
      phase += 0.07;
      const bars = waveRef.current?.children;
      if (bars) {
        Array.from(bars).forEach((bar, i) => {
          const s = seeds[i];
          const wave  = (Math.sin(i * 0.42 + phase) * 0.5 + 0.5);
          const wave2 = (Math.sin(i * 1.1  + phase * 1.6) * 0.5 + 0.5);
          const wave3 = (Math.sin(i * 0.23 + phase * 0.9) * 0.5 + 0.5);
          const h = 4 + (wave * 0.45 + wave2 * 0.35 + wave3 * 0.1 + s * 0.1) * 52;
          bar.style.height = h.toFixed(1) + 'px';
          bar.style.opacity = (0.5 + (h / 60) * 0.5).toFixed(2);
        });
      }
      waveAnimRef.current = requestAnimationFrame(tick);
    }
    waveAnimRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(waveAnimRef.current);
  }, [isPlaying]);

  // ── Auto-scroll to current segment ────────────────────────────────────────
  useEffect(() => {
    if (userScrolledRef.current) return;
    currentSegRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [currentIdx]);

  // ── Detect manual scroll → pause auto-scroll for 4s ──────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      userScrolledRef.current = true;
      clearTimeout(userScrollTimer.current);
      userScrollTimer.current = setTimeout(() => { userScrolledRef.current = false; }, 4000);
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [mode]);

  const backend = aiBackend || 'claude';
  const backendLabel = backend === 'codex' ? 'Codex CLI' : 'Claude Code CLI';

  // ── Generation ──────────────────────────────────────────────────────────────
  async function generate() {
    setGenError('');
    setGenerationText('Asking ' + backendLabel + ' to craft your podcast script…');
    setMode('generating');

    let selected = bookmarks.filter(b => b.text);
    if (sourceType === 'topic' && selectedTopics.length > 0) {
      selected = selected.filter(b =>
        selectedTopics.some(t => {
          if (t.id.startsWith('cat:')) return b.primaryCategory === t.id.slice(4) || (b.categories||[]).includes(t.id.slice(4));
          if (t.id.startsWith('fav:')) return b.favFolder === t.id.slice(4);
          return false;
        })
      );
    }
    selected = selected.slice(0, Math.max(5, Math.min(30, count)));

    if (!selected.length) {
      setGenError('No bookmarks matched. Try a different topic or count.');
      setMode('setup');
      return;
    }

    const topicLabel = selectedTopics.map(t => t.label.replace('⭐ ','')).join(', ');
    const prompt = buildPodcastPrompt(selected, sourceType, topicLabel, customPrompt);

    try {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: ctrl.signal,
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        setGenerationText(full);
      }

      const segments = parseScript(full);
      if (!segments.length) throw new Error('Could not parse podcast script.');

      // Save TTS config if key provided
      if (selectedProvider.needsKey && apiKey.trim() && onSetTtsConfig) {
        onSetTtsConfig({ provider: selectedProvider.id, key: apiKey.trim(), voice: selectedVoice || selectedProvider.voices[0]?.id || '' });
      }

      setScript(segments);
      setCurrentIdx(0);
      setMode('playing');
      // Auto-start
      setTimeout(() => startPlaying(segments, 0), 400);
    } catch (e) {
      if (e.name !== 'AbortError') {
        setGenError(e.message);
        setMode('setup');
      }
    }
  }

  // ── Playback ─────────────────────────────────────────────────────────────────
  async function speakSegment(idx, segs) {
    if (!segs[idx] || !playingRef.current) return;
    const text = segs[idx].text;
    const key  = ttsConfig?.key || apiKey;
    const voice = ttsConfig?.voice || selectedVoice || selectedProvider.voices?.[0]?.id || '';

    const onEnd = () => {
      if (!playingRef.current) return;
      const next = idx + 1;
      if (next < segs.length) { setCurrentIdx(next); speakSegment(next, segs); }
      else { setIsPlaying(false); playingRef.current = false; }
    };

    try {
      if ((selectedProvider.id === 'elevenlabs' || selectedProvider.id === 'sarvam') && key) {
        const audio = await speakViaTTS(selectedProvider.id, text, key, voice);
        audioRef.current = audio;
        audio.playbackRate = speedRef.current;
        audio.onended = onEnd;
        audio.play();
      } else {
        synthRef.current?.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = speedRef.current;
        utter.onend = onEnd;
        synthRef.current?.speak(utter);
      }
    } catch (e) {
      setPlayError(e.message);
      setIsPlaying(false);
      playingRef.current = false;
    }
  }

  function startPlaying(segs, idx) {
    playingRef.current = true;
    setIsPlaying(true);
    speakSegment(idx ?? currentIdx, segs ?? script);
  }

  function handlePlayPause() {
    if (isPlaying) {
      if (audioRef.current) audioRef.current.pause();
      synthRef.current?.pause();
      playingRef.current = false;
      setIsPlaying(false);
    } else {
      if (audioRef.current && audioRef.current.paused) {
        audioRef.current.play();
        playingRef.current = true;
        setIsPlaying(true);
      } else if (synthRef.current?.paused) {
        synthRef.current.resume();
        playingRef.current = true;
        setIsPlaying(true);
      } else {
        startPlaying(script, currentIdx);
      }
    }
  }

  function handleSkip() {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    synthRef.current?.cancel();
    const next = currentIdx + 1;
    if (next < script.length) {
      setCurrentIdx(next);
      if (isPlaying) speakSegment(next, script);
    }
  }

  function handleClose() {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    synthRef.current?.cancel();
    abortRef.current?.abort();
    playingRef.current = false;
    setIsPlaying(false);
  }

  function changeSpeed(s) {
    speedRef.current = s;
    setSpeed(s);
    if (audioRef.current) {
      audioRef.current.playbackRate = s;
    } else if (isPlaying && synthRef.current) {
      // Browser TTS: restart current segment at new rate
      synthRef.current.cancel();
      setTimeout(() => speakSegment(currentIdx, script), 80);
    }
  }

  function reset() { handleClose(); setMode('setup'); setScript([]); setGenerationText(''); setGenError(''); }

  // ── Render: generating ───────────────────────────────────────────────────────
  if (mode === 'generating') {
    return (
      <div className="mode-container">
        <div className="mode-topbar">
          <button className="mode-back-btn" onClick={() => { abortRef.current?.abort(); setMode('setup'); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            Cancel
          </button>
          <h2 className="mode-title">Generating Podcast</h2>
          <span className="chat-backend-badge">{backendLabel}</span>
        </div>
        <div className="podcast-gen-screen">
          <div className="podcast-gen-orb">
            <div className="podcast-gen-ring" />
            <div className="podcast-gen-ring r2" />
            <span className="podcast-gen-icon">🎙️</span>
          </div>
          <p className="podcast-gen-label">Writing your script…</p>
          {genError && <p className="podcast-error">{genError}</p>}
          <div className="podcast-gen-preview">
            {generationText.slice(-600)}
          </div>
        </div>
      </div>
    );
  }

  // ── Render: playing ──────────────────────────────────────────────────────────
  if (mode === 'playing') {
    function jumpTo(i) {
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      synthRef.current?.cancel();
      userScrolledRef.current = false; // re-enable auto-scroll after user clicks
      setCurrentIdx(i);
      if (isPlaying) speakSegment(i, script);
    }

    return (
      <div className="podcast-player-v2">
        {/* Top bar */}
        <div className="podcast-v2-topbar">
          <button className="mode-back-btn" onClick={() => { handleClose(); onClose(); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            Back
          </button>
          <div className="podcast-v2-meta">
            <span className="podcast-v2-title">Bookmark Podcast</span>
            <span className="podcast-v2-sub">{selectedProvider.name} · {backendLabel} · {script.length} segments</span>
          </div>
          <button className="mode-back-btn" onClick={reset}>New</button>
        </div>

        {/* Scrollable script */}
        <div className="podcast-v2-script" ref={scrollRef}>
          {playError && <div className="podcast-error" style={{margin:'16px 24px'}}>⚠️ {playError}</div>}

          <div className="podcast-v2-spacer-top"/>
          {script.map((seg, i) => {
            const state = i < currentIdx ? 'past' : i === currentIdx ? 'current' : 'upcoming';
            return (
              <div
                key={i}
                ref={i === currentIdx ? currentSegRef : null}
                className={`podcast-v2-seg ${state}`}
                onClick={() => jumpTo(i)}
              >
                {state === 'current' && (
                  <div className="podcast-v2-now-playing">
                    <span className="podcast-v2-pulse"/>
                    Now playing
                  </div>
                )}
                <p className="podcast-v2-text">{seg.text}</p>
                {(seg.type === 'intro' || seg.type === 'outro') && (
                  <span className="podcast-v2-type-tag">{seg.type}</span>
                )}
              </div>
            );
          })}
          <div className="podcast-v2-spacer-bottom"/>
        </div>

        {/* Waveform */}
        <div className="podcast-v2-wave-wrap">
          <div className="podcast-v2-waveform" ref={waveRef}>
            {Array.from({length: 48}).map((_, i) => (
              <div key={i} className="podcast-v2-bar"/>
            ))}
          </div>
        </div>

        {/* Speed control */}
        <div className="podcast-speed-bar">
          {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(s => (
            <button
              key={s}
              className={`podcast-speed-btn ${speed === s ? 'active' : ''}`}
              onClick={() => changeSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>

        {/* Transport controls */}
        <div className="podcast-v2-controls">
          <button
            className="podcast-ctrl-btn secondary"
            onClick={() => jumpTo(0)}
            title="Restart"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>
          <button
            className="podcast-ctrl-btn secondary"
            onClick={() => jumpTo(Math.max(0, currentIdx - 1))}
            title="Previous"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
          </button>

          <button className="podcast-ctrl-btn primary" onClick={handlePlayPause}>
            {isPlaying
              ? <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              : <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            }
          </button>

          <button
            className="podcast-ctrl-btn secondary"
            onClick={handleSkip}
            title="Next"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm2-12v12l8.5-6z" opacity="0"/><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
          </button>

          <div className="podcast-v2-progress">
            <span className="podcast-v2-idx">{currentIdx + 1}</span>
            <span className="podcast-v2-sep">/</span>
            <span className="podcast-v2-total">{script.length}</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: setup ────────────────────────────────────────────────────────────
  return (
    <div className="mode-container">
      <div className="mode-topbar">
        <button className="mode-back-btn" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          Back
        </button>
        <h2 className="mode-title">Bookmark Podcast</h2>
        <span className="chat-backend-badge">{backendLabel}</span>
      </div>

      <div className="podcast-setup" style={{ maxWidth: 560, gap: 0 }}>
        {genError && <div className="podcast-error" style={{ marginBottom: 16 }}>⚠️ {genError}</div>}

        {/* Source */}
        <div className="podcast-section-label">What to podcast about</div>
        <div className="podcast-source-tabs">
          {[
            { id: 'recent', label: '🕐 Recent' },
            { id: 'topic',  label: '🔍 Topic' },
            { id: 'prompt', label: '✍️ Prompt' },
          ].map(s => (
            <button
              key={s.id}
              className={`podcast-source-tab ${sourceType === s.id ? 'active' : ''}`}
              onClick={() => setSourceType(s.id)}
            >{s.label}</button>
          ))}
        </div>

        {sourceType === 'recent' && (
          <div className="podcast-source-config">
            <label className="podcast-key-label">Number of bookmarks</label>
            <div className="podcast-count-row">
              <input type="range" min="5" max="30" value={count} onChange={e => setCount(+e.target.value)} className="podcast-count-slider"/>
              <input
                type="number" min="5" max="30" value={count}
                onChange={e => setCount(Math.min(30, Math.max(5, +e.target.value || 5)))}
                className="podcast-count-input"
              />
            </div>
            <p className="podcast-hint">Most recent {count} bookmarks with text</p>
          </div>
        )}

        {sourceType === 'topic' && (
          <div className="podcast-source-config">
            <label className="podcast-key-label">Topics, categories &amp; folders</label>
            <TopicPicker
              bookmarks={bookmarks}
              selectedTopics={selectedTopics}
              onToggle={opt => setSelectedTopics(prev =>
                prev.some(t => t.id === opt.id) ? prev.filter(t => t.id !== opt.id) : [...prev, opt]
              )}
              onClear={() => setSelectedTopics([])}
            />
            <div className="podcast-count-row" style={{ marginTop: 12 }}>
              <label className="podcast-key-label" style={{ margin: 0 }}>Max bookmarks</label>
              <input type="range" min="5" max="30" value={count} onChange={e => setCount(+e.target.value)} className="podcast-count-slider"/>
              <input type="number" min="5" max="30" value={count} onChange={e => setCount(Math.min(30, Math.max(5, +e.target.value || 5)))} className="podcast-count-input"/>
            </div>
          </div>
        )}

        {sourceType === 'prompt' && (
          <div className="podcast-source-config">
            <label className="podcast-key-label">What do you want to hear?</label>
            <textarea
              className="podcast-prompt-textarea"
              placeholder="e.g. Make a digest of the most exciting AI launches this month…"
              value={customPrompt}
              onChange={e => setCustomPrompt(e.target.value)}
              rows={3}
              autoFocus
            />
            <div className="podcast-count-row" style={{ marginTop: 10 }}>
              <label className="podcast-key-label" style={{ margin: 0 }}>Max bookmarks to use</label>
              <input type="range" min="5" max="30" value={count} onChange={e => setCount(+e.target.value)} className="podcast-count-slider"/>
              <input type="number" min="5" max="30" value={count} onChange={e => setCount(Math.min(30, Math.max(5, +e.target.value || 5)))} className="podcast-count-input"/>
            </div>
          </div>
        )}

        {/* Voice */}
        <div className="podcast-section-label" style={{ marginTop: 20 }}>Voice</div>
        <div className="podcast-providers" style={{ marginBottom: 0 }}>
          {PROVIDERS.map(p => (
            <div
              key={p.id}
              className={`podcast-provider-card ${selectedProvider?.id === p.id ? 'selected' : ''}`}
              onClick={() => { setSelectedProvider(p); setSelectedVoice(''); }}
            >
              <div className="podcast-provider-icon">{p.icon}</div>
              <div className="podcast-provider-info">
                <div className="podcast-provider-name">{p.name}</div>
                <div className="podcast-provider-desc">{p.desc}</div>
              </div>
              {!p.needsKey && <span className="podcast-provider-badge">Free</span>}
            </div>
          ))}
        </div>

        {selectedProvider?.needsKey && (
          <div className="podcast-key-input-wrap">
            <label className="podcast-key-label">{selectedProvider.keyLabel}</label>
            <input
              className="podcast-key-input"
              type="password"
              placeholder={selectedProvider.placeholder}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
            />
            {selectedProvider.voices?.length > 0 && (
              <>
                <label className="podcast-key-label" style={{ marginTop: 10 }}>Voice</label>
                <select className="podcast-voice-select" value={selectedVoice} onChange={e => setSelectedVoice(e.target.value)}>
                  <option value="">Default</option>
                  {selectedProvider.voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </>
            )}
          </div>
        )}

        <button
          className="podcast-connect-btn"
          style={{ marginTop: 24 }}
          onClick={generate}
          disabled={
            (sourceType === 'topic' && selectedTopics.length === 0) ||
            (sourceType === 'prompt' && !customPrompt.trim()) ||
            (selectedProvider?.needsKey && !apiKey.trim() && !ttsConfig?.key)
          }
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 6 }}><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
          Generate &amp; Play Podcast
        </button>
      </div>
    </div>
  );
}
