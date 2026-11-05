/**
 * dsh-qq-bridge 的离线自测。
 *
 * 跑法：
 *   node test/host.mjs
 *
 * 它做两件事：
 *   1. 用一个假的 ctx 接住宿主那一半注册的路由，起一个本地 http 服务，
 *      逐个请求一遍——证明路由能注册、能返回、不会把异常抛到宿主；
 *   2. 用假的 window.__ModuleLoader__ 求值浏览器那一半，然后把设置页
 *      用 react-dom/server 渲染一次——证明组件树不会在求值/渲染时崩。
 *
 * 不碰桥接的写操作：role 用当前值原样写回，config 只读。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const REQUIRE = createRequire(join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'package.json'))

let failures = 0
function check(label, condition, detail) {
  const ok = Boolean(condition)
  if (!ok) failures++
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || detail === undefined ? '' : '  → ' + detail))
}

/* ---------- 1. 宿主 ---------- */

console.log('\n宿主：')
// 测试里别让插件自己去拉桥接（它会在宿主加载 5 秒后动手）。
process.env.DSH_QQ_BRIDGE_NO_AUTOSTART = '1'
// 也别真去问 GitHub：指到一个没人听的端口，几毫秒就失败。
process.env.DSH_QQ_BRIDGE_UPDATE_API = 'http://127.0.0.1:1'
// 更新源走临时文件，别读/写真机上那份
process.env.DSH_QQ_BRIDGE_UPDATE_CONFIG = join(process.env.TEMP || '.', 'qbg-test-update-config-' + process.pid + '.json')
process.env.DSH_QQ_BRIDGE_REPO = ''
const { apply, name } = await import('../lib/index.js')
check('导出 name', name === 'qq-bridge', String(name))

const routes = new Map()
const fakeCtx = {
  inject(services, callback) {
    callback({
      webServer: {
        register({ path, handler }) {
          routes.set(path, handler)
          return () => {}
        }
      },
      effect(fn) {
        return fn()
      }
    })
    return () => {}
  }
}
apply(fakeCtx)
check('注册了 21 条路由', routes.size === 21, [...routes.keys()].join(' '))

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname
  const handler = routes.get(path)
  if (handler === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500).end(String(error))
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const origin = 'http://127.0.0.1:' + port

const status = await (await fetch(origin + '/dsh-qq-bridge/status')).json()
check('status 返回 ok', status.ok === true)
check('status 认出桥接目录', typeof status.bridgeRoot === 'string' && status.bridgeRoot.length > 0, status.bridgeRoot)
check('status 报告 3100 状态', typeof status.listening === 'boolean', String(status.listening))
check('status 带回旧面板开关', typeof status.hideConsolePages === 'boolean')

const config = await (await fetch(origin + '/dsh-qq-bridge/config')).json()
check('config 读到白名单', config.ok === true && config.config && Array.isArray(config.config.allow.groups), JSON.stringify(config.error))

const roles = await (await fetch(origin + '/dsh-qq-bridge/roles')).json()
check('roles 列出角色', roles.ok === true && Array.isArray(roles.roles) && roles.roles.length > 0)

const settings = await (await fetch(origin + '/dsh-qq-bridge/settings')).json()
check('settings 读到模式', settings.ok === true && ['reserved', 'reserved2'].includes(settings.mode), String(settings.mode))
check('settings 带回开关表', settings.ok === true && Object.keys(settings.meta.flags).length >= 6)
check('settings 带回参数表', settings.ok === true && Object.keys(settings.meta.numbers).length >= 2)
check('settings 带回文本项', settings.ok === true && settings.meta.strings !== undefined && Object.keys(settings.meta.strings).length >= 1)
check('settings 带回枚举项', settings.ok === true && settings.meta.enums !== undefined && Object.keys(settings.meta.enums).length >= 2)

