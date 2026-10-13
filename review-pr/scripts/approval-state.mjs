// A successful process exit is not an approval receipt. These contracts are pure.
export const APPROVAL_REPOST_AFTER_MS = 10 * 60 * 1000;
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);
const reviewId = (value) => (typeof value === 'string' && /^[1-9]\d*$/.test(value)) ||
  (Number.isSafeInteger(value) && value > 0);

export function validateApprovalDisposition(approval, { head } = {}) {
  if (!approval || !['verified', 'blocked', 'pending'].includes(approval.status)) {
    throw new Error('缺少明确的 Approve 回执或阻塞状态');
  }
  if (approval.status === 'verified') {
    if (!reviewId(approval.reviewId) || !nonempty(approval.reviewer) || !sha(approval.head) ||
        (head !== undefined && (!sha(head) || approval.head.toLowerCase() !== head.toLowerCase())) ||
        (approval.source !== undefined && approval.source !== 'existing-maintainer-review') ||
        (approval.source === 'existing-maintainer-review' && !sha(approval.reviewHead)) ||
        (approval.reviewHead !== undefined && (approval.source !== 'existing-maintainer-review' || !sha(approval.reviewHead))) ||
        !nonempty(approval.verifiedAt) || !Number.isFinite(Date.parse(approval.verifiedAt))) {
      throw new Error('Approve 回执缺少真实 review ID、reviewer、同 head 或核验时间');
    }
    return { ...approval, reviewId: String(approval.reviewId), reviewer: approval.reviewer.trim(), head: approval.head.toLowerCase() };
  }
  if (!nonempty(approval.reason) || (approval.code !== undefined && !nonempty(approval.code))) {
    throw new Error('Approve 未完成时必须记录明确原因');
  }
  return { ...approval, reason: approval.reason.trim() };
}

export function approvalReceiptFromReview(review, { viewer, head, now = Date.now() } = {}) {
  const reviewer = String(review?.user?.login ?? '').trim();
  if (String(review?.state ?? '').toUpperCase() !== 'APPROVED' || !nonempty(viewer) ||
      reviewer.toLowerCase() !== viewer.toLowerCase() || !sha(head) ||
      String(review?.commit_id ?? '').toLowerCase() !== head.toLowerCase() || !reviewId(review?.id) ||
      !Number.isFinite(Date.parse(review?.submitted_at ?? ''))) return null;
  return validateApprovalDisposition({ status: 'verified', reviewId: String(review.id), reviewer,
    head: head.toLowerCase(), verifiedAt: new Date(now).toISOString(),
    ...(typeof review.html_url === 'string' && /^https:\/\//.test(review.html_url) ? { url: review.html_url } : {}) }, { head });
}

// The caller must supply each reviewer's latest substantive review from a
// complete live listing. GitHub decides whether a prior-head approval remains
// effective; keep its real commit separate from the head reviewed this round.
export function existingMaintainerApprovalReceipt(review, { author, maintainers = [], reviewDecision, head, now } = {}) {
  const reviewer = String(review?.user?.login ?? '').trim();
  if (reviewDecision !== 'APPROVED' || !nonempty(author) || !sha(head) ||
      reviewer.toLowerCase() === author.trim().toLowerCase() ||
      !maintainers.some((login) => String(login).trim().toLowerCase() === reviewer.toLowerCase())) return null;
  const receipt = approvalReceiptFromReview(review, { viewer: reviewer, head: review?.commit_id, now });
  return receipt ? validateApprovalDisposition({ ...receipt, head: head.toLowerCase(),
    reviewHead: receipt.head, source: 'existing-maintainer-review' }, { head }) : null;
}

export function pendingApproval(reason, code = 'approval-unverified') {
  return validateApprovalDisposition({ status: 'pending', reason, code });
}
