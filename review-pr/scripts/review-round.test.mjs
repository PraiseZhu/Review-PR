import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateList, validateCandidateList, makeReviewPlan, collectRoundResults, nextRoundState,
  explicitDependencies, parseReviewMode, createFixHandoffRequest, candidateFingerprint, FIX_WATCHDOG_MS } from './review-round.mjs';
import { buildReviewSummary, formatReviewCard, formatReviewCards } from './review-summary.mjs';
import { MERGE_RETRY_VERSION } from './merge-retry.mjs';

const now = Date.parse('2026-09-08T00:00:00Z');
const snapshot = (count) => Array.from({ length: count }, (_, i) => ({ number: i + 1,
  title: `修复 ${i + 1}`, url: `https://github.com/o/r/pull/${i + 1}`, createdAt: new Date(now + i).toISOString(),
  head: (i + 1).toString(16).padStart(40, '0'), headRefName: `pr-${i + 1}`, baseRefName: 'main',
  base: 'a'.repeat(40), updatedAt: new Date(now).toISOString(), isDraft: false, unresolved: 0, ci: 'SUCCESS',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED' }));
const contexts = (list) => list.map((p) => ({ ok: true, pr: p.number, meta: { state: 'OPEN', headRefOid: p.head }, dependencies: [] }));
const result = (plan, item, outcome = 'merged', extra = {}) => ({ runId: plan.runId, mode: plan.mode, pr: item.pr, head: item.head,
  enteredReview: true, reviewed: true, reviewClean: outcome !== 'findings' && extra.reviewed !== false,
  ...(outcome !== 'findings' && extra.reviewed !== false ? {
    approval: { status: 'verified', reviewId: 1, reviewer: 'fixture-maintainer', head: item.head, verifiedAt: new Date(now).toISOString() },
    reportFile: 'fixture-report.md' } : {}),
  merged: outcome === 'merged', outcome, reason: '已执行', ...extra });

test('released deferred gates keep history without overwriting shared state even before the next round finalizes', () => {
  const rows = snapshot(1);
  const manifest = createCandidateList({ repo: 'o/r', snapshot: rows, now, mode: 'review-only' });
  const plan = makeReviewPlan(manifest, contexts(rows));
  const item = plan.groups[0].prs[0];
  const deferred = { pr: item.pr, head: item.head, base: item.base, outcome: 'bot-pending' };
  const payload = { processed: [deferred] };
  const released = { 1: { reason: 'gate-deferred', roundId: plan.runId, ...deferred } };
  const previous = { version: 1, mode: 'review-only', prs: { 1: { outcome: 'approval', retry: false } } };
  assert.deepEqual(nextRoundState({ ...plan, released }, payload, previous, now), previous);
  assert.equal(nextRoundState({ ...plan, released }, payload, {}, now).prs[1], undefined);
  const wrongBinding = { 1: { ...released[1], head: 'other' } };
  assert.equal(nextRoundState({ ...plan, released: wrongBinding }, payload, previous, now).prs[1].outcome, 'bot-pending');
});

test('mode aliases preserve default and reject contradictory/invalid booleans', () => {
  assert.equal(parseReviewMode([]), 'auto');
  for (const args of [['--review-only'], ['reviewOnly=true'], ['--no-merge'], ['--review-only', 'true']]) assert.equal(parseReviewMode(args), 'review-only');
  assert.equal(parseReviewMode(['--review-only=false', 'reviewOnly=false']), 'auto');
  for (const args of [['--review-only', 'reviewOnly=false'], ['--review-only', 'maybe'], ['reviewOnly='], ['reviewOnly=maybe'], ['reviewOnly']]) assert.throws(() => parseReviewMode(args));
});

test('preflight wakes on status-only changes and failed attempts', () => {
  const rows = snapshot(1);
  const manifest = createCandidateList({ repo: 'o/r', snapshot: rows, now });
  const plan = makeReviewPlan(manifest, contexts(rows));
  const payload = collectRoundResults(plan, [result(plan, plan.groups[0].prs[0], 'ci-pending')]);
  const state = nextRoundState(plan, payload, {}, now);
  const select = (data = rows, time = now + 1, saved = state, mode = 'auto') => createCandidateList({ repo: 'o/r', snapshot: data, state: saved, now: time, mode });
  assert.equal(select().candidates.length, 0);
  for (const patch of [{ unresolved: 1 }, { ci: 'FAILURE' }, { reviewDecision: 'APPROVED' }, { head: 'b'.repeat(40) },
    { updatedAt: '2026-09-08T00:01:00Z' }, { base: 'c'.repeat(40) },
    { mergeable: 'CONFLICTING' }, { mergeStateStatus: 'DIRTY' }]) assert.equal(select([{ ...rows[0], ...patch }]).candidates.length, 1);
  assert.equal(select(rows, now + 365 * 24 * 60 * 60 * 1000).candidates.length, 0);
  assert.equal(select(rows, now + 1, state, 'review-only').candidates.length, 1);
  const failed = nextRoundState(plan, collectRoundResults(plan, [result(plan, plan.groups[0].prs[0], 'error')]), {}, now);
  assert.equal(select(rows, now + 1, failed).candidates.length, 1);
  const bot = nextRoundState(plan, collectRoundResults(plan, [result(plan, plan.groups[0].prs[0], 'bot-pending')]), {}, now);
  assert.equal(select(rows, now + 299_999, bot).candidates.length, 0);
  assert.equal(select(rows, now + 300_000, bot).candidates.length, 1);
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: [{ ...rows[0], isDraft: true }], now }).candidates.length, 0);
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: [], now }).candidates.length, 0);
});

