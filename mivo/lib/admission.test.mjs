import test from 'node:test';
import assert from 'node:assert/strict';
import { toFreeSlots, toAdmissionDecision, toBusyPrs, toExcludedPrs, toHeldWake, MAX_ADMIT_MS, ADMIT_INTERVAL_MS } from './admission.mjs';

const T0 = Date.parse('2026-10-14T10:00:00Z');
const round = (inflight, { queued = 0, finished = false } = {}) => ({ inflight, queued, finished });
const decide = (over = {}) => toAdmissionDecision({
  nowMs: T0 + 5 * 60_000, startedAtMs: T0, paused: false, inWindow: true, rounds: [round(1)], maxParallel: 10, ...over,
});

test('检查间隔 3 分钟,进程最多接单 60 分钟', () => {
  assert.equal(ADMIT_INTERVAL_MS, 180_000);
  assert.equal(MAX_ADMIT_MS, 60 * 60_000);
});

test('空闲槽位 = maxParallel 减去所有轮次在审数之和,已结束和失败的轮次也算,不小于 0', () => {
  assert.equal(toFreeSlots({ rounds: [round(3), round(2)], maxParallel: 10 }), 5);
  assert.equal(toFreeSlots({ rounds: [round(3, { finished: true }), round(2)], maxParallel: 10 }), 5);
  assert.equal(toFreeSlots({ rounds: [round(8), round(4)], maxParallel: 10 }), 0);
  assert.equal(toFreeSlots({ rounds: [], maxParallel: 10 }), 10);
});

test('有空槽、没有积压、没满 60 分钟、没暂停、在窗口内:另开一轮', () => {
  assert.deepEqual(decide(), { admit: true, freeSlots: 9 });
});

test('已经停止接单时原因原样返回', () => {
  assert.deepEqual(decide({ closedReason: 'round-failed' }), { admit: false, reason: 'round-failed' });
});

test('进程运行满 60 分钟就停止接单;59 分 59 秒还能接', () => {
  assert.deepEqual(decide({ nowMs: T0 + MAX_ADMIT_MS }), { admit: false, reason: 'max-runtime', close: true });
  assert.equal(decide({ nowMs: T0 + MAX_ADMIT_MS - 1000 }).admit, true);
});

test('暂停或维护窗口内本次不接,但不停止接单', () => {
  assert.deepEqual(decide({ paused: true }), { admit: false, reason: 'paused' });
  assert.deepEqual(decide({ inWindow: false }), { admit: false, reason: 'maintenance-window' });
});

test('判断顺序:暂停期间满了 60 分钟,也要停止接单', () => {
  assert.deepEqual(decide({ paused: true, nowMs: T0 + MAX_ADMIT_MS }), { admit: false, reason: 'max-runtime', close: true });
});

test('未结束的轮次还有未领取任务时不接;已结束轮次的残留不挡', () => {
  assert.deepEqual(decide({ rounds: [round(1, { queued: 2 })] }), { admit: false, reason: 'queued-backlog' });
  assert.equal(decide({ rounds: [round(1), round(0, { queued: 2, finished: true })] }).admit, true);
});

test('全进程在审数到 maxParallel 时不接', () => {
  assert.deepEqual(decide({ rounds: [round(6), round(4)] }), { admit: false, reason: 'no-free-slot' });
});

test('忙 PR = 未完成计划的全部候选(含计划阶段跳过的)加分组里的 PR', () => {
  const plans = [
    { manifest: { candidates: [{ number: 941 }, { number: 927 }] }, groups: [{ prs: [{ pr: 941 }] }] },
    { groups: [{ prs: [{ pr: 950 }, { pr: 956 }] }] },
  ];
  assert.deepEqual([...toBusyPrs(plans)].sort((a, b) => a - b), [927, 941, 950, 956]);
  assert.equal(toBusyPrs([]).size, 0);
  assert.equal(toBusyPrs([null, {}]).size, 0);
});

test('排除集:在审 PR,加上传递依赖它们的 PR;无关 PR 不受影响', () => {
  const roundState = { version: 1, mode: 'review-only', prs: {
    927: { dependencyPrs: [926] },
    930: { dependencyPrs: [927] },
    945: { dependencyPrs: [] },
    950: {},
  } };
  const excluded = toExcludedPrs({ busyPrs: new Set([926]), roundState });
  assert.deepEqual([...excluded].sort((a, b) => a - b), [926, 927, 930]);
});

test('排除集:round-state 版本或模式不对时只用忙 PR;字符串 PR 号也能匹配', () => {
  const prs = { 927: { dependencyPrs: ['926'] } };
  assert.deepEqual([...toExcludedPrs({ busyPrs: new Set([926]), roundState: { version: 1, mode: 'auto', prs } })], [926]);
  assert.deepEqual([...toExcludedPrs({ busyPrs: new Set([926]), roundState: { version: 2, mode: 'review-only', prs } })], [926]);
  assert.deepEqual([...toExcludedPrs({ busyPrs: new Set(['926']), roundState: { version: 1, mode: 'review-only', prs } })].sort(), [926, 927]);
});

test('held 唤醒:确认 issue 有新留言且 PR 不在审就唤醒;在审就延后并保留旧记录', () => {
  const issues = [
    { number: 952, title: '维护者确认 · PR #926 feat: x', updated_at: 't2' },
    { number: 954, title: '维护者确认 · PR #935 feat: y', updated_at: 't2' },
    { number: 960, title: '服务器收尾', updated_at: 't2' },
    { number: 961, title: '维护者确认 · PR #1 z', updated_at: 't2', pull_request: {} },
    { number: 970, title: '维护者确认 · PR #970 新开', updated_at: 't1' },
  ];
  const seen = { 952: { pr: 926, updatedAt: 't1' }, 954: { pr: 935, updatedAt: 't1' } };
  const r = toHeldWake({ issues, seen, busyPrs: new Set([935]) });
  assert.deepEqual(r.wake, [926]);
  assert.deepEqual(r.deferred, [935]);
  assert.deepEqual(r.next[952], { pr: 926, updatedAt: 't2' });
  assert.deepEqual(r.next[954], { pr: 935, updatedAt: 't1' });
  assert.deepEqual(r.next[970], { pr: 970, updatedAt: 't1' }, '第一次见到只记录,不唤醒');
  assert.equal(r.next[960], undefined);
  assert.equal(r.next[961], undefined);
});
