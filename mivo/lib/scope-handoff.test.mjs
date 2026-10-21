// review.md 对审查范围的影响:只扩不缩、受牵连的 R 重核、其余沿用;所有提前返回口都要过装饰。
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiffByFile, filePatchHashes, computeReviewScope, previousFromResult, buildHandoffPlan, withHandoffScope } from './scope.mjs';
import { toHandoffSnapshot, checkPreviousHandoffCoverage, normalizeHandoffCoverage } from './handoff.mjs';

const diffOf = (...paths) => paths.map((p) => ['diff --git a/' + p + ' b/' + p, 'index 111..222 100644', '--- a/' + p, '+++ b/' + p, '@@ -1,1 +1,2 @@', ' keep', '+added ' + p].join('\n')).join('\n');
const hashesOf = (...paths) => filePatchHashes(splitDiffByFile(diffOf(...paths)));
const NOW = Date.parse('2026-10-11T12:00:00Z');
const H = (n) => String(n).repeat(64).slice(0, 64);
const state = (n) => ({ oid: String(n).repeat(40).slice(0, 40), mode: '100644' });

const risk = (id, files, hash = H(id.length + files.length), over = {}) => ({ id, contentHash: hash, files, locations: [], complete: files.length > 0, ambiguous: false, ...over });
const review = (risks, states = {}) => {
  const files = [...new Set(risks.flatMap((r) => r.files))];
  return { version: 1, status: 'parsed', source: null, changeMap: [], risks, files, fileStates: Object.fromEntries(files.map((p) => [p, states[p] ?? state(1)])), warnings: [] };
};

const current = (over = {}) => ({
  head: 'h1', baseRefName: 'main', diffHash: 'd1', filePatchHashes: hashesOf('src/a.ts'), fileChangedLines: { 'src/a.ts': 1 }, totalDiffLines: 1,
  tier: 'standard', triggerKinds: [], specDigest: 'spec', now: NOW, verifiedDeferralIssues: [], ...over,
});
const goodMeta = (r, over = {}) => ({ contentHash: r.contentHash, evidenceValid: true, reused: false, sourceHead: 'h0', sourceRunId: '1', evidenceFileStates: { 'src/r.ts': state(1) }, ...over });
const previousOf = (rev, over = {}) => ({
  head: 'h0', baseRefName: 'main', diffHash: 'd0', reviewed: true, reportComplete: true, outcome: 'findings', reviewClean: true,
  findings: [], deferred: [], filePatchHashes: hashesOf('src/a.ts'), totalDiffLines: 1, tier: 'standard', triggerKinds: [],
  specDigest: 'spec', lastFullReviewAt: '2026-10-10T12:00:00Z',
  handoffReview: toHandoffSnapshot(rev),
  handoffCoverage: rev.risks.map((r) => ({ id: r.id, verdict: '成立', evidence: [{ path: 'src/r.ts', line: 3 }], note: 'ok' })),
  handoffCoverageMeta: Object.fromEntries(rev.risks.map((r) => [r.id, goodMeta(r)])), ...over,
});
// 上一轮有未修的问题 → 不是「已干净」,本轮改动走增量而不是直接全量
const INCR = { reviewClean: false, totalDiffLines: 10, findings: [{ path: 'src/a.ts', line: 1, body: '[P1] 旧问题', key: 'aaaaaaaaaaaa' }] };
const okCheck = (rev) => Object.fromEntries(rev.risks.map((r) => [r.id, { valid: true, unchanged: true }]));
const scopeOf = (prev, cur) => computeReviewScope({ previous: prev, current: cur, headIsDescendant: true });

test('SC2 无交接/解析失败:范围与改动前完全一致(无 handoffPlan)', () => {
  const rev = review([risk('R1', ['src/r.ts'])]);
  const prev = previousOf(rev, { filePatchHashes: hashesOf('src/a.ts'), diffHash: 'd1', head: 'h1' });
  for (const handoffReview of [undefined, null, { status: 'invalid' }, { status: 'missing' }]) {
    const s = scopeOf(prev, current({ handoffReview }));
    assert.equal(s.handoffPlan, undefined);
  }
});

