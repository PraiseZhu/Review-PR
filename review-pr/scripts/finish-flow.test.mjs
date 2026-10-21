import assert from 'node:assert/strict';
import { finishReviewedPr } from './finish-flow.mjs';
import { REVIEW_CHANGES_REQUESTED_BLOCKER } from './merge-retry.mjs';

const base = { mode: 'auto', pr: 7, head: 'a'.repeat(40), authorityDigest: 'digest', lockToken: 'lock', method: 'squash' };
const approval = { ok: true, approved: true, approval: { status: 'verified', reviewId: '123', reviewer: 'maintainer',
  head: base.head, verifiedAt: '2026-09-08T00:00:00.000Z' } };
const release = { ok: true, labels: { errors: [] } };
const pass = { ok: true, canMerge: true, normalMergeAvailable: true, state: 'OPEN', headVerified: true,
  baseVerified: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', blockClass: 'none', blockers: [],
  authorityVerified: true, threadsVerified: true, unresolvedThreads: [], ci: { status: 'pass' },
  botSettleVerified: true, botSettle: { settled: true }, staleRebaseChecked: true, staleRebase: { blocking: false },
  pendingSignoffLabels: [], protectedFiles: [], reviewDecision: 'APPROVED' };
const unknown = { ...pass, canMerge: false, normalMergeAvailable: false,
  mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', mergeableUnknown: true };

async function runCase(options, results) {
  const calls = [];
  const result = await finishReviewedPr(options, { run: async (script) => {
    calls.push(script);
    const next = results[script];
    return typeof next === 'function' ? next(calls) : next;
  }, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1); })() });
  return { result, calls };
}

{
  const { result, calls } = await runCase(base, {
    'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release,
    'pre-merge-check.mjs': pass, 'merge-reviewed-pr.mjs': { ok: true, merged: true },
  });
  assert.equal(result.stage, 'merged');
  assert.deepEqual(result.approval, approval.approval);
  assert.deepEqual(calls, ['approve-reviewed-pr.mjs', 'signoff-release.mjs', 'pre-merge-check.mjs', 'merge-reviewed-pr.mjs']);
}

{
  for (const response of [{ ok: true, approved: true }, { ok: false, error: 'subprocess timed out' },
    { ok: true, approved: false, approval: { status: 'pending', code: 'approval-receipt-pending', reason: 'response lost' } }]) {
    const { result, calls } = await runCase(base, { 'approve-reviewed-pr.mjs': response });
    assert.equal(result.stage, 'approval-pending');
    assert.equal(result.approval.status, 'pending');
    assert.equal(result.retry, true);
    assert.equal(calls.length, 1); // Never release labels, check merge gates, or merge without a receipt.
  }
  const { result, calls } = await runCase(base, { 'approve-reviewed-pr.mjs': {
    ok: true, approved: false, approval: { status: 'blocked', code: 'self-author', reason: '需另一位维护者' },
  } });
  assert.equal(result.stage, 'approval-blocked');
  assert.equal(result.approval.code, 'self-author');
  assert.equal(calls.length, 1);
}

{
  const observed = [];
  const result = await finishReviewedPr({ ...base, expectedBase: 'b'.repeat(40), expectedBaseRef: 'main' }, {
    run: async (script, args) => {
      observed.push({ script, args });
      return { 'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release,
        'pre-merge-check.mjs': { ...pass, baseVerified: false, canMerge: false, normalMergeAvailable: false,
          blockers: ['base changed'] } }[script];
    }, sleep: async () => { throw new Error('must not wait away a changed base'); },
  });
  assert.equal(result.stage, 'merge-blocked');
  assert.equal(result.approval.status, 'verified');
  assert.equal(observed.some((call) => call.script === 'merge-reviewed-pr.mjs'), false);
  assert.ok(observed.every((call) => call.args.includes('--expected-base')));
  assert.ok(observed.every((call) => call.args.includes('--expected-base-ref') && call.args.includes('main')));
  assert.equal(result.expectedBaseRef, 'main');
}