test('candidate diagnostics identify changed fields and refresh unchanged baselines', () => {
  const rows = snapshot(1);
  const first = createCandidateList({ repo: 'o/r', snapshot: rows, now });
  assert.equal(first.candidateDiagnostics.baselineMissingCount, 1);
  assert.deepEqual(first.candidateDiagnostics.reasonCounts, { 'no-baseline': 1 });
  const plan = makeReviewPlan(first, contexts(rows));
  const saved = nextRoundState(plan, collectRoundResults(plan, [result(plan, plan.groups[0].prs[0], 'ci-pending')]), {}, now);
  assert.deepEqual(Object.keys(saved.prs[1].fingerprintFields).sort(), [
    'base', 'ci', 'dependencies', 'head', 'mergeStateStatus', 'mergeable', 'reviewDecision', 'unresolved', 'updatedAt',
  ]);
  const changedRows = [{ ...rows[0], ci: 'FAILURE', updatedAt: '2026-09-08T00:01:00Z' }];
  const changed = createCandidateList({ repo: 'o/r', snapshot: changedRows, state: saved, now: now + 1 });
  const diagnostics = changed.candidateDiagnostics;
  assert.equal(diagnostics.fingerprintChangedCount, 1);
  assert.deepEqual(diagnostics.changedFieldCounts, { ci: 1, updatedAt: 1 });
  assert.deepEqual(diagnostics.rows[0].changedFields, ['ci', 'updatedAt']);
  assert.equal(diagnostics.rows[0].before.ci, 'SUCCESS');
  assert.equal(diagnostics.rows[0].after.ci, 'FAILURE');
  assert.ok(diagnostics.rows[0].reasonCodes.includes('fingerprint-changed'));

  const unchanged = createCandidateList({ repo: 'o/r', snapshot: rows, state: saved, now: now + 1 });
  assert.equal(unchanged.candidates.length, 0);
  const unchangedPlan = makeReviewPlan(unchanged, contexts(rows));
  const refreshed = nextRoundState(unchangedPlan, collectRoundResults(unchangedPlan, []), saved, now + 2);
  assert.deepEqual(refreshed.prs[1].fingerprintFields, saved.prs[1].fingerprintFields);
});

