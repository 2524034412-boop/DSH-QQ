/**
 * 检查更新 / 一键打补丁。
 *
 * 约定（发布方要照这个来）：
 *   - 一个仓库里可能放着好几个插件（比如星图开机也在里面），所以 release 的 tag 必须带前缀：
 *       qq-bridge-v0.3.1
 *   - release 里必须挂一个资产：
 *       dsh-qq-bridge-0.3.1.zip
 *     它的根目录就是插件根：package.json、lib/、docs/、locale/、cordis.patch.yml、README.md
 *   - 更新说明写在 release 正文里，会原样显示在设置页。
 *
 * 只替换**设置页插件**（这个包）。桥接本体（D:\DSH\qq-bridge）体积大、还带着用户数据，
 * 不在这里动 —— 那种更新走安装包。
 *
 * 安全线：
 *   - 解压出来的路径必须在临时目录里面（防 zip-slip）
 *   - 覆盖之前先把当前插件整份备份到插件目录旁边的 .backup/ 下
 *   - 只覆盖 package.json / cordis.patch.yml / README.md / lib / docs / locale，不删别的
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import tls from 'node:tls'

/**
 * 把系统根证书并进 Node 的信任链。
 *
 * 为什么非做不可：这台机器上 Node 自带的 CA 包认不出 GitHub 的证书
 * （`UNABLE_TO_VERIFY_LEAF_SIGNATURE`，通常是中间有个安全软件/代理在换证书），
 * 结果是「检查更新」永远报 fetch failed —— 功能看着在、其实一次也没成过。
 * 命令行可以加 `--use-system-ca`，但插件跑在 DSH 进程里，加不了启动参数，
 * 只能在代码里合并。Node 22+/24 提供这两个 API；老版本就静静跳过，行为跟以前一样。
 */
let caMerged = false
function trustSystemCertificates() {
  if (caMerged) return
  caMerged = true
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return
    const merged = [...tls.getCACertificates('default'), ...tls.getCACertificates('system')]
    tls.setDefaultCACertificates([...new Set(merged)])
  } catch {
    /* 拿不到系统证书库（权限、平台差异）就照旧用内置的 */
  }
}
trustSystemCertificates()

/**
 * 更新源要用户自己填（这个项目还没开源，各家仓库也不一样）。
 * 优先级：环境变量 > 本地配置文件 > 空（= 没配，不检查）。
 */
const CONFIG_FILE_NAME = 'dsh-qq-bridge-update.json'

/** 认识的文件/目录名（多一个都不覆盖）。 */
const COPY_ENTRIES = ['package.json', 'cordis.patch.yml', 'README.md', 'lib', 'docs', 'locale']
const ASSET_PATTERN = /^dsh-qq-bridge-.*\.zip$/i
const TAG_PATTERN = /^qq-bridge-v?/i
const MAX_ASSET_BYTES = 30 * 1024 * 1024

/** 缓存放这里：设置页每次打开都会问一遍，别把 GitHub 的额度打光。 */
let cache = { at: 0, data: null }

export function updateConfig(selfDir) {
  const saved = readSavedConfig()
  const fromEnv = (process.env.DSH_QQ_BRIDGE_REPO || '').trim()
  const repo = fromEnv !== '' ? fromEnv : String(saved.repo || '').trim()
  const api = (process.env.DSH_QQ_BRIDGE_UPDATE_API || saved.api || 'https://api.github.com').replace(/\/+$/, '')
  return {
    repo,
    api,
    configured: repo !== '',
    selfDir: resolve(process.env.DSH_QQ_BRIDGE_SELF_DIR || selfDir)
  }
}

/** 保存更新源的小文件：%USERPROFILE%\.dsh\dsh-qq-bridge-update.json */
function configFile() {
  const fromEnv = (process.env.DSH_QQ_BRIDGE_UPDATE_CONFIG || '').trim()
  if (fromEnv !== '') return resolve(fromEnv)
  return join(process.env.USERPROFILE ?? '', '.dsh', CONFIG_FILE_NAME)
}

function readSavedConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 记住「去哪个仓库找更新」。填一次就行，后面点检查更新都用它。
 * 只校验格式（owner/repo），不在这里联网验证——存下来，查的时候自然会知道对不对。
 */
export function setRepo(repo) {
  const clean = String(repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '')
  if (clean !== '' && !/^[\w.-]+\/[\w.-]+$/.test(clean)) {
    throw new Error('要写成「用户名/仓库名」，比如 yourname/qq-bridge')
  }
  const file = configFile()
  const next = { ...readSavedConfig(), repo: clean }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + Date.now()
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, file)
  cache = { at: 0, data: null }
  return { ok: true, repo: clean, configured: clean !== '' }
}

