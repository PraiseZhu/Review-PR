// 规则改版(specDigest 变)的范围判定、全量轮携带上一轮问题、specChange 配置读取、沿用时的锚点处理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiffByFile, filePatchHashes, computeReviewScope, previousFromResult, loadSpecChangePolicy, reanchorReusedFindings } from './scope.mjs';
import { applyConvergence } from './convergence.mjs';

const diff = ['diff --git a/src/a.ts b/src/a.ts', 'index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10,3 +10,4 @@', ' keep', '+added', ' tail'].join('\n');
const files = splitDiffByFile(diff);
const hashes = filePatchHashes(files);
const NOW = Date.parse('2026-10-11T12:00:00Z');
const REUSE_REASON = '规则改版，代码未变，沿用上次结论';

const current = (over = {}) => ({
  head: 'h1', baseRefName: 'main', diffHash: 'd1', filePatchHashes: hashes, fileChangedLines: { 'src/a.ts': 1 }, totalDiffLines: 1,
  tier: 'standard', triggerKinds: [], specDigest: 'spec-new', now: NOW, verifiedDeferralIssues: [], ...over,
});
const previous = (over = {}) => ({
  head: 'h1', baseRefName: 'main', diffHash: 'd1', reviewed: true, reportComplete: true, outcome: 'findings', reviewClean: true,
  findings: [], deferred: [], filePatchHashes: hashes, totalDiffLines: 1, tier: 'standard', triggerKinds: [],
  specDigest: 'spec-old', lastFullReviewAt: '2026-10-10T12:00:00Z', ...over,
});
const scopeOf = (prev, cur = current(), extra = {}) => computeReviewScope({ previous: prev, current: cur, headIsDescendant: true, ...extra });
const F1 = { path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 第一条\n第二行', key: 'aaaaaaaaaaaa', seenRounds: 2 };
const F2 = { path: 'src/gone.ts', body: '[P2] 旧文件的问题' };
const D1 = { path: 'src/a.ts', line: 10, body: '[P2] 已转', deferredTo: 5 };

test('SC3:只有 specDigest 变、改动指纹全同 → 沿用,原因写明', () => {
  const scope = scopeOf(previous());
  assert.equal(scope.mode, 'reuse');
  assert.equal(scope.reason, REUSE_REASON);
  assert.equal(scope.basedOn, 'h1');
});

test('SC3:同 head、祖先新 head、diffHash 变但每文件 patch 相同,都沿用', () => {
  assert.equal(scopeOf(previous({ head: 'h0' })).mode, 'reuse');
  assert.equal(scopeOf(previous({ head: 'h0', diffHash: 'dX' })).mode, 'reuse');
});

test('SC4:规则变且代码也变 → 全量,原因是规则变化,不被「超过一半」截走', () => {
  const modified = previous({ filePatchHashes: { 'src/a.ts': 'other' }, totalDiffLines: 1 });
  const scope = scopeOf(modified);
  assert.equal(scope.mode, 'full');
  assert.equal(scope.reason, '审查任务书或规则变了');
  const added = previous({ filePatchHashes: {} });
  assert.equal(scopeOf(added).reason, '审查任务书或规则变了');
  const removedOnly = previous({ filePatchHashes: { ...hashes, 'src/x.ts': 'h' } });
  assert.equal(scopeOf(removedOnly).mode, 'full');
});

test('SC5:forceFull=true 且规则变 → 全量;规则没变时开关不影响', () => {
  const forced = scopeOf(previous(), current(), { forceFullOnSpecChange: true });
  assert.equal(forced.mode, 'full');
  assert.equal(forced.reason, '审查任务书或规则变了');
  assert.equal(scopeOf(previous(), current(), { forceFullOnSpecChange: false }).mode, 'reuse');
  assert.equal(scopeOf(previous({ specDigest: 'spec-new' }), current(), { forceFullOnSpecChange: true }).reason, '同一版本已审过,沿用上次结论');
  // 只认布尔 true
  assert.equal(scopeOf(previous(), current(), { forceFullOnSpecChange: 'true' }).mode, 'reuse');
});

test('规则变 + 上一轮有问题且代码没变:沿用并带着问题;转 issue 的要本轮仍核验通过', () => {
  const prev = previous({ reviewClean: false, findings: [F1], deferred: [D1] });
  const ok = scopeOf(prev, current({ verifiedDeferralIssues: [5] }));
  assert.equal(ok.mode, 'reuse');
  assert.deepEqual(ok.previousFindings, [F1, D1]);
  const closed = scopeOf(prev, current({ verifiedDeferralIssues: [] }));
  assert.equal(closed.mode, 'full');
  assert.match(closed.reason, /转 issue 的问题本轮未核验通过/);
  assert.deepEqual(closed.previousFindings, [F1, D1], '全量照样带着上一轮问题');
});

test('规则变 + 上一轮未放行且没有问题条目 → 不新增沿用路径,仍全量', () => {
  const scope = scopeOf(previous({ reviewClean: false }));
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /没有可沿用的问题条目/);
  // advisory(只是前置门没过)经 previousFromResult 视为代码干净,可沿用
  const prev = { ...previous(), ...previousFromResult({ head: 'h1', reviewed: true, reviewClean: false, outcome: 'findings',
    reviewEvidence: { baseRefName: 'main', diffHash: 'd1' }, mivo: { reportComplete: true, advisory: { pendingGates: ['ui-evidence'] }, findings: [], filePatchHashes: hashes,
      totalDiffLines: 1, tier: 'standard', specDigest: 'spec-old', lastFullReviewAt: '2026-10-10T12:00:00Z' } }) };
  assert.equal(scopeOf(prev).mode, 'reuse');
});

