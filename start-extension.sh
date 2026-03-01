#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extension"

echo "==> Installing extension dependencies..."
cd "$EXT_DIR"
npm install

echo "==> Installing webview dependencies..."
cd "$EXT_DIR/webview"
npm install

echo "==> Building extension (dashboard + webview + backend)..."
cd "$EXT_DIR"
npm run build

echo "==> Opening extension workspace in VSCode..."
code "$EXT_DIR"

echo ""
echo "Done. Press F5 in VSCode to launch the Extension Development Host."
