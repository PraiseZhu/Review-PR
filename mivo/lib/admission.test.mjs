import test from 'node:test';
import assert from 'node:assert/strict';
import { toFreeSlots, toAdmissionDecision, toBusyPrs, canReleaseDeferredGate, withDeferredGateRetries, toExcludedPrs, toHeldWake, toProtectedHoldWake, toRunTiming, toDispatchFailure, findDispatchRun, toGateSkip, isGateSkipCandidate, GATE_SKIP_MAX_MS,
  MAX_ADMIT_MS, ADMIT_INTERVAL_MS, MAX_EXEC_MINUTES, MAX_QUEUE_MINUTES } from './admission.mjs';

const T0 = Date.parse('2026-10-14T10:00:00Z');
const round = (inflight, { queued = 0, finished = false } = {}) => ({ inflight, queued, finished });
const decide = (over = {}) => toAdmissionDecision({
  nowMs: T0 + 5 * 60_000, startedAtMs: T0, paused: false, inWindow: true, rounds: [round(1)], maxParallel: 10, ...over,
});

test('检查间隔 3 分钟;接单只剩 24 小时的保险上限', () => {
  assert.equal(ADMIT_INTERVAL_MS, 180_000);
  assert.equal(MAX_ADMIT_MS, 24 * 60 * 60_000);
});

test('空闲槽位 = maxParallel 减去所有轮次在审数之和,已结束和失败的轮次也算,不小于 0', () => {
  assert.equal(toFreeSlots({ rounds: [round(3), round(2)], maxParallel: 10 }), 5);
  assert.equal(toFreeSlots({ rounds: [round(3, { finished: true }), round(2)], maxParallel: 10 }), 5);
  assert.equal(toFreeSlots({ rounds: [round(8), round(4)], maxParallel: 10 }), 0);
  assert.equal(toFreeSlots({ rounds: [], maxParallel: 10 }), 10);
});

test('有空槽、没有积压、没暂停、在窗口内:另开一轮', () => {
  assert.deepEqual(decide(), { admit: true, freeSlots: 9 });
});

test('已经停止接单时原因原样返回', () => {
  assert.deepEqual(decide({ closedReason: 'round-failed' }), { admit: false, reason: 'round-failed' });
});

test('轮次重叠满 61 分钟仍接单,不再按运行时长关门;满 24 小时才停止接单', () => {
  assert.equal(decide({ nowMs: T0 + 61 * 60_000 }).admit, true);
  assert.equal(decide({ nowMs: T0 + MAX_ADMIT_MS - 1000 }).admit, true);
  assert.deepEqual(decide({ nowMs: T0 + MAX_ADMIT_MS }), { admit: false, reason: 'max-runtime', close: true });
});

test('进入维护窗口就停止接单,而且优先于暂停;暂停只是本次不接', () => {
  assert.deepEqual(decide({ inWindow: false }), { admit: false, reason: 'maintenance-window', close: true });
  assert.deepEqual(decide({ inWindow: false, paused: true }), { admit: false, reason: 'maintenance-window', close: true });
  assert.deepEqual(decide({ paused: true }), { admit: false, reason: 'paused' });
});

