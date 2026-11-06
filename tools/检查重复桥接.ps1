# 查「这台机器上是不是装了两份 qq-bridge」。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File 检查重复桥接.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File 检查重复桥接.ps1 -Fix     # 把多余的那份挪走
#
# 为什么需要它：插件只认 127.0.0.1:3100，谁在听谁就算数。要是机器上有两份桥接、
# 各带一份 state，用户看到的现象是「消息有时候回有时候不回」「记忆像是丢了」——
# 其实是两个自己抢同一个 QQ。
#
# 默认**只看不动**。加 -Fix 才会把「不是当前在跑的那份」挪到旁边的
# <目录>.duplicate-<时间>，不删除，随时能挪回来。

param(
  [switch]$Fix
)

$ErrorActionPreference = 'Stop'

function Line($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text)   { Write-Host "  [ok]   $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  [注意] $text" -ForegroundColor Yellow }
function Bad($text)  { Write-Host "  [重复] $text" -ForegroundColor Red }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ── 1. 找出所有「看起来是桥接」的目录 ────────────────────────────────────
$candidates = New-Object System.Collections.Generic.List[string]

# 环境变量最优先（插件和启动脚本都认它）
if ($env:DSH_QQ_BRIDGE_ROOT) { $candidates.Add($env:DSH_QQ_BRIDGE_ROOT.Trim()) }

# 安装器写的标记文件：插件实际会用的就是这儿
$marker = Join-Path $env:USERPROFILE '.dsh\qq-bridge-path.json'
$marked = $null
if (Test-Path -LiteralPath $marker) {
  try {
    $marked = (Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json).path
    if ($marked) { $candidates.Add([string]$marked) }
  } catch {
    Warn "标记文件读不懂：$marker"
  }
}

foreach ($p in @(
  (Join-Path $env:USERPROFILE 'qq-bridge'),
  'C:\DSH\qq-bridge',
  'D:\DSH\qq-bridge',
  'E:\DSH\qq-bridge',
  (Join-Path $env:LOCALAPPDATA 'qq-bridge')
)) { if ($p) { $candidates.Add($p) } }

$found = @()
$seen = @{}
foreach ($dir in $candidates) {
  if (-not $dir) { continue }
  $full = try { [System.IO.Path]::GetFullPath($dir) } catch { $null }
  if (-not $full) { continue }
  $key = $full.TrimEnd('\').ToLowerInvariant()
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true

  $bridge = Join-Path $full 'src\bridge.js'
  if (-not (Test-Path -LiteralPath $bridge)) { continue }

  $stateDir = Join-Path $full 'state'
  $rolesDir = Join-Path $full 'roles'
  $config = Join-Path $full 'config.json'

  $stateFiles = 0
  if (Test-Path -LiteralPath $stateDir) {
    $stateFiles = @(Get-ChildItem -LiteralPath $stateDir -File -Force -ErrorAction SilentlyContinue).Count
  }
  $roles = 0
  if (Test-Path -LiteralPath $rolesDir) {
    $roles = @(Get-ChildItem -LiteralPath $rolesDir -File -Filter '*.md' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne 'README.md' }).Count
  }

  $configGroups = 0
  $configOwner = ''
  if (Test-Path -LiteralPath $config) {
    try {
      $cfg = Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.allow -and $cfg.allow.groups) { $configGroups = @($cfg.allow.groups).Count }
      if ($cfg.ownerQQ) { $configOwner = [string]$cfg.ownerQQ }
    } catch { }
  }

  $found += [pscustomobject]@{
    Path        = $full
    BridgeMtime = (Get-Item -LiteralPath $bridge).LastWriteTime
    ConfigTime  = if (Test-Path -LiteralPath $config) { (Get-Item -LiteralPath $config).LastWriteTime } else { $null }
    StateFiles  = $stateFiles
    Roles       = $roles
    Groups      = $configGroups
    OwnerQQ     = $configOwner
    Marked      = ($marked -and $full.TrimEnd('\') -ieq ([string]$marked).TrimEnd('\'))
  }
}

# ── 2. 谁真的在 3100 上跑 ────────────────────────────────────────────────
$running = $null
$conn = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $conn.OwningProcess) -ErrorAction SilentlyContinue
  $cmd = ''
  if ($proc -and $proc.CommandLine) { $cmd = [string]$proc.CommandLine }
  # 命令行里的 bridge.js 路径 → 目录
  $runningDir = ''
  $m = [regex]::Match($cmd, '([A-Za-z]:\\[^"\s]*?)[\\/]src[\\/]bridge\.js')
  if ($m.Success) { $runningDir = $m.Groups[1].Value }
  $running = [pscustomobject]@{
    Pid  = $conn.OwningProcess
    Cmd  = $cmd
    Dir  = $runningDir
  }
}

# ── 3. 报告 ──────────────────────────────────────────────────────────────
Line ''
Line '========== qq-bridge 安装情况 ==========' Cyan

if ($running) {
  Line ("  3100 上在跑：PID {0}" -f $running.Pid)
  if ($running.Dir) { Line ("  跑的是：{0}" -f $running.Dir) }
  else { Line '  跑的是：（命令行里没看出路径，可能是别的程序占着 3100）' }
} else {
  Line '  3100 上没有进程在听 —— 桥接没在跑'
}
Line ''

