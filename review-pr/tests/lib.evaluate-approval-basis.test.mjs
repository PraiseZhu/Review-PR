// evaluateApprovalBasis + resolveApprovedShortcut 的矩阵测试(SC-B / SC3.2 / SC-E,
// 2026-08-04 #469 复盘;2026-08-05 第 3 轮复审改造:输入为原生 latestOpinionatedReviews,
// 不再自算 latest-per-reviewer)。覆盖:viewer-only@head / 非 viewer@head / 并存 /
// stale viewer / review commit 缺失 / 分页截断 / viewer 缺失 / bot 排除 / 同 login 数据
// 异常(含顺序不变性)/ reviewDecision 合取 —— 全部 unknown 走 fail-closed(不承认
// approval,宁可多要一道授权)。
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
  const sc = resolveApprovedShortcut({ approvalBasis: b, ownAckRequired: false, headBoundAuthorized: false, reviewDecision: 'APPROVED' });
  assert.equal(sc.granted, false);
  assert.match(sc.reason, /stale/);
});

// ── 第 3 轮复审修订(2026-08-05):输入改为原生 latestOpinionatedReviews,不再自算
// latest-per-reviewer;同 login 多条不一致记录(违反原生字段契约)是数据异常,fail-closed
// 且**与返回顺序无关**——上一版手工 tie-break 被复审实测"只交换数组顺序,granted 在
// true/false 间翻转",这里显式锁顺序不变性。──

test('同 login 多条不一致记录(state 冲突)→ 数据异常不计入,且与顺序无关', () => {
  const pair = [
    r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD),
    r('kirozeng', 'CHANGES_REQUESTED', '2026-08-04T10:00:00Z', HEAD),
  ];
  for (const list of [pair, [...pair].reverse()]) {
    const b = evalBasis(list);
    assert.equal(b.basis, 'none');
    assert.ok(b.reasons.some((s) => /多条不一致记录/.test(s)));
  }
});

test('复审反例:同 login、同为 APPROVED、一条 current-head 一条旧 head → 不计入,正反序结果一致(不再由返回顺序决定 granted)', () => {
  const pair = [
    r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD),
    r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', OLD),
  ];
  for (const list of [pair, [...pair].reverse()]) {
    const b = evalBasis(list);
    assert.equal(b.basis, 'none', '同 login commitOid 冲突必须 fail-closed,不得取任一条');
    const sc = resolveApprovedShortcut({ approvalBasis: b, ownAckRequired: false, headBoundAuthorized: false, reviewDecision: 'APPROVED' });
    assert.equal(sc.granted, false);
  }
});

test('同 login 多条**完全一致**的重复记录 → 幂等,照常计入(不误伤)', () => {
  const b = evalBasis([
    r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD),
    r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD),
  ]);
  assert.equal(b.basis, 'independent');
});

test('单条 review 缺 submittedAt → 与判定无关(原生字段语义下不再消费时间),照常计入', () => {
  const b = evalBasis([r('kirozeng', 'APPROVED', null, HEAD)]);
  assert.equal(b.basis, 'independent');
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

test('同 login 同时出现 APPROVED 与 CHANGES_REQUESTED(意见覆盖由服务端 latestOpinionatedReviews 处理,本地看到即数据异常)→ 不算 approval', () => {
  const b = evalBasis([
    r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD),
    r('kirozeng', 'CHANGES_REQUESTED', '2026-08-04T11:00:00Z', HEAD),
  ]);
  assert.equal(b.basis, 'none');
});

test('同 login 同时出现 APPROVED 与 DISMISSED(dismiss 语义由服务端处理,本地看到即数据异常)→ 不算 approval', () => {
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

test('shortcut: independent(+聚合裁决 APPROVED)→ granted(配置无关)', () => {
  const basis = evalBasis([r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD)]);
  for (const ownAckRequired of [false, true]) {
    assert.equal(resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired, headBoundAuthorized: false, reviewDecision: 'APPROVED' }).granted, true);
  }
});

test('复审修订:reviewDecision 是必要合取条件——REVIEW_REQUIRED/null 时即使 independent@head 也不 granted(防 --admin 绕过审批数/Code Owner 规则)', () => {
  const basis = evalBasis([r('kirozeng', 'APPROVED', '2026-08-04T10:00:00Z', HEAD)]);
  for (const decision of ['REVIEW_REQUIRED', null, undefined, 'CHANGES_REQUESTED']) {
    const sc = resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired: false, headBoundAuthorized: true, reviewDecision: decision });
    assert.equal(sc.granted, false, `reviewDecision=${decision} 必须拒绝`);
    assert.match(sc.reason, /github-review-decision-not-approved/);
  }
});

test('shortcut: own-account + 配置关 → granted(现状兼容);配置开 → 需 head 绑定授权', () => {
  const basis = evalBasis([r('PraiseZhu', 'APPROVED', '2026-08-04T10:00:00Z', HEAD)]);
  assert.equal(resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired: false, headBoundAuthorized: false, reviewDecision: 'APPROVED' }).granted, true);
  const denied = resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired: true, headBoundAuthorized: false, reviewDecision: 'APPROVED' });
  assert.equal(denied.granted, false);
  assert.match(denied.reason, /own-account-approval-needs-explicit-auth/);
  assert.equal(resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired: true, headBoundAuthorized: true, reviewDecision: 'APPROVED' }).granted, true);
});

test('shortcut: none/stale → 恒不 granted(聚合裁决 APPROVED 也救不回——两个条件是合取)', () => {
  for (const reviews of [[], [r('PraiseZhu', 'APPROVED', '2026-08-04T10:00:00Z', OLD)]]) {
    const basis = evalBasis(reviews);
    assert.equal(resolveApprovedShortcut({ approvalBasis: basis, ownAckRequired: false, headBoundAuthorized: true, reviewDecision: 'APPROVED' }).granted, false);
  }
});