test('SC3 增量:R 涉及文件本轮改了 → 该 R 的全部文件并进范围,原范围一个不少', () => {
  const rev = review([risk('R1', ['src/a.ts', 'src/r.ts']), risk('R2', ['src/other.ts'])]);
  const prev = previousOf(rev, { ...INCR, filePatchHashes: { 'src/a.ts': 'old', 'src/b.ts': 'same' }, handoffCoverageMeta: { R1: goodMeta(rev.risks[0]), R2: goodMeta(rev.risks[1], { evidenceFileStates: { 'src/r.ts': state(1) } }) } });
  const cur = current({ filePatchHashes: { 'src/a.ts': 'new', 'src/b.ts': 'same' }, handoffReview: rev, handoffEvidenceCheck: okCheck(rev) });
  const s = scopeOf(prev, cur);
  assert.equal(s.mode, 'incremental');
  assert.deepEqual(s.files, ['src/a.ts', 'src/r.ts']);
  assert.deepEqual(s.changedFiles, ['src/a.ts']);
  const byId = Object.fromEntries(s.handoffPlan.map((i) => [i.id, i]));
  assert.equal(byId.R1.action, 'recheck');
  assert.match(byId.R1.reason, /src\/a\.ts/);
  assert.equal(byId.R2.action, 'reuse');
  assert.equal(byId.R2.previousCoverage.verdict, '成立');
});

test('SC3 增量:R 内容哈希变了 → 重核并带入文件;diff 外文件的 blob 变了也算', () => {
  const before = review([risk('R1', ['src/r.ts'], H(1)), risk('R2', ['src/q.ts'], H(2))]);
  const after = review([risk('R1', ['src/r.ts'], H(9)), risk('R2', ['src/q.ts'], H(2))], { 'src/q.ts': state(7) });
  const prev = previousOf(before, { ...INCR, filePatchHashes: { 'src/a.ts': 'old' } });
  const cur = current({ filePatchHashes: { 'src/a.ts': 'new' }, handoffReview: after, handoffEvidenceCheck: okCheck(after) });
  const s = scopeOf(prev, cur);
  assert.deepEqual(s.handoffPlan.map((i) => [i.id, i.action]), [['R1', 'recheck'], ['R2', 'recheck']]);
  assert.deepEqual(s.files, ['src/a.ts', 'src/q.ts', 'src/r.ts']);
  assert.match(s.handoffPlan[0].reason, /内容变了/);
  assert.match(s.handoffPlan[1].reason, /head 上变了/);
});

test('SC3 沿用的条件缺一不可:无路径、上次非成立、证据失效、meta 哈希错配、不可信上一轮', () => {
  const rev = review([risk('R1', ['src/r.ts']), risk('R2', []), risk('R3', ['src/r3.ts']), risk('R4', ['src/r4.ts']), risk('R5', ['src/r5.ts'])]);
  const prev = previousOf(rev);
  prev.handoffCoverage[2] = { ...prev.handoffCoverage[2], verdict: '不成立' };
  prev.handoffCoverageMeta.R4 = goodMeta(rev.risks[3], { contentHash: H(0) });
  const check = { ...okCheck(rev), R5: { valid: true, unchanged: false } };
  const run = (p) => buildHandoffPlan({ review: rev, previous: p, evidenceCheck: check }).items.map((i) => i.action);
  assert.deepEqual(run(prev), ['reuse', 'recheck', 'recheck', 'recheck', 'recheck']);
  assert.deepEqual(run({ ...prev, reportComplete: false }), ['recheck', 'recheck', 'recheck', 'recheck', 'recheck']);
  assert.equal(buildHandoffPlan({ review: rev, previous: prev, evidenceCheck: {} }).items[0].action, 'recheck');
});

test('SC3 空路径集合不能证明未受影响;旧包没有交接字段 → 保守重核,不触发集中重审', () => {
  const rev = review([risk('R1', [])]);
  const legacy = { head: 'h0', baseRefName: 'main', diffHash: 'd1', reviewed: true, reportComplete: true, outcome: 'findings', reviewClean: true, findings: [], deferred: [],
    filePatchHashes: hashesOf('src/a.ts'), totalDiffLines: 1, tier: 'standard', triggerKinds: [], specDigest: 'spec', lastFullReviewAt: '2026-10-10T12:00:00Z' };
  // 代码没变、旧包无快照:整轮沿用(不开模型),交接标 deferred
  const s = scopeOf(legacy, current({ handoffReview: rev }));
  assert.equal(s.mode, 'reuse');
  assert.equal(s.handoffPlan[0].action, 'deferred');
  assert.match(s.handoffPlan[0].reason, /未新核实/);
  const p = previousFromResult({ head: 'h0', mivo: {} });
  assert.equal(p.handoffReview, null);
  assert.deepEqual(p.handoffCoverage, []);
});