test('transient GitHub UNKNOWN mergeability never wakes unchanged PRs', () => {
  const rows = snapshot(1);
  const first = createCandidateList({ repo: 'o/r', snapshot: rows, now });
  const plan = makeReviewPlan(first, contexts(rows));
  const saved = nextRoundState(plan, collectRoundResults(plan, [result(plan, plan.groups[0].prs[0], 'ci-pending')]), {}, now);
  const select = (data, state = saved) => createCandidateList({ repo: 'o/r', snapshot: data, state, now: now + 1 });
  const unknown = [{ ...rows[0], mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }];

  const transient = select(unknown);
  assert.equal(transient.candidates.length, 0);
  assert.equal(transient.skipped[0].fingerprint, saved.prs[1].fingerprint);
  assert.deepEqual([transient.skipped[0].fingerprintFields.mergeable, transient.skipped[0].fingerprintFields.mergeStateStatus],
    ['MERGEABLE', 'CLEAN']);
  for (const patch of [{ mergeable: 'UNKNOWN' }, { mergeStateStatus: 'UNKNOWN' }]) {
    assert.equal(select([{ ...rows[0], ...patch }]).candidates.length, 0);
  }
  assert.equal(select(rows).candidates.length, 0);

  const changedStable = [{ ...rows[0], mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }];
  assert.equal(select(changedStable).candidates.length, 1);
  const mixedReal = select([{ ...rows[0], mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' }]);
  assert.equal(mixedReal.candidates.length, 1);
  assert.deepEqual(mixedReal.candidateDiagnostics.rows[0].changedFields, ['mergeable']);

  const realChangeDuringUnknown = [{ ...unknown[0], ci: 'FAILURE' }];
  const real = select(realChangeDuringUnknown);
  assert.equal(real.candidates.length, 1);
  assert.deepEqual(real.candidateDiagnostics.rows[0].changedFields, ['ci']);
  assert.deepEqual([real.candidates[0].fingerprintFields.mergeable, real.candidates[0].fingerprintFields.mergeStateStatus],
    ['MERGEABLE', 'CLEAN']);
});

test('legacy UNKNOWN fingerprints stabilize without a migration review round', () => {
  const rows = snapshot(1);
  const unknown = [{ ...rows[0], mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }];
  const legacyPlan = makeReviewPlan(createCandidateList({ repo: 'o/r', snapshot: unknown, now }), contexts(unknown));
  const legacy = nextRoundState(legacyPlan,
    collectRoundResults(legacyPlan, [result(legacyPlan, legacyPlan.groups[0].prs[0], 'ci-pending')]), {}, now);
  delete legacy.prs[1].fingerprintFields;

  const stable = createCandidateList({ repo: 'o/r', snapshot: rows, state: legacy, now: now + 1 });
  assert.equal(stable.candidates.length, 0);
  assert.equal(stable.skipped[0].fingerprint, candidateFingerprint(rows[0], rows));

  const stablePlan = makeReviewPlan(stable, contexts(rows));
  const migrated = nextRoundState(stablePlan, collectRoundResults(stablePlan, []), legacy, now + 2);
  assert.deepEqual([migrated.prs[1].fingerprintFields.mergeable, migrated.prs[1].fingerprintFields.mergeStateStatus],
    ['MERGEABLE', 'CLEAN']);
  assert.equal(migrated.prs[1].fingerprint, candidateFingerprint(rows[0], rows));
});

test('transient merge failures re-enter unchanged snapshots and clear retry on a real blocker', () => {
  const rows = snapshot(1);
  const plan = makeReviewPlan(createCandidateList({ repo: 'o/r', snapshot: rows, now }), contexts(rows));
  const item = plan.groups[0].prs[0];
  const save = (extra, previous = {}, time = now) => nextRoundState(plan,
    collectRoundResults(plan, [result(plan, item, 'merge-blocked', extra)]), previous, time);
  const select = (state, mode = 'auto') => createCandidateList({ repo: 'o/r', snapshot: rows, state, mode, now: now + 60_000 });
  const transient = save({ retry: true, reason: 'GitHub 状态尚未稳定:UNKNOWN/UNKNOWN' });
  assert.equal(select(transient).candidates.length, 1);
  const blocked = save({ retry: false, reason: 'mergeable=CONFLICTING' }, transient, now + 1);
  assert.equal(select(blocked).candidates.length, 0);
  assert.equal(blocked.prs[1].retry, false);

  for (const reason of [
    '独立审查通过；guarded merge 时 GitHub mergeable/mergeStateStatus 变为 UNKNOWN，pre-merge-check 未授权普通 merge route。',
    'GitHub 状态尚未稳定:UNKNOWN/UNKNOWN',
    'code=base-merge-lock-busy', 'code=merge-reconciliation-pending',
    'PR #4443 的上次合并结果不明，必须先核验，不能并发重发',
  ]) {
    const legacy = save({ retry: false, reason });
    delete legacy.prs[1].mergeRetryVersion;
    assert.equal(select(legacy).candidates.length, 1, reason);
    const only = { ...legacy, mode: 'review-only' };
    assert.equal(select(only, 'review-only').candidates.length, 0);
    const classified = save({ retry: false, reason }, legacy);
    assert.equal(classified.prs[1].mergeRetryVersion, MERGE_RETRY_VERSION);
    assert.equal(select(classified).candidates.length, 0); // The legacy migration is one-shot.
  }
  for (const reason of ['mergeable=CONFLICTING', 'CI 失败', '权限不足', '缺少维护者 Approve', '线程未 resolve',
    'pre-merge-check 未授权普通 merge route', 'clean review, already approved; left until next round']) {
    const legacy = save({ retry: false, reason });
    legacy.prs[1].mergeRetryVersion = 1;
    assert.equal(select(legacy).candidates.length, 1, reason);
    const checked = save({ retry: false, reason }, legacy);
    assert.equal(select(checked).candidates.length, 0);
    // A recorded author-side cause is a real blocker, not an incomplete finish.
    legacy.prs[1].fixCause = 'ci-failed';
    assert.equal(select(legacy).candidates.length, 0);
  }
});

test('legacy stale-rebase results wake once for an author reminder and completed reminders stay quiet', () => {
  const rows = snapshot(1);
  const plan = makeReviewPlan(createCandidateList({ repo: 'o/r', snapshot: rows, now }), contexts(rows));
  const item = plan.groups[0].prs[0];
  const notice = { kind: 'stale-rebase', status: 'posted', head: item.head,
    fingerprint: 'f'.repeat(64), reason: '已提醒作者 rebase' };
  const blocked = result(plan, item, 'rebase', {
    enteredReview: false, reviewed: false, reviewClean: false, approval: undefined, authorNotice: notice,
  });
  const saved = nextRoundState(plan, collectRoundResults(plan, [blocked]), {}, now);
  assert.equal(saved.prs[1].authorNotice.status, 'posted');
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: rows, state: saved, now: now + 1 }).candidates.length, 0);

  const legacy = structuredClone(saved);
  delete legacy.prs[1].authorNotice;
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: rows, state: legacy, now: now + 1 }).candidates.length, 1);
  assert.throws(() => collectRoundResults(plan, [{ ...blocked, authorNotice: undefined }]), /作者提醒/);
  assert.throws(() => collectRoundResults(plan, [{ ...blocked,
    authorNotice: { kind: 'stale-rebase', status: 'failed', head: item.head, reason: '评论失败' } }]), /下轮重试/);

  const failed = { ...blocked, retry: true,
    authorNotice: { kind: 'stale-rebase', status: 'failed', head: item.head, reason: '评论失败' } };
  const failedState = nextRoundState(plan, collectRoundResults(plan, [failed]), {}, now);
  assert.equal(failedState.prs[1].retry, true);
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: rows, state: failedState, now: now + 1 }).candidates.length, 1);
});

