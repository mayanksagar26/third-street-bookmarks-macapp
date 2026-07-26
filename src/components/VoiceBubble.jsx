import { useEffect, useRef } from 'react';

export default function VoiceBubble({ isPlaying, currentText, onPlayPause, onSkip, onClose }) {
  const bars = 12;

  return (
    <div className={`voice-bubble ${isPlaying ? 'playing' : ''}`}>
      <button className="voice-bubble-close" onClick={onClose}>✕</button>

      <div className="voice-orb-wrap">
        <div className={`voice-orb ${isPlaying ? 'active' : ''}`}>
          <div className="voice-orb-inner" />
          <div className="voice-orb-ring" />
          <div className="voice-orb-ring ring2" />
        </div>
        {isPlaying && (
          <div className="voice-waveform">
            {Array.from({ length: bars }).map((_, i) => (
              <div key={i} className="voice-bar" style={{ animationDelay: `${(i * 0.08).toFixed(2)}s` }} />
            ))}
          </div>
        )}
      </div>

      <div className="voice-bubble-label">
        {isPlaying ? 'Now reading' : 'Paused'}
      </div>
      <div className="voice-bubble-text">{(currentText || '').slice(0, 80)}{currentText?.length > 80 ? '…' : ''}</div>

      <div className="voice-controls">
        <button className="voice-ctrl-btn" onClick={onPlayPause}>
          {isPlaying
            ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          }
        </button>
        <button className="voice-ctrl-btn" onClick={onSkip}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
        </button>
      </div>
    </div>
  );
}