test('SC3 基础范围 reuse:交接风险有实质变化 → 升为单次全量,旧问题 outOfDiff 重算', () => {
  const before = review([risk('R1', ['src/r.ts'], H(1))]);
  const after = review([risk('R1', ['src/r.ts'], H(2))]);
  const prev = previousOf(before, { head: 'h1', diffHash: 'd1', findings: [{ path: 'src/a.ts', body: '[P1] x', key: 'aaaaaaaaaaaa' }, { path: 'src/gone.ts', body: '[P2] y', outOfDiff: false }], reviewClean: false });
  const s = scopeOf(prev, current({ handoffReview: after, handoffEvidenceCheck: okCheck(after) }));
  // 有旧问题 → 基础范围本来就不是 reuse;换成干净的旧包验证升级
  assert.notEqual(s.mode, 'reuse');
  const clean = previousOf(before, { head: 'h1', diffHash: 'd1' });
  const up = scopeOf(clean, current({ handoffReview: after, handoffEvidenceCheck: okCheck(after) }));
  assert.equal(up.mode, 'full');
  assert.match(up.reason, /交接风险发生实质变化.*R1/);
  assert.equal(up.handoffPlan[0].action, 'recheck');
  const same = scopeOf(clean, current({ handoffReview: before, handoffEvidenceCheck: okCheck(before) }));
  assert.equal(same.mode, 'reuse');
  assert.equal(same.handoffPlan[0].action, 'reuse');
});

test('SC4 全量与收口:逐条 R 全部重核,范围不变,附加路径池单独给出', () => {
  const rev = review([risk('R1', ['src/r.ts'])]);
  const s = computeReviewScope({ previous: null, current: current({ handoffReview: rev }), headIsDescendant: null });
  assert.equal(s.mode, 'full');
  assert.deepEqual(s.files, ['src/a.ts']);
  assert.deepEqual(s.handoffFiles, ['src/r.ts']);
  assert.equal(s.handoffPlan[0].action, 'recheck');
});

test('SC5 previousFromResult 读回跨轮字段;畸形字段当没有', () => {
  const rev = review([risk('R1', ['src/r.ts'])]);
  const result = { head: 'h0', mivo: { handoffReview: toHandoffSnapshot(rev), handoffCoverage: [{ id: 'R1', verdict: '成立' }], handoffCoverageMeta: { R1: { evidenceValid: true } }, handoffStats: { version: 1 } } };
  const p = previousFromResult(result);
  assert.equal(p.handoffReview.risks[0].id, 'R1');
  assert.equal(p.handoffCoverage[0].verdict, '成立');
  assert.deepEqual(p.handoffStats, { version: 1 });
  const bad = previousFromResult({ head: 'h0', mivo: { handoffReview: { version: 2 }, handoffCoverage: 'x', handoffCoverageMeta: [], handoffStats: 5 } });
  assert.equal(bad.handoffReview, null);
  assert.deepEqual(bad.handoffCoverage, []);
  assert.deepEqual(bad.handoffCoverageMeta, {});
  assert.equal(bad.handoffStats, null);
});

test('SC5 两轮往返:上一轮「成立」+ 未受牵连 → 沿用旧条目与旧来源;受牵连或答卷改口 → 本轮新核', () => {
  const rev = review([risk('R1', ['src/r.ts']), risk('R2', ['src/q.ts'])]);
  const reader = () => ({ exists: true, regularFile: true, lineCount: 10, oid: state(1).oid, mode: '100644' });
  const plan = buildHandoffPlan({ review: rev, previous: previousOf(rev), evidenceCheck: okCheck(rev) }).items;
  assert.deepEqual(plan.map((i) => i.action), ['reuse', 'reuse']);
  const out = normalizeHandoffCoverage({ raw: [{ id: 'R2', verdict: '不成立', evidence: [{ path: 'src/r.ts', line: 2 }], note: '改口' }], review: rev, plan, headReader: reader, source: { head: 'h1', runId: '2' } });
  assert.equal(out.meta.R1.reused, true);
  assert.equal(out.meta.R1.sourceHead, 'h0');
  assert.equal(out.coverage[0].verdict, '成立');
  assert.equal(out.meta.R2.reused, false);
  assert.equal(out.meta.R2.sourceHead, 'h1');
  assert.equal(out.coverage[1].verdict, '不成立');
});

