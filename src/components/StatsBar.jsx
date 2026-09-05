function fmt(n) { return Number(n || 0).toLocaleString(); }

export default function StatsBar({ bookmarks }) {
  const authors = new Set(bookmarks.map(b => b.authorHandle).filter(Boolean)).size;
  const dates = bookmarks.map(b => b.postedAt).filter(Boolean).map(d => new Date(d).getFullYear()).filter(y => !isNaN(y));
  const years = dates.length ? Math.max(...dates) - Math.min(...dates) + 1 : 0;
  const cats = new Set(bookmarks.map(b => b.primaryCategory).filter(c => c && c !== 'unclassified')).size;

  return (
    <div className="stats-bar">
      <div className="stat-item">
        <div className="stat-value">{fmt(bookmarks.length)}</div>
        <div className="stat-label">Bookmarks</div>
      </div>
      <div className="stat-item">
        <div className="stat-value">{fmt(authors)}</div>
        <div className="stat-label">Voices</div>
      </div>
      <div className="stat-item">
        <div className="stat-value">{years}</div>
        <div className="stat-label">Years</div>
      </div>
      <div className="stat-item">
        <div className="stat-value">{cats}</div>
        <div className="stat-label">Categories</div>
      </div>
    </div>
  );
}
