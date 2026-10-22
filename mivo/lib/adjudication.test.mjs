// #124:审查机核对盯梢的裁决记录,认裁决并放行;同一版本的问题都裁决完不再跑模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAdjudications, confirmAdjudications, matchAdjudication, parseRulingRecord } from './rulings.mjs';
import { applyConvergence, splitAdjudicated } from './convergence.mjs';
import { findingMarker } from './finding.mjs';
import { splitDiffByFile, filePatchHashes, computeReviewScope } from './scope.mjs';
import { finalizeReport, renderAdjudicatedSection, adjudicatedReuseReport, ADJUDICATED_SECTION } from './report.mjs';

const REVIEWER = 'ReviewBot';
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const STD = 'eced0deeeaa8';
const KEY = '874751f27e81';
const record = ({ key = KEY, head = HEAD, verdict = 'invalid', std = STD } = {}) =>
  `<!-- mivo-ruling v=1 key=${key} head=${head} verdict=${verdict} std=${std} by=codex/gpt-6-astra task=live-1199-x -->`;
const first = (severity = 'P2', key = KEY) => ({ author: { login: REVIEWER }, url: 'https://x/t1',
  body: `[${severity}] 测试替身忽略参数,验不到二次转发\n\n事实…\n\n${findingMarker({ key, round: 1, head: HEAD, bugClass: 'test-coverage-gap' })}` });
const watcherReply = (extra, { login = REVIEWER, receipt = true } = {}) => ({ author: { login }, url: 'https://x/r1',
  body: `发生了什么:裁决席按统一分级判定不成立。\n\n${receipt ? '<!-- mivo-watcher-receipt task=live-1199-x -->\n' : ''}${extra}` });
const thread = (id, comments, over = {}) => ({ id, path: 'src/a.ts', line: 12, isResolved: true, comments, ...over });
const collect = (threads) => collectAdjudications({ threads, reviewer: REVIEWER.toLowerCase(), standardVersion: STD });

test('裁决记录:解析出问题 key、head、结论、标准版本、裁决者;格式不对返回 null', () => {
  assert.deepEqual(parseRulingRecord(`说明\n${record({ verdict: 'p3' })}`),
    { key: KEY, head: HEAD, verdict: 'p3', std: STD, by: 'codex/gpt-6-astra', task: 'live-1199-x' });
  assert.equal(parseRulingRecord('没有记录'), null);
  assert.equal(parseRulingRecord(record({ key: 'abc' })), null);
  assert.equal(parseRulingRecord(record({ verdict: 'valid' })), null);
  // 正文里夹带的同格式文字不算:盯梢把真记录写在最后一行,取最后一条。
  assert.equal(parseRulingRecord(`说明 ${record({ key: '000000000000', verdict: 'p3' })}\n${record()}`).key, KEY);
});

test('盯梢以审查账号回帖、带回执、key 对得上、标准版本相同的 P1/P2 裁决:核验通过', () => {
  const { verified, rejected } = collect([thread('T1', [first('P2'), watcherReply(record())])]);
  assert.deepEqual(rejected, []);
  assert.equal(verified.length, 1);
  assert.deepEqual({ ...verified[0], finding: undefined }, { threadId: 'T1', path: 'src/a.ts', line: 12, url: 'https://x/r1', key: KEY,
    bugClass: 'test-coverage-gap', severity: 'P2', head: HEAD, verdict: 'invalid', std: STD, by: 'codex/gpt-6-astra', task: 'live-1199-x', finding: undefined });
  assert.match(verified[0].finding, /测试替身忽略参数/);
});

