// Mini 侧的收口补跑游标(#100):待补/收口失败 → 记 pendingFinalFull;同 head 下一次派发的 prev_run_id 指向那次运行,服务器据此直接全量;
// 全量真的做完才清;普通失败不覆盖;新 head 不消费旧 head 的游标。
// round.mjs 是脚本(import 即运行 main),这里按函数名从源码里取出纯函数,注入真实的 previousFromResult;不做 I/O。
// 另用真实的 review-round.mjs(collectRoundResults / nextRoundState)证明待补包(error + retry)能被收尾,并让同 head 被判为需要重试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { previousFromResult, computeReviewScope } from '../lib/scope.mjs';
import { createCandidateList, makeReviewPlan, collectRoundResults, nextRoundState } from '../../review-pr/scripts/review-round.mjs';

const source = readFileSync(fileURLToPath(new URL('./round.mjs', import.meta.url)), 'utf8');
function extract(name) {
  const start = new RegExp(`^function\\s+${name}\\s*\\(`, 'm').exec(source);
  assert.ok(start, `round.mjs 缺少函数 ${name}`);
  const end = /^\}/m.exec(source.slice(start.index));
  return source.slice(start.index, start.index + end.index + 1);
}
const { finalFullStorePatch, previousRunIdFor } = new Function('previousFromResult',
  `${extract('finalFullStorePatch')}\n${extract('previousRunIdFor')}\nreturn { finalFullStorePatch, previousRunIdFor };`)(previousFromResult);

const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const pending = (over = {}, mivo = {}) => ({
  pr: 7, head: HEAD, outcome: 'error', retry: true, enteredReview: true, reviewed: false, reviewClean: false, merged: false, reason: '收口待补:剩余模型预算不足',
  mivo: { runId: '77', reportComplete: false, finalFull: { head: HEAD, runId: '77', outcome: 'pending-budget' },
    finalFullContext: { kind: 'same-run', findingFiles: [], previousRound: null }, scope: { mode: 'incremental', previousFindings: [] }, ...mivo }, ...over,
});
const completed = (outcome = 'clean', over = {}) => ({
  pr: 7, head: HEAD, outcome: 'approval', reviewed: true, reviewClean: true, mivo: { runId: '88', reportComplete: true,
    finalFull: { head: HEAD, runId: '88', outcome }, finalFullContext: { kind: 'budget-retry', findingFiles: [], previousRound: null } }, ...over,
});

test('待补包 → 记游标 { head, runId };已缓存的 cleanHead(同 head)一并清掉,旧的干净缓存不能抑制补跑', () => {
  assert.deepEqual(finalFullStorePatch({ server: pending(), head: HEAD, record: {}, runId: '1' }), { pendingFinalFull: { head: HEAD, runId: '77' } });
  assert.deepEqual(finalFullStorePatch({ server: pending(), head: HEAD, record: { cleanHead: HEAD }, runId: '1' }),
    { pendingFinalFull: { head: HEAD, runId: '77' }, cleanHead: null });
  assert.deepEqual(finalFullStorePatch({ server: pending(), head: HEAD, record: { cleanHead: OTHER }, runId: '1' }), { pendingFinalFull: { head: HEAD, runId: '77' } }, '别的 head 的 cleanHead 不动');
});

test('收口开始后失败(finalFull=error)同样记游标;畸形或身份不一致的标记不记', () => {
  const failed = pending({}, { finalFull: { head: HEAD, runId: '77', outcome: 'error' } });
  assert.equal(finalFullStorePatch({ server: failed, head: HEAD, record: {}, runId: '1' }).pendingFinalFull.runId, '77');
  for (const bad of [pending({ retry: false }), pending({}, { runId: '5' }), pending({}, { finalFull: { head: OTHER, runId: '77', outcome: 'pending-budget' } }),
    pending({}, { finalFullContext: { kind: 'direct-full', findingFiles: [], previousRound: null } }), pending({ head: OTHER })]) {
    assert.deepEqual(finalFullStorePatch({ server: bad, head: HEAD, record: {}, runId: '1' }), {});
  }
});

test('同 head 全量真的做完(clean / findings / manual-review)→ 清游标;顶层 error(发布失败)或别的 head 不清', () => {
  const record = { pendingFinalFull: { head: HEAD, runId: '77' } };
  for (const outcome of ['clean', 'findings', 'manual-review']) {
    assert.deepEqual(finalFullStorePatch({ server: completed(outcome), head: HEAD, record, runId: '88' }), { pendingFinalFull: null }, outcome);
  }
  assert.deepEqual(finalFullStorePatch({ server: completed('clean', { outcome: 'error' }), head: HEAD, record, runId: '88' }), {}, '发布失败仍可重试,义务不撤');
  assert.deepEqual(finalFullStorePatch({ server: completed('clean'), head: OTHER, record, runId: '88' }), {});
  assert.deepEqual(finalFullStorePatch({ server: completed('clean'), head: HEAD, record: {}, runId: '88' }), {}, '没有游标就没有东西可清');
});