{
  const { result, calls } = await runCase({ ...base, mode: 'review-only' }, {
    'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release, 'pre-merge-check.mjs': pass,
    'merge-reviewed-pr.mjs': { ok: true, merged: true },
  });
  assert.equal(result.stage, 'reviewed-only');
  assert.equal(calls.includes('merge-reviewed-pr.mjs'), false);
}

{
  const pending = { ...pass, canMerge: false, normalMergeAvailable: false, ci: { status: 'pending' },
    blockers: ['CI pending'], blockClass: 'ci-pending' };
  const { result, calls } = await runCase(base, {
    'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release, 'pre-merge-check.mjs': pending,
  });
  assert.equal(result.stage, 'merge-blocked');
  assert.equal(calls.includes('merge-reviewed-pr.mjs'), false);
}

{
  const changed = { ...pass, canMerge: false, normalMergeAvailable: false, headVerified: false,
    blockers: ['head changed'], blockClass: 'head-changed' };
  const { result, calls } = await runCase(base, {
    'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release, 'pre-merge-check.mjs': changed,
  });
  assert.equal(result.stage, 'merge-blocked');
  assert.equal(calls.includes('merge-reviewed-pr.mjs'), false);
}

{
  const { result, calls } = await runCase(base, {
    'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': { ok: false, labelWarning: 'label failed' },
    'pre-merge-check.mjs': pass,
  });
  assert.equal(result.stage, 'label-sync-blocked');
  assert.equal(calls.includes('pre-merge-check.mjs'), false);
}

{
  const { result, calls } = await runCase(base, {
    'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release, 'pre-merge-check.mjs': unknown,
  });
  assert.equal(result.stage, 'merge-blocked');
  assert.equal(result.retry, true);
  assert.equal(result.checks, 4); // Initial check plus three bounded reads, then leave the round.
  assert.equal(calls.includes('merge-reviewed-pr.mjs'), false);

  const recovered = await runCase(base, {
    'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release,
    'pre-merge-check.mjs': (seen) => seen.filter((s) => s === 'pre-merge-check.mjs').length === 1 ? unknown : pass,
    'merge-reviewed-pr.mjs': { ok: true, merged: true },
  });
  assert.equal(recovered.result.stage, 'merged');
  assert.equal(recovered.result.retry, false);
  assert.equal(recovered.calls.filter((s) => s === 'merge-reviewed-pr.mjs').length, 1);
}

{
  // The first check passed, but the inner check saw UNKNOWN while taking the base lock (#4484).
  for (const merge of [
    { ok: true, merged: false, preMerge: unknown },
    { ok: true, merged: false, pending: true, retry: true, code: 'base-merge-lock-busy' },
    { ok: false, merged: false, pending: true, retry: true, code: 'merge-reconciliation-pending' },
  ]) {
    const { result, calls } = await runCase(base, {
      'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release,
      'pre-merge-check.mjs': pass, 'merge-reviewed-pr.mjs': merge,
    });
    assert.equal(result.stage, 'merge-blocked');
    assert.equal(result.retry, true);
    assert.equal(result.approval.status, 'verified');
    assert.equal(calls.filter((s) => s === 'merge-reviewed-pr.mjs').length, 1);
  }
}

