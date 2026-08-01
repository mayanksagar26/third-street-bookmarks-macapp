#!/usr/bin/env bash
# Render background.html to the PNG the DMG bundler ships.
#
# The background is authored as HTML because it has to stay in step with the
# app's own theme — same gradient, same rim, same accent — and keeping it as a
# binary blob means it silently drifts. This turns it back into a picture.
#
# Chrome ships on nearly every Mac and is the only headless renderer we can
# assume; there is no build-time dependency on it, since the PNG is committed.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

chrome=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
do
  [[ -x "$candidate" ]] && { chrome="$candidate"; break; }
done

if [[ -z "$chrome" ]]; then
  echo "No Chrome-family browser found. Install Chrome, or open" >&2
  echo "  $here/background.html" >&2
  echo "and export a 1320x520 screenshot of the .dmg element to background@2x.png." >&2
  exit 1
fi

# 2x device scale over a 660x260 layout gives the 1320x520 image Finder wants
# for the HiDPI representation.
"$chrome" \
  --headless \
  --disable-gpu \
  --hide-scrollbars \
  --default-background-color=00000000 \
  --force-device-scale-factor=2 \
  --window-size=660,260 \
  --screenshot="$here/background@2x.png" \
  "file://$here/background.html" >/dev/null 2>&1

echo "Wrote $here/background@2x.png"
