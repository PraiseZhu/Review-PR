export function gateReviewMarker(kind, head) {
  if (!['format', 'security'].includes(kind) || !/^[0-9a-f]{40,64}$/i.test(head)) throw new Error('gate kind / head 不合法');
  return `<!-- review-pr:gate-review kind=${kind} head=${head.toLowerCase()} -->`;
}

// Gate-clean is not evidence that a content finding was fixed. Unknown/legacy reviews stay put.
export function selectGateReviewsToDismiss(reviews, viewer, head) {
  return reviews.filter((r) => {
    if (r.state !== 'CHANGES_REQUESTED' || String(r.user?.login ?? '').toLowerCase() !== viewer.toLowerCase() ||
        !Number.isSafeInteger(r.id) || r.id <= 0) return false;
    const marker = String(r.body ?? '').match(/<!-- review-pr:gate-review kind=(format|security) head=([0-9a-f]{40,64}) -->/i);
    return Boolean(marker && marker[2].toLowerCase() === String(r.commit_id ?? '').toLowerCase() &&
      marker[2].toLowerCase() !== head.toLowerCase());
  });
}
