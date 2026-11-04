// [MIVO-PATCH reviewer-app] 审查 App 发完审查后的收尾:不执行任何维护者才有的签核释放。
import test from 'node:test';
import assert from 'node:assert/strict';
import { finishReviewedPr } from './finish-flow.mjs';

const head = 'a'.repeat(40);
const base = { mode: 'review-only', pr: 7, head, authorityDigest: `sha256:${'d'.repeat(64)}`, lockToken: 'lock', method: 'squash' };
const verified = (policy) => ({ ok: true, approved: true,
  approval: { status: 'verified', reviewId: '123', reviewer: 'praisebuild[bot]', head, verifiedAt: '2026-11-04T00:00:00.000Z' },
  approvalPolicy: policy });
const pass = { ok: true, canMerge: false, normalMergeAvailable: false, state: 'OPEN', headVerified: true,
  baseVerified: true, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', blockClass: 'none', blockers: [],
  authorityVerified: true, threadsVerified: true, unresolvedThreads: [], ci: { status: 'pass' },
  botSettleVerified: true, botSettle: { settled: true }, staleRebaseChecked: true, staleRebase: { blocking: false },
  pendingSignoffLabels: [], protectedFiles: [], reviewDecision: 'REVIEW_REQUIRED',
  blockedAwaitingApproval: true, approvalPolicy: { approvalRequired: true } };

async function runCase(options, results) {
  const calls = [];
  const result = await finishReviewedPr(options, { run: async (script) => {
    calls.push(script);
    return results[script];
  }, sleep: async () => { throw new Error('审查 App 的收尾不应等待维护者批准'); }, now: (() => { let t = 0; return () => (t += 1); })() });
  return { result, calls };
}

test('审查 App 的 Approve 之后不调用 signoff-release,回执写明跳过原因,仍跑真实 pre-merge', async () => {
  const { result, calls } = await runCase(base, {
    'approve-reviewed-pr.mjs': verified({ viewerIsReviewerApp: true, viewerIsMaintainer: false, approvalRequired: true }),
    'signoff-release.mjs': { ok: false, error: '不应被调用' },
    'pre-merge-check.mjs': pass,
  });
  assert.deepEqual(calls, ['approve-reviewed-pr.mjs', 'pre-merge-check.mjs']);
  assert.equal(result.stage, 'reviewed-only');
  assert.deepEqual(result.release, { skipped: true, reason: 'reviewer-app-not-maintainer' });
  assert.equal(result.approval.status, 'verified');
});

test('审查 App 作者在集合内走 exempt 时同样不释放签核', async () => {
  const policy = { viewerIsReviewerApp: true, authorIsMaintainer: true, approvalRequired: false, author: 'praisezhu' };
  const { result, calls } = await runCase(base, {
    'approve-reviewed-pr.mjs': { ok: true, approved: false, approvalSatisfied: true, approvalPolicy: policy,
      approval: { status: 'exempt', author: 'praisezhu', head, authorityDigest: base.authorityDigest, source: 'maintainer-allowlist', reason: '维护者作者免独立 Approve' } },
    'signoff-release.mjs': { ok: false, error: '不应被调用' },
    'pre-merge-check.mjs': pass,
  });
  assert.equal(calls.includes('signoff-release.mjs'), false);
  assert.equal(result.release.skipped, true);
});

test('真人维护者的收尾保持原样:仍先 signoff-release 再 pre-merge', async () => {
  const { calls } = await runCase(base, {
    'approve-reviewed-pr.mjs': verified({ viewerIsReviewerApp: false, viewerIsMaintainer: true }),
    'signoff-release.mjs': { ok: true, labels: { errors: [] } },
    'pre-merge-check.mjs': { ...pass, canMerge: true, normalMergeAvailable: true },
  });
  assert.deepEqual(calls, ['approve-reviewed-pr.mjs', 'signoff-release.mjs', 'pre-merge-check.mjs']);
  // 旧回执没有 viewerIsReviewerApp 字段也按旧路径。
  const legacy = await runCase(base, {
    'approve-reviewed-pr.mjs': { ...verified({}), approvalPolicy: undefined },
    'signoff-release.mjs': { ok: true, labels: { errors: [] } },
    'pre-merge-check.mjs': { ...pass, canMerge: true, normalMergeAvailable: true },
  });
  assert.equal(legacy.calls.includes('signoff-release.mjs'), true);
});
