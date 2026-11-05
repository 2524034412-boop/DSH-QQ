/**
 * 「新用户第一屏」回归测试。
 *
 * 跑法：
 *   node test/firstrun.mjs
 *
 * 它把浏览器那一半真的渲染出来（一个会更新状态的迷你 React），
 * 然后按三种用户状态看页面到底长什么样：
 *
 *   1. 什么都没装    —— 只该剩「新手引导 + 运行状态」，别的卡片全收起来
 *   2. 装了没启动    —— 引导说缺 config，人格卡是空态（不是空下拉 + roles/.md）
 *   3. 启动了没配    —— 运行设置能用；旧面板按钮不出现
 *
 * 这不是单测某个函数，是盯着「新用户打开看到什么」这件事本身：
 * 谁以后再加卡片把第一屏弄脏了，这里会红。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import vm from 'node:vm'

let failures = 0
function check(label, condition, detail) {
  const ok = Boolean(condition)
  if (!ok) failures++
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || detail === undefined ? '' : '  → ' + detail))
}

/** 只有开发者才看得懂的东西，不该出现在新用户的第一屏。 */
function noDeveloperJargon(text) {
  const jargon = ['DSH_QQ_BRIDGE_ROOT', 'qq-bridge-path.json', 'console-token', 'Junction', 'junction']
  return jargon.every((word) => text.indexOf(word) < 0)
}

const HERE = dirname(fileURLToPath(import.meta.url))

/* ---------- 迷你 React：状态会更新，分多轮渲染 ---------- */

function makeReact() {
  const stores = new Map()
  let current = null
  let pass = 0
  return {
    setPass(value) { pass = value },
    begin(type) {
      if (!stores.has(type)) stores.set(type, { list: [], cursor: 0 })
      current = stores.get(type)
      current.cursor = 0
    },
    api: {
      createElement(type, props, ...children) {
        return { type, props: props || {}, children: children.flat() }
      },
      useState(initial) {
        const store = current
        const index = store.cursor++
        if (!(index in store.list)) store.list[index] = typeof initial === 'function' ? initial() : initial
        return [store.list[index], (next) => { store.list[index] = typeof next === 'function' ? next(store.list[index]) : next }]
      },
      // 只在第一轮跑 effect：之后状态已经在 store 里，再跑就是重复请求。
      useEffect(effect) {
        const index = current.cursor++
        if (pass === 1) current.list['cleanup' + index] = effect()
      },
      useCallback(fn) { current.cursor++; return fn },
      useMemo(fn) { current.cursor++; return fn() },
      useRef(value) { current.cursor++; return { current: value } }
    }
  }
}

function renderTree(node, react, errors) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => renderTree(child, react, errors)).join('')
  if (typeof node.type === 'function') {
    react.begin(node.type)
    try {
      return renderTree(node.type(node.props), react, errors)
    } catch (error) {
      errors.push(String((error && error.message) || error))
      return '[崩:' + String((error && error.message) || error).slice(0, 60) + ']'
    }
  }
  if (typeof node.type === 'string') {
    return '<' + node.type + '>' + node.children.map((child) => renderTree(child, react, errors)).join('') + '</>'
  }
  return ''
}

/* ---------- 一个场景：起宿主 + 渲染页面 ---------- */