{
  const ownRefresh = { ...pass, canMerge: false, normalMergeAvailable: false, actualHead: base.head,
    reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED', blockClass: 'review-changes-requested',
    blockers: [REVIEW_CHANGES_REQUESTED_BLOCKER], approvalPolicy: { viewer: 'maintainer' },
    reviewSnapshot: { verified: true, latest: [{ reviewId: '123', reviewer: 'maintainer', state: 'APPROVED', head: base.head }] } };
  const recovered = await runCase(base, {
    'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release,
    'pre-merge-check.mjs': calls => calls.filter(s => s === 'pre-merge-check.mjs').length === 1 ? ownRefresh : pass,
    'merge-reviewed-pr.mjs': { ok: true, merged: true },
  });
  assert.equal(recovered.result.merged, true);
  assert.equal(recovered.result.checks, 2);
  assert.equal(recovered.calls.filter(s => s === 'approve-reviewed-pr.mjs').length, 1);
  const stillLagging = await runCase(base, {
    'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release, 'pre-merge-check.mjs': ownRefresh,
  });
  assert.equal(stillLagging.result.checks, 4);
  assert.equal(stillLagging.result.retry, true);
  for (const patch of [
    { reviewSnapshot: { verified: false, latest: ownRefresh.reviewSnapshot.latest } },
    { reviewSnapshot: { verified: true, latest: [{ ...ownRefresh.reviewSnapshot.latest[0], reviewId: '124' }] } },
    { reviewSnapshot: { verified: true, latest: [{ ...ownRefresh.reviewSnapshot.latest[0], head: 'b'.repeat(40) }] } },
    { reviewSnapshot: { verified: true, latest: [...ownRefresh.reviewSnapshot.latest, { reviewer: 'other', state: 'CHANGES_REQUESTED' }] } },
    { reviewSnapshot: { verified: true, latest: [{ ...ownRefresh.reviewSnapshot.latest[0], state: 'CHANGES_REQUESTED' }] } },
    { approvalPolicy: { viewer: 'another-maintainer' } },
    { actualHead: 'b'.repeat(40) }, { ci: { status: 'failed' } },
    { baseVerified: false }, { authorityVerified: false }, { unresolvedThreads: [{}] },
    { blockers: [REVIEW_CHANGES_REQUESTED_BLOCKER, 'another branch requirement'] },
  ]) {
    const blocked = await runCase(base, {
      'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release, 'pre-merge-check.mjs': { ...ownRefresh, ...patch },
    });
    assert.equal(blocked.result.checks, 1, JSON.stringify(patch));
    assert.equal(blocked.result.retry, false);
    assert.equal(blocked.calls.includes('merge-reviewed-pr.mjs'), false);
  }
}

{
  const preWriteFailures = [
    { ok: true, merged: false, mergeAttempted: false, preMerge: unknown, retry: true },
    { ok: true, merged: false, mergeAttempted: false, code: 'base-merge-lock-busy', pending: true, retry: true },
  ];
  for (const failure of preWriteFailures) {
    const recovered = await runCase(base, {
      'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release, 'pre-merge-check.mjs': pass,
      'merge-reviewed-pr.mjs': calls => calls.filter(s => s === 'merge-reviewed-pr.mjs').length === 1 ? failure : { ok: true, merged: true },
    });
    assert.equal(recovered.result.merged, true);
    assert.equal(recovered.result.checks, 2);
    assert.equal(recovered.result.mergeAttempts, 2);
    const exhausted = await runCase(base, {
      'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release, 'pre-merge-check.mjs': pass, 'merge-reviewed-pr.mjs': failure,
    });
    assert.equal(exhausted.result.mergeAttempts, 4);
    assert.equal(exhausted.result.retry, true);
    const newlyBlocked = await runCase(base, {
      'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release,
      'pre-merge-check.mjs': calls => calls.filter(s => s === 'pre-merge-check.mjs').length === 1 ? pass :
        { ...pass, canMerge: false, normalMergeAvailable: false, ci: { status: 'failed' }, blockers: ['CI failed'], blockClass: 'ci-failed' },
      'merge-reviewed-pr.mjs': failure,
    });
    assert.equal(newlyBlocked.result.mergeAttempts, 1);
    assert.equal(newlyBlocked.result.retry, false);
    assert.equal(newlyBlocked.result.merge, undefined);
  }
  for (const failure of [
    { ok: false, merged: false, error: 'child timed out; write status unknown' },
    { ok: false, merged: false, mergeAttempted: true, pending: true, retry: true, code: 'merge-reconciliation-pending' },
    { ok: false, merged: false, mergeAttempted: false, pending: true, retry: true, code: 'merge-reconciliation-pending' },
    { ok: true, merged: false, retry: true, preMerge: unknown }, // No proof that a write was not attempted.
  ]) {
    const uncertain = await runCase(base, {
      'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release, 'pre-merge-check.mjs': pass, 'merge-reviewed-pr.mjs': failure,
    });
    assert.equal(uncertain.result.mergeAttempts, 1);
    assert.equal(uncertain.result.retry, true);
    assert.equal(uncertain.calls.filter(s => s === 'pre-merge-check.mjs').length, 1);
  }
}