/** 宽松的版本比较：0.3.0 vs 0.3.1，认 v 前缀，非数字段按字符串比。 */
export function compareVersions(a, b) {
  const split = (value) => String(value).replace(/^v/i, '').split(/[.+-]/).filter((part) => part !== '')
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const one = left[index]
    const two = right[index]
    if (one === undefined) return -1
    if (two === undefined) return 1
    const oneNumber = /^\d+$/.test(one) ? Number(one) : NaN
    const twoNumber = /^\d+$/.test(two) ? Number(two) : NaN
    if (Number.isFinite(oneNumber) && Number.isFinite(twoNumber)) {
      if (oneNumber !== twoNumber) return oneNumber < twoNumber ? -1 : 1
      continue
    }
    if (one !== two) return one < two ? -1 : 1
  }
  return 0
}

/** 从 release 里挑出这个插件的资产和版本号；不是我们的 release 就返回 null。 */
export function pickRelease(releases) {
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release === null || typeof release !== 'object') continue
    const assets = Array.isArray(release.assets) ? release.assets : []
    const asset = assets.find((item) => item && typeof item.name === 'string' && ASSET_PATTERN.test(item.name))
    if (asset === undefined) continue
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    const fromTag = TAG_PATTERN.test(tag) ? tag.replace(TAG_PATTERN, '') : ''
    const fromAsset = String(asset.name).replace(/^dsh-qq-bridge-/i, '').replace(/\.zip$/i, '')
    const version = fromTag !== '' ? fromTag : fromAsset
    if (version === '') continue
    return {
      version,
      tag,
      name: typeof release.name === 'string' ? release.name : tag,
      body: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
      url: typeof release.html_url === 'string' ? release.html_url : '',
      publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
      asset: {
        name: asset.name,
        size: Number(asset.size) || 0,
        url: String(asset.browser_download_url || asset.url || '')
      }
    }
  }
  return null
}

/** 请求头。私有仓库或撞到限流时，可以用环境变量给一个 token（默认不带）。 */
function githubHeaders() {
  const headers = { 'user-agent': 'dsh-qq-bridge', accept: 'application/vnd.github+json' }
  const token = String(process.env.DSH_QQ_BRIDGE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim()
  if (token !== '') headers.authorization = 'Bearer ' + token
  return headers
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: githubHeaders() })
    if (response.status === 404) throw new Error('仓库或发布页不存在（404）：' + url)
    if (response.status === 403 || response.status === 429) {
      throw new Error('GitHub 限流了（403）：过一会儿再试，或者去 Release 页面手动下载')
    }
    if (!response.ok) throw new Error('GitHub 返回 ' + response.status)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function offlineResult(current, config, error) {
  return {
    ok: true,
    enabled: true,
    configured: true,
    current,
    repo: config.repo,
    latest: '',
    behind: false,
    canInstall: false,
    checked: false,
    error: String(error?.message ?? error)
  }
}

/**
 * 问 GitHub 有没有新版。refresh=true 时忽略缓存。
 * 永远返回对象（不抛）：设置页不该因为没网就红一片。
 */