const roleText = await (await fetch(origin + '/dsh-qq-bridge/role/edit?name=' + encodeURIComponent(roles.current || roles.roles[0].name))).json()
check('role/edit 读出正文', roleText.ok === true && typeof roleText.content === 'string' && roleText.chars > 100, String(roleText.chars))
check('role/edit 带注入上限', roleText.ok === true && typeof roleText.limit === 'number' && roleText.limit > 1000)

const noContent = await (
  await fetch(origin + '/dsh-qq-bridge/role/edit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '独立AI' })
  })
).json()
check('role/edit 缺内容被拒', noContent.ok === false)

const escape = await (await fetch(origin + '/dsh-qq-bridge/role/edit?name=' + encodeURIComponent('../config'))).json()
check('role/edit 拒绝路径穿越', escape.ok === false)

const prompt = await (await fetch(origin + '/dsh-qq-bridge/prompt')).json()
check('prompt 读出仿真提示词', prompt.ok === true && typeof prompt.content === 'string' && prompt.content.length > 1000, String(prompt.bytes))
check('prompt 带回备份列表', prompt.ok === true && Array.isArray(prompt.backups))

const badRestore = await (
  await fetch(origin + '/dsh-qq-bridge/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore', name: '../../config.json' })
  })
).json()
check('prompt 拒绝非法备份名', badRestore.ok === false)

const digest = await (await fetch(origin + '/dsh-qq-bridge/digest')).json()
check('digest 有字段', digest.ok === true && typeof digest.content === 'string')

const social = await (await fetch(origin + '/dsh-qq-bridge/social')).json()
check('social 带回三个本子', social.ok === true && 'events' in social && 'impressions' in social && 'affinity' in social)

const setup = await (await fetch(origin + '/dsh-qq-bridge/setup')).json()
check('setup 返回检查清单', setup.ok === true && Array.isArray(setup.steps) && setup.steps.length >= 7, String(setup.steps && setup.steps.length))
check('setup 每步都有说明', setup.ok === true && setup.steps.every((step) => typeof step.hint === 'string' && step.hint.length > 0))

