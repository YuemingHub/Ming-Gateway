#!/usr/bin/env bash
# Backup / restore test for the isolated Bifrost instance.
#
# Question: is backup at least as simple as Ming-Gateway's (copy gateway.yaml +
# data/channels.json)?
#
# Method:
#   1. create a marker virtual key via the governance API
#   2. stop the gateway; copy the whole app dir as the "backup"
#   3. delete config.db; start; check the marker (proves where state lives)
#   4. restore from the copy; start; check the marker is back
#   5. clean up the marker
#
# Evidence: raw/backup-restore.txt
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APPDIR="$HERE/bifrost-app"
OUT="$HERE/raw/backup-restore.txt"
BK="$HERE/.tmp/app-backup"
BIN="$(find "${LOCALAPPDATA:-$HOME/.local/share}/bifrost" -type f -name 'bifrost-http*' 2>/dev/null | sort | tail -1)"
PORT=17878

exec >>"$OUT" 2>&1
echo "===== backup/restore test $(date -Is) ====="
START_WITH_GW=${START_WITH_GW:-0}

stop_gw() { taskkill //IM "bifrost-http.exe-0" //F >/dev/null 2>&1 || true; sleep 2; }
start_gw() { ( cd "$APPDIR" && "$BIN" -app-dir "$APPDIR" -port "$PORT" -log-style pretty >"$HERE/.tmp/gw-restore.log" 2>&1 & ) ; sleep 10; }
MARKER_ID=""
vk_exists() { [ -n "$MARKER_ID" ] && curl -s -m 5 "http://127.0.0.1:$PORT/api/governance/virtual-keys" | grep -c "$MARKER_ID" || echo 0; }

echo "--- step 0: ensure gateway running"
curl -s -m 5 "http://127.0.0.1:$PORT/health" >/dev/null || start_gw
echo "health: $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health)"

echo "--- step 1: create marker VK via API"
curl -s -m 10 -X POST "http://127.0.0.1:$PORT/api/governance/virtual-keys" \
  -H 'Content-Type: application/json' \
  -d '{"name":"backup marker","provider_configs":[{"provider":"mock-b1","allowed_models":["*"],"key_ids":["*"]}]}' > "$HERE/.tmp/marker.json"
MARKER_ID=$(grep -o '"id":"[0-9a-f-]\{36\}"' "$HERE/.tmp/marker.json" | head -1 | sed 's/.*:"//; s/"//')
echo "marker id: $MARKER_ID"
echo "marker present after create: $(vk_exists)"

echo "--- step 2: stop gateway, back up the whole app dir"
stop_gw
rm -rf "$BK"; cp -r "$APPDIR" "$BK"
echo "backup contents:"; ls -la "$BK"

echo "--- step 3: delete config.db, start, check marker (state location proof)"
mv "$APPDIR/config.db" "$APPDIR/config.db.deleted" 2>/dev/null || echo "(no config.db found)"
start_gw
echo "marker present with config.db deleted: $(vk_exists)"
stop_gw

echo "--- step 4: restore backup copy, start, check marker"
rm -f "$APPDIR/config.db.deleted" "$APPDIR/config.db" "$APPDIR/logs.db"
cp -r "$BK/." "$APPDIR/"
start_gw
echo "marker present after restore: $(vk_exists)"

echo "--- step 5: cleanup (delete marker VK via API, then stop)"
IDS=$(curl -s -m 5 "http://127.0.0.1:$PORT/api/governance/virtual-keys" | tr ',' '
' | grep -B0 '"name":"backup marker' | grep -o '"id":"[0-9a-f-]\{36\}"' | sed 's/.*:"//; s/"//' | sort -u)
for id in $IDS; do curl -s -m 5 -X DELETE "http://127.0.0.1:$PORT/api/governance/virtual-keys/$id" | head -c 200; echo; done
echo "marker present after cleanup: $(vk_exists)"
stop_gw
echo "===== done ====="