{
  for (const patch of [
    { headVerified: false }, { baseVerified: false }, { authorityVerified: false },
    { state: 'CLOSED' }, { threadsVerified: false }, { unresolvedThreads: [{}] },
    { ci: { status: 'failed' } }, { ci: { status: 'pending' } },
    { botSettleVerified: false }, { botSettle: { settled: false } },
    { staleRebaseChecked: false }, { staleRebase: { blocking: true } },
    { pendingSignoffLabels: ['awaiting-discussion'] }, { protectedFiles: ['.github/CODEOWNERS'] },
    { reviewDecision: 'CHANGES_REQUESTED' }, { reviewDecision: 'REVIEW_REQUIRED' },
    { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    { blockers: ['branch rule'], blockClass: 'structural-check' },
  ]) {
    const { result, calls } = await runCase(base, {
      'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release,
      'pre-merge-check.mjs': { ...unknown, ...patch },
    });
    assert.equal(result.stage, 'merge-blocked');
    assert.equal(result.retry, false, JSON.stringify(patch));
    assert.equal(calls.includes('merge-reviewed-pr.mjs'), false);
  }
  const only = await runCase({ ...base, mode: 'review-only' }, {
    'approve-reviewed-pr.mjs': approval, 'signoff-release.mjs': release, 'pre-merge-check.mjs': unknown,
  });
  assert.equal(only.result.stage, 'reviewed-only');
  assert.notEqual(only.result.retry, true);
  assert.equal(only.calls.includes('merge-reviewed-pr.mjs'), false);
}

{
  const digest = `sha256:${'a'.repeat(64)}`;
  const exempt = {
    ok: true, approved: false, approvalSatisfied: true,
    approval: {
      status: 'exempt', author: 'praisezhu', head: base.head, authorityDigest: digest,
      source: 'maintainer-allowlist', reason: '按 2026-10-21 维护者决定免另一位维护者独立 Approve',
    },
    approvalPolicy: { author: 'praisezhu', authorIsMaintainer: true, approvalRequired: false, authorityDigest: digest },
  };
  const { result, calls } = await runCase({ ...base, authorityDigest: digest, mode: 'review-only' }, {
    'approve-reviewed-pr.mjs': exempt, 'signoff-release.mjs': release, 'pre-merge-check.mjs': pass,
    'merge-reviewed-pr.mjs': { ok: true, merged: true },
  });
  assert.equal(result.stage, 'reviewed-only');
  assert.equal(result.approved, false);
  assert.equal(result.approvalSatisfied, true);
  assert.equal(result.approval.status, 'exempt');
  assert.equal(calls.includes('merge-reviewed-pr.mjs'), false);

  const merged = await runCase({ ...base, authorityDigest: digest }, {
    'approve-reviewed-pr.mjs': exempt, 'signoff-release.mjs': release, 'pre-merge-check.mjs': pass,
    'merge-reviewed-pr.mjs': { ok: true, merged: true },
  });
  assert.equal(merged.result.stage, 'merged');
  assert.equal(merged.result.approved, false);
  assert.equal(merged.result.approval.status, 'exempt');

  const mismatch = await runCase({ ...base, authorityDigest: digest }, {
    'approve-reviewed-pr.mjs': { ...exempt, approvalPolicy: { ...exempt.approvalPolicy, approvalRequired: true } },
  });
  assert.equal(mismatch.result.approval.status, 'pending');
  assert.equal(mismatch.calls.length, 1);

  const fakeApproved = await runCase({ ...base, authorityDigest: digest }, {
    'approve-reviewed-pr.mjs': { ...exempt, approved: true },
  });
  assert.equal(fakeApproved.result.approval.status, 'pending');
}

console.log('finish-flow.test.mjs: 全部通过');

