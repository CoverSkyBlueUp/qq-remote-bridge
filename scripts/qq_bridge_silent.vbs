' Launch qq_remote_bridge.js with no visible console window.
' Hidden via wscript (WindowStyle 0) - node.exe console stays off-screen.
' Path derives from this script's own folder so the bundle is portable.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node.exe """ & dir & "\qq_remote_bridge.js" & """", 0, False
