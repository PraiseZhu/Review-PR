import test from 'node:test';
import assert from 'node:assert/strict';
import { toRetryDecision, toFailureRecord, MAX_FAILURES_PER_HEAD, MAX_DISPATCH_ATTEMPT } from './retry.mjs';

const T0 = Date.parse('2026-10-12T10:00:00Z');
const min = (n) => n * 60_000;
const failure = (count, at = T0) => ({ count, at: new Date(at).toISOString() });

test('没失败过就派发', () => {
  assert.deepEqual(toRetryDecision({ failure: null, attempt: 1, nowMs: T0 }), { dispatch: true });
  assert.deepEqual(toRetryDecision({ failure: { count: 0 }, attempt: 3, nowMs: T0 }), { dispatch: true });
});

test('失败后按 10、20、40… 分钟退避,最多等 4 小时', () => {
  for (const [count, wait] of [[1, 10], [2, 20], [3, 40], [4, 80], [5, 160]]) {
    const early = toRetryDecision({ failure: failure(count), attempt: 2, nowMs: T0 + min(wait) - 1 });
    assert.equal(early.dispatch, false, `第 ${count} 次失败后 ${wait} 分钟内不派`);
    assert.match(early.reason, new RegExp(`第 ${count} 次`));
    assert.equal(toRetryDecision({ failure: failure(count), attempt: 2, nowMs: T0 + min(wait) }).dispatch, true);
  }
});

test('同一 head 失败满 6 次停止自动重试', () => {
  const stop = toRetryDecision({ failure: failure(MAX_FAILURES_PER_HEAD), attempt: 7, nowMs: T0 + min(10_000) });
  assert.equal(stop.dispatch, false);
  assert.match(stop.reason, /停止自动重试,需要人工处理/);
});

test('派发次数超过 review-pr.yml 守卫上限 9 次就停,不再派必然被拒的 run', () => {
  assert.equal(toRetryDecision({ attempt: MAX_DISPATCH_ATTEMPT, nowMs: T0 }).dispatch, true);
  const over = toRetryDecision({ attempt: MAX_DISPATCH_ATTEMPT + 1, nowMs: T0 });
  assert.equal(over.dispatch, false);
  assert.match(over.reason, /上限/);
});

test('失败记录:失败累加,成功清掉,只动这个 head', () => {
  const a = toFailureRecord({}, 'h1', true, '2026-10-12T10:00:00Z');
  assert.deepEqual(a, { h1: { count: 1, at: '2026-10-12T10:00:00Z' } });
  const b = toFailureRecord({ ...a, h0: { count: 2, at: 'x' } }, 'h1', true, '2026-10-12T10:20:00Z');
  assert.deepEqual(b.h1, { count: 2, at: '2026-10-12T10:20:00Z' });
  assert.deepEqual(b.h0, { count: 2, at: 'x' });
  assert.deepEqual(toFailureRecord(b, 'h1', false, 'y'), { h0: { count: 2, at: 'x' } });
  assert.deepEqual(toFailureRecord(undefined, 'h1', false, 'y'), {});
});
