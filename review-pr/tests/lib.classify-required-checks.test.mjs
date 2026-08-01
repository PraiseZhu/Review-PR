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
