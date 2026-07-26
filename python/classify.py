#!/usr/bin/env python3
"""
Classify unclassified bookmarks in the SQLite DB.

If OPENAI_API_KEY is set: uses GPT-4o-mini via the openai package.
Otherwise: falls back to keyword/regex rules (fast, free, offline).

Usage:
    python3 classify.py
    OPENAI_API_KEY=sk-... python3 classify.py
"""

import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

DB_PATH = Path.home() / ".ft-bookmarks/bookmarks.db"

# ── Categories & keyword rules ─────────────────────────────────────────────────

CATEGORIES = [
    "ai-news", "tool", "technique", "launch", "startup", "research",
    "career", "opinion", "education", "finance", "security", "health",
    "design", "productivity", "culture", "personal-story", "humor",
    "media", "business", "commerce", "demo", "entertainment", "travel",
    "sports", "books", "food", "history", "self-improvement", "community",
    "leadership", "marketing", "policy", "science", "misc",
]

# Ordered: first match wins
KEYWORD_RULES = [
    ("ai-news",        r"\b(gpt|llm|openai|anthropic|gemini|claude|mistral|llama|deepseek|ai model|language model|foundation model|chatgpt|copilot|o1|o3)\b"),
    ("security",       r"\b(hack|exploit|vulnerability|cve|malware|phishing|ransomware|breach|zero.?day|security|pentest|infosec|cybersec)\b"),
    ("finance",        r"\b(stock|invest|market|fund|crypto|bitcoin|eth|defi|nft|vc|valuation|ipo|startup funding|revenue|profit|loss|balance sheet|equity|bond|etf)\b"),
    ("health",         r"\b(health|mental health|sleep|diet|nutrition|exercise|fitness|medicine|therapy|anxiety|depression|longevity|wellness)\b"),
    ("research",       r"\b(paper|arxiv|study|findings|dataset|benchmark|experiment|ablation|sota|state.of.the.art|published|journal|conference|acm|nips|icml|iclr)\b"),
    ("technique",      r"\b(tutorial|how.?to|guide|implement|algorithm|architecture|pattern|best practice|tips|trick|approach|method|technique|walkthrough|step.by.step)\b"),
    ("tool",           r"\b(tool|library|framework|sdk|api|cli|plugin|extension|package|repo|github|open.?source|release|v\d+\.\d+)\b"),
    ("launch",         r"\b(launch|ship|shipped|announcing|we.?built|introducing|new product|beta|waitlist|sign up|product hunt|just launched|going live)\b"),
    ("startup",        r"\b(startup|founder|yc|y combinator|seed|series [a-d]|pivot|pmf|product.market fit|runway|burn rate|churn|mrr|arr)\b"),
    ("career",         r"\b(job|hire|hiring|interview|resume|salary|negotiat|promotion|career|layoff|fired|offer|recruiter|linkedin|work.?life|remote work)\b"),
    ("design",         r"\b(design|ui|ux|figma|typography|color|layout|spacing|component|visual|interaction|prototype|wireframe|css|tailwind)\b"),
    ("productivity",   r"\b(productivity|focus|habit|routine|workflow|time management|pkm|obsidian|notion|second brain|inbox zero|deep work|pomodoro)\b"),
    ("education",      r"\b(learn|course|book|read|resource|curriculum|lesson|explain|understand|concept|primer|intro|beginner|fundamentals)\b"),
    ("opinion",        r"\b(think|believe|opinion|take|hot take|unpopular opinion|disagree|perspective|view|rant|thread|thoughts on|my take)\b"),
    ("personal-story", r"\b(my story|i built|i learned|i made|i quit|personal|journey|experience|failed|burnout|struggle|proud|milestone)\b"),
    ("humor",          r"\b(lol|lmao|funny|joke|meme|😂|🤣|humor|satire|parody|irony|sarcasm)\b"),
    ("business",       r"\b(business|b2b|saas|enterprise|customer|sales|growth|gtm|go.to.market|monetize|pricing|retention)\b"),
    ("marketing",      r"\b(marketing|seo|content|brand|audience|viral|growth hack|funnel|conversion|ad |ads |campaign|copywriting)\b"),
    ("culture",        r"\b(culture|society|social|community|diversity|inclusion|ethics|philosophy|psychology|human|mindset|values)\b"),
    ("science",        r"\b(science|physics|biology|chemistry|neuroscience|climate|space|quantum|mathematics|statistics|proof|theorem)\b"),
    ("policy",         r"\b(regulation|law|policy|government|congress|senate|eu|gdpr|antitrust|legislation|compliance|legal)\b"),
    ("entertainment",  r"\b(movie|show|series|netflix|youtube|podcast|music|game|gaming|sport|nba|nfl|film|tv|streaming)\b"),
    ("travel",         r"\b(travel|trip|city|country|visa|nomad|remote work abroad|destination|flight|hotel|explore)\b"),
    ("sports",         r"\b(nba|nfl|nhl|mlb|soccer|football|basketball|tennis|cricket|olympics|athlete|championship|match|score)\b"),
    ("food",           r"\b(food|recipe|cook|restaurant|eat|meal|nutrition|vegan|keto|coffee|wine|taste)\b"),
    ("history",        r"\b(history|historical|century|war|empire|ancient|decade|era|past|revolution|timeline)\b"),
    ("self-improvement",r"\b(self.improvement|self.help|confidence|motivation|discipline|goals|mindfulness|meditation|stoic|growth mindset)\b"),
    ("books",          r"\b(book|reading list|recommend|review|author|chapter|novel|nonfiction|biography|memoir)\b"),
    ("demo",           r"\b(demo|video|watch|showing|live|screen.?shot|gif|walkthrough|preview|built this|see it in action)\b"),
    ("commerce",       r"\b(ecommerce|shopify|amazon|marketplace|seller|buy|sell|checkout|payment|stripe|cart)\b"),
    ("leadership",     r"\b(leadership|management|team|ceo|executive|founder|cto|manager|culture|hire|delegate|decision)\b"),
]

