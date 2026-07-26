#!/usr/bin/env python3
"""
Export bookmarks from SQLite → bookmarks.json.
Preserves custom fields (isRead, favFolder, colorLabel, note) from existing JSON.
Usage: python3 export.py [path/to/bookmarks.json]
"""

import json
import sqlite3
import sys
from pathlib import Path

DB_PATH   = Path.home() / ".ft-bookmarks/bookmarks.db"
JSON_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "bookmarks.json"


def _parse_json(val, default):
    if not val:
        return default
    try:
        return json.loads(val)
    except Exception:
        return default


def _split_csv(val):
    if not val:
        return []
    return [v.strip() for v in val.split(",") if v.strip()]


def merge_rows(json_path, new_rows, source):
    """Union `new_rows` (this source's complete current set) into the existing
    bookmarks.json: keep rows owned by other sources, drop this source's stale
    (un-bookmarked) rows, let new_rows win on overlap. User state already lives
    on new_rows, so read/fav history is preserved."""
    try:
        existing = json.loads(json_path.read_text(encoding="utf-8"))
    except Exception:
        existing = []
    new_ids = {r["id"] for r in new_rows}
    kept = [
        b for b in existing
        if b.get("id") not in new_ids and (b.get("source") or "fieldtheory") != source
    ]
    return new_rows + kept


def load_custom_state(json_path):
    """Load fields that live only in bookmarks.json, not in SQLite."""
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


def export(db_path, json_path):
    custom = load_custom_state(json_path)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    try:
        cur.execute("""
            SELECT b.*, COALESCE(s.is_read, 0) AS is_read, s.fav_folder,
                   s.color_label AS db_color_label
            FROM bookmarks b
            LEFT JOIN bookmark_ui_state s ON b.id = s.id
            ORDER BY b.synced_at DESC
        """)
    except sqlite3.OperationalError:
        # Fallback if schema doesn't have all columns yet
        try:
            cur.execute("""
                SELECT b.*, COALESCE(s.is_read, 0) AS is_read, s.fav_folder,
                       NULL AS db_color_label
                FROM bookmarks b
                LEFT JOIN bookmark_ui_state s ON b.id = s.id
                ORDER BY b.synced_at DESC
            """)
        except sqlite3.OperationalError:
            cur.execute("SELECT * FROM bookmarks ORDER BY synced_at DESC")

    rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    out = []
    for r in rows:
        bm_id = r["id"]
        prev  = custom.get(bm_id, {})

        out.append({
            "id":                    bm_id,
            "tweetId":               r.get("tweet_id"),
            "url":                   r.get("url"),
            "text":                  r.get("text"),
            "authorHandle":          r.get("author_handle"),
            "authorName":            r.get("author_name"),
            "authorProfileImageUrl": r.get("author_profile_image_url"),
            "postedAt":              r.get("posted_at"),
            "bookmarkedAt":          r.get("bookmarked_at"),
            "categories":            _split_csv(r.get("categories")),
            "primaryCategory":       r.get("primary_category"),
            "domains":               _split_csv(r.get("domains")),
            "primaryDomain":         r.get("primary_domain"),
            "githubUrls":            _parse_json(r.get("github_urls"), []),
            "links":                 _parse_json(r.get("links_json"), []),
            "mediaCount":            r.get("media_count"),
            "linkCount":             r.get("link_count"),
            "likeCount":             r.get("like_count"),
            "repostCount":           r.get("repost_count"),
            "replyCount":            r.get("reply_count"),
            "quoteCount":            r.get("quote_count"),
            "bookmarkCount":         r.get("bookmark_count"),
            "viewCount":             r.get("view_count"),
            "folderIds":             _parse_json(r.get("folder_ids"), []),
            "folderNames":           _parse_json(r.get("folder_names"), []),
            "articleTitle":          r.get("article_title"),
            "articleSite":           r.get("article_site"),
            "syncedAt":              r.get("synced_at"),
            "quotedTweet":           _parse_json(r.get("quoted_tweet_json"), None),
            "source":                "fieldtheory",
            # Custom fields — SQLite is primary, JSON fills gaps, note is JSON-only
            "isRead":      prev.get("isRead")      or bool(r.get("is_read")),
            "favFolder":   prev.get("favFolder")   or r.get("fav_folder"),
            "colorLabel":  r.get("db_color_label") or prev.get("colorLabel"),
            "note":        prev.get("note"),
        })

    # Merge into the existing file by default so a Field Theory sync keeps rows
    # from other sources (e.g. birdclaw) and never resets your read/fav history.
    if "--replace" not in sys.argv:
        final = merge_rows(json_path, out, "fieldtheory")
        json_path.write_text(json.dumps(final, indent=2, ensure_ascii=False), encoding="utf-8")
        kept = len(final) - len(out)
        print(f"  Merged {len(out)} Field Theory bookmarks (+{kept} kept from other sources = {len(final)}) → {json_path}")
        return len(final)

    json_path.write_text(
        json.dumps(out, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"  Exported {len(out)} bookmarks → {json_path}")
    return len(out)


if __name__ == "__main__":
    if not DB_PATH.exists():
        print(f"  DB not found: {DB_PATH}")
        sys.exit(1)
    export(DB_PATH, JSON_PATH)
