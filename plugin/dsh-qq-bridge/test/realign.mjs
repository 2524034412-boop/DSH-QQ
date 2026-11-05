/**
 * 「桥接在跑，但连的是上一代 DSH」这条路的取证。
 *
 * 2026-11-05 早上真实踩到：DSH 重启换了端口，桥接还认着旧地址，
 * 四盏灯里只有 dsh 那盏红着，片头和设置页都显示「待修」。
 * 旧逻辑是「3100 在听就什么都不做」，正好把这种情况绕过。
 *
 * 这里只验判断本身（不真的去起进程）：
 *   1. 旧端口已经没人听 → 判定「要重新对齐」；
 *   2. 旧端口还活着 → 判定「不用动」（DSH 没换地址，别去重启人家的桥接）；
 *   3. 地址读不懂 / 没配 / 没端口 → 一律「不用动」（宁可不动，也不误杀）。
 *
 * 用法：node test/realign.mjs
 */

import { createServer } from 'node:http'
import { __internal } from '../lib/index.js'

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 起一个真端口，关掉之后再问它，答案必须翻过来。 */
const server = createServer((req, res) => res.end('ok'))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = 'http://127.0.0.1:' + String(port)

console.log('configuredDshPortAlive')

// 1. 还活着
check(
  '端口还活着 → 认为没换地址',
  (await __internal.configuredDshPortAlive({ dsh: { baseUrl } })) === true,
)

// 2. 关掉之后必须变成 false（这就是「DSH 重启换了端口」的形状）
await new Promise((resolve) => server.close(resolve))
check(
  '端口关掉之后 → 认为地址失效了',
  (await __internal.configuredDshPortAlive({ dsh: { baseUrl } })) === false,
  baseUrl + ' 应该已经没人听',
)

// 3. 各种读不出端口的情况，一律不许当成「失效」（否则会误重启正常在跑的桥接）
for (const [label, config] of [
  ['没配 dsh', {}],
  ['dsh 是 null', { dsh: null }],
  ['baseUrl 是空串', { dsh: { baseUrl: '' } }],
  ['baseUrl 不是字符串', { dsh: { baseUrl: 42 } }],
  ['baseUrl 是垃圾', { dsh: { baseUrl: '不是地址' } }],
  ['地址没有端口', { dsh: { baseUrl: 'http://127.0.0.1' } }],
  ['config 是 null', null],
]) {
  check(
    `${label} → 不动手`,
    (await __internal.configuredDshPortAlive(config)) === true,
  )
}

console.log(failures.length === 0 ? '\n全部通过' : `\n${String(failures.length)} 项失败`)
process.exitCode = failures.length === 0 ? 0 : 1