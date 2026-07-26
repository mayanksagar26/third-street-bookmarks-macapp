#!/usr/bin/env python3
"""
Export bookmarks (or likes) from a birdclaw SQLite DB → bookmarks.json schema.

birdclaw (https://birdclaw.sh, by @steipete) stores everything in one tweets
table with `bookmarked` / `liked` flags rather than a dedicated bookmarks table.
Schema verified against birdclaw 0.6.0:

    tweets(id, account_id, author_profile_id, kind, text, created_at,
           is_replied, reply_to_id, like_count, media_count, bookmarked, liked,
           entities_json, media_json, quoted_tweet_id)
    profiles(id, handle, display_name, avatar_url, ...)
    tweet_collections(account_id, tweet_id, kind, collected_at, source, ...)

Usage:
    python3 birdclaw_export.py [out.json] [--kind bookmarks|likes]

Preserves isRead/favFolder/colorLabel/note from the existing out.json (birdclaw
has no equivalent of those UI fields, so the JSON is the system of record for
them). Tags every row with "source": "birdclaw".
"""

import json
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path.home() / ".birdclaw/birdclaw.sqlite"


def _arg(flag, default):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def _parse_json(val, default):
    if not val:
        return default
    try:
        return json.loads(val)
    except Exception:
        return default


def _extract_links(entities_json):
    """birdclaw stores X-style entities. Pull expanded URLs defensively —
    shape can be {urls:[{expanded_url|url}]} or a bare list of strings."""
    ent = _parse_json(entities_json, None)
    urls = []
    if isinstance(ent, dict):
        candidates = ent.get("urls") or ent.get("url_expansions") or []
        for u in candidates:
            if isinstance(u, str):
                urls.append(u)
            elif isinstance(u, dict):
                urls.append(u.get("expanded_url") or u.get("expanded") or u.get("url") or "")
    elif isinstance(ent, list):
        for u in ent:
            if isinstance(u, str):
                urls.append(u)
            elif isinstance(u, dict):
                urls.append(u.get("expanded_url") or u.get("url") or "")
    return [u for u in urls if u and u.startswith("http")]


def _domains(links):
    out = []
    for u in links:
        try:
            host = u.split("//", 1)[1].split("/", 1)[0].lstrip("www.")
            if host:
                out.append(host)
        except Exception:
            pass
    return out


def merge_rows(out_path, new_rows, source):
    """Union `new_rows` (this source's complete current set) into the existing
    bookmarks.json. Keeps rows owned by OTHER sources, drops this source's rows
    that are no longer bookmarked (un-bookmark), and lets new_rows win on overlap.
    Per-tweet user state is already carried on new_rows (set from the existing
    file before this call), so read/fav history is never reset."""
    existing = []
    try:
        existing = json.loads(out_path.read_text(encoding="utf-8"))
    except Exception:
        existing = []
    new_ids = {r["id"] for r in new_rows}
    kept = [
        b for b in existing
        if b.get("id") not in new_ids and (b.get("source") or "fieldtheory") != source
    ]
    return new_rows + kept


def load_custom_state(json_path):
    if json_path is None:
        return {}
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
        return {
            b["id"]: {
                "isRead":     b.get("isRead", False),
                "favFolder":  b.get("favFolder"),
                "colorLabel": b.get("colorLabel"),
                "note":       b.get("note"),
            }
            for b in data
        }
    except Exception:
        return {}


def _profile(cur, profile_id):
    if not profile_id:
        return {}
    row = cur.execute(
        "SELECT handle, display_name, avatar_url FROM profiles WHERE id = ?",
        (profile_id,),
    ).fetchone()
    return dict(row) if row else {}


def _quoted(cur, quoted_id):
    if not quoted_id:
        return None
    t = cur.execute(
        "SELECT id, text, author_profile_id FROM tweets WHERE id = ?",
        (quoted_id,),
    ).fetchone()
    if not t:
        return None
    p = _profile(cur, t["author_profile_id"])
    handle = p.get("handle")
    return {
        "id":                    t["id"],
        "text":                  t["text"],
        "authorHandle":          handle,
        "authorName":            p.get("display_name"),
        "authorProfileImageUrl": p.get("avatar_url"),
        "url":                   f"https://x.com/{handle}/status/{t['id']}" if handle else None,
        "media":                 [],
    }


