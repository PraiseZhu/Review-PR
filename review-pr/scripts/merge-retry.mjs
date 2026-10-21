// Only proven pre-write failures can repeat a guarded merge in the same round.
// Uncertain writes must first be reconciled by reads, never blindly resubmitted.
export const MERGE_RETRY_VERSION = 2;
export const REVIEW_CHANGES_REQUESTED_BLOCKER = 'mergeStateStatus=BLOCKED(reviewDecision=CHANGES_REQUESTED,仍有 reviewer 要求修改)';
const same = (a, b) => typeof a === 'string' && a.length > 0 && a.toLowerCase() === String(b ?? '').toLowerCase();
const IN_PROGRESS_STAGES = new Set(['approving', 'approved', 'approval-exempt', 'checking', 'merging', 'merge-retry-pending']);
export const isFinishInProgress = (receipt) => IN_PROGRESS_STAGES.has(receipt?.stage);

function clearMergePrerequisites(check) {
  return check?.ok === true && check.state === 'OPEN' &&
    check.headVerified === true && check.baseVerified === true && check.authorityVerified === true &&
    check.threadsVerified === true && check.unresolvedThreads?.length === 0 &&
    check.ci?.status === 'pass' && check.botSettleVerified === true && check.botSettle?.settled === true &&
    check.staleRebaseChecked === true && check.staleRebase?.blocking === false &&
    !check.pendingSignoffLabels?.length && !check.protectedFiles?.length &&
    check.mergeable !== 'CONFLICTING' && check.mergeStateStatus !== 'DIRTY';
}

export function isOwnApprovalRefresh(check, approval) {
  if (!clearMergePrerequisites(check) || check.reviewDecision !== 'CHANGES_REQUESTED' ||
      check.blockClass !== 'review-changes-requested' || check.blockers?.length !== 1 ||
      check.blockers[0] !== REVIEW_CHANGES_REQUESTED_BLOCKER ||
      approval?.status !== 'verified' || !same(approval.reviewer, check.approvalPolicy?.viewer) ||
      !same(approval.head, check.actualHead) || check.reviewSnapshot?.verified !== true ||
      !Array.isArray(check.reviewSnapshot.latest)) return false;
  const latest = check.reviewSnapshot.latest;
  if (latest.some((review) => review.state === 'CHANGES_REQUESTED')) return false;
  return latest.some((review) => review.state === 'APPROVED' && same(review.reviewer, approval.reviewer) &&
    String(review.reviewId) === String(approval.reviewId) && same(review.head, approval.head));
}

function boundExempt(check, approval) {
  const policy = check?.approvalPolicy;
  return approval?.status === 'exempt' &&
    policy?.approvalRequired === false && policy?.authorIsMaintainer === true &&
    typeof approval.author === 'string' && approval.author.toLowerCase() === String(policy.author ?? '').toLowerCase() &&
    typeof approval.head === 'string' && approval.head.toLowerCase() === String(check.actualHead ?? '').toLowerCase() &&
    approval.authorityDigest === policy.authorityDigest;
}

export function isTransientMergeCheck(check, approval) {
  if (isOwnApprovalRefresh(check, approval)) return true;
  const decisionOk = check?.reviewDecision === 'APPROVED' || boundExempt(check, approval);
  return clearMergePrerequisites(check) && decisionOk && !check.blockers?.length &&
    (!check.blockClass || check.blockClass === 'none') &&
    check.mergeable !== 'CONFLICTING' && check.mergeStateStatus !== 'DIRTY' &&
    (check.mergeable === 'UNKNOWN' || check.mergeableUnknown === true || check.mergeStateStatus === 'UNKNOWN');
}

export function canRetryMergeBeforeWrite(merge, approval) {
  return merge?.merged !== true && merge?.queued !== true && merge?.mergeAttempted === false &&
    (merge.code === 'base-merge-lock-busy' || isTransientMergeCheck(merge.preMerge, approval));
}

export function needsFinishContinuation(result, receipt) {
  if (!result?.reviewClean || result.merged) return false;
  if (result.approval?.status === 'pending') return true;
  if (!['verified', 'exempt'].includes(result.approval?.status) || !receipt) return false;
  if (isFinishInProgress(receipt)) return true;
  if (receipt.stage === 'approval-checkpoint-failed') return true;
  if (['label-sync-blocked', 'check-failed'].includes(receipt.stage) && receipt.retry === true) return true;
  if (result.mode === 'review-only' || receipt.stage !== 'merge-blocked') return false;
  return receipt.merge ? canRetryMergeBeforeWrite(receipt.merge, result.approval)
    : isTransientMergeCheck(receipt.preMerge, result.approval);
}

export function needsMergeRetry(result) {
  if (!result || result.merged || result.mode === 'review-only') return false;
  // The inner guarded check is newer than finish's first pre-merge check.
  const latest = result.merge ?? result;
  return result.retry === true || latest.retry === true || latest.pending === true ||
    latest.ok === false && Boolean(latest.error) ||
    isTransientMergeCheck(latest.preMerge, result.approval);
}

export function legacyMergeRetryDue(previous) {
  if (previous?.mergeRetryVersion === MERGE_RETRY_VERSION || previous?.outcome !== 'merge-blocked' ||
      previous.reviewClean !== true || previous.approval?.status !== 'verified' || previous.fixCause) return false;
  // Older records do not prove that an approved finish reached a terminal merge
  // result. Reclassify once with fresh guards, including generic lost reasons.
  return true;
}
