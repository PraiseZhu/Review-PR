#!/usr/bin/env node
// dismiss-own-review.mjs — 维护者作者重审通过后,只撤销 viewer 自己留下的旧
// CHANGES_REQUESTED review,解除 reviewDecision 死锁而不产生新的 APPROVED review。
//
// ⚠️ 安全边界:
// - 仅限仍在最终维护者集合中的作者，并绑定本轮 authority digest;
// - 调用方必须显式传 --review-clean,表示已对当前 head 完成最终代码重审且零 P0/P1;
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
  assertActiveReviewLock,
  print,
  fail,
} from './lib.mjs';

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
  const viewerLogin = (gh(['api', 'user', '--jq', '.login']).stdout ?? '').trim();
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
  const approvalPolicy = evaluateMaintainerApprovalPolicy({
    authorLogin: meta.author?.login ?? '',
    viewerLogin,
    authority,
  });
  const policy = evaluateOwnReviewDismissal({
    approvalExempt: approvalPolicy.authorIsMaintainer && !authorityError,
    reviewClean,
    state: meta.state,
    mergeStateStatus: meta.mergeStateStatus,
    reviewDecision: meta.reviewDecision,
    viewerLogin,
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
    '当前 head 已完成最终代码重审且零 P0/P1,所有 conversation 已 resolve。' +
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
  const freshPolicy = evaluateMaintainerApprovalPolicy({
    authorLogin: freshMeta.author?.login ?? '',
    viewerLogin,
    authority: freshAuthority,
  });
  const writeFailures = [];
  if (String(freshMeta.headRefOid ?? '').toLowerCase() !== expectedHead.toLowerCase()) {
    writeFailures.push(`写操作前 head 已变化:${expectedHead} → ${freshMeta.headRefOid ?? '(empty)'}`);
  }
  if (freshAuthority.digest !== expectedAuthorityDigest) {
    writeFailures.push(`写操作前维护者权限已变化:${expectedAuthorityDigest} → ${freshAuthority.digest}`);
  }
  if (!freshPolicy.authorIsMaintainer) writeFailures.push('写操作前作者已不在最终维护者集合中');
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
  const errors = [];
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
    errors,
    approvalPolicy,
    viewer: policy.viewer,
    message,
  });
  process.exit(errors.length === 0 ? 0 : 2);
} catch (error) {
  fail(error);
}
