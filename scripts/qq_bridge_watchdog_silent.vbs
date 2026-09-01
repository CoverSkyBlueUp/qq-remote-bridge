' Launch qq_bridge_watchdog.ps1 with no visible console window (wscript never
' shows a console, unlike powershell.exe -WindowStyle Hidden which can flash).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\qq_bridge_watchdog.ps1""", 0, False
