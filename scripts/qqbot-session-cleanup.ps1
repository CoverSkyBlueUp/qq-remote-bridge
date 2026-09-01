# qqbot-session-cleanup.ps1 - hide ALL qqbot sessions from the web UI and
# auto-delete each session once its message push has completed.
#
# Rules (per user request):
#   1) Every qqbot session (cwd == workspace, stored under
#      ~/.dsh/sessions/--D-QQbot--) must be invisible:
#      - ungrouped sessions are archived via the dsh web API
#        (workspace.archiveSession), removing them from the "Ungrouped" group.
#   2) Auto-delete after the message push completes (no retention period):
#      - sessions that are hidden (archived), not running, and idle longer than
#        graceMinutes have their session-log directory removed, and their
#        records are pruned from workspace.json / session_projcache.json.
#   3) protectedSessionIds are never archived or deleted (the active session).
#
# Modes:
#   - API mode: dsh web server online (default http://127.0.0.1:3080); read
#     session state and archive/delete through the API.
#   - Direct mode: server offline; fall back to a conservative file scan
#     (dir last-write time + grace + protected list; skip while a headless
#     child process is running).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File qqbot-session-cleanup.ps1 [-WhatIf]
#   -ArchiveOnly : only hide new ungrouped qqbot sessions (used by the 1-minute task)
#   -DeleteOnly  : only delete idle hidden qqbot sessions (used at qqbot startup)
#   default      : both passes
# Scheduled task: DSH_QQBot_Session_Cleanup (every minute, -ArchiveOnly).
# qqbot startup hook: qq_bridge_watchdog.ps1 runs this script (full mode).

param(
  [switch]$WhatIf,
  [switch]$ArchiveOnly,
  [switch]$DeleteOnly
)

if ($ArchiveOnly -and $DeleteOnly) { Write-Error "use only one of -ArchiveOnly / -DeleteOnly"; exit 1 }
$doArchive = (-not $DeleteOnly)
$doDelete  = (-not $ArchiveOnly)

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- config ---------------------------------------------------------------
$ConfigPath = Join-Path $Dir 'qqbot-session-cleanup.json'
if (-not (Test-Path $ConfigPath)) { Write-Error "missing config: $ConfigPath"; exit 1 }
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json

$baseUrl     = [string]$cfg.baseUrl
$workspace   = [string]$cfg.workspace
$graceMin    = if ($cfg.graceMinutes) { [int]$cfg.graceMinutes } else { 2 }
$protected   = @($cfg.protectedSessionIds)
$logFile     = if ($cfg.logFile) { [string]$cfg.logFile } else { Join-Path $Dir 'qqbot-session-cleanup.log' }

$sessionsRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
$qqDir        = Join-Path $sessionsRoot '--D-QQbot--'
$wsJson       = Join-Path $env:USERPROFILE '.dsh\storages\workspace.json'
$projJson     = Join-Path $env:USERPROFILE '.dsh\storages\session_projcache.json'

function Log($m) {
  $line = "$(Get-Date -Format o) $m"
  try { Add-Content -Path $logFile -Value $line -ErrorAction Stop } catch {}
  Write-Host $line
}