test('独立兜底不被规则改版绕过', () => {
  const cases = [
    [previous({ reportComplete: false }), /没审完/],
    [previous({ lastFullReviewAt: '2026-10-01T00:00:00Z' }), /7 天/],
    [previous({ baseRefName: 'dev' }), /base 分支变了/],
    [previous({ tier: 'light' }), /档位升级/],
    [previous({ manualReview: true }), /人工复核/],
    [previous({ pendingGates: ['handoff'] }), /交接/],
  ];
  for (const [prev, re] of cases) assert.match(scopeOf(prev).reason, re);
  assert.match(scopeOf(previous(), current({ triggerKinds: ['security'] })).reason, /新增确认门/);
  assert.match(scopeOf(previous({ specDigest: undefined })).reason, /没有任务书版本/);
  const nonAncestor = computeReviewScope({ previous: previous({ head: 'h0' }), current: current(), headIsDescendant: null });
  assert.equal(nonAncestor.mode, 'full');
  assert.match(nonAncestor.reason, /不是当前版本的祖先/);
});

test('SC1:全量轮携带上一轮完整结果的问题(含已不在 diff 的、转 issue 的);不完整的不带', () => {
  const trusted = previous({ reviewClean: false, findings: [F1, F2], deferred: [D1], baseRefName: 'dev' });
  const frozen = structuredClone(trusted);
  const scope = scopeOf(trusted);
  assert.equal(scope.mode, 'full');
  assert.deepEqual(scope.previousFindings, [F1, F2, D1], '顺序:findings 后 deferred,原样');
  assert.deepEqual(trusted, frozen, '不改输入');
  assert.deepEqual(scopeOf(null).previousFindings, []);
  assert.deepEqual(scopeOf(previous({ reportComplete: false, findings: [F1] })).previousFindings, []);
  assert.deepEqual(scopeOf(previous({ outcome: 'error', findings: [F1] })).previousFindings, []);
  assert.deepEqual(scopeOf(previous({ reviewed: false, findings: [F1] })).previousFindings, []);
});

test('SC2:全量携带后收敛模块按 legacy-N 与 key 续数轮次', () => {
  const scope = scopeOf(previous({ reviewClean: false, findings: [{ path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 旧问题' }], baseRefName: 'dev' }));
  assert.equal(scope.mode, 'full');
  const out = applyConvergence({ findings: [{ path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 旧问题', title: '旧问题', supersedes: 'legacy-1' }],
    scope, roundIndex: 2, previousRound: null, head: 'h1' });
  assert.equal(out.findings[0].seenRounds, 2);
});

test('沿用时的锚点:head 与 diff 都相同保留行号,否则转文件级', () => {
  const same = reanchorReusedFindings([F1], { previousHead: 'h1', previousDiffHash: 'd1', head: 'h1', diffHash: 'd1' });
  assert.deepEqual(same, [F1]);
  for (const over of [{ head: 'h2' }, { diffHash: 'd2' }, { previousDiffHash: undefined }, { previousHead: undefined }]) {
    const frozen = structuredClone(F1);
    const out = reanchorReusedFindings([{ ...F1, position: 3, start_line: 9, start_side: 'RIGHT' }], { previousHead: 'h1', previousDiffHash: 'd1', head: 'h1', diffHash: 'd1', ...over });
    assert.equal(out[0].subject_type, 'file');
    for (const k of ['line', 'side', 'position', 'start_line', 'start_side']) assert.equal(k in out[0], false, k);
    assert.equal(out[0].key, F1.key);
    assert.equal(out[0].seenRounds, 2);
    assert.deepEqual(F1, frozen);
  }
});

test('SC5:specChange 配置读取,坏值一律 false 且带 warning(不回显原文)', () => {
  const load = (text) => { let n = 0; const r = loadSpecChangePolicy(() => { n += 1; if (text instanceof Error) throw text; return text; }); assert.equal(n, 1); return r; };
  assert.deepEqual(load('{"specChange":{"forceFull":true}}'), { forceFull: true, warning: null });
  assert.deepEqual(load('{"specChange":{"forceFull":false}}'), { forceFull: false, warning: null });
  assert.deepEqual(load('{"verify":{}}'), { forceFull: false, warning: null }, '旧配置没有 specChange 块');
  assert.deepEqual(load('{"specChange":{}}'), { forceFull: false, warning: null });
  for (const text of ['{"specChange":{"forceFull":"true"}}', '{"specChange":{"forceFull":1}}', '{"specChange":{"forceFull":null}}', '{"specChange":true}', '{"specChange":null}', '{"specChange":[]}']) {
    const r = load(text);
    assert.equal(r.forceFull, false, text);
    assert.match(r.warning, /specChange\.forceFull 配置不合法，按 false 处理/);
  }
  for (const text of ['{oops SECRET-TOKEN', '[]', 'null', '42', new Error('ENOENT /secret/path')]) {
    const r = load(text);
    assert.equal(r.forceFull, false);
    assert.match(r.warning, /读不到或不合法，specChange\.forceFull 按 false 处理/);
    assert.doesNotMatch(r.warning, /SECRET|ENOENT|secret/);
  }
});
