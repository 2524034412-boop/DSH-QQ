# qq-bridge 安装器（PS 5.1 / pwsh 通用）
#
# 做的事：
#   1. 检查 DSH 在不在
#   2. 把 qq-bridge 复制到 %USERPROFILE%\qq-bridge（保留已有的 state / 数据）
#   3. 写 ~/.dsh/qq-bridge-path.json，告诉插件桥接装在哪
#   4. 装依赖（pnpm）
#   5. 跑 scripts\setup-dsh.mjs，注册 DSH 侧的预设与 MCP（失败不致命）
#   6. 把 dsh-qq-bridge 插件装进 DSH profile，并注册到 bundles
#   7. （可选）注册开机自启（-Autostart）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DshHome "C:\DSH"
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Autostart
#
# 卸载：删掉 %USERPROFILE%\qq-bridge 与 %USERPROFILE%\.dsh\plugins\dsh-qq-bridge，
#       再从 profile\package.json 里移除两处即可。

param(
  [string]$DshHome = '',
  [string]$BridgeDir = (Join-Path $env:USERPROFILE 'qq-bridge'),
  [string]$PathFile = (Join-Path $env:USERPROFILE '.dsh\qq-bridge-path.json'),
  [switch]$SkipDeps,
  [switch]$SkipPlugin,
  [switch]$Autostart
)

$ErrorActionPreference = 'Stop'

function Title($text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Ok($text)    { Write-Host "  [ok]   $text" -ForegroundColor Green }
function Warn($text)  { Write-Host "  [warn] $text" -ForegroundColor Yellow }
function Die($text)   { Write-Host "  [fail] $text" -ForegroundColor Red; exit 1 }

function Test-DshDir($dir) {
  if ([string]::IsNullOrWhiteSpace($dir)) { return $false }
  return (Test-Path -LiteralPath (Join-Path $dir 'DeepSeek Harness.exe'))
}

# DSH 装在哪：调用者给的 > 正在跑的进程 > 卸载注册表 > 常见位置。
# 以前默认硬写 D:\DSH，别人的机器几乎不可能撞上。
function Find-DshHome {
  $tries = New-Object System.Collections.Generic.List[string]
  try {
    Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path } |
      ForEach-Object { $tries.Add((Split-Path -Parent $_.Path)) }
  } catch { }
  foreach ($root in @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    try {
      Get-ItemProperty $root -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'DeepSeek Harness*' -and $_.InstallLocation } |
        ForEach-Object { $tries.Add($_.InstallLocation) }
    } catch { }
  }
  foreach ($c in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
      (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness'),
      'D:\DSH',
      'C:\DSH',
      (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
      (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness'))) {
    if (-not [string]::IsNullOrWhiteSpace($c)) { $tries.Add($c) }
  }
  foreach ($t in $tries) {
    if (Test-DshDir $t) { return (Resolve-Path -LiteralPath $t).Path }
  }
  return ''
}

$here = $PSScriptRoot
$srcBridge = Join-Path $here 'qq-bridge'
$srcPlugin = Join-Path $here 'plugin\dsh-qq-bridge'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$pluginsDir = Join-Path $env:USERPROFILE '.dsh\plugins'

Write-Host ''
Write-Host 'qq-bridge 安装器' -ForegroundColor White
Write-Host '----------------' -ForegroundColor DarkGray

# ── 1. DSH ────────────────────────────────────────────────────────────
Title '1/7 检查 DSH'
if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = Find-DshHome
  if ($DshHome -eq '') {
    Die @"
没找到 DSH（DeepSeek Harness）。
  试过：正在运行的进程、卸载注册表、%LOCALAPPDATA%\Programs、D:\DSH、C:\DSH、Program Files。
  如果 DSH 装在别处，请这样跑：
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DshHome "你的 DSH 目录"
"@
  }
  Ok "自动找到 DSH：$DshHome"
}
$dshExe = Join-Path $DshHome 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $dshExe)) {
  Die "没找到 DSH：$dshExe`n  先装 DSH（DeepSeek Harness），或用 -DshHome 指定安装目录。"
}
Ok "DSH：$DshHome"

