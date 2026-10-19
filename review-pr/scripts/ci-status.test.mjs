#!/usr/bin/env node
// ci-status.test.mjs — 合并前 CI 总判定(evaluateCiStatus / classifyRollupContexts)的回归。
//
// 为什么要这个测试:「只有 CI 全过才合并」的判定必须钉死,历史上有两个真实的洞
// (2026-08-04 修):① 非 required 的红 CI 给的是 UNSTABLE 不是 BLOCKED,旧逻辑只在
// BLOCKED 时看 CI → 完全不设防;② selfMerge(--admin)在 awaiting-approval 分支提前
// 返回,CI 分类永远不执行 → admin 合并把挂着的 required CI 一起绕掉。
// 三件事必须钉住:
//   ① failed 永远压过 pending / awaiting / pass —— 任一来源见到失败就是 failed;
//   ② UNSTABLE 但已读到的来源全绿 = unknown(读取不完整),绝不判 pass;
//      两个来源都读不到 = unknown,绝不判 pass;
//   ③ ACTION_REQUIRED(fork workflow 待批)单列 awaiting,不算失败也不算通过。
// 跑:node scripts/ci-status.test.mjs   退出码 0 = 全过。

import { evaluateCiStatus, classifyRollupContexts } from './lib.mjs';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, `got ${g}, want ${w}`);
}

