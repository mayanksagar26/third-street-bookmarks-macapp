import { sortsForSources } from '../bookmark-sources';

// Only the sorts that mean something for what is on screen.
//
// Every source used to get X's six, so a Hacker News view offered "Most
// Reposted" and an Instagram one offered "Most Bookmarked" — controls that
// re-order nothing because every row reports zero. A control that appears to be
// broken is worse than one that isn't there.

export default function SortBar({ currentSort, onSort, sourceIds = [] }) {
  const sorts = sortsForSources(sourceIds);

  return (
    <div className="sort-bar">
      {sorts.map(s => (
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
