/**
 * dsh-qq-bridge —— 宿主那一半（Node 侧）。
 *
 * 它不碰桥接的代码，只做三件事：
 *   1. 读桥接的 config.json / state/current-role.json，把白名单和角色暴露给设置页；
 *   2. 探活 127.0.0.1:3100，把「QQ / SnowLuma / OneBot / DSH」四个灯的数据取回来；
 *   3. 点按钮时跑它现成的脚本（对齐端口 = 重启桥接），或者替它发一条测试消息。
 *
 * 安全约定：
 *   - 每一条路由单独 try/catch。一个路由注册不上，绝不能让整个条目「未激活」——
 *     DSH 把未激活当致命错误，会直接崩启动（2026-11-02 连 profile 都被重置过）。
 *   - 写 config.json 之前先备份，写的时候用临时文件 + rename，半截断电不会留下坏 JSON。
 *
 * @module dsh-qq-bridge
 */

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { applyUpdate, checkForUpdate, setRepo } from './update.js'

export const name = 'qq-bridge'

const ROUTE_BASE = '/dsh-qq-bridge'

/** 插件版本。status 和 /api 都报这一个，别再各写各的。 */
const PLUGIN_VERSION = '0.4.4'

/** 这个插件自己的目录（被「检查更新」覆盖的就是它）。 */
const SELF_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** 浏览器那一半声明的卡片扩展槽。名字写在这里，别处只许引用。 */
const CARD_SLOT = 'settings.qq-bridge.card'

/** 桥接装在哪。环境变量 > 路径标记文件 > 常见位置。 */
let rootCache = { value: null, at: 0 }

function resolveBridgeRoot() {
  const fromEnv = process.env.DSH_QQ_BRIDGE_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())

  const marker = join(process.env.USERPROFILE ?? '', '.dsh', 'qq-bridge-path.json')
  const fromMarker = readJson(marker, null)
  if (fromMarker !== null && typeof fromMarker.path === 'string' && fromMarker.path.trim() !== '') {
    const candidate = resolve(fromMarker.path.trim())
    if (existsSync(join(candidate, 'src', 'bridge.js'))) return candidate
  }

  const home = process.env.USERPROFILE ?? ''
  const candidates = [
    'D:\\DSH\\qq-bridge',
    'C:\\DSH\\qq-bridge',
    'E:\\DSH\\qq-bridge',
    join(home, 'qq-bridge'),
    join(home, '.dsh', 'qq-bridge'),
    join(process.env.LOCALAPPDATA ?? '', 'qq-bridge')
  ]
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(join(candidate, 'src', 'bridge.js'))) return resolve(candidate)
  }
  return 'D:\\DSH\\qq-bridge'
}

function bridgeRoot() {
  const now = Date.now()
  if (rootCache.value === null || now - rootCache.at > 30000) {
    rootCache = { value: resolveBridgeRoot(), at: now }
  }
  return rootCache.value
}

