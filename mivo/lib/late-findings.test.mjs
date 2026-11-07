// #221 后来发现:第 2 轮起落在上一轮审过、本轮没改动的文件上的新 P2 不阻断,单列一节;P0/P1、改过的文件、接续旧问题、第一轮照常阻断。
// 夹具用真实 diff 算补丁指纹(splitDiffByFile),上一轮/本轮各一份,经 unchangedReviewedFiles 得到未改动文件,再交给发布阶段分桶函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiffByFile, filePatchHashes, filePatchHashesV2, unchangedReviewedFiles } from './scope.mjs';
import { splitLateFindings, loadLateFindingsMode, renderLateSection, finalizeReport, LATE_SECTION } from './report.mjs';

const fileDiff = (path, added) => [`diff --git a/${path} b/${path}`, 'index 1..2 100644', `--- a/${path}`, `+++ b/${path}`, '@@ -1,1 +1,2 @@', ' keep', `+${added}`];
const hashesOf = (diff) => { const files = splitDiffByFile(diff.join('\n')); return { filePatchHashes: filePatchHashes(files), filePatchHashesV2: filePatchHashesV2(files) }; };

// 上一轮:a.ts、b.ts 都审过;本轮:a.ts 没动,b.ts 补丁变了,c.ts 是新加的文件。
const PREVIOUS = { reviewed: true, reportComplete: true, outcome: 'changes-requested', ...hashesOf([...fileDiff('src/a.ts', 'one'), ...fileDiff('src/b.ts', 'two')]) };
const CURRENT = hashesOf([...fileDiff('src/a.ts', 'one'), ...fileDiff('src/b.ts', 'two changed'), ...fileDiff('src/c.ts', 'three')]);

const finding = (over = {}) => ({ severity: 'P2', title: '边界没处理', path: 'src/a.ts', line: 2, origin: 'introduced', supersedes: null, deferredTo: null,
  seenRounds: 1, instances: [], key: 'aaaaaaaaaaaa', ...over });
const split = (findings, { previous = PREVIOUS, mode = 'enforce' } = {}) =>
  splitLateFindings({ findings, unchangedFiles: unchangedReviewedFiles({ previous, current: CURRENT }), mode });

test('unchangedReviewedFiles:只列上一轮审过、本轮指纹相同的文件;没有可信上一轮返回 null', () => {
  assert.deepEqual(unchangedReviewedFiles({ previous: PREVIOUS, current: CURRENT }), ['src/a.ts']);
  // 只有 v1 的旧结果包按 v1 比
  assert.deepEqual(unchangedReviewedFiles({ previous: { ...PREVIOUS, filePatchHashesV2: null }, current: CURRENT }), ['src/a.ts']);
  assert.equal(unchangedReviewedFiles({ previous: null, current: CURRENT }), null);
  assert.equal(unchangedReviewedFiles({ previous: { ...PREVIOUS, reportComplete: false }, current: CURRENT }), null);
  assert.equal(unchangedReviewedFiles({ previous: { ...PREVIOUS, outcome: 'error' }, current: CURRENT }), null);
});

test('SC2:有上一轮可信结果,新 P2 所在文件指纹没变 → 进后来发现,不计入阻断', () => {
  const p2 = finding();
  const out = split([p2]);
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.late, [p2]);
});

test('SC3:P0、P1 照常阻断', () => {
  const p0 = finding({ severity: 'P0' });
  const p1 = finding({ severity: 'P1' });
  assert.deepEqual(split([p0, p1]), { findings: [p0, p1], late: [] });
});

test('SC3:文件补丁指纹变了的 P2、新加文件上的 P2 照常阻断', () => {
  const changed = finding({ path: 'src/b.ts' });
  const added = finding({ path: 'src/c.ts' });
  assert.deepEqual(split([changed, added]), { findings: [changed, added], late: [] });
});

test('SC3:supersedes 指向上一轮问题的 P2 照常阻断', () => {
  const p2 = finding({ supersedes: 'bbbbbbbbbbbb' });
  assert.deepEqual(split([p2]), { findings: [p2], late: [] });
});

