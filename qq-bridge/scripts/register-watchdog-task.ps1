# 注册「每 10 分钟自检」计划任务（用 XML，避免 cmd 参数转义把 /sc 吞掉的问题）。
# 动机：常驻 watchdog 和 Startup 自启都只在「登录」时建立。机器睡眠一夜后唤醒不会有登录事件，
# 于是桥接一直是死的、面板上的「对接」也点不动（2026-10-31 早上就是这个状态）。
# 这里用重复触发器 + StartWhenAvailable：唤醒或错过时间点后，任务计划程序会补跑一次 checkOnce。
$ErrorActionPreference = 'Stop'

$vbs = 'D:\DSH\qq-bridge\watchdog-once.vbs'
if (-not (Test-Path -LiteralPath $vbs)) { throw "找不到 $vbs" }

$user = "$env:USERDOMAIN\$env:USERNAME"
$start = (Get-Date).AddMinutes(1).ToString('s')
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>qq-bridge health check every 10 min (catch up after sleep)</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT10M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"$vbs"</Arguments>
      <WorkingDirectory>D:\DSH\qq-bridge</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

Register-ScheduledTask -TaskName 'QQBridgeWatchdog' -Xml $xml -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'QQBridgeWatchdog'
$i = Get-ScheduledTaskInfo -TaskName 'QQBridgeWatchdog'
"registered : $($t.TaskName) / $($t.State)"
"interval   : $($t.Triggers[0].Repetition.Interval)"
"startWhen  : $($t.Settings.StartWhenAvailable)"
"nextRun    : $($i.NextRunTime)"
