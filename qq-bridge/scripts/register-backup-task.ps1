# Register the weekly backup task (Sunday 04:00, catch up after sleep / missed run).
# ASCII-only: PowerShell 5.1 reads it without a BOM.
$ErrorActionPreference = 'Stop'

$ps1 = 'D:\DSH\qq-bridge\scripts\backup-dsh.ps1'
if (-not (Test-Path -LiteralPath $ps1)) { throw "missing $ps1" }

$user = "$env:USERDOMAIN\$env:USERNAME"
$start = (Get-Date -Date (Get-Date).AddDays(7 - [int](Get-Date).DayOfWeek) -Hour 4 -Minute 0 -Second 0).ToString('s')

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Weekly DSH data backup (code, roles, state json, docs)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <DaysOfWeek><Sunday/></DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>
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
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "$ps1"</Arguments>
      <WorkingDirectory>D:\DSH\qq-bridge</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

Register-ScheduledTask -TaskName 'DSHWeeklyBackup' -Xml $xml -Force | Out-Null
$t = Get-ScheduledTask -TaskName 'DSHWeeklyBackup'
$i = Get-ScheduledTaskInfo -TaskName 'DSHWeeklyBackup'
"registered : $($t.TaskName) / $($t.State)"
"next run   : $($i.NextRunTime)"
