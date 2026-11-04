' 开机自启（隐藏窗口）：由计划任务在登录时调用，实际逻辑在 scripts\autostart.mjs
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.Run """" & fso.GetParentFolderName(WScript.ScriptFullName) & "\开机自启.cmd""", 0, False
