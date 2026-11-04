# Weekly backup of the DSH data (NOT the 17 GB TTS models / Chromium profile).
# Output: D:\DSH\存档\dsh-YYYYMMDD-HHmm.zip — keeps the newest 3; the oldest is
# deleted as soon as a new one lands, so the folder never grows past 3 snapshots.
# Saved as UTF-8 with BOM because the destination path contains Chinese.
$ErrorActionPreference = 'Stop'

$root = 'D:\DSH'
$dest = Join-Path $root '存档'
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }

$stamp = (Get-Date).ToString('yyyyMMdd-HHmm')
$zip = Join-Path $dest ("dsh-" + $stamp + ".zip")
$stage = Join-Path $env:TEMP ("dshbak-" + $stamp)
New-Item -ItemType Directory -Path $stage -Force | Out-Null

function Copy-Tree($src, $name) {
  if (-not (Test-Path $src)) { return }
  $target = Join-Path $stage $name
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Copy-Item -Path (Join-Path $src '*') -Destination $target -Recurse -Force -ErrorAction SilentlyContinue
}

# 1) qq-bridge: code, roles, prompts, media, config
foreach ($part in @('src', 'scripts', 'roles', 'public')) {
  Copy-Tree (Join-Path $root "qq-bridge\$part") "qq-bridge\$part"
}
foreach ($f in @('config.json')) {
  $p = Join-Path $root "qq-bridge\$f"
  if (Test-Path $p) {
    New-Item -ItemType Directory -Path (Join-Path $stage 'qq-bridge') -Force | Out-Null
    Copy-Item $p (Join-Path $stage "qq-bridge\$f") -Force
  }
}

# 2) state: memory / relations / transcripts. Skip the 497 MB Chromium profile and logs.
$stateSrc = Join-Path $root 'qq-bridge\state'
$stateDst = Join-Path $stage 'qq-bridge\state'
if (Test-Path $stateSrc) {
  New-Item -ItemType Directory -Path $stateDst -Force | Out-Null
  robocopy $stateSrc $stateDst /E /XD edge-app-profile /XF *.log *.log.1 *.jsonl *.jsonl.1 *.tmp /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with $LASTEXITCODE" }
}

# 3) panel plugin + top-level docs (persona cards, handoff notes)
Copy-Tree (Join-Path $root 'panel-plugin') 'panel-plugin'
Get-ChildItem -Path $root -File -Filter *.md -ErrorAction SilentlyContinue | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $stage $_.Name) -Force
}

# 3b) 星图开机插件（源）+ 发布包 + profile 清单。
#     插件源码住在 %USERPROFILE%\.dsh\plugins\，不在 D:\DSH 下，所以要单独收。
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$pluginSrc = Join-Path $dshHome 'plugins\dsh-star-boot'
if (Test-Path $pluginSrc) {
  Copy-Tree $pluginSrc 'plugins\dsh-star-boot'
}

# 发布目录：分享用的 zip 与打包脚本
$release = Join-Path $root '发布'
if (Test-Path $release) {
  $releaseDst = Join-Path $stage 'release'
  New-Item -ItemType Directory -Path $releaseDst -Force | Out-Null
  Copy-Item (Join-Path $release '*') $releaseDst -Recurse -Force -ErrorAction SilentlyContinue
}

# profile 的两份清单：出问题时靠它们还原 bundles / patch
$profileDir = Join-Path $dshHome 'profiles\desktop'
if (Test-Path $profileDir) {
  $profileDst = Join-Path $stage 'profiles\desktop'
  New-Item -ItemType Directory -Path $profileDst -Force | Out-Null
  foreach ($name in @('package.json', 'cordis.patch.yml')) {
    $file = Join-Path $profileDir $name
    if (Test-Path $file) { Copy-Item $file (Join-Path $profileDst $name) -Force }
  }
  $latestBak = Get-ChildItem $profileDir -Filter 'package.json.bak-*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latestBak) { Copy-Item $latestBak.FullName (Join-Path $profileDst $latestBak.Name) -Force }
}

# 4) tts scripts/config only (the 17 GB of models is out of scope)
$ttsSrc = Join-Path $root 'tts'
if (Test-Path $ttsSrc) {
  $ttsDst = Join-Path $stage 'tts'
  New-Item -ItemType Directory -Path $ttsDst -Force | Out-Null
  Get-ChildItem -Path $ttsSrc -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.py', '.ps1', '.cmd', '.bat', '.json', '.md', '.txt', '.yaml', '.yml' } |
    ForEach-Object { Copy-Item $_.FullName (Join-Path $ttsDst $_.Name) -Force }
}

# 5) zip + cleanup
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal -Force
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)

# 6) keep the newest 3 archives — the oldest leaves as soon as a new one is written
$old = Get-ChildItem $dest -Filter 'dsh-*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3
foreach ($f in $old) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }

$line = "[{0}] {1}  {2} MB  (kept {3})" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), (Split-Path $zip -Leaf), $mb, (@(Get-ChildItem $dest -Filter 'dsh-*.zip').Count)
Add-Content -Path (Join-Path $dest 'backup.log') -Value $line -Encoding UTF8
Write-Output $line