test('不认的裁决:别的账号、没有盯梢回执、key 对不上、P0、标准版本不同、原问题没标记;各写明原因', () => {
  const noMarker = { author: { login: REVIEWER }, body: '[P2] 老格式问题,没有 marker' };
  const { verified, rejected } = collect([
    thread('T1', [first(), watcherReply(record(), { login: 'someone' })]),
    thread('T2', [first(), watcherReply(record(), { receipt: false })]),
    thread('T3', [first(), watcherReply(record({ key: 'ffffffffffff' }))]),
    thread('T4', [first('P0'), watcherReply(record())]),
    thread('T5', [first(), watcherReply(record({ std: '000000000000' }))]),
    thread('T6', [noMarker, watcherReply(record())]),
  ]);
  assert.deepEqual(verified, []);
  assert.deepEqual(rejected.map((r) => [r.threadId, r.reason]), [
    ['T1', '不是盯梢以审查账号发的回帖'],
    ['T2', '不是盯梢以审查账号发的回帖'],
    ['T3', `裁决记录的问题 key ffffffffffff 和这条讨论的问题 ${KEY} 对不上`],
    ['T4', 'P0 不按裁决放行'],
    ['T5', `裁决用的分级标准版本 000000000000 不是当前版本 ${STD}`],
    ['T6', '原问题没有 mivo-finding 标记,对不上是哪一条'],
  ]);
});

test('没有裁决记录、或不是审查机开的 thread:不认也不报;同一 thread 以最后一条裁决为准', () => {
  const greptile = { author: { login: 'greptile-apps' }, body: `[P2] x\n${findingMarker({ key: KEY, head: HEAD })}` };
  assert.deepEqual(collect([thread('T1', [first(), watcherReply('')]), thread('T2', [greptile, watcherReply(record())])]), { verified: [], rejected: [] });
  const { verified } = collect([thread('T1', [first(), watcherReply(record({ verdict: 'invalid' })), watcherReply(record({ verdict: 'p3' }))])]);
  assert.equal(verified[0].verdict, 'p3');
});

test('裁决只对裁决时的代码有效:同一 head 或之后相关文件没改才保留', () => {
  const [item] = collect([thread('T1', [first(), watcherReply(record({ head: OLD_HEAD }))])]).verified;
  const calls = [];
  const codeState = (state) => (rulingHead, path) => { calls.push([rulingHead, path]); return state; };
  assert.equal(confirmAdjudications({ verified: [{ ...item, head: HEAD }], head: HEAD, codeState: codeState('changed') }).verified.length, 1);
  assert.deepEqual(calls, [], '同一 head 不查 git');
  assert.equal(confirmAdjudications({ verified: [item], head: HEAD, codeState: codeState('unchanged') }).verified.length, 1);
  assert.deepEqual(calls, [[OLD_HEAD, 'src/a.ts']]);
  const changed = confirmAdjudications({ verified: [item], head: HEAD, codeState: codeState('changed') });
  assert.deepEqual([changed.verified, changed.rejected.map((r) => r.reason)], [[], ['裁决之后相关文件改过(或历史被改写),裁决失效']]);
  const unknown = confirmAdjudications({ verified: [item], head: HEAD, codeState: codeState('unknown') });
  assert.deepEqual(unknown.rejected.map((r) => r.reason), ['核对不了裁决之后相关文件有没有改过']);
});

test('匹配同一条问题:key 相同,或同文件、同问题类型、行号相差不超过 3 行;P0 永不匹配', () => {
  const adjudications = [{ key: KEY, path: 'src/a.ts', line: 12, bugClass: 'test-coverage-gap', verdict: 'invalid' }];
  assert.ok(matchAdjudication(adjudications, { key: KEY, severity: 'P2', path: 'src/other.ts' }));
  assert.ok(matchAdjudication(adjudications, { key: 'ffffffffffff', severity: 'P1', path: 'src/a.ts', line: 15, bugClass: 'test-coverage-gap' }));
  assert.equal(matchAdjudication(adjudications, { key: 'ffffffffffff', severity: 'P2', path: 'src/a.ts', line: 16, bugClass: 'test-coverage-gap' }), null);
  assert.equal(matchAdjudication(adjudications, { key: 'ffffffffffff', severity: 'P2', path: 'src/a.ts', line: 12, bugClass: 'null-deref' }), null);
  assert.equal(matchAdjudication(adjudications, { key: KEY, severity: 'P0', path: 'src/a.ts', line: 12 }), null);
});

