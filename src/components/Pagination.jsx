function fmt(n) { return Number(n || 0).toLocaleString(); }

export default function Pagination({ total, currentPage, pageSize, onPageChange }) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  const pages = [];
  pages.push(1);
  if (currentPage > 3) pages.push('...');
  for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) pages.push(i);
  if (currentPage < totalPages - 2) pages.push('...');
  if (totalPages > 1) pages.push(totalPages);

  function go(p) {
    if (p < 1 || p > totalPages) return;
    onPageChange(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="pagination">
      <button className="page-btn" onClick={() => go(currentPage - 1)} disabled={currentPage === 1}>←</button>
      {pages.map((p, i) =>
        p === '...'
          ? <span key={`ellipsis-${i}`} className="page-info">…</span>
          : <button key={p} className={`page-btn ${p === currentPage ? 'active' : ''}`} onClick={() => go(p)}>{p}</button>
      )}
      <button className="page-btn" onClick={() => go(currentPage + 1)} disabled={currentPage === totalPages}>→</button>
      <span className="page-info">
        &nbsp;{fmt((currentPage - 1) * pageSize + 1)}–{fmt(Math.min(currentPage * pageSize, total))} of {fmt(total)}
      </span>
    </div>
  );
}
