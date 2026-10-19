// CI 红→绿唤醒接线(round.mjs 的 wakeCiFailedPrs)。仿 code-scan-wake.test.mjs:
// 上轮 outcome=ci-failed、已有快照聚合 ci=SUCCESS 时标 retry,不另打 GraphQL。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import * as admission from '../lib/admission.mjs';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
function extractFunction(name) {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(source);
  assert.ok(declaration, `round.mjs 里找不到函数 ${name}`);
  const closing = /^\}/m.exec(source.slice(declaration.index));
  assert.ok(closing, `${name} 没有顶格的结束括号`);
  return source.slice(declaration.index, declaration.index + closing.index + 1);
}

function makeWorld({ rows = {}, issues = [], rs = null, watch = undefined, storeThrows = false } = {}) {
  assert.equal(typeof admission.toCiWake, 'function', 'admission.mjs 应导出 toCiWake');
  const files = new Map();
  if (rs) files.set('/state/key/round-state.json', rs);
  if (watch) files.set('/state/mivo/ci-wake.json', watch);
  const logs = [];
  const sandbox = {
    toCiWake: admission.toCiWake, join,
    CONFIG: { targetRepo: 'o/r', stateDir: '/state', repoRoot: '/repo' },
    loadStore: () => { if (storeThrows) throw new Error('reviews.json 损坏'); return { prs: {} }; },
    stateFile: (name) => `/state/mivo/${name}`,
    roundStateKey: () => 'key',
    readJson: (file, fallback) => (files.has(file) ? structuredClone(files.get(file)) : fallback),
    writeJson: (file, value) => files.set(file, structuredClone(value)),
    log: (event, detail) => logs.push({ event, ...detail }),
  };
  const issuesList = issues.map((number) => ({ number, pull_request: {} }));
  vm.runInNewContext(`${extractFunction('wakeCiFailedPrs')}\nglobalThis.api = { wakeCiFailedPrs };`, sandbox);
  return {
    sweep: (busy = new Set()) => sandbox.api.wakeCiFailedPrs([...issuesList, { number: 999 }], busy),
    logs,
    files,
  };
}

const failedRow = (ci = 'SUCCESS', head = 'h1') => ({
  fingerprint: 'fp', fingerprintFields: { head, ci }, outcome: 'ci-failed', retry: false,
});
const retryOf = (world, pr) => world.files.get('/state/key/round-state.json').prs[pr].retry;
const roundState = (prs) => ({ version: 1, mode: 'review-only', prs });

test('上轮 ci-failed、聚合 SUCCESS:标 retry 唤醒一次;同一状态再次不唤醒', () => {
  const world = makeWorld({
    issues: [1109],
    rs: roundState({ 1109: failedRow() }),
  });
  world.sweep();
  assert.equal(retryOf(world, 1109), true);
  assert.equal(world.logs.find((entry) => entry.event === 'wake-ci').prs[0], 1109);
  assert.deepEqual(world.files.get('/state/mivo/ci-wake.json').seen, { 1109: { head: 'h1', ci: 'SUCCESS' } });
  world.files.get('/state/key/round-state.json').prs[1109].retry = false;
  world.sweep();
  assert.equal(retryOf(world, 1109), false, '状态稳定后不重复唤醒');
});

test('聚合仍红不唤醒;不另打 GitHub', () => {
  const world = makeWorld({
    issues: [3],
    rs: roundState({ 3: failedRow('FAILURE') }),
  });
  world.sweep();
  assert.equal(retryOf(world, 3), false);
  assert.equal(world.logs.some((entry) => entry.event === 'wake-ci'), false);
});

test('在审的 PR 先推迟(不标 retry、基线不动)', () => {
  const world = makeWorld({
    issues: [7],
    rs: roundState({ 7: failedRow() }),
  });
  world.sweep(new Set([7]));
  assert.equal(retryOf(world, 7), false);
  assert.ok(world.logs.some((entry) => entry.event === 'wake-ci-deferred'));
  assert.equal(world.files.has('/state/mivo/ci-wake.json') && world.files.get('/state/mivo/ci-wake.json').seen?.[7], undefined);
});

test('只看开放 PR;没有 ci-failed 记录时不写文件', () => {
  const closed = makeWorld({
    issues: [],
    rs: roundState({ 1: failedRow() }),
  });
  closed.sweep();
  assert.equal(closed.files.get('/state/key/round-state.json').prs[1].retry, false);
  assert.equal(closed.files.has('/state/mivo/ci-wake.json'), false);
  const none = makeWorld({
    issues: [1],
    rs: roundState({ 1: { outcome: 'approval', fingerprintFields: { head: 'h1', ci: 'SUCCESS' }, retry: false } }),
  });
  none.sweep();
  assert.equal(retryOf(none, 1), false);
  assert.equal(none.files.has('/state/mivo/ci-wake.json'), false);
});

test('任何意外只记日志、不抛', () => {
  const broken = makeWorld({ storeThrows: true, issues: [1] });
  assert.doesNotThrow(() => broken.sweep());
});