COMPILED_RULES = [(cat, re.compile(pat, re.IGNORECASE)) for cat, pat in KEYWORD_RULES]


def classify_regex(text: str) -> str:
    for cat, pattern in COMPILED_RULES:
        if pattern.search(text):
            return cat
    return "misc"


# ── OpenAI classifier ──────────────────────────────────────────────────────────

SYSTEM_PROMPT = f"""You classify tweets/bookmarks into exactly one category.

Categories: {', '.join(CATEGORIES)}

Rules:
- Return ONLY a JSON array of category strings, one per tweet, in input order.
- Pick the most specific category that fits.
- Use "misc" only when nothing else fits.
- No explanations, no extra text."""


def classify_cli(tweets: list[dict], backend: str) -> list[str]:
    """Classify using local claude or codex CLI."""
    extra_path = '/usr/local/bin:/opt/homebrew/bin:' + str(Path.home() / '.local/bin') + ':' + str(Path.home() / '.npm-global/bin')
    env = {**os.environ, 'PATH': os.environ.get('PATH', '') + ':' + extra_path}

    lines = "\n".join(f"{i+1}. {t['text'][:300]}" for i, t in enumerate(tweets))
    prompt = f"""{SYSTEM_PROMPT}

Tweets:
{lines}"""

    if backend == 'codex':
        cmd = ['codex', '--full-auto', '-q', prompt]
    else:
        cmd = ['claude', '-p', prompt]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=120)
        raw = result.stdout.strip()
        raw = re.sub(r'^```[a-z]*\n?', '', raw).rstrip('`').strip()
        cats = json.loads(raw)
        return [c if c in CATEGORIES else 'misc' for c in cats]
    except Exception as e:
        print(f"  CLI classify failed ({e}), falling back to regex", flush=True)
        return [classify_regex(t['text']) for t in tweets]


def classify_openai(tweets: list[dict]) -> list[str]:
    import openai  # already installed

    client = openai.OpenAI()
    lines = "\n".join(f"{i+1}. {t['text'][:300]}" for i, t in enumerate(tweets))
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": lines},
        ],
        temperature=0,
    )
    raw = resp.choices[0].message.content.strip()
    # Strip markdown code fences if present
    raw = re.sub(r"^```[a-z]*\n?", "", raw).rstrip("`").strip()
    result = json.loads(raw)
    # Validate each returned category
    return [r if r in CATEGORIES else "misc" for r in result]


# ── DB helpers ─────────────────────────────────────────────────────────────────

