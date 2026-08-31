# qq-remote-bridge one-click installer.
# Run from the extracted bundle directory. Portable: the install dir is this
# script's own folder, so the bundle can live anywhere.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 -AppId <APPID> -ClientSecret <SECRET> -OpenId <USER_OPENID>
#   powershell ... -File deploy.ps1            # reuse existing qq_bridge_config.json if present
#
# It: (1) writes qq_bridge_config.json, (2) registers the launcher in the user
# Startup folder for login autostart, (3) starts the daemon + watchdog.
param(
  [string]$AppId,
  [string]$ClientSecret,
  [string]$OpenId,
  [string]$DshBin
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
if (-not $cfg.gateway) { $cfg.gateway = "wss://api.sgroup.qq.com/websocket" }
if (-not $cfg.apiHost) { $cfg.apiHost = "api.bot.qq.com" }
if (-not $cfg.tokenHost) { $cfg.tokenHost = "bots.qq.com" }
if (-not $cfg.replyContentLimit) { $cfg.replyContentLimit = 1500 }
if (-not $cfg.commandTimeoutMs) { $cfg.commandTimeoutMs = 20000 }

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

# ---- 2) login autostart registration -------------------------------------
if (Test-Path $Launcher) {
  Copy-Item $Launcher $StartupLink -Force
  Write-Step "登录自启已注册: $StartupLink"
} else {
  Write-Host "未找到 launcher: $Launcher" -ForegroundColor Yellow
}

# ---- 3) start daemon + watchdog ------------------------------------------
Write-Step "正在启动 daemon 与 watchdog..."
$SilentVbs = Join-Path $Dir "qq_bridge_silent.vbs"
if (Test-Path $SilentVbs) {
  Start-Process -FilePath "wscript.exe" -ArgumentList "`"$SilentVbs`"" -WindowStyle Hidden
} else {
  Start-Process -FilePath "node.exe" -ArgumentList "`"$(Join-Path $Dir 'qq_remote_bridge.js')`"" -WorkingDirectory $Dir -WindowStyle Hidden
}
Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $Dir 'qq_bridge_watchdog.ps1')`"" -WindowStyle Hidden
Start-Sleep -Seconds 8

Write-Step "部署完成。检查日志:"
$Log = Join-Path $Dir "qq_remote_bridge.log"
if (Test-Path $Log) { Get-Content $Log -Tail 8 }
