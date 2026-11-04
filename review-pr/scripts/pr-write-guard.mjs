// Bind each write in a multi-step action to the same lock, viewer, authority and head.
import { gh, ghJson, assertActiveReviewLock, fetchMaintainerAuthority, evaluateMaintainerApprovalPolicy, isSignoffExemptAuthor, stateFile,
  readReviewIdentity, normalizeReviewActor, reviewRecordActor, loadRules } from './lib.mjs';
import { recordSelfWrite } from './self-write-receipts.mjs';

// [MIVO-PATCH reviewer-app] 审查 App 只获得「发审查」能力:purpose='review' 时只放行当前仓、当前 PR 的
// POST pulls/<pr>/reviews 与 POST pulls/<pr>/comments;签核评论、改标签、关 issue、合并、GraphQL 写一律不在其内。
function isReviewWrite(args, { owner, repo, pr }) {
  if (!Array.isArray(args) || args[0] !== 'api' || args.includes('graphql')) return false;
  const methodAt = args.indexOf('--method');
  if (methodAt < 0 || String(args[methodAt + 1]).toUpperCase() !== 'POST') return false;
  const endpoints = args.filter((arg) => typeof arg === 'string' && /^repos\//.test(arg));
  if (endpoints.length !== 1) return false;
  const base = `repos/${owner}/${repo}/pulls/${pr}`.toLowerCase();
  return [`${base}/reviews`, `${base}/comments`].includes(endpoints[0].toLowerCase());
}

export function createPrWriteGuard(binding, dependencies = {}) {
  const api = { gh, ghJson, assertActiveReviewLock, fetchMaintainerAuthority, evaluateMaintainerApprovalPolicy, isSignoffExemptAuthor, recordSelfWrite, readReviewIdentity, ...dependencies };
  const { owner, repo, pr, lockToken, expectedHead, expectedAuthorityDigest, purpose } = binding;
  if (!lockToken || !expectedHead || !expectedAuthorityDigest) throw new Error('写操作缺少 lock/head/authority 绑定');
  // 写前身份绑定按「当前实际写入账号」精确比较,不用别名集合:同一集合里换成另一个账号也算身份漂移。
  let boundViewer = normalizeReviewActor(binding.expectedViewer)?.key ?? null;
  const reviewerApps = binding.reviewerApps ?? loadRules().reviewerApps ?? [];
  return (args, options = {}) => {
    api.assertActiveReviewLock(lockToken);
    const identity = api.readReviewIdentity({ ghFn: api.gh });
    const viewer = normalizeReviewActor(identity.viewerLogin)?.key ?? '';
    const authority = api.fetchMaintainerAuthority({ owner, repo });
    const fields = `state,isDraft,headRefOid,author,updatedAt${binding.expectedBaseRef ? ',baseRefName' : ''}`;
    const beforeObservedAt = Date.now();
    const meta = api.ghJson(['pr', 'view', String(pr), '--repo', `${owner}/${repo}`, '--json', fields]);
    // 人类作者仍按 login 字符串传(旧调用方与注入的 policy 都按字符串);Bot 作者传带类型的 actor,三种写法才能归一。
    const authorActor = reviewRecordActor({ author: meta.author });
    const authorInput = normalizeReviewActor(authorActor)?.isBot ? authorActor : meta.author?.login;
    const policy = api.evaluateMaintainerApprovalPolicy({ authorLogin: authorInput, viewerLogin: viewer, authority, reviewerIdentity: identity, reviewerApps });
    // 审查 App 只在 purpose='review' 且写的是精确端点时算有权限;其余目的仍要求维护者。
    const reviewAppAllowed = purpose === 'review' && policy.viewerIsReviewerApp && !policy.viewerIsMaintainer;
    if (reviewAppAllowed && !isReviewWrite(args, { owner, repo, pr })) {
      throw new Error(`审查 App 在 purpose=review 下只允许 POST pulls/${pr}/reviews 与 pulls/${pr}/comments(实际 ${String(args?.[0])} ${(args ?? []).filter((arg) => /^repos\//.test(String(arg))).join(',') || '(无 repos 端点)'})`);
    }
    if (meta.state !== 'OPEN' || meta.isDraft || meta.headRefOid !== expectedHead || authority.digest !== expectedAuthorityDigest ||
        !(policy.viewerIsMaintainer || reviewAppAllowed) || (boundViewer && boundViewer !== viewer) ||
        (binding.expectedBaseRef && meta.baseRefName !== binding.expectedBaseRef)) {
      // 逐项写出期望与实际(只含状态、SHA、登录名,不含令牌或环境)。
      throw new Error(`写操作前 PR/head/base/viewer/authority 已变化或权限不足:state=${meta.state}${meta.isDraft ? '(draft)' : ''},`
        + `head 期望 ${expectedHead} 实际 ${meta.headRefOid},authority 期望 ${expectedAuthorityDigest} 实际 ${authority.digest},`
        + `viewer 期望 ${boundViewer ?? '(未绑定)'} 实际 ${viewer || '(empty)'}(维护者=${policy.viewerIsMaintainer},审查App=${policy.viewerIsReviewerApp},purpose=${purpose ?? 'default'})`
        + `${binding.expectedBaseRef ? `,base 期望 ${binding.expectedBaseRef} 实际 ${meta.baseRefName}` : ''}`);
    }
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
