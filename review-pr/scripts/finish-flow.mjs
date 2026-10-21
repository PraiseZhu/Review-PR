// One reviewed head -> approval -> label reconciliation -> current merge gates -> merge.
// Dependencies are injected so fault scenarios can be exercised without GitHub writes.
import { validateApprovalDisposition, pendingApproval } from './approval-state.mjs';
import { isOwnApprovalRefresh, isTransientMergeCheck, needsMergeRetry, canRetryMergeBeforeWrite } from './merge-retry.mjs';
export function canWaitForApproval(check, approval) {
  if (!check?.ok || check.state !== 'OPEN' || !check.headVerified || check.baseVerified === false || !check.authorityVerified ||
      !check.threadsVerified || check.unresolvedThreads?.length !== 0 ||
      check.ci?.status !== 'pass' || !check.botSettleVerified || !check.botSettle?.settled ||
      !check.staleRebaseChecked || check.staleRebase?.blocking ||
      check.pendingSignoffLabels?.length || check.protectedFiles?.length) return false;
  // Only a fully read, same-review receipt proves our own CR was superseded.
  // Another reviewer's CR, or an unverified snapshot, remains a real blocker.
  if (check.reviewDecision === 'CHANGES_REQUESTED') return isOwnApprovalRefresh(check, approval);
  const awaiting = check.approvalPolicy?.approvalRequired !== false && check.blockedAwaitingApproval;
  return awaiting || check.mergeableUnknown ||
    check.mergeStateStatus === 'UNKNOWN' || check.blockClass === 'structural-check';
}

function bindExemptApproval(approval, approvalResult, { head, authorityDigest }) {
  const policy = approvalResult?.approvalPolicy;
  if (approvalResult?.approved === true || policy?.authorIsMaintainer !== true || policy?.approvalRequired !== false) {
    throw new Error('免审批回执与 live policy 不符');
  }
  return validateApprovalDisposition(approval, { head, authorityDigest, author: policy.author });
}