def export(out_path, kind):
    flag_col      = "liked" if kind == "likes" else "bookmarked"
    collection_kw = "like%" if kind == "likes" else "bookmark%"

    custom = load_custom_state(out_path)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    rows = cur.execute(f"""
        SELECT t.*,
               (SELECT collected_at FROM tweet_collections c
                 WHERE c.tweet_id = t.id AND c.kind LIKE ?
                 ORDER BY c.collected_at DESC LIMIT 1) AS collected_at
        FROM tweets t
        WHERE t.{flag_col} = 1
        ORDER BY collected_at DESC, t.created_at DESC
    """, (collection_kw,)).fetchall()

    out = []
    for r in rows:
        r = dict(r)
        tid    = r["id"]
        prof   = _profile(cur, r.get("author_profile_id"))
        handle = prof.get("handle")
        links  = _extract_links(r.get("entities_json"))
        prev   = custom.get(tid, {})

        out.append({
            "id":                    tid,
            "tweetId":               tid,
            "url":                   f"https://x.com/{handle}/status/{tid}" if handle else None,
            "text":                  r.get("text"),
            "authorHandle":          handle,
            "authorName":            prof.get("display_name"),
            "authorProfileImageUrl": prof.get("avatar_url"),
            "postedAt":              r.get("created_at"),
            "bookmarkedAt":          r.get("collected_at") or r.get("created_at"),
            "categories":            [],
            "primaryCategory":       None,
            "domains":               _domains(links),
            "primaryDomain":         (_domains(links) or [None])[0],
            "githubUrls":            [u for u in links if "github.com" in u],
            "links":                 links,
            "mediaCount":            r.get("media_count"),
            "linkCount":             len(links),
            "likeCount":             r.get("like_count"),
            "repostCount":           None,
            "replyCount":            None,
            "quoteCount":            None,
            "bookmarkCount":         None,
            "viewCount":             None,
            "folderIds":             [],
            "folderNames":           [],
            "articleTitle":          None,
            "articleSite":           None,
            "syncedAt":              r.get("collected_at"),
            "quotedTweet":           _quoted(cur, r.get("quoted_tweet_id")),
            "source":                "birdclaw",
            # UI state lives only in JSON for birdclaw
            "isRead":     prev.get("isRead", False),
            "favFolder":  prev.get("favFolder"),
            "colorLabel": prev.get("colorLabel"),
            "note":       prev.get("note"),
        })

    conn.close()
    if out_path is None:                       # --stdout: emit JSON, write nothing
        print(json.dumps(out, ensure_ascii=False))
        return len(out)

    # Bookmarks merge into the existing file (append, never clobber other sources
    # or your read/fav history). `--replace` forces the old overwrite behaviour.
    if kind == "bookmarks" and "--replace" not in sys.argv:
        final = merge_rows(out_path, out, "birdclaw")
        out_path.write_text(json.dumps(final, indent=2, ensure_ascii=False), encoding="utf-8")
        kept = len(final) - len(out)
        print(f"  Merged {len(out)} birdclaw bookmarks (+{kept} kept from other sources = {len(final)}) → {out_path}")
        return len(final)

    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Exported {len(out)} {kind} from birdclaw → {out_path}")
    return len(out)


if __name__ == "__main__":
    if not DB_PATH.exists():
        print(f"  birdclaw DB not found: {DB_PATH} — run `birdclaw init` first")
        sys.exit(1)
    kind = _arg("--kind", "bookmarks")
    if "--stdout" in sys.argv:
        export(None, kind)
    else:
        positional = [a for a in sys.argv[1:] if not a.startswith("--") and a != kind]
        out = Path(positional[0]) if positional else Path(__file__).parent / "bookmarks.json"
        export(out, kind)
