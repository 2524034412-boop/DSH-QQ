// 只读探针：列 DSH 的 agent preset，看她那个会话为什么卡住
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'));
const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
  token: cfg.dsh.authToken,
  tokenExplicit: cfg.dsh.authTokenExplicit === true,
  header: cfg.dsh.authHeader,
  prefix: cfg.dsh.authPrefix,
  allowRemote: cfg.dsh.allowRemote === true,
});

const res = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
const list = res.presets || res || [];
console.log('preset 数量:', list.length);
for (const p of list) {
  const id = p.id || p.presetId || p.name || '?';
  const name = p.name || p.title || '';
  console.log(`- ${id}  ${name}  ${p.description || ''}`.slice(0, 160));
}

// 会话状态
const s = unwrap(await api.sessions.list({}), 'sessions.list');
const arr = s.sessions || s || [];
console.log('\n最近 5 个会话:');
for (const x of arr.slice(0, 5)) {
  console.log(`- ${x.sessionId} | preset=${x.agentPreset || x.preset || '?'} | ${x.title || ''}`.slice(0, 140));
}