if ($found.Count -eq 0) {
  Warn '没找到任何 qq-bridge 目录。'
  Line ''
  Line '  可能装在别的地方。可以把插件状态页里的「桥接目录」贴过来。' DarkGray
  exit 0
}

foreach ($item in $found) {
  $isRunning = $running -and $running.Dir -and ($item.Path.TrimEnd('\') -ieq $running.Dir.TrimEnd('\'))
  $tag = if ($isRunning) { '正在运行' } elseif ($item.Marked) { '插件认为的' } else { '没在用' }
  Line ("  {0}" -f $item.Path) White
  Line ("      {0} | state {1} 个文件 | 人格卡 {2} 张 | 白名单群 {3} 个 | 管理员 {4}" -f $tag, $item.StateFiles, $item.Roles, $item.Groups, $(if ($item.OwnerQQ) { $item.OwnerQQ } else { '（没填）' }))
  Line ("      bridge.js 改动于 {0}；config.json 改动于 {1}" -f $item.BridgeMtime.ToString('yyyy-MM-dd HH:mm'), $(if ($item.ConfigTime) { $item.ConfigTime.ToString('yyyy-MM-dd HH:mm') } else { '（没有 config）' }))
  Line ''
}

# ── 4. 结论 ──────────────────────────────────────────────────────────────
if ($found.Count -eq 1) {
  Ok '只有一份，不会冲突。'
  if ($running -and $running.Dir -and ($found[0].Path.TrimEnd('\') -ine $running.Dir.TrimEnd('\'))) {
    Warn ('不过 3100 上跑的那份不是这个目录（{0}），说明还有一份没被扫到。把它的路径告诉我。' -f $running.Dir)
  }
  exit 0
}

Bad ("找到 {0} 份 qq-bridge，这就是冲突的根源。" -f $found.Count)
Line ''

# 该留哪一份：正在跑的 > 插件认为的 > state 文件最多的
$keep = $null
if ($running -and $running.Dir) {
  $keep = $found | Where-Object { $_.Path.TrimEnd('\') -ieq $running.Dir.TrimEnd('\') } | Select-Object -First 1
}
if (-not $keep) { $keep = $found | Where-Object { $_.Marked } | Select-Object -First 1 }
if (-not $keep) { $keep = $found | Sort-Object StateFiles -Descending | Select-Object -First 1 }

Line ("  建议保留：{0}" -f $keep.Path) Green
Line ("      （它的 state 有 {0} 个文件、人格卡 {1} 张 —— 她的记忆和历史在这儿）" -f $keep.StateFiles, $keep.Roles) DarkGray
Line ''

$extras = @($found | Where-Object { $_.Path.TrimEnd('\') -ine $keep.Path.TrimEnd('\') })
foreach ($item in $extras) {
  Line ("  多余的一份：{0}（state {1} 个文件）" -f $item.Path, $item.StateFiles) Yellow
}
Line ''

if (-not $Fix) {
  Line '  这次只是看看，没动任何东西。' Cyan
  Line ''
  Line '  要处理的话，二选一：' DarkGray
  Line '    · 自动：加 -Fix 再跑一次，会把多余的那份改名挪到旁边（不删，随时能改回来）' DarkGray
  Line '    · 手动：把上面「多余的一份」改名或删掉，保留建议保留的那份' DarkGray
  Line ''
  Line '  处理完再确认一次：' DarkGray
  Line ('    · qq-bridge-path.json 指向 {0}' -f $keep.Path) DarkGray
  Line '    · 只留一个桥接在跑（设置 → 灵犀 → 运行状态 → 重启桥接）' DarkGray
  exit 0
}

# ── 5. -Fix：挪走多余的（不删） ──────────────────────────────────────────
foreach ($item in $extras) {
  $isRunning = $running -and $running.Dir -and ($item.Path.TrimEnd('\') -ieq $running.Dir.TrimEnd('\'))
  if ($isRunning) {
    Warn ("跳过 {0}：它正在 3100 上跑，先停掉它再挪" -f $item.Path)
    continue
  }
  $dest = $item.Path.TrimEnd('\') + '.duplicate-' + $stamp
  try {
    Rename-Item -LiteralPath $item.Path -NewName (Split-Path $dest -Leaf) -ErrorAction Stop
    Ok ("已挪走：{0}  →  {1}" -f $item.Path, $dest)
    Line '      （没删除，确认没问题后自己删这个 .duplicate- 目录就行）' DarkGray
  } catch {
    Warn ("挪不动：{0} —— {1}" -f $item.Path, $_.Exception.Message)
    Line '      多半是还有进程占着它，先结束那个进程再来。' DarkGray
  }
}

# 标记文件指回保留的那份
if ($marker) {
  try {
    $json = @{ path = $keep.Path } | ConvertTo-Json
    Set-Content -LiteralPath $marker -Value $json -Encoding UTF8
    Ok ("qq-bridge-path.json 已指向 {0}" -f $keep.Path)
  } catch {
    Warn ("qq-bridge-path.json 写不进去：{0}" -f $_.Exception.Message)
  }
}

Line ''
Line '  最后一步：重启一次桥接，让插件连上剩下的那份。' Cyan
Line '  设置 → 灵犀 · QQ 桥接 → 运行状态 → 重启桥接' DarkGray