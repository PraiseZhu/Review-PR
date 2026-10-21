// 放行前收口全量(#100)的范围判定:SC3 上一轮干净且代码变 → 直接全量;SC4 修复轮免收口;SC5 同 head 待补 → 直接补跑全量。
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiffByFile, filePatchHashes, computeReviewScope, previousFromResult, fixRoundExemption, readFinalFull } from './scope.mjs';

const SHA0 = 'a'.repeat(40);
const SHA1 = 'b'.repeat(40);
const diff = (bodyA, bodyB = '+b2') => [
  'diff --git a/src/a.ts b/src/a.ts', 'index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10,3 +10,4 @@ export function a() {', ' keep', bodyA, ' tail',
  'diff --git a/src/b.ts b/src/b.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/b.ts', '@@ -0,0 +1,1 @@', bodyB,
  'diff --git a/src/c.ts b/src/c.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/c.ts', '@@ -0,0 +1,1 @@', '+c',
].join('\n');
const filesOf = (...args) => splitDiffByFile(diff(...args));
const current = (over = {}, files = filesOf('+added', '+b2')) => ({
  head: SHA1, baseRefName: 'main', diffHash: 'd1', filePatchHashes: filePatchHashes(files),
  fileChangedLines: { 'src/a.ts': 1, 'src/b.ts': 1, 'src/c.ts': 1 }, totalDiffLines: 3, tier: 'standard', triggerKinds: [],
  specDigest: 'spec-1', now: Date.parse('2026-10-11T12:00:00Z'), ...over,
});
const base = (files, over = {}) => ({
  head: SHA0, baseRefName: 'main', diffHash: 'd0', reviewed: true, reportComplete: true, outcome: 'findings', reviewClean: true, findings: [],
  filePatchHashes: filePatchHashes(files), totalDiffLines: 3, tier: 'standard', triggerKinds: [], specDigest: 'spec-1',
  lastFullReviewAt: '2026-10-10T12:00:00Z', ...over,
});
const FINDING = { path: 'src/b.ts', line: 1, body: '[P1] 问题', key: 'k1', severity: 'P1' };
const closing = (over = {}) => base(filesOf('+added', '+b2'), {
  reviewClean: false, findings: [FINDING],
  finalFull: { head: SHA0, runId: '41', outcome: 'findings' }, finalFullContext: { kind: 'same-run', findingFiles: ['src/b.ts'], previousRound: null }, ...over,
});

test('SC3 上一轮干净、本轮代码变了 → 直接全量(不先跑增量);没变仍沿用', () => {
  const prev = base(filesOf('+old', '+b2'));
  const scope = computeReviewScope({ previous: prev, current: current(), headIsDescendant: true });
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /上一轮已干净,本轮代码有变化/);
  assert.deepEqual(scope.files, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  const same = computeReviewScope({ previous: base(filesOf('+added', '+b2'), { head: SHA1 }), current: current(), headIsDescendant: null });
  assert.equal(same.mode, 'reuse');
});

test('SC3 advisory(代码干净、门未过)也算干净;转 issue 的问题不算干净,仍走增量', () => {
  const advisory = base(filesOf('+old', '+b2'), { reviewClean: false, outcome: 'merge-blocked', pendingGates: ['ui-evidence'] });
  // advisory 在 previousFromResult 里被折成 reviewClean=true;computeReviewScope 看到的就是 true。
  const prev = { ...advisory, reviewClean: true };
  assert.equal(computeReviewScope({ previous: prev, current: current(), headIsDescendant: true }).mode, 'full');
  const deferred = { ...prev, deferred: [{ path: 'src/a.ts', deferredTo: 9, body: '[P2] x' }] };
  assert.equal(computeReviewScope({ previous: deferred, current: current(), headIsDescendant: true }).mode, 'incremental');
});

test('SC3 规则改版且代码没变:仍按 #106 沿用,不触发收口全量', () => {
  const prev = base(filesOf('+added', '+b2'), { specDigest: 'spec-0' });
  const scope = computeReviewScope({ previous: prev, current: current({ head: SHA0, specDigest: 'spec-1' }), headIsDescendant: true });
  assert.equal(scope.mode, 'reuse');
});

