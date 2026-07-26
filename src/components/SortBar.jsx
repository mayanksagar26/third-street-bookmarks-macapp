const SORTS = [
  { key: 'newest',    label: 'Newest' },
  { key: 'oldest',    label: 'Oldest' },
  { key: 'likes',     label: 'Most Liked' },
  { key: 'bookmarks', label: 'Most Bookmarked' },
  { key: 'reposts',   label: 'Most Reposted' },
  { key: 'author',    label: 'By Author' },
];

export default function SortBar({ currentSort, onSort }) {
  return (
    <div className="sort-bar">
      {SORTS.map(s => (
        <button
          key={s.key}
          className={`sort-btn ${currentSort === s.key ? 'active' : ''}`}
          onClick={() => onSort(s.key)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
