#!/usr/bin/env python3
"""
Classify bookmarks with Laya, trained on the labels you already have.

Laya (`pip install laya`, https://huggingface.co/convaiinnovations/laya) is a
non-generative decision model: a ModernBERT encoder with a scoring head, one
forward pass per input, nothing to parse. Out of the box it is a poor fit for
this job — measured on 300 held-out bookmarks, asking it to choose among all 34
categories agreed with the existing labels 19% of the time, below the regex
rules (24%). Its README says as much: many options share one small token
budget, so each label gets a few tokens.

What does work is its encoder. Every bookmark that already carries a category
(from Field Theory's classifier, or an earlier Claude/Codex run) is a training
example: embed its text once, fit a linear layer from embedding to category,
and classify new bookmarks with the pair. On the same 300 held-out bookmarks:

    regex rules                     24%   instant
    Laya zero-shot (34-way choice)  19%   ~180 ms / bookmark
    Codex CLI, 20 per call          42%   ~1,070 ms / bookmark
    Laya encoder + trained head     42%   ~110 ms / bookmark, +5 s model load

"Agreement" is against labels an LLM produced, not ground truth; Codex scoring
the same 42% says the labels themselves are that noisy, not that both are bad.
The point is the right-hand column: Codex-level agreement, about ten times
faster, offline, and without spending a subscription on labelling.

Everything lives in ~/.tsb/laya/:

    dataset.jsonl    the training set — {id, text, category} per line, rebuilt
                     from your labelled bookmarks on every train
    embeddings.npz   encoder output per bookmark id, so a retrain only embeds
                     what is new
    head.pt          the trained layer, its label list, and held-out accuracy
    predicted.json   ids this script labelled — kept out of the training set,
                     so the model never learns from its own guesses

Runs under the Laya virtualenv (Python 3.10+; see setup_laya.sh), not the
system python3. classify.py hands off to it with --backend=laya.

Usage:
    laya_classify.py train                [--json=bookmarks.json]
    laya_classify.py classify [--ids-file=ids.txt] [--json=bookmarks.json]
    laya_classify.py status
"""

from __future__ import annotations

import json
import os
import random
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from classify import CATEGORIES, DB_PATH, read_ids_file  # noqa: E402

LAYA_DIR = Path(os.environ.get("TSB_LAYA_DIR", Path.home() / ".tsb/laya"))
DATASET = LAYA_DIR / "dataset.jsonl"
EMBEDDINGS = LAYA_DIR / "embeddings.npz"
HEAD = LAYA_DIR / "head.pt"
PREDICTED = LAYA_DIR / "predicted.json"

MODEL_ID = "convaiinnovations/laya"
MAX_TOKENS = 256        # a tweet is well under this; long articles are cut
MIN_PER_LABEL = 2       # a category seen once can't be learned, only memorised
RETRAIN_AFTER = 50      # new labelled bookmarks before classify retrains first
UNLABELLED = ("", "unclassified")


def log(msg: str):
    print(f"  {msg}", flush=True)


# ── Reading and writing labels ─────────────────────────────────────────────────

def load_rows(json_path: Path | None) -> list[dict]:
    """Every bookmark as {id, text, category}, from bookmarks.json or ft's DB."""
    if json_path is not None:
        data = json.loads(json_path.read_text(encoding="utf-8"))
        return [{"id": str(b.get("id")), "text": b.get("text") or "",
                 "category": b.get("primaryCategory") or ""} for b in data]
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute("SELECT id, text, primary_category FROM bookmarks").fetchall()
    conn.close()
    return [{"id": str(r[0]), "text": r[1] or "", "category": r[2] or ""} for r in rows]


def save_labels(json_path: Path | None, labels: dict[str, str]):
    if json_path is not None:
        data = json.loads(json_path.read_text(encoding="utf-8"))
        for b in data:
            cat = labels.get(str(b.get("id")))
            if cat:
                b["primaryCategory"] = cat
                b["categories"] = [cat]
        json_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        return
    conn = sqlite3.connect(str(DB_PATH))
    conn.executemany(
        "UPDATE bookmarks SET primary_category = ?, categories = ? WHERE id = ?",
        [(c, c, i) for i, c in labels.items()],
    )
    conn.commit()
    conn.close()