const CONFIG_FILE = () => join(bridgeRoot(), 'config.json')
const STATE_DIR = () => join(bridgeRoot(), 'state')
const ROLE_STATE = () => join(STATE_DIR(), 'current-role.json')
const ROLES_DIR = () => join(bridgeRoot(), 'roles')
const TOKEN_FILE = () => join(STATE_DIR(), 'console-token')

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写：先写 .tmp 再 rename；调用方负责先备份。 */
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolveBody) => {
    let size = 0
    let overflow = false
    const chunks = []
    req.on('data', (chunk) => {
      if (overflow) return
      size += chunk.length
      if (size > limit) {
        // 不 destroy：连接被我们自己掐断时，调用方还会往这个 res 写 400，
        // 那会变成 write-after-destroy。这里只停止收集，让流自己读完再回 null。
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) return resolveBody(null)
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') return resolveBody({})
      try {
        resolveBody(JSON.parse(text))
      } catch {
        resolveBody(null)
      }
    })
    req.on('error', () => resolveBody(null))
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/** 直接把文件丢回去（语音试听用）。 */
function sendFile(res, file, type) {
  try {
    const data = readFileSync(file)
    res.writeHead(200, {
      'content-type': type,
      'content-length': data.length,
      'cache-control': 'no-store'
    })
    res.end(data)
  } catch (error) {
    sendJson(res, 404, { ok: false, error: '读不到音频文件：' + String(error?.message ?? error) })
  }
}

function audioTypeOf(file) {
  const lower = String(file).toLowerCase()
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.m4a')) return 'audio/mp4'
  return 'audio/wav'
}

/**
 * 写操作的同源校验。
 *
 * 这些路由挂在 DSH 的 HTTP 服务上，没有它自己的登录令牌，本机别的程序也能打。
 * 浏览器发起的 POST 一定会带 Origin（或至少 Referer），所以只放行两种：
 *   1. 完全没有 Origin/Referer 的请求——那是本机的脚本（node/curl），不是网页；
 *   2. Origin 的 host 是 127.0.0.1 / localhost。
 * 这样别的网站用 fetch 打进来会被 403 掉，本机工具不受影响。
 */
function sameOrigin(req) {
  const raw = req.headers.origin ?? req.headers.referer ?? ''
  if (raw === '') return true
  try {
    const url = new URL(String(raw))
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

function blockCrossOrigin(req, res) {
  if (sameOrigin(req)) return false
  sendJson(res, 403, { ok: false, error: '跨站请求被拒绝（只接受 DSH 同源页面）' })
  return true
}

/** 这个插件装没装：先看插件目录，再看 profile 的依赖。 */
function pluginInstalled(name) {
  const home = process.env.USERPROFILE ?? ''
  if (home !== '' && existsSync(join(home, '.dsh', 'plugins', name))) return true
  const pkg = readJson(join(home, '.dsh', 'profiles', 'desktop', 'package.json'), null)
  const deps = pkg?.dependencies ?? {}
  return Object.prototype.hasOwnProperty.call(deps, name)
}

/** 3100 通不通（TCP 层，2 秒）。 */
function portOpen(port, timeout = 2000) {
  return new Promise((resolveOpen) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolveOpen(value)
    }
    import('node:net').then(({ connect }) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.setTimeout(timeout)
      socket.once('connect', () => {
        socket.destroy()
        done(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
        done(false)
      })
      socket.once('error', () => done(false))
    }).catch(() => done(false))
  })
}

function consoleToken() {
  try {
    return readFileSync(TOKEN_FILE(), 'utf8').trim()
  } catch {
    return ''
  }
}

/** 调桥接自己的接口（只走 127.0.0.1，带控制台令牌）。 */
async function bridgeFetch(path, init = {}, timeoutMs = 8000) {
  const token = consoleToken()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('http://127.0.0.1:3100' + path, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
        ...(token !== '' ? { 'x-console-token': token } : {})
      }
    })
    const text = await response.text()
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text.slice(0, 2000) }
    }
    return { status: response.status, ok: response.ok, data }
  } catch (error) {
    return { status: 0, ok: false, data: { error: String(error?.message ?? error) } }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 没有 config.json 就先按示例生成一份。
 *
 * 桥接的 loadConfig() 在缺文件时是**抛错**（不是用默认值跑），align-dsh-port.mjs 也只会
 * 报「读不到 config.json」。所以全新安装后如果没人点「从示例创建配置」，桥接永远起不来，
 * 用户看到的就是「桥接没有在运行」。这里把这一步自动化，日志里会说明白。
 */
function ensureConfigFromExample() {
  const root = bridgeRoot()
  const config = join(root, 'config.json')
  if (existsSync(config)) return false
  const example = join(root, 'config.example.json')
  if (!existsSync(example)) return false
  try {
    copyFileSync(example, config)
    console.log('[dsh-qq-bridge] 没有 config.json，已按 config.example.json 生成一份（管理员和白名单还是空的）')
    return true
  } catch (error) {
    console.error('[dsh-qq-bridge] 按示例生成 config.json 失败', error)
    return false
  }
}

/** 用哪个 node 去跑桥接脚本：DSH 自带的运行时优先，不用 Electron 本体。 */
function nodeRuntime() {
  const explicit = (process.env.DSH_NODE || '').trim()
  if (explicit !== '' && existsSync(explicit)) return explicit
  const base = join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-runtimes')
  try {
    for (const name of readdirSync(base)) {
      const candidate = join(base, name, 'dependencies', 'node', 'bin', 'node.exe')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* 没这个目录就用回退 */
  }
  // 最后才退回 process.execPath（Electron 以 node 模式跑）；这样桥接会显示成 DSH 进程，
  // 对齐脚本按进程名找旧桥接时就会漏掉 —— 所以能找 node 就一定用 node。
  return process.execPath
}

/**
 * 在后台把桥接拉起来（脚本会先把 DSH 的新端口写进 config，再启动）。
 * 分离进程 + unref：DSH 退出时它不会跟着被带走，看门狗和计划任务都能接住。
 */
function spawnBridgeAlign() {
  const root = bridgeRoot()
  const script = join(root, 'scripts', 'align-dsh-port.mjs')
  if (!existsSync(script)) return false
  // 没有配置就没有桥接：先把这一步补上，别让拉起脚本空跑一趟。
  ensureConfigFromExample()
  try {
    const child = spawn(nodeRuntime(), [script], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    return true
  } catch (error) {
    console.error('[dsh-qq-bridge] 拉起桥接失败', error)
    return false
  }
}

/**
 * config.json 里记着的那个 DSH 端口，现在还有人听吗。
 *
 * 这是判断「桥接是不是连错了地址」最省事的办法：DSH 每次重启会换端口，
 * 旧端口立刻没人听。反过来，旧端口还活着就说明 DSH 没换地址（或者又抽中同一个），
 * 那不该去动桥接。读不懂地址就当「还活着」——宁可不动，也不要反复重启人家的桥接。
 */
async function configuredDshPortAlive(config) {
  const url = config?.dsh?.baseUrl
  if (typeof url !== 'string' || url.trim() === '') return true
  let port = 0
  try {
    port = Number(new URL(url.trim()).port)
  } catch {
    return true
  }
  if (!Number.isFinite(port) || port <= 0) return true
  return portOpen(port, 800)
}

/**
 * DSH 一退出，桥接就会跟着退（它盯的是 DSH 的事件流，流断就收工）。
 * 而看门狗 10 分钟才巡一次 —— 中间这段时间，用户看到的就是「桥接没有在运行」。
 * 所以宿主每次加载都主动看一眼，两种情况都要管：
 *
 *   1. 桥接没在跑 → 后台拉起来（会先对齐端口）；
 *   2. 桥接在跑，但它认的 DSH 端口已经没人听了 → DSH 重启换了端口，
 *      那盏「DSH 灯」会一直红着，片头和设置页都会显示「待修」。
 *      这就是 2026-11-05 早上那次：桥接好好的，只有 dsh:false，
 *      而旧逻辑「端口在听就什么都不做」正好绕过了它。
 */
async function maybeAutoStartBridge() {
  if (process.env.DSH_QQ_BRIDGE_NO_AUTOSTART === '1') return
  try {
    const config = readConfig()
    if (config !== null && config.autoStartBridge === false) return
    if (!existsSync(join(bridgeRoot(), 'src', 'bridge.js'))) return

    if (!(await portOpen(3100, 1500))) {
      if (spawnBridgeAlign()) {
        console.log('[dsh-qq-bridge] 桥接没在跑，已在后台拉起（会先对齐 DSH 端口）')
      }
      return
    }

    // 在跑，但连的是上一代 DSH 地址 —— 重启一次就好，不然那盏灯永远红着。
    if (await configuredDshPortAlive(config)) return
    if (spawnBridgeAlign()) {
      console.log('[dsh-qq-bridge] 桥接认的 DSH 端口已经变了，正在重新对齐')
    }
  } catch (error) {
    console.error('[dsh-qq-bridge] 自动拉起桥接时出错', error)
  }
}

/* ---------- 配置 ---------- */

function readConfig() {
  return readJson(CONFIG_FILE(), null)
}

function publicConfig(config) {
  if (config === null || typeof config !== 'object') return null
  const allow = config.allow ?? {}
  const asList = (value) => (Array.isArray(value) ? value.map((item) => String(item)) : [])
  return {
    ownerQQ: config.ownerQQ === undefined ? '' : String(config.ownerQQ),
    allow: { private: asList(allow.private), groups: asList(allow.groups) },
    allowAllWhenEmpty: config.allowAllWhenEmpty === true,
    ackMessage: typeof config.ackMessage === 'string' ? config.ackMessage : '',
    hideConsolePages: config.hideConsolePages === true,
    role: readJson(ROLE_STATE(), { role: '', mode: '' })
  }
}

/* ---------- 角色 ---------- */

function sanitizeRole(name) {
  const value = String(name ?? '').trim()
  if (value === '' || value.length > 40) return ''
  if (value.includes('..') || /[\\/:*?"<>|]/.test(value)) return ''
  return value
}

function listRoles() {
  const dir = ROLES_DIR()
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => {
        const fileBase = entry.name.slice(0, -3)
        if (fileBase.toLowerCase() === 'readme') return null
        let bytes = 0
        try {
          bytes = readFileSync(join(dir, entry.name)).length
        } catch {
          bytes = 0
        }
        return { name: fileBase, bytes }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  } catch {
    return []
  }
}

/* ---------- 开关与参数（白名单，只碰这些路径） ---------- */

const FLAGS = {
  'social.enabled': { group: '社交', label: '一代自动回复', hint: 'reserved 模式下按概率接话' },
  'socialV2.enabled': { group: '社交', label: '二代自动回复', hint: 'reserved2 模式下按工具协议行动' },
  'social.proactiveEnabled': { group: '社交', label: '主动搭话', hint: '没人说话时自己起话题' },
  'socialV2.voice.enabled': { group: '表达', label: '语音', hint: '允许发语音条' },
  'socialV2.sticker.enabled': { group: '表达', label: '表情包', hint: '允许用收藏的表情' },
  'socialV2.sticker.collect.enabled': { group: '表达', label: '偷表情', hint: '允许收藏别人发的表情' },
  'slang.enabled': { group: '学习', label: '学梗', hint: '从群聊里提取黑话' },
  'socialV2.biliDigest.enabled': { group: '学习', label: '刷B站摘要', hint: '每天把刷到的视频带进上下文' },
  'security.interceptNotify': { group: '安全', label: '拦截通知', hint: '拦下危险消息时告诉你' },
  'hideConsolePages': { group: '安全', label: '隐藏旧控制台', hint: '默认开启，只关 /panel 那个旧控制台；总控可视化面板 /dashboard 和记忆星图 /memory 一直可用' },
  'autoStartBridge': { group: '运行', label: 'DSH 启动时自动拉起桥接', hint: '默认开启。DSH 一退出桥接就会跟着退，关了就得自己点「重启桥接」' }
}

/** 这几个开关「config 里没写」等于开（默认开），取反判断。 */
const DEFAULT_TRUE_FLAGS = new Set(['hideConsolePages', 'autoStartBridge'])

const NUMBERS = {
  'role.maxInjectChars': { group: '人格', label: '人格注入上限', min: 1000, max: 20000, step: 500, unit: '字符' },
  'sendDelayMs': { group: '发送', label: '发送延迟', min: 0, max: 5000, step: 100, unit: 'ms' },
  'questionTimeoutMs': { group: '发送', label: '提问等待', min: 5000, max: 600000, step: 5000, unit: 'ms' },
  'socialV2.voice.maxPerMinute': { group: '表达', label: '语音上限', min: 0, max: 20, step: 1, unit: '条/分' },
  'socialV2.biliDigest.maxItems': { group: '学习', label: '每次带几条视频', min: 1, max: 10, step: 1, unit: '条' },
  'socialV2.voice.maxSeconds': { group: '语音', label: '语音最长', min: 5, max: 300, step: 5, unit: '秒' },
  'socialV2.voice.params.speed_factor': { group: '语音', label: '语速', min: 0.5, max: 2, step: 0.05, unit: '倍' },
  'social.triggerProbability': { group: '概率', label: '接话概率', min: 0, max: 1, step: 0.05, unit: '' },
  'social.proactiveProbability': { group: '概率', label: '主动概率', min: 0, max: 0.5, step: 0.05, unit: '' }
}

const STRINGS = {
  ackMessage: { group: '发送', label: '收到确认语', max: 60, placeholder: '收到消息时先回的那句，留空就不回' }
}

const ENUMS = {
  'socialV2.voice.engine': {
    group: '语音',
    label: '引擎',
    options: [
      { value: 'gptsovits', label: 'GPT-SoVITS（本地）' },
      { value: 'edge', label: 'Edge TTS（在线）' }
    ]
  },
  'socialV2.voice.edgeVoice': {
    group: '语音',
    label: '音色',
    options: [
      { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔' },
      { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼' },
      { value: 'zh-CN-YunxiNeural', label: '云希 · 男声' },
      { value: 'zh-CN-YunjianNeural', label: '云健 · 热血' },
      { value: 'zh-CN-YunyangNeural', label: '云扬 · 播音' },
      { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北' },
      { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西' }
    ]
  }
}

function getPath(object, dotted) {
  let node = object
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

function setPath(object, dotted, value) {
  const parts = dotted.split('.')
  let node = object
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index]
    if (node[part] === null || typeof node[part] !== 'object') node[part] = {}
    node = node[part]
  }
  node[parts[parts.length - 1]] = value
}

function readModeState() {
  return readJson(join(STATE_DIR(), 'mode.json'), { mode: 'reserved2' })
}

function readLogTail(lines) {
  const file = join(STATE_DIR(), 'bridge.log')
  if (!existsSync(file)) return { lines: [], note: '没有 bridge.log' }
  try {
    const size = statSync(file).size
    const window = 128 * 1024
    const start = Math.max(0, size - window)
    const handle = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      readSync(handle, buffer, 0, buffer.length, start)
      const text = buffer.toString('utf8')
      const all = text.split(/\r?\n/).filter((line) => line.trim() !== '')
      return { lines: all.slice(-lines), note: start > 0 ? '只读了最后 128 KB' : '' }
    } finally {
      closeSync(handle)
    }
  } catch (error) {
    return { lines: [], note: String(error?.message ?? error) }
  }
}

/* ---------- 路由 ---------- */

function createHandlers() {
  const statusHandler = async (req, res) => {
    const root = bridgeRoot()
    const config = readConfig()
    const bridgePresent = existsSync(join(root, 'src', 'bridge.js'))
    const up = await portOpen(3100)
    let diag = null
    // 只有「程序在 + 端口通」才去读 diag：3100 上跑着别的东西时，
    // 拿回来的 JSON 不是我们的，几盏灯会被它带歪。
    if (up && bridgePresent) {
      const result = await bridgeFetch('/diag', {}, 6000)
      diag = result.ok ? result.data : { error: result.data?.error ?? 'diag 读不到' }
    }
    const groups = Array.isArray(config?.allow?.groups) ? config.allow.groups : []
    const privates = Array.isArray(config?.allow?.private) ? config.allow.private : []
    const owner = config?.ownerQQ
    const nextStep = !bridgePresent
      ? '没找到桥接程序（' + join(root, 'src', 'bridge.js') + '）。请按安装说明放好 qq-bridge，或设置环境变量 DSH_QQ_BRIDGE_ROOT 指向它。'
      : config === null
        ? '找到目录但没有 config.json：先启动一次桥接，它会自己生成。'
        : !up
          ? '桥接没在跑：点下面的「重启桥接」。'
          : !owner
            ? '还没填管理员 QQ——不填的话审批和管理命令都用不了。'
            : groups.length + privates.length === 0 && config.allowAllWhenEmpty !== true
              ? '白名单是空的：她不会回任何人的消息，至少加一个群或一个私聊。'
              : '一切就绪。'

    sendJson(res, 200, {
      ok: true,
      bridgeRoot: root,
      exists: bridgePresent,
      configExists: config !== null,
      listening: up,
      diag,
      // 和桥接保持一致：旧面板默认就是隐藏的（config 里没这个键也算隐藏）。
      hideConsolePages: config?.hideConsolePages !== false,
      nextStep,
      version: PLUGIN_VERSION,
      at: Date.now()
    })
  }

  const configHandler = async (req, res) => {
    if (req.method === 'GET') {
      const config = readConfig()
      if (config === null) return sendJson(res, 404, { ok: false, error: '找不到 config.json' })
      return sendJson(res, 200, { ok: true, config: publicConfig(config) })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })

    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })

    const current = readConfig()
    if (current === null) return sendJson(res, 404, { ok: false, error: '找不到 config.json' })

    const next = { ...current }
    if (typeof body.ownerQQ !== 'undefined') next.ownerQQ = String(body.ownerQQ ?? '').trim()
    if (typeof body.silent === 'boolean') next.silent = body.silent
    if (typeof body.ackMessage === 'string') next.ackMessage = body.ackMessage
    if (typeof body.allowAllWhenEmpty === 'boolean') next.allowAllWhenEmpty = body.allowAllWhenEmpty
    if (body.allow && typeof body.allow === 'object') {
      const clean = (list) =>
        Array.isArray(list)
          ? list
              .map((item) => String(item).trim())
              .filter((item) => item !== '' && /^\d{4,20}$/.test(item))
          : []
      next.allow = {
        ...(current.allow ?? {}),
        private: clean(body.allow.private),
        groups: clean(body.allow.groups)
      }
    }

    const dir = bridgeRoot()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      copyFileSync(CONFIG_FILE(), join(dir, `config.json.bak-settings-${stamp}`))
    } catch {
      /* 备份失败不阻止保存，但下面会告诉用户 */
    }
    try {
      writeJsonAtomic(CONFIG_FILE(), next)
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: '写入失败：' + String(error?.message ?? error) })
    }
    return sendJson(res, 200, {
      ok: true,
      restartRequired: true,
      config: publicConfig(next)
    })
  }

  const rolesHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
    const state = readJson(ROLE_STATE(), { role: '', mode: '' })
    return sendJson(res, 200, { ok: true, roles: listRoles(), current: String(state.role ?? '') })
  }

  const roleHandler = async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    const wanted = sanitizeRole(body.role)
    if (wanted === '') return sendJson(res, 400, { ok: false, error: '角色名不合法' })
    const found = listRoles().some((item) => item.name === wanted)
    if (!found) return sendJson(res, 404, { ok: false, error: `没有这个角色：${wanted}` })
    const previous = readJson(ROLE_STATE(), { role: '', mode: 'active' })
    try {
      mkdirSync(STATE_DIR(), { recursive: true })
      writeJsonAtomic(ROLE_STATE(), { ...previous, role: wanted })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: '写入失败：' + String(error?.message ?? error) })
    }
    return sendJson(res, 200, { ok: true, role: wanted })
  }

  const actionHandler = async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
    const body = await readBody(req)
    const action = String(body?.action ?? '')

    if (action === 'test') {
      // 文案可以自定义：前端传了就用，没传用默认那句。
      const text = String(body?.text ?? '').trim().slice(0, 200)
      const result = await bridgeFetch('/api/test-send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text !== '' ? text : '这是一条来自 DSH 设置的测试消息。' })
      })
      return sendJson(res, result.ok ? 200 : 502, {
        ok: result.ok,
        status: result.status,
        result: result.data
      })
    }

    // 打开日志所在文件夹（排查问题时少走两步）。
    if (action === 'open-logs') {
      const dir = STATE_DIR()
      if (!existsSync(dir)) return sendJson(res, 404, { ok: false, error: '还没有 state 目录：桥接可能没启动过' })
      try {
        const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false })
        child.unref()
        return sendJson(res, 200, { ok: true, dir, note: '已在资源管理器打开' })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: '打不开：' + String(error?.message ?? error) })
      }
    }

    if (action === 'init-config') {
      const root = bridgeRoot()
      const example = join(root, 'config.example.json')
      const target = join(root, 'config.json')
      if (existsSync(target)) return sendJson(res, 200, { ok: true, created: false, note: '已经有 config.json，不覆盖' })
      if (!existsSync(example)) return sendJson(res, 404, { ok: false, error: '没找到 config.example.json，请按安装说明手动放一份 config.json' })
      try {
        copyFileSync(example, target)
        return sendJson(res, 200, { ok: true, created: true, note: '已按示例生成 config.json：白名单和管理员还是空的，填完再重启桥接' })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }

    if (action === 'connect') {
      const root = bridgeRoot()
      const script = join(root, 'scripts', 'autostart.mjs')
      if (!existsSync(script)) return sendJson(res, 404, { ok: false, error: '找不到 autostart.mjs：' + script })
      ensureConfigFromExample()
      try {
        const child = spawn(nodeRuntime(), [script], {
          cwd: root,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
        child.unref()
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return sendJson(res, 200, { ok: true, started: true, note: '正在检查 DSH / SnowLuma 并拉起桥接，约 20~40 秒' })
    }

    if (action === 'restart') {
      if (!existsSync(join(bridgeRoot(), 'scripts', 'align-dsh-port.mjs'))) {
        return sendJson(res, 404, { ok: false, error: '找不到对齐脚本：' + join(bridgeRoot(), 'scripts', 'align-dsh-port.mjs') })
      }
      if (!spawnBridgeAlign()) {
        return sendJson(res, 500, { ok: false, error: '拉起桥接失败（详见 DSH 日志）' })
      }
      return sendJson(res, 200, { ok: true, started: true, note: '重启大约需要 10~15 秒' })
    }

    // 全屏星图：交给桥接自己拉 Edge 应用窗口（/open-memory 是免令牌的）。
    // 以前客户端直接 window.open('/memory')，没带令牌 → 401，点了没反应。
    if (action === 'open-memory') {
      const result = await bridgeFetch('/open-memory', {}, 6000)
      if (result.status === 0) {
        return sendJson(res, 502, { ok: false, error: '桥接没在跑：' + String(result.data?.error ?? '连不上 127.0.0.1:3100') })
      }
      // 桥接回 204 不带 body，读不成 JSON 是正常的。
      return sendJson(res, 200, { ok: true, status: result.status, note: '已在全屏窗口打开星图' })
    }

    // 总控制可视化面板：桥接自己拉一个全屏窗口（/open-panel 免令牌，内部会带 token 打开 /dashboard）。
    if (action === 'open-dashboard') {
      const result = await bridgeFetch('/open-panel', {}, 8000)
      if (result.status === 0) {
        return sendJson(res, 502, { ok: false, error: '桥接没在跑：' + String(result.data?.error ?? '连不上 127.0.0.1:3100') })
      }
      return sendJson(res, 200, { ok: true, status: result.status, note: '已在全屏窗口打开可视化面板' })
    }

    return sendJson(res, 400, { ok: false, error: `不认识的动作：${action}` })
  }

  const settingsHandler = async (req, res) => {
    const config = readConfig()
    if (config === null) return sendJson(res, 404, { ok: false, error: '找不到 config.json' })

    if (req.method === 'GET') {
      const mode = readModeState()
      const flags = {}
      for (const key of Object.keys(FLAGS)) {
        const raw = getPath(config, key)
        // 默认开的开关（旧面板隐藏、启动时拉起桥接）：config 里没有这个键时显示成「开」。
        flags[key] = DEFAULT_TRUE_FLAGS.has(key) ? raw !== false : raw === true
      }
      const numbers = {}
      for (const key of Object.keys(NUMBERS)) {
        const value = getPath(config, key)
        numbers[key] = typeof value === 'number' ? value : null
      }
      const strings = {}
      for (const key of Object.keys(STRINGS)) {
        const value = getPath(config, key)
        strings[key] = typeof value === 'string' ? value : ''
      }
      const enums = {}
      for (const key of Object.keys(ENUMS)) {
        const value = getPath(config, key)
        enums[key] = typeof value === 'string' ? value : ''
      }
      return sendJson(res, 200, {
        ok: true,
        mode: String(mode.mode ?? 'reserved2'),
        flags,
        numbers,
        strings,
        enums,
        meta: { flags: FLAGS, numbers: NUMBERS, strings: STRINGS, enums: ENUMS }
      })
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })

    let touched = false
    const next = { ...config }
    const changed = []

    if (body.flags && typeof body.flags === 'object') {
      for (const [key, value] of Object.entries(body.flags)) {
        if (Object.prototype.hasOwnProperty.call(FLAGS, key) === false) continue
        if (typeof value !== 'boolean') continue
        setPath(next, key, value)
        changed.push(FLAGS[key].label + '=' + (value ? '开' : '关'))
        touched = true
      }
    }

    if (body.numbers && typeof body.numbers === 'object') {
      for (const [key, value] of Object.entries(body.numbers)) {
        const meta = NUMBERS[key]
        if (meta === undefined) continue
        const number = Number(value)
        if (!Number.isFinite(number)) continue
        const scaled = meta.step >= 1 ? Math.round(number) : Math.round(number / meta.step) * meta.step
        const clamped = Math.min(meta.max, Math.max(meta.min, Number(scaled.toFixed(2))))
        setPath(next, key, clamped)
        changed.push(meta.label + '=' + clamped)
        touched = true
      }
    }

    if (body.strings && typeof body.strings === 'object') {
      for (const [key, value] of Object.entries(body.strings)) {
        const meta = STRINGS[key]
        if (meta === undefined) continue
        const text = String(value ?? '').trim().slice(0, meta.max)
        setPath(next, key, text)
        changed.push(meta.label + '=' + (text === '' ? '（空）' : text))
        touched = true
      }
    }

    if (body.enums && typeof body.enums === 'object') {
      for (const [key, value] of Object.entries(body.enums)) {
        const meta = ENUMS[key]
        if (meta === undefined) continue
        const text = String(value ?? '')
        if (!meta.options.some((option) => option.value === text)) continue
        setPath(next, key, text)
        changed.push(meta.label + '=' + text)
        touched = true
      }
    }

    let modeChanged = false
    if (typeof body.mode === 'string') {
      const allowed = ['reserved', 'reserved2']
      if (!allowed.includes(body.mode)) return sendJson(res, 400, { ok: false, error: '模式只能是 reserved / reserved2' })
      const previous = readModeState()
      try {
        mkdirSync(STATE_DIR(), { recursive: true })
        writeJsonAtomic(join(STATE_DIR(), 'mode.json'), { ...previous, mode: body.mode })
        modeChanged = true
        changed.push('模式=' + (body.mode === 'reserved2' ? '二代' : '一代'))
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: '写模式失败：' + String(error?.message ?? error) })
      }
    }

    if (touched) {
      const dir = bridgeRoot()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        copyFileSync(CONFIG_FILE(), join(dir, `config.json.bak-settings-${stamp}`))
      } catch {
        /* 备份失败不阻止保存 */
      }
      try {
        writeJsonAtomic(CONFIG_FILE(), next)
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: '写入失败：' + String(error?.message ?? error) })
      }
    }

    return sendJson(res, 200, {
      ok: true,
      restartRequired: touched || modeChanged,
      changed
    })
  }

  const logsHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
    const url = new URL(req.url, 'http://local')
    const raw = Number(url.searchParams.get('n'))
    const count = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.round(raw))) : 50
    const query = (url.searchParams.get('q') ?? '').trim()
    const tail = readLogTail(query === '' ? count : 500)
    // 过滤在服务端做：先读一大段再筛，比让浏览器拉 500 行再筛省事。
    const lines = query === '' ? tail.lines : tail.lines.filter((line) => line.includes(query)).slice(-count)
    return sendJson(res, 200, {
      ok: true,
      lines,
      note: tail.note,
      total: tail.lines.length,
      query,
      path: join(STATE_DIR(), 'bridge.log'),
      dir: STATE_DIR()
    })
  }

  const slangHandler = async (req, res) => {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://local')
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const raw = readJson(join(STATE_DIR(), 'slang.json'), [])
      const all = Array.isArray(raw) ? raw : []
      const items = all
        .filter((entry) => {
          if (query === '') return true
          return [entry.content, entry.meaning, entry.usage]
            .some((field) => String(field ?? '').toLowerCase().includes(query))
        })
        .slice(0, 80)
        .map((entry) => ({
          id: String(entry.id ?? ''),
          content: String(entry.content ?? ''),
          meaning: String(entry.meaning ?? ''),
          status: String(entry.status ?? ''),
          count: Number(entry.count ?? 0),
          useCount: Number(entry.useCount ?? 0)
        }))
      return sendJson(res, 200, { ok: true, total: all.length, items })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter((id) => id !== '') : []
    if (ids.length === 0) return sendJson(res, 400, { ok: false, error: '没有要删的条目' })
    const result = await bridgeFetch('/api/slang/batch-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids })
    })
    return sendJson(res, result.ok ? 200 : 502, { ok: result.ok, status: result.status, result: result.data })
  }

  const stickersHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
    const raw = readJson(join(STATE_DIR(), 'stickers.json'), [])
    const all = Array.isArray(raw) ? raw : []
    const items = all.slice(0, 60).map((entry) => ({
      id: String(entry.id ?? entry.md5 ?? ''),
      desc: String(entry.desc ?? entry.localNote ?? entry.remark ?? ''),
      url: String(entry.url ?? ''),
      resId: String(entry.resId ?? ''),
      useCount: Number(entry.useCount ?? 0)
    }))
    return sendJson(res, 200, { ok: true, total: all.length, items })
  }

  const roleEditHandler = async (req, res) => {
    const url = new URL(req.url, 'http://local')
    const config = readConfig()
    const limit = typeof config?.role?.maxInjectChars === 'number' ? config.role.maxInjectChars : 15000

    if (req.method === 'GET') {
      const wanted = sanitizeRole(url.searchParams.get('name'))
      if (wanted === '') return sendJson(res, 400, { ok: false, error: '角色名不合法' })
      const file = join(ROLES_DIR(), wanted + '.md')
      if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: '没有这个角色：' + wanted })
      try {
        const content = readFileSync(file, 'utf8')
        return sendJson(res, 200, {
          ok: true,
          name: wanted,
          content,
          chars: Array.from(content).length,
          bytes: Buffer.byteLength(content, 'utf8'),
          limit,
          mtime: statSync(file).mtimeMs
        })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
    const body = await readBody(req, 512 * 1024)
    if (body === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON（或超过 512 KB）' })

    const wanted = sanitizeRole(body.name)
    if (wanted === '') return sendJson(res, 400, { ok: false, error: '角色名不合法' })
    if (typeof body.content !== 'string') return sendJson(res, 400, { ok: false, error: '缺少 content' })
    if (Buffer.byteLength(body.content, 'utf8') > 256 * 1024) {
      return sendJson(res, 400, { ok: false, error: '内容超过 256 KB，拒绝写入' })
    }

    const file = join(ROLES_DIR(), wanted + '.md')
    if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: '没有这个角色：' + wanted })

    try {
      const backups = join(bridgeRoot(), 'backups')
      mkdirSync(backups, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      copyFileSync(file, join(backups, `${wanted}-改前-${stamp}.md`))
      const tmp = file + '.tmp-' + process.pid
      writeFileSync(tmp, body.content, 'utf8')
      renameSync(tmp, file)
      return sendJson(res, 200, {
        ok: true,
        name: wanted,
        chars: Array.from(body.content).length,
        bytes: Buffer.byteLength(body.content, 'utf8'),
        limit,
        restartRequired: false
      })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: '写入失败：' + String(error?.message ?? error) })
    }
  }

  const PRESET_DIR = () => join(bridgeRoot(), 'dsh', 'agent-presets', 'qq-chat-v2')
  const PROMPT_FILE = () => join(PRESET_DIR(), 'agent.cordis.yml')

  const promptHandler = async (req, res) => {
    const file = PROMPT_FILE()
    if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: '没找到仿真提示词文件（dsh\\agent-presets\\qq-chat-v2\\agent.cordis.yml）。它来自 qq-agent-presets 插件；装好并启动一次桥接后会出现。' })

    if (req.method === 'GET') {
      try {
        const content = readFileSync(file, 'utf8')
        const backups = readdirSync(PRESET_DIR())
          .filter((name) => name.startsWith('agent.cordis.yml.bak-'))
          .map((name) => {
            let size = 0
            try {
              size = statSync(join(PRESET_DIR(), name)).size
            } catch {
              size = 0
            }
            return { name, size }
          })
          .sort((a, b) => b.name.localeCompare(a.name))
          .slice(0, 20)
        return sendJson(res, 200, { ok: true, file, content, bytes: Buffer.byteLength(content, 'utf8'), backups })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')

    if (body.action === 'backup') {
      try {
        copyFileSync(file, file + '.bak-' + stamp)
        return sendJson(res, 200, { ok: true, backup: 'agent.cordis.yml.bak-' + stamp })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }

    if (body.action === 'restore') {
      const name = String(body.name ?? '')
      if (!/^agent\.cordis\.yml\.bak-[0-9A-Za-z.\-]+$/.test(name)) return sendJson(res, 400, { ok: false, error: '备份文件名不合法' })
      const source = join(PRESET_DIR(), name)
      if (!existsSync(source)) return sendJson(res, 404, { ok: false, error: '没有这个备份：' + name })
      try {
        copyFileSync(file, file + '.bak-before-restore-' + stamp)
        const content = readFileSync(source, 'utf8')
        const tmp = file + '.tmp-' + process.pid
        writeFileSync(tmp, content, 'utf8')
        renameSync(tmp, file)
        return sendJson(res, 200, { ok: true, restored: name, bytes: Buffer.byteLength(content, 'utf8') })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }

    return sendJson(res, 400, { ok: false, error: 'action 只能是 backup / restore' })
  }

  const digestHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
    const config = readConfig()
    const dir = typeof config?.socialV2?.biliDigest?.dir === 'string' && config.socialV2.biliDigest.dir !== ''
      ? config.socialV2.biliDigest.dir
      : join(process.env.USERPROFILE ?? '', '.dsh', 'bili-duty', 'out')
    // 这份日报是刷B站插件写的，不是桥接的数据：带上「装没装」和目录，省得用户以为桥接坏了。
    const plugin = pluginInstalled('dsh-bili-scroll')
    try {
      const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md')).sort()
      if (files.length === 0) return sendJson(res, 200, { ok: true, dir, plugin, file: '', content: '' })
      const newest = files[files.length - 1]
      const content = readFileSync(join(dir, newest), 'utf8').slice(0, 20 * 1024)
      return sendJson(res, 200, { ok: true, dir, plugin, file: newest, content })
    } catch (error) {
      return sendJson(res, 200, { ok: true, dir, plugin, file: '', content: '', note: String(error?.message ?? error) })
    }
  }

  const socialHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
    return sendJson(res, 200, {
      ok: true,
      events: readJson(join(STATE_DIR(), 'events.json'), null),
      impressions: readJson(join(STATE_DIR(), 'impressions.json'), null),
      affinity: readJson(join(STATE_DIR(), 'affinity.json'), null)
    })
  }

  const setupHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
    const root = bridgeRoot()
    const config = readConfig()
    const [snowluma, onebotA, onebotB, bridgeUp] = await Promise.all([
      portOpen(5099, 1200),
      portOpen(3000, 1200),
      portOpen(3001, 1200),
      portOpen(3100, 1200)
    ])
    const groups = Array.isArray(config?.allow?.groups) ? config.allow.groups : []
    const privates = Array.isArray(config?.allow?.private) ? config.allow.private : []
    const bridgePresent = existsSync(join(root, 'src', 'bridge.js'))
    // 桥接在跑时，它的 /diag 才是权威（它自己知道 QQ 连没连上）；端口探测只是兜底。
    let diag = null
    if (bridgePresent && bridgeUp) {
      const result = await bridgeFetch('/diag', {}, 4000)
      diag = result.ok && result.data && typeof result.data === 'object' ? result.data : null
    }
    const known = (key, fallback) => (diag !== null && typeof diag[key] === 'boolean' ? diag[key] : fallback)
    const snowlumaOk = bridgePresent && known('snowluma', snowluma)
    const onebotOk = bridgePresent && known('onebot', onebotA || onebotB)
    const steps = [
      { id: 'bridge-files', label: '桥接程序', ok: bridgePresent, hint: '桥接程序没找到。重跑一次安装包里的「安装.cmd」，它会把文件放好' },
      { id: 'config', label: '配置文件', ok: config !== null, hint: '还没有配置文件，点上面的按钮生成一份就能改了' },
      {
        id: 'snowluma',
        label: 'SnowLuma（QQ 网关）',
        ok: snowlumaOk,
        // 桥接没跑时端口探不准（5099 可能是别的东西）：明确说「还不知道」，别装成红的。
        unknown: !bridgePresent,
        hint: bridgePresent ? '这个要另外装：点「怎么装 SnowLuma」。先登录官方 QQ，再让它接上 QQ 进程' : '桥接还没装好，这项看不出来'
      },
      {
        id: 'onebot',
        label: 'QQ 连上了吗',
        ok: onebotOk,
        unknown: !bridgePresent,
        hint: bridgePresent ? '在 SnowLuma 里点一下「注入」，让她能收到 QQ 消息' : '桥接还没装好，这项看不出来'
      },
      // 端口通不代表是我们的桥接：3100 上可能是别的服务，所以要求程序文件也在。
      { id: 'bridge', label: '桥接在线', ok: bridgePresent && bridgeUp, hint: bridgePresent ? '点「重启桥接」，等十来秒就好' : '先把桥接程序放好（第一项）' },
      { id: 'owner', label: '管理员 QQ', ok: Boolean(config?.ownerQQ), hint: '填你自己的 QQ 号。不填的话，她不会听管理命令' },
      { id: 'allow', label: '让她能回谁', ok: groups.length + privates.length > 0 || config?.allowAllWhenEmpty === true, hint: '现在是空的，她谁也不回 —— 至少加一个群，或者你自己的私聊' },
      { id: 'bili', label: '刷B站（可选）', ok: pluginInstalled('dsh-bili-scroll'), optional: true, hint: '不装也能用。想装的话，去 DSH 插件市场搜 dsh-bili-scroll' }
    ]
    const required = steps.filter((step) => step.optional !== true)
    return sendJson(res, 200, { ok: true, ready: required.every((step) => step.ok), steps, bridgeRoot: root })
  }

  /**
   * 记忆星图的地址。
   *
   * 桥接的 /memory 要控制台令牌（query 或头都行），而令牌只有宿主这边读得到
   * （state/console-token）。所以把「带令牌的地址」交给页面，让 iframe / 新窗口直接用。
   * 顺带一提：/memory 自己就是 frame-ancestors *，没带 X-Frame-Options，可以嵌。
   */
  const memoryHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
    // 先看程序在不在：只在端口上探活，3100 上是别人的服务时也会「通」。
    if (!existsSync(join(bridgeRoot(), 'src', 'bridge.js'))) {
      return sendJson(res, 200, { ok: true, up: false, url: '', error: '桥接还没装好，先把第一步做完' })
    }
    const up = await portOpen(3100)
    if (!up) return sendJson(res, 200, { ok: true, up: false, url: '', error: '桥接没在跑：先点「重启桥接」' })
    const token = consoleToken()
    if (token === '') return sendJson(res, 200, { ok: true, up: true, url: '', error: '还没拿到星图令牌：点一下「重启桥接」，它会自己生成' })
    return sendJson(res, 200, {
      ok: true,
      up: true,
      url: 'http://127.0.0.1:3100/memory?token=' + encodeURIComponent(token),
      embeddable: true
    })
  }

  /**
   * 接口清单。给「别人的插件 / 本机脚本」看的：这一版到底有哪些路、怎么用、
   * 以及往哪张页面里塞自己的卡片。文档会过时，这份不会——它和注册表写在同一处。
   */
  const apiHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
    return sendJson(res, 200, {
      ok: true,
      plugin: 'dsh-qq-bridge',
      version: PLUGIN_VERSION,
      schemaVersion: 1,
      base: ROUTE_BASE,
      routes: [
        { path: '/status', methods: ['GET'], desc: '总状态：桥接目录、是否在线、四个灯、下一步建议' },
        { path: '/setup', methods: ['GET'], desc: '新手引导的检查项（含可选项标记 optional）' },
        { path: '/config', methods: ['GET', 'POST'], desc: '白名单 / 管理员 / 静默等配置；POST 会先备份再原子写入' },
        { path: '/roles', methods: ['GET'], desc: '角色列表与当前角色' },
        { path: '/role', methods: ['POST'], desc: '切换当前角色（body: { role }）' },
        { path: '/role/edit', methods: ['GET', 'POST'], desc: '读写角色文件正文（body: { name, content }）' },
        { path: '/settings', methods: ['GET', 'POST'], desc: '开关与数值设置（body: { flags?, numbers?, strings?, enums? }）' },
        { path: '/action', methods: ['POST'], desc: '动作：重启桥接 / 一键对接 / 发测试消息（body: { action }）' },
        { path: '/logs', methods: ['GET'], desc: '桥接日志尾部（?n=行数）' },
        { path: '/slang', methods: ['GET', 'POST'], desc: '黑话库：查 / 增删' },
        { path: '/stickers', methods: ['GET'], desc: '收藏表情列表' },
        { path: '/prompt', methods: ['GET', 'POST'], desc: '提示词文件读写' },
        { path: '/digest', methods: ['GET'], desc: '刷B站日报（最新一份 Markdown）' },
        { path: '/social', methods: ['GET'], desc: '社交状态：事件、印象、好感度' },
        { path: '/memory', methods: ['GET'], desc: '记忆星图的地址（带控制台令牌，可直接给 iframe / 新窗口）' },
        { path: '/update', methods: ['GET', 'POST'], desc: '检查更新 / 一键装补丁（GET 查，POST {action:"apply"} 装）' },
        { path: '/diagnose', methods: ['GET'], desc: '一键诊断：版本、路径、四灯、最近日志拼成一段文本' },
        { path: '/backups', methods: ['GET', 'POST'], desc: '备份列表 / 还原（kind=config|role|prompt）' },
        { path: '/voice/preview', methods: ['POST'], desc: '语音试听：{text} → 直接返回音频' },
        { path: '/api', methods: ['GET'], desc: '这份清单本身' },
        { path: '/peer', methods: ['GET'], desc: '同一台机器上还装着哪些带界面的 DSH 插件（给「互相认得」用）' }
      ],
      slots: {
        card: {
          name: CARD_SLOT,
          kind: 'list',
          scope: 'root',
          orderHint: '核心卡片占 10–90；扩展从 100 起，按 10 递增',
          props: { base: '接口前缀，等于 base', version: '插件版本' },
          desc: '别的插件往 QQ 桥接设置页末尾加自己的卡片，用 ctx.slots.inject + ctx.slots.register'
        }
      },
      conventions: [
        '所有接口都在 /dsh-qq-bridge 下，返回 JSON，成功一律带 ok:true',
        '失败统一是 { ok:false, error:"说明" }，HTTP 状态码表意（400 参数错、403 跨站、404 没有、405 方法不对）',
        '写接口（POST）要求同源：浏览器带 Origin 必须指向本机，否则 403；不带 Origin 的本机脚本放行',
        '路由只增不改：要换结构就加新路径，别让别人的代码半夜失效',
        '扩展卡片自己包一层 .qbg-card（本插件样式表里有），别去改核心卡片的 DOM',
        '想让这里用你的中文名显示，写 locale/zh.json 的 {"meta":{"title":"星图开机"}}（DSH 插件列表也读这里）；老写法 package.json 的 dshLabel 仍然认，没有就用包名'
      ]
    })
  }

  /**
   * 邻接插件：同一台机器上还装着谁。
   *
   * 只读 `.dsh/plugins/<包名>/package.json` 和它的 `locale/`，**不启动、不调用**任何人——
   * 这里只回答「装了什么、什么版本」。判断某个插件死活是它自己的事（比如星图开机自己会报）。
   * 只列有浏览器那一半的（`dsh.client`），因为只有它们才可能跟这一页有交集。
   */
  const peerHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
    const pluginsDir = dirname(SELF_DIR)
    const peers = []
    let entries = []
    try {
      entries = readdirSync(pluginsDir, { withFileTypes: true })
    } catch (error) {
      return sendJson(res, 200, { ok: true, dir: pluginsDir, peers: [], error: '读不到插件目录' })
    }
    for (const entry of entries) {
      // junction / 符号链接也算：装插件的人常用 mklink。
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name === basename(SELF_DIR)) continue
      const dir = join(pluginsDir, entry.name)
      const manifest = readJson(join(dir, 'package.json'), null)
      if (manifest === null || typeof manifest !== 'object') continue
      const client = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh.client : null
      if (client === null || client === undefined) continue
      const name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : entry.name

      // 显示名三级：dshLabel（本插件早期约定的）→ locale/zh.json 的 meta.title（DSH 自己也读这里）→ 包名。
      // 优先读 locale 是因为那是官方口径：插件只要写了 locale，DSH 的插件列表和这张卡就同名。
      let label = typeof manifest.dshLabel === 'string' ? manifest.dshLabel.trim() : ''
      if (label === '') {
        for (const lang of ['zh', 'en']) {
          const meta = readJson(join(dir, 'locale', lang + '.json'), null)
          const title = meta && typeof meta === 'object' && meta.meta ? meta.meta.title : null
          if (typeof title === 'string' && title.trim() !== '') {
            label = title.trim()
            break
          }
        }
      }
      if (label === '') label = name

      peers.push({
        name,
        label,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        description: typeof manifest.description === 'string' ? manifest.description : ''
      })
    }
    peers.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
    return sendJson(res, 200, { ok: true, dir: pluginsDir, peers: peers.slice(0, 20) })
  }

  /** 一键诊断：把排查要用的东西拼成一段能直接粘出去的文本。 */
  const diagnoseHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
    const root = bridgeRoot()
    const config = readConfig()
    const present = existsSync(join(root, 'src', 'bridge.js'))
    const up = await portOpen(3100, 1500)
    let diag = null
    if (present && up) {
      const result = await bridgeFetch('/diag', {}, 4000)
      diag = result.ok ? result.data : null
    }
    const mode = readModeState()
    const groups = Array.isArray(config?.allow?.groups) ? config.allow.groups : []
    const privates = Array.isArray(config?.allow?.private) ? config.allow.private : []
    const log = readLogTail(40)
    const yes = (value) => (value === true ? '正常' : '异常')
    const text = [
      'DSH QQ 桥接 · 诊断报告',
      '时间：' + new Date().toLocaleString('zh-CN'),
      '插件版本：' + PLUGIN_VERSION,
      '桥接目录：' + root,
      '桥接程序：' + (present ? '在' : '不在'),
      '端口 3100：' + (up ? '在听' : '没听'),
      '桥接连的 DSH：' + String(config?.dsh?.baseUrl ?? '（未知）'),
      '管理员 QQ：' + (config?.ownerQQ ? String(config.ownerQQ) : '（没填）'),
      '白名单：群 ' + groups.length + ' 个 / 私聊 ' + privates.length + ' 个',
      '模式：' + String(mode.mode ?? '未知'),
      '四灯：DSH=' + yes(diag && diag.dsh) + ' SnowLuma=' + yes(diag && diag.snowluma) + ' OneBot=' + yes(diag && diag.onebot) + ' QQ=' + yes(diag && diag.qq),
      diag && diag.note ? '桥接备注：' + String(diag.note) : '',
      '',
      '最近日志（最后 ' + log.lines.length + ' 行' + (log.note ? '，' + log.note : '') + '）：',
      ...(log.lines.length === 0 ? ['（没有日志）'] : log.lines)
    ].filter((line) => line !== '').join('\n')
    return sendJson(res, 200, { ok: true, text, at: Date.now() })
  }

  /* ---------- 备份 ---------- */

  function listBackups() {
    const root = bridgeRoot()
    const collect = (dir, accept, extra) => {
      try {
        return readdirSync(dir)
          .filter(accept)
          .map((name) => {
            let size = 0
            let mtime = 0
            try {
              const stat = statSync(join(dir, name))
              size = stat.size
              mtime = stat.mtimeMs
            } catch {
              size = 0
            }
            return { name, size, mtime, ...(extra ? extra(name) : {}) }
          })
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 30)
      } catch {
        return []
      }
    }
    return {
      config: collect(root, (name) => name.startsWith('config.json.bak-')),
      role: collect(join(root, 'backups'), (name) => name.toLowerCase().endsWith('.md'), (name) => ({ role: name.split('-改前-')[0] })),
      prompt: collect(PRESET_DIR(), (name) => name.startsWith('agent.cordis.yml.bak-'))
    }
  }

  const backupsHandler = async (req, res) => {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...listBackups() })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    const kind = String(body?.kind ?? '')
    const name = String(body?.name ?? '')
    const root = bridgeRoot()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      if (kind === 'config') {
        if (!/^config\.json\.bak-[0-9A-Za-z.\-]+$/.test(name)) return sendJson(res, 400, { ok: false, error: '备份文件名不合法' })
        const source = join(root, name)
        if (!existsSync(source)) return sendJson(res, 404, { ok: false, error: '没有这个备份：' + name })
        const target = join(root, 'config.json')
        if (existsSync(target)) copyFileSync(target, join(root, 'config.json.bak-before-restore-' + stamp))
        copyFileSync(source, target)
        return sendJson(res, 200, { ok: true, restored: name, target, restartRequired: true })
      }
      if (kind === 'role') {
        if (!name.toLowerCase().endsWith('.md') || name.includes('..') || /[\\/:*?"<>|]/.test(name)) {
          return sendJson(res, 400, { ok: false, error: '备份文件名不合法' })
        }
        const cut = name.indexOf('-改前-')
        if (cut <= 0) return sendJson(res, 400, { ok: false, error: '这不是人格卡备份（缺「-改前-」）' })
        const roleName = sanitizeRole(name.slice(0, cut))
        if (roleName === '') return sendJson(res, 400, { ok: false, error: '角色名不合法' })
        const source = join(root, 'backups', name)
        if (!existsSync(source)) return sendJson(res, 404, { ok: false, error: '没有这个备份：' + name })
        const target = join(ROLES_DIR(), roleName + '.md')
        mkdirSync(join(root, 'backups'), { recursive: true })
        if (existsSync(target)) copyFileSync(target, join(root, 'backups', roleName + '-还原前-' + stamp + '.md'))
        copyFileSync(source, target)
        return sendJson(res, 200, { ok: true, restored: name, target, restartRequired: false })
      }
      if (kind === 'prompt') {
        if (!/^agent\.cordis\.yml\.bak-[0-9A-Za-z.\-]+$/.test(name)) return sendJson(res, 400, { ok: false, error: '备份文件名不合法' })
        const source = join(PRESET_DIR(), name)
        if (!existsSync(source)) return sendJson(res, 404, { ok: false, error: '没有这个备份：' + name })
        const target = PROMPT_FILE()
        if (!existsSync(target)) return sendJson(res, 404, { ok: false, error: '提示词文件不在，先启动一次桥接' })
        copyFileSync(target, target + '.bak-before-restore-' + stamp)
        const content = readFileSync(source, 'utf8')
        const tmp = target + '.tmp-' + process.pid
        writeFileSync(tmp, content, 'utf8')
        renameSync(tmp, target)
        return sendJson(res, 200, { ok: true, restored: name, target, restartRequired: true })
      }
      return sendJson(res, 400, { ok: false, error: 'kind 只能是 config / role / prompt' })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /** 语音试听：让桥接合成一句，直接把音频流回来给浏览器播。 */
  const voicePreviewHandler = async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    const text = String(body?.text ?? '').trim().slice(0, 200)
    if (text === '') return sendJson(res, 400, { ok: false, error: '先说一句要试听的话' })
    const result = await bridgeFetch('/api/voice/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, rate: Number(body?.rate) || 0, voice: String(body?.voice ?? '') })
    }, 60000)
    if (!result.ok || !result.data || result.data.ok === false) {
      const reason = String(result.data?.error ?? '桥接没给音频（可能是 TTS 没配）')
      return sendJson(res, 502, { ok: false, error: reason })
    }
    const file = String(result.data.path ?? '')
    if (file === '' || !existsSync(file)) {
      return sendJson(res, 502, { ok: false, error: '桥接说合成好了，但文件不在：' + file })
    }
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      size = 0
    }
    if (size > 8 * 1024 * 1024) return sendJson(res, 413, { ok: false, error: '音频太大（' + size + ' B）' })
    return sendFile(res, file, audioTypeOf(file))
  }

  /**
   * 检查更新 / 一键打补丁。
   *
   * GET  ?refresh=1 强制绕过缓存；POST {action:'apply'} 下载并装上最新补丁包。
   * 只替换设置页插件自身（SELF_DIR），不碰桥接本体和用户数据。
   */
  const updateHandler = async (req, res) => {
    if (req.method === 'GET') {
      let refresh = false
      try {
        refresh = new URL(req.url ?? '/', 'http://local').searchParams.get('refresh') === '1'
      } catch { /* 坏 URL 就当不强制刷新 */ }
      const info = await checkForUpdate({ current: PLUGIN_VERSION, selfDir: SELF_DIR, refresh })
      return sendJson(res, 200, info)
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    const action = String(body?.action ?? 'apply')
    if (action === 'set-repo') {
      try {
        const saved = setRepo(body?.repo)
        return sendJson(res, 200, { ok: true, repo: saved.repo, configured: saved.configured })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    }
    if (action !== 'apply') return sendJson(res, 400, { ok: false, error: `不认识的动作：${action}` })
    try {
      const result = await applyUpdate({ current: PLUGIN_VERSION, selfDir: SELF_DIR })
      return sendJson(res, 200, result)
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  return { statusHandler, configHandler, rolesHandler, roleHandler, roleEditHandler, actionHandler, settingsHandler, logsHandler, slangHandler, stickersHandler, promptHandler, digestHandler, socialHandler, memoryHandler, setupHandler, apiHandler, peerHandler, updateHandler, diagnoseHandler, backupsHandler, voicePreviewHandler }
}

export function apply(ctx) {
  let handlers = null
  try {
    handlers = createHandlers()
  } catch (error) {
    console.error('[dsh-qq-bridge] 初始化失败，设置页会显示为不可用', error)
    return
  }

  try {
    ctx.inject(['webServer'], (webCtx) => {
      const register = (path, handler, label) => {
        try {
          // 统一包一层：写操作先过同源校验，任何异常都别把请求吊死。
          const guarded = (req, res) => {
            if (req.method !== 'GET' && blockCrossOrigin(req, res)) return undefined
            return Promise.resolve(handler(req, res)).catch((error) => {
              if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            })
          }
          return webCtx.webServer.register({ kind: 'exact', path, handler: guarded })
        } catch (error) {
          console.error(`[dsh-qq-bridge] ${label} 注册失败`, error)
          return () => {}
        }
      }
      webCtx.effect(() => register(ROUTE_BASE + '/status', handlers.statusHandler, 'status'), 'qq-bridge: status')
      webCtx.effect(() => register(ROUTE_BASE + '/config', handlers.configHandler, 'config'), 'qq-bridge: config')
      webCtx.effect(() => register(ROUTE_BASE + '/roles', handlers.rolesHandler, 'roles'), 'qq-bridge: roles')
      webCtx.effect(() => register(ROUTE_BASE + '/role', handlers.roleHandler, 'role'), 'qq-bridge: role')
      webCtx.effect(() => register(ROUTE_BASE + '/action', handlers.actionHandler, 'action'), 'qq-bridge: action')
      webCtx.effect(() => register(ROUTE_BASE + '/settings', handlers.settingsHandler, 'settings'), 'qq-bridge: settings')
      webCtx.effect(() => register(ROUTE_BASE + '/logs', handlers.logsHandler, 'logs'), 'qq-bridge: logs')
      webCtx.effect(() => register(ROUTE_BASE + '/slang', handlers.slangHandler, 'slang'), 'qq-bridge: slang')
      webCtx.effect(() => register(ROUTE_BASE + '/stickers', handlers.stickersHandler, 'stickers'), 'qq-bridge: stickers')
      webCtx.effect(() => register(ROUTE_BASE + '/role/edit', handlers.roleEditHandler, 'role-edit'), 'qq-bridge: role edit')
      webCtx.effect(() => register(ROUTE_BASE + '/prompt', handlers.promptHandler, 'prompt'), 'qq-bridge: prompt')
      webCtx.effect(() => register(ROUTE_BASE + '/digest', handlers.digestHandler, 'digest'), 'qq-bridge: digest')
      webCtx.effect(() => register(ROUTE_BASE + '/social', handlers.socialHandler, 'social'), 'qq-bridge: social')
      webCtx.effect(() => register(ROUTE_BASE + '/memory', handlers.memoryHandler, 'memory'), 'qq-bridge: memory')
      webCtx.effect(() => register(ROUTE_BASE + '/setup', handlers.setupHandler, 'setup'), 'qq-bridge: setup')
      webCtx.effect(() => register(ROUTE_BASE + '/api', handlers.apiHandler, 'api'), 'qq-bridge: api')
    webCtx.effect(() => register(ROUTE_BASE + '/peer', handlers.peerHandler, 'peer'), 'qq-bridge: peer')
      webCtx.effect(() => register(ROUTE_BASE + '/update', handlers.updateHandler, 'update'), 'qq-bridge: update')
      webCtx.effect(() => register(ROUTE_BASE + '/diagnose', handlers.diagnoseHandler, 'diagnose'), 'qq-bridge: diagnose')
      webCtx.effect(() => register(ROUTE_BASE + '/backups', handlers.backupsHandler, 'backups'), 'qq-bridge: backups')
      webCtx.effect(() => register(ROUTE_BASE + '/voice/preview', handlers.voicePreviewHandler, 'voice-preview'), 'qq-bridge: voice preview')
    })
  } catch (error) {
    console.error('[dsh-qq-bridge] 没有可用的 webServer，设置页不出现，其它功能不受影响', error)
  }

  // 桥接不会随 DSH 启动：它盯着 DSH 的事件流，流断就退。DSH 一起来就先摸一眼，
  // 停了就在 5 秒后后台拉起来（等 DSH 自己的服务先就位，别抢跑）。
  const scheduleAutoStart = () => {
    const timer = setTimeout(() => {
      void maybeAutoStartBridge()
    }, 5000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(scheduleAutoStart, 'qq-bridge: 自动拉起桥接')
    else scheduleAutoStart()
  } catch (error) {
    console.error('[dsh-qq-bridge] 自动拉起桥接没排上', error)
    scheduleAutoStart()
  }
}

/**
 * 给自测用的钩子：这两个函数平时只被 5 秒后的定时器调用，测试里不该真的去
 * 起进程、也不该等 5 秒，所以单独开出来，让测试直接喂一条 config 进来。
 */
export const __internal = {
  configuredDshPortAlive,
  maybeAutoStartBridge
}
