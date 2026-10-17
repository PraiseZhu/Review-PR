import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordSelfWrite, readSelfWrites, selfWriteChainMatches } from './self-write-receipts.mjs';

const binding = { repo: 'o/r', pr: 1, head: 'a'.repeat(40), scope: 'lock-one', beforeUpdatedAt: '2026-10-18T00:00:00Z' };
const startedAt = Date.parse('2026-10-18T00:00:01.100Z');
const args = ['api', '--method', 'POST', 'repos/o/r/issues/1/comments'];

test('自写链必须从冻结基线连续到当前秒,支持多次评论和加摘标签但拒绝缺口或旧回执', () => {
  const baseline = '2026-10-18T10:00:00Z';
  const commentAt = '2026-10-18T10:00:10Z';
  const labelAt = '2026-10-18T10:00:20Z';
  const receipts = [{ ...binding, beforeUpdatedAt: commentAt, updatedAt: labelAt },
    { ...binding, beforeUpdatedAt: baseline, updatedAt: commentAt }];
  assert.equal(selfWriteChainMatches(receipts, baseline, labelAt, binding.head), true);
  assert.equal(selfWriteChainMatches(receipts.slice(0, 1), baseline, labelAt, binding.head), false);
  assert.equal(selfWriteChainMatches(receipts, baseline, labelAt, 'b'.repeat(40)), false);
  assert.equal(selfWriteChainMatches([{ ...binding, updatedAt: labelAt, beforeUpdatedAt: undefined }], baseline, labelAt, binding.head), false);
  assert.equal(selfWriteChainMatches([{ ...binding, beforeUpdatedAt: '2026-10-18T10:00:05Z', updatedAt: commentAt }], baseline, commentAt, binding.head), false);
});

test('自写回执绑定 repo、PR、head、锁;成功评论与标签能记录', () => {
  mkdirSync('_tmp', { recursive: true });
  const directory = mkdtempSync('_tmp/self-write-');
  try {
    const record = (patch = {}) => recordSelfWrite({ directory, ...binding, args,
      result: { ok: true, stdout: '{"updated_at":"2026-10-18T00:00:01Z"}' },
      startedAt, beforeObservedAt: startedAt, finishedAt: startedAt + 1800, ...patch });
    record();
    record({ args: ['api', '--method', 'DELETE', 'repos/o/r/issues/1/labels/review%3Amerge-ready'],
      result: { ok: true, stdout: '' }, finishedAt: startedAt + 200 });
    assert.equal(readSelfWrites({ directory, ...binding }).length, 2);
    for (const patch of [{ pr: 2 }, { repo: 'other/r' }, { head: 'b'.repeat(40) }, { scope: 'other-lock' }]) {
      assert.deepEqual(readSelfWrites({ directory, ...binding, ...patch }), []);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('失败、读取、其它 PR 写入、跨秒且无事件时间的操作不产生回执', () => {
  mkdirSync('_tmp', { recursive: true });
  const directory = mkdtempSync('_tmp/self-write-');
  try {
    const record = (patch) => recordSelfWrite({ directory, ...binding, args,
      result: { ok: true, stdout: '' }, startedAt, beforeObservedAt: startedAt, finishedAt: startedAt + 200, ...patch });
    record({ result: { ok: false, stdout: '' } });
    record({ beforeUpdatedAt: undefined });
    record({ beforeObservedAt: startedAt - 1000 });
    record({ args: ['api', 'repos/o/r/pulls/1'] });
    record({ args: ['api', '--method', 'POST', 'repos/o/r/issues/2/comments'] });
    record({ finishedAt: startedAt + 1800 });
    record({ result: { ok: true, stdout: '{"updated_at":"2026-10-17T00:00:01Z"}' } });
    assert.deepEqual(readSelfWrites({ directory, ...binding }), []);
    writeFileSync(join(directory, 'unrelated.jsonl'), 'broken');
    assert.deepEqual(readSelfWrites({ directory, ...binding }), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