function Invoke-Api($method, $payload) {
  $body = @{
    type    = 'client-request'
    rpcId   = 'cleanup-' + [guid]::NewGuid().ToString('N')
    method  = $method
    payload = $payload
  } | ConvertTo-Json -Depth 6 -Compress
  $r = Invoke-RestMethod -Uri ($baseUrl + '/api/' + $method) -Method Post `
        -ContentType 'application/json' -Body $body -TimeoutSec 8
  if (-not $r.result.ok) {
    throw "API $method failed: " + ($r.result.error | ConvertTo-Json -Compress)
  }
  return $r.result.value
}

# Read a JSON storage file as UTF-8 (BOM-tolerant) and remember its BOM-ness
# so writes preserve the server's file style. PowerShell 5.1's default
# Get-Content would misread UTF-8 as ANSI/GBK and corrupt the JSON.
$script:lastJsonHasBom = $false
function Read-JsonFile($path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $script:lastJsonHasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  return ([System.IO.File]::ReadAllText($path) | ConvertFrom-Json)
}

function Write-JsonFileAtomic($path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 30
  $enc = New-Object System.Text.UTF8Encoding($script:lastJsonHasBom)
  Copy-Item -Path $path -Destination ($path + '.bak') -Force
  [System.IO.File]::WriteAllText($path, $json, $enc)
}

function Get-HeadlessChildren {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -match 'bin\.js' -and $_.CommandLine -match 'headless' })
  } catch { return @() }
}

# ---- run ------------------------------------------------------------------
$deleted = @()
$archivedNow = @()
$serverUp = $false

try {
  $wl = Invoke-Api 'workspace.list' @{}
  $sl = Invoke-Api 'session.list' @{}
  $serverUp = $true
} catch {
  Log "SERVER DOWN ($($_.Exception.Message)); switching to direct file mode"
  $serverUp = $false
}

if ($serverUp) {
  # workspace accounting and archive set
  $accounted = @{}
  foreach ($w in $wl.items) { foreach ($sid in $w.sessionIds) { $accounted[$sid] = $true } }
  $archivedSet = @($wl.archivedSessionIds)
  $qqSessions = @($sl.items | Where-Object { $_.cwd -eq $workspace })
  $running = @{}
  foreach ($s in $qqSessions) { if ($s.running) { $running[$s.sessionId] = $true } }

  # 1) archive ungrouped qqbot sessions (bot-created headless sessions) so they
  #    never show in the sidebar. Accounted sessions (user's own web
  #    conversations) are left visible and are managed manually.
  if ($doArchive) {
    foreach ($s in $qqSessions) {
      $id = $s.sessionId
      if ($protected -contains $id) { continue }
      if ($accounted.ContainsKey($id)) { continue }
      if ($archivedSet -contains $id) { continue }
      Log "ARCHIVE $id (title=$($s.projections.values.title))"
      $archivedNow += $id
      if (-not $WhatIf) {
        $v = Invoke-Api 'workspace.archiveSession' @{ sessionId = $id }
        $archivedSet = @($v.archivedSessionIds)
      }
    }
  }

  # 2) delete: archived + not running + idle beyond grace + not protected
  if ($doDelete) {
    $cutoff = [datetime]::Now.AddMinutes(-$graceMin)
    foreach ($s in $qqSessions) {
      $id = $s.sessionId
      if ($protected -contains $id) { continue }
      if ($running.ContainsKey($id)) { continue }
      if ($archivedSet -notcontains $id) { continue }
      $dir = Join-Path $qqDir $id
      if (-not (Test-Path $dir)) { continue }
      $mtime = (Get-Item $dir).LastWriteTime
      if ($mtime -gt $cutoff) { continue }
      Log "DELETE $id (idle since $($mtime.ToString('o')))"
      $deleted += $id
      if (-not $WhatIf) {
        Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop
      }
    }
  }
} else {
  # direct mode: server offline - conservative delete pass (archive needs the API)
  if ($doDelete) {
    $headless = Get-HeadlessChildren
    if ($headless.Count -gt 0) {
      Log "direct mode: $($headless.Count) headless child(ren) running; skipping deletion this run"
    }
    $cutoff = [datetime]::Now.AddMinutes(-$graceMin)
    if (Test-Path $qqDir) {
      foreach ($d in Get-ChildItem $qqDir -Directory) {
        $id = $d.Name
        if ($protected -contains $id) { continue }
        if ($headless.Count -gt 0) { break }
        if ($d.LastWriteTime -gt $cutoff) { continue }
        Log "DELETE(direct) $id (idle since $($d.LastWriteTime.ToString('o')))"
        $deleted += $id
        if (-not $WhatIf) { Remove-Item -Path $d.FullName -Recurse -Force -ErrorAction Stop }
      }
    }
  }
}

# 3) prune registry files (atomic write + .bak backup; when the server is up
#    its in-memory state may rewrite these files, but directory removal is the
#    authoritative cleanup)
if (-not $WhatIf -and $deleted.Count -gt 0) {
  try {
    if (Test-Path $wsJson) {
      $ws = Read-JsonFile $wsJson
      $before = $ws.global.archivedSessionIds.Count
      $null = $ws.global.archivedSessionIds = @($ws.global.archivedSessionIds | Where-Object { $deleted -notcontains $_ })
      foreach ($w in $ws.tables.workspaces.PSObject.Properties) {
        $null = $w.Value.sessionIds = @($w.Value.sessionIds | Where-Object { $deleted -notcontains $_ })
      }
      if ($ws.global.archivedSessionIds.Count -ne $before) {
        Write-JsonFileAtomic $wsJson $ws
        Log "PRUNED workspace.json archivedSessionIds ($before -> $($ws.global.archivedSessionIds.Count))"
      }
    }
    if (Test-Path $projJson) {
      $proj = Read-JsonFile $projJson
      $dropped = @()
      foreach ($k in @($proj.tables.sessions.PSObject.Properties.Name)) {
        if ($deleted -contains $k) { $proj.tables.sessions.PSObject.Properties.Remove($k) | Out-Null; $dropped += $k }
      }
      if ($dropped.Count -gt 0) {
        Write-JsonFileAtomic $projJson $proj
        Log "PRUNED session_projcache.json sessions ($($dropped.Count) removed)"
      }
    }
  } catch {
    Log "PRUNE FAILED (non-fatal): $($_.Exception.Message)"
  }
}

Log "DONE serverUp=$serverUp archive=$doArchive delete=$doDelete archivedNow=$($archivedNow.Count) deleted=$($deleted.Count) whatif=$WhatIf"
