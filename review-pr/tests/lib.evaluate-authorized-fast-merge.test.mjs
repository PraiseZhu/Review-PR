// evaluateAuthorizedFastMerge 单测 —— 2026-08-01 owner 拍板收窄阻断面 + 2026-08-02 P1-1
// fail-closed 化后的核心回归防线。紧急通道语义:「特别要紧的 PR 要立即合,只要 CI 绿 +
// 明确授权」,管理员显式授权即自担责任,机器职责从「拦」变成「留痕」。
//
// 任何情况不可绕过(必须 eligible=false):安全扫描未成功完成(P1-1)、泄密硬门、物理
// 冲突(DIRTY)、required 检查未全绿或读取失败。
// 不阻断但必须显著写进 reportOnly(eligible 可以是 true):格式门未过、未 resolve
// thread、非 required 检查失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAuthorizedFastMerge } from '../scripts/lib.mjs';

const GREEN_REQUIRED = { requiredFailed: [], requiredPending: [], nonRequiredFailed: [], nonRequiredPending: [] };
const SCAN_CLEAN = { scanned: true, hardHitCount: 0 };

// ── 2026-08-01 裁决新增:两条不再阻断的场景 ──

test('裁决新增 1/2:格式门未过 + 有效授权 → eligible=true,reportOnly 带格式警示', () => {
  const r = evaluateAuthorizedFastMerge({
    security: SCAN_CLEAN,
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
    security: SCAN_CLEAN,
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
    security: SCAN_CLEAN,
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

// ── 任何情况不可绕过的硬阻断(回归防线,防止未来又被悄悄放宽)──

test('P1-1(2026-08-02)硬阻断 0/4:安全扫描未成功完成(scanned=false)→ fail-closed,不当"无命中"放行', () => {
  const r = evaluateAuthorizedFastMerge({
    security: { scanned: false, hardHitCount: 0 },
    mergeStateStatus: 'CLEAN',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, false, 'scanned=false 时即使 hardHitCount=0 也不能放行——没扫到不等于没有');
  assert.match(r.blockedReason, /扫描未成功完成|重试/);
});

test('硬阻断 1/4:泄密硬门命中 → 任何情况不可压过,即使其余全绿', () => {
  const r = evaluateAuthorizedFastMerge({
    security: { scanned: true, hardHitCount: 1 },
    mergeStateStatus: 'CLEAN',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /security\.hardHits/);
});

test('硬阻断 2/4:mergeStateStatus=DIRTY(物理冲突)→ 授权解不了,不可绕过', () => {
  const r = evaluateAuthorizedFastMerge({
    security: SCAN_CLEAN,
    mergeStateStatus: 'DIRTY',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /DIRTY/);
});

test('硬阻断 3/4a:required 检查失败 → CI 硬指标,不因授权而放宽', () => {
  const r = evaluateAuthorizedFastMerge({
    security: SCAN_CLEAN,
    mergeStateStatus: 'BLOCKED',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: { requiredFailed: ['lint + tsc + unit'], requiredPending: [], nonRequiredFailed: [], nonRequiredPending: [] },
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /必需检查失败/);
});

test('硬阻断 3/4b:required 检查还在跑(pending)→ 同样不可绕过,等跑完再合', () => {
  const r = evaluateAuthorizedFastMerge({
    security: SCAN_CLEAN,
    mergeStateStatus: 'BLOCKED',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: { requiredFailed: [], requiredPending: ['e2e kernel gate'], nonRequiredFailed: [], nonRequiredPending: [] },
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /还在跑/);
});

test('硬阻断 3/4c:required 检查读取失败(null)→ fail-closed,未证明全绿不放行', () => {
  const r = evaluateAuthorizedFastMerge({
    security: SCAN_CLEAN,
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
    security: SCAN_CLEAN,
    mergeStateStatus: 'CLEAN',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, true);
  assert.deepEqual(r.reportOnly, { formatIssues: [], unresolvedThreadCount: 0, nonRequiredFailures: [] });
});

test('优先级:扫描未完成与泄密硬命中同时出现时(理论上不该共存,防御性验证)优先报告扫描未完成', () => {
  const r = evaluateAuthorizedFastMerge({
    security: { scanned: false, hardHitCount: 1 },
    mergeStateStatus: 'DIRTY',
    unresolvedThreadCount: 0,
    formatPass: true,
    formatIssues: [],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, false);
  assert.match(r.blockedReason, /扫描未成功完成|重试/);
});

// ── automated-review-gate wave0 追加(SC-4 边界,2026-08-08)──

test('security 缺失/空对象 → fail-closed(未证明无泄露,不当"无命中"处理)', () => {
  for (const security of [undefined, null, {}]) {
    const r = evaluateAuthorizedFastMerge({
      security, mergeStateStatus: 'CLEAN',
      unresolvedThreadCount: 0, formatPass: true, formatIssues: [], requiredChecks: GREEN_REQUIRED,
    });
    assert.equal(r.eligible, false, `security=${JSON.stringify(security)} 必须 fail-closed`);
    assert.match(r.blockedReason, /扫描未成功完成|重试/);
  }
});

test('硬阻断分支 reportOnly 不吞信号(fail-visible:扫描失败/CI 失败时格式与 thread 信号仍显著带出)', () => {
  const r = evaluateAuthorizedFastMerge({
    security: { scanned: false, hardHitCount: 0 },
    mergeStateStatus: 'BLOCKED',
    unresolvedThreadCount: 2, formatPass: false, formatIssues: ['Title 缺合规 type 前缀'],
    requiredChecks: GREEN_REQUIRED,
  });
  assert.equal(r.eligible, false);
  assert.deepEqual(r.reportOnly.formatIssues, ['Title 缺合规 type 前缀']);
  assert.equal(r.reportOnly.unresolvedThreadCount, 2);
});

test('预测红集(反向变异):全绿基线逐维度变异,每个变异恰好红在目标 blockedReason', () => {
  const base = {
    security: SCAN_CLEAN, mergeStateStatus: 'CLEAN',
    unresolvedThreadCount: 0, formatPass: true, formatIssues: [], requiredChecks: GREEN_REQUIRED,
  };
  const ok = evaluateAuthorizedFastMerge(base);
  assert.equal(ok.eligible, true, '前提:全绿基线必须 eligible=true');
  const reds = [
    ['scanned 变 false', { ...base, security: { scanned: false, hardHitCount: 0 } }, /扫描未成功完成|重试/],
    ['hardHitCount 变 1', { ...base, security: { scanned: true, hardHitCount: 1 } }, /security\.hardHits/],
    ['mergeStateStatus 变 DIRTY', { ...base, mergeStateStatus: 'DIRTY' }, /DIRTY/],
    ['requiredFailed 加 lint', { ...base, requiredChecks: { ...GREEN_REQUIRED, requiredFailed: ['lint'] } }, /必需检查失败/],
    ['requiredPending 加 e2e', { ...base, requiredChecks: { ...GREEN_REQUIRED, requiredPending: ['e2e'] } }, /还在跑/],
    ['requiredChecks 变 null', { ...base, requiredChecks: null }, /读取失败/],
  ];
  for (const [label, input, re] of reds) {
    const r = evaluateAuthorizedFastMerge(input);
    assert.equal(r.eligible, false, `${label}:必须 eligible=false`);
    assert.match(r.blockedReason, re, `${label}:blockedReason 必须锚定该维度`);
  }
});
