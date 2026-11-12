# Memory and CPU of a process group, for docs/LOCAL_WEB_APP_SPEC.md section 6 (LW13).
# Usage: powershell -File tools/measure.ps1 -Match "<regex on the command line or path>" [-Samples 5] [-Every 60]
# Reports per sample: process count, private working set (MB, sum), private bytes / commit (MB, sum), CPU seconds (sum).
param([string]$Match, [int]$Samples = 5, [int]$Every = 60)
$rows = @()
for ($i = 0; $i -lt $Samples; $i++) {
  $procs = Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -match $Match) -or ($_.ExecutablePath -match $Match) }
  $ids = @($procs | ForEach-Object { [int]$_.ProcessId })
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains [int]$_.IDProcess }
  $ws = ($perf | Measure-Object -Property WorkingSetPrivate -Sum).Sum / 1MB
  $pb = ($perf | Measure-Object -Property PrivateBytes -Sum).Sum / 1MB
  $cpu = (Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object -Property CPU -Sum).Sum
  $rows += [pscustomobject]@{ time = (Get-Date).ToString('HH:mm:ss'); processes = $ids.Count; privateWorkingSetMB = [math]::Round($ws, 1); privateBytesMB = [math]::Round($pb, 1); cpuSeconds = [math]::Round($cpu, 2) }
  if ($i -lt $Samples - 1) { Start-Sleep -Seconds $Every }
}
$rows | Format-Table -AutoSize | Out-String
