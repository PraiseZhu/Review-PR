// review.md 里的短文件名 / 路径后缀(#262):能唯一确定才解析成完整路径,多个候选不猜;
// 换版后第一轮,新解析出的文件不算「交接涉及文件变了」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewHandoff, readHandoffReview, toHandoffSnapshot } from './handoff.mjs';
import { buildHandoffPlan, computeReviewScope, previousFromResult, splitDiffByFile, filePatchHashes } from './scope.mjs';

const entry = (n) => ({ mode: '100644', type: 'blob', oid: String(n).padStart(40, 'a') });
const tree = (...paths) => new Map(paths.map((p, i) => [p, entry(i + 1)]));
const handoff = (defense, mapCell = '`src/panel/bridge.ts#send` 改重试') => [
  '---', 'schema: mivo-pr-handoff/v1', 'kind: review', 'pr: 77', '---', '',
  '## 2. 改动地图', '',
  '| 触发入口 | 改动点 | 直接下游 | 必须保持的不变量 |', '|---|---|---|---|',
  `| 面板发消息 | ${mapCell} | 无 | 超时后不重复发送 |`, '',
  '## 3. 风险清单', '',
  '### R1：重试', '- 触发：超时', '- 会坏成什么样：重复发送', `- 现在靠什么挡住：${defense}`, '- 怎么证明我错了：断网重放', '- 测试：无', '',
].join('\n');
const HEAD = tree('src/panel/bridge.ts', 'src/host/bridge.ts', 'src/panel/queue.ts', 'server/index.ts', 'src/index.ts', 'docs/pr/77/review.md');
const parse = (text, { headFiles = HEAD, diffFiles = [] } = {}) => parseReviewHandoff(text, { prNumber: 77, headFiles, diffFiles });

test('SC6 短文件名在本 PR 改动里唯一 → 采用完整路径,符号原样保留,并记进 resolvedFiles', () => {
  const r = parse(handoff('`bridge.ts#send` 里的去重表'), { diffFiles: ['src/panel/bridge.ts', 'src/panel/queue.ts'] });
  assert.deepEqual(r.risks[0].files, ['src/panel/bridge.ts']);
  assert.deepEqual(r.risks[0].locations, [{ path: 'src/panel/bridge.ts', symbol: 'send' }]);
  assert.deepEqual(r.risks[0].resolvedFiles, ['src/panel/bridge.ts']);
  assert.equal(r.risks[0].complete, true);
  assert.deepEqual(r.fileStates['src/panel/bridge.ts'], { oid: HEAD.get('src/panel/bridge.ts').oid, mode: '100644' });
  assert.deepEqual(r.warnings.filter((w) => w.code.startsWith('path-')), []);
});

test('SC6 本 PR 改动里没有、整个 head 里唯一 → 也采用', () => {
  const r = parse(handoff('`queue.ts` 的出队顺序'), { diffFiles: ['src/panel/bridge.ts'] });
  assert.deepEqual(r.risks[0].files, ['src/panel/queue.ts']);
  assert.deepEqual(r.risks[0].resolvedFiles, ['src/panel/queue.ts']);
});

test('SC6 路径后缀(带一段目录)同样按唯一匹配解析', () => {
  const r = parse(handoff('`panel/bridge.ts#send`'), { diffFiles: [] });
  assert.deepEqual(r.risks[0].files, ['src/panel/bridge.ts']);
});

test('SC6 head 里有多个同名文件、本 PR 改动里一个都没有 → 丢弃并告警写明候选数', () => {
  const r = parse(handoff('`bridge.ts#send`'), { diffFiles: ['src/panel/queue.ts'] });
  assert.deepEqual(r.risks[0].files, []);
  assert.equal(r.risks[0].complete, false);
  assert.equal(r.risks[0].resolvedFiles, undefined);
  const w = r.warnings.find((x) => x.code === 'path-ambiguous');
  assert.ok(w, JSON.stringify(r.warnings));
  assert.equal(w.path, 'bridge.ts');
  assert.match(w.message, /有 2 个文件能对上/);
});