test('模型本轮仍报了被采信裁决的问题:P1/P2 移出阻断进 adjudicatedKept;同 key 的 P0 照常阻断', () => {
  const adjudications = [{ key: KEY, path: 'src/a.ts', line: 12, bugClass: 'test-coverage-gap', verdict: 'p3', by: 'codex/gpt-6-astra', url: 'https://x/r1', head: HEAD }];
  const raised = (severity) => ({ path: 'src/a.ts', line: 12, severity, title: '测试替身忽略参数', bugClass: 'test-coverage-gap', supersedes: KEY,
    trigger: 't', behavior: 'b', impact: 'i', fix: 'f', verify: 'v', evidence: [], origin: 'introduced', instances: [] });
  const conv = applyConvergence({ findings: [raised('P2')], roundIndex: 2, history: undefined, adjudications, head: HEAD });
  assert.deepEqual(conv.findings, []);
  assert.deepEqual(conv.adjudicatedKept, [{ key: KEY, severity: 'P2', path: 'src/a.ts', line: 12, title: '测试替身忽略参数',
    verdict: 'p3', by: 'codex/gpt-6-astra', url: 'https://x/r1', rulingHead: HEAD }]);
  const p0 = applyConvergence({ findings: [raised('P0')], roundIndex: 2, history: undefined, adjudications, head: HEAD });
  assert.equal(p0.findings.length, 1);
  assert.deepEqual(p0.adjudicatedKept, []);
});

test('沿用上一轮结论时同样按裁决重判阻断', () => {
  const adjudications = [{ key: KEY, path: 'src/a.ts', line: 12, bugClass: 'test-coverage-gap', verdict: 'invalid', head: HEAD }];
  const stored = [{ key: KEY, severity: 'P2', path: 'src/a.ts', line: 12, title: 'A' }, { key: 'cccccccccccc', severity: 'P1', path: 'src/b.ts', line: 3, title: 'B' }];
  const { findings, adjudicatedKept } = splitAdjudicated(stored, adjudications);
  assert.deepEqual(findings.map((f) => f.key), ['cccccccccccc']);
  assert.deepEqual(adjudicatedKept.map((f) => f.key), [KEY]);
});

const diff = ['diff --git a/src/a.ts b/src/a.ts', 'index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10,3 +10,4 @@', ' keep', '+added', ' tail'].join('\n');
const hashes = filePatchHashes(splitDiffByFile(diff));
const current = (over = {}) => ({ head: 'h1', baseRefName: 'main', diffHash: 'd1', filePatchHashes: hashes, fileChangedLines: { 'src/a.ts': 1 },
  totalDiffLines: 1, tier: 'standard', triggerKinds: [], specDigest: 'spec', now: Date.parse('2026-10-22T12:00:00Z'), verifiedDeferralIssues: [], ...over });
const previous = (over = {}) => ({ head: 'h1', baseRefName: 'main', diffHash: 'd1', reviewed: true, reportComplete: true, outcome: 'findings', reviewClean: false,
  findings: [{ path: 'src/a.ts', line: 11, body: '[P2] A', key: KEY, severity: 'P2' }], deferred: [], filePatchHashes: hashes, totalDiffLines: 1,
  tier: 'standard', triggerKinds: [], specDigest: 'spec', lastFullReviewAt: '2026-10-22T10:00:00Z', ...over });
const scopeOf = (prev, cur) => computeReviewScope({ previous: prev, current: cur, headIsDescendant: true });
const SETTLED = '同一版本的问题都已裁决或转 issue,不再跑模型,按裁决与转 issue 出结论';

