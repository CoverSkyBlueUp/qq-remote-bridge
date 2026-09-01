' Silent launcher for qqbot-session-cleanup.ps1 - no console window ever
' appears (wscript is a GUI-subsystem host; the child powershell is spawned
' hidden with window style 0). Optional argument: -ArchiveOnly (used by the
' every-minute scheduled task); no argument = full mode (used at qqbot start).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
mode = ""
If WScript.Arguments.Count > 0 Then mode = " " & WScript.Arguments(0)
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\qqbot-session-cleanup.ps1""" & mode, 0, True
