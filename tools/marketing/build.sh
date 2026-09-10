#!/bin/bash
# ============================================================
#  Regenerate Chrome Web Store marketing assets.
#
#  Produces, into <project>/store-assets:
#    marketing-banner-1400x560.{png,jpg}       promotional tile
#    marketing-tile-440x280.{png,jpg}          small tile
#    marketing-screenshot-{dark,light}-640x400.{png,jpg}   screenshots (crisp)
#    marketing-screenshot-{dark,light}-1280x800.png        high-res screenshots
#
#  Requires: Node + Playwright (project dev dep) and macOS `sips`.
#  Run via:  npm run assets   (or ./tools/marketing/build.sh)
# ============================================================
set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
OUT="${ROOT}/store-assets"

mkdir -p "${OUT}"
echo "📸 Regenerating store assets into ${OUT}"

# Banner + small tile (vector mockups)
node "${HERE}/render.js" "${HERE}/large-banner.html" "${OUT}/marketing-banner-1400x560.png" 1400 560
node "${HERE}/render.js" "${HERE}/small-tile.html" "${OUT}/marketing-tile-440x280.png" 440 280

# Real popup screenshots (dark + light), rendered from popup.html at 2x.
node "${HERE}/render-popup.js" "${OUT}"

# Downscale the 2x popups to the exact 640x400 store size (crisp).
for t in dark light; do
  sips -z 400 640 "${OUT}/marketing-screenshot-${t}-1280x800.png" \
    --out "${OUT}/marketing-screenshot-${t}-640x400.png" >/dev/null 2>&1
done

# JPG copies (Chrome Web Store accepts both PNG and JPG).
for f in "${OUT}"/*.png; do
  sips -s format jpeg -s formatOptions 92 "$f" --out "${f%.png}.jpg" >/dev/null 2>&1
done

echo "✅ Store assets regenerated:"
ls -1 "${OUT}"
