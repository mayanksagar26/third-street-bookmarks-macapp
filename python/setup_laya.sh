#!/bin/bash
# Install Laya for the "Laya" classify engine, then train it on your labels.
#
#   ~/.tsb/laya-venv   Python 3.10+ virtualenv with `pip install laya` (torch,
#                      transformers — about 1 GB)
#   ~/.cache/huggingface  the convaiinnovations/laya checkpoint (about 1.7 GB),
#                      downloaded on first load
#   ~/.tsb/laya        dataset, embeddings and the trained head
#
# Laya needs Python 3.10 or newer; macOS ships 3.9. If no newer python3.x is on
# PATH, this puts `uv` in a small virtualenv of its own and has it fetch a
# standalone Python 3.12 into ~/.local/share/uv — no Homebrew, no sudo, and the
# system Python is left alone.
#
# Usage: setup_laya.sh [--json=/path/to/bookmarks.json]   (args go to training)
set -euo pipefail

TSB="$HOME/.tsb"
VENV="${TSB_LAYA_VENV:-$TSB/laya-venv}"
HERE="$(cd "$(dirname "$0")" && pwd)"

find_python() {
  for py in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$py" >/dev/null 2>&1 &&
       "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      command -v "$py"; return 0
    fi
  done
  return 1
}

if [ ! -x "$VENV/bin/python" ]; then
  if PY="$(find_python)"; then
    echo "  Using $PY"
    "$PY" -m venv "$VENV"
    "$VENV/bin/python" -m pip install -q --upgrade pip
    echo "  pip install laya (torch + transformers, about 1 GB)…"
    "$VENV/bin/python" -m pip install -q laya
  else
    echo "  No Python 3.10+ found — fetching one with uv…"
    python3 -m venv "$TSB/uv-bootstrap"
    "$TSB/uv-bootstrap/bin/pip" install -q uv
    UV="$TSB/uv-bootstrap/bin/uv"
    "$UV" python install 3.12
    "$UV" venv "$VENV" --python 3.12
    echo "  pip install laya (torch + transformers, about 1 GB)…"
    "$UV" pip install -q --python "$VENV/bin/python" laya
  fi
fi

"$VENV/bin/python" -I -c 'import laya; print("  laya", laya.__version__, "installed")'
echo "  Training on your labelled bookmarks (first run downloads the model)…"
"$VENV/bin/python" "$HERE/laya_classify.py" train "$@"