test('SC4 上一轮是收口且有问题、本轮改动全落在问题文件里 → 增量带免收口候选', () => {
  const files = filesOf('+added', '+b2-fixed');
  const scope = computeReviewScope({ previous: closing(), current: current({}, files), headIsDescendant: true });
  assert.equal(scope.mode, 'incremental');
  assert.deepEqual(scope.finalFullExemption, { sourceHead: SHA0, sourceRunId: '41', issueFiles: ['src/b.ts'], changedFiles: ['src/b.ts'] });
});

test('SC4 改动超出问题文件 → 没有免收口候选(增量干净后照常收口)', () => {
  const files = filesOf('+changed', '+b2-fixed');
  const scope = computeReviewScope({ previous: closing(), current: current({}, files), headIsDescendant: true });
  assert.equal(scope.mode, 'incremental');
  assert.equal(scope.finalFullExemption, undefined);
});

test('SC4 前提不全不免收口:上一轮不是收口(无记录/direct-full/outcome 不是 findings)、没有真实变更、记录 head 不是上一轮 head', () => {
  const files = filesOf('+added', '+b2-fixed');
  const run = (previous) => computeReviewScope({ previous, current: current({}, files), headIsDescendant: true }).finalFullExemption;
  assert.equal(run(closing({ finalFull: null, finalFullContext: null })), undefined);
  assert.equal(run(closing({ finalFullContext: { kind: 'direct-full', findingFiles: ['src/b.ts'], previousRound: null } })), undefined);
  assert.equal(run(closing({ finalFull: { head: SHA0, runId: '41', outcome: 'clean' } })), undefined);
  assert.equal(run(closing({ finalFull: { head: SHA1, runId: '41', outcome: 'findings' } })), undefined);
  assert.equal(run(closing({ finalFullContext: { kind: 'same-run', findingFiles: [], previousRound: null } })), undefined);
  assert.deepEqual(fixRoundExemption({ previous: closing(), changed: [] }), {});
  assert.deepEqual(fixRoundExemption({ previous: closing(), changed: ['src/b.ts', 'src/z.ts'] }), {});
  assert.deepEqual(fixRoundExemption({ previous: closing({ findings: [] }), changed: ['src/b.ts'] }), {});
  assert.ok(fixRoundExemption({ previous: closing({ finalFullContext: { kind: 'budget-retry', findingFiles: ['src/b.ts'], previousRound: null } }), changed: ['src/b.ts'] }).finalFullExemption);
});

test('SC4 超过 7 天、超半数、新确认门这些全量兜底仍先于豁免', () => {
  const files = filesOf('+added', '+b2-fixed');
  const half = computeReviewScope({ previous: closing({ totalDiffLines: 1 }), current: current({}, files), headIsDescendant: true });
  assert.equal(half.mode, 'full');
  const old = computeReviewScope({ previous: closing({ lastFullReviewAt: '2026-10-01T00:00:00Z' }), current: current({}, files), headIsDescendant: true });
  assert.equal(old.mode, 'full');
  const gate = computeReviewScope({ previous: closing(), current: current({ triggerKinds: ['security'] }, files), headIsDescendant: true });
  assert.equal(gate.mode, 'full');
});

// ── 同 head 收口待补 ──────────────────────────────────────────────────────────
const pendingResult = (over = {}, mivo = {}) => ({
  pr: 7, head: SHA1, outcome: 'error', retry: true, reviewed: false, reviewClean: false, reviewEvidence: { baseRefName: 'main', diffHash: 'd1' },
  mivo: { targetRepo: 'o/r', runId: '77', reportComplete: false, filePatchHashes: filePatchHashes(filesOf('+added', '+b2')), totalDiffLines: 3,
    tier: 'standard', triggerKinds: [], specDigest: 'spec-1', lastFullReviewAt: '2026-10-10T12:00:00Z',
    scope: { mode: 'incremental', previousFindings: [FINDING, { path: 'src/gone.ts', body: '[P2] y', key: 'k2' }] },
    finalFull: { head: SHA1, runId: '77', outcome: 'pending-budget' }, finalFullContext: { kind: 'same-run', findingFiles: [], previousRound: { roundIndex: 2, findings: [], keys: ['k1'] } },
    ...mivo }, ...over,
});

