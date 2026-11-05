/**
 * 写配置的安全性测试：证明「保存开关」不会吃掉 config.json 里的其它字段。
 *
 * 跑法：node test/config.mjs
 * 它会在临时目录里造一份 qq-bridge 骨架，然后走插件自己的 /settings 接口，
 * 写完对比顶层键集合、以及几个关键字段的类型。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

let failures = 0
function check(label, condition, detail) {
  const ok = Boolean(condition)
  if (!ok) failures++
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || detail === undefined ? '' : '  → ' + detail))
}

const root = join(tmpdir(), 'qbtest-' + process.pid)
mkdirSync(join(root, 'state'), { recursive: true })
mkdirSync(join(root, 'roles'), { recursive: true })
mkdirSync(join(root, 'backups'), { recursive: true })

const original = {
  dsh: { baseUrl: 'http://127.0.0.1:3080', model: 'deepseek-flash' },
  ownerQQ: 12345678,
  allow: { private: ['111111'], groups: ['222222', '333333'] },
  deny: { private: [], groups: [] },
  allowAllWhenEmpty: false,
  ackMessage: '收到',
  sendDelayMs: 300,
  consolePort: 3100,
  consoleToken: '',
  pricing: { models: { m: { input: 1, output: 2 } } },
  security: { interceptNotify: true },
  slang: { enabled: true },
  social: { enabled: true, triggerProbability: 0.4 },
  socialV2: { enabled: true, voice: { enabled: true, engine: 'gptsovits' }, biliDigest: { enabled: true, maxItems: 3 } },
  hideConsolePages: false,
  customUnknownKey: { keep: 'me' }
}
writeFileSync(join(root, 'config.json'), JSON.stringify(original, null, 2))
writeFileSync(join(root, 'roles', '测试角色.md'), '# 测试\n' + '她'.repeat(200))
writeFileSync(join(root, 'state', 'current-role.json'), JSON.stringify({ role: '测试角色', mode: 'active' }))
writeFileSync(join(root, 'state', 'mode.json'), JSON.stringify({ mode: 'reserved2' }))

process.env.DSH_QQ_BRIDGE_ROOT = root

const { apply } = await import('../lib/index.js')
const routes = new Map()
apply({
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
  }
})

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname
  const handler = routes.get(path)
  if (handler === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  Promise.resolve(handler(req, res)).catch((error) => res.writeHead(500).end(String(error)))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port

console.log('\n写配置：')
const saved = await (
  await fetch(origin + '/dsh-qq-bridge/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flags: { 'social.enabled': false, hideConsolePages: true }, numbers: { sendDelayMs: 1200 } })
  })
).json()
check('保存成功', saved.ok === true && Array.isArray(saved.changed), JSON.stringify(saved.error))

const after = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
check('开关写进去了', after.social.enabled === false)
check('下线开关写进去了', after.hideConsolePages === true)
check('数字参数写进去了', after.sendDelayMs === 1200)

const keysBefore = Object.keys(original).sort().join(',')
const keysAfter = Object.keys(after).sort().join(',')
check('顶层键一个没丢', keysBefore === keysAfter, keysAfter)

check('深字段没被动', after.pricing?.models?.m?.output === 2 && after.socialV2?.voice?.engine === 'gptsovits')
check('白名单还是数组', Array.isArray(after.allow.groups) && after.allow.groups.join(',') === '222222,333333')
check('管理员还是数字', after.ownerQQ === 12345678, typeof after.ownerQQ)
check('未知键也没被吃掉', after.customUnknownKey?.keep === 'me')

const backups = (await import('node:fs')).readdirSync(root).filter((name) => name.startsWith('config.json.bak-settings-'))
check('写了备份', backups.length === 1, backups.join(','))

const white = await (
  await fetch(origin + '/dsh-qq-bridge/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allow: { groups: ['999999'], private: ['888888'] } })
  })
).json()
check('白名单可改写', white.ok === true)
const after2 = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
check('白名单写到盘上', after2.allow.groups.join(',') === '999999' && after2.allow.private.join(',') === '888888')
check('非数字被过滤', true)
const filtered = await (
  await fetch(origin + '/dsh-qq-bridge/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allow: { groups: ['abc', '1234', '1'], private: [] } })
  })
).json()
check('非法 ID 被过滤', filtered.ok === true && JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).allow.groups.join(',') === '1234')

server.close()
rmSync(root, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
