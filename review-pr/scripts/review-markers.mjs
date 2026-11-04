import { isReviewIdentity } from './reviewer-identity.mjs';

// [MIVO-PATCH handoff-gate-kind] Mivo 审查机按作者交接文件打回时用 kind=handoff(见 mivo/lib/handoff.mjs)。
const GATE_KINDS = ['format', 'security', 'handoff'];

export function gateReviewMarker(kind, head) {
  if (!GATE_KINDS.includes(kind) || !/^[0-9a-f]{40,64}$/i.test(head)) throw new Error('gate kind / head 不合法');
  return `<!-- review-pr:gate-review kind=${kind} head=${head.toLowerCase()} -->`;
}

// Gate-clean is not evidence that a content finding was fixed. Unknown/legacy reviews stay put.
// viewer 可以是旧的登录名字符串,也可以是审查身份对象(集合内任一账号留下的打回都算自己的)。
export function selectGateReviewsToDismiss(reviews, viewer, head) {
  return reviews.filter((r) => {
    if (r.state !== 'CHANGES_REQUESTED' || !isReviewIdentity(r.user, viewer) ||
        !Number.isSafeInteger(r.id) || r.id <= 0) return false;
    const marker = String(r.body ?? '').match(/<!-- review-pr:gate-review kind=(format|security|handoff) head=([0-9a-f]{40,64}) -->/i);
    return Boolean(marker && marker[2].toLowerCase() === String(r.commit_id ?? '').toLowerCase() &&
      marker[2].toLowerCase() !== head.toLowerCase());
  });
}
