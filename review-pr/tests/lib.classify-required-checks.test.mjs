// classifyRequiredChecks 单测 —— 授权快速合并通道的 CI 口径核心(required 全绿即可合,
// 非 required 失败不阻断)。纯函数,零网络依赖。
// 跑:node --test review-pr/tests/  (或单跑本文件: node --test review-pr/tests/lib.classify-required-checks.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequiredChecks } from '../scripts/lib.mjs';

test('required 全绿、非 required(Greptile)失败 —— 分别归档,不互相污染', () => {
  const nodes = [
    { __typename: 'CheckRun', name: 'lint + tsc + unit', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true },
    { __typename: 'CheckRun', name: 'e2e kernel gate', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true },
    { __typename: 'CheckRun', name: 'Greptile Review', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: false },
  ];
  const r = classifyRequiredChecks(nodes);
  assert.deepEqual(r.requiredFailed, []);
  assert.deepEqual(r.nonRequiredFailed, ['Greptile Review']);
});

test('required 检查真失败必须出现在 requiredFailed(硬指标,授权也压不过)', () => {
  const nodes = [
    { __typename: 'CheckRun', name: 'lint + tsc + unit', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: true },
  ];
  const r = classifyRequiredChecks(nodes);
  assert.deepEqual(r.requiredFailed, ['lint + tsc + unit']);
});

test('required 检查还在跑(pending)也要拦,不能当绿放过', () => {
  const nodes = [
    { __typename: 'CheckRun', name: 'e2e kernel gate', status: 'IN_PROGRESS', isRequired: true },
  ];
  const r = classifyRequiredChecks(nodes);
  assert.deepEqual(r.requiredPending, ['e2e kernel gate']);
  assert.deepEqual(r.requiredFailed, []);
});

test('永不上报的必需检查(structural-check 场景)不在 contexts 里时视为无已知问题', () => {
  const nodes = [
    { __typename: 'CheckRun', name: 'lint + tsc + unit', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true },
    // code_scanning / code_quality 从不出现在这份 contexts 列表里
  ];
  const r = classifyRequiredChecks(nodes);
  assert.equal(r.requiredFailed.length, 0);
  assert.equal(r.requiredPending.length, 0);
});

test('StatusContext 形态(state 字段而非 status/conclusion)同样正确分类', () => {
  const nodes = [
    { __typename: 'StatusContext', context: 'legacy-ci', state: 'FAILURE', isRequired: true },
    { __typename: 'StatusContext', context: 'legacy-optional', state: 'PENDING', isRequired: false },
  ];
  const r = classifyRequiredChecks(nodes);
  assert.deepEqual(r.requiredFailed, ['legacy-ci']);
  assert.deepEqual(r.nonRequiredPending, ['legacy-optional']);
});

test('nodes 非数组(读取失败)返回 null —— fail-closed,调用方不得当绿放行', () => {
  assert.equal(classifyRequiredChecks(null), null);
  assert.equal(classifyRequiredChecks(undefined), null);
  assert.equal(classifyRequiredChecks('not-an-array'), null);
});

// ── P1-3(2026-08-02)required 完整性:必需检查从未开始跑(不在 contexts 里)时,单看
// contexts 会误判"没有已知问题"=全绿。expectedRequiredNames(分支保护 required_status_
// checks 规则要求的完整 context 名单)与实际观测到的 requiredSeen 做差,缺失的按
// pending 处理——不能因为"contexts 里没出现"就当绿。──

test('P1-3 负例 1/2:空 contexts + 分支要求 11 项 required checks → 全部判 pending,不 eligible(此前的盲区:空数组看起来"没有已知问题")', () => {
  const expected = new Set([
    'lint + tsc + unit', 'e2e kernel gate', 'typecheck', 'build', 'unit-macos',
    'unit-linux', 'unit-windows', 'security-scan', 'license-check', 'format-check', 'changelog-check',
  ]);
  const r = classifyRequiredChecks([], expected);
  assert.equal(r.requiredFailed.length, 0, '一条都没跑,不该出现在 failed 里(failed 特指"跑过且失败")');
  assert.equal(r.requiredPending.length, 11, '11 项要求的 required check 一条都没出现在 contexts 里,必须全部按 pending 处理');
  assert.deepEqual(new Set(r.requiredPending), expected);
});

test('P1-3 负例 2/2:100 条正常 + 第 101 条才是 required FAILURE → 必须能在完整节点集合里正确捕获,不因数量多而漏判(验证 classifyRequiredChecks 本身没有隐藏的截断上限)', () => {
  const nodes = [];
  for (let i = 0; i < 100; i++) {
    nodes.push({ __typename: 'CheckRun', name: `check-${i}`, status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: false });
  }
  nodes.push({ __typename: 'CheckRun', name: 'the-101st-check', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: true });
  assert.equal(nodes.length, 101);
  const r = classifyRequiredChecks(nodes);
  assert.deepEqual(r.requiredFailed, ['the-101st-check'], '第 101 条(超过单页 GraphQL first:100 的边界)必须被正确分类,不能静默丢失');
});

test('P1-3:required check 真的跑过且通过(在 requiredSeen 里)不会被 expectedRequiredNames 误判成 pending', () => {
  const nodes = [{ __typename: 'CheckRun', name: 'lint + tsc + unit', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true }];
  const r = classifyRequiredChecks(nodes, new Set(['lint + tsc + unit']));
  assert.deepEqual(r.requiredPending, []);
  assert.deepEqual(r.requiredFailed, []);
});

test('P1-3:required check 跑过但失败,同时也在 expectedRequiredNames 里 —— 只进 requiredFailed,不重复计入 requiredPending', () => {
  const nodes = [{ __typename: 'CheckRun', name: 'lint + tsc + unit', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: true }];
  const r = classifyRequiredChecks(nodes, new Set(['lint + tsc + unit']));
  assert.deepEqual(r.requiredFailed, ['lint + tsc + unit']);
  assert.deepEqual(r.requiredPending, []);
});

test('不传 expectedRequiredNames(第二参省略)时行为与此前完全一致,不做完整性核验', () => {
  const r = classifyRequiredChecks([]);
  assert.deepEqual(r.requiredFailed, []);
  assert.deepEqual(r.requiredPending, []);
});