test('同一版本、代码没变、上一轮阻断问题全被采信裁决覆盖:不跑模型,沿用并按裁决出结论', () => {
  const scope = scopeOf(previous(), current({ settledKeys: [KEY] }));
  assert.deepEqual([scope.mode, scope.reason], ['reuse', SETTLED]);
});

test('有没被覆盖的问题、有 P0、不是同一版本、或没有裁决:照常审', () => {
  const two = previous({ findings: [{ path: 'src/a.ts', line: 11, body: '[P2] A', key: KEY, severity: 'P2' }, { path: 'src/a.ts', line: 10, body: '[P1] B', key: 'cccccccccccc', severity: 'P1' }] });
  assert.notEqual(scopeOf(two, current({ settledKeys: [KEY] })).reason, SETTLED);
  const p0 = previous({ findings: [{ path: 'src/a.ts', line: 11, body: '[P0] A', key: KEY, severity: 'P0' }] });
  assert.notEqual(scopeOf(p0, current({ settledKeys: [KEY] })).reason, SETTLED);
  assert.notEqual(scopeOf(previous({ head: 'h0' }), current({ settledKeys: [KEY] })).reason, SETTLED);
  assert.notEqual(scopeOf(previous(), current()).reason, SETTLED);
});

test('报告:单列已采信的裁决,结论写「没有阻断」并说明几条按裁决不阻断', () => {
  const kept = [{ key: KEY, severity: 'P2', path: 'src/a.ts', line: 12, title: '测试替身忽略参数', verdict: 'p3', by: 'codex/gpt-6-astra', url: 'https://x/r1' }];
  assert.deepEqual(renderAdjudicatedSection([]), []);
  const section = renderAdjudicatedSection(kept).join('\n');
  assert.match(section, new RegExp(ADJUDICATED_SECTION));
  assert.match(section, /`src\/a\.ts:12` · \[P2\] 测试替身忽略参数 · 裁决:够不上必修\(P3\) · 裁决者 codex\/gpt-6-astra · \[裁决回帖\]\(https:\/\/x\/r1\)/);
  const report = finalizeReport({ report: '## Findings\n\n无\n\n## Rule coverage\n\nx\n\n## Verification\n\ny\n\n## Overall\n\npass —— 没有 P0/P1/P2。',
    findings: [], adjudicatedKept: kept, pr: 1, url: 'u', head: HEAD, base: OLD_HEAD, diffHash: 'd', tier: 'standard', scope: { mode: 'full', reason: 'r' } });
  assert.match(report, /pass —— 没有阻断的 P0\/P1\/P2。另有 1 条 P1\/P2 经盯梢裁决席判定不成立或够不上必修，服务器已核验采信，不阻断。/);
  assert.ok(report.indexOf(ADJUDICATED_SECTION) < report.indexOf('## Rule coverage'));
});

test('沿用上一轮报告时:Findings 与结论按剩下的问题重写,并单列裁决;不留「打回」的旧结论', () => {
  const previousReport = '> Mivo 自动审查 · head x\n\n## Findings\n\n[P2] src/a.ts:12 — 测试替身忽略参数\n\n## Rule coverage\n\nx\n\n## Verification\n\ny\n\n## Overall\n\nchanges-requested —— 1 条 P0/P1/P2，已在对应位置开 review thread。';
  const kept = [{ key: KEY, severity: 'P2', path: 'src/a.ts', line: 12, title: '测试替身忽略参数', verdict: 'invalid' }];
  const text = adjudicatedReuseReport({ previousReport, scope: { reason: SETTLED, basedOn: HEAD }, findings: [], adjudicatedKept: kept });
  assert.match(text, /^> 本轮沿用上一轮审查结论\(同一版本的问题都已裁决/);
  assert.doesNotMatch(text, /changes-requested/);
  assert.match(text, /## Findings\n\n无\n/);
  assert.match(text, /pass —— 没有阻断的 P0\/P1\/P2。另有 1 条/);
  assert.ok(text.indexOf(ADJUDICATED_SECTION) < text.indexOf('## Rule coverage'));
});
