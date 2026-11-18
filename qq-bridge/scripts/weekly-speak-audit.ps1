# 每周说话体检：跑一次 speak-audit.mjs（最近 7 天），把报告存下来做趋势。
# 只在登录时触发，内部自己判断"距上次是否超过 6 天"，所以一天多次登录也只跑一次。
#
# 手动跑：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\weekly-speak-audit.ps1
# 强制跑：加 -Force

param([switch]$Force, [int]$Days = 7)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$state = Join-Path $root 'state'
$stampFile = Join-Path $state 'speak-audit.json'
$logFile = Join-Path $state 'speak-audit.log'
$node = 'C:\Users\25240\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$script = Join-Path $root 'scripts\speak-audit.mjs'

if (-not (Test-Path $node)) { Write-Host "找不到 node：$node"; exit 1 }
if (-not (Test-Path $script)) { Write-Host "找不到 speak-audit.mjs"; exit 1 }

# 距上次跑够 6 天了吗
$last = $null
if (Test-Path $stampFile) {
  try { $last = (Get-Content $stampFile -Raw -Encoding UTF8 | ConvertFrom-Json).at } catch {}
}
if (-not $Force -and $last) {
  $lastTime = [datetime]'1970-01-01 08:00:00'
  try { $lastTime = [datetime]::Parse($last) } catch {}
  if (((Get-Date) - $lastTime).TotalDays -lt 6) {
    Write-Host "上次体检在 $($lastTime.ToString('yyyy-MM-dd HH:mm'))，不到 6 天，跳过"
    exit 0
  }
}

Push-Location $root
try {
  $report = & $node $script $Days 2>&1 | Out-String
  # 顺带查一次人格卡有没有新增重复段落
  $persona = & $node (Join-Path $root 'scripts\persona-dup-check.mjs') 2>&1 | Out-String
} finally {
  Pop-Location
}
$report = $report + "`n---- 人格卡查重 ----`n" + $persona

$at = (Get-Date).ToString('o')
$entry = "===== $at（最近 $Days 天）=====`n$report"
Add-Content -Path $logFile -Value $entry -Encoding UTF8

# 只留最近 20 次，别让日志无限长
$lines = Get-Content $logFile -Encoding UTF8
$markers = @()
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -like '===== *') { $markers += $i } }
if ($markers.Count -gt 20) {
  $cut = $markers[$markers.Count - 20]
  $lines[$cut..($lines.Count - 1)] | Set-Content -Path $logFile -Encoding UTF8
}

@{
  at = $at
  days = $Days
  chars = $report.Length
  report = $report
} | ConvertTo-Json -Depth 3 | Set-Content -Path $stampFile -Encoding UTF8

Write-Host "体检完成：$stampFile"
Write-Host $report