import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationReferences } from '../src/qq-references.js';

test('interleaved speakers, old quoted images and ambiguous pictures', () => {
  const pic = (userId, messageId) => ({ userId, messageId, time: 1, media: [{kind:'image'}] });
  const recent = [pic('A','-12'), pic('B','14'), {userId:'C',messageId:'15',plain:'吃饭'}];
  const next = {userId:'A',plain:'看右下角',time:5000};
  assert.equal(conversationReferences(recent,next,[]).imageSourceMessageId,'-12');
  assert.deepEqual(conversationReferences([...recent,pic('A','20')],next,[]),{});
  assert.deepEqual(conversationReferences(recent,next,[{type:'reply',data:{id:14}},{type:'at',data:{qq:'B'}}]),
    {quotedMessageId:'14',quotedUserId:'B',imageSourceMessageId:'14',mentionedUsers:['B']});
});
