/**
 * 「全速模式」那个开关的取证。
 *
 * 它是**反向**开关：界面上叫 `fullSpeedMode`（勾上 = 全速），写进 config 的却是
 * `socialV2.budget.enabled = false`。这种取反最容易写反——反了的话，用户点「全速」
 * 结果把省算力打开了，而且看不出来。
 *
 * 这里用一个临时桥接目录（DSH_QQ_BRIDGE_ROOT），不碰本机 config：
 *   1. 省算力开着时，开关显示为「关」；
 *   2. 勾上之后，config 里 budget.enabled 必须变成 false；
 *   3. 再读回来，开关显示为「开」；
 *   4. 取消勾选，config 里回到 true；
 *   5. 响应里要告诉前端「已经替你重启了」（restarted 字段存在）。
 *
 * 用法：node test/fullspeed.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/* ---------- 造一个临时桥接目录 ---------- */

const root = mkdtempSync(join(tmpdir(), 'qbfull-'))
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'src', 'bridge.js'), '// stub\n')
writeFileSync(join(root, 'config.json'), JSON.stringify({
  ownerQQ: '10001',
  allow: { private: [], groups: ['123456'] },
  socialV2: { enabled: true, budget: { enabled: true, peakEffort: 'low', turnsPerHour: 10 } }
}, null, 2))

process.env.DSH_QQ_BRIDGE_ROOT = root
process.env.DSH_QQ_BRIDGE_NO_AUTOSTART = '1'

const { apply } = await import('../lib/index.js')

/* ---------- 挂路由（和 host.mjs 同一套最小 ctx） ---------- */

const routes = new Map()
apply({
  on() {},
  inject(_deps, body) {
    body({
      effect(fn) {
        return fn()
      },
      webServer: {
        register(route) {
          routes.set(route.path, route.handler)
          return () => {}
        }
      }
    })
  }
})

const origin = 'http://127.0.0.1:1' // 只为同源校验：不带 Origin 的本机脚本放行
const call = async (path, init) => {
  const url = origin + path
  const handler = routes.get(new URL(url).pathname)
  if (handler === undefined) throw new Error('没有这条路由：' + path)
  // readBody 用的是 req.on(...)，所以这里造一个最小的事件发射器。
  const req = {
    method: (init?.method ?? 'GET'),
    url,
    headers: {},
    _handlers: {},
    on(event, fn) {
      if (this._handlers[event] === undefined) this._handlers[event] = []
      this._handlers[event].push(fn)
      return this
    },
    emit(event, arg) {
      for (const fn of this._handlers[event] ?? []) fn(arg)
    }
  }
  queueMicrotask(() => {
    if (init?.body !== undefined) req.emit('data', Buffer.from(init.body))
    req.emit('end')
  })
  const box = { status: 0, body: null }
  const res = {
    headersSent: false,
    writeHead(status) { box.status = status; this.headersSent = true },
    end(body) { box.body = body === undefined ? null : JSON.parse(body) }
  }
  await handler(req, res)
  return box
}

const budgetEnabled = () => JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).socialV2.budget.enabled

/* ---------- 1. 初始状态 ---------- */

console.log('读取')
const first = await call('/dsh-qq-bridge/settings')
check('settings 读得到', first.status === 200 && first.body.ok === true)
check('开关表里有 fullSpeedMode', first.body.meta.flags.fullSpeedMode !== undefined, JSON.stringify(Object.keys(first.body.meta.flags)))
check('省算力开着时，全速开关显示为关', first.body.flags.fullSpeedMode === false, String(first.body.flags.fullSpeedMode))
check('说明文字讲了峰时和重启', /9–12|9-12/.test(first.body.meta.flags.fullSpeedMode.hint) && first.body.meta.flags.fullSpeedMode.hint.includes('重启'))

/* ---------- 2. 打开全速 ---------- */

console.log('打开全速')
const turnedOn = await call('/dsh-qq-bridge/settings', {
  method: 'POST',
  body: JSON.stringify({ flags: { fullSpeedMode: true } })
})
check('保存成功', turnedOn.status === 200 && turnedOn.body.ok === true, JSON.stringify(turnedOn.body))
check('config 里 budget.enabled 变成 false', budgetEnabled() === false, String(budgetEnabled()))
check('变更说明里写的是全速模式=开', String((turnedOn.body.changed || []).join('')).includes('全速模式') && String((turnedOn.body.changed || []).join('')).includes('=开'), JSON.stringify(turnedOn.body.changed))
check('响应里告诉前端已重启', Object.prototype.hasOwnProperty.call(turnedOn.body, 'restarted'), JSON.stringify(turnedOn.body))
check('顺手备份了 config', existsSync(join(root, 'config.json')) && readFileSync(join(root, 'config.json'), 'utf8').includes('"enabled": false'))

/* ---------- 3. 读回来 ---------- */

console.log('再读')
const second = await call('/dsh-qq-bridge/settings')
check('全速开关现在显示为开', second.body.flags.fullSpeedMode === true, String(second.body.flags.fullSpeedMode))
check('别的开关没被带歪', second.body.flags['socialV2.enabled'] === true, String(second.body.flags['socialV2.enabled']))

/* ---------- 4. 关回去 ---------- */

console.log('关回去')
const turnedOff = await call('/dsh-qq-bridge/settings', {
  method: 'POST',
  body: JSON.stringify({ flags: { fullSpeedMode: false } })
})
check('关掉成功', turnedOff.body.ok === true)
check('config 里回到 true', budgetEnabled() === true, String(budgetEnabled()))
const third = await call('/dsh-qq-bridge/settings')
check('开关跟着回到关', third.body.flags.fullSpeedMode === false, String(third.body.flags.fullSpeedMode))

/* ---------- 5. 不认的键不许写进去 ---------- */

console.log('边界')
const bogus = await call('/dsh-qq-bridge/settings', {
  method: 'POST',
  body: JSON.stringify({ flags: { 'socialV2.budget.enabled': false } })
})
check('绕过开关名直接写 config 路径会被忽略', bogus.body.ok === true && budgetEnabled() === true, String(budgetEnabled()))

console.log(failures.length === 0 ? '\n全部通过' : `\n${String(failures.length)} 项失败`)
process.exitCode = failures.length === 0 ? 0 : 1