test('SC5 同 head 的待补包 → 直接全量补跑,带旧问题清单并按本轮 diff 重算 outOfDiff', () => {
  const prev = previousFromResult(pendingResult(), 'r');
  assert.equal(prev.pendingFinalFull.runId, '77');
  const scope = computeReviewScope({ previous: prev, current: current(), headIsDescendant: null });
  assert.equal(scope.mode, 'full');
  assert.equal(scope.purpose, 'final-full');
  assert.equal(scope.finalFullKind, 'budget-retry');
  assert.deepEqual(scope.previousFindings.map((f) => [f.key, f.outOfDiff === true]), [['k1', false], ['k2', true]]);
});

test('SC5 待补标记只认形状完整、身份一致的包:非 error、runId 不一致、head 不一致、kind 非法都不算', () => {
  const ok = (r) => previousFromResult(r, '').pendingFinalFull;
  assert.ok(ok(pendingResult()));
  assert.equal(ok(pendingResult({ outcome: 'findings' })), null);
  assert.equal(ok(pendingResult({ retry: false })), null);
  assert.equal(ok(pendingResult({}, { finalFull: { head: SHA1, runId: '1', outcome: 'pending-budget' } })), null);
  assert.equal(ok(pendingResult({}, { finalFull: { head: SHA0, runId: '77', outcome: 'pending-budget' } })), null);
  assert.equal(ok(pendingResult({}, { finalFull: { head: SHA1, runId: '77', outcome: 'clean' } })), null);
  assert.equal(ok(pendingResult({}, { finalFullContext: { kind: 'direct-full', findingFiles: [], previousRound: null } })), null);
  assert.equal(ok(pendingResult({}, { finalFullContext: { kind: 'same-run', findingFiles: ['../x'], previousRound: null } })), null);
  assert.equal(readFinalFull({ head: 'zz', runId: '1', outcome: 'clean' }), null);
  assert.equal(readFinalFull('x'), null);
});

test('SC5 待补包但 head 已变 → 不适用补跑,走常规判断(上一轮没审完 → 全量)', () => {
  const prev = previousFromResult(pendingResult(), 'r');
  const scope = computeReviewScope({ previous: prev, current: current({ head: 'c'.repeat(40) }), headIsDescendant: true });
  assert.equal(scope.mode, 'full');
  assert.equal(scope.purpose, undefined);
  assert.match(scope.reason, /上一轮没审完/);
});

test('previousFromResult 带回完整收口记录和问题文件;畸形记录当没有', () => {
  const result = { pr: 7, head: SHA0, reviewed: true, reviewClean: false, outcome: 'findings', reviewEvidence: { baseRefName: 'main', diffHash: 'd0' },
    mivo: { targetRepo: 'o/r', runId: '41', reportComplete: true, findings: [FINDING], deferred: [],
      finalFull: { head: SHA0, runId: '41', outcome: 'findings' }, finalFullContext: { kind: 'same-run', findingFiles: ['src/b.ts'], previousRound: null } } };
  const prev = previousFromResult(result, '');
  assert.deepEqual(prev.finalFull, { head: SHA0, runId: '41', outcome: 'findings' });
  assert.deepEqual(prev.finalFullContext.findingFiles, ['src/b.ts']);
  assert.equal(prev.pendingFinalFull, null);
  const bad = previousFromResult({ ...result, mivo: { ...result.mivo, finalFull: { head: 'x', runId: 'y', outcome: 'z' }, finalFullContext: 'oops' } }, '');
  assert.equal(bad.finalFull, null);
  assert.equal(bad.finalFullContext, null);
  assert.equal(previousFromResult({ ...result, mivo: { ...result.mivo, finalFull: undefined } }, '').finalFull, null);
});
