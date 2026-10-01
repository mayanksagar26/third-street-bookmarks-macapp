// ─────────────────────────────────────────────────────────────────────────────
// Favourite-folder membership writes, against state.db's fav_membership table.
//
// `created_at` on a row is when that bookmark was favourited into that folder,
// and the earliest of a bookmark's rows is when it became a favourite. Both
// writes here keep it that way: refiling a bookmark or renaming a folder must
// not make an old favourite look new. Only a membership that didn't exist
// before gets `now`.
//
// Kept out of index.js so it can be tested against a real SQLite handle
// without starting the server.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace a bookmark's folder set with `folders`.
 *
 * Folders it is already in keep their date. A folder it is newly filed into
 * gets the bookmark's earliest existing date if it has one, so moving a
 * favourite from one folder to another doesn't restart its clock; a bookmark
 * that wasn't a favourite at all gets `now`.
 */
function setFolders(conn, id, folders, now = new Date().toISOString()) {
  const clean = [...new Set((folders || []).map(f => String(f).trim()).filter(Boolean))];
  const tx = conn.transaction(() => {
    const before = new Map(
      conn.prepare('SELECT folder, created_at FROM fav_membership WHERE id = ?').all(id)
        .map(r => [r.folder, r.created_at]),
    );
    const dates = [...before.values()].filter(Boolean).sort();
    const firstFavourited = dates[0] || now;
    conn.prepare('DELETE FROM fav_membership WHERE id = ?').run(id);
    const ins = conn.prepare('INSERT OR IGNORE INTO fav_membership (id, folder, created_at) VALUES (?, ?, ?)');
    for (const f of clean) ins.run(id, f, before.get(f) || firstFavourited);
  });
  tx();
  return clean;
}

/**
 * Rename a folder everywhere, merging into `to` if it already exists.
 * Each moved membership keeps its date; where a bookmark was already in
 * `to`, the earlier of the two dates wins.
 */
function renameFolder(conn, from, to) {
  const tx = conn.transaction(() => {
    const rows = conn.prepare('SELECT id, created_at FROM fav_membership WHERE folder = ?').all(from);
    const existing = conn.prepare('SELECT created_at FROM fav_membership WHERE id = ? AND folder = ?');
    const upsert = conn.prepare('INSERT OR REPLACE INTO fav_membership (id, folder, created_at) VALUES (?, ?, ?)');
    for (const r of rows) {
      const there = existing.get(r.id, to)?.created_at;
      const keep = [there, r.created_at].filter(Boolean).sort()[0] || null;
      upsert.run(r.id, to, keep);
    }
    conn.prepare('DELETE FROM fav_membership WHERE folder = ?').run(from);
  });
  tx();
}

module.exports = { setFolders, renameFolder };
