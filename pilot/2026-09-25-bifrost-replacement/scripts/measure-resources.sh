#!/usr/bin/env bash
# Resource footprint measurement for a running gateway process (Windows host).
#   bash scripts/measure-resources.sh <process-name-pattern> <label> [load-cmd]
#
# Samples RSS / CPU before and after the load command, prints a compact record.
# Evidence is appended by the caller into raw/.
set -uo pipefail
PATTERN="$1"; LABEL="$2"; LOADCMD="${3:-}"
ps_json() {
  powershell -NoProfile -Command "
    \$p = Get-Process | Where-Object { \$_.ProcessName -like '$PATTERN' } | Select-Object -First 1
    if (\$p) { \$o = [pscustomobject]@{ rssMB = [math]::Round(\$p.WorkingSet64/1MB,1); cpuSec = [math]::Round(\$p.CPU,2); pid=\$p.Id };
      \$o | ConvertTo-Json -Compress } else { '{\"error\":\"not running\"}' }"
}
echo "[$LABEL] before: $(ps_json)"
if [ -n "$LOADCMD" ]; then
  echo "[$LABEL] load: $LOADCMD"
  bash -c "$LOADCMD"
  sleep 3
fi
echo "[$LABEL] after : $(ps_json)"