// ── ① classifyRollupContexts:CheckRun 与 StatusContext 混排 ──
{
  const r = classifyRollupContexts([
    { name: 'test-unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'test-e2e', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'lint', status: 'IN_PROGRESS', conclusion: null },
    { name: 'deploy-preview', status: null, conclusion: 'PENDING' },   // StatusContext state=PENDING
    { name: 'external-ci', status: null, conclusion: 'ERROR' },        // StatusContext state=ERROR
    { name: 'fork-build', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
    { name: 'optional-scan', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { name: 'flaky-retry', status: 'COMPLETED', conclusion: 'CANCELLED' },
    { name: 'neutral-check', status: 'COMPLETED', conclusion: 'NEUTRAL' },
  ]);
  eq('rollup/failed', r.failed, ['test-e2e', 'external-ci', 'flaky-retry']);
  eq('rollup/pending', r.pending, ['lint', 'deploy-preview']);
  eq('rollup/awaiting', r.awaiting, ['fork-build']);
}
{
  // gh 小写 conclusion 也认(REST 端点风格),空数组 = 无 check
  const r = classifyRollupContexts([{ name: 'a', status: 'completed', conclusion: 'failure' }]);
  eq('rollup/小写 conclusion', r.failed, ['a']);
  eq('rollup/空输入', classifyRollupContexts([]), { failed: [], pending: [], awaiting: [] });
}
{
  // 同名去重(2026-08-16,PR #2755 实录):concurrency 顶掉留下的旧 CANCELLED +
  // 更新的 SUCCESS → 只按最新一条评估,被顶掉的旧 run 不算失败(GitHub 分支保护同口径)
  const r = classifyRollupContexts([
    { name: 'check:pr-design-basis', workflowName: 'pr-design-basis', startedAt: '2026-08-14T17:08:47Z', completedAt: '2026-08-14T17:08:49Z', status: 'COMPLETED', conclusion: 'CANCELLED' },
    { name: 'verify-checks', workflowName: 'client-ci', startedAt: '2026-08-14T17:08:49Z', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'check:pr-design-basis', workflowName: 'pr-design-basis', startedAt: '2026-08-14T17:08:51Z', completedAt: '2026-08-14T17:09:01Z', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ]);
  eq('rollup/被顶掉的 CANCELLED 忽略', r.failed, []);
  eq('rollup/去重后无 pending', r.pending, []);
  eq('rollup/去重后无 awaiting', r.awaiting, []);
}
{
  // 反向:同名最新一条仍是 CANCELLED(没有后继 run 的真取消)→ 照样算失败
  const r = classifyRollupContexts([
    { name: 'build', workflowName: 'ci', startedAt: '2026-08-14T10:00:00Z', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'build', workflowName: 'ci', startedAt: '2026-08-14T11:00:00Z', status: 'COMPLETED', conclusion: 'CANCELLED' },
  ]);
  eq('rollup/同名最新仍 CANCELLED 算失败', r.failed, ['build']);
}
{
  // 去重键是 workflowName+name:不同 workflow 的同名 job 互不相干,新的 SUCCESS
  // 不能把另一个 workflow 里真被取消的同名 job 顶掉
  const r = classifyRollupContexts([
    { name: 'build', workflowName: 'ci-a', startedAt: '2026-08-14T10:00:00Z', status: 'COMPLETED', conclusion: 'CANCELLED' },
    { name: 'build', workflowName: 'ci-b', startedAt: '2026-08-14T11:00:00Z', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ]);
  eq('rollup/跨 workflow 同名不互相顶掉', r.failed, ['build']);
}
{
  // re-run 已启动还没跑完:同名旧的 SUCCESS 被更新的 IN_PROGRESS 顶掉 → pending(等跑完)
  const r = classifyRollupContexts([
    { name: 'build', workflowName: 'ci', startedAt: '2026-08-14T10:00:00Z', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'build', workflowName: 'ci', startedAt: '2026-08-14T11:00:00Z', status: 'IN_PROGRESS', conclusion: null },
  ]);
  eq('rollup/re-run 在跑算 pending', r.pending, ['build']);
  eq('rollup/re-run 在跑不判失败', r.failed, []);
}
{
  // 时间戳全缺(StatusContext / 旧数据):按数组序去重,靠后当更新
  const r = classifyRollupContexts([
    { name: 'build', status: 'COMPLETED', conclusion: 'CANCELLED' },
    { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ]);
  eq('rollup/无时间戳按数组序取靠后', r.failed, []);
}
{
  // #1109:同一 head 上 pr-format-gate 5 条 check run(北京 2026-10-19)。
  // 新 pull_request 事件 18:37 绿(run id 更大);旧 pull_request_target 重跑把 startedAt
  // 刷新成 18:41/18:42/18:58 红(run id 更小,GitHub 重跑复用旧事件 payload)。
  // 18:59 绿是同一新事件 run 的完成时间,startedAt 仍是 18:37。按 startedAt 会把旧事件重跑当最新。
  const contexts = [
    {
      name: 'pr-format-gate', workflowName: 'pr-format-gate',
      startedAt: '2026-10-19T10:37:00Z', completedAt: '2026-10-19T10:37:20Z',
      status: 'COMPLETED', conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/xindong/mivo-canvas-plugin/actions/runs/1860100370/job/1',
    },
    {
      name: 'pr-format-gate', workflowName: 'pr-format-gate',
      startedAt: '2026-10-19T10:41:58Z', completedAt: '2026-10-19T10:42:05Z',
      status: 'COMPLETED', conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/xindong/mivo-canvas-plugin/actions/runs/1860100001/job/2',
    },
    {
      name: 'pr-format-gate', workflowName: 'pr-format-gate',
      startedAt: '2026-10-19T10:42:00Z', completedAt: '2026-10-19T10:42:08Z',
      status: 'COMPLETED', conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/xindong/mivo-canvas-plugin/actions/runs/1860100002/job/3',
    },
    {
      name: 'pr-format-gate', workflowName: 'pr-format-gate',
      startedAt: '2026-10-19T10:58:29Z', completedAt: '2026-10-19T10:58:40Z',
      status: 'COMPLETED', conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/xindong/mivo-canvas-plugin/actions/runs/1860100003/job/4',
    },
    {
      name: 'pr-format-gate', workflowName: 'pr-format-gate',
      startedAt: '2026-10-19T10:37:00Z', completedAt: '2026-10-19T10:59:49Z',
      status: 'COMPLETED', conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/xindong/mivo-canvas-plugin/actions/runs/1860100370/job/5',
    },
  ];
  const r = classifyRollupContexts(contexts);
  eq('rollup/#1109 旧事件重跑红不盖过新事件绿', r.failed, []);
  eq('rollup/#1109 去重后无 pending', r.pending, []);
  eq('eval/#1109 聚合 pass', evaluateCiStatus({ rollup: r, ciRuns: { failed: [], pending: [], awaiting: [] } }).status, 'pass');
}
{
  // 最新一次事件的 run 失败仍判失败(run id 更大,即使 startedAt 更早)
  const r = classifyRollupContexts([
    {
      name: 'pr-format-gate', workflowName: 'pr-format-gate',
      startedAt: '2026-10-19T11:00:00Z', status: 'COMPLETED', conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/o/r/actions/runs/100/job/1',
    },
    {
      name: 'pr-format-gate', workflowName: 'pr-format-gate',
      startedAt: '2026-10-19T10:00:00Z', status: 'COMPLETED', conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/o/r/actions/runs/200/job/2',
    },
  ]);
  eq('rollup/最新 run 红仍失败', r.failed, ['pr-format-gate']);
}
{
  // 取不到 run id 时保持原行为:按 startedAt 取最新
  const r = classifyRollupContexts([
    { name: 'build', workflowName: 'ci', startedAt: '2026-08-14T10:00:00Z', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'build', workflowName: 'ci', startedAt: '2026-08-14T11:00:00Z', status: 'COMPLETED', conclusion: 'CANCELLED' },
  ]);
  eq('rollup/无 run id 仍按 startedAt', r.failed, ['build']);
}

// ── ② evaluateCiStatus:failed 压过一切 ──
{
  const r = evaluateCiStatus({
    rollup: { failed: ['e2e'], pending: ['lint'], awaiting: [] },
    ciRuns: { failed: [], pending: ['build'], awaiting: [{ id: 1, name: 'fork-ci' }] },
    mergeStateStatus: 'BLOCKED',
  });
  eq('eval/failed 压过 pending+awaiting', r.status, 'failed');
  eq('eval/failed 名单', r.failed, ['e2e']);
  check('eval/reason 带名单', r.reason.includes('e2e'), r.reason);
}
{
  // 两源合并去重:同名 workflow 只出现一次
  const r = evaluateCiStatus({
    rollup: { failed: ['test'], pending: [], awaiting: [] },
    ciRuns: { failed: ['test'], pending: [], awaiting: [] },
  });
  eq('eval/两源去重', r.failed, ['test']);
}
{
  // 只有 Actions 来源可读(rollup 403)时,Actions 的失败照样拦
  const r = evaluateCiStatus({
    rollup: null,
    ciRuns: { failed: ['unit'], pending: [], awaiting: [] },
    mergeStateStatus: 'CLEAN',
  });
  eq('eval/rollup 读不到但 Actions 失败', r.status, 'failed');
}
{
  // 只有 rollup 可读时,外部 CI(非 Actions)的失败照样拦 —— 旧逻辑会把它误判成 structural-check
  const r = evaluateCiStatus({
    rollup: { failed: ['jenkins/build'], pending: [], awaiting: [] },
    ciRuns: { failed: [], pending: [], awaiting: [] },
    mergeStateStatus: 'BLOCKED',
  });
  eq('eval/外部 required check 失败', r.status, 'failed');
}

// ── ③ pending / awaiting ──
{
  const r = evaluateCiStatus({
    rollup: { failed: [], pending: ['e2e'], awaiting: [] },
    ciRuns: { failed: [], pending: [], awaiting: [] },
  });
  eq('eval/pending', r.status, 'pending');
}
{
  const r = evaluateCiStatus({
    rollup: null,
    ciRuns: { failed: [], pending: [], awaiting: [{ id: 7, name: 'fork-ci' }] },
    mergeStateStatus: 'BLOCKED',
  });
  eq('eval/awaiting', r.status, 'awaiting');
  eq('eval/awaiting 名单展开成 name', r.awaiting, ['fork-ci']);
}

// ── ④ unknown:不完整状态绝不判 pass ──
{
  const r = evaluateCiStatus({ rollup: null, ciRuns: null, mergeStateStatus: 'CLEAN' });
  eq('eval/两源全读不到 = unknown', r.status, 'unknown');
}
{
  // UNSTABLE = GitHub 说有 check 非通过;已读到的来源却全绿 → 读取不完整,不是 pass
  const r = evaluateCiStatus({
    rollup: { failed: [], pending: [], awaiting: [] },
    ciRuns: { failed: [], pending: [], awaiting: [] },
    mergeStateStatus: 'UNSTABLE',
  });
  eq('eval/UNSTABLE 但来源全绿 = unknown', r.status, 'unknown');
}

// ── ⑤ pass:全绿或无任何 check ──
{
  const r = evaluateCiStatus({
    rollup: { failed: [], pending: [], awaiting: [] },
    ciRuns: { failed: [], pending: [], awaiting: [] },
    mergeStateStatus: 'CLEAN',
  });
  eq('eval/全绿 = pass', r.status, 'pass');
}
{
  // 仓库没配任何 CI:rollup 可读且为空 → 视为 pass(空集全绿),不误伤无 CI 仓库
  const r = evaluateCiStatus({
    rollup: { failed: [], pending: [], awaiting: [] },
    ciRuns: null,
    mergeStateStatus: 'CLEAN',
  });
  eq('eval/无 CI 仓库 = pass', r.status, 'pass');
}

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('ci-status.test.mjs 全部通过');
