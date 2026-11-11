' Hidden one-shot watchdog: 给计划任务每 10 分钟用一次。
' 只做一次 checkOnce 就退出（watchdog.mjs --once），不会常驻。
' 存在的意义：机器睡眠/唤醒、夜里关机之后，常驻的 watchdog 进程已经死了，
' 而 Startup 里的自启只在「登录」时触发 —— 唤醒不会触发登录，于是就没人管桥接了。
Dim fso, sh, base, node
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
node = "C:\Users\25240\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.CurrentDirectory = base
sh.Run """" & node & """ """ & base & "\scripts\watchdog.mjs"" --once", 0, False