def predicted_ids() -> set:
    try:
        return set(json.loads(PREDICTED.read_text()))
    except (OSError, ValueError):
        return set()


def build_dataset(rows: list[dict]) -> list[dict]:
    """Labelled bookmarks worth learning from, written to dataset.jsonl.

    Leaves out rows with no text, labels outside CATEGORIES (old ones like
    "resource" that the app no longer offers), labels this script produced, and
    categories too rare to generalise from.
    """
    mine = predicted_ids()
    usable = [r for r in rows
              if r["category"] in CATEGORIES and r["text"].strip() and r["id"] not in mine]
    counts: dict[str, int] = {}
    for r in usable:
        counts[r["category"]] = counts.get(r["category"], 0) + 1
    dataset = [r for r in usable if counts[r["category"]] >= MIN_PER_LABEL]

    LAYA_DIR.mkdir(parents=True, exist_ok=True)
    with DATASET.open("w", encoding="utf-8") as f:
        for r in dataset:
            f.write(json.dumps({"id": r["id"], "text": r["text"], "category": r["category"]},
                               ensure_ascii=False) + "\n")
    return dataset


# ── Laya ───────────────────────────────────────────────────────────────────────

class Encoder:
    """Laya's encoder, loaded once, with an on-disk cache keyed by bookmark id."""

    def __init__(self):
        import numpy as np
        import torch
        import laya
        from laya.shortlist import embed_fn_from_agent

        self.np = np
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        t0 = time.time()
        agent = laya.load(MODEL_ID, device=device)
        log(f"Laya loaded on {device} in {time.time() - t0:.1f}s")
        self.embed_fn = embed_fn_from_agent(agent, max_length=MAX_TOKENS, batch_size=32)
        self.cache: dict = {}
        if EMBEDDINGS.exists():
            z = np.load(EMBEDDINGS)
            self.cache = dict(zip(z["ids"].tolist(), z["vecs"]))

    def embed(self, rows: list[dict]):
        missing = [r for r in rows if r["id"] not in self.cache]
        if missing:
            log(f"Embedding {len(missing)} bookmark{'s' if len(missing) != 1 else ''}…")
            t0 = time.time()
            for i in range(0, len(missing), 256):
                chunk = missing[i:i + 256]
                vecs = self.embed_fn([r["text"] for r in chunk])
                for r, v in zip(chunk, vecs):
                    self.cache[r["id"]] = v
                log(f"Embedded: {min(i + 256, len(missing))}/{len(missing)}")
            log(f"{(time.time() - t0) * 1000 / len(missing):.0f} ms per bookmark")
            self.save()
        return self.np.stack([self.cache[r["id"]] for r in rows])

    def save(self):
        ids = list(self.cache)
        self.np.savez(EMBEDDINGS, ids=self.np.array(ids), vecs=self.np.stack([self.cache[i] for i in ids]))


def fit(X, y, n_labels: int, epochs: int = 300):
    """Standardise, then one linear layer — full-batch, a fraction of a second.

    Tried against k-nearest-neighbours (38%) and a shortlist-then-Laya-choice
    hybrid (27%); the plain linear layer beat both.
    """
    import torch

    mu, sd = X.mean(0), X.std(0) + 1e-6
    A = torch.tensor((X - mu) / sd, dtype=torch.float32)
    t = torch.tensor(y)
    torch.manual_seed(0)
    layer = torch.nn.Linear(A.shape[1], n_labels)
    opt = torch.optim.AdamW(layer.parameters(), lr=1e-3, weight_decay=1e-2)
    for _ in range(epochs):
        opt.zero_grad()
        torch.nn.functional.cross_entropy(layer(A), t).backward()
        opt.step()
    return layer, mu, sd


