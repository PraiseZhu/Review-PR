import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiffByFile, filePatchHashes, computeReviewScope } from './scope.mjs';
import { validateAnswer, finalizeReport, scrubSecrets, REPORT_SECTIONS } from './report.mjs';

const diff = (bodyA, bodyB = '+b2') => [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ export function a() {',
  ' keep',
  bodyA,
  ' tail',
  'diff --git a/src/b.ts b/src/b.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/b.ts',
  '@@ -0,0 +1,1 @@',
  bodyB,
].join('\n');

test('按文件切 diff:指纹只看改动行,行号漂移不算变化;记录新侧行号', () => {
  const files = splitDiffByFile(diff('+added'));
  assert.deepEqual(Object.keys(files).sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal(files['src/a.ts'].changedLines, 1);
  assert.deepEqual([...files['src/a.ts'].rightLines].sort((x, y) => x - y), [10, 11, 12]);
  const shifted = splitDiffByFile(diff('+added').replace('@@ -10,3 +10,4 @@', '@@ -40,3 +40,4 @@'));
  assert.equal(shifted['src/a.ts'].hash, files['src/a.ts'].hash);
  assert.notEqual(splitDiffByFile(diff('+changed'))['src/a.ts'].hash, files['src/a.ts'].hash);
});

const files = splitDiffByFile(diff('+added'));
const current = (over = {}) => ({
  head: 'h1', baseRefName: 'main', diffHash: 'd1', filePatchHashes: filePatchHashes(files),
  fileChangedLines: { 'src/a.ts': 1, 'src/b.ts': 1 }, totalDiffLines: 2, tier: 'standard', triggerKinds: [],
  skillSha: 's', rulesDigest: 'r', now: Date.parse('2026-10-11T12:00:00Z'), ...over,
});
const previous = (over = {}) => ({
  head: 'h0', baseRefName: 'main', diffHash: 'd0', reviewed: true, reportComplete: true, outcome: 'review-only', reviewClean: true,
  findings: [], filePatchHashes: { ...filePatchHashes(files), 'src/a.ts': 'old' }, totalDiffLines: 10, tier: 'standard',
  triggerKinds: [], skillSha: 's', rulesDigest: 'r', lastFullReviewAt: '2026-10-10T12:00:00Z', ...over,
});

test('增量:只审 patch 变了的文件,外加上轮有问题的文件', () => {
  const scope = computeReviewScope({ previous: previous({ reviewClean: false, findings: [{ path: 'src/b.ts', body: '[P1] x' }] }), current: current(), headIsDescendant: true });
  assert.equal(scope.mode, 'incremental');
  assert.deepEqual(scope.files, ['src/a.ts', 'src/b.ts']);
  assert.match(scope.reason, /^增量\(基于 h0,本轮审 2 个文件\)$/);
});

test('同一版本已审且干净 → 沿用结论,不再调用模型', () => {
  const scope = computeReviewScope({ previous: previous({ head: 'h1', filePatchHashes: filePatchHashes(files) }), current: current(), headIsDescendant: null });
  assert.equal(scope.mode, 'reuse');
});

test('全量兜底:各条件都会退回全量', () => {
  const cases = [
    [null, /没有上一轮/],
    [previous({ reportComplete: false }), /没审完/],
    [previous({ baseRefName: 'dev' }), /base 分支变了/],
    [previous({ tier: 'light' }), /档位升级/],
    [previous({ skillSha: 'old' }), /skill 版本/],
    [previous({ rulesDigest: 'old' }), /规则文件/],
    [previous({ lastFullReviewAt: '2026-10-01T00:00:00Z' }), /7 天/],
  ];
  for (const [prev, re] of cases) assert.match(computeReviewScope({ previous: prev, current: current(), headIsDescendant: true }).reason, re);
  assert.equal(computeReviewScope({ previous: previous(), current: current({ triggerKinds: ['security'] }), headIsDescendant: true }).mode, 'full');
  assert.match(computeReviewScope({ previous: previous(), current: current(), headIsDescendant: false }).reason, /不是当前版本的祖先/);
  assert.equal(computeReviewScope({ previous: previous({ diffHash: 'd1' }), current: current(), headIsDescendant: false }).mode, 'reuse');
  assert.match(computeReviewScope({ previous: previous({ totalDiffLines: 1 }), current: current(), headIsDescendant: true }).reason, /一半/);
});

const fullReport = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'pass —— 没有 P0/P1。'].join('\n');

test('答卷校验:四段齐全;问题必须在 diff 里;行号不在新侧就改成文件级', () => {
  assert.equal(validateAnswer({ report: '## Findings', findings: [] }, { diffFiles: files }).ok, false);
  const ok = validateAnswer({ report: fullReport, findings: [
    { path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 真问题' },
    { path: 'src/a.ts', line: 99, side: 'RIGHT', body: '[P0] 行号不对' },
    { path: 'src/a.ts', line: null, side: 'RIGHT', body: '[P2] 风格' },
  ] }, { diffFiles: files });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.findings, [
    { path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 真问题' },
    { path: 'src/a.ts', subject_type: 'file', body: '[P0] 行号不对' },
  ]);
  assert.equal(validateAnswer({ report: fullReport, findings: [{ path: 'other.ts', line: 1, side: 'RIGHT', body: '[P1] x' }] }, { diffFiles: files }).ok, false);
});

test('最终报告:固定头部、审查范围行;结论行跟实际问题数一致', () => {
  const report = finalizeReport({ report: fullReport, findings: [{ path: 'src/a.ts', line: 11, body: '[P1] x' }], pr: 1,
    url: 'https://github.com/o/r/pull/1', head: 'a'.repeat(40), base: 'b'.repeat(40), diffHash: 'c'.repeat(64), tier: 'standard',
    scope: { mode: 'incremental', reason: '增量(基于 h0,本轮审 1 个文件)' } });
  assert.match(report, /^> Mivo 自动审查 · \[PR\]\(https:\/\/github.com\/o\/r\/pull\/1\)/);
  assert.match(report, /## Verification\n\n审查范围:增量\(基于 h0,本轮审 1 个文件\)/);
  assert.match(report, /## Overall\nchanges-requested —— 1 条 P0\/P1/);
  for (const section of REPORT_SECTIONS) assert.ok(report.includes(section));
});

test('发布前脱敏:高置信凭证格式全部替换', () => {
  const token = `ghp_${'x'.repeat(36)}`;
  const { text, hits } = scrubSecrets(`读到了 ${token} 和 sk-${'a'.repeat(24)}`);
  assert.equal(hits, 2);
  assert.doesNotMatch(text, /ghp_|sk-a/);
});
