<#
  把串口采集器装成「登录时自动启动」的计划任务（当前用户，不需要管理员）。

  装：   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-serial-env-task.ps1
  看：   Get-ScheduledTask -TaskName 'qq-bridge-serial-env' | Get-ScheduledTaskInfo
  卸：   Unregister-ScheduledTask -TaskName 'qq-bridge-serial-env' -Confirm:$false

  ⚠️ 先手动跑通（scripts\serial-env.ps1 -Test 能看到「已交给桥接」）再装这个，
     否则等于开机自动启动一个还没验证过的东西。
#>
param(
  [string]$TaskName = 'qq-bridge-serial-env',
  [string]$Place = '书房'
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'serial-env.ps1'
if (-not (Test-Path $script)) { throw "找不到 $script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Place `"$Place`"" `
  -WorkingDirectory $bridgeRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'qq-bridge：从 USB 串口读温湿度（ESP32 + SHT30）' -Force | Out-Null

Write-Host "已注册计划任务：$TaskName（登录时启动，脚本退出会自动重试）"
Write-Host "现在立刻启动一次：Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "日志：$bridgeRoot\state\serial-env.log"