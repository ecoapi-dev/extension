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

echo "==> Installing dashboard dependencies..."
cd "$SCRIPT_DIR/dashboard"
npm install

echo "==> Building extension (dashboard + webview + backend)..."
cd "$EXT_DIR"
npm run build

echo "==> Opening extension workspace..."
if [[ -d "/Applications/Visual Studio Code.app" ]]; then
  open -a "Visual Studio Code" "$EXT_DIR"
elif command -v code &>/dev/null; then
  code "$EXT_DIR"
elif [[ -d "/Applications/Cursor.app" ]]; then
  open -a "Cursor" "$EXT_DIR"
elif command -v cursor &>/dev/null; then
  cursor "$EXT_DIR"
else
  echo "Open the extension folder manually: $EXT_DIR"
fi

echo ""
echo "Done. Press F5 to launch the Extension Development Host."