test('SC5 coverage 校验:缺项补未核实、未知/重复/非法 verdict、证据无效只 warning', () => {
  const rev = review([risk('R1', ['src/r.ts']), risk('R2', ['src/q.ts']), risk('R3', ['src/s.ts'])]);
  const reader = (path) => (path === 'src/empty.ts' ? { exists: true, regularFile: true, lineCount: 0 } : path === 'src/link.ts' ? { exists: true, regularFile: false, lineCount: 3 }
    : path === 'src/r.ts' ? { exists: true, regularFile: true, lineCount: 5, oid: state(1).oid, mode: '100644' } : { exists: false, lineCount: 0 });
  const raw = [
    { id: 'R1', verdict: '成立', evidence: [{ path: 'src/r.ts', line: 5 }], note: 'ok' },
    { id: 'R1', verdict: '不成立', evidence: [], note: '重复' },
    { id: 'R9', verdict: '成立', evidence: [], note: '未知' },
    { id: 'R2', verdict: '也许', evidence: [], note: 'x' },
  ];
  const out = normalizeHandoffCoverage({ raw, review: rev, plan: [], headReader: reader, source: { head: 'h', runId: '1' } });
  assert.deepEqual(out.coverage.map((c) => [c.id, c.verdict]), [['R1', '未核实'], ['R2', '未核实'], ['R3', '未核实']]);
  assert.ok(out.warnings.some((w) => /R9/.test(w)) && out.warnings.some((w) => /重复/.test(w)));
  const one = (evidence) => normalizeHandoffCoverage({ raw: [{ id: 'R1', verdict: '成立', evidence, note: '' }], review: review([risk('R1', ['src/r.ts'])]), plan: [], headReader: reader, source: {} });
  assert.equal(one([{ path: 'src/r.ts', line: 5 }]).meta.R1.evidenceValid, true);
  for (const bad of [[{ path: 'src/r.ts', line: 6 }], [{ path: 'src/r.ts', line: 0 }], [{ path: 'src/r.ts', line: null }], [{ path: 'src/empty.ts', line: 1 }], [{ path: 'src/link.ts', line: 1 }], [{ path: 'src/none.ts', line: 1 }], []]) {
    const r = one(bad);
    assert.equal(r.meta.R1.evidenceValid, false);
    assert.equal(r.coverage[0].verdict, '成立'); // 保留声明,但不可复用
  }
  const noArray = normalizeHandoffCoverage({ raw: undefined, review: rev, plan: [], headReader: reader, source: {} });
  assert.equal(noArray.coverage.length, 3);
  assert.ok(noArray.warnings[0].includes('缺 handoffCoverage'));
});

test('SC5 checkPreviousHandoffCoverage:证据位置失效或文件身份变了 → 不能沿用', () => {
  const coverage = [{ id: 'R1', verdict: '成立', evidence: [{ path: 'src/r.ts', line: 3 }] }];
  const meta = { R1: { evidenceFileStates: { 'src/r.ts': state(1) } } };
  const reader = (over = {}) => () => ({ exists: true, regularFile: true, lineCount: 10, oid: state(1).oid, mode: '100644', ...over });
  assert.deepEqual(checkPreviousHandoffCoverage({ coverage, meta, headReader: reader() }), { R1: { valid: true, unchanged: true } });
  assert.deepEqual(checkPreviousHandoffCoverage({ coverage, meta, headReader: reader({ oid: state(2).oid }) }).R1, { valid: true, unchanged: false });
  assert.deepEqual(checkPreviousHandoffCoverage({ coverage, meta, headReader: reader({ lineCount: 2 }) }).R1, { valid: false, unchanged: false });
  assert.deepEqual(checkPreviousHandoffCoverage({ coverage, meta: {}, headReader: reader() }).R1, { valid: false, unchanged: false });
});

// ── 缺上一轮快照 / 歧义 R 的保守处理:无法证明 R 变化,不清豁免、不升全量(只扩不缩) ──
const exemptScope = () => ({ mode: 'incremental', reason: '增量', files: ['src/a.ts'], changedFiles: ['src/a.ts'], previousFindings: [], basedOn: 'h0',
  finalFullExemption: { sourceHead: 'h0', sourceRunId: '1', issueFiles: ['src/a.ts'], changedFiles: ['src/a.ts'] } });
