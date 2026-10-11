#!/bin/bash
# ============================================================
#  Regenerate Chrome Web Store marketing assets.
#
#  Produces, into <project>/store-assets:
#    marketing-banner-1400x560.{png,jpg}       marquee image
#    marketing-tile-440x280.{png,jpg}          small promo tile
#    marketing-screenshot-<layout>-<theme>-640x400.{png,jpg}    screenshots (crisp)
#    marketing-screenshot-<layout>-<theme>-1280x800.png         high-res screenshots
#    marketing-feature-watch-nav-{1280x800,640x400}.{png,jpg}   Prev / Next feature card
#    marketing-feature-backup-{1280x800,640x400}.{png,jpg}      backup / restore feature card
#
#  <layout> is modern (the default) or classic; <theme> is light or dark.
#  Chrome Web Store allows up to 5 screenshots; there are 6 candidates (4 popup
#  shots + the 2 feature cards), so pick 5 when uploading.
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

# Real popup screenshots for both layouts (light + dark), rendered at 2x.
node "${HERE}/render-popup.js" "${OUT}"

# Downscale the 2x popups to the exact 640x400 store size (crisp).
for l in classic modern; do
  for t in light dark; do
    sips -z 400 640 "${OUT}/marketing-screenshot-${l}-${t}-1280x800.png" \
      --out "${OUT}/marketing-screenshot-${l}-${t}-640x400.png" >/dev/null 2>&1
  done
done

# Feature cards (also valid as store screenshots)
for card in watch-nav backup; do
  sips -z 400 640 "${OUT}/marketing-feature-${card}-1280x800.png" \
    --out "${OUT}/marketing-feature-${card}-640x400.png" >/dev/null 2>&1
done

# JPG copies (Chrome Web Store accepts both PNG and JPG).
for f in "${OUT}"/*.png; do
  sips -s format jpeg -s formatOptions 92 "$f" --out "${f%.png}.jpg" >/dev/null 2>&1
done

echo "✅ Store assets regenerated:"
ls -1 "${OUT}"
