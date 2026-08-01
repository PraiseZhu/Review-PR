// classifyBlockedStatus 单测 —— P1-4(2026-08-02)第②层可达性修复的核心回归防线。
//
// 根因:此前 reviewDecision='REVIEW_REQUIRED'/null 时直接短路判 blockClass=
// 'awaiting-approval',从不往下探测是否存在真实的结构性 blocker。在不要求 approve 的
// 仓库(如 mivo-canvas)里 reviewDecision 恒为 REVIEW_REQUIRED/null,短路判定的结果是这类
// 仓库的 blockClass 永远到不了 'structural-check','review-pending-admin-bypass'
// (admin-trust)路由因此永久不可达,即便作者在 admins 名单也没有任何合并出口
// (EVOLUTION.md own-pr-has-no-merge-path-when-selffix-empty 的根因)。
//
// 修复验证:approval 维度不再决定"要不要探测",只决定"探测完之后怎么归类"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlockedStatus } from '../scripts/lib.mjs';

const CLEAN_CI = { failed: [], pending: [] };
const CLEAN_ROLLUP = { failed: [], pending: [], ok: ['lint + tsc + unit'] };
const STRUCTURAL_BLOCK = { requiredCheckRules: ['code_scanning', 'code_quality'], canBypass: 'always', rulesetIds: [1] };
const NO_STRUCTURAL_BLOCK = { requiredCheckRules: [], canBypass: null, rulesetIds: [1] };

test('P1-4 端到端分流 1/2:reviewDecision=REVIEW_REQUIRED + 存在真实结构性门 → blockClass=structural-check(此前会误判 awaiting-approval,导致 admin-trust 路由不可达)', () => {
  let probeCalls = 0;
  const r = classifyBlockedStatus({
    reviewDecision: 'REVIEW_REQUIRED',
    hasUnresolvedThreads: false,
    ciRuns: CLEAN_CI,
    headRollup: CLEAN_ROLLUP,
    probeStructuralBlock: () => { probeCalls += 1; return STRUCTURAL_BLOCK; },
  });
  assert.equal(r.blockClass, 'structural-check');
  assert.deepEqual(r.structuralBlock, STRUCTURAL_BLOCK);
  assert.equal(probeCalls, 1, '必须真的探测过,不能靠 reviewDecision 短路跳过探测');
});

test('P1-4 端到端分流 2/2:reviewDecision=null(GraphQL 常见形态,与 REVIEW_REQUIRED 同义)+ 存在真实结构性门 → blockClass=structural-check', () => {
  let probeCalls = 0;
  const r = classifyBlockedStatus({
    reviewDecision: null,
    hasUnresolvedThreads: false,
    ciRuns: CLEAN_CI,
    headRollup: CLEAN_ROLLUP,
    probeStructuralBlock: () => { probeCalls += 1; return STRUCTURAL_BLOCK; },
  });
  assert.equal(r.blockClass, 'structural-check');
  assert.deepEqual(r.structuralBlock, STRUCTURAL_BLOCK);
  assert.equal(probeCalls, 1);
});

test('探测证实"确实只是缺 approval"(无结构性门)时,reviewDecision=REVIEW_REQUIRED 正确归 awaiting-approval', () => {
  const r = classifyBlockedStatus({
    reviewDecision: 'REVIEW_REQUIRED',
    hasUnresolvedThreads: false,
    ciRuns: CLEAN_CI,
    headRollup: CLEAN_ROLLUP,
    probeStructuralBlock: () => NO_STRUCTURAL_BLOCK,
  });
  assert.equal(r.blockClass, 'awaiting-approval');
  assert.equal(r.structuralBlock, null);
});

test('探测证实"确实只是缺 approval"(无结构性门)时,reviewDecision=null 同样归 awaiting-approval', () => {
  const r = classifyBlockedStatus({
    reviewDecision: null,
    hasUnresolvedThreads: false,
    ciRuns: CLEAN_CI,
    headRollup: CLEAN_ROLLUP,
    probeStructuralBlock: () => NO_STRUCTURAL_BLOCK,
  });
  assert.equal(r.blockClass, 'awaiting-approval');
});

test('reviewDecision=APPROVED + 存在结构性门 → blockClass=structural-check(回归防线:不因本次修复被误伤)', () => {
  const r = classifyBlockedStatus({
    reviewDecision: 'APPROVED',
    hasUnresolvedThreads: false,
    ciRuns: CLEAN_CI,
    headRollup: CLEAN_ROLLUP,
    probeStructuralBlock: () => STRUCTURAL_BLOCK,
  });
  assert.equal(r.blockClass, 'structural-check');
});

test('reviewDecision=APPROVED + 探测无结构性门 + 其余全干净 → blockClass=blocked-unexplained(异常兜底,fail-closed)', () => {
  const r = classifyBlockedStatus({
    reviewDecision: 'APPROVED',
    hasUnresolvedThreads: false,
    ciRuns: CLEAN_CI,
    headRollup: CLEAN_ROLLUP,
    probeStructuralBlock: () => NO_STRUCTURAL_BLOCK,
  });
  assert.equal(r.blockClass, 'blocked-unexplained');
});

test('probeStructuralBlock 返回 null(探测失败)→ blockClass=ci-unknown,不当 awaiting-approval 或 structural-check 处理', () => {
  const r = classifyBlockedStatus({
    reviewDecision: 'REVIEW_REQUIRED',
    hasUnresolvedThreads: false,
    ciRuns: CLEAN_CI,
    headRollup: CLEAN_ROLLUP,
    probeStructuralBlock: () => null,
  });
  assert.equal(r.blockClass, 'ci-unknown');
  assert.equal(r.structuralBlock, null);
});

test('惰性探测:未 resolve thread 存在时不该走到探测这一步(省 API 调用)', () => {
  let probeCalls = 0;
  const r = classifyBlockedStatus({
    reviewDecision: 'REVIEW_REQUIRED',
    hasUnresolvedThreads: true,
    ciRuns: CLEAN_CI,
    headRollup: CLEAN_ROLLUP,
    probeStructuralBlock: () => { probeCalls += 1; return STRUCTURAL_BLOCK; },
  });
  assert.equal(r.blockClass, 'threads-unresolved');
  assert.equal(probeCalls, 0, '未 resolve thread 已经是确定性 blocker,不该再多发一次探测 API 调用');
});

test('ciRuns===null(CI 状态读取失败)→ ci-unknown,不走到探测这一步', () => {
  let probeCalls = 0;
  const r = classifyBlockedStatus({
    reviewDecision: null,
    hasUnresolvedThreads: false,
    ciRuns: null,
    headRollup: CLEAN_ROLLUP,
    probeStructuralBlock: () => { probeCalls += 1; return STRUCTURAL_BLOCK; },
  });
  assert.equal(r.blockClass, 'ci-unknown');
  assert.equal(probeCalls, 0);
});

test('ciRuns 有 failed 项 → ci-failed,不走到探测这一步', () => {
  let probeCalls = 0;
  const r = classifyBlockedStatus({
    reviewDecision: 'REVIEW_REQUIRED',
    hasUnresolvedThreads: false,
    ciRuns: { failed: ['lint + tsc + unit'], pending: [] },
    headRollup: CLEAN_ROLLUP,
    probeStructuralBlock: () => { probeCalls += 1; return STRUCTURAL_BLOCK; },
  });
  assert.equal(r.blockClass, 'ci-failed');
  assert.equal(probeCalls, 0);
});