test('SC3:没有上一轮结果(第一轮)的 P2 照常阻断', () => {
  const p2 = finding();
  assert.deepEqual(split([p2], { previous: null }), { findings: [p2], late: [] });
});

test('其余照常阻断的 P2:上一轮已阻断的同一问题(连续报出)、同类位置落在改过的文件、转 issue、PR 之前就存在', () => {
  const repeat = finding({ seenRounds: 2 });
  const spread = finding({ instances: [{ path: 'src/b.ts', line: 2 }] });
  const deferred = finding({ deferredTo: 12 });
  const pre = finding({ origin: 'pre-existing' });
  assert.deepEqual(split([repeat, spread, deferred, pre]), { findings: [repeat, spread, deferred, pre], late: [] });
  // 同类位置也都在没改的文件里:照样进后来发现
  const sameFile = finding({ instances: [{ path: 'src/a.ts', line: 1 }] });
  assert.deepEqual(split([sameFile]).late, [sameFile]);
});

test('SC4:lateFindings.mode 为 off 时分桶与阻断结果和改动前一致', () => {
  const list = [finding(), finding({ severity: 'P1' }), finding({ path: 'src/b.ts' })];
  const out = split(list, { mode: 'off' });
  assert.deepEqual(out, { findings: list, late: [] });
  assert.notEqual(out.findings, list, '返回新数组,不改输入');
  const report = ['## Findings', '无', '## Rule coverage', 'x', '## Verification', 'y', '## Overall', 'pass'].join('\n');
  const args = { report, findings: [], pr: 7, url: 'u', head: 'h'.repeat(40), base: 'b'.repeat(40), diffHash: 'd', tier: 'standard', scope: { mode: 'full', reason: 'r' } };
  assert.equal(finalizeReport({ ...args, late: out.late }), finalizeReport(args));
});

test('开关读取:缺块 off 不告警;enforce/off 照读;不合法或读不到按 off 并告警', () => {
  const read = (text) => () => text;
  assert.deepEqual(loadLateFindingsMode('f', read('{}')), { mode: 'off', warning: null });
  assert.deepEqual(loadLateFindingsMode('f', read('{"lateFindings":{"mode":"enforce"}}')), { mode: 'enforce', warning: null });
  assert.deepEqual(loadLateFindingsMode('f', read('{"lateFindings":{"mode":"off"}}')), { mode: 'off', warning: null });
  assert.equal(loadLateFindingsMode('f', read('{"lateFindings":{"mode":"observe"}}')).mode, 'off');
  assert.match(loadLateFindingsMode('f', read('{"lateFindings":{"mode":"observe"}}')).warning, /lateFindings\.mode 不合法/);
  assert.match(loadLateFindingsMode('f', read('not json')).warning, /读不到或不合法/);
  assert.equal(loadLateFindingsMode('f', () => { throw new Error('ENOENT'); }).mode, 'off');
});

test('仓库开关文件把 lateFindings.mode 设为 enforce', () => {
  assert.deepEqual(loadLateFindingsMode(new URL('../config/review-features.json', import.meta.url)), { mode: 'enforce', warning: null });
});

test('SC2:报告单列「后来发现」一节,结论是 pass 并写明条数', () => {
  const late = [finding({ title: '后来才看到的问题' })];
  assert.deepEqual(renderLateSection([]), []);
  const report = ['## Findings', '无', '## Rule coverage', 'x', '## Verification', 'y', '## Overall', 'changes-requested'].join('\n');
  const text = finalizeReport({ report, findings: [], late, pr: 7, url: 'u', head: 'h'.repeat(40), base: 'b'.repeat(40), diffHash: 'd', tier: 'standard', scope: { mode: 'full', reason: 'r' } });
  assert.ok(text.includes(LATE_SECTION));
  assert.ok(text.indexOf(LATE_SECTION) < text.indexOf('## Rule coverage'), '单列一节在 Rule coverage 前');
  assert.match(text, /- `src\/a\.ts:2` · \[P2\] 后来才看到的问题/);
  assert.match(text, /^pass —— 没有阻断的 P0\/P1\/P2。另有 1 条后来发现的 P2(.*)，不阻断本 PR。$/m);
  assert.doesNotMatch(text, /^changes-requested/m);
});
