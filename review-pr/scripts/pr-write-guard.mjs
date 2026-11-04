// Bind each write in a multi-step action to the same lock, viewer, authority and head.
import { gh, ghJson, assertActiveReviewLock, fetchMaintainerAuthority, evaluateMaintainerApprovalPolicy, isSignoffExemptAuthor, stateFile,
  readReviewIdentity, normalizeReviewActor } from './lib.mjs';
import { recordSelfWrite } from './self-write-receipts.mjs';

export function createPrWriteGuard(binding, dependencies = {}) {
  const api = { gh, ghJson, assertActiveReviewLock, fetchMaintainerAuthority, evaluateMaintainerApprovalPolicy, isSignoffExemptAuthor, recordSelfWrite, readReviewIdentity, ...dependencies };
  const { owner, repo, pr, lockToken, expectedHead, expectedAuthorityDigest, purpose } = binding;
  if (!lockToken || !expectedHead || !expectedAuthorityDigest) throw new Error('写操作缺少 lock/head/authority 绑定');
  // 写前身份绑定按「当前实际写入账号」精确比较,不用别名集合:同一集合里换成另一个账号也算身份漂移。
  let boundViewer = normalizeReviewActor(binding.expectedViewer)?.key ?? null;
  return (args, options = {}) => {
    api.assertActiveReviewLock(lockToken);
    const identity = api.readReviewIdentity({ ghFn: api.gh });
    const viewer = normalizeReviewActor(identity.viewerLogin)?.key ?? '';
    const authority = api.fetchMaintainerAuthority({ owner, repo });
    const fields = `state,isDraft,headRefOid,author,updatedAt${binding.expectedBaseRef ? ',baseRefName' : ''}`;
    const beforeObservedAt = Date.now();
    const meta = api.ghJson(['pr', 'view', String(pr), '--repo', `${owner}/${repo}`, '--json', fields]);
    const policy = api.evaluateMaintainerApprovalPolicy({ authorLogin: meta.author?.login, viewerLogin: viewer, authority, reviewerIdentity: identity });
    if (meta.state !== 'OPEN' || meta.isDraft || meta.headRefOid !== expectedHead || authority.digest !== expectedAuthorityDigest ||
        !policy.viewerIsMaintainer || (boundViewer && boundViewer !== viewer) ||
        (binding.expectedBaseRef && meta.baseRefName !== binding.expectedBaseRef)) throw new Error('写操作前 PR/head/base/viewer/authority 已变化或权限不足');
    if (purpose === 'hold' && policy.authorIsMaintainer) throw new Error('维护者作者免前置确认门，拒绝 hold');
    // [MIVO-PATCH exempt-authors] 豁免名单作者同样免前置确认门。
    if (purpose === 'hold' && api.isSignoffExemptAuthor(meta.author?.login)) throw new Error('豁免名单作者免前置确认门，拒绝 hold');
    // [MIVO-PATCH signoff-mode] 通知 issue 只给免确认门的作者(维护者或豁免名单);受保护路径的确认 issue(protected-hold)
    // 任何作者都开——它比 hold 更严,误用只会多等人工。上面两条 hold 拒绝保持不变。
    if (purpose === 'signoff-notice' && !(policy.authorIsMaintainer || api.isSignoffExemptAuthor(meta.author?.login))) throw new Error('非豁免作者不发通知 issue，应走 hold');
    boundViewer = viewer;
    api.assertActiveReviewLock(lockToken);
    const startedAt = Date.now();
    const result = api.gh(args, { ...options, noCredFallback: true });
    api.recordSelfWrite({ directory: process.env.REVIEW_PR_SELF_WRITE_DIR || stateFile('self-writes'),
      repo: `${owner}/${repo}`, pr, head: expectedHead, scope: lockToken, beforeUpdatedAt: meta.updatedAt, beforeObservedAt,
      args, result, startedAt, finishedAt: Date.now() });
    return result;
  };
}