def fetch_unclassified(conn: sqlite3.Connection) -> list[dict]:
    cur = conn.cursor()
    cur.execute("""
        SELECT id, text, author_handle
        FROM bookmarks
        WHERE primary_category IS NULL
           OR primary_category = ''
           OR primary_category = 'unclassified'
    """)
    return [{"id": r[0], "text": (r[1] or ""), "author": (r[2] or "")} for r in cur.fetchall()]


def save_category(conn: sqlite3.Connection, tweet_id: str, category: str):
    conn.execute(
        "UPDATE bookmarks SET primary_category = ?, categories = ? WHERE id = ?",
        (category, category, tweet_id),
    )


# ── JSON mode (source-agnostic: classifies a bookmarks.json in place) ──────────

def classify_json_file(path: Path, backend: str):
    """Classify unclassified rows in a bookmarks.json directly, no SQLite.
    Used by sources (e.g. birdclaw) that export JSON rather than ft's DB."""
    data = json.loads(path.read_text(encoding="utf-8"))
    todo = [
        b for b in data
        if not b.get("primaryCategory") or b.get("primaryCategory") in ("", "unclassified")
    ]
    if not todo:
        print("  Nothing to classify.")
        return

    use_llm = backend in ("openai", "claude", "codex")
    mode = {"openai": "openai/gpt-4o-mini", "claude": "claude CLI", "codex": "codex CLI"}.get(backend, "regex (offline)")
    print(f"  Classifying {len(todo)} bookmarks using {mode}...")

    batch_size = 20 if use_llm else len(todo)
    for i in range(0, len(todo), batch_size):
        batch = [{"text": b.get("text", "")} for b in todo[i : i + batch_size]]
        try:
            if backend == "openai":
                cats = classify_openai(batch)
            elif backend in ("claude", "codex"):
                cats = classify_cli(batch, backend)
            else:
                cats = [classify_regex(t["text"]) for t in batch]
        except Exception as e:
            print(f"  Warning: batch failed ({e}), falling back to regex")
            cats = [classify_regex(t["text"]) for t in batch]

        for b, cat in zip(todo[i : i + batch_size], cats):
            b["primaryCategory"] = cat
            b["categories"] = [cat]
        print(f"  Categories: {min(i + batch_size, len(todo))}/{len(todo)}", flush=True)

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Done. {len(todo)} bookmarks classified.")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    # Backend selection: --backend=claude|codex|openai|regex
    backend = 'regex'
    json_path = None
    for arg in sys.argv[1:]:
        if arg.startswith('--backend='):
            backend = arg.split('=', 1)[1]
        elif arg.startswith('--json='):
            json_path = Path(arg.split('=', 1)[1])

    if backend == 'regex':
        if os.environ.get("OPENAI_API_KEY"):
            backend = 'openai'
        elif os.environ.get("USE_CLAUDE_CLI"):
            backend = 'claude'
        elif os.environ.get("USE_CODEX_CLI"):
            backend = 'codex'

    # JSON mode short-circuits the SQLite path entirely.
    if json_path is not None:
        classify_json_file(json_path, backend)
        return

    use_llm = backend in ('openai', 'claude', 'codex')
    mode = {'openai': 'openai/gpt-4o-mini', 'claude': 'claude CLI', 'codex': 'codex CLI'}.get(backend, 'regex (offline)')

    conn = sqlite3.connect(str(DB_PATH))
    tweets = fetch_unclassified(conn)

    if not tweets:
        print("  Nothing to classify.")
        conn.close()
        return

    print(f"  Classifying {len(tweets)} bookmarks using {mode}...")

    batch_size = 20 if use_llm else len(tweets)
    done = 0

    for i in range(0, len(tweets), batch_size):
        batch = tweets[i : i + batch_size]
        try:
            if backend == 'openai':
                categories = classify_openai(batch)
            elif backend in ('claude', 'codex'):
                categories = classify_cli(batch, backend)
            else:
                categories = [classify_regex(t["text"]) for t in batch]
        except Exception as e:
            print(f"  Warning: batch failed ({e}), falling back to regex")
            categories = [classify_regex(t["text"]) for t in batch]

        for tweet, cat in zip(batch, categories):
            save_category(conn, tweet["id"], cat)

        done += len(batch)
        print(f"  Categories: {done}/{len(tweets)} ({done*100//len(tweets)}%)", flush=True)

    conn.commit()
    conn.close()
    print(f"  Done. {len(tweets)} bookmarks classified.")


if __name__ == "__main__":
    main()
