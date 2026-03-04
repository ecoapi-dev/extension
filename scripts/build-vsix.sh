#!/usr/bin/env bash
# build-vsix.sh — Build and package the ECO extension as a .vsix file
#
# Usage (run in a bash terminal):
#   bash extension/scripts/build-vsix.sh
#
# Confirmed compatible with: Windows (Git Bash / WSL), Linux.
# Do NOT run in PowerShell or CMD — bash is required.
#
# Run from anywhere — the script resolves its own location.
# Output: eco-api-analyzer-*.vsix in the extension/ directory.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR/.."

echo "==> Installing extension dependencies..."
cd "$EXT_DIR"
npm install

echo "==> Installing webview dependencies..."
cd "$EXT_DIR/webview"
npm install

echo "==> Installing dashboard dependencies..."
cd "$EXT_DIR/dashboard"
npm install

echo "==> Building (dashboard + webview + extension backend)..."
cd "$EXT_DIR"
npm run build

echo "==> Packaging .vsix..."
cd "$EXT_DIR"
npx @vscode/vsce package --no-dependencies --allow-missing-repository

VSIX=$(ls "$EXT_DIR"/eco-api-analyzer-*.vsix 2>/dev/null | head -n 1)

echo ""
echo "Done! VSIX created: $VSIX"
echo ""
echo "To install:"
echo "  code --install-extension \"$VSIX\""
echo "  or: Ctrl+Shift+P → Extensions: Install from VSIX..."