async function scenario(name, setup) {
  console.log('\n场景：' + name)

  const root = mkdtempSync(join(tmpdir(), 'qbfirst-' + name + '-'))
  let server = null
  let realFetch = null
  // 中途任何一步炸掉，也要把临时目录和全局 fetch 收干净 —— 上次客户端语法错，
  // 就在 %TEMP% 里留下了一个 qbfirst-* 目录。
  try {
    setup(root)
    process.env.DSH_QQ_BRIDGE_ROOT = root
    // 测试里别让插件自己去拉桥接，也别真去问 GitHub
    process.env.DSH_QQ_BRIDGE_NO_AUTOSTART = '1'
    process.env.DSH_QQ_BRIDGE_UPDATE_API = 'http://127.0.0.1:1'
    process.env.DSH_QQ_BRIDGE_REPO = ''
    process.env.DSH_QQ_BRIDGE_UPDATE_CONFIG = join(root, 'update-config.json')

    const { apply } = await import('../lib/index.js?v=' + name)
    const routes = new Map()
    apply({
      inject(services, callback) {
        callback({
          webServer: { register({ path, handler }) { routes.set(path, handler); return () => {} } },
          effect(fn) { return fn() }
        })
      }
    })

    server = createServer((req, res) => {
      const path = new URL(req.url, 'http://local').pathname
      const handler = routes.get(path)
      if (handler === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'no route' }))
        return
      }
      Promise.resolve(handler(req, res)).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(error) }))
        }
      })
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const origin = 'http://127.0.0.1:' + server.address().port

    realFetch = globalThis.fetch
    globalThis.fetch = (url, init) => realFetch(String(url).startsWith('/') ? origin + url : url, init)

    let loaded = null
    globalThis.window = { __ModuleLoader__: { load(entry) { loaded = entry } } }
    vm.runInThisContext(readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8'), { filename: 'client.js' })
    const react = makeReact()
    const mod = loaded.factory((id) => {
      if (id === 'react') return react.api
      throw new Error('未预期的依赖：' + id)
    })

    const errors = []
    const tree = { type: mod.__page, props: { renderSlot: () => null }, children: [] }
    react.setPass(1)
    renderTree(tree, react, errors)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    react.setPass(2)
    renderTree(tree, react, errors)
    await new Promise((resolve) => setTimeout(resolve, 600))
    react.setPass(3)
    const html = renderTree(tree, react, errors)

    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
    return { text, errors }
  } finally {
    if (realFetch !== null) globalThis.fetch = realFetch
    if (server !== null) server.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/* ---------- 1. 什么都没装 ---------- */

const empty = await scenario('empty', () => {})
check('渲染不崩', empty.errors.length === 0, empty.errors.join(' | '))
check('还留着新手引导', empty.text.indexOf('新手引导') >= 0)
check('还留着运行状态', empty.text.indexOf('运行状态') >= 0)
check('收起后不再是一屏「找不到」', empty.text.indexOf('找不到 config.json') < 0)
check('不显示需要桥接数据的卡片', empty.text.indexOf('她的本子') < 0 && empty.text.indexOf('收藏的表情') < 0)
check('说明会自动展开', empty.text.indexOf('会自动展开') >= 0)
check('端口有人应答也不说桥接正常', empty.text.indexOf('桥接正常') < 0, empty.text.slice(0, 200))

/* ---------- 2. 装了没启动 ---------- */

const installed = await scenario('installed', (root) => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'bridge.js'), '// stub\n')
})
check('渲染不崩', installed.errors.length === 0, installed.errors.join(' | '))
check('引导说缺 config（人话）', installed.text.indexOf('还没有配置文件') >= 0)
check('不甩环境变量名给新用户', noDeveloperJargon(installed.text))
check('人格卡是空态', installed.text.indexOf('还没有角色文件') >= 0)
check('不再出现「roles/.md」这种残句', installed.text.indexOf('roles/.md') < 0)
check('不出现旧面板按钮', installed.text.indexOf('打开旧面板') < 0)

/* ---------- 3. 启动了没配 ---------- */

const started = await scenario('started', (root) => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'bridge.js'), '// stub\n')
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ownerQQ: '', silent: false, allow: { private: [], groups: [] } }, null, 2))
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(root, 'roles'), { recursive: true })
})
check('渲染不崩', started.errors.length === 0, started.errors.join(' | '))
check('运行设置出来了', started.text.indexOf('运行设置') >= 0 && started.text.indexOf('模式') >= 0)
check('白名单空着会被点名', started.text.indexOf('她谁也不回') >= 0)
check('管理员没填会被点名', started.text.indexOf('审批和管理命令都用不了') >= 0)
check('人格卡还是空态', started.text.indexOf('还没有角色文件') >= 0)

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
