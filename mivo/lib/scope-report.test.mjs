import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiffByFile, filePatchHashes, computeReviewScope, previousFromResult } from './scope.mjs';
import { validateAnswer, finalizeReport, scrubSecrets, renderDeferredSection, REPORT_SECTIONS, ANSWER_SCHEMA, DEFERRED_SECTION, DEFER_HINT } from './report.mjs';

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
  specDigest: 'spec-1', now: Date.parse('2026-10-11T12:00:00Z'), ...over,
});
const previous = (over = {}) => ({
  head: 'h0', baseRefName: 'main', diffHash: 'd0', reviewed: true, reportComplete: true, outcome: 'review-only', reviewClean: true,
  findings: [], filePatchHashes: { ...filePatchHashes(files), 'src/a.ts': 'old' }, totalDiffLines: 10, tier: 'standard',
  triggerKinds: [], specDigest: 'spec-1', lastFullReviewAt: '2026-10-10T12:00:00Z', ...over,
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
    [previous({ specDigest: 'spec-0' }), /任务书或规则变了/],
    [previous({ specDigest: undefined }), /上一轮没有任务书版本/],
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

test('上一轮有转 issue 的问题:不算干净、不沿用结论,问题文件进增量范围并带上 deferredTo', () => {
  const deferred = [{ path: 'src/b.ts', line: 1, side: 'RIGHT', body: '[P1] 漏列', deferredTo: 1001 }];
  const same = computeReviewScope({ previous: previous({ head: 'h1', filePatchHashes: filePatchHashes(files), deferred }), current: current(), headIsDescendant: null });
  assert.equal(same.mode, 'incremental');
  assert.deepEqual(same.files, ['src/b.ts']);
  assert.equal(same.previousFindings[0].deferredTo, 1001);
  const rebased = computeReviewScope({ previous: previous({ diffHash: 'd1', deferred }), current: current(), headIsDescendant: false });
  assert.equal(rebased.mode, 'full');
});

test('答卷校验:核验过的 P1 转 issue 不阻断;P0、名单外、非法 issue 号照常阻断', () => {
  assert.ok(ANSWER_SCHEMA.properties.findings.items.required.includes('deferredTo'));
  assert.deepEqual(ANSWER_SCHEMA.properties.findings.items.properties.deferredTo.type, ['integer', 'null']);
  const checked = validateAnswer({ report: fullReport, findings: [
    { path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 转走的', deferredTo: 1001 },
    { path: 'src/a.ts', line: 99, side: 'RIGHT', body: '[P1] 转走但行号不对', deferredTo: 1001 },
    { path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P0] 想转的 P0', deferredTo: 1001 },
    { path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 名单外', deferredTo: 1002 },
    { path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 非法号', deferredTo: '#1001' },
    { path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 缺字段' },
    { path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 显式 null', deferredTo: null },
  ] }, { diffFiles: files, deferrals: [{ issue: 1001 }] });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.deferred, [
    { path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] 转走的', deferredTo: 1001 },
    { path: 'src/a.ts', subject_type: 'file', body: '[P1] 转走但行号不对', deferredTo: 1001 },
  ]);
  assert.deepEqual(checked.findings.map((f) => f.body), ['[P0] 想转的 P0', '[P1] 名单外', '[P1] 非法号', '[P1] 缺字段', '[P1] 显式 null']);
  assert.ok(checked.findings.every((f) => !('deferredTo' in f)), '阻断问题的形状不变');
  assert.ok(checked.notes.some((n) => /P0,不能转 issue\(#1001\)/.test(n)));
  assert.ok(checked.notes.some((n) => /#1002 不在核验通过的 issue 里/.test(n)));
  assert.ok(checked.notes.some((n) => /deferredTo 不是 issue 号/.test(n)));
  const noList = validateAnswer({ report: fullReport, findings: [{ path: 'src/a.ts', line: 11, side: 'RIGHT', body: '[P1] x', deferredTo: 1001 }] }, { diffFiles: files });
  assert.equal(noList.findings.length, 1, '没有核验通过的条目时一律阻断');
});

const finalize = (over) => finalizeReport({ report: fullReport, findings: [], pr: 1, url: 'https://github.com/o/r/pull/1',
  head: 'a'.repeat(40), base: 'b'.repeat(40), diffHash: 'c'.repeat(64), tier: 'heavy', scope: { mode: 'full', reason: '首次' }, ...over });

test('最终报告:只有转 issue 的问题时结论是 pass,并在 Rule coverage 前单列', () => {
  const report = finalize({ deferred: [{ path: 'src/a.ts', line: 11, body: '[P1] 旧 ghost 列表静默漏列\n影响', deferredTo: 1001 }],
    deferralsRejected: [{ issue: 1002, ref: '#1002', reason: 'issue 不是 OPEN(closed)' }] });
  assert.match(report, /## Overall\npass —— 没有阻断的 P0\/P1；1 条 P1 已转 issue 跟进\(#1001\)，不阻断本 PR。/);
  assert.ok(report.indexOf(DEFERRED_SECTION) >= 0 && report.indexOf(DEFERRED_SECTION) < report.indexOf('## Rule coverage'));
  assert.ok(report.includes('- #1001 · `src/a.ts:11` · [P1] 旧 ghost 列表静默漏列'));
  assert.ok(report.includes('  - `#1002`：issue 不是 OPEN(closed)'));
  assert.ok(!report.includes(DEFER_HINT), 'pass 时不附转 issue 的做法');
});

test('最终报告:有阻断问题时结论照旧并补一句;阻断里有 P1 才附转 issue 的做法', () => {
  const mixed = finalize({ findings: [{ path: 'src/a.ts', line: 11, body: '[P1] x' }], deferred: [{ path: 'src/b.ts', body: '[P1] y', deferredTo: 1001 }] });
  assert.match(mixed, /## Overall\nchanges-requested —— 1 条 P0\/P1，已在对应位置开 review thread。另有 1 条 P1 已转 issue 跟进\(#1001\)，不阻断。\n\n本 PR 修不了/);
  assert.ok(mixed.includes('- #1001 · `src/b.ts` · [P1] y'));
  const onlyP0 = finalize({ findings: [{ path: 'src/a.ts', line: 11, body: '[P0] z' }] });
  assert.ok(!onlyP0.includes(DEFER_HINT));
  const plain = finalize({});
  assert.ok(!plain.includes(DEFERRED_SECTION), '没有转 issue 也没有未采用登记时,报告和以前一样');
  assert.match(plain, /## Overall\npass —— 没有 P0\/P1。\n?$/);
  assert.deepEqual(renderDeferredSection({ deferred: [], rejected: [] }), []);
  assert.deepEqual(renderDeferredSection({ rejected: [{ ref: 'o/r#5', reason: '跨仓引用,只认本仓 issue' }] }).slice(0, 4),
    [DEFERRED_SECTION, '', '- 无', '- 登记了但没采用：']);
});

test('specDigest:旧产物缺字段退回全量,两边都缺也不能判成相等;skill 换版本但任务书没变仍可增量', () => {
  assert.equal(computeReviewScope({ previous: previous({ specDigest: undefined }), current: current({ specDigest: undefined }), headIsDescendant: true }).mode, 'full');
  assert.match(computeReviewScope({ previous: previous(), current: current({ specDigest: '' }), headIsDescendant: true }).reason, /本轮没有任务书版本/);
  const scope = computeReviewScope({ previous: previous({ skillSha: 'old-sha', rulesDigest: 'old' }), current: current({ skillSha: 'new-sha' }), headIsDescendant: true });
  assert.equal(scope.mode, 'incremental', '只换了审查机代码版本,任务书材料没变');
  assert.equal(computeReviewScope({ previous: previous({ head: 'h1', filePatchHashes: filePatchHashes(files) }), current: current(), headIsDescendant: null }).mode, 'reuse', '同 head 复用');
});

test('上一轮结果包 → 上一轮记录:specDigest 等字段原样带回', () => {
  const result = { pr: 7, head: 'h0', reviewed: true, reviewClean: true, outcome: 'review-only',
    reviewEvidence: { baseRefName: 'main', diffHash: 'd0' },
    mivo: { targetRepo: 'o/r', reportComplete: true, findings: [], deferred: [], filePatchHashes: { 'a.ts': 'x' }, totalDiffLines: 3,
      tier: 'standard', triggerKinds: [], skillSha: 'sha', specDigest: 'spec-1', lastFullReviewAt: '2026-10-10T12:00:00Z' } };
  const prev = previousFromResult(result, 'report');
  assert.equal(prev.specDigest, 'spec-1');
  assert.equal(prev.report, 'report');
  assert.deepEqual(prev.filePatchHashes, { 'a.ts': 'x' });
  assert.equal(previousFromResult({ ...result, mivo: { ...result.mivo, specDigest: undefined } }, '').specDigest, undefined);
});

// advisory(代码没有 P0/P1、前置门没过)的结果包:reviewClean 记 false 是给 Mini 看的「还没放行」,
// 不是「代码审查有问题」。范围判定把它当成代码干净;有转 issue 的问题或不是 advisory 的 false 仍然不算干净。
test('上一轮结果包:advisory 视为代码干净,其余 reviewClean=false 仍不干净', () => {
  const base = { pr: 7, head: 'h1', reviewed: true, reviewClean: false, outcome: 'merge-blocked',
    reviewEvidence: { baseRefName: 'main', diffHash: 'd1' },
    mivo: { targetRepo: 'o/r', reportComplete: true, findings: [], deferred: [], filePatchHashes: filePatchHashes(files), totalDiffLines: 2,
      tier: 'standard', triggerKinds: [], specDigest: 'spec-1', lastFullReviewAt: '2026-10-10T12:00:00Z' } };
  const advisory = { ...base, mivo: { ...base.mivo, advisory: { pendingGates: ['bot-threads'] } } };
  const scope = (result) => computeReviewScope({ previous: previousFromResult(result, ''), current: current({ head: 'h1', diffHash: 'd1' }), headIsDescendant: null });
  assert.equal(scope(advisory).mode, 'reuse', 'advisory:同一 head 沿用');
  assert.equal(scope({ ...advisory, mivo: { ...advisory.mivo, deferred: [{ path: 'src/a.ts', body: '[P1] x', deferredTo: 9 }] } }).mode, 'incremental', '有转 issue 的问题不沿用,重新核验');
  assert.equal(scope({ ...advisory, mivo: { ...advisory.mivo, findings: [{ path: 'src/a.ts', body: '[P1] x' }] } }).mode, 'incremental', '有 P0/P1 不沿用,重审问题文件');
  assert.equal(scope({ ...advisory, mivo: { ...advisory.mivo, advisory: { pendingGates: [] } } }).mode, 'full', '没有挂起的门不算 advisory');
  assert.equal(scope(base).mode, 'full', '不是 advisory 的 reviewClean=false 仍不干净');
  assert.equal(scope({ ...advisory, mivo: { ...advisory.mivo, verifierOverruledAll: true } }).mode, 'full', '核对员推翻全部卡点、等人工复核的 advisory 仍全量(manualReview 优先)');
  assert.equal(previousFromResult(advisory, '').reviewClean, true, '记录里是代码层面的干净;result.reviewClean 本身仍是 false');
  assert.equal(advisory.reviewClean, false);
});

// 2026-10-17 补审:作者即审查账号时,publishAdvisory 把发布阶段才发现的拦截项写进 advisory.blockers(pendingGates 为空)。
// 这类结果和「只剩机器人 thread」一样,代码层面是干净的,同 head 该沿用,不该多跑一轮完整审查。
test('上一轮结果包:advisory.blockers(作者自批之外的发布阶段拦截项)也算代码干净,同 head 沿用', () => {
  const base = { pr: 7, head: 'h1', reviewed: true, reviewClean: false, outcome: 'merge-blocked',
    reviewEvidence: { baseRefName: 'main', diffHash: 'd1' },
    mivo: { targetRepo: 'o/r', reportComplete: true, findings: [], deferred: [], filePatchHashes: filePatchHashes(files), totalDiffLines: 2,
      tier: 'standard', triggerKinds: [], specDigest: 'spec-1', lastFullReviewAt: '2026-10-10T12:00:00Z' } };
  const blockers = { ...base, mivo: { ...base.mivo, advisory: { pendingGates: [], blockers: ['仍有 conversation 未 resolve'] } } };
  const scope = (result) => computeReviewScope({ previous: previousFromResult(result, ''), current: current({ head: 'h1', diffHash: 'd1' }), headIsDescendant: null });
  assert.equal(scope(blockers).mode, 'reuse', '只有 blockers 的 advisory:同一 head 沿用');
  assert.equal(previousFromResult(blockers, '').reviewClean, true);
  assert.equal(scope({ ...blockers, mivo: { ...blockers.mivo, advisory: { pendingGates: [], blockers: [] } } }).mode, 'full', '两者都为空不算 advisory');
  assert.equal(scope({ ...blockers, mivo: { ...blockers.mivo, advisory: { blockers: ['x'] } } }).mode, 'reuse', '缺 pendingGates 字段也认 blockers');
  assert.equal(scope({ ...blockers, mivo: { ...blockers.mivo, findings: [{ path: 'src/a.ts', body: '[P1] x' }] } }).mode, 'incremental', '有 P0/P1 不沿用');
  assert.equal(scope({ ...blockers, mivo: { ...blockers.mivo, deferred: [{ path: 'src/a.ts', body: '[P1] x', deferredTo: 9 }] } }).mode, 'incremental', '有转 issue 的问题不沿用');
  assert.equal(scope({ ...blockers, mivo: { ...blockers.mivo, verifierOverruledAll: true } }).mode, 'full', '核对员推翻全部卡点的 advisory 仍全量');
});

test('addedLines 只含 + 行的新侧行号;增量范围带 changedFiles', () => {
  const split = splitDiffByFile(diff('+added'));
  assert.deepEqual([...split['src/a.ts'].addedLines], [11]);
  assert.deepEqual([...split['src/b.ts'].addedLines], [1]);
  const scope = computeReviewScope({ previous: previous({ reviewClean: false, findings: [{ path: 'src/b.ts', body: '[P1] x' }] }), current: current(), headIsDescendant: true });
  assert.deepEqual(scope.changedFiles, ['src/a.ts']);
});

test('上一轮「核对员推翻了全部卡点、等人工复核」的状态跨轮保留:无关文件的小改动也不能走增量并恢复 Approve', () => {
  const result = { pr: 7, head: 'h0', reviewed: true, reviewClean: false, outcome: 'merge-blocked', reviewEvidence: { baseRefName: 'main', diffHash: 'd0' },
    approval: { status: 'blocked', code: 'verifier-overruled' },
    mivo: { targetRepo: 'o/r', reportComplete: true, findings: [], deferred: [], verifierOverruled: [{ path: 'src/a.ts' }], verifierOverruledAll: true,
      filePatchHashes: { 'src/a.ts': 'same', 'src/b.ts': 'old' }, totalDiffLines: 100, tier: 'standard', triggerKinds: [], specDigest: 'spec-1', lastFullReviewAt: '2026-10-10T12:00:00Z' } };
  const prev = previousFromResult(result, 'report');
  assert.equal(prev.manualReview, true);
  const cur = current({ filePatchHashes: { 'src/a.ts': 'same', 'src/b.ts': 'new' }, fileChangedLines: { 'src/b.ts': 1 }, totalDiffLines: 101 });
  for (const headIsDescendant of [true, null]) {
    const scope = computeReviewScope({ previous: prev, current: cur, headIsDescendant });
    assert.equal(scope.mode, 'full', `headIsDescendant=${headIsDescendant}`);
    assert.match(scope.reason, /核对员推翻\/降级了全部卡点/);
  }
  assert.equal(computeReviewScope({ previous: { ...prev, head: 'h1' }, current: current({ head: 'h1', filePatchHashes: cur.filePatchHashes }), headIsDescendant: null }).mode, 'full', '同一 head 也重新全量');
  const unmarked = previousFromResult({ ...result, approval: undefined, mivo: { ...result.mivo, verifierOverruledAll: undefined } }, '');
  assert.equal(unmarked.manualReview, true, '没有显式标记时按形状认(没有阻断问题、有被推翻的问题、没放行)');
  assert.equal(previousFromResult({ ...result, reviewClean: true, mivo: { ...result.mivo, verifierOverruledAll: undefined, verifierOverruled: [] } }, '').manualReview, false);
});
