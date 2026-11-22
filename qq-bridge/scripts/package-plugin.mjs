#!/usr/bin/env node
/**
 * 把设置页插件打成更新包：dsh-qq-bridge-<版本>.zip
 *
 * 要求（插件里的更新逻辑认这个格式）：
 *   - zip 根目录**就是插件根**（package.json、lib/、docs/、locale/、cordis.patch.yml…）
 *   - 里面不要多一层文件夹
 *   - 只放插件运行需要的东西，不要把 node_modules / .git / 测试产物打进去
 *
 * 用法：node scripts/package-plugin.mjs [--out 目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const srcArg = process.argv.indexOf('--src');
const SRC = srcArg > 0 ? path.resolve(process.argv[srcArg + 1]) : path.join(ROOT, 'plugin', 'dsh-qq-bridge');
const outArg = process.argv.indexOf('--out');
const OUT_DIR = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'dist');

if (!fs.existsSync(path.join(SRC, 'package.json'))) {
  console.error('✗ 找不到 plugin/dsh-qq-bridge/package.json');
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!version) { console.error('✗ package.json 没有 version'); process.exit(1); }

const ENTRIES = ['package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'lib', 'docs', 'locale'];
const existing = ENTRIES.filter((e) => fs.existsSync(path.join(SRC, e)));
console.log('插件:', pkg.name, '@', version);
console.log('打包条目:', existing.join(', '));

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `dsh-qq-bridge-${version}.zip`);
if (fs.existsSync(out)) fs.unlinkSync(out);

// Windows 自带的 bsdtar 就能生成 zip：-a 按扩展名选格式
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
execFileSync(tar, ['-a', '-c', '-f', out, '-C', SRC, ...existing], { stdio: 'inherit' });

const size = fs.statSync(out).size;
console.log(`✅ 生成 ${path.relative(ROOT, out)}（${(size / 1024).toFixed(1)} KB）`);

// 校验：列出前几项，确认根目录没有多一层
try {
  const list = execFileSync(tar, ['-tf', out], { encoding: 'utf8' }).split('\n').filter(Boolean);
  console.log('  包内前 6 项:', list.slice(0, 6).join(' | '));
  const flat = list.every((p) => p.split('/')[0] === 'dsh-qq-bridge' ? false : true);
  console.log('  根目录结构正常:', flat ? '✅' : '❌ 多了一层文件夹');
  console.log('  条目数:', list.length);
} catch (e) {
  console.log('  （列表校验失败，可忽略）', e.message);
}