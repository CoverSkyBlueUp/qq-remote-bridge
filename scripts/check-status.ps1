# qq-remote-bridge status helper (portable)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File check-status.ps1
# Paths derive from this script's own directory.
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $Dir "qq_remote_bridge.log"
$cfg = Join-Path $Dir "qq_bridge_config.json"
$pidFile = Join-Path $Dir "qq_remote_bridge.pid"

Write-Host "=== qq-remote-bridge status (@ $Dir) ==="
Write-Host ""

Write-Host "[1] daemon process:"
$pidVal = 0
if (Test-Path $pidFile) { $pidVal = [int](Get-Content $pidFile -Raw).Trim() }
if ($pidVal -gt 0 -and (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) {
  $p = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
  Write-Host "  RUNNING pid=$pidVal started=$($p.StartTime)"
} else {
  Write-Host "  NOT RUNNING (no live pid)"
}

Write-Host ""
Write-Host "[2] config:"
if (Test-Path $cfg) {
  try {
    $c = Get-Content $cfg -Raw | ConvertFrom-Json
    Write-Host "  appId=$($c.appId)"
    Write-Host "  authorizedOpenids=$($c.authorizedOpenids -join ',')"
    Write-Host "  replyContentLimit=$($c.replyContentLimit)"
  } catch {
    Write-Host "  config parse error: $($_.Exception.Message)"
  }
} else {
  Write-Host "  MISSING: $cfg"
}

Write-Host ""
Write-Host "[3] log tail (connection/events):"
if (Test-Path $log) {
  Get-Content $log -Tail 12
} else {
  Write-Host "  no log file yet"
}

Write-Host ""
Write-Host "[4] startup registration (logon scheduled task):"
$task = Get-ScheduledTask -TaskName "DSH_QQ_Remote_Bridge" -ErrorAction SilentlyContinue
if ($task) {
  $info = $task | Get-ScheduledTaskInfo
  Write-Host "  DSH_QQ_Remote_Bridge -> state=$($task.State), lastRun=$($info.LastRunTime), nextRun=$($info.NextRunTime)"
} else {
  Write-Host "  DSH_QQ_Remote_Bridge -> NOT REGISTERED"
}
