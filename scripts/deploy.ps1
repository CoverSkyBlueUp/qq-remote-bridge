# qq-remote-bridge one-click installer.
# Run from the extracted bundle directory. Portable: the install dir is this
# script's own folder, so the bundle can live anywhere.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 -AppId <APPID> -ClientSecret <SECRET> -OpenId <USER_OPENID>
#   powershell ... -File deploy.ps1            # reuse existing qq_bridge_config.json if present
# Optional: -Workspace <dir> sets the working directory of every natural-language
# headless session (default: %USERPROFILE%\dsh-qqbot-workspace). -DshBin <path>
# overrides the dsh CLI entry.
# -ProgressIntervalMs <ms> sets the minimum gap between progress pushes (default 60000).
#
# It: (1) writes qq_bridge_config.json, (2) registers the launcher in the user
# Startup folder for login autostart, (3) starts the daemon + watchdog.
param(
  [string]$AppId,
  [string]$ClientSecret,
  [string]$OpenId,
  [string]$DshBin,
  [string]$Workspace,
  [int]$ProgressIntervalMs
)

$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Dir "qq_bridge_config.json"
$Launcher = Join-Path $Dir "qq_remote_bridge_launch.cmd"
$Startup = [Environment]::GetFolderPath('Startup')
$StartupLink = Join-Path $Startup "DSH_QQ_Remote_Bridge.cmd"

function Write-Step($m) { Write-Host "[deploy] $m" -ForegroundColor Cyan }

# ---- 1) config -----------------------------------------------------------
if (Test-Path $ConfigPath) {
  $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
} else {
  $cfg = $null
}
if ($AppId) { $cfg.appId = $AppId }
if ($ClientSecret) { $cfg.clientSecret = $ClientSecret }
if ($OpenId) {
  if (-not $cfg.authorizedOpenids) { $cfg.authorizedOpenids = @($OpenId) }
  elseif ($cfg.authorizedOpenids -notcontains $OpenId) { $cfg.authorizedOpenids += $OpenId }
}
if ($DshBin) { $cfg.dshBin = $DshBin }
if ($Workspace) { $cfg.workspace = $Workspace }
if (-not $cfg.workspace) { $cfg.workspace = Join-Path $env:USERPROFILE "dsh-qqbot-workspace" }
if (-not $cfg.gateway) { $cfg.gateway = "wss://api.sgroup.qq.com/websocket" }
if (-not $cfg.apiHost) { $cfg.apiHost = "api.bot.qq.com" }
if (-not $cfg.tokenHost) { $cfg.tokenHost = "bots.qq.com" }
if (-not $cfg.replyContentLimit) { $cfg.replyContentLimit = 1500 }
if (-not $cfg.commandTimeoutMs) { $cfg.commandTimeoutMs = 20000 }
if ($ProgressIntervalMs) { $cfg.progressIntervalMs = $ProgressIntervalMs }
if (-not $cfg.progressIntervalMs) { $cfg.progressIntervalMs = 60000 }
if ($null -eq $cfg.startupGreeting) { $cfg.startupGreeting = $true }
if ($null -eq $cfg.autoSplitTasks) { $cfg.autoSplitTasks = $true }
if ($null -eq $cfg.netTaskAsk) { $cfg.netTaskAsk = $true }

# Validate required fields
if (-not $cfg.appId -or -not $cfg.clientSecret) {
  Write-Host "缺少 appId / clientSecret。请提供 -AppId 与 -ClientSecret，或确保 qq_bridge_config.json 已存在。" -ForegroundColor Red
  exit 1
}
if (-not $cfg.authorizedOpenids -or $cfg.authorizedOpenids.Count -eq 0) {
  Write-Host "缺少 authorizedOpenids。请提供 -OpenId（你的 user_openid）。" -ForegroundColor Red
  exit 1
}

$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $ConfigPath -Encoding UTF8
Write-Step "配置已写入: $ConfigPath"
Write-Step "  appId=$($cfg.appId)"
Write-Step "  authorizedOpenids=$($cfg.authorizedOpenids -join ',')"

# ---- 2) login autostart registration (scheduled task at logon) ------------
# A logon-triggered scheduled task (same mechanism DSH itself uses) runs the
# watchdog at logon; the watchdog starts the daemon and keeps it alive. The
# task also restarts the watchdog if it fails, and StartWhenAvailable covers
# a missed logon trigger. An old Startup-folder entry is removed to avoid
# double-start.
$TaskName = "DSH_QQ_Remote_Bridge"
$WatchdogVbs = Join-Path $Dir "qq_bridge_watchdog_silent.vbs"
$Watchdog = Join-Path $Dir "qq_bridge_watchdog.ps1"
$Startup = [Environment]::GetFolderPath('Startup')
$StartupLink = Join-Path $Startup "DSH_QQ_Remote_Bridge.cmd"
if (Test-Path $StartupLink) {
  Remove-Item $StartupLink -Force -ErrorAction SilentlyContinue
  Write-Step "已移除旧启动文件夹条目: $StartupLink"
}
# The scheduled task runs wscript with a VBS wrapper: wscript never shows a
# console, so no PowerShell window (or flash) appears at logon.
if (Test-Path $WatchdogVbs) {
  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$WatchdogVbs`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $trigger.Delay = "PT30S"
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "QQ remote bridge: keep qq_remote_bridge daemon alive (hidden via wscript); starts with DSH at logon" -Force | Out-Null
  Write-Step "登录自启已注册（计划任务 + wscript 静默）: $TaskName（随登录启动，30s 延迟）"
} else {
  Write-Host "未找到 watchdog 静默启动器: $WatchdogVbs" -ForegroundColor Yellow
}

# ---- 3) start daemon + watchdog ------------------------------------------
Write-Step "正在启动 daemon 与 watchdog..."
$SilentVbs = Join-Path $Dir "qq_bridge_silent.vbs"
if (Test-Path $SilentVbs) {
  Start-Process -FilePath "wscript.exe" -ArgumentList "`"$SilentVbs`"" -WindowStyle Hidden
} else {
  Start-Process -FilePath "node.exe" -ArgumentList "`"$(Join-Path $Dir 'qq_remote_bridge.js')`"" -WorkingDirectory $Dir -WindowStyle Hidden
}
if (Test-Path $WatchdogVbs) {
  Start-Process -FilePath "wscript.exe" -ArgumentList "`"$WatchdogVbs`"" -WindowStyle Hidden
} else {
  Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Watchdog`"" -WindowStyle Hidden
}
Start-Sleep -Seconds 8

Write-Step "部署完成。检查日志:"
$Log = Join-Path $Dir "qq_remote_bridge.log"
if (Test-Path $Log) { Get-Content $Log -Tail 8 }
