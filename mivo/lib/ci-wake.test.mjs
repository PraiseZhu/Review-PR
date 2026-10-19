// CI 红→绿没有独立唤醒:上轮 outcome=ci-failed、指纹里的聚合 ci 已是 SUCCESS、PR 无改动时
// 入选只看指纹和 retry,ci-failed 不带 retry,status:ci-failed 一直挂着。
// 纯函数 toCiWake:用已有快照的聚合 ci,不另打 GitHub;唤醒一次,状态稳定后不重复唤醒。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as admission from './admission.mjs';

const toCiWake = (...args) => {
  assert.equal(typeof admission.toCiWake, 'function', 'admission.mjs 应导出 toCiWake');
  return admission.toCiWake(...args);
};

const row = (pr, { head = 'h1', ci = 'SUCCESS', outcome = 'ci-failed' } = {}) => ({ pr, head, outcome, ci });

test('上轮 ci-failed 且聚合 ci=SUCCESS:唤醒一次;同一状态再次不唤醒', () => {
  const watched = [row(1109)];
  const first = toCiWake({ watched, seen: {} });
  assert.deepEqual(first.wake, [1109]);
  assert.deepEqual(first.deferred, []);
  assert.deepEqual(first.next, { 1109: { head: 'h1', ci: 'SUCCESS' } });
  const again = toCiWake({ watched, seen: first.next });
  assert.deepEqual(again.wake, [], '状态稳定后不每 3 分钟重派');
  assert.deepEqual(again.deferred, []);
});

test('在审的 PR 先推迟(不唤醒、基线不动)', () => {
  const watched = [row(7)];
  const r = toCiWake({ watched, seen: {}, busyPrs: new Set([7]) });
  assert.deepEqual(r.wake, []);
  assert.deepEqual(r.deferred, [7]);
  assert.deepEqual(r.next, {});
});

test('聚合仍红不唤醒', () => {
  const watched = [row(3, { ci: 'FAILURE' }), row(4, { ci: 'ERROR' })];
  const r = toCiWake({ watched, seen: {} });
  assert.deepEqual(r.wake, []);
  assert.deepEqual(r.deferred, []);
});

test('CI 状态与上轮判定不同(PENDING 等非 SUCCESS)不唤醒,避免进行中反复派', () => {
  const r = toCiWake({ watched: [row(5, { ci: 'PENDING' })], seen: {} });
  assert.deepEqual(r.wake, []);
});

test('空输入不唤醒', () => {
  assert.deepEqual(toCiWake(), { wake: [], deferred: [], next: {} });
});
