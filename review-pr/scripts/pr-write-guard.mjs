// Bind each write in a multi-step action to the same lock, viewer, authority and head.
import { gh, ghJson, assertActiveReviewLock, fetchMaintainerAuthority, evaluateMaintainerApprovalPolicy, isSignoffExemptAuthor } from './lib.mjs';

export function createPrWriteGuard(binding, dependencies = {}) {
  const api = { gh, ghJson, assertActiveReviewLock, fetchMaintainerAuthority, evaluateMaintainerApprovalPolicy, isSignoffExemptAuthor, ...dependencies };
  const { owner, repo, pr, lockToken, expectedHead, expectedAuthorityDigest, purpose } = binding;
  if (!lockToken || !expectedHead || !expectedAuthorityDigest) throw new Error('写操作缺少 lock/head/authority 绑定');
  let boundViewer = String(binding.expectedViewer ?? '').trim().toLowerCase() || null;
  return (args, options = {}) => {
    api.assertActiveReviewLock(lockToken);
    const viewer = String(api.gh(['api', 'user', '--jq', '.login']).stdout).trim().toLowerCase();
    const authority = api.fetchMaintainerAuthority({ owner, repo });
    const fields = `state,isDraft,headRefOid,author${binding.expectedBaseRef ? ',baseRefName' : ''}`;
    const meta = api.ghJson(['pr', 'view', String(pr), '--repo', `${owner}/${repo}`, '--json', fields]);
    const policy = api.evaluateMaintainerApprovalPolicy({ authorLogin: meta.author?.login, viewerLogin: viewer, authority });
    if (meta.state !== 'OPEN' || meta.isDraft || meta.headRefOid !== expectedHead || authority.digest !== expectedAuthorityDigest ||
        !policy.viewerIsMaintainer || (boundViewer && boundViewer !== viewer) ||
        (binding.expectedBaseRef && meta.baseRefName !== binding.expectedBaseRef)) throw new Error('写操作前 PR/head/base/viewer/authority 已变化或权限不足');
    if (purpose === 'hold' && policy.authorIsMaintainer) throw new Error('维护者作者免前置确认门，拒绝 hold');
    // [MIVO-PATCH exempt-authors] 豁免名单作者同样免前置确认门。
    if (purpose === 'hold' && api.isSignoffExemptAuthor(meta.author?.login)) throw new Error('豁免名单作者免前置确认门，拒绝 hold');
    boundViewer = viewer;
    api.assertActiveReviewLock(lockToken);
    return api.gh(args, { ...options, noCredFallback: true });
  };
}
