// #127:盯梢裁决开不成时转的 issue 带问题 key 标记,审查机按 key 认,不靠模型判断「是不是同一问题」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeferralKeys, keyedDeferrals, verifyDeferrals, MAX_DEFERRAL_KEYS } from './deferrals.mjs';
import { applyConvergence, splitAdjudicated } from './convergence.mjs';
import { splitDiffByFile, filePatchHashes, computeReviewScope } from './scope.mjs';
import { adjudicatedReuseReport, DEFERRED_SECTION } from './report.mjs';

const KEY = '874751f27e81';
const mark = (key, extra = '') => `<!-- mivo-defer key=${key}${extra} -->`;

test('issue 正文里的 key 标记:读出 key、问题类型、行号、路径;去重;格式不对不算;最多 20 条', () => {
  const body = `来自 PR #7\n${mark(KEY, ' class=test-coverage-gap line=12 path=src/a.ts')}\n${mark(KEY)}\n${mark('abc')}\n<!-- mivo-defer key=${'f'.repeat(12)} -->`;
  assert.deepEqual(parseDeferralKeys(body), [
    { key: KEY, bugClass: 'test-coverage-gap', line: 12, path: 'src/a.ts' },
    { key: 'f'.repeat(12), bugClass: null, line: null, path: null },
  ]);
  assert.deepEqual(parseDeferralKeys(null), []);
  const many = Array.from({ length: 25 }, (_, i) => mark(i.toString(16).padStart(12, '0'))).join('\n');
  assert.equal(parseDeferralKeys(many).length, MAX_DEFERRAL_KEYS);
});

test('只认核验通过的 issue 里的标记:开 issue 的不是作者或维护者、或没提到本 PR,标记不算', () => {
  const issues = {
    1: { state: 'open', user: { login: 'author' }, title: '转 issue 跟进 #7', body: mark(KEY) },
    2: { state: 'open', user: { login: 'stranger' }, title: '#7', body: mark('aaaaaaaaaaaa') },
    3: { state: 'open', user: { login: 'author' }, title: '别的事', body: mark('bbbbbbbbbbbb') },
    4: { state: 'closed', user: { login: 'author' }, title: '#7', body: mark('cccccccccccc') },
  };
  const { verified, rejected } = verifyDeferrals({ entries: [1, 2, 3, 4].map((issue) => ({ issue, ref: `#${issue}`, text: '' })),
    repo: 'o/r', pr: 7, author: 'author', maintainers: [], readIssue: (n) => ({ ok: true, issue: issues[n] }) });
  assert.deepEqual(verified.map((d) => d.issue), [1]);
  assert.equal(rejected.length, 3);
  assert.deepEqual(keyedDeferrals(verified), [{ key: KEY, bugClass: null, line: null, path: null, issue: 1 }]);
});

const finding = (severity, key = KEY) => ({ path: 'src/a.ts', line: 12, side: 'RIGHT', body: `[${severity}] 测试替身忽略参数\n细节`, key, severity });

test('模型本轮仍报了按 key 转 issue 的 P1/P2:移到已转 issue,不阻断;同 key 的 P0 照常阻断', () => {
  const base = { preexisting: [], deferred: [], scope: { mode: 'full' }, roundIndex: 2, previousRound: null, head: 'h' };
  // key 由审查机按 path|问题类型|标题算出,和盯梢从原问题标记里抄的是同一个。
  const key = applyConvergence({ ...base, findings: [finding('P2')] }).findings[0].key;
  const keyDeferrals = [{ key, bugClass: null, line: null, path: null, issue: 55 }];
  const p2 = applyConvergence({ ...base, findings: [finding('P2')], keyDeferrals });
  assert.deepEqual(p2.findings, []);
  assert.deepEqual(p2.deferred.map((f) => [f.key, f.deferredTo]), [[key, 55]]);
  const p0 = applyConvergence({ ...base, findings: [finding('P0')], keyDeferrals });
  assert.deepEqual(p0.findings.map((f) => f.key), [key]);
  assert.deepEqual(p0.deferred, []);
  const other = applyConvergence({ ...base, findings: [{ ...finding('P2'), body: '[P2] 别的问题\n细节' }], keyDeferrals });
  assert.equal(other.findings.length, 1);
});

test('沿用上一轮结论时同样按 key 移到已转 issue;裁决优先', () => {
  const adjudications = [{ key: 'eeeeeeeeeeee', head: 'h', verdict: 'invalid' }];
  const keyDeferrals = [{ key: KEY, issue: 55 }, { key: 'eeeeeeeeeeee', issue: 56 }];
  const out = splitAdjudicated([finding('P2'), finding('P1', 'eeeeeeeeeeee'), finding('P0')], adjudications, keyDeferrals);
  assert.deepEqual(out.findings.map((f) => f.severity), ['P0']);
  assert.deepEqual(out.adjudicatedKept.map((f) => f.key), ['eeeeeeeeeeee']);
  assert.deepEqual(out.deferred.map((f) => [f.key, f.deferredTo]), [[KEY, 55]]);
});

const diff = ['diff --git a/src/a.ts b/src/a.ts', 'index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10,3 +10,4 @@', ' keep', '+added', ' tail'].join('\n');
const hashes = filePatchHashes(splitDiffByFile(diff));

test('同一版本、代码没变、上一轮阻断问题都被按 key 转 issue 覆盖:不跑模型,沿用', () => {
  const previous = { head: 'h1', baseRefName: 'main', diffHash: 'd1', reviewed: true, reportComplete: true, outcome: 'findings', reviewClean: false,
    specDigest: 's', lastFullReviewAt: new Date().toISOString(), filePatchHashes: hashes, totalDiffLines: 1, findings: [finding('P2')], deferred: [] };
  const current = (settledKeys) => ({ head: 'h1', baseRefName: 'main', diffHash: 'd1', filePatchHashes: hashes, fileChangedLines: { 'src/a.ts': 1 },
    specDigest: 's', now: Date.now(), settledKeys });
  assert.equal(computeReviewScope({ previous, current: current([KEY]), headIsDescendant: true }).mode, 'reuse');
  assert.notEqual(computeReviewScope({ previous, current: current([]), headIsDescendant: true }).mode, 'reuse');
});

test('沿用报告:结论写已转 issue 不阻断;旧报告里的「已转 issue」一节换成新的,不重复', () => {
  const previousReport = ['## Findings', '', '[P2] src/a.ts:12 — 测试替身忽略参数', '', DEFERRED_SECTION, '', '- #40 · `src/b.ts:3` · [P2] 旧的', '',
    '## Rule coverage', '', 'x', '', '## Overall', '', 'changes-requested —— 1 条 P0/P1/P2'].join('\n');
  const deferred = [{ ...finding('P2', 'bbbbbbbbbbbb'), path: 'src/b.ts', line: 3, body: '[P2] 旧的', deferredTo: 40 }, { ...finding('P2'), deferredTo: 55 }];
  const text = adjudicatedReuseReport({ previousReport, scope: { reason: 'r', basedOn: 'h' }, findings: [], deferred });
  assert.equal(text.split(DEFERRED_SECTION).length, 2, '已转 issue 一节只出现一次');
  assert.match(text, /- #55 · `src\/a.ts:12`/);
  assert.match(text, /pass —— 没有阻断的 P0\/P1\/P2。另有 2 条 P1\/P2 已转 issue 跟进\(#40、#55\)，不阻断。/);
  assert.doesNotMatch(text, /changes-requested/);
  assert.ok(text.indexOf(DEFERRED_SECTION) < text.indexOf('## Rule coverage'));
});