export async function finishReviewedPr(options, { run, sleep, checkpoint = () => {}, now = Date.now }) {
  const { mode, pr, head, expectedBase, expectedBaseRef, authorityDigest, lockToken, method, bodyFile, allowStructuralBypass = false } = options;
  if (!['auto', 'review-only'].includes(mode)) throw new Error('--mode 必须显式为 auto / review-only');
  if (!Number.isInteger(pr) || pr <= 0 || !head || !authorityDigest || !lockToken) throw new Error('PR/head/authority/lock 参数不完整');
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new Error('--method 必须为 merge / squash / rebase');
  const startedAt = now();
  const binding = [String(pr), '--lock-token', lockToken, '--expected-head', head, '--expected-authority-digest', authorityDigest,
    ...(expectedBase ? ['--expected-base', expectedBase] : []), ...(expectedBaseRef ? ['--expected-base-ref', expectedBaseRef] : [])];
  const state = { version: 1, pr, head, authorityDigest, mode, ...(options.runId ? { runId: options.runId } : {}),
    ...(expectedBase ? { expectedBase } : {}), ...(expectedBaseRef ? { expectedBaseRef } : {}), reviewClean: true,
    approved: false, merged: false, checks: 0, mergeAttempts: 0, approval: pendingApproval('准备核验当前 head 的独立 Approve', 'approval-not-started') };
  const save = (stage, extra = {}) => {
    Object.assign(state, extra, { stage, elapsedMs: now() - startedAt });
    checkpoint({ ...state });
    return { ...state };
  };
  save('approving');
  let approvalResult;
  try { approvalResult = await run('approve-reviewed-pr.mjs', [...binding, '--review-clean', ...(bodyFile ? ['--body-file', bodyFile] : [])]); }
  catch (error) { approvalResult = { ok: false, error: error.message }; }
  let approval;
  try {
    approval = approvalResult?.approval?.status === 'exempt'
      ? bindExemptApproval(approvalResult.approval, approvalResult, { head, authorityDigest })
      : validateApprovalDisposition(approvalResult?.approval, { head });
  } catch { approval = pendingApproval('Approve 子进程未返回可核验回执，恢复时先只读回查', 'approval-result-unverified'); }
  if (approval.status === 'exempt') {
    if (approvalResult?.ok === false) {
      return save('approval-checkpoint-failed', { ok: false, approved: false, approval, approvalResult, retry: true,
        reason: approvalResult?.error || '免审批已核验，但子进程未完整完成收尾' });
    }
    save('approval-exempt', { approved: false, approvalSatisfied: true, approval, approvalResult });
  } else {
    if (approval.status !== 'verified') {
      return save(approval.status === 'pending' ? 'approval-pending' : 'approval-blocked', {
        ok: approvalResult?.ok !== false, reason: approval.reason, approval, approvalResult, retry: approval.status === 'pending' });
    }
    if (approvalResult?.ok === false || approvalResult?.approved !== true) {
      return save('approval-checkpoint-failed', { ok: false, approved: true, approval, approvalResult, retry: true,
        reason: approvalResult?.error || 'Approve 已核验，但子进程未完整完成收尾' });
    }
    save('approved', { approved: true, approval, approvalResult });
  }

  // An old awaiting-discussion label must not strand an already approved PR until the next scan.
  const release = await run('signoff-release.mjs', [...binding, '--labels-only', '--close-issue']);
  if (!release.ok || release.labels?.errors?.length || release.labelWarning) {
    return save('label-sync-blocked', { ok: false, retry: true, release, reason: release.labelWarning || release.error || '维护者确认标签同步失败' });
  }
  save('checking', { release });
  const delays = [2000, 4000, 8000];
  let retries = 0;
  const waitOnce = async () => {
    if (retries >= delays.length || now() - startedAt >= 90_000) return false;
    await sleep(delays[retries++]);
    return true;
  };
  let check;
  for (;;) {
    check = await run('pre-merge-check.mjs', binding);
    // A newer read replaces any earlier pre-write failure; do not carry its
    // retry or merge receipt across a newly discovered real blocker.
    save('checking', { preMerge: check, checks: state.checks + 1, merge: undefined, retry: false });
    if (!check.ok) return save('check-failed', { ok: false, retry: true, reason: check.error || check.reason });
    if (!check.canMerge && !check.normalMergeAvailable && canWaitForApproval(check, approval) && await waitOnce()) continue;
    if (mode === 'review-only') {
      return save('reviewed-only', { ok: true, canMerge: Boolean(check.canMerge || check.structuralBypassAvailable), reason: '已审核通过，review-only 不执行合并' });
    }
    const admin = !check.canMerge && !check.normalMergeAvailable && allowStructuralBypass && check.structuralBypassAvailable;
    if (!check.canMerge && !check.normalMergeAvailable && !admin) {
      return save('merge-blocked', { ok: true, retry: isTransientMergeCheck(check, approval),
        reason: check.blockers?.join('; ') || `GitHub 状态尚未稳定:${check.mergeable}/${check.mergeStateStatus}` });
    }
    // Each attempt repeats all live gates. Retry only if the child positively
    // proves that no merge write occurred, within the shared read/retry budget.
    save('merging', { mergeAttempts: state.mergeAttempts + 1 });
    const merge = await run('merge-reviewed-pr.mjs', [...binding, '--method', method, ...(admin ? ['--admin'] : [])]);
    if (canRetryMergeBeforeWrite(merge, approval)) {
      save('merge-retry-pending', { merge, retry: true, reason: merge.reason });
      if (await waitOnce()) continue;
    }
    return save(merge.merged ? 'merged' : merge.queued ? 'merge-queued' : 'merge-blocked', {
      ok: merge.ok, merged: Boolean(merge.merged), queued: Boolean(merge.queued), merge,
      retry: needsMergeRetry({ ...merge, approval }),
      reason: merge.reason || merge.error || (merge.merged ? '已在本轮合并' : '合并未完成'),
    });
  }
}
