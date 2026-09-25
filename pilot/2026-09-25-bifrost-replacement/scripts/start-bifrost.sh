#!/usr/bin/env bash
# Start the isolated Bifrost instance used by this pilot.
# - dedicated app dir (its own config.json / config.db / logs.db)
# - isolated port (default 17878), bound to localhost only
# - uses the npx-cached v2.2.3 binary directly, so process control is clean
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${BIFROST_PORT:-17878}"
APPDIR="${BIFROST_APPDIR:-$HERE/bifrost-app}"

BIN="${BIFROST_BIN:-}"
if [ -z "$BIN" ]; then
  CACHE="${LOCALAPPDATA:-$HOME/.local/share}/bifrost"
  BIN="$(find "$CACHE" -type f -name 'bifrost-http*' 2>/dev/null | sort | tail -1)"
fi
if [ -z "$BIN" ] || [ ! -f "$BIN" ]; then
  echo "bifrost binary not found; run: npx -y @maximhq/bifrost --help (downloads v2.2.3)" >&2
  exit 1
fi

mkdir -p "$APPDIR"
if [ ! -f "$APPDIR/config.json" ]; then
  cp "$HERE/fixtures/bifrost-config.json" "$APPDIR/config.json"
fi
test -f "$APPDIR/config.json" || { echo "missing $APPDIR/config.json" >&2; exit 1; }
# NOTE: relative paths inside config.json (config_store.config.path = "./config.db")
# resolve against the process WORKING DIRECTORY, not -app-dir. Starting from the
# app dir keeps the sqlite files inside it so a folder backup is complete.
cd "$APPDIR"
echo "[start-bifrost] bin=$BIN app-dir=$APPDIR cwd=$(pwd) port=$PORT"
exec "$BIN" -app-dir "$APPDIR" -port "$PORT" -log-style pretty
