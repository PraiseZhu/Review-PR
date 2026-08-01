// evaluateAuthorizedFastMerge 单测 —— 2026-08-01 owner 拍板收窄阻断面后的核心回归防线。
// 紧急通道语义:「特别要紧的 PR 要立即合,只要 CI 绿 + 明确授权」,管理员显式授权即
// 自担责任,机器职责从「拦」变成「留痕」。
//
// 任何情况不可绕过(必须 eligible=false):泄密硬门、物理冲突(DIRTY)、required 检查未
// 全绿或读取失败。
// 不阻断但必须显著写进 reportOnly(eligible 可以是 true):格式门未过、未 resolve
// thread、非 required 检查失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAuthorizedFastMerge } from '../scripts/lib.mjs';

const GREEN_REQUIRED = { requiredFailed: [], requiredPending: [], nonRequiredFailed: [], nonRequiredPending: [] };

// ── 2026-08-01 裁决新增:两条不再阻断的场景 ──

test('裁决新增 1/2:格式门未过 + 有效授权 → eligible=true,reportOnly 带格式警示', () => {
  const r = evaluateAuthorizedFastMerge({
    hasSecurityHardHit: false,
    mergeStateStatus: 'BLOCKED',
    unresolvedThreadCount: 0,
    formatPass: false,
    formatIssues: ['Description 缺段落: 这次改了什么 / 怎么验证的'],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, true, '格式门未过不再阻断紧急通道');
  assert.equal(r.blockedReason, null);
  assert.deepEqual(r.reportOnly.formatIssues, ['Description 缺段落: 这次改了什么 / 怎么验证的'], '格式警示必须显著出现在 reportOnly,不能悄悄吞掉');
});

test('裁决新增 2/2:未 resolve thread + 有效授权 → eligible=true,reportOnly 带 thread 计数', () => {
  const r = evaluateAuthorizedFastMerge({
    hasSecurityHardHit: false,
    mergeStateStatus: 'BLOCKED',
    unresolvedThreadCount: 2,
    formatPass: true,
    formatIssues: [],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, true, '未 resolve thread 不再阻断紧急通道');
  assert.equal(r.blockedReason, null);
  assert.equal(r.reportOnly.unresolvedThreadCount, 2, 'thread 计数必须显著出现在 reportOnly');
});

test('格式门未过 + 未 resolve thread + 非 required 失败同时出现 → 三项都进 reportOnly,仍 eligible=true', () => {
  const r = evaluateAuthorizedFastMerge({
    hasSecurityHardHit: false,
    mergeStateStatus: 'BLOCKED',
    unresolvedThreadCount: 3,
    formatPass: false,
    formatIssues: ['Title 缺少合规 type 前缀'],
    requiredChecks: { requiredFailed: [], requiredPending: [], nonRequiredFailed: ['Greptile Review'], nonRequiredPending: [] },
  });
  assert.equal(r.eligible, true);
  assert.deepEqual(r.reportOnly, {
    formatIssues: ['Title 缺少合规 type 前缀'],
    unresolvedThreadCount: 3,
    nonRequiredFailures: ['Greptile Review'],
  });
});

// ── 任何情况不可绕过的三类硬阻断(回归防线,防止未来又被悄悄放宽)──

test('硬阻断 1/3:泄密硬门命中 → 任何情况不可压过,即使其余全绿', () => {
  const r = evaluateAuthorizedFastMerge({
    hasSecurityHardHit: true,
    mergeStateStatus: 'CLEAN',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /security\.hardHits/);
});

test('硬阻断 2/3:mergeStateStatus=DIRTY(物理冲突)→ 授权解不了,不可绕过', () => {
  const r = evaluateAuthorizedFastMerge({
    hasSecurityHardHit: false,
    mergeStateStatus: 'DIRTY',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /DIRTY/);
});

test('硬阻断 3/3a:required 检查失败 → CI 硬指标,不因授权而放宽', () => {
  const r = evaluateAuthorizedFastMerge({
    hasSecurityHardHit: false,
    mergeStateStatus: 'BLOCKED',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: { requiredFailed: ['lint + tsc + unit'], requiredPending: [], nonRequiredFailed: [], nonRequiredPending: [] },
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /必需检查失败/);
});

test('硬阻断 3/3b:required 检查还在跑(pending)→ 同样不可绕过,等跑完再合', () => {
  const r = evaluateAuthorizedFastMerge({
    hasSecurityHardHit: false,
    mergeStateStatus: 'BLOCKED',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: { requiredFailed: [], requiredPending: ['e2e kernel gate'], nonRequiredFailed: [], nonRequiredPending: [] },
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /还在跑/);
});

test('硬阻断 3/3c:required 检查读取失败(null)→ fail-closed,未证明全绿不放行', () => {
  const r = evaluateAuthorizedFastMerge({
    hasSecurityHardHit: false,
    mergeStateStatus: 'BLOCKED',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: null,
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /读取失败/);
});

test('全绿场景(无格式/thread/CI 问题)→ eligible=true,reportOnly 全空', () => {
  const r = evaluateAuthorizedFastMerge({
    hasSecurityHardHit: false,
    mergeStateStatus: 'CLEAN',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, true);
  assert.deepEqual(r.reportOnly, { formatIssues: [], unresolvedThreadCount: 0, nonRequiredFailures: [] });
});

test('优先级:泄密硬门与物理冲突同时命中时,报告的是泄密(检查顺序符合"最不可绕过的先判")', () => {
  const r = evaluateAuthorizedFastMerge({
    hasSecurityHardHit: true,
    mergeStateStatus: 'DIRTY',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /security\.hardHits/);
});
