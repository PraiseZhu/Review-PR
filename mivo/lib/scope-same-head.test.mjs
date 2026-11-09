// #231:同一版本、代码没变、上一轮有问题时,讨论输入没变就沿用上次结论,不再跑模型。
// 夹具形状取自 xindong/mivo-canvas-plugin#2035:11-09 在 042e0660 上作者 resolve 了审查机 thread 但没推新提交,
// 前置连派三轮,每轮模型都把同一个 P2 再报一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiffByFile, filePatchHashes, computeReviewScope, previousFromResult, discussionDigestOf } from './scope.mjs';

const diff = ['diff --git a/cindyplugin/src/persist/libraryModel3dThumbnail.ts b/cindyplugin/src/persist/libraryModel3dThumbnail.ts', 'index 111..222 100644',
  '--- a/cindyplugin/src/persist/libraryModel3dThumbnail.ts', '+++ b/cindyplugin/src/persist/libraryModel3dThumbnail.ts', '@@ -200,3 +200,4 @@', ' keep', '+added', ' tail'].join('\n');
const hashes = filePatchHashes(splitDiffByFile(diff));
const NOW = Date.parse('2026-11-09T07:00:00Z');
const HEAD = '042e066082ade602f1f0ada68acc929db7174596';
const REASON = '同一版本代码没变,也没有新的申辩或裁定,沿用上次结论';
const F = { path: 'cindyplugin/src/persist/libraryModel3dThumbnail.ts', line: 205, side: 'RIGHT', body: '[P2] 共享缩略图任务仍被首个候选的证明失败阻断', key: '575a77e458a1', seenRounds: 1 };
const REBUTTAL = { threadId: 'PRRT_1', path: F.path, line: 205, severity: 'P2', finding: '共享缩略图任务只检查首个调用方', reply: '旧实现让同一个模型的多张卡片共用缩略图任务时…' };
const DIGEST = discussionDigestOf({ rebuttals: [REBUTTAL] });

const current = (over = {}) => ({
  head: HEAD, baseRefName: 'integration/3d', diffHash: 'fccdbfe5', filePatchHashes: hashes, fileChangedLines: { [F.path]: 1 }, totalDiffLines: 1,
  tier: 'heavy', triggerKinds: [], specDigest: 'spec', now: NOW, verifiedDeferralIssues: [], settledKeys: [], discussionDigest: DIGEST, ...over,
});
const previous = (over = {}) => ({
  head: HEAD, baseRefName: 'integration/3d', diffHash: 'fccdbfe5', reviewed: true, reportComplete: true, outcome: 'findings', reviewClean: false,
  findings: [F], deferred: [], filePatchHashes: hashes, totalDiffLines: 1, tier: 'heavy', triggerKinds: [],
  specDigest: 'spec', lastFullReviewAt: '2026-11-09T04:44:00Z', discussionDigest: DIGEST, ...over,
});
const scopeOf = (prev, cur = current()) => computeReviewScope({ previous: prev, current: cur, headIsDescendant: null });

test('SC1:同一版本、代码没变、上一轮有问题、讨论输入没变 → 沿用,带着原问题,不跑模型', () => {
  const scope = scopeOf(previous());
  assert.equal(scope.mode, 'reuse');
  assert.equal(scope.reason, REASON);
  assert.equal(scope.basedOn, HEAD);
  assert.deepEqual(scope.previousFindings.map((f) => f.key), [F.key]);
});

test('SC2:同版本出现新的作者申辩、维护者裁定、盯梢裁决或转 issue 变化 → 不沿用,照旧交给模型', () => {
  const changedInputs = [
    { rebuttals: [REBUTTAL, { ...REBUTTAL, threadId: 'PRRT_2' }] },
    { rebuttals: [{ ...REBUTTAL, reply: '作者补了新的理由' }] },
    { rebuttals: [REBUTTAL], rulings: [{ threadId: 'PRRT_1', by: 'kirozeng', reason: '维护者裁定不改' }] },
    { rebuttals: [REBUTTAL], adjudications: [{ key: F.key, verdict: 'P3', head: HEAD }] },
    { rebuttals: [REBUTTAL], deferrals: [{ issue: 2100, text: '转 issue 跟进' }] },
  ];
  for (const inputs of changedInputs) {
    const scope = scopeOf(previous(), current({ discussionDigest: discussionDigestOf(inputs) }));
    assert.notEqual(scope.mode, 'reuse', JSON.stringify(inputs));
    assert.equal(scope.mode, 'incremental');
  }
});