const api = await (await fetch(origin + '/dsh-qq-bridge/api')).json()
check('api 返回接口清单', api.ok === true && api.plugin === 'dsh-qq-bridge' && api.schemaVersion === 1, JSON.stringify(api.error))
check('api 的路由表和真实注册对上', Array.isArray(api.routes) && api.routes.length === routes.size, String(api.routes && api.routes.length) + ' vs ' + routes.size)
check('api 标明卡片扩展槽', api.slots && api.slots.card && api.slots.card.name === 'settings.qq-bridge.card', JSON.stringify(api.slots))
check('api 版本和包一致', api.version === JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version, String(api.version))
check('api 只认 GET', (await fetch(origin + '/dsh-qq-bridge/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 405)

// 邻接插件：只报「装了谁、什么版本」。这台机器上星图开机一定在，所以顺带验一下中文名。
const peer = await (await fetch(origin + '/dsh-qq-bridge/peer')).json()
check('peer 返回插件表', peer.ok === true && Array.isArray(peer.peers), JSON.stringify(peer.error))
check('peer 不把自己列进去', Array.isArray(peer.peers) && peer.peers.every((item) => item.name !== 'dsh-qq-bridge'))
check('peer 每项都有名字和版本', Array.isArray(peer.peers) && peer.peers.every((item) => typeof item.name === 'string' && typeof item.version === 'string'))
const starPeer = Array.isArray(peer.peers) ? peer.peers.find((item) => item.name === 'dsh-star-boot') : undefined
if (starPeer !== undefined) {
  check('peer 认得出星图开机的中文名', starPeer.label === '星图开机', String(starPeer.label))
  check('peer 报了星图开机的版本', /^\d+\.\d+\.\d+$/.test(starPeer.version), String(starPeer.version))
} else {
  check('peer 能找到星图开机', false, '这台机器上装着的 dsh-star-boot 没被列出来')
}

// 显示名优先读 locale/zh.json（DSH 自己的口径），没有 dshLabel 的插件也要有中文名。
const locale = (pkg) => {
  const dir = join(HERE, '..', '..', pkg, 'locale', 'zh.json')
  if (!existsSync(dir)) return undefined
  try {
    return JSON.parse(readFileSync(dir, 'utf8'))?.meta?.title
  } catch {
    return undefined
  }
}
for (const pkg of ['dsh-550c-boot', 'dsh-bili-scroll']) {
  const row = Array.isArray(peer.peers) ? peer.peers.find((item) => item.name === pkg) : undefined
  const want = locale(pkg)
  if (row === undefined || want === undefined) continue
  check(`peer 用 locale 里的中文名（${pkg}）`, row.label === want, `${String(row.label)} ≠ ${String(want)}`)
}
check('peer 只认 GET', (await fetch(origin + '/dsh-qq-bridge/peer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 405)

const memory = await (await fetch(origin + '/dsh-qq-bridge/memory')).json()
check('memory 返回可用性', memory.ok === true && typeof memory.up === 'boolean', JSON.stringify(memory))
if (memory.up === true) {
  check('memory 给的是带令牌的地址', typeof memory.url === 'string' && memory.url.startsWith('http://127.0.0.1:3100/memory?token='), String(memory.url).slice(0, 60))
  check('memory 明确可以嵌', memory.embeddable === true)
  check('memory 不带令牌拿不到（401）', (await fetch('http://127.0.0.1:3100/memory')).status === 401)
  const withToken = await fetch(memory.url)
  const html = await withToken.text()
  check('memory 带令牌能打开', withToken.status === 200 && html.indexOf('<canvas') >= 0, String(withToken.status))
  check('memory 允许被嵌（frame-ancestors *，无 X-Frame-Options）', String(withToken.headers.get('content-security-policy') || '').indexOf('frame-ancestors *') >= 0 && withToken.headers.get('x-frame-options') === null)
} else {
  check('memory 没在跑时给提示', typeof memory.error === 'string' && memory.error.length > 0)
}
check('memory 只认 GET', (await fetch(origin + '/dsh-qq-bridge/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 405)

// 更新接口：测试里把 API 指到一个没人听的端口，只验证「查不到也不崩、版本报得对」。
const update = await (await fetch(origin + '/dsh-qq-bridge/update')).json()
check('update 查不到也不崩', update.ok === true && typeof update.repo === 'string', JSON.stringify(update.error))
check('没设仓库时如实说', update.configured === false && update.enabled === false)
check('update 报的当前版本等于包版本', update.current === JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version, String(update.current))
check('update 离线时不冒充有新版本', update.behind === false && update.canInstall === false)

// 新增：诊断 / 备份 / 日志过滤 / 表情图
const diagnose = await (await fetch(origin + '/dsh-qq-bridge/diagnose')).json()
check('diagnose 给出可复制的文本', diagnose.ok === true && typeof diagnose.text === 'string' && diagnose.text.includes('插件版本'))
check('diagnose 带四灯和路径', diagnose.text.includes('四灯') && diagnose.text.includes('桥接目录'))

const backups = await (await fetch(origin + '/dsh-qq-bridge/backups')).json()
check('backups 三类都在', backups.ok === true && Array.isArray(backups.config) && Array.isArray(backups.role) && Array.isArray(backups.prompt))

const logsFiltered = await (await fetch(origin + '/dsh-qq-bridge/logs?n=10&q=zzz-not-exist')).json()
check('logs 支持关键词过滤', logsFiltered.ok === true && logsFiltered.lines.length === 0 && logsFiltered.query === 'zzz-not-exist')
check('logs 带上日志路径', typeof logsFiltered.path === 'string' && logsFiltered.path.endsWith('bridge.log'))

const stickersWithUrl = await (await fetch(origin + '/dsh-qq-bridge/stickers')).json()
check('stickers 带图地址', stickersWithUrl.ok === true && (stickersWithUrl.items.length === 0 || 'url' in stickersWithUrl.items[0]))
check('voice/preview 只认 POST', (await fetch(origin + '/dsh-qq-bridge/voice/preview')).status === 405)

const slang = await (await fetch(origin + '/dsh-qq-bridge/slang')).json()
check('slang 返回词条', slang.ok === true && Array.isArray(slang.items) && typeof slang.total === 'number')
check('slang 搜索能过', (await (await fetch(origin + '/dsh-qq-bridge/slang?q=zzzznotexist')).json()).items.length === 0)

const stickers = await (await fetch(origin + '/dsh-qq-bridge/stickers')).json()
check('stickers 返回列表', stickers.ok === true && Array.isArray(stickers.items))

const noop = await (
  await fetch(origin + '/dsh-qq-bridge/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  })
).json()
check('settings 空提交不改文件', noop.ok === true && noop.restartRequired === false && Array.isArray(noop.changed))

const badMode = await (
  await fetch(origin + '/dsh-qq-bridge/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'whatever' })
  })
).json()
check('settings 拒绝未知模式', badMode.ok === false)

const crossSite = await fetch(origin + '/dsh-qq-bridge/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
  body: JSON.stringify({ flags: { 'social.enabled': false } })
})
check('跨站写操作被拒（403）', crossSite.status === 403, String(crossSite.status))

const sameSite = await fetch(origin + '/dsh-qq-bridge/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:1' },
  body: JSON.stringify({})
})
check('同源写操作放行', sameSite.status === 200, String(sameSite.status))

const logs = await (await fetch(origin + '/dsh-qq-bridge/logs?n=5')).json()
check('logs 返回数组', logs.ok === true && Array.isArray(logs.lines) && logs.lines.length <= 5)

if (roles.ok && roles.roles.length > 0) {
  const current = roles.current || roles.roles[0].name
  const switched = await (
    await fetch(origin + '/dsh-qq-bridge/role', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: current })
    })
  ).json()
  check('role 原值写回不报错', switched.ok === true, JSON.stringify(switched.error))
}

const badRole = await (
  await fetch(origin + '/dsh-qq-bridge/role', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: '../../etc/passwd' })
  })
).json()
check('role 拒绝路径穿越', badRole.ok === false)