test('protected-path results require an author notice and retry failed notices', () => {
  const rows = snapshot(1);
  const plan = makeReviewPlan(createCandidateList({ repo: 'o/r', snapshot: rows, now }), contexts(rows));
  const item = plan.groups[0].prs[0];
  const base = result(plan, item, 'protected', {
    enteredReview: false, reviewed: false, reviewClean: false, approval: undefined,
  });
  assert.throws(() => collectRoundResults(plan, [base]), /受保护路径作者提醒/);
  const posted = { ...base, authorNotice: {
    kind: 'protected-path', status: 'posted', head: item.head,
    fingerprint: '.github/PULL_REQUEST_TEMPLATE.md',
  } };
  const saved = nextRoundState(plan, collectRoundResults(plan, [posted]), {}, now);
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: rows, state: saved, now: now + 1 }).candidates.length, 0);
  const legacy = structuredClone(saved);
  delete legacy.prs[1].authorNotice;
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: rows, state: legacy, now: now + 1 }).candidates.length, 1);
  assert.throws(() => collectRoundResults(plan, [{ ...base, retry: false, authorNotice: {
    kind: 'protected-path', status: 'failed', head: item.head, reason: '评论失败',
  } }]), /下轮重试/);
  const suppressed = { ...base, authorNotice: {
    kind: 'protected-path', status: 'suppressed', head: item.head, reason: 'self-fix-author',
  } };
  assert.throws(() => collectRoundResults(plan, [suppressed]), /不是自有 PR/);
});

test('manifest is repo-bound, expires and detects tampering', () => {
  const manifest = createCandidateList({ repo: 'o/r', snapshot: snapshot(1), now });
  assert.equal(validateCandidateList(manifest, { repo: 'o/r', now }), manifest);
  assert.throws(() => validateCandidateList(manifest, { repo: 'other/repo', now }));
  assert.throws(() => validateCandidateList(manifest, { now: now + 3_600_001 }));
  assert.throws(() => validateCandidateList({ ...manifest, candidates: [] }, { now }));
});

