// decideStructuralBypassRoute 单测 —— 结构性 BLOCKED 三层分级合并路由的核心修复。
// 直接复现 EVOLUTION.md 记录的 #342 型(零 review,非 admin)与 #366 型(admin,缺 APPROVED)场景。
// 纯函数,零网络依赖。
// 2026-08-04(#469 复盘):签名从 reviewDecision 改为 approvedShortcut 布尔——
// 「APPROVED 算不算数」上移到 evaluateApprovalBasis/resolveApprovedShortcut(head 绑定 +
// own-account 收紧),本函数只消费最终布尔;本文件的场景语义不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStructuralBypassRoute } from '../scripts/lib.mjs';

test('SC0-2:非 admin + 机械前提满足但零 review(#342/#366 型 fail-open 场景)必须 skip', () => {
  const r = decideStructuralBypassRoute({ structuralCanBypass: true, approvedShortcut: false, isAdminAuthor: false });
  assert.equal(r.route, 'skip-structural-block');
  assert.equal(r.basis, null);
});

test('reviewDecision=null(GraphQL 常见形态)同样必须挡住,不能因为"非 CHANGES_REQUESTED"就误判可合', () => {
  const r = decideStructuralBypassRoute({ structuralCanBypass: true, approvedShortcut: false, isAdminAuthor: false });
  assert.equal(r.route, 'skip-structural-block');
});

test('非 admin + 真实 APPROVED review → 照常直接 bypass 合并(不因本次修复被误伤)', () => {
  const r = decideStructuralBypassRoute({ structuralCanBypass: true, approvedShortcut: true, isAdminAuthor: false });
  assert.deepEqual(r, { route: 'bypass-structural-block', basis: 'approved' });
});

test('SC0-3:admin(如 ownPr)缺 APPROVED → 进独立审查,不是直接合并、也不是跳过', () => {
  const r = decideStructuralBypassRoute({ structuralCanBypass: true, approvedShortcut: false, isAdminAuthor: true });
  assert.deepEqual(r, { route: 'review-pending-admin-bypass', basis: 'admin-trust' });
});

test('admin 身份不豁免机械前提 —— canBypass/allowlist 不满足时仍 skip', () => {
  const r = decideStructuralBypassRoute({ structuralCanBypass: false, approvedShortcut: false, isAdminAuthor: true });
  assert.equal(r.route, 'skip-structural-block');
});

test('admin 且已有真实 APPROVED(如被其他人 approve 过)→ 优先走 approved 路径,不必进 admin-trust', () => {
  const r = decideStructuralBypassRoute({ structuralCanBypass: true, approvedShortcut: true, isAdminAuthor: true });
  assert.deepEqual(r, { route: 'bypass-structural-block', basis: 'approved' });
});

// ── automated-review-gate wave0 追加(SC-1 策略层,2026-08-08):四象限路由表 + 反向变异 ──

test('SC-1 四象限路由表:structuralCanBypass × approvedShortcut × isAdminAuthor 的确定性路由', () => {
  // [structuralCanBypass, approvedShortcut, isAdminAuthor, 期望 route, 期望 basis]
  const cases = [
    [true, true, false, 'bypass-structural-block', 'approved'],  // 独立 approve@head → 直接 bypass
    [true, true, true, 'bypass-structural-block', 'approved'],   // admin + 真实 approve → approved 优先
    [true, false, true, 'review-pending-admin-bypass', 'admin-trust'], // admin 缺 APPROVED → 进独立审查(回执)
    [true, false, false, 'skip-structural-block', null],         // 非 admin 缺 APPROVED → 跳过(#342/#366 型)
    [false, true, false, 'skip-structural-block', null],         // 机械前提不满足,approve 也救不了
    [false, false, true, 'skip-structural-block', null],         // 机械前提不满足,admin 身份不豁免
  ];
  for (const [canBypass, approved, isAdmin, route, basis] of cases) {
    const r = decideStructuralBypassRoute({ structuralCanBypass: canBypass, approvedShortcut: approved, isAdminAuthor: isAdmin });
    assert.equal(r.route, route, `canBypass=${canBypass} approved=${approved} admin=${isAdmin} → route`);
    assert.equal(r.basis, basis, `canBypass=${canBypass} approved=${approved} admin=${isAdmin} → basis`);
  }
});

test('反向变异:approvedShortcut true→false(同一输入只改这一维)恰好红在 route/basis 断言', () => {
  const rTrue = decideStructuralBypassRoute({ structuralCanBypass: true, approvedShortcut: true, isAdminAuthor: false });
  assert.deepEqual(rTrue, { route: 'bypass-structural-block', basis: 'approved' });
  const rFalse = decideStructuralBypassRoute({ structuralCanBypass: true, approvedShortcut: false, isAdminAuthor: false });
  assert.deepEqual(rFalse, { route: 'skip-structural-block', basis: null });
});