test('SC3:上一轮结果没有讨论摘要(换版前的旧结果)→ 行为与以前一致(增量)', () => {
  const legacy = previousFromResult({ head: HEAD, reviewed: true, reviewClean: false, outcome: 'findings', reviewEvidence: { baseRefName: 'integration/3d', diffHash: 'fccdbfe5' },
    mivo: { reportComplete: true, findings: [F], filePatchHashes: hashes, totalDiffLines: 1, tier: 'heavy', specDigest: 'spec', lastFullReviewAt: '2026-11-09T04:44:00Z' } });
  assert.equal(legacy.discussionDigest, null);
  assert.equal(scopeOf(legacy).mode, 'incremental');
  for (const bad of [123, '', {}]) {
    const parsed = previousFromResult({ head: HEAD, mivo: { discussionDigest: bad } });
    assert.equal(parsed.discussionDigest, null, String(bad));
  }
  const parsed = previousFromResult({ head: HEAD, mivo: { discussionDigest: DIGEST } });
  assert.equal(parsed.discussionDigest, DIGEST);
});

test('沿用只限同一 head、代码没变:head 变了或补丁变了都不沿用', () => {
  assert.notEqual(scopeOf(previous({ head: 'h0' }), current()).mode, 'reuse');
  assert.equal(computeReviewScope({ previous: previous({ head: 'h0' }), current: current(), headIsDescendant: true }).mode, 'incremental');
  assert.notEqual(scopeOf(previous({ filePatchHashes: { [F.path]: 'other' } })).mode, 'reuse');
});

test('SC5:原有的兜底照常优先(收口待补、7 天、档位升级、新确认门、base 分支变化、人工复核)', () => {
  const pendingFinalFull = { head: HEAD, previousFindings: [F] };
  const finalFull = scopeOf(previous({ pendingFinalFull }));
  assert.equal(finalFull.mode, 'full');
  assert.equal(finalFull.purpose, 'final-full');
  assert.equal(scopeOf(previous({ lastFullReviewAt: '2026-10-01T00:00:00Z' })).reason, '距上次完整审查超过 7 天');
  assert.equal(scopeOf(previous({ tier: 'standard' })).mode, 'full');
  assert.equal(scopeOf(previous({ triggerKinds: [] }), current({ triggerKinds: ['security'] })).mode, 'full');
  assert.equal(scopeOf(previous({ baseRefName: 'main' })).mode, 'full');
  assert.equal(scopeOf(previous({ manualReview: true })).mode, 'full');
});

test('上一轮干净、同一版本的老路径不变', () => {
  const clean = scopeOf(previous({ findings: [], reviewClean: true }));
  assert.equal(clean.mode, 'reuse');
  assert.equal(clean.reason, '同一版本已审过,沿用上次结论');
});

test('discussionDigestOf:与顺序无关,字段改动会变,空输入稳定', () => {
  const a = { threadId: 'A', reply: 'x' };
  const b = { threadId: 'B', reply: 'y' };
  assert.equal(discussionDigestOf({ rebuttals: [a, b] }), discussionDigestOf({ rebuttals: [b, a] }));
  assert.notEqual(discussionDigestOf({ rebuttals: [a] }), discussionDigestOf({ rebuttals: [{ ...a, reply: 'z' }] }));
  assert.equal(discussionDigestOf(), discussionDigestOf({}));
  assert.match(discussionDigestOf(), /^[0-9a-f]{64}$/);
  // 同一份文字放在不同类别里不能撞成同一个摘要
  assert.notEqual(discussionDigestOf({ rulings: [{ threadId: 'A', by: null, reason: 'x' }] }), discussionDigestOf({ rebuttals: [{ threadId: 'A', reply: 'x' }] }));
});

// ── 合并前单审(Astra,2026-11-10)指出的三处:长申辩末尾补证据、撤掉转 issue 的问题 key、base 前移改了 diffHash ──
import { rebuttalRowsOf } from './scope.mjs';
import { collectRebuttals } from './rulings.mjs';

const reviewerThread = (id, replies) => ({ id, path: F.path, line: 205,
  comments: [{ author: { login: 'mivo-bot' }, body: `[P2] 共享缩略图任务仍被首个候选的证明失败阻断\n<!-- mivo-finding key=${F.key} round=1 head=042e066082ad -->` }, ...replies] });
const LONG = '旧实现'.repeat(250);

