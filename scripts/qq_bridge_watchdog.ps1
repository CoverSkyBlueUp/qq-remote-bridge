# qq-remote-bridge watchdog: keeps the bridge daemon alive.
# Started at Windows login (Startup folder). Loops forever:
#   - every 30s, if the recorded daemon PID is gone, restart the daemon.
# PID-based check is reliable without CIM/permissions.
# Paths derive from this script's own directory so the bundle is portable.
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bridge = Join-Path $Dir "qq_remote_bridge.js"
$SilentVbs = Join-Path $Dir "qq_bridge_silent.vbs"
$Log = Join-Path $Dir "qq_remote_bridge_watchdog.log"
$PidFile = Join-Path $Dir "qq_remote_bridge.pid"
# Session cleanup helper (optional): deletes idle qqbot sessions (see
# .monitor). Look for the silent launcher in this bundle's own dir first
# (repo layout: scripts/qqbot-session-cleanup.vbs), then in <parent>\.monitor
# (this machine's deployment layout). Absent = feature disabled gracefully.
$CleanupVbs = Join-Path $Dir "qqbot-session-cleanup.vbs"
if (-not (Test-Path $CleanupVbs)) {
  $altCleanup = Join-Path (Split-Path $Dir -Parent) ".monitor\qqbot-session-cleanup.vbs"
  if (Test-Path $altCleanup) { $CleanupVbs = $altCleanup }
}

function WLog($m) {
  $line = "$(Get-Date -Format o) $m"
  try { Add-Content -Path $Log -Value $line -ErrorAction Stop } catch {}
}

function Get-RecordedPid {
  if (Test-Path $PidFile) {
    try { return [int](Get-Content $PidFile -Raw).Trim() } catch { return 0 }
  }
  return 0
}

# Run the qqbot session cleanup (hide stragglers + delete idle sessions).
# Called on every bot startup/restart. Launched through wscript + a silent VBS
# wrapper so no console window ever flashes (powershell -WindowStyle Hidden
# still creates a brief visible console first).
function Run-Cleanup {
  if (-not (Test-Path $CleanupVbs)) {
    WLog "cleanup launcher missing: $CleanupVbs"
    return
  }
  try {
    & wscript.exe "`"$CleanupVbs`"" 2>&1 | Out-Null
    WLog "cleanup launched (silent via wscript)"
  } catch {
    WLog ("cleanup FAILED: " + $_.Exception.Message)
  }
}

function Start-Bridge {
  WLog "bridge not running; starting it"
  try {
    # Launch via wscript so the node console window is never shown.
    # The daemon writes its own PID file; read it back after a short delay.
    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$SilentVbs`"" -WindowStyle Hidden -ErrorAction Stop | Out-Null
    Start-Sleep -Seconds 3
    if (Test-Path $PidFile) {
      $p = Get-Content $PidFile -Raw
      WLog "bridge started pid=$p (via silent vbs)"
    } else {
      WLog "bridge launched (pid file not ready yet)"
    }
  } catch {
    WLog "bridge start FAILED: $($_.Exception.Message)"
  }
  Run-Cleanup
}

WLog "watchdog started"
Run-Cleanup

# initial check: make sure a bridge is up on boot
$pidNow = Get-RecordedPid
if ($pidNow -gt 0 -and (Get-Process -Id $pidNow -ErrorAction SilentlyContinue)) {
  WLog "bridge already running pid=$pidNow"
} else {
  Start-Bridge
}

while ($true) {
  $pidNow = Get-RecordedPid
  $alive = $false
  if ($pidNow -gt 0) {
    $proc = Get-Process -Id $pidNow -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq "node") { $alive = $true }
  }
  if (-not $alive) {
    Start-Bridge
  }
  Start-Sleep -Seconds 30
}
