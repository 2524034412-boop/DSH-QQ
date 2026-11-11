<#
  从 USB 串口读 ESP32 上报的温湿度，转成 /report 请求交给桥接。

  为什么要这一层：ESP32 只负责「读传感器 + 往串口打一行 JSON」，不碰网络。
  好处是插上就能用 —— 不用配 WiFi、不用填电脑 IP、不用管防火墙，也不受校园网
  认证/客户端隔离影响。

  自检（不用等板子）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serial-env.ps1 -Test
  正常跑：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serial-env.ps1
  或者双击 scripts\start-serial-env.cmd（无窗口）

  日志：state/serial-env.log
#>
param(
  [string]$Port = '',                 # 留空 = 自动找 CH340/CP210x/ESP32 的串口
  [string]$Place = '',                # 可选：给读数打个房间标签（不进提示词，纯记录用）
  [int]$Baud = 115200,
  [int]$BridgePort = 3101,
  [switch]$Test
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $bridgeRoot 'state'
$tokenFile = Join-Path $stateDir 'environment-token'
$logFile = Join-Path $stateDir 'serial-env.log'
$reportUrl = "http://127.0.0.1:$BridgePort/report"

function Write-Log([string]$message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [serial] $message"
  Write-Host $line
  try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch {}
}

function Get-SensorToken {
  if (-not (Test-Path $tokenFile)) { throw "找不到令牌文件：$tokenFile（先把桥接跑起来一次）" }
  $token = (Get-Content $tokenFile -Raw).Trim()
  if ($token.Length -lt 8) { throw "令牌文件内容不正常：$tokenFile" }
  return $token
}

function Find-SerialPort {
  if ($Port) { return $Port }
  # 先用系统端口表快速判断「有没有插东西」：GetPortNames 是毫秒级的，
  # 而 Win32_PnPEntity 查询要好几秒 —— 没插板子时不该每 5 秒去翻一次 WMI。
  $names = [System.IO.Ports.SerialPort]::GetPortNames()
  if (-not $names -or $names.Count -eq 0) { return '' }
  if ($names.Count -eq 1) { return $names[0] }
  # 多个串口时按设备描述挑，比「COM 号」靠谱：换 USB 口后 COM 号会变，描述不会。
  $candidates = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '\(COM\d+\)' -and $_.Name -match 'CH340|CH341|CP210|USB-SERIAL|USB Serial|Silicon Labs|ESP32|UART' }
  if (-not $candidates) { return $names[0] }
  $name = $candidates | Select-Object -First 1 -ExpandProperty Name
  if ($name -match '\((COM\d+)\)') { return $Matches[1] }
  return $names[0]
}

function Send-Reading([string]$jsonLine) {
  $token = Get-SensorToken
  try { $reading = $jsonLine | ConvertFrom-Json } catch {
    Write-Log "跳过一行不是 JSON 的数据：$($jsonLine.Substring(0, [Math]::Min(60, $jsonLine.Length)))"
    return
  }
  if ($reading.PSObject.Properties.Name -contains 'error') {
    Write-Log "板子报错：$($reading.error)"
    return
  }
  if ($reading.PSObject.Properties.Name -contains 'hello') {
    Write-Log "板子已就绪：$($reading.hello) / 传感器 $($reading.sensor)"
    return
  }
  if (-not ($reading.PSObject.Properties.Name -contains 'tempC')) { return }
  if (-not ($reading.PSObject.Properties.Name -contains 'place') -and $Place) {
    $reading | Add-Member -NotePropertyName place -NotePropertyValue $Place -Force
  }
  $body = $reading | ConvertTo-Json -Compress
  try {
    $res = Invoke-RestMethod -Method Post -Uri $reportUrl -Headers @{ 'x-sensor-token' = $token } `
      -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 8
    Write-Log ("收到 $($reading.tempC)°C / $($reading.humidity)% → 已交给桥接（at=$($res.at)）")
  } catch {
    Write-Log "上报失败：$($_.Exception.Message)（桥接没跑？端口 $BridgePort）"
  }
}

if ($Test) {
  Write-Log "自检模式：不走串口，直接造一条读数发过去"
  $detected = Find-SerialPort
  if ($detected) { Write-Log "顺带探测到串口：$detected" } else { Write-Log "当前没探测到串口（板子还没插，正常）" }
  Send-Reading '{"tempC":23.4,"humidity":58.2}'
  Write-Log '自检结束。看到「已交给桥接」就说明电脑这一半是通的。'
  exit 0
}

$placeNote = ''
if (-not [string]::IsNullOrEmpty($Place)) { $placeNote = "，房间标签「$Place」" }
Write-Log "启动：波特率 $Baud，桥接端口 $BridgePort$placeNote"

while ($true) {
  $target = Find-SerialPort
  if (-not $target) {
    Write-Log '没找到串口设备，5 秒后重试（检查 USB 线是不是只充电的、驱动装了没）'
    Start-Sleep -Seconds 5
    continue
  }
  $sp = $null
  try {
    $sp = New-Object System.IO.Ports.SerialPort $target, $Baud, 'None', 8, 'One'
    $sp.NewLine = "`n"
    $sp.ReadTimeout = 10000
    $sp.ReadBufferSize = 4096
    # 不要一打开就拉 DTR/RTS：那会把板子复位一次，读数要重来
    $sp.DtrEnable = $false
    $sp.RtsEnable = $false
    $sp.Open()
    Write-Log "已连接 $target"
    while ($true) {
      $line = $sp.ReadLine().Trim()
      if ($line.StartsWith('{')) { Send-Reading $line }
    }
  } catch {
    Write-Log "串口断开或读取失败：$($_.Exception.Message)"
    $Port = ''
    Start-Sleep -Seconds 5
  } finally {
    if ($sp) { try { $sp.Dispose() } catch {} }
  }
}