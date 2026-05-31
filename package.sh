#!/bin/bash
# Package the Chrome extension for distribution

set -e

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
cp popup.js "${TARGET_DIR}/"
cp LICENSE "${TARGET_DIR}/"

# Copy icons directory
cp -r icons "${TARGET_DIR}/"

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
unzip -l "${ZIP_FILE}" | tail -n +4 | head -n -2