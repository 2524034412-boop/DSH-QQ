/**
 * 「检查更新 / 一键打补丁」的端到端测试。
 *
 * 跑法：
 *   node test/update.mjs
 *
 * 它不碰真插件、也不碰真 GitHub：
 *   - 起一个假的 GitHub API（返回 release 列表和补丁包字节）
 *   - 补丁包是现场用 tar 打的 zip（内容是一个 9.9.9 版的假插件）
 *   - 插件目录指向临时目录（DSH_QQ_BRIDGE_SELF_DIR）
 * 然后真的走一遍：查 → 下载 → 解压 → 校验 → 备份 → 覆盖。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version

let failures = 0
function check(label, condition, detail) {
  const ok = Boolean(condition)
  if (!ok) failures++
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || detail === undefined ? '' : '  → ' + detail))
}

const work = mkdtempSync(join(tmpdir(), 'qbup-'))
const fakeSelf = join(work, 'plugins', 'dsh-qq-bridge')
const fixture = join(work, 'fixture')
const wrongFixture = join(work, 'wrong')
const assetZip = join(work, 'asset.zip')
const wrongZip = join(work, 'wrong.zip')

function writePlugin(dir, version, body) {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-qq-bridge', version, type: 'module' }, null, 2))
  writeFileSync(join(dir, 'lib', 'index.js'), body)
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert: []\n')
}

function makeZip(from, to) {
  const result = spawnSync('tar', ['-a', '-c', '-f', to, '-C', from, '.'], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('打 zip 失败：' + String(result.stderr || result.stdout))
}

// 当前装的（旧） / 补丁里的（新） / 一个不属于这个插件的包
writePlugin(fakeSelf, '0.1.0', '// old\n')
writePlugin(fixture, '9.9.9', '// new\n')
writePlugin(wrongFixture, '9.9.9', '// wrong\n')
writeFileSync(join(wrongFixture, 'package.json'), JSON.stringify({ name: 'someone-else', version: '9.9.9' }, null, 2))
makeZip(fixture, assetZip)
makeZip(wrongFixture, wrongZip)

let releaseMode = 'normal'
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://local')
  if (url.pathname === '/repos/owner/repo/releases') {
    if (releaseMode === 'empty') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
      return
    }
    const assetName = releaseMode === 'wrong' ? 'dsh-qq-bridge-9.9.9.zip' : 'dsh-qq-bridge-9.9.9.zip'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([
      {
        tag_name: 'qq-bridge-v9.9.9',
        name: 'qq bridge 9.9.9',
        body: '修了三个小毛病',
        html_url: 'https://example.invalid/release',
        published_at: '2026-11-04T12:00:00Z',
        assets: [{ name: assetName, size: 1024, browser_download_url: 'http://127.0.0.1:' + server.address().port + (releaseMode === 'wrong' ? '/wrong.zip' : '/asset.zip') }]
      }
    ]))
    return
  }
  if (url.pathname === '/asset.zip' || url.pathname === '/wrong.zip') {
    const file = url.pathname === '/asset.zip' ? assetZip : wrongZip
    const buffer = readFileSync(file)
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buffer.length })
    res.end(buffer)
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"no route"}')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port

process.env.DSH_QQ_BRIDGE_UPDATE_API = origin
process.env.DSH_QQ_BRIDGE_REPO = 'owner/repo'
process.env.DSH_QQ_BRIDGE_SELF_DIR = fakeSelf
process.env.DSH_QQ_BRIDGE_UPDATE_CONFIG = join(work, 'update-config.json')
process.env.DSH_QQ_BRIDGE_NO_AUTOSTART = '1'
process.env.DSH_QQ_BRIDGE_ROOT = join(work, 'bridge-root')
mkdirSync(process.env.DSH_QQ_BRIDGE_ROOT, { recursive: true })

const { apply } = await import('../lib/index.js?v=update')
const routes = new Map()
apply({
  inject(services, callback) {
    callback({
      webServer: { register({ path, handler }) { routes.set(path, handler); return () => {} } },
      effect(fn) { return fn() }
    })
  }
})

const plugin = createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname
  const handler = routes.get(path)
  if (handler === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"ok":false,"error":"no route"}')
    return
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    }
  })
})
await new Promise((done) => plugin.listen(0, '127.0.0.1', done))
const pluginOrigin = 'http://127.0.0.1:' + plugin.address().port

const getUpdate = async (query = '') => (await fetch(pluginOrigin + '/dsh-qq-bridge/update' + query)).json()
const postUpdate = async (body) => {
  const response = await fetch(pluginOrigin + '/dsh-qq-bridge/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}

console.log('\n检查更新：')
const info = await getUpdate('?refresh=1')
check('查到新版本', info.latest === '9.9.9', JSON.stringify(info))
check('认得出版本更旧', info.behind === true)
check('可以装', info.canInstall === true && info.asset && info.asset.name === 'dsh-qq-bridge-9.9.9.zip')
check('带回了更新说明', info.notes === '修了三个小毛病')

console.log('\n一键装补丁：')
const applied = await postUpdate({ action: 'apply' })
check('装补丁成功', applied.status === 200 && applied.body.ok === true, JSON.stringify(applied.body))
check('返回了来源和目标版本', applied.body.from === REAL_VERSION && applied.body.to === '9.9.9', JSON.stringify([applied.body.from, applied.body.to, REAL_VERSION]))
check('要求重启', applied.body.restartRequired === true)
check('文件真的被换掉了', JSON.parse(readFileSync(join(fakeSelf, 'package.json'), 'utf8')).version === '9.9.9' && readFileSync(join(fakeSelf, 'lib', 'index.js'), 'utf8') === '// new\n')
check('旧版本备份还在', existsSync(applied.body.backup) && JSON.parse(readFileSync(join(applied.body.backup, 'package.json'), 'utf8')).version === '0.1.0', String(applied.body.backup))

console.log('\n异常情况：')
releaseMode = 'wrong'
process.env.DSH_QQ_BRIDGE_REPO = 'owner/repo'
const wrong = await postUpdate({ action: 'apply' })
check('别的插件的包会被拒绝', wrong.status === 500 && String(wrong.body.error).includes('别的插件'), JSON.stringify(wrong.body))

releaseMode = 'empty'
const empty = await getUpdate('?refresh=1')
check('没有发布包时说清楚', empty.checked === true && empty.latest === '' && String(empty.error).includes('qq-bridge-v'), JSON.stringify(empty))

const notOurAction = await postUpdate({ action: 'nope' })
check('不认识的更新动作被拒', notOurAction.status === 400)

console.log('\n更新源没配置时：')
delete process.env.DSH_QQ_BRIDGE_REPO
releaseMode = 'normal'
const unconfigured = await getUpdate('?refresh=1')
check('没设仓库时不冒充在检查', unconfigured.enabled === false && unconfigured.configured === false, JSON.stringify(unconfigured))
check('没设仓库时说清要填什么', String(unconfigured.error).includes('仓库'))

const savedRepo = await postUpdate({ action: 'set-repo', repo: 'owner/repo' })
check('可以记住仓库', savedRepo.status === 200 && savedRepo.body.repo === 'owner/repo', JSON.stringify(savedRepo.body))
check('仓库记到了文件里', JSON.parse(readFileSync(join(work, 'update-config.json'), 'utf8')).repo === 'owner/repo')
const afterSave = await getUpdate('?refresh=1')
check('记住之后就能查了', afterSave.enabled === true && afterSave.latest === '9.9.9', JSON.stringify(afterSave))

const badRepo = await postUpdate({ action: 'set-repo', repo: '这不是仓库 名字' })
check('仓库格式不对会被拒', badRepo.status === 400)
const cleared = await postUpdate({ action: 'set-repo', repo: '' })
check('可以清空更新源', cleared.status === 200 && cleared.body.configured === false)

plugin.close()
server.close()
rmSync(work, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