test('clean review cannot hide a missing Approve; pending and legacy omissions wake on unchanged heads', () => {
  const rows = snapshot(1);
  const plan = makeReviewPlan(createCandidateList({ repo: 'o/r', snapshot: rows, now }), contexts(rows));
  const item = plan.groups[0].prs[0];
  const omitted = result(plan, item, 'approval', { approval: undefined });
  assert.throws(() => collectRoundResults(plan, [omitted]), /Approve/);
  assert.throws(() => collectRoundResults(plan, [result(plan, item, 'merged', { approval: { status: 'verified', head: item.head } })]), /回执/);
  const pending = result(plan, item, 'approval-pending', { approval: { status: 'pending', reason: 'POST 后连接中断，分页回查也失败' } });
  const payload = collectRoundResults(plan, [pending]);
  const saved = nextRoundState(plan, payload, {}, now);
  assert.equal(saved.prs[1].retry, true);
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: rows, state: saved, now: now + 60_000 }).candidates.length, 1);
  const legacy = structuredClone(saved); legacy.prs[1].retry = false; legacy.prs[1].outcome = 'approval'; delete legacy.prs[1].approval;
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: rows, state: legacy, now: now + 60_000 }).candidates.length, 1);
  const blocked = result(plan, item, 'approval', { approval: { status: 'blocked', code: 'viewer-is-author', reason: '不能批准自己的 PR' } });
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: rows, state: nextRoundState(plan, collectRoundResults(plan, [blocked]), {}, now), now: now + 1 }).candidates.length, 1);
  const evidence = { head: item.head, base: rows[0].base, baseRefName: 'main', diffHash: 'f'.repeat(64) };
  item.evidence = evidence;
  assert.throws(() => collectRoundResults(plan, [result(plan, item, 'merged')]), /证据/);
  assert.equal(collectRoundResults(plan, [result(plan, item, 'merged', { reviewEvidence: evidence })]).merge.merged.length, 1);
});

test('dependency classification excludes parents still open, closed-unmerged and cycles', () => {
  const rows = snapshot(28);
  const ctx = contexts(rows);
  ctx[0].dependencies = [{ repo: 'o/r', number: 2, state: 'OPEN' }];
  ctx[1].dependencies = [{ repo: 'o/r', number: 1, state: 'OPEN' }];
  ctx[2].dependencies = [{ repo: 'o/r', number: 29, state: 'CLOSED' }];
  ctx[3].meta.headRefOid = 'f'.repeat(40);
  ctx[4].meta.needsRetarget = true;
  ctx[5].dependencies = [{ repo: 'o/r', number: 30, state: 'MERGED' }];
  const plan = makeReviewPlan(createCandidateList({ repo: 'o/r', snapshot: rows, now }), ctx);
  assert.deepEqual(plan.groups.map((g) => g.prs.length), [10, 10, 3]);
  assert.deepEqual(plan.skipped.map((p) => p.outcome), ['dependency', 'dependency', 'dependency', 'state-changed', 'retarget']);
  assert.equal(plan.groups[0].prs[0].pr, 6);
  // Finishing the parent never adds a dependent back to the frozen groups.
  assert.equal(plan.groups.flatMap((g) => g.prs).some((p) => p.pr === 1), false);
});

test('explicit dependency syntax does not classify ordinary references', () => {
  assert.deepEqual(explicitDependencies('Fixes #1\nRelated to #2\nDepends on #3, o/r#4\n依赖：https://github.com/x/y/pull/9', 'o/r'), ['o/r#3', 'o/r#4', 'x/y#9']);
});

