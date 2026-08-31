@echo off
rem QQ Remote Bridge login launcher: starts daemon now and keeps it alive via watchdog.
rem %~dp0 = directory of this script, so the bundle is portable.
set "DIR=%~dp0"
start "" /min "node" "%DIR%qq_remote_bridge.js"
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%DIR%qq_bridge_watchdog.ps1"
