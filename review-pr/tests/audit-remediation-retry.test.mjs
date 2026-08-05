// audit-merged-loop-prs.mjs 的 remediation 重试/游标推进边界单测
// (F-A5-REMEDIATION-RETRY-LOSS,seat②codex-adversarial R2 finding)。
//
// 根因:main() 此前无论本轮 remediation(revert PR 创建 / T0 告警发送)是否成功,都
// 无条件把游标推进到 now。窗口左边界一旦前移,remediation 失败的 PR 因 mergedAt 早于
// 新游标被窗口过滤器永久排除——代码注释写的「失败下轮重试」实际不成立(seat② fake-gh
// 实测:第 2 轮 revert.created=false 后游标照推,第 3 轮 audited=[],revert 尝试永远
// 停在 1 次)。
//
// 修复不变量:游标只能推进到「窗口内已完全解决」的边界——存在未解决 entry 时,停在
// 这些 entry 里最早的 mergedAt(下一轮窗口重新纳入它);「未解决」判据与 main() 循环
// 开头的已审跳过判据(audited[key].alerted || verdictOk)保持同一套,外加一种
// cursor-only 特例:告警能力关闭(仓库级长期配置状态,非「这次没送达」)且 revert 已
// 创建成功 → 允许游标越过,否则游标在未配置告警的仓库上永久卡死。
//
// 跑:node --test review-pr/tests/audit-remediation-retry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMergedLoopEntryResolved, decideCursorAfterRemediation, isOpsAlertDelivered } from '../scripts/audit-merged-loop-prs.mjs';

const CURSOR = '2026-08-01T00:00:00.000Z';
const NOW = '2026-08-05T12:00:00.000Z';

function entry(over = {}) {
  return { pr: 9, key: '9:m9', mergedAt: '2026-08-02T10:00:00.000Z', ok: false, ...over };
}

// ---- isMergedLoopEntryResolved ----

test('verdict.ok=true(head-bound clean receipt)→ 已解决', () => {
  assert.equal(isMergedLoopEntryResolved({ entry: entry({ ok: true }), audited: {} }), true);
});

test('already-audited 跳过项 → 已解决(不阻塞游标)', () => {
  assert.equal(isMergedLoopEntryResolved({ entry: { pr: 9, key: '9:m9', skipped: 'already-audited' }, audited: {} }), true);
});

test('revert 创建成功 + 告警真送达(audited.alerted=true)→ 已解决', () => {
  const audited = { '9:m9': { revertPr: 77, alerted: true } };
  assert.equal(isMergedLoopEntryResolved({ entry: entry(), audited }), true);
});

test('(a) revert 创建失败(台账无 revertPr、无 alerted)→ 未解决,必须重试', () => {
  const e = entry({ revert: { created: false, reason: 'revert-failed: boom' }, alert: { posted: true, channel: 'slack' } });
  // 注意:alert 送达但 revert 没开出来——alerted 只在 alert.posted 时写台账,这里模拟
  // main() 的真实台账状态:alerted 已记但 revertPr 缺失。按 main() 的已审跳过判据
  // (alerted || verdictOk)这条会被跳过,所以 resolved 判定必须与其一致,不能比它更严
  // (否则游标永远等一个不会再被处理的 entry)。
  const audited = { '9:m9': { alerted: true } };
  assert.equal(isMergedLoopEntryResolved({ entry: e, audited }), true, '与 main() 已审跳过判据保持一致:alerted 即不再重扫,游标不应为它卡住');
});

test('(a) 告警配置了但这次发送失败(alert-failed)且 revert 也失败 → 未解决', () => {
  const e = entry({ revert: { created: false, reason: 'revert-failed: x' }, alert: { posted: false, reason: 'alert-failed: timeout' } });
  assert.equal(isMergedLoopEntryResolved({ entry: e, audited: {} }), false);
});

test('(a) revert 已创建但告警「配置了却没送达」(alert-failed)→ 未解决(告警侧还要重试)', () => {
  const e = entry({ revert: { created: true, number: 77 }, alert: { posted: false, reason: 'alert-failed: timeout' } });
  const audited = { '9:m9': { revertPr: 77 } };
  assert.equal(isMergedLoopEntryResolved({ entry: e, audited }), false);
});

test('(d) 告警能力关闭(notify-module-not-configured)+ revert 已创建 → 已解决(游标可越过,防止未配置仓库游标永久卡死)', () => {
  const e = entry({ revert: { created: true, number: 77 }, alert: { posted: false, reason: 'notify-module-not-configured' } });
  const audited = { '9:m9': { revertPr: 77 } };
  assert.equal(isMergedLoopEntryResolved({ entry: e, audited }), true);
});