test('部署暂停:不开新轮并停止接单,先于维护窗口和暂停', () => {
  assert.deepEqual(decide({ deployHold: true }), { admit: false, reason: 'deploy-hold', close: true });
  assert.deepEqual(decide({ deployHold: true, inWindow: false, paused: true }), { admit: false, reason: 'deploy-hold', close: true });
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

test('暂缓判门只释放已收尾、绑定正确且无服务器派发的等待结果', () => {
  const task = { pr: 1025, head: 'head', base: 'base', phase: 'complete', agentId: 'mini-gate:1025:done' };
  const result = { pr: 1025, head: 'head', base: 'base', runId: 'round', mode: 'review-only',
    outcome: 'bot-pending', enteredReview: false, reviewed: false, errors: [] };
  const input = { task, result, roundId: 'round' };
  assert.equal(canReleaseDeferredGate(input), true);
  assert.equal(canReleaseDeferredGate({ ...input, result: { ...result, outcome: 'ci-pending' } }), true);
  for (const patch of [{ phase: 'cleanup-pending' }, { phase: 'running' }, { agentId: 'gha:1:dispatch' }]) {
    assert.equal(canReleaseDeferredGate({ ...input, task: { ...task, ...patch } }), false);
  }
  for (const patch of [{ outcome: 'approval' }, { outcome: 'error' }, { enteredReview: true }, { reviewed: true },
    { head: 'other' }, { base: 'other' }, { runId: 'other' }, { mode: 'auto' }, { errors: ['failure'] }, { retry: true }]) {
    assert.equal(canReleaseDeferredGate({ ...input, result: { ...result, ...patch } }), false);
  }
  for (const state of ['dispatching', 'sent', 'bound', 'not-submitted', 'unknown']) {
    assert.equal(canReleaseDeferredGate({ ...input, dispatchIntent: { state } }), false);
  }
  assert.equal(canReleaseDeferredGate({ ...input, result: null }), false);
});

test('等作者的判门结果没有执行动作时也提前释放,有动作就留在原轮次', () => {
  const task = { pr: 1148, head: 'head', base: 'base', phase: 'complete', agentId: 'mini-gate:1148:done' };
  const result = { pr: 1148, head: 'head', base: 'base', runId: 'round', mode: 'review-only',
    enteredReview: false, reviewed: false, errors: [], gate: { stage: 'threads', actions: [] } };
  for (const outcome of ['conflict', 'changes-requested', 'ci-unknown', 'retarget', 'merge-blocked', 'threads-unresolved']) {
    assert.equal(canReleaseDeferredGate({ task, result: { ...result, outcome }, roundId: 'round' }), true, outcome);
    assert.equal(canReleaseDeferredGate({ task, result: { ...result, outcome, gate: { actions: [{ script: 'signoff-hold' }] } }, roundId: 'round' }), false, outcome);
    assert.equal(canReleaseDeferredGate({ task, result: { ...result, outcome, gate: undefined }, roundId: 'round' }), false, outcome);
    assert.equal(canReleaseDeferredGate({ task, result: { ...result, outcome, retry: true }, roundId: 'round' }), false, outcome);
  }
  for (const outcome of ['ci-failed', 'protected', 'security', 'format', 'rebase', 'maintainer-signoff', 'error']) {
    assert.equal(canReleaseDeferredGate({ task, result: { ...result, outcome }, roundId: 'round' }), false, outcome);
  }
});

test('已释放暂缓结果只在候选查询中请求重判,不修改共享状态或覆盖更新轮次', () => {
  const state = { version: 1, mode: 'review-only', prs: { 1025: { retry: false },
    1071: { retry: false, roundCreatedAt: '2026-10-18T02:00:00Z' } } };
  const marker = { reason: 'gate-deferred', roundId: 'round' };
  const plan = { runId: 'round', manifest: { createdAt: '2026-10-18T01:00:00Z' },
    released: { 1025: marker, 1071: marker, 1080: { reason: 'head-superseded' } } };
  const next = withDeferredGateRetries(state, [plan]);
  assert.equal(next.prs[1025].retry, true);
  assert.equal(next.prs[1071].retry, false);
  assert.equal(next.prs[1080], undefined);
  assert.equal(state.prs[1025].retry, false);
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
    { number: 970, title: '维护者确认 · PR #970 新开', updated_at: 't1', comments: 0 },
  ];
  const seen = { 952: { pr: 926, updatedAt: 't1' }, 954: { pr: 935, updatedAt: 't1' } };
  const r = toHeldWake({ issues, seen, busyPrs: new Set([935]) });
  assert.deepEqual(r.wake, [926]);
  assert.deepEqual(r.deferred, [935]);
  assert.deepEqual(r.next[952], { pr: 926, updatedAt: 't2' });
  assert.deepEqual(r.next[954], { pr: 935, updatedAt: 't1' });
  assert.deepEqual(r.next[970], { pr: 970, updatedAt: 't1' }, '第一次见到且没有评论只记录,不唤醒');
  assert.equal(r.next[960], undefined);
  assert.equal(r.next[961], undefined);
});

test('held 唤醒:第一次见到的 issue 已有评论也唤醒(创建到被记录之间收到的「同意放行」不能漏);在审的延后且不记录', () => {
  const issues = [
    { number: 980, title: '维护者确认 · PR #971 改 workflow', updated_at: 't1', comments: 2 },
    { number: 981, title: '维护者确认 · PR #972 b', updated_at: 't1', comments: 1 },
    { number: 982, title: '维护者确认 · PR #973 c', updated_at: 't1', comments: 0 },
  ];
  const r = toHeldWake({ issues, seen: {}, busyPrs: new Set([972]) });
  assert.deepEqual(r.wake, [971]);
  assert.deepEqual(r.deferred, [972]);
  assert.deepEqual(r.next[980], { pr: 971, updatedAt: 't1' });
  assert.equal(r.next[981], undefined, '在审的首次见到不记录,下个周期仍按首次处理');
  assert.deepEqual(r.next[982], { pr: 973, updatedAt: 't1' });
  // 已记录过、没有变化:不再重复唤醒
  assert.deepEqual(toHeldWake({ issues: [issues[0]], seen: r.next }).wake, []);
});

test('提前释放的 PR(作者推了新提交、旧 run 已确认结束)不再算忙,同轮其它 PR 照旧算', () => {
  const plans = [{ manifest: { candidates: [{ number: 941 }, { number: 950 }] }, groups: [{ prs: [{ pr: 941 }, { pr: 950 }] }],
    released: { 950: { at: '2026-10-14T10:00:00Z' } } }];
  assert.deepEqual([...toBusyPrs(plans)], [941]);
});

const MIN = 60_000;
// REST workflow run 的 run 级字段:排队中 updated_at 也会变(创建时),只有 in_progress 才把它当开始执行的时刻。
const runAt = (createdMin, { startedMin = null } = {}) => ({ status: startedMin === null ? 'queued' : 'in_progress',
  created_at: new Date(T0 + createdMin * MIN).toISOString(), run_started_at: new Date(T0 + createdMin * MIN).toISOString(),
  updated_at: new Date(T0 + (startedMin ?? createdMin) * MIN).toISOString() });

test('取消线:排队和执行分开计时;排队 40 分钟加执行 160 分钟不取消', () => {
  assert.equal(MAX_EXEC_MINUTES, 170);
  assert.equal(MAX_QUEUE_MINUTES, 120);
  const long = toRunTiming({ nowMs: T0 + 200 * MIN, run: runAt(0, { startedMin: 40 }) });
  assert.equal(long.phase, 'running');
  assert.equal(long.cancel, null);
  assert.equal(Math.round(long.execMin), 160);
  assert.equal(toRunTiming({ nowMs: T0 + 171 * MIN, run: runAt(0, { startedMin: 0 }) }).cancel, 'exec', '执行超过 170 分钟才取消');
  assert.equal(toRunTiming({ nowMs: T0 + 169 * MIN, run: runAt(0, { startedMin: 0 }) }).cancel, null);
});

test('排队超过 30 分钟记慢,超过 120 分钟才取消;排队中的 run 不用 updated_at / run_started_at', () => {
  const slow = toRunTiming({ nowMs: T0 + 31 * MIN, run: runAt(0) });
  assert.deepEqual([slow.phase, slow.slow, slow.cancel], ['queued', true, null]);
  assert.equal(toRunTiming({ nowMs: T0 + 29 * MIN, run: runAt(0) }).slow, false);
  assert.equal(toRunTiming({ nowMs: T0 + 121 * MIN, run: runAt(0) }).cancel, 'queue');
  const queuedUpdated = { status: 'queued', created_at: new Date(T0).toISOString(), updated_at: new Date(T0 + 100 * MIN).toISOString() };
  assert.equal(toRunTiming({ nowMs: T0 + 171 * MIN, run: queuedUpdated }).cancel, 'queue', '排队中的 run 按排队算');
  assert.equal(toRunTiming({ nowMs: T0 + 5 * MIN, run: { status: 'in_progress', created_at: new Date(T0).toISOString() } }).phase, 'queued', '执行中但读不到 updated_at 时按排队算');
  assert.equal(toRunTiming({ nowMs: T0, run: { status: 'queued' } }).cancel, null, '读不到时间不取消');
});

test('派发失败:只有带错误内容的 HTTP 4xx 算明确被拒;超时、断线、5xx 都按不知道有没有派出', () => {
  assert.equal(toDispatchFailure({ stderr: 'could not create workflow dispatch event: HTTP 422: Unexpected inputs provided: ["x"]' }), 'rejected');
  assert.equal(toDispatchFailure({ stderr: 'HTTP 403: Must have admin rights to Repository.' }), 'rejected');
  assert.equal(toDispatchFailure({ stderr: 'HTTP 502: Bad Gateway' }), 'unknown');
  assert.equal(toDispatchFailure({ stderr: 'HTTP 404' }), 'unknown', '只有状态码没有内容');
  assert.equal(toDispatchFailure({ stderr: '', error: 'spawnSync gh ETIMEDOUT' }), 'unknown');
  assert.equal(toDispatchFailure({ stderr: 'HTTP 422: x', error: 'spawnSync gh ETIMEDOUT' }), 'unknown', '超时时不信半截输出');
  assert.equal(toDispatchFailure({ stderr: 'error connecting to api.github.com' }), 'unknown');
});

test('按 dispatch_id 找 run:分页结果里按 run 名找;列表不完整时如实标出', () => {
  const pages = [
    { total_count: 3, workflow_runs: [{ id: 11, display_title: 'review-pr #950 aaaa1111' }, { id: 12, display_title: 'review-pr #951 bbbb2222' }] },
    { total_count: 3, workflow_runs: [{ id: 13, display_title: 'review-pr #950 cccc3333' }] },
  ];
  assert.deepEqual(findDispatchRun(pages, { pr: 950, dispatchId: 'cccc3333' }), { runId: '13', complete: true });
  assert.deepEqual(findDispatchRun(pages, { pr: 950, dispatchId: 'dddd4444' }), { runId: null, complete: true });
  assert.deepEqual(findDispatchRun([pages[0]], { pr: 950, dispatchId: 'dddd4444' }), { runId: null, complete: false }, '只拿到第一页');
  assert.deepEqual(findDispatchRun(null, { pr: 950, dispatchId: 'x' }), { runId: null, complete: false });
  assert.deepEqual(findDispatchRun(pages, { pr: 95, dispatchId: 'aaaa1111' }), { runId: null, complete: true }, 'PR 号要完全对上');
});

test('旧受保护记录只标 retry 一次,不清空缓存、不碰其它 PR', () => {
  const roundState = {
    version: 1, mode: 'review-only',
    prs: {
      951: { outcome: 'protected', retry: false, fingerprint: 'aa' },
      941: { outcome: 'approval', retry: false, fingerprint: 'bb' },
      978: { outcome: 'protected', retry: true, fingerprint: 'cc' },
    },
  };
  const first = toProtectedHoldWake({ roundState, alreadyDone: false });
  assert.equal(first.done, true);
  assert.deepEqual(first.wake, [951]);
  assert.equal(first.next.prs[951].retry, true);
  assert.equal(first.next.prs[951].fingerprint, 'aa');
  assert.equal(first.next.prs[941].retry, false);
  assert.equal(first.next.prs[941].fingerprint, 'bb');
  assert.equal(first.next.prs[978].retry, true);
  const again = toProtectedHoldWake({ roundState: first.next, alreadyDone: true });
  assert.deepEqual(again.wake, []);
  assert.equal(again.next, first.next);
});

// ---- [MIVO-PATCH gate-bases] 通用一次性唤醒 ----
import { toOutcomeWake, toGateBaseWake } from './admission.mjs';

test('toGateBaseWake 只把 dependency/retarget 的行标 retry,其它 outcome(含 protected)不动', () => {
  const roundState = { version: 1, mode: 'review-only', prs: {
    11: { outcome: 'dependency', head: 'h' }, 12: { outcome: 'retarget', head: 'h' }, 13: { outcome: 'protected', head: 'h' },
    14: { outcome: 'findings', head: 'h' }, 15: { outcome: 'unchanged', head: 'h' }, 16: { outcome: 'dependency', retry: true, head: 'h' } } };
  const before = JSON.stringify(roundState);
  const result = toGateBaseWake({ roundState });
  assert.deepEqual(result.wake, [11, 12]);
  assert.equal(result.done, true);
  assert.equal(result.next.prs[11].retry, true);
  assert.equal(result.next.prs[12].retry, true);
  for (const pr of [13, 14, 15, 16]) assert.deepEqual(result.next.prs[pr], roundState.prs[pr], String(pr));
  assert.equal(JSON.stringify(roundState), before, '不改入参');
  assert.equal(result.next.mode, 'review-only');
});

test('toOutcomeWake:alreadyDone 不唤醒、非法编号跳过、空输入安全、wake 升序', () => {
  const roundState = { prs: { 30: { outcome: 'dependency' }, 5: { outcome: 'dependency' }, abc: { outcome: 'dependency' }, '-3': { outcome: 'dependency' }, 0: { outcome: 'dependency' } } };
  const done = toOutcomeWake({ roundState, alreadyDone: true, outcomes: ['dependency'] });
  assert.deepEqual(done, { done: true, wake: [], next: roundState });
  assert.deepEqual(toOutcomeWake({ roundState, outcomes: ['dependency'] }).wake, [5, 30]);
  assert.deepEqual(toOutcomeWake({ roundState, outcomes: [] }).wake, []);
  assert.deepEqual(toOutcomeWake({ roundState: null, outcomes: ['dependency'] }).wake, []);
  assert.deepEqual(toOutcomeWake({}).wake, []);
  assert.deepEqual(toOutcomeWake().wake, []);
});

test('toProtectedHoldWake 与 toOutcomeWake(protected) 结果一致', () => {
  const roundState = { prs: { 1: { outcome: 'protected' }, 2: { outcome: 'dependency' } } };
  assert.deepEqual(toProtectedHoldWake({ roundState }), toOutcomeWake({ roundState, outcomes: ['protected'] }));
});

test('toGateSkip(#141):只有 updatedAt 变了、上轮是等讨论/等 CI 且没有 retry、30 分钟内真判过门,才沿用上轮结论', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const candidate = (reasonCodes, changedFields = []) => ({ number: 7, head: 'h7', selectionDiagnostics: { reasonCodes, changedFields } });
  const previous = { head: 'h7', outcome: 'threads-unresolved', reason: '1 条 conversation 未 resolve', retry: false };
  const lastGate = { head: 'h7', atMs: now - 10 * 60_000 };
  assert.deepEqual(toGateSkip({ candidate: candidate(['fingerprint-changed'], ['updatedAt']), previous, lastGate, nowMs: now }),
    { outcome: 'threads-unresolved', reason: '1 条 conversation 未 resolve', retry: false });
  assert.deepEqual(toGateSkip({ candidate: candidate(['fingerprint-changed'], ['updatedAt']), previous: { ...previous, outcome: 'ci-pending' }, lastGate, nowMs: now }),
    { outcome: 'ci-pending', reason: '1 条 conversation 未 resolve', retry: false });
  // 要判门的情况
  for (const [label, args] of [
    ['ci 也变了', { candidate: candidate(['fingerprint-changed'], ['ci', 'updatedAt']) }],
    ['没有基线', { candidate: candidate(['no-baseline']) }],
    ['重试窗口到了', { candidate: candidate(['retry', 'retry-window-expired']) }],
    ['只因 retry 被选中(上轮动作失败要重试,单审 P2)', { candidate: candidate(['retry']), previous: { ...previous, retry: true } }],
    ['只有 updatedAt 变了但上轮标了 retry', { previous: { ...previous, retry: true } }],
    ['指纹变了且也带 retry', { candidate: candidate(['fingerprint-changed', 'retry'], ['updatedAt']) }],
    ['指纹变了但说不出哪项', { candidate: candidate(['fingerprint-changed', 'fingerprint-mismatch-unattributed']) }],
    ['上轮是 bot-pending(和时间有关)', { previous: { ...previous, outcome: 'bot-pending' } }],
    ['上轮是 protected', { previous: { ...previous, outcome: 'protected' } }],
    ['round-state 的 head 不同', { previous: { ...previous, head: 'old' } }],
    ['从没真判过门', { lastGate: undefined }],
    ['上次真判门是别的 head', { lastGate: { ...lastGate, head: 'old' } }],
    ['距上次真判门满 30 分钟', { lastGate: { ...lastGate, atMs: now - GATE_SKIP_MAX_MS } }],
    ['时钟倒退', { lastGate: { ...lastGate, atMs: now + 60_000 } }],
  ]) {
    assert.equal(toGateSkip({ candidate: candidate(['fingerprint-changed'], ['updatedAt']), previous, lastGate, nowMs: now, ...args }), null, label);
  }
  assert.equal(isGateSkipCandidate(undefined), false, '候选名单里找不到这一项');
});
