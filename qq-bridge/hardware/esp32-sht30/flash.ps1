param(
  [ValidateSet('display','serial','probe')][string]$Sketch = 'display',
  [string]$Pins = '',
  [string]$Port = '',
  [switch]$Build,
  [int]$Monitor = 0,
  [string]$Board = 'esp32:esp32:esp32'
)

# ESP32 + SHT31/30 一键编译 + 上传 + 看串口。
#
#   .\flash.ps1                        # 带屏幕的固件，默认 21/22
#   .\flash.ps1 -Pins 25,26            # 换成 GPIO25=SDA / GPIO26=SCL
#   .\flash.ps1 -Sketch probe          # I2C 探针：扫 14 组引脚，看哪组认得到 0x44
#   .\flash.ps1 -Build                 # 只编译不上传
#   .\flash.ps1 -Monitor 20            # 上传后读 20 秒串口
#
# 之所以要这个脚本：arduino-cli 默认往 C:\Users\...\AppData\Local\Arduino15 写，
# 那目录在这台机器上不可写（Access denied），所以数据和库目录都改到 D:\DSH\tools\arduino15。

$ErrorActionPreference = 'Stop'

$root = 'D:\DSH\qq-bridge\hardware\esp32-sht30'
$cli  = 'D:\DSH\tools\arduino-cli\arduino-cli.exe'
if (-not (Test-Path $cli)) { Write-Host "找不到 arduino-cli：$cli"; exit 1 }

$env:ARDUINO_DIRECTORIES_DATA      = 'D:\DSH\tools\arduino15'
$env:ARDUINO_DIRECTORIES_DOWNLOADS = 'D:\DSH\tools\arduino15\staging'
$env:ARDUINO_DIRECTORIES_USER      = 'D:\DSH\tools\arduino15\user'

# esptool.exe / gen_insights_package.exe 都是 PyInstaller 打包的 onefile 程序，
# 它们解包时要用 %TEMP%；在 DSH 拉起的环境里用系统 TEMP 会报
# "Could not create temporary directory!"，指到 D 盘就正常。
$env:TEMP = 'D:\DSH\tools\tmp'
$env:TMP  = 'D:\DSH\tools\tmp'
if (-not (Test-Path $env:TEMP)) { New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null }

$map = @{ display = 'esp32-sht30-display'; serial = 'esp32-sht30-serial'; probe = 'i2c-probe' }
$dir = Join-Path $root $map[$Sketch]
if (-not (Test-Path (Join-Path $dir "$($map[$Sketch]).ino"))) {
  Write-Host "找不到源码：$dir"; exit 1
}

$cliArgs = @('compile', '--fqbn', $Board, '--build-path', "D:\DSH\tools\build\$Sketch", $dir)

if ($Pins) {
  $parts = @($Pins -split '[,\s]+' | Where-Object { $_ })
  if ($parts.Count -ne 2) { Write-Host '-Pins 要写成 25,26（SDA,SCL）'; exit 1 }
  # 用 Arduino 的 build_opt.h 传宏，而不是 --build-property build.extra_flags：
  # 后者会把平台自带的 build.extra_flags 整个替换掉（-DARDUINO_USB_CDC_ON_BOOT=0
  # 以及 ESP32 那个宏就没了），结果 Adafruit_BusIO 走到 AVR 分支、报 BitOrder 未定义。
  # build_opt.h 是追加式的，只影响这个 sketch 目录。
  $optFile = Join-Path $dir 'build_opt.h'
  $line = "-DI2C_SDA_PIN=$($parts[0]) -DI2C_SCL_PIN=$($parts[1])`n"
  [IO.File]::WriteAllText($optFile, $line, (New-Object Text.UTF8Encoding($false)))
  Write-Host ("I2C 引脚覆盖为 SDA=GPIO{0}  SCL=GPIO{1}" -f $parts[0], $parts[1])
} else {
  $optFile = Join-Path $dir 'build_opt.h'
  if (Test-Path $optFile) { Remove-Item $optFile -Force; Write-Host '已清掉 build_opt.h（回到固件默认引脚 21/22）' }
}

if (-not $Build) {
  if (-not $Port) {
    $cands = @()
    try {
      $json = & $cli board list --format json 2>$null | Out-String
      if ($json) {
        $obj = $json | ConvertFrom-Json
        foreach ($p in $obj.detected_ports) { if ($p.port.address) { $cands += $p.port.address } }
      }
    } catch { }
    if (-not $cands.Count) {
      $cands = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
        ForEach-Object { if ($_.Name -match '(COM\d+)') { $Matches[1] } } | Sort-Object -Unique)
    }
    if (-not $cands.Count) {
      Write-Host '没有发现串口 —— 板子插上了吗？'
      Write-Host '  · 换一根能传数据的 USB 线（很多线只供电）'
      Write-Host '  · 插机箱后面板直插，别走 hub / 扩展坞'
      Write-Host '  · 设备管理器里看有没有 CH340 / CP2102 带黄色感叹号'
      exit 2
    }
    $Port = $cands[0]
  }
  Write-Host "串口：$Port"
  $cliArgs += @('--upload', '-p', $Port)
}

Write-Host ("编译{0}：{1}" -f $(if ($Build) { '' } else { '并上传' }), $map[$Sketch])
& $cli @cliArgs
if ($LASTEXITCODE -ne 0) { Write-Host "失败，退出码 $LASTEXITCODE"; exit $LASTEXITCODE }
Write-Host 'OK'

if ($Monitor -gt 0 -and $Port -and -not $Build) {
  Write-Host ("--- 串口 $Port 读 {0} 秒 ---" -f $Monitor)
  $sp = New-Object System.IO.Ports.SerialPort($Port, 115200, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
  $sp.ReadTimeout = 500
  try { $sp.Open() } catch { Write-Host "打不开串口：$($_.Exception.Message)"; exit 3 }
  $deadline = (Get-Date).AddSeconds($Monitor)
  $buf = ''
  while ((Get-Date) -lt $deadline) {
    try { $buf += $sp.ReadExisting() } catch { }
    while ($buf.Contains("`n")) {
      $i = $buf.IndexOf("`n")
      $line = $buf.Substring(0, $i).TrimEnd("`r")
      $buf = $buf.Substring($i + 1)
      if ($line) { Write-Host $line }
    }
    Start-Sleep -Milliseconds 120
  }
  $sp.Close()
  if ($buf.Trim()) { Write-Host $buf.Trim() }
}