test('F1:作者在长回复末尾补证据(前 600 字不变)→ 指纹变,不沿用;任务书摘取的申辩确实看不出差别', () => {
  const before = [reviewerThread('PRRT_1', [{ author: { login: 'zhongxingtian-ai' }, body: `${LONG}。` }])];
  const after = [reviewerThread('PRRT_1', [{ author: { login: 'zhongxingtian-ai' }, body: `${LONG}。新证据:第二个候选可以独立证明,见 libraryModel3dThumbnail.test.ts。` }])];
  const who = { reviewer: 'mivo-bot', author: 'zhongxingtian-ai' };
  // 任务书用的截断申辩相同(这正是不能拿它判断「有没有新申辩」的原因)
  assert.deepEqual(collectRebuttals({ threads: before, ...who }).map((r) => r.reply), collectRebuttals({ threads: after, ...who }).map((r) => r.reply));
  const d0 = discussionDigestOf({ rebuttals: rebuttalRowsOf({ threads: before, ...who }) });
  const d1 = discussionDigestOf({ rebuttals: rebuttalRowsOf({ threads: after, ...who }) });
  assert.notEqual(d0, d1);
  assert.notEqual(scopeOf(previous({ discussionDigest: d0 }), current({ discussionDigest: d1 })).mode, 'reuse');
  assert.equal(scopeOf(previous({ discussionDigest: d0 }), current({ discussionDigest: d0 })).mode, 'reuse');
});

test('F1:申辩指纹不截断、不限条数;审查机自己的回复和别人的回复不算作者申辩', () => {
  const who = { reviewer: 'mivo-bot', author: 'zhongxingtian-ai' };
  const many = Array.from({ length: 25 }, (_, i) => reviewerThread(`PRRT_${i}`, [{ author: { login: 'zhongxingtian-ai' }, body: `申辩 ${i}` }]));
  assert.equal(rebuttalRowsOf({ threads: many, ...who }).length, 25, '超过任务书 20 条上限的也进指纹');
  const base = [reviewerThread('PRRT_1', [{ author: { login: 'zhongxingtian-ai' }, body: '申辩' }])];
  const withOthers = [reviewerThread('PRRT_1', [{ author: { login: 'zhongxingtian-ai' }, body: '申辩' }, { author: { login: 'mivo-bot' }, body: '审查机回复' }, { author: { login: 'greptile-apps' }, body: '别人' }])];
  assert.deepEqual(rebuttalRowsOf({ threads: withOthers, ...who }), rebuttalRowsOf({ threads: base, ...who }));
  const notReviewer = [{ id: 'X', comments: [{ author: { login: 'someone' }, body: '[P2] x' }, { author: { login: 'zhongxingtian-ai' }, body: '回复' }] }];
  assert.deepEqual(rebuttalRowsOf({ threads: notReviewer, ...who }), [], '不是审查机开的 thread 不算');
  assert.deepEqual(rebuttalRowsOf({ threads: base, reviewer: '', author: 'zhongxingtian-ai' }), [], '读不到审查账号时为空');
});

test('F2:转 issue 仍开着、登记行没变,但撤掉了某个问题 key → 摘要变,不沿用', () => {
  const withKey = [{ issue: 2100, text: '转 issue 跟进', keys: [{ key: F.key, bugClass: 'x', path: F.path, line: 205 }] }];
  const keyRemoved = [{ issue: 2100, text: '转 issue 跟进', keys: [] }];
  const d0 = discussionDigestOf({ deferrals: withKey });
  const d1 = discussionDigestOf({ deferrals: keyRemoved });
  assert.notEqual(d0, d1);
  const deferredOnly = previous({ findings: [], deferred: [{ ...F, key: F.key, deferredTo: 2100 }], discussionDigest: d0 });
  assert.notEqual(scopeOf(deferredOnly, current({ discussionDigest: d1, verifiedDeferralIssues: [2100] })).mode, 'reuse');
  // key 的顺序不影响
  const two = (a, b) => [{ issue: 2100, text: 't', keys: [{ key: a }, { key: b }] }];
  assert.equal(discussionDigestOf({ deferrals: two('a', 'b') }), discussionDigestOf({ deferrals: two('b', 'a') }));
});

test('同一 head、逐文件 patch 没变,但整份 diffHash 变了(base 前移)→ 不走新沿用分支', () => {
  const scope = scopeOf(previous(), current({ diffHash: 'changed' }));
  assert.notEqual(scope.reason, REASON);
  assert.equal(scope.mode, 'incremental');
});
