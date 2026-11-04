// 「别人说了她的人格」识别 + 去重
import assert from 'node:assert/strict';
import { corePersonaHint, alreadyRemembered } from '../src/core-memory-hint.js';

let pass = 0;
const ok = (cond, name) => { if (cond) { pass += 1; console.log('  ✓', name); } else { console.error('  ✗', name); process.exitCode = 1; } };

ok(corePersonaHint('你其实挺温柔的，别老是自己扛') === '人格评价', '「你其实…」算人格评价');
ok(corePersonaHint('你比群里一些人还像人') === null, '普通夸奖不算（没有触发词）');
ok(corePersonaHint('你是不是人？还是只是个程序') === '身份质疑', '身份质疑能识别');
ok(corePersonaHint('你只是个工具而已，别太当回事') === '贬低身份', '贬低身份能识别');
ok(corePersonaHint('你有没有感情啊') === '情感拷问', '情感拷问能识别');
ok(corePersonaHint('你这种人就是欠骂') === '人格评价', '带刺的人格评价也算');
ok(corePersonaHint('今天吃了什么') === null, '日常闲聊不触发');
ok(corePersonaHint('') === null && corePersonaHint(null) === null, '空值不崩');
ok(corePersonaHint('你其实'.repeat(60)) === null, '太长的不判（防拼贴刷屏）');

ok(alreadyRemembered('你其实挺温柔的', [{ text: '老大说我这个人其实挺温柔' }]) === true, '近似内容已记过就跳过');
ok(alreadyRemembered('你其实挺温柔的', [{ text: '今天吃了面' }]) === false, '无关记忆不拦');
ok(alreadyRemembered('你其实挺温柔的', []) === false, '没有记忆时不拦');
ok(alreadyRemembered('', [{ text: 'x' }]) === true, '空引用视为已记录');

console.log(`\n${pass} 项通过`);
