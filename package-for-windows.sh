#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# package-for-windows.sh
#
# Bundles CMT Metrics Hub into a zip ready to hand off to a Windows user.
# Run this on your Mac:
#   chmod +x package-for-windows.sh
#   ./package-for-windows.sh
#
# Output: cmt-metrics-hub-windows.zip  (~50–60 MB without node_modules)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PACKAGE_NAME="cmt-metrics-hub-windows"
ZIP_FILE="${PACKAGE_NAME}.zip"
STAGING="/tmp/${PACKAGE_NAME}"

echo ""
echo " ================================================================"
echo "  CMT Metrics Hub — Windows Package Builder"
echo " ================================================================"
echo ""

# ── 1. Fresh build ────────────────────────────────────────────────
echo " [*] Building TypeScript..."
npm run build
echo " [+] Build complete."

# ── 2. Stage the files ────────────────────────────────────────────
echo " [*] Staging files..."
rm -rf "${STAGING}"
mkdir -p "${STAGING}"

# Core app files
cp -r dist/       "${STAGING}/dist"
cp -r frontend/   "${STAGING}/frontend"
cp -r windows/    "${STAGING}/windows"
cp    package.json         "${STAGING}/"
cp    package-lock.json    "${STAGING}/"
cp    .env.example         "${STAGING}/"

# Copy DB snapshot if it exists
if [ -f "data/cmt_metrics.db" ]; then
    mkdir -p "${STAGING}/data"
    cp data/cmt_metrics.db "${STAGING}/data/"
    echo " [+] DB snapshot included ($(du -sh data/cmt_metrics.db | cut -f1))"
else
    mkdir -p "${STAGING}/data"
    echo " [-] No DB found — colleague will start with empty database"
fi

# Copy manual_classifications so all tags are preserved
if [ -f "data/cmt_metrics.db" ]; then
    echo " [+] DB already includes all classifications"
fi

# ── 3. Zip it ─────────────────────────────────────────────────────
echo " [*] Creating zip..."
rm -f "${ZIP_FILE}"
cd /tmp
zip -r "${OLDPWD}/${ZIP_FILE}" "${PACKAGE_NAME}" -x "*.DS_Store" "*.git*"
cd "${OLDPWD}"

SIZE=$(du -sh "${ZIP_FILE}" | cut -f1)
echo " [+] Created: ${ZIP_FILE} (${SIZE})"

# ── 4. Cleanup ────────────────────────────────────────────────────
rm -rf "${STAGING}"

echo ""
echo " ================================================================"
echo "  Done! Send  ${ZIP_FILE}  to your colleague."
echo " ================================================================"
echo ""
echo "  Their instructions:"
echo "   1. Install Node.js 20 LTS from https://nodejs.org"
echo "   2. Unzip to any folder (e.g. C:\\cmt-metrics-hub\\)"
echo "   3. Double-click  windows\\install.bat"
echo "   4. Double-click  windows\\start.bat"
echo "   5. Open  http://localhost:3001"
echo ""