test('普通失败(无结果记录)不动游标:后一次失败不能覆盖待补', () => {
  const generic = { pr: 7, head: HEAD, outcome: 'error', retry: true, reviewed: false, mivo: { runId: '99' } };
  assert.deepEqual(finalFullStorePatch({ server: generic, head: HEAD, record: { pendingFinalFull: { head: HEAD, runId: '77' } }, runId: '99' }), {});
});

test('prev_run_id:同 head 有游标就指向待补那次运行,否则最近一次完整结果;新 head 不消费旧 head 的游标', () => {
  const record = { lastCompleteRunId: '50', pendingFinalFull: { head: HEAD, runId: '77' } };
  assert.equal(previousRunIdFor(record, HEAD), '77');
  assert.equal(previousRunIdFor(record, OTHER), '50');
  assert.equal(previousRunIdFor({ pendingFinalFull: { head: HEAD, runId: 'bad' } }, HEAD), '');
  assert.equal(previousRunIdFor({}, HEAD), '');
  assert.equal(previousRunIdFor(undefined, HEAD), '');
});

test('接线:dispatchReview 用 previousRunIdFor 取 prev_run_id;collectServerRun 合并游标 patch,lastCompleteRunId 仍只认完整结果', () => {
  const dispatch = extract('dispatchReview');
  assert.match(dispatch, /const prevRunId = previousRunIdFor\(record, task\.head\);/);
  assert.match(dispatch, /prev_run_id: String\(prevRunId\)/);
  const collect = /^function collectServerRun\b[\s\S]*?^\}/m.exec(source)[0];
  assert.match(collect, /\.\.\.finalFullStorePatch\(\{ server, head: task\.head, record: loadStore\(\)\.prs\[task\.pr\] \?\? \{\}, runId: entry\.runId \}\)/);
  assert.match(collect, /server\.reviewed && server\.mivo\?\.reportComplete \? \{ lastCompleteRunId: entry\.runId \}/);
});

// ── 真实收尾器:待补包(error + retry)能被 review-round 收尾,且让同 head 被判为需要重试(不被 unchanged 跳过) ──
const now = Date.parse('2026-10-21T00:00:00Z');
const rows = [{ number: 7, title: 't', url: 'https://github.com/o/r/pull/7', createdAt: new Date(now).toISOString(), head: HEAD, headRefName: 'pr-7', baseRefName: 'main',
  base: 'a'.repeat(40), updatedAt: new Date(now).toISOString(), isDraft: false, unresolved: 0, ci: 'SUCCESS', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED' }];

test('真实收尾器:待补包被接受,下一轮同 head 仍是候选(retry),不会因 unchanged 被跳过', () => {
  const manifest = createCandidateList({ repo: 'o/r', snapshot: rows, now, mode: 'review-only' });
  const plan = makeReviewPlan(manifest, rows.map((p) => ({ ok: true, pr: p.number, meta: { state: 'OPEN', headRefOid: p.head }, dependencies: [] })));
  const item = plan.groups[0].prs[0];
  const server = { ...pending(), runId: plan.runId, mode: plan.mode, base: item.base, errors: [], warnings: [], threadUrls: [] };
  const payload = collectRoundResults(plan, [server]);
  const state = nextRoundState(plan, payload, {}, now);
  assert.equal(state.prs[7].retry, true);
  assert.equal(state.prs[7].outcome, 'error');
  const next = createCandidateList({ repo: 'o/r', snapshot: rows, state, now: now + 1, mode: 'review-only' });
  assert.equal(next.candidates.length, 1, '同 head 下一轮仍会进候选');
});

// ── 端到端串起来:待补包 → 游标 → 下一次派发的 prev_run_id → 服务器范围判定直接全量 ──
test('端到端:待补 → prev_run_id=待补那次运行 → 服务器按待补包算范围,直接全量并带真实前轮', () => {
  const result = pending({}, { scope: { mode: 'incremental', previousFindings: [{ path: 'src/a.ts', body: '[P1] 旧问题', key: 'k1' }] },
    finalFullContext: { kind: 'same-run', findingFiles: [], previousRound: { roundIndex: 2, findings: [], keys: ['k1'] } } });
  const record = { lastCompleteRunId: '50', ...finalFullStorePatch({ server: result, head: HEAD, record: {}, runId: '77' }) };
  assert.equal(previousRunIdFor(record, HEAD), '77');
  const previous = previousFromResult(result, '');
  const current = { head: HEAD, baseRefName: 'main', diffHash: 'd1', filePatchHashes: { 'src/a.ts': 'x' }, totalDiffLines: 3, tier: 'standard', triggerKinds: [],
    specDigest: 's', now };
  const scope = computeReviewScope({ previous, current, headIsDescendant: null });
  assert.equal(scope.mode, 'full');
  assert.equal(scope.purpose, 'final-full');
  assert.deepEqual(scope.previousFindings.map((f) => f.key), ['k1']);
});