$runtime = Join-Path $DshHome 'resources\runtime\primary-runtime\dependencies'
$nodeExe = Join-Path $runtime 'node\bin\node.exe'
$pnpmMjs = Join-Path $runtime 'pnpm\bin\pnpm.mjs'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $found) { Die "没找到 node。DSH 的运行时目录不完整：$runtime" }
  $nodeExe = $found.Source
  Warn "用系统 node：$nodeExe"
} else {
  Ok "node：$nodeExe"
}
if (-not (Test-Path -LiteralPath $pnpmMjs)) {
  $pnpmCjs = Join-Path $runtime 'pnpm\bin\pnpm.cjs'
  if (Test-Path -LiteralPath $pnpmCjs) {
    $pnpmMjs = $pnpmCjs
    Ok "pnpm：$pnpmMjs"
  } else {
    Die "没找到 pnpm：$runtime\pnpm\bin\pnpm.mjs`n  DSH 的运行时目录不完整，建议重装一次 DSH。"
  }
}

# pnpm 跑包的 postinstall 时会直接调 `node`（qq-bridge 的 patch-snowluma-sdk.mjs 就是），
# 而全新机器上 node 根本不在 PATH（DSH 只带自己的运行时）——不补这一步，安装会在
# 「pnpm install 失败（退出码 1）」这里整段中止。
$nodeDir = Split-Path -Parent $nodeExe
if ($nodeDir -ne '' -and (($env:PATH -split ';') -notcontains $nodeDir)) {
  $env:PATH = $nodeDir + ';' + $env:PATH
  Ok "已把 node 加进本次安装的 PATH（postinstall 要用）"
}

