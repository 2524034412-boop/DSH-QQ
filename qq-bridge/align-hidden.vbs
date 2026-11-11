' Hidden launcher for the "one-click align" scheduled task.
' Starts scripts\autostart.mjs directly with node (no cmd.exe wrapper, no pause),
' so the task always exits and the bridge is never left hanging.
Dim fso, sh, base, node
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
node = "C:\Users\25240\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.CurrentDirectory = base
sh.Run """" & node & """ """ & base & "\scripts\autostart.mjs""", 0, False