export async function checkForUpdate({ current, selfDir, refresh = false, timeoutMs = 12000 }) {
  const config = updateConfig(selfDir)
  if (config.configured === false) {
    return {
      ok: true,
      enabled: false,
      configured: false,
      current,
      repo: '',
      latest: '',
      behind: false,
      canInstall: false,
      checked: false,
      error: '还没设置更新仓库：填一下「用户名/仓库名」（比如 yourname/qq-bridge），我才能去查新版本'
    }
  }
  const now = Date.now()
  if (!refresh && cache.data !== null && now - cache.at < 60 * 1000 && cache.data.repo === config.repo) {
    return cache.data
  }
  try {
    const releases = await fetchJson(config.api + '/repos/' + config.repo + '/releases?per_page=100', timeoutMs)
    const found = pickRelease(releases)
    if (found === null) {
      const empty = {
        ok: true,
        enabled: true,
        configured: true,
        current,
        repo: config.repo,
        latest: '',
        behind: false,
        canInstall: false,
        checked: true,
        error: '这个仓库还没有 qq-bridge 的发布包（tag 要以 qq-bridge-v 开头，并挂 dsh-qq-bridge-<版本>.zip）'
      }
      cache = { at: now, data: empty }
      return empty
    }
    const behind = compareVersions(found.version, current) > 0
    const result = {
      ok: true,
      enabled: true,
      configured: true,
      current,
      repo: config.repo,
      latest: found.version,
      behind,
      canInstall: behind && found.asset.url !== '' && found.asset.size <= MAX_ASSET_BYTES,
      checked: true,
      name: found.name,
      notes: found.body,
      url: found.url,
      publishedAt: found.publishedAt,
      asset: { name: found.asset.name, size: found.asset.size, url: found.asset.url }
    }
    cache = { at: now, data: result }
    return result
  } catch (error) {
    // 没网 / 限流：给个能看懂的话，并且不缓存（下次打开重试）
    return offlineResult(current, config, error)
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 解压：Windows 自带的 bsdtar 认识 zip，不引第三方依赖。 */
function unzip(file, outDir) {
  const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  const useTar = existsSync(tar)
  const args = useTar ? ['-xf', file, '-C', outDir] : ['-xf', file, '-C', outDir]
  const command = useTar ? tar : 'tar'
  const result = spawnSync(command, args, { windowsHide: true, encoding: 'utf8' })
  if (result.error) throw new Error('解压失败：找不到 tar（' + String(result.error.message) + '）')
  if (result.status !== 0) throw new Error('解压失败：' + String(result.stderr || result.stdout || '').trim().slice(0, 300))
}

/** 防 zip-slip：解出来的每个文件都必须在目录里面。 */
function assertInside(root, target) {
  const base = realpathSync(root)
  const path = realpathSync(target)
  if (path !== base && !path.startsWith(base + sep)) throw new Error('压缩包里有越界路径：' + target)
}

async function download(url, file, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: githubHeaders() })
    if (!response.ok) throw new Error('下载补丁包失败：HTTP ' + response.status)
    const buffer = Buffer.from(await response.arrayBuffer())
    writeFileSync(file, buffer)
    return buffer.length
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载并装上最新补丁包。只动设置页插件，装完要重启 DSH 才生效。
 */
export async function applyUpdate({ current, selfDir, timeoutMs = 60000 }) {
  const config = updateConfig(selfDir)
  if (!existsSync(join(config.selfDir, 'package.json'))) {
    throw new Error('找不到插件目录：' + config.selfDir)
  }
  const info = await checkForUpdate({ current, selfDir: config.selfDir, refresh: true, timeoutMs })
  if (info.enabled === false) throw new Error(info.error || '没配置更新源')
  if (info.checked !== true) throw new Error(info.error || '检查更新失败')
  if (info.latest === '') throw new Error(info.error || '没有可用的补丁包')
  if (info.behind !== true) throw new Error('已经是最新版（' + current + '）')
  if (!info.canInstall) throw new Error('这个版本的补丁包太大或没有下载地址，请去 Release 页面手动下载')

  const work = mkdtempSync(join(tmpdir(), 'qbu-'))
  const zipFile = join(work, 'patch.zip')
  const outDir = join(work, 'out')
  mkdirSync(outDir, { recursive: true })

  try {
    const bytes = await download(info.asset.url, zipFile, timeoutMs)
    if (bytes > MAX_ASSET_BYTES) throw new Error('补丁包太大（' + Math.round(bytes / 1024 / 1024) + ' MB）')
    unzip(zipFile, outDir)

    for (const entry of readdirSync(outDir)) assertInside(outDir, join(outDir, entry))

    // 有些发布方式会把文件包一层目录，往下找一层。
    let root = outDir
    if (!existsSync(join(root, 'package.json'))) {
      const children = readdirSync(outDir).filter((name) => statSync(join(outDir, name)).isDirectory())
      const nested = children.find((name) => existsSync(join(outDir, name, 'package.json')))
      if (nested === undefined) throw new Error('补丁包里没有 package.json，不是这个插件的包')
      root = join(outDir, nested)
    }

    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (manifest.name !== 'dsh-qq-bridge') throw new Error('补丁包属于别的插件：' + String(manifest.name))
    if (!existsSync(join(root, 'lib', 'index.js'))) throw new Error('补丁包里缺 lib/index.js')
    if (compareVersions(manifest.version, info.latest) !== 0) {
      throw new Error('补丁包版本（' + manifest.version + '）和发布信息（' + info.latest + '）对不上')
    }

    // 先整份备份当前插件，出问题能一键恢复。
    const parent = dirname(config.selfDir)
    const backupDir = join(parent, '.backup')
    mkdirSync(backupDir, { recursive: true })
    const backup = join(backupDir, 'dsh-qq-bridge-' + current + '-' + stamp())
    cpSync(config.selfDir, backup, {
      recursive: true,
      force: true,
      filter: (source) => !source.includes(sep + 'node_modules') && !source.includes(sep + '.git')
    })

    for (const entry of COPY_ENTRIES) {
      const from = join(root, entry)
      if (!existsSync(from)) continue
      cpSync(from, join(config.selfDir, entry), { recursive: true, force: true })
    }

    cache = { at: 0, data: null }
    return {
      ok: true,
      from: current,
      to: info.latest,
      backup,
      restartRequired: true,
      note: '补丁已装好，重启 DSH 生效'
    }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* 临时文件清不掉不影响结果 */ }
  }
}