# ── 2. 复制桥接 ───────────────────────────────────────────────────────
Title '2/7 复制桥接'
if (-not (Test-Path -LiteralPath (Join-Path $srcBridge 'src\bridge.js'))) {
  Die "安装包不完整：缺少 qq-bridge\src\bridge.js。请把整个安装包解压后再运行。"
}
New-Item -ItemType Directory -Path $BridgeDir -Force | Out-Null
$robocopyArgs = @($srcBridge, $BridgeDir, '/E', '/XD', 'state', 'node_modules', '.git', '/XF', '*.log', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1')
$robo = Start-Process -FilePath 'robocopy.exe' -ArgumentList $robocopyArgs -NoNewWindow -Wait -PassThru
if ($robo.ExitCode -ge 8) { Die "复制失败（robocopy 退出码 $($robo.ExitCode)）" }
Ok "桥接文件 -> $BridgeDir（已有的 state / 记忆不会被删）"

# 随包附带的插件（预设 / 控制端 / 设置页）先复制过去，setup-dsh.mjs 要用。
# 但桥接目录里自带的那两个（qq-mode-console / qq-agent-presets）不能复制成实体目录：
# setup-dsh 要给它们建 junction，目录已经存在会直接报「不是符号链接，请先移走」，
# 结果就是预设和 MCP 一个都没注册上（新机器上实测踩到）。
$srcPlugins = Join-Path $here 'plugin'
if (Test-Path -LiteralPath $srcPlugins) {
  foreach ($dir in (Get-ChildItem -LiteralPath $srcPlugins -Directory)) {
    $fromBridge = Join-Path $BridgeDir "plugins\$($dir.Name)"
    if (Test-Path -LiteralPath $fromBridge) {
      Ok "插件 $($dir.Name)：桥接目录自带，5/7 会建链接"
      continue
    }
    $target = Join-Path $pluginsDir $dir.Name
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $rr = Start-Process robocopy.exe -ArgumentList @($dir.FullName, $target, '/E', '/NFL', '/NDL', '/NJH', '/NJS') -NoNewWindow -Wait -PassThru
    if ($rr.ExitCode -ge 8) { Warn "复制插件 $($dir.Name) 失败（$($rr.ExitCode)）" } else { Ok "插件 $($dir.Name)" }
  }
}

# ── 3. 路径标记 ───────────────────────────────────────────────────────
Title '3/7 记录安装位置'
$markerDir = Split-Path -Parent $PathFile
if ($markerDir -ne '' -and -not (Test-Path -LiteralPath $markerDir)) { New-Item -ItemType Directory -Path $markerDir -Force | Out-Null }
$marker = @{ path = $BridgeDir } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($PathFile, $marker, (New-Object System.Text.UTF8Encoding($false)))
Ok "$PathFile"

# ── 4. 依赖 ───────────────────────────────────────────────────────────
Title '4/7 安装桥接依赖'
if ($SkipDeps) {
  Warn '按要求跳过（-SkipDeps）'
} else {
  Push-Location $BridgeDir
  try {
    & $nodeExe $pnpmMjs install --prefer-offline
    if ($LASTEXITCODE -ne 0) { Die "pnpm install 失败（退出码 $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
  Ok '依赖就绪'
}

# ── 5. DSH 侧预设与 MCP ───────────────────────────────────────────────
Title '5/7 注册 DSH 预设与 MCP'
$setup = Join-Path $BridgeDir 'scripts\setup-dsh.mjs'
# setup-dsh.mjs 要 import js-yaml：依赖没装时它只会甩一屏 Node 栈，不如先说清楚。
$hasDeps = Test-Path -LiteralPath (Join-Path $BridgeDir 'node_modules\js-yaml')
if (-not (Test-Path -LiteralPath $setup)) {
  Warn "没有 setup-dsh.mjs，跳过"
} elseif (-not $hasDeps) {
  Warn '桥接依赖没装（node_modules 里没有 js-yaml），这一步跳过。'
  Warn '装好依赖后可以再跑一遍本脚本，或手动执行：node scripts\setup-dsh.mjs desktop'
} else {
  Push-Location $BridgeDir
  try {
    $setupOut = & $nodeExe $setup 'desktop' 2>&1
    $setupOut | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) {
      Warn "setup-dsh.mjs 退出码 $LASTEXITCODE —— 预设/MCP 可能没写全，可在 DSH 里手动检查"
    } else {
      Ok '预设与 MCP 已写入 DSH'
    }
  } catch {
    Warn "setup-dsh.mjs 出错：$($_.Exception.Message)"
  } finally {
    Pop-Location
  }
}

# 兜底：桥接自带的插件必须真的能加载。setup-dsh 正常时会建 junction；
# 它要是提前失败（依赖没装全、路径不对），这里补上，免得「装完了但没工具」。
if (Test-Path -LiteralPath $srcPlugins) {
  foreach ($dir in (Get-ChildItem -LiteralPath $srcPlugins -Directory)) {
    $fromBridge = Join-Path $BridgeDir "plugins\$($dir.Name)"
    if (-not (Test-Path -LiteralPath $fromBridge)) { continue }
    $link = Join-Path $pluginsDir $dir.Name
    if (Test-Path -LiteralPath $link) { Ok "插件 $($dir.Name)：已就位"; continue }
    try {
      New-Item -ItemType Junction -Path $link -Target $fromBridge | Out-Null
      Ok "插件 $($dir.Name)：补建链接 -> $fromBridge"
    } catch {
      Warn "插件 $($dir.Name) 没接上：$($_.Exception.Message)"
    }
  }
}

# ── 6. 插件 ───────────────────────────────────────────────────────────
Title '6/7 安装 DSH 插件'
if ($SkipPlugin) {
  Warn '按要求跳过（-SkipPlugin）'
} else {
  if (-not (Test-Path -LiteralPath (Join-Path $srcPlugin 'package.json'))) {
    Die "安装包不完整：缺少 plugin\dsh-qq-bridge\package.json"
  }
  $target = Join-Path $pluginsDir 'dsh-qq-bridge'
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  $r2 = Start-Process -FilePath 'robocopy.exe' -ArgumentList @($srcPlugin, $target, '/E', '/NFL', '/NDL', '/NJH', '/NJS') -NoNewWindow -Wait -PassThru
  if ($r2.ExitCode -ge 8) { Die "插件复制失败（$($r2.ExitCode)）" }
  Ok "插件 -> $target"

  if (-not (Test-Path -LiteralPath $profileDir)) { Die "没找到 DSH profile：$profileDir。请先启动一次 DSH。" }
  $pkgFile = Join-Path $profileDir 'package.json'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupFile = "$pkgFile.bak-install-$stamp"
  Copy-Item -LiteralPath $pkgFile -Destination $backupFile -Force
  $json = Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
  # 手工建的 / 极简的 profile 可能缺字段：补出来再写，别在 Add-Member 上炸。
  if ($null -eq $json.dependencies) {
    $json | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object psobject) -Force
  }
  if ($null -eq $json.dsh) {
    $json | Add-Member -NotePropertyName dsh -NotePropertyValue (New-Object psobject) -Force
  }
  if ($null -eq $json.dsh.profile) {
    $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object psobject) -Force
  }
  $link = 'link:' + ($target -replace '\\', '/')
  if ($json.dependencies.PSObject.Properties.Name -contains 'dsh-qq-bridge') {
    $json.dependencies.'dsh-qq-bridge' = $link
  } else {
    $json.dependencies | Add-Member -NotePropertyName 'dsh-qq-bridge' -NotePropertyValue $link
  }
  if ($null -eq $json.dsh.profile.bundles) {
    $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
  }
  $bundles = @($json.dsh.profile.bundles)
  if ($bundles -notcontains 'dsh-qq-bridge') {
    $json.dsh.profile.bundles = @($bundles + 'dsh-qq-bridge')
  }
  $out = $json | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($pkgFile, $out, (New-Object System.Text.UTF8Encoding($false)))

  # 写完立刻读回来验一遍：profile 坏一处，DSH 就直接起不来。宁可当场退回备份。
  try {
    $check = Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $okLink = ($check.dependencies.'dsh-qq-bridge' -eq $link)
    $okBundle = (@($check.dsh.profile.bundles) -contains 'dsh-qq-bridge')
    if (-not ($okLink -and $okBundle)) { throw '写进去的字段读不回来' }
    Ok '已写进 profile/package.json（回读校验通过）'
  } catch {
    Copy-Item -LiteralPath $backupFile -Destination $pkgFile -Force
    Die "profile/package.json 写入校验失败，已还原备份：$($_.Exception.Message)"
  }

  Push-Location $profileDir
  try {
    & $nodeExe $pnpmMjs install --prefer-offline
    if ($LASTEXITCODE -ne 0) { Warn "profile 的 pnpm install 退出码 $LASTEXITCODE，插件可能加载不了" }
  } finally {
    Pop-Location
  }
  Ok '插件已链接'
}