test('SC6 本 PR 同时改了两个同名文件 → 不猜,丢弃', () => {
  const r = parse(handoff('`bridge.ts#send`'), { diffFiles: ['src/panel/bridge.ts', 'src/host/bridge.ts'] });
  assert.deepEqual(r.risks[0].files, []);
  assert.ok(r.warnings.some((w) => w.code === 'path-ambiguous' && w.path === 'bridge.ts'));
});

test('SC6 head 里同名的有多个,但本 PR 只改了其中一个 → 采用本 PR 改的那个', () => {
  const r = parse(handoff('`index.ts`'), { diffFiles: ['server/index.ts'] });
  assert.deepEqual(r.risks[0].files, ['server/index.ts']);
});

test('SC6 找不到的照旧丢弃(path-not-in-head);完整路径照旧原样采用,不算解析', () => {
  const missing = parse(handoff('`nowhere.ts`'));
  assert.deepEqual(missing.risks[0].files, []);
  assert.ok(missing.warnings.some((w) => w.code === 'path-not-in-head' && w.path === 'nowhere.ts'));
  const exact = parse(handoff('`src/host/bridge.ts#recv`'));
  assert.deepEqual(exact.risks[0].files, ['src/host/bridge.ts']);
  assert.equal(exact.risks[0].resolvedFiles, undefined);
});

test('SC6 本 PR 改动清单里已删除的文件(head 上没有)不参与匹配', () => {
  const r = parse(handoff('`gone.ts`'), { diffFiles: ['src/old/gone.ts'] });
  assert.deepEqual(r.risks[0].files, []);
  assert.ok(r.warnings.some((w) => w.code === 'path-not-in-head' && w.path === 'gone.ts'));
});

test('SC6 改动地图里的短文件名同样解析', () => {
  const r = parse(handoff('`src/panel/bridge.ts`', '`queue.ts#flush` 改重试'), { diffFiles: ['src/panel/queue.ts'] });
  assert.deepEqual(r.changeMap[0].files, ['src/panel/queue.ts']);
  assert.ok(r.files.includes('src/panel/queue.ts'));
});

test('SC6 readHandoffReview 把 diffFiles 传给解析', () => {
  const text = handoff('`bridge.ts#send`');
  const treeOut = [...HEAD.entries()].map(([path, e]) => `${e.mode} ${e.type} ${e.oid}\t${path}`).join('\0');
  const gitFn = (args) => {
    if (args.includes('ls-tree')) return { ok: true, stdout: treeOut };
    if (args.includes('-s')) return { ok: true, stdout: String(Buffer.byteLength(text)) };
    return { ok: true, stdout: text };
  };
  const without = readHandoffReview({ prNumber: 77, head: 'h'.repeat(40), gitFn });
  assert.deepEqual(without.risks[0].files, []);
  const withDiff = readHandoffReview({ prNumber: 77, head: 'h'.repeat(40), gitFn, diffFiles: ['src/panel/bridge.ts'] });
  assert.deepEqual(withDiff.risks[0].files, ['src/panel/bridge.ts']);
});

// ── 换版后第一轮:上一轮快照是解析上线前记的(没有 resolver 标记) ──
const H64 = 'f'.repeat(64);
const state = (n) => ({ oid: String(n).repeat(40).slice(0, 40), mode: '100644' });
const riskNow = { id: 'R1', contentHash: H64, files: ['src/a.ts', 'src/panel/bridge.ts'], resolvedFiles: ['src/panel/bridge.ts'], locations: [], complete: true, ambiguous: false };
const reviewNow = { version: 1, status: 'parsed', source: null, changeMap: [], risks: [riskNow], files: riskNow.files,
  fileStates: { 'src/a.ts': state(1), 'src/panel/bridge.ts': state(2) }, warnings: [] };
