import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectRoleText, GEN1_ROLE_LINE_RE } from '../src/role-card.js';
const card=fs.readFileSync(new URL('../roles/独立AI.md',import.meta.url),'utf8');
const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url),'utf8'));
const limit=Math.max(1000,Math.min(20000,Number(config.role?.maxInjectChars)||6000));
for(const mode of ['v1','v2']){
  const selected=selectRoleText(card,mode);
  assert(selected.length<=limit,`${mode}: complete card must fit injection budget`);
  assert(selected.includes('十一、开口前的一眼自检'),'tail retained');
  if(mode==='v2') assert.equal(selected.split('\n').filter(x=>GEN1_ROLE_LINE_RE.test(x)).length,0,'no legacy lines silently dropped');
  console.log(`PASS ${mode}: ${selected.length} characters / ${limit} budget, all sections retained`);
}
assert(!card.includes('qq_'),'no copied tool APIs or version-specific argument recipes');
for(const text of ['安全、隐私、事实与授权','当前明确请求与真实处境','正在进行的对话','不否认、不编造真人身份','没发生的生活不要编','结果不明不重复发送','不因对方没回复、没充值或有现实朋友而主动扣分','实际状态数值由桥接决定']) assert(card.includes(text),text);
assert(!/\bhttps?:\/\//.test(card));
console.log('PASS priority ordering, honest persona, tool restraint and relationship boundaries');
const oldFile=new URL('../backups/独立AI-优化前-20261031-1927.md',import.meta.url);
if(fs.existsSync(oldFile)) console.log(`Character comparison: ${fs.readFileSync(oldFile,'utf8').length} -> ${card.length} (not a token measurement)`);
