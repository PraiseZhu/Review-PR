#!/usr/bin/env node
// retry-ci.mjs 的纯判定回归。
import { classifyCiRerunCandidate, requiredCheckNames } from './retry-ci.mjs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) return;
  failed += 1;
  console.error('FAIL ' + name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  check(name, a === e, 'got ' + a + ', want ' + e);
}

eq('required checks 合并 ruleset', requiredCheckNames({ requiredStatusChecks: [
  { context: 'DCO', integrationId: 1 }, { context: 'verify' }, 'Windows unit tests', { context: 'DCO' },
] }), ['DCO', 'verify', 'Windows unit tests']);

const run = { id: 42, name: 'client-ci', status: 'completed', conclusion: 'failure', run_attempt: 1 };
const goodJobs = [
  { name: 'verify-checks', status: 'completed', conclusion: 'success' },
  { name: 'Linux unit tests', status: 'completed', conclusion: 'success' },
];
const eligible = classifyCiRerunCandidate({ run, jobs: goodJobs,
  requiredChecks: ['verify', 'Windows unit tests'], observedChecks: ['DCO', 'verify-checks', 'Linux unit tests'] });
check('workflow failure + 全部 job 成功 + 缺 required check → eligible', eligible.eligible === true);
eq('记录缺失 required checks', eligible.missingRequiredChecks, ['verify', 'Windows unit tests']);

check('真实 job failure 不重跑', classifyCiRerunCandidate({ run, jobs: [
  ...goodJobs, { name: 'Windows unit tests', status: 'completed', conclusion: 'failure' },
], requiredChecks: ['verify'], observedChecks: [] }).eligible === false);
check('已有 run attempt 不重跑', classifyCiRerunCandidate({ run: { ...run, run_attempt: 2 }, jobs: goodJobs,
  requiredChecks: ['verify'], observedChecks: [] }).eligible === false);
check('required check 已上报不重跑', classifyCiRerunCandidate({ run, jobs: goodJobs,
  requiredChecks: ['verify'], observedChecks: ['verify'] }).eligible === false);
check('job 名称本身不算 check 已上报', classifyCiRerunCandidate({ run,
  jobs: [{ name: 'verify', status: 'completed', conclusion: 'success' }],
  requiredChecks: ['verify'], observedChecks: [] }).eligible === true);
check('jobs 读取为空不重跑', classifyCiRerunCandidate({ run, jobs: [], requiredChecks: ['verify'], observedChecks: [] }).eligible === false);

if (failed) process.exit(1);
console.log('ci-rerun.test.mjs 全部通过');