test('24-PR round covers every PR once; failures do not swallow other results', () => {
  const rows = snapshot(26); rows[24].isDraft = true; rows[25].isDraft = true;
  const ctx = contexts(rows);
  ctx[4].dependencies = [{ repo: 'o/r', number: 1, state: 'OPEN' }];
  ctx[5].meta.headRefOid = 'f'.repeat(40);
  const plan = makeReviewPlan(createCandidateList({ repo: 'o/r', snapshot: rows, now }), ctx);
  assert.deepEqual(plan.groups.map((g) => g.prs.length), [10, 10, 2]);
  const results = plan.groups.flatMap((g) => g.prs).map((p) => {
    const outcome = ({ 2: 'maintainer-signoff', 3: 'threads-unresolved', 4: 'threads-unresolved', 7: 'findings', 9: 'error' })[p.pr] || 'merged';
    return result(plan, p, outcome, [2, 3, 4, 9].includes(p.pr) ? { enteredReview: false, reviewed: false } : {});
  });
  const payload = collectRoundResults(plan, results);
  const summary = buildReviewSummary(payload);
  assert.deepEqual([summary.review.enteredCount, summary.review.notEnteredCount, summary.review.draftCount,
    summary.merge.mergedCount, summary.merge.notMergedCount, summary.coverageComplete], [18, 6, 2, 17, 7, true]);
  assert.deepEqual(summary.metrics, {
    currentPrCount: 26, candidateCount: 24, enteredCount: 18, mergedCount: 17, enteredNotMergedCount: 1,
  });
  assert.doesNotMatch(formatReviewCard(summary), /等待维护者确认（1）|存在未解决 thread（2）/);
  assert.throws(() => collectRoundResults(plan, results.slice(1)), /尚无终态/);
  assert.throws(() => collectRoundResults(plan, [...results, results[0]]), /重复/);
  assert.throws(() => collectRoundResults(plan, results.map((p, i) => i ? p : { ...p, runId: 'stale' })), /其他轮次/);
  assert.throws(() => collectRoundResults(plan, results.map((p) => p.pr === 3 ? { ...p, enteredReview: true } : p)), /前置门/);
  assert.throws(() => collectRoundResults({ ...plan, mode: 'review-only' }, results), /模式/);
  assert.throws(() => collectRoundResults(plan, results.map((p) => ({ ...p, mode: 'review-only' }))), /模式/);
  const reviewOnly = { ...plan, mode: 'review-only' };
  const onlySummary = buildReviewSummary(collectRoundResults(reviewOnly, results.map((p) => ({ ...p, mode: 'review-only',
    ...(p.merged ? { merged: false, outcome: 'review-only' } : {}) }))));
  assert.equal(onlySummary.merge.mergedCount, 0);
  assert.equal(onlySummary.merge.notMergedCount, 24);
});

test('failed cleanup after a confirmed merge preserves the merged fact', () => {
  const rows = snapshot(1);
  const plan = makeReviewPlan(createCandidateList({ repo: 'o/r', snapshot: rows, now }), contexts(rows));
  const payload = collectRoundResults(plan, [result(plan, plan.groups[0].prs[0], 'merged', { errors: ['agent 在合并确认后崩溃'] })]);
  assert.equal(payload.merge.merged.length, 1);
  assert.equal(payload.errors.length, 1);
});

