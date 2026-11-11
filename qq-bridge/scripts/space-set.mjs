#!/usr/bin/env node
// 改「她此刻在哪」的唯一入口（1a 阶段没有别的东西会写 state/space.json）。
//
//   node scripts/space-set.mjs                        # 看现在是什么、她会读到什么
//   node scripts/space-set.mjs --place 客厅 --detail "茶几上放着一杯凉了的水"
//   node scripts/space-set.mjs --place 水池 --detail "泡在水里，半个身子沉下去"
//   node scripts/space-set.mjs --clear                # 删掉空间状态，提示词里不再多这一行
//
// 改完**不用重启桥接**：每次唤醒都会重新读这个文件。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSpaceState, spaceLineFor } from '../src/space-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'state', 'space.json');

/** 极简参数解析：支持 --key value、--key=value、--flag。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[body] = true;
    } else {
      out[body] = next;
      i += 1;
    }
  }
  return out;
}

function render(state) {
  if (!state) return '（没有空间状态：唤醒提示里不会多这一行）';
  const line = spaceLineFor(state);
  if (!line) return '（place 为空：唤醒提示里不会多这一行）';
  return line.trim().replace(/^/, '  ');
}

const args = parseArgs(process.argv.slice(2));

if (args.clear) {
  try { fs.unlinkSync(FILE); } catch {}
  console.log('已删除 state/space.json —— 她的唤醒提示恢复成没有「此刻」的状态。');
  process.exit(0);
}

const patch = {};
for (const field of ['place', 'detail', 'doing']) {
  if (typeof args[field] === 'string') patch[field] = args[field];
}

if (Object.keys(patch).length > 0) {
  const prev = readSpaceState(FILE) ?? {};
  const next = {
    version: 1,
    ...prev,
    ...patch,
    updatedAt: Date.now()
  };
  if (patch.place && patch.place !== prev.place) next.since = Date.now();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`已写入 ${path.relative(ROOT, FILE)}`);
}

const state = readSpaceState(FILE);
if (state) {
  console.log('');
  console.log('  place : ' + (state.place ?? '—'));
  console.log('  detail: ' + (state.detail ?? '—'));
  if (state.doing) console.log('  doing : ' + state.doing);
}
console.log('');
console.log('她会读到：');
console.log(render(state));