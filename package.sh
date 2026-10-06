#!/bin/bash
# Package the Chrome extension for distribution

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXTENSION_NAME="scroll-saver"
VERSION=$(grep '"version"' manifest.json | cut -d'"' -f4)
ZIP_FILE="${EXTENSION_NAME}-v${VERSION}.zip"

echo "Packaging ${EXTENSION_NAME} version ${VERSION}..."

# Create temporary directory
TEMP_DIR=$(mktemp -d)
TARGET_DIR="${TEMP_DIR}/${EXTENSION_NAME}"
mkdir -p "${TARGET_DIR}"

# Copy necessary files
cp manifest.json "${TARGET_DIR}/"
cp content.js "${TARGET_DIR}/"
cp background.js "${TARGET_DIR}/"
cp popup.html "${TARGET_DIR}/"
cp popup.css "${TARGET_DIR}/"
cp popup-classic.html "${TARGET_DIR}/"
cp popup-classic.css "${TARGET_DIR}/"
cp popup.js "${TARGET_DIR}/"
cp import.html "${TARGET_DIR}/"
cp import.js "${TARGET_DIR}/"
cp LICENSE "${TARGET_DIR}/"

# Copy icons directory
cp -r icons "${TARGET_DIR}/"

# Copy i18n locale files
cp -r _locales "${TARGET_DIR}/"

# Create ZIP (excluding hidden files and macOS metadata)
cd "${TEMP_DIR}"
zip -r "${ZIP_FILE}" "${EXTENSION_NAME}" -x ".*" -x "__MACOSX" -x "*/.DS_Store"

# Move ZIP to original directory
cd - > /dev/null
mv "${TEMP_DIR}/${ZIP_FILE}" .

# Cleanup
rm -rf "${TEMP_DIR}"

echo "✅ Package created: ${ZIP_FILE}"
echo "📦 Files included:"
unzip -l "${ZIP_FILE}" | awk 'NR>3 && NF>0 && !/files,.*bytes/'

# ============================================================
# Regenerate Chrome Web Store marketing assets each release.
# These go to store-assets/ (outside the extension zip).
# Fails gracefully — packaging still succeeds without them.
# ============================================================
echo
echo "📸 Regenerating Chrome Web Store assets..."
if "${SCRIPT_DIR}/tools/marketing/build.sh"; then
  echo "✅ Store assets ready in ${SCRIPT_DIR}/store-assets/"
else
  echo "⚠️  Store asset generation skipped (install playwright: npm install, and ensure it's macOS with sips)"
fi 