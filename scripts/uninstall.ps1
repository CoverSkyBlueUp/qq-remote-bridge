# qq-remote-bridge uninstaller.
# Portable: install dir is this script's own folder.
# Stops the daemon + watchdog, removes the login autostart entry, and (optionally)
# removes the config. Does NOT delete the bundle scripts themselves.
param(
  [switch]$KeepConfig
)

$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Dir "qq_remote_bridge.pid"
$ConfigPath = Join-Path $Dir "qq_bridge_config.json"
$Startup = [Environment]::GetFolderPath('Startup')
$StartupLink = Join-Path $Startup "DSH_QQ_Remote_Bridge.cmd"

function Write-Step($m) { Write-Host "[uninstall] $m" -ForegroundColor Yellow }

# ---- 1) stop daemon ------------------------------------------------------
if (Test-Path $PidFile) {
  $pidVal = [int](Get-Content $PidFile -Raw).Trim()
  $p = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
  if ($p) { Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue; Write-Step "已停止 daemon pid=$pidVal" }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
} else {
  Write-Step "无 pid 文件；尝试按命令行匹配停止 daemon"
  Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
    try { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction Stop).CommandLine -like "*qq_remote_bridge*" } catch { $false }
  } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Write-Step "已停止 pid=$($_.Id)" }
}

# ---- 2) stop watchdog ----------------------------------------------------
Get-Process -Name powershell -ErrorAction SilentlyContinue | Where-Object {
  try { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction Stop).CommandLine -like "*qq_bridge_watchdog*" } catch { $false }
} | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Write-Step "已停止 watchdog pid=$($_.Id)" }

# ---- 3) remove login autostart (scheduled task + legacy Startup entry) ----
$TaskName = "DSH_QQ_Remote_Bridge"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Step "已移除登录自启计划任务: $TaskName"
}
if (Test-Path $StartupLink) {
  Remove-Item $StartupLink -Force -ErrorAction SilentlyContinue
  Write-Step "已移除旧启动文件夹条目: $StartupLink"
}

# ---- 4) optionally remove config ----------------------------------------
if (-not $KeepConfig -and (Test-Path $ConfigPath)) {
  Remove-Item $ConfigPath -Force -ErrorAction SilentlyContinue
  Write-Step "已删除配置: $ConfigPath"
} else {
  Write-Step "保留配置: $ConfigPath"
}

Write-Step "卸载完成。可删除本目录（$Dir）清理所有脚本。"
