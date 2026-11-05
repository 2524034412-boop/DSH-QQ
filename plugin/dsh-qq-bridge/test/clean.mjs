/**
 * 全新用户的空环境测试。
 *
 * 场景：一个刚装好 DSH 的人，桥接目录是空的（没有 config.json、没有 roles、
 * 没有 state、也没有 console-token）。插件不能崩、不能白屏，而且要能说清
 * 「下一步该干什么」。
 *
 *      node test/clean.mjs
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

let failures = 0
function check(label, condition, detail) {
  const ok = Boolean(condition)
  if (!ok) failures++
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || detail === undefined ? '' : '  → ' + detail))
}

const root = join(tmpdir(), 'qbfresh-' + process.pid)
mkdirSync(root, { recursive: true })
process.env.DSH_QQ_BRIDGE_ROOT = root
// 测试里别让插件自己去拉桥接
process.env.DSH_QQ_BRIDGE_NO_AUTOSTART = '1'

const { apply } = await import('../lib/index.js')
const routes = new Map()
apply({
  inject(services, callback) {
    callback({
      webServer: { register({ path, handler }) { routes.set(path, handler); return () => {} } },
      effect(fn) { return fn() }
    })
  }
})

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname
  const handler = routes.get(path)
  if (handler === undefined) { res.writeHead(404).end('no route'); return }
  Promise.resolve(handler(req, res)).catch((error) => res.writeHead(500).end(String(error)))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port

const get = async (path) => {
  const response = await fetch(origin + path)
  return { status: response.status, body: await response.json().catch(() => null) }
}

console.log('\n空环境（没有 config / roles / state）：')
const status = await get('/dsh-qq-bridge/status')
check('status 不崩', status.status === 200 && status.body.ok === true)
check('status 说清目录不存在', status.body.exists === false, String(status.body.exists))
check('status 给出下一步', typeof status.body.nextStep === 'string' && status.body.nextStep.length > 0, status.body.nextStep)

const config = await get('/dsh-qq-bridge/config')
check('config 返回明确错误而不是崩', config.status === 404 && config.body.ok === false)

const settings = await get('/dsh-qq-bridge/settings')
check('settings 返回明确错误', settings.status === 404 || (settings.body && settings.body.ok === false))

const roles = await get('/dsh-qq-bridge/roles')
check('roles 空列表不崩', roles.status === 200 && Array.isArray(roles.body.roles) && roles.body.roles.length === 0)

const prompt = await get('/dsh-qq-bridge/prompt')
check('prompt 缺文件时给错误', prompt.status === 404 || prompt.body.ok === false)

const slang = await get('/dsh-qq-bridge/slang')
check('slang 空目录不崩', slang.status === 200 && Array.isArray(slang.body.items) && slang.body.total === 0)

const stickers = await get('/dsh-qq-bridge/stickers')
check('stickers 空目录不崩', stickers.status === 200 && Array.isArray(stickers.body.items))

const social = await get('/dsh-qq-bridge/social')
check('social 空目录不崩', social.status === 200 && social.body.ok === true)

const logs = await get('/dsh-qq-bridge/logs')
check('logs 缺文件不崩', logs.status === 200 && Array.isArray(logs.body.lines))

const setup = await get('/dsh-qq-bridge/setup')
check('setup 给出检查清单', setup.status === 200 && Array.isArray(setup.body.steps) && setup.body.steps.length >= 4)
check('setup 报告缺什么', typeof setup.body.ready === 'boolean')
check('setup 能查出配置缺失', setup.body.steps.some((step) => step.id === 'config' && step.ok === false))
// 本机 3100 端口可能真有个桥接在跑：程序目录是空的时候，绝不能说「桥接在线」。
check('setup 不拿端口冒充桥接在线', setup.body.steps.find((step) => step.id === 'bridge').ok === false)
check('setup 的 QQ 相关步骤不在缺程序时假绿', setup.body.steps.filter((step) => step.id === 'snowluma' || step.id === 'onebot').every((step) => step.ok === false))

const memoryEmpty = await get('/dsh-qq-bridge/memory')
check('memory 缺程序时不给地址', memoryEmpty.status === 200 && memoryEmpty.body.url === '' && memoryEmpty.body.up === false, JSON.stringify(memoryEmpty.body))

// 新手点「从示例创建配置」：有 config.example.json 时应该能生成 config.json
writeFileSync(join(root, 'config.example.json'), JSON.stringify({ ownerQQ: 0, allow: { private: [], groups: [] } }, null, 2))
const init = await (await fetch(origin + '/dsh-qq-bridge/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'init-config' })
})).json()
check('能从示例生成配置', init.ok === true && init.created === true, JSON.stringify(init))

const configAfter = await get('/dsh-qq-bridge/config')
check('生成后 config 能读', configAfter.status === 200 && configAfter.body.ok === true)

// 旧面板在新装机器上就该是隐藏的：示例配置里没这个键时，开关要显示成「开」。
const settingsAfter = await get('/dsh-qq-bridge/settings')
check('旧面板默认隐藏（配置里没键也算隐藏）', settingsAfter.body.flags.hideConsolePages === true, JSON.stringify(settingsAfter.body.flags && settingsAfter.body.flags.hideConsolePages))
// 同理：重启 DSH 后自动拉起桥接，默认也是开。
check('启动时自动拉起桥接默认开', settingsAfter.body.flags.autoStartBridge === true)
check('开关表里能看到这一项', settingsAfter.body.meta.flags.autoStartBridge !== undefined && settingsAfter.body.meta.flags.autoStartBridge.label.length > 0)

const initAgain = await (await fetch(origin + '/dsh-qq-bridge/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'init-config' })
})).json()
check('不会覆盖已有配置', initAgain.ok === true && initAgain.created === false)

// 真实新用户路径：配置缺失时点「重启桥接」（或 DSH 启动时自动拉起）——
// 拉起脚本只会报「读不到 config.json」，所以插件必须先把示例复制过去。
rmSync(join(root, 'config.json'), { force: true })
mkdirSync(join(root, 'scripts'), { recursive: true })
writeFileSync(
  join(root, 'scripts', 'align-dsh-port.mjs'),
  [
    "import { mkdirSync, writeFileSync } from 'node:fs'",
    "mkdirSync(new URL('../state/', import.meta.url), { recursive: true })",
    "writeFileSync(new URL('../state/align-ran.txt', import.meta.url), 'ok')",
    ''
  ].join('\n')
)
const restart = await (await fetch(origin + '/dsh-qq-bridge/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'restart' })
})).json()
check('缺配置时「重启桥接」不报错', restart.ok === true, JSON.stringify(restart))
await new Promise((resolve) => setTimeout(resolve, 1500))
check('缺配置时自动按示例生成', existsSync(join(root, 'config.json')))
check('拉起脚本真的跑起来了', existsSync(join(root, 'state', 'align-ran.txt')))

server.close()
rmSync(root, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