test('(d) 告警能力关闭(ops-alert-channel-not-configured)+ revert 已创建 → 已解决', () => {
  const e = entry({ revert: { created: true, number: 77 }, alert: { posted: false, reason: 'ops-alert-channel-not-configured' } });
  const audited = { '9:m9': { revertPr: 77 } };
  assert.equal(isMergedLoopEntryResolved({ entry: e, audited }), true);
});

test('(d) 告警能力关闭但 revert 创建失败 → 未解决(revert 侧仍要重试)', () => {
  const e = entry({ revert: { created: false, reason: 'revert-failed: x' }, alert: { posted: false, reason: 'notify-module-not-configured' } });
  assert.equal(isMergedLoopEntryResolved({ entry: e, audited: {} }), false);
});

// ---- decideCursorAfterRemediation ----

test('(b) 全部已解决 → 游标推进到 now', () => {
  const results = [entry({ ok: true }), { pr: 8, key: '8:m8', skipped: 'already-audited' }];
  assert.equal(decideCursorAfterRemediation({ results, audited: {}, cursor: CURSOR, now: NOW }), NOW);
});

test('(b) 空窗口(本轮零 entry)→ 游标推进到 now', () => {
  assert.equal(decideCursorAfterRemediation({ results: [], audited: {}, cursor: CURSOR, now: NOW }), NOW);
});

test('(a)(不变量核心)存在 remediation 失败的 entry → 游标停在其 mergedAt,不推进到 now', () => {
  const bad = entry({ mergedAt: '2026-08-03T09:00:00.000Z', revert: { created: false, reason: 'revert-failed: x' }, alert: { posted: false, reason: 'alert-failed: y' } });
  const next = decideCursorAfterRemediation({ results: [bad], audited: {}, cursor: CURSOR, now: NOW });
  assert.equal(next, '2026-08-03T09:00:00.000Z', '游标必须停在未解决 PR 的 mergedAt,让下一轮窗口重新纳入它——推到 now 就是 F-A5-REMEDIATION-RETRY-LOSS 原始漏洞');
});

test('(c) 多条混合(有的解决有的没有)→ 游标取未解决集合里最早的 mergedAt', () => {
  const ok1 = entry({ pr: 1, key: '1:m1', ok: true, mergedAt: '2026-08-02T01:00:00.000Z' });
  const bad2 = entry({ pr: 2, key: '2:m2', mergedAt: '2026-08-04T08:00:00.000Z', revert: { created: false, reason: 'revert-failed' }, alert: { posted: false, reason: 'alert-failed: y' } });
  const bad3 = entry({ pr: 3, key: '3:m3', mergedAt: '2026-08-03T02:00:00.000Z', revert: { created: false, reason: 'revert-failed' }, alert: { posted: false, reason: 'alert-failed: y' } });
  const next = decideCursorAfterRemediation({ results: [ok1, bad2, bad3], audited: {}, cursor: CURSOR, now: NOW });
  assert.equal(next, '2026-08-03T02:00:00.000Z', '取未解决里最早的 mergedAt,已解决的不影响');
});

test('未解决 entry 的 mergedAt 缺失 → fail-closed:游标原地不动(不假设缺失=放行)', () => {
  const bad = entry({ mergedAt: null, revert: { created: false, reason: 'revert-failed' }, alert: { posted: false, reason: 'alert-failed: y' } });
  const next = decideCursorAfterRemediation({ results: [bad], audited: {}, cursor: CURSOR, now: NOW });
  assert.equal(next, CURSOR);
});

// ---- isOpsAlertDelivered(F-A5-OPS-ALERT-CONTRACT-DRIFT,seat②codex-adversarial R3 finding)----
// 此前 sendOpsAlert 误用 channel==='slack' 判送达(该枚举值从不出现,真实枚举是
// api/webhook/degraded),api 真送达被判失败→alerted 不落账→游标被卡+下轮重复告警。

test('api 通道送达 → 算真送达(此前被误判失败,正是 finding 复现场景)', () => {
  assert.equal(isOpsAlertDelivered('api'), true);
});

test('webhook 通道 → 算送达(与 notify-sync-alert.mjs 判据同款;生产上已摘 webhook,保留为形状一致+枚举 fail-safe)', () => {
  assert.equal(isOpsAlertDelivered('webhook'), true);
});

test("degraded 降级路径/legacy 'slack' 字面量/undefined → 均不算送达(不写 alerted,留给下轮重试)", () => {
  assert.equal(isOpsAlertDelivered('degraded'), false);
  assert.equal(isOpsAlertDelivered('slack'), false, "'slack' 是修复前的错误字面量,真实枚举里不存在,必须不算送达");
  assert.equal(isOpsAlertDelivered(undefined), false);
});