test('own-PR blockers require a real handoff disposition while review-only and maintainer gates never dispatch', () => {
  const rows = snapshot(1);
  const ctx = contexts(rows); ctx[0].auto = { selfFix: true };
  const plan = makeReviewPlan(createCandidateList({ repo: 'o/r', snapshot: rows, now }), ctx);
  const item = plan.groups[0].prs[0];
  assert.equal(item.selfFix, true);
  const blocked = result(plan, item, 'threads-unresolved', { enteredReview: false, reviewed: false });
  const request = createFixHandoffRequest({ ...blocked, selfFix: item.selfFix });
  assert.equal(request.fingerprint, `${item.head}|skip-gate`); // Unresolved threads keep the legacy skip-gate binding.
  assert.throws(() => collectRoundResults(plan, [blocked]), /跟进/);
  assert.throws(() => collectRoundResults(plan, [{ ...blocked, fixHandoff: request }]), /跟进/);
  const receipt = { ...request, status: 'dispatched', sessionId: 'real-fixture-session', reason: '已投递修复卡点' };
  assert.throws(() => collectRoundResults(plan, [{ ...blocked, fixHandoff: { ...receipt, sessionId: '' } }]), /session ID/);
  assert.throws(() => collectRoundResults(plan, [{ ...blocked, fixHandoff: { ...receipt, fingerprint: 'wrong-head|skip-gate' } }]), /跟进/);
  const payload = collectRoundResults(plan, [{ ...blocked, fixHandoff: receipt }]);
  const summary = buildReviewSummary(payload);
  assert.equal(summary.review.enteredCount, 0);
  assert.equal(summary.merge.notMergedGroups[0].key, 'threads-unresolved');
  assert.equal(summary.merge.mergedCount, 0);
  assert.equal(summary.merge.notMerged[0].fixHandoff.status, 'dispatched');
  assert.doesNotMatch(formatReviewCard(summary), /已投递独立修复 session/);
  const saved = nextRoundState(plan, payload, {}, now);
  const unchanged = createCandidateList({ repo: 'o/r', snapshot: rows, state: saved, now: now + 1 });
  assert.equal(unchanged.candidates.length, 0);
  assert.equal(collectRoundResults(makeReviewPlan(unchanged, []), []).processed[0].fixHandoff.sessionId, receipt.sessionId);
  const failed = collectRoundResults(plan, [{ ...blocked, fixHandoff: { ...request, status: 'failed', reason: 'host unavailable' } }]);
  assert.equal(failed.errors.length, 1);
  assert.equal(createCandidateList({ repo: 'o/r', snapshot: rows, state: nextRoundState(plan, failed, {}, now), now: now + 1 }).candidates.length, 1);
  const deduped = collectRoundResults(plan, [{ ...blocked, fixHandoff: { ...receipt, status: 'deduplicated' } }]);
  assert.equal(buildReviewSummary(deduped).merge.notMerged[0].fixHandoff.status, 'deduplicated');
  assert.doesNotMatch(formatReviewCard(buildReviewSummary(deduped)), /同一卡点未重复投递/);
  for (const patch of [{ mode: 'review-only' }, { selfFix: false }, { outcome: 'maintainer-signoff' },
    { outcome: 'approval' }, { outcome: 'ci-pending' }, { outcome: 'ci-unknown' }, { outcome: 'dependency' },
    { outcome: 'protected' }, { outcome: 'bot-pending' }, { merged: true }]) {
    assert.equal(createFixHandoffRequest({ ...blocked, selfFix: true, ...patch }), null);
  }
  const onlyPlan = { ...plan, mode: 'review-only' };
  const onlyResult = { ...blocked, mode: 'review-only' };
  assert.equal(collectRoundResults(onlyPlan, [onlyResult]).processed.length, 1);
  assert.throws(() => collectRoundResults(onlyPlan, [{ ...onlyResult, fixHandoff: receipt }]), /不允许/);
  for (const outcome of ['security', 'format', 'findings', 'ci-failed', 'conflict', 'rebase', 'changes-requested']) {
    assert.equal(createFixHandoffRequest({ ...blocked, selfFix: true, outcome, base: rows[0].base }).status, 'requested');
  }
  assert.equal(createFixHandoffRequest({ ...blocked, selfFix: true, outcome: 'ci-failed' }).fingerprint, `${item.head}|skip-ci-failed`);
  assert.equal(createFixHandoffRequest({ ...blocked, selfFix: true, outcome: 'conflict', base: rows[0].base }).fingerprint,
    `${item.head}|skip-conflict|${rows[0].base}`);
  const lateThread = result(plan, item, 'merge-blocked', {
    fixCause: 'threads-unresolved', fixEvidence: { head: item.head, sourceFile: 'fixture-late-check.json', reason: '新到 1 条 thread' },
  });
  const lateRequest = createFixHandoffRequest({ ...lateThread, selfFix: true });
  assert.equal(lateRequest.fingerprint, `${item.head}|skip-gate`);
  const lateConflict = result(plan, item, 'merge-blocked', {
    fixCause: 'conflict',
    fixEvidence: { head: item.head, sourceFile: 'fixture-late-check.json', reason: '与 base 冲突' },
    base: rows[0].base,
  });
  assert.equal(createFixHandoffRequest({ ...lateConflict, selfFix: true }).fingerprint, `${item.head}|skip-conflict|${rows[0].base}`);
  assert.throws(() => collectRoundResults(plan, [lateThread]), /跟进/);
  const latePayload = collectRoundResults(plan, [{ ...lateThread, fixHandoff: { ...receipt, ...lateRequest, status: 'dispatched' } }]);
  assert.equal(latePayload.review.entered.length, 1);
  assert.equal(latePayload.processed[0].outcome, 'merge-blocked');
  assert.equal(createFixHandoffRequest({ ...lateThread, selfFix: true, fixCause: undefined }), null);
  assert.throws(() => createFixHandoffRequest({ ...lateThread, selfFix: true, fixCause: 'approval' }), /无效/);
  assert.throws(() => createFixHandoffRequest({ ...lateThread, selfFix: true, fixEvidence: null }), /证据/);
  assert.throws(() => createFixHandoffRequest({ ...lateThread, selfFix: true,
    fixEvidence: { ...lateThread.fixEvidence, head: 'changed' } }), /证据/);
  assert.equal(createFixHandoffRequest({ ...lateThread, selfFix: true, mode: 'review-only' }), null);
  const needsHuman = collectRoundResults(plan, [{ ...blocked, fixHandoff: { ...receipt, status: 'needs-human', reason: '跟进会话请维护者裁定' } }]);
  assert.equal(needsHuman.processed[0].fixHandoff.status, 'needs-human');
  assert.equal(needsHuman.errors.length, 0);
});