const badAction = await (
  await fetch(origin + '/dsh-qq-bridge/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'nope' })
  })
).json()
check('action 拒绝未知动作', badAction.ok === false)

server.close()

/* ---------- 2. 浏览器那一半 ---------- */

console.log('\n浏览器：')
let loaded = null
globalThis.window = { __ModuleLoader__: { load(entry) { loaded = entry } } }
const code = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
vm.runInThisContext(code, { filename: 'client.js' })
check('加载器 id 等于包名', loaded !== null && loaded.id === 'dsh-qq-bridge', loaded === null ? '没调用 load' : loaded.id)

/**
 * DSH 的壳在运行时把 React 注入进来，本机没有可 require 的 react。
 * 所以这里用一个「够用就好」的最小实现：只要组件在首次渲染时
 * 调用的 hook 顺序正确、不引用不存在的东西，它就能跑通；
 * 真出了问题（比如 useState 用错、访问 undefined 的属性）会直接抛。
 */
function miniReact() {
  const hooks = []
  let cursor = 0
  const api = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    useState(initial) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], () => {}]
    },
    useEffect(effect) {
      cursor++
      try {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanup()
      } catch (error) {
        throw new Error('useEffect 里抛了：' + error.message)
      }
    },
    useCallback(fn) {
      cursor++
      return fn
    },
    useMemo(fn) {
      cursor++
      return fn()
    },
    useRef(value) {
      cursor++
      return { current: value }
    }
  }
  return api
}

