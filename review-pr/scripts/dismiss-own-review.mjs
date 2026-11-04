#!/usr/bin/env node
// dismiss-own-review.mjs — 维护者作者重审通过后,只撤销 viewer 自己留下的旧
// CHANGES_REQUESTED review,解除 reviewDecision 死锁而不产生新的 APPROVED review。
//
// ⚠️ 安全边界:
// - 仅限仍在最终维护者集合中的作者，并绑定本轮 authority digest;
// [MIVO-PATCH p2-blocking] 零 P0/P1/P2 才允许 dismiss
// - 调用方必须显式传 --review-clean,表示已对当前 head 完成最终代码重审且零 P0/P1/P2;
// - 只 dismiss viewer 自己的 CR,只要掺有别人的 CR 或未 resolve thread 就拒绝;
// - review ID 从 REST 拉取,避免把 GraphQL node id 误传给 REST dismissal 端点。
//
// 跑:node <skill-root>/scripts/dismiss-own-review.mjs <PR> --review-clean
//     --lock-token <prepare.lock.token> --expected-head <sha>
//     --expected-authority-digest <digest> [--dry-run]
// 退出码:0 = 已完成;2 = 前置条件不满足/部分失败;1 = 脚本自身出错。

import {
  parseRepo,
  parsePR,
  gh,
  ghJson,
  fetchAllReviewThreads,
  fetchMaintainerAuthority,
  evaluateMaintainerApprovalPolicy,
  evaluateOwnReviewDismissal,
  readReviewIdentityOrEmpty,
  sameReviewActor,
  reviewRecordActor,
  loadRules,
  assertActiveReviewLock,
  print,
  fail,
} from './lib.mjs';
import { putDismissal } from './dismiss-review.mjs';
import { scrubSecrets } from './secret-scrub.mjs';

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const reviewClean = process.argv.includes('--review-clean');
  const dryRun = process.argv.includes('--dry-run');
  const lockTokenIndex = process.argv.indexOf('--lock-token');
  const lockToken = lockTokenIndex >= 0 ? String(process.argv[lockTokenIndex + 1] ?? '').trim() : '';
  const expectedHeadIndex = process.argv.indexOf('--expected-head');
  const expectedHead = expectedHeadIndex >= 0 ? String(process.argv[expectedHeadIndex + 1] ?? '').trim() : '';
  const expectedAuthorityIndex = process.argv.indexOf('--expected-authority-digest');
  const expectedAuthorityDigest = expectedAuthorityIndex >= 0
    ? String(process.argv[expectedAuthorityIndex + 1] ?? '').trim()
    : '';
  const slug = `${owner}/${repo}`;
  assertActiveReviewLock(lockToken);

  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'state,mergeStateStatus,reviewDecision,author,headRefOid',
  ]);
  const identity = readReviewIdentityOrEmpty();
  const viewerLogin = identity.viewerLogin;
  const threadResult = fetchAllReviewThreads(owner, repo, pr);
  const unresolvedCount = threadResult.threads.filter((thread) => !thread.isResolved).length;

  const pages = ghJson([
    'api', '--method', 'GET', '--paginate', '--slurp',
    `repos/${slug}/pulls/${pr}/reviews`, '-f', 'per_page=100',
  ]);
  const reviews = (Array.isArray(pages) ? pages : [])
    .flatMap((page) => (Array.isArray(page) ? page : []));
  let authority = null;
  let authorityError = null;
  try {
    authority = fetchMaintainerAuthority({ owner, repo });
    if (!expectedAuthorityDigest) authorityError = '缺少 --expected-authority-digest';
    else if (authority.digest !== expectedAuthorityDigest) {
      authorityError = `维护者权限已变化:${expectedAuthorityDigest} → ${authority.digest}`;
    }
  } catch (error) {
    authorityError = String(error?.message ?? error);
  }
  // [MIVO-PATCH reviewer-app] 配置的审查 App 可以清「自己」发出的 CR(见 evaluateOwnReviewDismissal 的 reviewerApp);人类路径不变。
  const reviewerApps = loadRules().reviewerApps ?? [];
  const approvalPolicy = evaluateMaintainerApprovalPolicy({
    authorLogin: reviewRecordActor({ author: meta.author }),
    viewerLogin,
    authority,
    reviewerIdentity: identity,
    reviewerApps,
  });
  const reviewerApp = approvalPolicy.viewerIsReviewerApp === true;
  const policy = evaluateOwnReviewDismissal({
    reviewerApp,
    approvalExempt: approvalPolicy.authorIsMaintainer && !authorityError,
    reviewClean,
    state: meta.state,
    mergeStateStatus: meta.mergeStateStatus,
    reviewDecision: meta.reviewDecision,
    viewerLogin,
    reviewerIdentity: identity,
    reviews,
    unresolvedCount,
    threadsVerified: threadResult.verified,
    expectedHead,
    actualHead: meta.headRefOid,
  });
  if (authorityError) {
    policy.available = false;
    policy.failedChecks.unshift(`维护者权限未验证:${authorityError}`);
  }

  if (!policy.available) {
    print({
      ok: true,
      pr,
      dismissed: false,
      approvalPolicy,
      failedChecks: policy.failedChecks,
      reason: policy.failedChecks.join(';'),
    });
    process.exit(2);
  }

  const message =
    '当前 head 已完成最终代码重审且零 P0/P1/P2,所有 conversation 已 resolve。' +
    '作者仍在最终维护者集合中,故只 dismiss viewer 自己的旧 CHANGES_REQUESTED,不提交新的 APPROVE。';

  if (dryRun) {
    print({
      ok: true,
      pr,
      dismissed: false,
      dryRun: true,
      approvalPolicy,
      viewer: policy.viewer,
      reviewIds: policy.reviewIds,
      expectedHead,
      actualHead: meta.headRefOid,
      message,
    });
    process.exit(0);
  }

  // 写操作前最后一次绑定锁/head,避免失去租约或作者推新代码后仍撤 review。
  assertActiveReviewLock(lockToken);
  const freshMeta = ghJson([
    'pr', 'view', String(pr), '--repo', slug, '--json', 'author,headRefOid',
  ]);
  const freshAuthority = fetchMaintainerAuthority({ owner, repo });
  const freshIdentity = readReviewIdentityOrEmpty();
  const freshPolicy = evaluateMaintainerApprovalPolicy({
    authorLogin: reviewRecordActor({ author: freshMeta.author }),
    viewerLogin,
    authority: freshAuthority,
    reviewerIdentity: identity,
    reviewerApps,
  });
  const writeFailures = [];
  if (String(freshMeta.headRefOid ?? '').toLowerCase() !== expectedHead.toLowerCase()) {
    writeFailures.push(`写操作前 head 已变化:${expectedHead} → ${freshMeta.headRefOid ?? '(empty)'}`);
  }
  if (freshAuthority.digest !== expectedAuthorityDigest) {
    writeFailures.push(`写操作前维护者权限已变化:${expectedAuthorityDigest} → ${freshAuthority.digest}`);
  }
  if (reviewerApp) {
    if (!sameReviewActor(freshIdentity.viewerLogin, viewerLogin)) writeFailures.push(`写操作前 GitHub viewer 已变化:${viewerLogin} → ${freshIdentity.viewerLogin || '(empty)'}`);
    if (!freshPolicy.viewerIsReviewerApp) writeFailures.push('写操作前 viewer 已不是配置的审查 App');
  } else if (!freshPolicy.authorIsMaintainer) writeFailures.push('写操作前作者已不在最终维护者集合中');
  if (writeFailures.length > 0) {
    print({
      ok: true,
      pr,
      dismissed: false,
      approvalPolicy: freshPolicy,
      reason: writeFailures.join(';'),
      failedChecks: writeFailures,
    });
    process.exit(2);
  }

  const dismissed = [];
  const alreadyDismissed = [];
  const errors = [];
  const readReviews = () => {
    const pages = ghJson(['api', '--method', 'GET', '--paginate', '--slurp', `repos/${slug}/pulls/${pr}/reviews`, '-f', 'per_page=100']);
    return (Array.isArray(pages) ? pages : []).flatMap((page) => (Array.isArray(page) ? page : []));
  };
  for (const reviewId of policy.reviewIds) {
    const currentMeta = ghJson([
      'pr', 'view', String(pr), '--repo', slug, '--json', 'headRefOid',
    ]);
    if (String(currentMeta.headRefOid ?? '').toLowerCase() !== expectedHead.toLowerCase()) {
      errors.push({
        reviewId,
        error: `dismiss 前 head 已变化:${expectedHead} → ${currentMeta.headRefOid ?? '(empty)'}`,
      });
      break;
    }
    assertActiveReviewLock(lockToken);
    if (reviewerApp) {
      // 每个 PUT 前重读真实 viewer 与完整 reviews:viewer 必须仍是同一个 App;目标 review 仍须是该 App 的 CR,
      // 已是 DISMISSED 就不再写(幂等)。
      const nowIdentity = readReviewIdentityOrEmpty();
      if (!sameReviewActor(nowIdentity.viewerLogin, viewerLogin)) {
        errors.push({ reviewId, error: `dismiss 前 GitHub viewer 已变化:期望 ${viewerLogin} 实际 ${nowIdentity.viewerLogin || '(empty)'}` });
        break;
      }
      const target = readReviews().find((review) => Number(review?.id) === reviewId);
      if (!target) { errors.push({ reviewId, error: `dismiss 前完整重读找不到 review ${reviewId}` }); continue; }
      const state = String(target.state ?? '').toUpperCase();
      if (state === 'DISMISSED') { alreadyDismissed.push(reviewId); continue; }
      if (state !== 'CHANGES_REQUESTED' || !sameReviewActor(reviewRecordActor(target), viewerLogin)) {
        errors.push({ reviewId, error: `dismiss 前 review ${reviewId} 不再是 ${viewerLogin} 的 CHANGES_REQUESTED(期望 CHANGES_REQUESTED,实际 ${state || '(empty)'},作者 ${reviewRecordActor(target).login || '(empty)'})` });
        continue;
      }
      const written = putDismissal({ slug, pr, reviewId, message });
      if (written.status === 'dismissed') dismissed.push(reviewId);
      else if (written.status === 'already-dismissed') alreadyDismissed.push(reviewId);
      else errors.push({ reviewId, error: written.error });
      continue;
    }
    const result = gh([
      'api', '--method', 'PUT',
      `repos/${slug}/pulls/${pr}/reviews/${reviewId}/dismissals`,
      '--input', '-',
    ], {
      input: JSON.stringify({ message, event: 'DISMISS' }),
      allowFail: true,
      timeoutMs: 15_000,
      noCredFallback: true,
    });
    if (result.ok) dismissed.push(reviewId);
    else errors.push({ reviewId, error: (result.stderr || result.stdout || '').trim().slice(0, 300) });
  }
  const afterMeta = ghJson([
    'pr', 'view', String(pr), '--repo', slug, '--json', 'headRefOid',
  ]);
  if (String(afterMeta.headRefOid ?? '').toLowerCase() !== expectedHead.toLowerCase()) {
    errors.push({
      reviewId: null,
      error: `dismiss 完成后 head 已变化:${expectedHead} → ${afterMeta.headRefOid ?? '(empty)'}`,
    });
  }

  print({
    ok: errors.length === 0,
    pr,
    dismissed: errors.length === 0,
    dismissedCount: dismissed.length,
    dismissed,
    ...(reviewerApp ? { alreadyDismissed } : {}),
    errors,
    approvalPolicy,
    viewer: policy.viewer,
    message,
  });
  process.exit(errors.length === 0 ? 0 : 2);
} catch (error) {
  fail(new Error(scrubSecrets(error?.message ?? error)));
}