// 旧快照:bridge.ts 当时写的是短文件名,被丢弃,files 里只有 a.ts。
const legacySnapshot = { version: 1, status: 'parsed', source: null, risks: [{ id: 'R1', contentHash: H64, files: ['src/a.ts'], complete: false, ambiguous: false }], fileStates: { 'src/a.ts': state(1) } };
const trusted = { reviewed: true, reportComplete: true, outcome: 'approval' };

test('SC6 旧快照 + 本轮新解析出文件:不算实质变化,这条 R 本轮重核一次', () => {
  const plan = buildHandoffPlan({ review: reviewNow, previous: { ...trusted, handoffReview: legacySnapshot }, changedFiles: [] });
  assert.deepEqual(plan.substantive, []);
  assert.equal(plan.items[0].action, 'recheck');
  assert.match(plan.items[0].reason, /短文件名/);
  assert.equal(plan.items[0].affected, undefined);
  assert.deepEqual(plan.items[0].files, ['src/a.ts', 'src/panel/bridge.ts'], '重核时带上解析出的文件');
});

test('SC6 新快照(带 resolver 标记)按完整清单比:文件清单真的变了仍算实质变化', () => {
  const marked = { ...legacySnapshot, resolver: 1 };
  const plan = buildHandoffPlan({ review: reviewNow, previous: { ...trusted, handoffReview: marked }, changedFiles: [] });
  assert.deepEqual(plan.substantive, ['R1']);
  assert.match(plan.items[0].reason, /涉及文件在 head 上变了/);
});

test('SC6 旧快照下,原有文件自己变了仍算实质变化(只豁免新解析出的那部分)', () => {
  const moved = { ...reviewNow, fileStates: { ...reviewNow.fileStates, 'src/a.ts': state(9) } };
  const plan = buildHandoffPlan({ review: moved, previous: { ...trusted, handoffReview: legacySnapshot }, changedFiles: [] });
  assert.deepEqual(plan.substantive, ['R1']);
});

test('SC6 toHandoffSnapshot 带 resolver 标记,经结果包读回后保留;旧结果包读回没有标记', () => {
  const snap = toHandoffSnapshot(reviewNow);
  assert.equal(snap.resolver, 1);
  const result = (handoffReview) => ({ head: 'a'.repeat(40), reviewed: true, outcome: 'approval', mivo: { reportComplete: true, handoffReview } });
  assert.equal(previousFromResult(result(snap)).handoffReview.resolver, 1);
  assert.equal(previousFromResult(result(legacySnapshot)).handoffReview.resolver, undefined);
});

test('SC6 换版后第一轮代码没变:沿用不被升成全量', () => {
  const diff = ['diff --git a/src/a.ts b/src/a.ts', 'index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');
  const hashes = filePatchHashes(splitDiffByFile(diff));
  const head = 'b'.repeat(40);
  const previous = { ...trusted, head, baseRefName: 'main', diffHash: 'd1', reviewClean: true, findings: [], deferred: [], filePatchHashes: hashes, totalDiffLines: 1,
    tier: 'standard', triggerKinds: [], specDigest: 'spec', lastFullReviewAt: '2026-11-26T12:00:00Z', handoffReview: legacySnapshot, handoffCoverage: [], handoffCoverageMeta: {} };
  const current = { head, baseRefName: 'main', diffHash: 'd1', filePatchHashes: hashes, fileChangedLines: { 'src/a.ts': 1 }, totalDiffLines: 1, tier: 'standard', triggerKinds: [],
    specDigest: 'spec', now: Date.parse('2026-11-27T12:00:00Z'), handoffReview: reviewNow, handoffEvidenceCheck: {} };
  const scope = computeReviewScope({ previous, current, headIsDescendant: null });
  assert.equal(scope.mode, 'reuse', scope.reason);
  // 对照:同样的输入、快照带 resolver 标记(文件清单确实变了)→ 升全量。证明上面的沿用靠的是旧快照兼容,不是别的分支。
  const marked = computeReviewScope({ previous: { ...previous, handoffReview: { ...legacySnapshot, resolver: 1 } }, current, headIsDescendant: null });
  assert.equal(marked.mode, 'full');
  assert.match(marked.reason, /交接风险发生实质变化/);
});