function render(node, depth) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => render(child, depth)).join('')
  if (typeof node.type === 'function') {
    cursorReset()
    const out = node.type(node.props)
    return render(out, (depth || 0) + 1)
  }
  if (typeof node.type === 'string') {
    const cls = node.props && typeof node.props.className === 'string' ? ' class="' + node.props.className + '"' : ''
    return '<' + node.type + cls + '>' + node.children.map((child) => render(child, depth)).join('') + '</>'
  }
  return ''
}

let cursorValue = 0
function cursorReset() {
  cursorValue = 0
}

const mod = loaded.factory((id) => {
  if (id === 'react') return miniReact()
  throw new Error('未预期的依赖：' + id)
})
check('客户端导出 apply', typeof mod.apply === 'function')
check('客户端 inject slots', Array.isArray(mod.inject) && mod.inject.includes('slots'))

let pageHtml = ''
let renderError = ''
try {
  pageHtml = render({ type: mod.__page, props: {}, children: [] }, 0)
} catch (error) {
  renderError = error.message
}
check('首次渲染不崩', renderError === '', renderError)
check('页面里有「运行状态」', pageHtml.indexOf('运行状态') >= 0, pageHtml.slice(0, 120))
check('页面里有「记忆星图」', pageHtml.indexOf('记忆星图') >= 0)
// 星图是重货（canvas 全屏动画）：没点之前绝不能自己挂上去。
check('星图不会自己加载 iframe', pageHtml.indexOf('<iframe') < 0)

/* ---------- 3. 拓展接口 ---------- */

console.log('\n拓展：')
check('客户端导出槽名', typeof mod.__slot === 'string' && mod.__slot === 'settings.qq-bridge.card', String(mod.__slot))
check('新用户第一屏：没程序时收起', mod.__firstRun({ exists: false }) === true)
check('新用户第一屏：装了程序就展开', mod.__firstRun({ exists: true }) === false)
check('新用户第一屏：读不到状态时照常展开', mod.__firstRun(null) === false)

let registered = null
mod.apply({
  slots: {
    inject(_name, callback) {
      return callback()
    },
    register(option) {
      registered = option
      return () => {}
    }
  },
  effect(fn) {
    return fn()
  }
})
check('注册设置页时声明了子槽位', registered !== null && registered.children !== undefined && registered.children[mod.__slot] !== undefined, JSON.stringify(registered && registered.children))
check('子槽位是 list 作用域', registered !== null && registered.children[mod.__slot].kind === 'list' && registered.children[mod.__slot].scope === 'root')

let fallback = null
mod.apply({
  slots: {
    inject(_name, callback) {
      return callback()
    },
    register(option) {
      if (option.children !== undefined) throw new Error('这版 DSH 不认 children')
      fallback = option
      return () => {}
    }
  },
  effect(fn) {
    return fn()
  }
})
check('不认 children 时退回不带槽位注册', fallback !== null && fallback.children === undefined && fallback.name === 'settings.section')


let seen = null
const extHtml = render(
  {
    type: mod.__page,
    props: {
      renderSlot(name, props) {
        seen = { name, props }
        return '扩展卡片内容'
      }
    },
    children: []
  },
  0
)
check('页面把扩展槽画在最后', seen !== null && seen.name === mod.__slot, String(seen && seen.name))
check('扩展卡片真的渲染出来', extHtml.indexOf('扩展卡片内容') >= 0)
check('扩展卡片拿到 base / version', seen !== null && seen.props.base === '/dsh-qq-bridge' && typeof seen.props.version === 'string')
check('槽位空着就不画空框', render({ type: mod.__page, props: { renderSlot: () => null }, children: [] }, 0).indexOf('qbg-ext') < 0)

const boomHtml = render({ type: mod.__page, props: { renderSlot() { throw new Error('坏卡片') } }, children: [] }, 0)
check('扩展卡片抛异常不崩整页', boomHtml.indexOf('运行状态') >= 0 && boomHtml.indexOf('扩展卡片渲染失败') >= 0)


console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