def train(json_path: Path | None, enc: Encoder | None = None) -> dict:
    import numpy as np
    import torch

    rows = load_rows(json_path)
    dataset = build_dataset(rows)
    if len(dataset) < 50:
        raise SystemExit(f"Only {len(dataset)} labelled bookmarks — too few to train on. "
                         "Classify some with Claude or Codex first.")
    labels = sorted({r["category"] for r in dataset})
    li = {c: i for i, c in enumerate(labels)}
    log(f"Training on {len(dataset)} labelled bookmarks across {len(labels)} categories "
        f"(dataset: {DATASET})")

    enc = enc or Encoder()
    X = enc.embed(dataset)
    y = np.array([li[r["category"]] for r in dataset])

    # Held-out check first, so the number shown in the app is honest, then the
    # real model on everything.
    order = list(range(len(dataset)))
    random.Random(0).shuffle(order)
    cut = max(1, len(order) // 10)
    test, rest = order[:cut], order[cut:]
    layer, mu, sd = fit(X[rest], y[rest], len(labels))
    with torch.no_grad():
        pred = layer(torch.tensor((X[test] - mu) / sd, dtype=torch.float32)).argmax(-1).numpy()
    accuracy = float((pred == y[test]).mean())
    log(f"Held-out agreement with your labels: {accuracy:.0%} ({len(test)} bookmarks)")

    layer, mu, sd = fit(X, y, len(labels))
    meta = {"labels": labels, "trained_on": len(dataset), "accuracy": accuracy,
            "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "model": MODEL_ID}
    torch.save({"state": layer.state_dict(), "mu": torch.tensor(mu), "sd": torch.tensor(sd), **meta}, HEAD)
    log("Saved.")
    return meta


def load_head():
    import torch
    if not HEAD.exists():
        return None
    return torch.load(HEAD, weights_only=False)


def classify(json_path: Path | None, only_ids: set | None):
    import torch

    rows = load_rows(json_path)
    todo = [r for r in rows
            if r["category"] in UNLABELLED and (only_ids is None or r["id"] in only_ids)]
    if not todo:
        log("Nothing new to classify." if only_ids is not None else "Nothing to classify.")
        return

    enc = Encoder()
    head = load_head()
    labelled = sum(1 for r in rows if r["category"] in CATEGORIES)
    if head is None or labelled - head["trained_on"] >= RETRAIN_AFTER:
        log("No trained model yet — training first." if head is None
            else f"{labelled - head['trained_on']} new labels since last training — retraining.")
        train(json_path, enc)
        head = load_head()

    scope = "new " if only_ids is not None else ""
    log(f"Classifying {len(todo)} {scope}bookmarks using Laya "
        f"(trained on {head['trained_on']}, {head['accuracy']:.0%} held-out agreement)...")
    labels = head["labels"]
    layer = torch.nn.Linear(len(head["mu"]), len(labels))
    layer.load_state_dict(head["state"])

    t0 = time.time()
    with_text = [r for r in todo if r["text"].strip()]
    out = {r["id"]: "misc" for r in todo if not r["text"].strip()}
    if with_text:
        X = enc.embed(with_text)
        with torch.no_grad():
            pred = layer(((torch.tensor(X) - head["mu"]) / head["sd"]).float()).argmax(-1).tolist()
        out.update({r["id"]: labels[p] for r, p in zip(with_text, pred)})
    save_labels(json_path, out)
    PREDICTED.write_text(json.dumps(sorted(predicted_ids() | set(out))))
    log(f"Categories: {len(out)}/{len(todo)} (100%)")
    log(f"Done. {len(out)} {scope}bookmarks classified in {time.time() - t0:.1f}s.")


def status():
    head = error = None
    try:
        head = load_head()
    except Exception as e:  # a corrupt or incompatible head.pt: retrain fixes it
        error = f"{type(e).__name__}: {e}"
    print(json.dumps({
        "error": error,
        "installed": True,
        "trained": head is not None,
        "trainedOn": head["trained_on"] if head else 0,
        "accuracy": head["accuracy"] if head else None,
        "trainedAt": head["trained_at"] if head else None,
        "dataset": str(DATASET),
    }))


def main():
    args = sys.argv[1:]
    cmd = args[0] if args and not args[0].startswith("--") else "classify"
    json_path = only_ids = None
    for arg in args:
        if arg.startswith("--json="):
            json_path = Path(arg.split("=", 1)[1])
        elif arg.startswith("--ids-file="):
            only_ids = read_ids_file(Path(arg.split("=", 1)[1]))
    if cmd == "train":
        train(json_path)
    elif cmd == "status":
        status()
    else:
        classify(json_path, only_ids)


if __name__ == "__main__":
    main()
