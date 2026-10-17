import test from 'node:test';
import assert from 'node:assert/strict';
import { toRetryDecision, toFailureRecord, MAX_FAILURES_PER_HEAD, MAX_DISPATCH_ATTEMPT } from './retry.mjs';
// 2026-10-17 补审新增:派发次数按连续失败数算、已完成审查次数单独封顶。
const { toDispatchAttempt, toCompletedRunsRecord, MAX_COMPLETED_RUNS_PER_HEAD } = await import('./retry.mjs');

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

// 2026-10-17 补审:attempts 原先累计同 head 的所有派发(含成功的复用),满 9 次就停。摘标签后门禁恢复要靠再派发一次把标签加回,
// 同 head 已派 9 次时就加不回来。attempt 是「这一轮连续重试第几次」(服务器据此升级模型、判定最终失败,workflow 守卫只收 1–9),
// 改按连续失败数算;防失控的保险改成单独的「已完成审查次数」上限。
test('派发的 attempt = 连续失败数 + 1:成功过的 head 再派发从 1 开始,不再累计', () => {
  assert.equal(toDispatchAttempt(null), 1);
  assert.equal(toDispatchAttempt(undefined), 1);
  assert.equal(toDispatchAttempt({ count: 0 }), 1);
  assert.equal(toDispatchAttempt({ count: 1 }), 2);
  assert.equal(toDispatchAttempt({ count: MAX_FAILURES_PER_HEAD - 1 }), MAX_FAILURES_PER_HEAD);
  assert.ok(toDispatchAttempt({ count: MAX_FAILURES_PER_HEAD }) <= MAX_DISPATCH_ATTEMPT, '失败上限内,attempt 不会超过 workflow 守卫的 9');
  assert.equal(toDispatchAttempt({ count: 'x' }), 1);
});

test('同 head 已完成审查满上限就停,防止指纹反复变化造成的失控派发;未满照常', () => {
  assert.ok(MAX_COMPLETED_RUNS_PER_HEAD > MAX_DISPATCH_ATTEMPT, '上限要比原先的 9 次宽,留给摘标签后再加回的派发');
  assert.equal(toRetryDecision({ attempt: 1, completedRuns: MAX_COMPLETED_RUNS_PER_HEAD - 1, nowMs: T0 }).dispatch, true);
  const stop = toRetryDecision({ attempt: 1, completedRuns: MAX_COMPLETED_RUNS_PER_HEAD, nowMs: T0 });
  assert.equal(stop.dispatch, false);
  assert.match(stop.reason, new RegExp(`已完成 ${MAX_COMPLETED_RUNS_PER_HEAD} 次`));
  assert.match(stop.reason, /停止自动重试,需要人工处理/);
  assert.equal(toRetryDecision({ attempt: 1, nowMs: T0 }).dispatch, true, '没传 completedRuns 与旧调用方一致');
});

test('已完成审查次数记录:只动这个 head,不改入参', () => {
  const before = { h0: 3 };
  const a = toCompletedRunsRecord(before, 'h1');
  assert.deepEqual(a, { h0: 3, h1: 1 });
  assert.deepEqual(toCompletedRunsRecord(a, 'h1'), { h0: 3, h1: 2 });
  assert.deepEqual(before, { h0: 3 });
  assert.deepEqual(toCompletedRunsRecord(undefined, 'h1'), { h1: 1 });
});
