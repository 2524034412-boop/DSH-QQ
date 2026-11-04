' ASCII-named hidden launcher for autostart.cmd.
' Used by WMI / Startup so the process tree is not tied to the DSH session.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.Run """" & fso.GetParentFolderName(WScript.ScriptFullName) & "\autostart.cmd""", 0, False
