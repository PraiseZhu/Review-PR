import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSegmentAnswer, preserveFailedModelAnswer } from '../scripts/lib.server-review.mjs';

const key = { kind: 'hunk', fileId: 'f1-aaaa', hunkId: 'h1-bbbb' };
const delivery = {
  segmentId: 'seg-01',
  order: 1,
  snapshotHash: 'snap1-deadbeef',
  assignedCoverageKeys: [key],
};

test('四字段收据通过;缺 snapshotHash / 类型不对 / segmentId 错必须指出哪一格', () => {
  const full = {
    segmentId: 'seg-01',
    receivedOrder: 1,
    snapshotHash: 'snap1-deadbeef',
    coverageKeys: [key],
  };
  assert.equal(validateSegmentAnswer(full, delivery), true);

  const missingHash = { segmentId: 'seg-01', receivedOrder: 1, coverageKeys: [key] };
  assert.throws(
    () => validateSegmentAnswer(missingHash, delivery),
    (err) => /snapshotHash/.test(err.message) && /undefined/.test(err.message) && !/coverage mismatch/.test(err.message),
  );

  const stringOrder = { ...full, receivedOrder: '1' };
  assert.throws(
    () => validateSegmentAnswer(stringOrder, delivery),
    (err) => /receivedOrder \(type\)/.test(err.message) && /"1"/.test(err.message),
  );

  const wrongId = { ...full, segmentId: 'seg-99' };
  assert.throws(
    () => validateSegmentAnswer(wrongId, delivery),
    (err) => /segmentId/.test(err.message) && /seg-99/.test(err.message),
  );
});

test('finalize 失败时把答卷原样拷到 worktree failed-model-answer.json', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'failed-answer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const answers = join(root, 'server-answers');
  mkdirSync(answers);
  const src = join(answers, 'model-answer.json');
  const body = '{"schemaVersion":"rro-1","segmentReceipts":[{"segmentId":"seg-01","receivedOrder":1}]}\n';
  writeFileSync(src, body);
  const err = new Error('segment answer binding mismatch:snapshotHash expected "snap1-x" got undefined');
  assert.throws(
    () => preserveFailedModelAnswer(root, src, err),
    (e) => e !== err && e.cause === err && e.message.includes('preserved') && e.message.includes('failed-model-answer.json'),
  );
  const dest = join(root, 'failed-model-answer.json');
  assert.equal(existsSync(dest), true);
  assert.equal(readFileSync(dest, 'utf8'), body);
});
