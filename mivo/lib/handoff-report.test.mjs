// 答卷 handoffCoverage / finding.handoffRiskIds 的校验、"交接之外的发现"统计与服务端报告小节。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_SCHEMA, validateAnswer, computeHandoffStats, renderHandoffCoverageSection, finalizeReport, HANDOFF_SECTION } from './report.mjs';
import { FINDING_ITEM_SCHEMA, readHandoffRiskIds } from './finding.mjs';
import { splitDiffByFile } from './scope.mjs';

const diff = ['diff --git a/src/a.ts b/src/a.ts', 'index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' keep', '+added', ' tail'].join('\n');
const diffFiles = splitDiffByFile(diff);
const st = { oid: 'a'.repeat(40), mode: '100644' };
const review = { version: 1, status: 'parsed', changeMap: [], files: ['src/r.ts'], fileStates: { 'src/r.ts': st },
  risks: ['R1', 'R2'].map((id, i) => ({ id, title: id, fields: {}, contentHash: String(i).repeat(64), files: ['src/r.ts'], locations: [], complete: true, ambiguous: false })), warnings: [] };
const headReader = (path) => (path === 'src/r.ts' ? { exists: true, regularFile: true, lineCount: 20, ...st } : path === 'src/a.ts' ? { exists: true, regularFile: true, lineCount: 3, oid: 'b'.repeat(40), mode: '100644' } : { exists: false, lineCount: 0 });
const REPORT = '## Findings\n\n无\n\n## Rule coverage\n\n读了规则。\n\n### 作者交接核对\n\n- R1 · 成立 · 模型自己写的\n交接之外的发现:99 条\n\n### 改动地图核对\n\n- M1 保持\n\n## Verification\n\n无\n\n## Overall\n\npass —— 没有 P0/P1/P2。\n';
const finding = (over = {}) => ({ severity: 'P1', title: 't', trigger: 'x', behavior: 'y', impact: 'z', fix: 'f', verify: 'v', evidence: [{ path: 'src/a.ts', line: 2 }],
  origin: 'introduced', bugClass: 'c', instances: [], supersedes: null, path: 'src/a.ts', line: 2, side: 'RIGHT', deferredTo: null, ...over });
const answer = (over = {}) => ({ report: REPORT, findings: [], handoffCoverage: [], ...over });
const handoff = { review, plan: [], headReader, source: { head: 'h1', runId: '9' } };

test('SC5 schema:handoffCoverage 与 handoffRiskIds 必填,且只用已核实支持的关键字', () => {
  assert.ok(ANSWER_SCHEMA.required.includes('handoffCoverage'));
  assert.deepEqual(ANSWER_SCHEMA.properties.handoffCoverage.items.properties.verdict.enum, ['成立', '不成立', '未核实']);
  assert.equal(ANSWER_SCHEMA.properties.handoffCoverage.items.additionalProperties, false);
  assert.ok(FINDING_ITEM_SCHEMA.required.includes('handoffRiskIds'));
  const text = JSON.stringify(ANSWER_SCHEMA);
  assert.ok(!/maxLength|minItems|maxItems|minLength/.test(text));
});

test('SC5 validateAnswer:旧答卷(没有 handoffCoverage)照常通过;交接 off 时不产出 coverage', () => {
  const legacy = { report: REPORT, findings: [] };
  const off = validateAnswer(legacy, { diffFiles });
  assert.equal(off.ok, true);
  assert.deepEqual(off.handoffCoverage, []);
  const on = validateAnswer(legacy, { diffFiles, handoff });
  assert.equal(on.ok, true);
  assert.deepEqual(on.handoffCoverage.map((c) => c.verdict), ['未核实', '未核实']);
  assert.ok(on.notes.some((n) => /缺 handoffCoverage/.test(n)));
});

test('SC5 validateAnswer:有效 coverage 带 meta;证据无效只出 note,不改变 ok 与阻断', () => {
  const out = validateAnswer(answer({ handoffCoverage: [
    { id: 'R1', verdict: '成立', evidence: [{ path: 'src/r.ts', line: 5 }], note: '确实' },
    { id: 'R2', verdict: '成立', evidence: [{ path: 'src/forged.ts', line: 1 }], note: '伪造' }] }), { diffFiles, handoff });
  assert.equal(out.ok, true);
  assert.equal(out.handoffCoverageMeta.R1.evidenceValid, true);
  assert.equal(out.handoffCoverageMeta.R2.evidenceValid, false);
  assert.equal(out.handoffCoverageMeta.R1.sourceHead, 'h1');
  assert.ok(out.notes.some((n) => /R2 的证据没有通过检查/.test(n)));
  assert.equal(out.findings.length, 0);
});

test('SC6 handoffRiskIds:合法保留去重、未知编号剔除并计不完整、缺字段计不完整;不影响严重度与阻断', () => {
  const out = validateAnswer(answer({ findings: [
    finding({ handoffRiskIds: ['R1', 'R1'] }),
    finding({ title: 'u', handoffRiskIds: ['R1', 'R7'], path: 'src/a.ts' }),
    finding({ title: 'w', handoffRiskIds: [] }),
    (() => { const f = finding({ title: 'v' }); delete f.handoffRiskIds; return f; })()] }), { diffFiles, handoff });
  assert.equal(out.findings.length, 4);
  assert.deepEqual(out.findings.map((f) => f.handoffRiskIds), [['R1'], ['R1'], [], []]);
  assert.deepEqual(out.findings.map((f) => f.handoffMappingComplete), [true, false, true, false]);
  assert.ok(out.findings.every((f) => f.severity === 'P1'));
  assert.deepEqual(readHandoffRiskIds(['R1', 5], new Set(['R1'])), { ids: ['R1'], complete: false });
});

test('SC6 统计:blocking = associated + outside;只数最终阻断集,deferred/preexisting 不在内', () => {
  const coverage = [{ id: 'R1', verdict: '成立' }, { id: 'R2', verdict: '不成立' }, { id: 'R3', verdict: '未核实' }];
  const meta = { R1: { evidenceValid: true, reused: true }, R2: { evidenceValid: true, reused: false }, R3: { evidenceValid: false } };
  const rev = { ...review, risks: [...review.risks, { ...review.risks[0], id: 'R3' }] };
  const findings = [{ handoffRiskIds: ['R1', 'R2'], handoffMappingComplete: true }, { handoffRiskIds: [], handoffMappingComplete: true }, { handoffRiskIds: [], handoffMappingComplete: false }];
  const stats = computeHandoffStats({ review: rev, coverage, meta, findings, head: 'h1', runId: '9' });
  assert.deepEqual(stats, { version: 1, measuredHead: 'h1', measuredRunId: '9', reused: false, reviewAvailable: true, complete: false,
    risks: 3, coverageVerified: 2, coverageReused: 1, blocking: 3, associated: 1, outside: 2, mappingUnknown: 1 });
  assert.equal(stats.blocking, stats.associated + stats.outside);
  const zero = computeHandoffStats({ review: { ...review, risks: [] }, findings: [{ handoffRiskIds: [], handoffMappingComplete: true }] });
  assert.equal(zero.complete, true);
  assert.equal(zero.outside, 1);
  const none = computeHandoffStats({ review: { status: 'missing' }, findings: [{}, {}] });
  assert.deepEqual([none.reviewAvailable, none.complete, none.blocking], [false, false, 2]);
  assert.equal(computeHandoffStats({ review, findings: [] }).outside, 0);
});

test('SC6 报告:服务端生成唯一的「作者交接核对」与「交接之外的发现：N 条」,地图核对保留,模型自写的计数被替换', () => {
  const coverage = [{ id: 'R1', verdict: '成立', evidence: [{ path: 'src/r.ts', line: 5 }], note: '有`反引号`<!-- x -->' }, { id: 'R2', verdict: '未核实', evidence: [], note: '没跑成' }];
  const meta = { R1: { evidenceValid: true, reused: true, sourceHead: 'abcdef1234' }, R2: { evidenceValid: false } };
  const stats = { reviewAvailable: true, complete: true, outside: 2 };
  const text = finalizeReport({ report: REPORT, findings: [], pr: 77, url: 'u', head: 'h'.repeat(40), base: 'b'.repeat(40), diffHash: 'd', tier: 'standard', scope: { mode: 'full', reason: 'r' },
    handoff: { review, coverage, meta, stats } });
  assert.equal(text.split(HANDOFF_SECTION).length, 2);
  assert.equal(text.match(/交接之外的发现[:：]/g).length, 1);
  assert.match(text, /交接之外的发现：2 条/);
  assert.ok(!text.includes('99 条') && !text.includes('模型自己写的'));
  assert.match(text, /### 改动地图核对\n\n- M1 保持/);
  assert.match(text, /R1 · 成立 · 证据 `src\/r\.ts:5` · 沿用（来源 head `abcdef1`）/);
  assert.ok(!text.includes('<!--'));
  assert.ok(text.indexOf(HANDOFF_SECTION) < text.indexOf('## Verification'));
  const incomplete = renderHandoffCoverageSection({ coverage: [], meta: {}, stats: { reviewAvailable: true, complete: false, outside: 1 } }).join('\n');
  assert.match(incomplete, /关联记录不完整，不用于趋势比较/);
});

test('SC6 报告:模型写了多个「作者交接核对」小节时全部去掉,只留服务端那一节', () => {
  const twice = REPORT.replace('### 改动地图核对', '### 作者交接核对\n\n交接之外的发现:88 条\n\n### 改动地图核对');
  const text = finalizeReport({ report: twice, findings: [], pr: 77, url: 'u', head: 'h'.repeat(40), base: 'b'.repeat(40), diffHash: 'd', tier: 'standard', scope: { mode: 'full', reason: 'r' },
    handoff: { review, coverage: [], meta: {}, stats: { reviewAvailable: true, complete: true, outside: 0 } } });
  assert.equal(text.split(HANDOFF_SECTION).length, 2);
  assert.equal(text.match(/交接之外的发现[:：]/g).length, 1);
  assert.ok(!text.includes('88 条') && !text.includes('99 条'));
  assert.match(text, /### 改动地图核对\n\n- M1 保持/);
});

test('SC6 交接不可用时报告不动模型原文', () => {
  const text = finalizeReport({ report: REPORT, findings: [], pr: 77, url: 'u', head: 'h'.repeat(40), base: 'b'.repeat(40), diffHash: 'd', tier: 'standard', scope: { mode: 'full', reason: 'r' },
    handoff: { review: { status: 'missing' }, coverage: [], meta: {}, stats: null } });
  assert.match(text, /模型自己写的/);
});