const legacyPrevious = (over = {}) => ({ head: 'h0', baseRefName: 'main', diffHash: 'd1', reviewed: true, reportComplete: true, outcome: 'findings', reviewClean: true, findings: [], deferred: [],
  filePatchHashes: hashesOf('src/a.ts'), totalDiffLines: 1, tier: 'standard', triggerKinds: [], specDigest: 'spec', lastFullReviewAt: '2026-10-10T12:00:00Z', ...over });

test('防拉锯豁免:上一轮没有交接快照(旧结果包)→ 无法证明文件身份变了,保留豁免,R 文件照样并进范围', () => {
  const rev = review([risk('R1', ['src/r.ts'])]);
  const s = withHandoffScope({ scope: exemptScope(), previous: legacyPrevious(), current: current({ handoffReview: rev, handoffEvidenceCheck: okCheck(rev) }) });
  assert.ok(s.finalFullExemption, '旧包无快照不是身份变化');
  assert.deepEqual(s.files, ['src/a.ts', 'src/r.ts']);
  assert.equal(s.handoffPlan[0].action, 'recheck');
});

test('防拉锯豁免:上一轮有快照且引用文件 blob 变了(又不在问题文件/改动文件里)→ 取消豁免', () => {
  const before = review([risk('R1', ['src/r.ts'], H(1))], { 'src/r.ts': state(1) });
  const after = review([risk('R1', ['src/r.ts'], H(1))], { 'src/r.ts': state(7) });
  const prev = previousOf(before, legacyPrevious());
  const s = withHandoffScope({ scope: exemptScope(), previous: prev, current: current({ handoffReview: after, handoffEvidenceCheck: okCheck(after) }) });
  assert.equal(s.finalFullExemption, undefined);
  assert.deepEqual(s.files, ['src/a.ts', 'src/r.ts']);
  // 对照:blob 没变 → 保留
  const kept = withHandoffScope({ scope: exemptScope(), previous: prev, current: current({ handoffReview: before, handoffEvidenceCheck: okCheck(before) }) });
  assert.ok(kept.finalFullExemption);
});

test('歧义 R:上一轮没有快照 → 不算实质变化,不升全量;沿用既有审查结果,这条交接标 deferred', () => {
  const rev = review([risk('R1', ['src/r.ts'], H(1), { ambiguous: true, complete: false })]);
  const s = scopeOf(legacyPrevious({ diffHash: 'd1', head: 'h1' }), current({ handoffReview: rev, handoffEvidenceCheck: okCheck(rev) }));
  assert.equal(s.mode, 'reuse');
  assert.equal(s.handoffPlan[0].action, 'deferred');
  assert.deepEqual(buildHandoffPlan({ review: rev, previous: legacyPrevious() }).substantive, []);
});

test('歧义 R:歧义本身没变(两轮都歧义,哈希/文件/blob 相同)→ 不升全量,但不沿用,点名重核', () => {
  const rev = review([risk('R1', ['src/r.ts'], H(1), { ambiguous: true, complete: false })]);
  const prev = previousOf(rev, { head: 'h1', diffHash: 'd1' });
  const s = scopeOf(prev, current({ handoffReview: rev, handoffEvidenceCheck: okCheck(rev) }));
  assert.equal(s.mode, 'reuse');
  const plan = buildHandoffPlan({ review: rev, previous: prev, evidenceCheck: okCheck(rev) });
  assert.deepEqual(plan.substantive, []);
  assert.equal(plan.items[0].action, 'recheck');
  assert.match(plan.items[0].reason, /歧义/);
});

test('歧义 R:歧义相对上一轮快照出现或消失 → 仍是实质变化,升全量', () => {
  const plain = review([risk('R1', ['src/r.ts'], H(1))]);
  const dup = review([risk('R1', ['src/r.ts'], H(1), { ambiguous: true, complete: false })]);
  const appear = buildHandoffPlan({ review: dup, previous: previousOf(plain), evidenceCheck: okCheck(dup) });
  assert.deepEqual(appear.substantive, ['R1']);
  const vanish = buildHandoffPlan({ review: plain, previous: previousOf(dup), evidenceCheck: okCheck(plain) });
  assert.deepEqual(vanish.substantive, ['R1']);
  const up = scopeOf(previousOf(plain, { head: 'h1', diffHash: 'd1' }), current({ handoffReview: dup, handoffEvidenceCheck: okCheck(dup) }));
  assert.equal(up.mode, 'full');
});