test('own-PR watchdog wakes a stalled fix session once, then stops after needs-human', () => {
  const rows = snapshot(1);
  const ctx = contexts(rows); ctx[0].auto = { selfFix: true };
  const plan = makeReviewPlan(createCandidateList({ repo: 'o/r', snapshot: rows, now }), ctx);
  const item = plan.groups[0].prs[0];
  const blocked = result(plan, item, 'threads-unresolved', { enteredReview: false, reviewed: false });
  const request = createFixHandoffRequest({ ...blocked, selfFix: true });
  const receipt = { ...request, status: 'dispatched', sessionId: 'real-fixture-session', reason: '已投递',
    dispatchedAt: new Date(now).toISOString(), nudgeCount: 0 };
  const saved = nextRoundState(plan, collectRoundResults(plan, [{ ...blocked, fixHandoff: receipt }]), {}, now);
  const fresh = createCandidateList({ repo: 'o/r', snapshot: rows, state: saved, now: now + 1, fixSessions: {
    1: { sessionId: receipt.sessionId, fingerprint: request.fingerprint, dispatchedAt: receipt.dispatchedAt, nudgeCount: 0 },
  } });
  assert.equal(fresh.candidates.length, 0);
  const nudge = createCandidateList({ repo: 'o/r', snapshot: rows, state: saved, now: now + FIX_WATCHDOG_MS, fixSessions: {
    1: { sessionId: receipt.sessionId, fingerprint: request.fingerprint, dispatchedAt: receipt.dispatchedAt, nudgeCount: 0 },
  } });
  assert.equal(nudge.candidates.length, 1);
  assert.ok(nudge.candidateDiagnostics.rows[0].reasonCodes.includes('fix-watchdog'));
  const stalled = createCandidateList({ repo: 'o/r', snapshot: rows, state: saved, now: now + FIX_WATCHDOG_MS * 2, fixSessions: {
    1: { sessionId: receipt.sessionId, fingerprint: request.fingerprint,
      dispatchedAt: new Date(now + FIX_WATCHDOG_MS).toISOString(), nudgeCount: 1 },
  } });
  assert.equal(stalled.candidates.length, 1);
  const human = createCandidateList({ repo: 'o/r', snapshot: rows, state: saved, now: now + FIX_WATCHDOG_MS * 3, fixSessions: {
    1: { sessionId: receipt.sessionId, fingerprint: request.fingerprint,
      dispatchedAt: new Date(now + FIX_WATCHDOG_MS).toISOString(), nudgeCount: 1, needsHuman: true },
  } });
  assert.equal(human.candidates.length, 0);
});

test('coverage cannot be faked with declared counts and duplicate membership', () => {
  const summary = buildReviewSummary({ review: { eligibleCount: 2, entered: [{ pr: 1 }], notEnteredCount: 1 } });
  assert.equal(summary.review.coverageComplete, false);
  assert.throws(() => buildReviewSummary({ strictCoverage: true, review: { eligibleCount: 2, entered: [{ pr: 1 }], notEntered: [{ pr: 1 }] } }));
});

test('large Chinese summaries stay in one card and omit unmerged detail', () => {
  const rows = snapshot(450);
  const items = rows.map((p) => ({ ...p, pr: p.number, outcome: 'findings', reason: '发现需要修改的问题，见审查线程。'.repeat(15) }));
  const summary = buildReviewSummary({ strictCoverage: true, mode: 'auto', review: { eligibleCount: items.length, entered: items, notEntered: [] },
    merge: { merged: [], notMerged: items } });
  const pages = formatReviewCards(summary);
  assert.equal(pages.length, 1);
  const serialized = JSON.stringify(pages[0].card);
  assert.match(serialized, /本轮没有合并 PR/);
  for (const p of rows) assert.doesNotMatch(serialized, new RegExp(`pull/${p.number}(?:"|\\))`));
  assert.ok(Buffer.byteLength(serialized) <= 28_000);
  const escaped = buildReviewSummary({ mode: 'auto', notes: Array(100).fill('Windows "错误" C:\\path\\folder\\failed '.repeat(20)) });
  assert.equal(formatReviewCards(escaped).length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(formatReviewCards(escaped)[0].card)) <= 28_000);
});
