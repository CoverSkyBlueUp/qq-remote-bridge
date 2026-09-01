@echo off
rem QQ Remote Bridge login launcher: starts daemon now and keeps it alive via
rem the watchdog. Both run through wscript VBS wrappers so NO console window
rem (not even a flash) appears at logon.
rem %~dp0 = directory of this script, so the bundle is portable.
set "DIR=%~dp0"
start "" wscript.exe "%DIR%qq_bridge_silent.vbs"
start "" wscript.exe "%DIR%qq_bridge_watchdog_silent.vbs"