# ── 7. 自启 ───────────────────────────────────────────────────────────
Title '7/7 开机自启'
# 默认不装：桥接离开 DSH 就没用，而 DSH 一启动插件会自己把桥接拉起来（0.2.6+）。
# 开机就把它拉起来，只会在 DSH 没开时反复起一个立刻退出的进程。
if (-not $Autostart) {
  Warn '默认不建开机自启：DSH 启动时插件会自己拉起桥接。'
  Warn '确实想随开机启动，加 -Autostart 再跑一次。'
} else {
  $autostartCmd = Join-Path $BridgeDir 'autostart.cmd'
  if (-not (Test-Path -LiteralPath $autostartCmd)) {
    Warn "没有 autostart.cmd，跳过自启"
  } else {
    $startup = [Environment]::GetFolderPath('Startup')
    $lnk = Join-Path $startup 'qq-bridge-autostart.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($lnk)
    $shortcut.TargetPath = $autostartCmd
    $shortcut.WorkingDirectory = $BridgeDir
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'qq-bridge 开机自启'
    $shortcut.Save()
    Ok "已加入启动项：$lnk"
  }
}

# ── 完成 ──────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host ''
Write-Host '接下来：'
Write-Host '  1. 打开 DSH -> 设置 -> QQ 桥接'
Write-Host '  2. 按「新手引导」一步步走：'
Write-Host '     装 SnowLuma -> 手机 QQ 扫码 -> 在 SnowLuma 里注入一次'
Write-Host '     -> 点「一键对接」-> 填管理员 QQ -> 加一个群或私聊'
Write-Host '  3. 点「发一条测试消息」，QQ 收到就说明通了'
Write-Host ''
Write-Host '如果设置里没有「QQ 桥接」：重启一次 DSH。' -ForegroundColor Yellow
