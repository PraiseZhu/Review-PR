// evaluateApprovalBasis + resolveApprovedShortcut 的矩阵测试(SC-B / SC3.2 / SC-E,
// 2026-08-04 #469 复盘)。覆盖:viewer-only@head / 非 viewer@head / 并存 / stale viewer /
// review commit 缺失 / 分页截断 / viewer 缺失 / bot 排除 / DISMISSED 覆盖 —— 全部 unknown
// 走 fail-closed(不承认 approval,宁可多要一道授权)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateApprovalBasis, resolveApprovedShortcut } from '../scripts/lib.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const r = (author, state, submittedAt, commitOid, isBot = false) => ({ author, state, submittedAt, commitOid, isBot });
const evalBasis = (reviews, over = {}) =>
  evaluateApprovalBasis({ reviews, headRefOid: HEAD, viewerLogin: 'PraiseZhu', reviewsComplete: true, ...over });

test('viewer 自己在当前 head 的 APPROVED → own-account(不是 independent)', () => {
  const b = evalBasis([r('PraiseZhu', 'APPROVED', '2026-08-04T10:00:00Z', HEAD)]);
  assert.equal(b.basis, 'own-account');
  assert.equal(b.ownAccountCurrentHead, true);
  assert.deepEqual(b.independentApprovers, []);
});

test('非 viewer 在当前 head 的 APPROVED → independent', () => {
  const b = evalBasis([r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD)]);
  assert.equal(b.basis, 'independent');
  assert.deepEqual(b.independentApprovers, ['kirozeng']);
});

test('并存:independent 优先于 own-account', () => {
  const b = evalBasis([
    r('PraiseZhu', 'APPROVED', '2026-08-04T10:00:00Z', HEAD),
    r('kirozeng', 'APPROVED', '2026-08-04T11:00:00Z', HEAD),
  ]);
  assert.equal(b.basis, 'independent');
  assert.equal(b.ownAccountCurrentHead, true);
});

test('#469 形态:viewer 的 APPROVED 绑定旧 head → stale,不构成任何 shortcut', () => {
  const b = evalBasis([r('PraiseZhu', 'APPROVED', '2026-08-04T10:28:00Z', OLD)]);
  assert.equal(b.basis, 'stale');
  assert.deepEqual(b.staleApprovers, ['praisezhu']);
  const sc = resolveApprovedShortcut({ approvalBasis: b, ownAckRequired: false, headBoundAuthorized: false });
  assert.equal(sc.granted, false);
  assert.match(sc.reason, /stale/);
});

test('review 的 commitOid 缺失 → 按 stale 处理(fail-closed,不猜"可能是当前的")', () => {
  const b = evalBasis([r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', null)]);
  assert.equal(b.basis, 'stale');
});

test('分页不完整 → basis=none,一票否决(fail-closed)', () => {
  const b = evalBasis([r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD)], { reviewsComplete: false });
  assert.equal(b.basis, 'none');
  assert.equal(b.dataComplete, false);
});

test('headRefOid 缺失/非法 → basis=none(fail-closed)', () => {
  const b = evalBasis([r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD)], { headRefOid: '' });
  assert.equal(b.basis, 'none');
});

test('viewerLogin 缺失 → current-head approval 保守按 own-account(不冒认 independent)', () => {
  const b = evalBasis([r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD)], { viewerLogin: '' });
  assert.equal(b.basis, 'own-account');
});

test('同一 reviewer 的最新意见覆盖旧意见:先 APPROVED 后 CHANGES_REQUESTED → 不算 approval', () => {
  const b = evalBasis([
    r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD),
    r('kirozeng', 'CHANGES_REQUESTED', '2026-08-04T11:00:00Z', HEAD),
  ]);
  assert.equal(b.basis, 'none');
});

test('DISMISSED 覆盖旧 APPROVED → 不算 approval(与 GitHub reviewDecision 语义一致)', () => {
  const b = evalBasis([
    r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD),
    r('kirozeng', 'DISMISSED', '2026-08-04T11:00:00Z', HEAD),
  ]);
  assert.equal(b.basis, 'none');
});

test('bot 的 review 不进任何 basis;COMMENTED 不算 opinionated', () => {
  const b = evalBasis([
    r('greptile-apps[bot]', 'APPROVED', '2026-08-04T10:00:00Z', HEAD, true),
    r('kirozeng', 'COMMENTED', '2026-08-04T11:00:00Z', HEAD),
  ]);
  assert.equal(b.basis, 'none');
});

// ── resolveApprovedShortcut ──

test('shortcut: independent → 恒 granted(配置无关)', () => {
  const basis = evalBasis([r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD)]);
  for (const ownAckRequired of [false, true]) {
    assert.equal(resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired, headBoundAuthorized: false }).granted, true);
  }
});

test('shortcut: own-account + 配置关 → granted(现状兼容);配置开 → 需 head 绑定授权', () => {
  const basis = evalBasis([r('PraiseZhu', 'APPROVED', '2026-08-04T10:00:00Z', HEAD)]);
  assert.equal(resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired: false, headBoundAuthorized: false }).granted, true);
  const denied = resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired: true, headBoundAuthorized: false });
  assert.equal(denied.granted, false);
  assert.match(denied.reason, /own-account-approval-needs-explicit-auth/);
  assert.equal(resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired: true, headBoundAuthorized: true }).granted, true);
});

test('shortcut: none/stale → 恒不 granted', () => {
  for (const reviews of [[], [r('PraiseZhu', 'APPROVED', '2026-08-04T10:00:00Z', OLD)]]) {
    const basis = evalBasis(reviews);
    assert.equal(resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired: false, headBoundAuthorized: true }).granted, false);
  }
});
