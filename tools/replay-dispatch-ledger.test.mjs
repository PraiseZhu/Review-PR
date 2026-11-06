import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, selectRepeats, toRepeatClass } from './replay-dispatch-ledger.mjs';

const head = 'a'.repeat(40);
const other = 'b'.repeat(40);
const liveOf = (blockClass, extra = {}) => ({ ok: true, meta: { headRefOid: head, reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE' },
  gate: { blockClass, selfBlockedResolvable: blockClass === 'self-resolvable', unresolvedThreads: [], ...extra }, auto: { action: 'review' } });
const entry = (id, pr, h = head) => ({ at: `2026-11-06T0${id}:00:00Z`, pr, head: h, dispatchId: `d${id}`, action: 'review' });

test('selectRepeats:同 PR 同 head 的第 2 次起算重复(与上一次同 head 的派发配对);别的 PR、别的 head 的第 1 次不算', () => {
  const repeats = selectRepeats([entry(1, 7), entry(2, 7), entry(3, 7, other), entry(4, 8), entry(5, 7)]);
  assert.deepEqual(repeats.map((r) => [r.entry.dispatchId, r.previousEntry.dispatchId]), [['d2', 'd1'], ['d5', 'd2']]);
});

test('replay:上次核对员推翻 + 自解死锁 → 修复后拦下;失败重试、门禁推迟后的重审、别的卡点不受影响', () => {
  const ledger = [entry(1, 1), entry(2, 1), entry(3, 2), entry(4, 2), entry(5, 3), entry(6, 3)];
  const results = { r1: { outcome: 'merge-blocked', approvalCode: 'verifier-overruled' }, r3: { outcome: 'error', approvalCode: null }, r5: { outcome: 'merge-blocked', approvalCode: 'gates-pending' } };
  const lives = { d2: liveOf('self-resolvable'), d4: liveOf('self-resolvable'), d6: liveOf('self-resolvable') };
  const out = replay({ ledger, runIdOf: (d) => ({ d1: 'r1', d3: 'r3', d5: 'r5' })[d], resultOf: (r) => results[r] ?? null, liveOf: (e) => lives[e.dispatchId] ?? null });
  assert.equal(out.repeats, 3);
  const blocked = out.rows.filter((r) => r.dispatchedBefore && !r.dispatchedAfter);
  assert.deepEqual(blocked.map((r) => r.pr), [1], '只有上次核对员推翻的那条被拦');
  assert.equal(blocked[0].afterOutcome, 'merge-blocked');
  assert.equal(out.blockedByFix, 1);
  assert.equal(out.byClass['self-resolvable ← 上次 merge-blocked/verifier-overruled'].blockedByFix, 1);
  assert.equal(out.byClass['self-resolvable ← 上次 error'].blockedByFix, 0);
  assert.ok(Object.keys(out.byClass).includes('self-resolvable ← 上次 merge-blocked/verifier-overruled'));
});

test('toRepeatClass:读不到上次结果或当时的 context 也有类别名', () => {
  assert.equal(toRepeatClass({ previous: null, live: null }), 'unknown ← 上次 no-result');
});
