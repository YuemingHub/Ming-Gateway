#!/usr/bin/env bash
# Two restart cycles answering two questions:
#   Cycle A (rule enabled + content logging off):
#     - does an enabled routing rule suppress the implicit failover chain?
#     - does client.disable_content_logging:true keep conversation content out of logs?
#   Cycle B (rule disabled + content logging off):
#     - is failover restored? is content still out of the logs?
# Evidence: raw/rule-and-content-logging.txt
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APPDIR="$HERE/bifrost-app"
BIN="$(find "${LOCALAPPDATA:-$HOME/.local/share}/bifrost" -type f -name 'bifrost-http*' 2>/dev/null | sort | tail -1)"
PORT=17878
exec >>"$HERE/raw/rule-and-content-logging.txt" 2>&1
echo "===== rule & content-logging cycles $(date -Is) ====="

stop_gw() { taskkill //IM "bifrost-http.exe-0" //F >/dev/null 2>&1 || true; sleep 2; }
start_gw() { ( cd "$APPDIR" && "$BIN" -app-dir "$APPDIR" -port "$PORT" -log-style pretty >"$HERE/.tmp/gw-cycle.log" 2>&1 & ); sleep 11; }

toggle_rule() { # $1 = true/false
  python - "$APPDIR/config.json" "$1" << 'PY'
import json, sys
p, val = sys.argv[1], sys.argv[2] == 'true'
c = json.load(open(p, encoding='utf-8'))
for r in c['governance']['routing_rules']:
    if r['id'] == 'chain-a-strict':
        r['enabled'] = val
json.dump(c, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('chain-a-strict enabled =', val)
PY
}
set_content_logging() { # $1 = true/false
  python - "$APPDIR/config.json" "$1" << 'PY'
import json, sys
p, val = sys.argv[1], sys.argv[2] == 'true'
c = json.load(open(p, encoding='utf-8'))
c.setdefault('client', {})['disable_content_logging'] = val
json.dump(c, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('disable_content_logging =', val)
PY
}

probe() { # $1 = label
  echo "--- probe: $1"
  node - "$PORT" "$1" << 'JS'
const port = process.argv[2];
const label = process.argv[3];
const MOCK = 'http://127.0.0.1:18080';
const GW = `http://127.0.0.1:${port}`;
const marker = `CONTENT-MARKER-${Date.now()}`;
(async () => {
  await fetch(`${MOCK}/__mock/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyBehavior: { 'sk-mock-a1': '500' } }) });
  const res = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bf-vk': 'sk-bf-a-strict' },
    body: JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: marker }] }),
  });
  const text = await res.text();
  let routed = null; try { routed = JSON.parse(text).extra_fields?.routing_info || null; } catch {}
  await fetch(`${MOCK}/__mock/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyBehavior: {} }) });
  const logs = await (await fetch(`${GW}/api/logs?limit=10`)).text();
  const contentLeaked = logs.includes(marker) || logs.includes('mock-answer');
  console.log(JSON.stringify({ label, failoverStatus: res.status, routed, contentMarkerInLogs: contentLeaked }));
})();
JS
}

echo "### cycle A: rule ENABLED + content logging DISABLED"
stop_gw; toggle_rule true; set_content_logging true; start_gw; probe "A"
echo "### cycle B: rule DISABLED + content logging DISABLED"
stop_gw; toggle_rule false; set_content_logging true; start_gw; probe "B"
stop_gw
echo "### fixture restored: rule disabled, content logging left ON=false (original)"
python - "$APPDIR/config.json" << 'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding='utf-8'))
for r in c['governance']['routing_rules']:
    if r['id'] == 'chain-a-strict':
        r['enabled'] = False
c.setdefault('client', {}).pop('disable_content_logging', None)
json.dump(c, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('restored')
PY
echo "===== done ====="
