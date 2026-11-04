# 注册「一键对接」计划任务：让 autostart 跑在任务计划程序自己的进程树里，
# 而不是 DSH 的子进程里 —— 这样 DSH 重启/关闭时不会把它一起带走。
# 任务没有触发器，只用于按需触发（桥接的 /oneclick 用 schtasks /run 拉起它）。
$ErrorActionPreference = 'Stop'

$taskName = 'QQBridgeAlign'
$vbs = 'D:\DSH\qq-bridge\autostart-hidden.vbs'
if (-not (Test-Path -LiteralPath $vbs)) { throw "找不到 $vbs" }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Principal $principal -Force | Out-Null

$t = Get-ScheduledTask -TaskName $taskName
"registered: $($t.TaskName)"
"state     : $($t.State)"
"action    : $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
"triggers  : $($t.Triggers.Count)"
