# Measure the local Ming-Gateway (node gateway.js) process.
# Usage: powershell -NoProfile -File scripts/measure-gateway.ps1 -Label idle
param([string]$Label = "sample")
$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*gateway.js*' } | Select-Object -First 1
if (-not $proc) { Write-Output "[$Label] gateway not running"; exit 1 }
$p = Get-Process -Id $proc.ProcessId
$o = [pscustomobject]@{
  label  = $Label
  pid    = $p.Id
  rssMB  = [math]::Round($p.WorkingSet64 / 1MB, 1)
  cpuSec = [math]::Round($p.CPU, 2)
  threads = $p.Threads.Count
}
$o | ConvertTo-Json -Compress
