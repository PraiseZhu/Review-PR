#!/usr/bin/env node
// request-changes-reviewed-pr.mjs — 把审查发现绑定到本轮锁、已审查 head 与当前维护者身份。
//
// 跑:node <skill-root>/scripts/request-changes-reviewed-pr.mjs <PR>
//   --lock-token <prepare.lock.token> --expected-head <sha>
//   --expected-authority-digest <digest> --body-file <path|-> [--dry-run]

import { readFileSync } from 'node:fs';
import { gateReviewMarker } from './review-markers.mjs';
import { normalizeReviewComments, findingsMarker } from './review-comments.mjs';
import { createPrWriteGuard } from './pr-write-guard.mjs';
import {
  parseRepo,
  parsePR,
  gh,
  ghJson,
  fetchMaintainerAuthority,
  evaluateMaintainerApprovalPolicy,
  reviewRecordActor,
  readReviewIdentityOrEmpty,
  isReviewIdentity,
  sameReviewActor,
  assertActiveReviewLock,
  fetchRestPages,
  loadRules,
  print,
  fail,
} from './lib.mjs';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : '';
}

// [MIVO-PATCH reviewer-app] 失败信息不得带令牌:先抹掉环境里的令牌原值,再抹 GitHub 令牌格式与 Bearer 头。
function scrubSecrets(text) {
  let out = String(text ?? '');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'REVIEW_PR_IDENTITY_TOKEN', 'REVIEW_PR_READ_TOKEN', 'CHECKS_TOKEN']) {
    const value = String(process.env[key] ?? '').trim();
    if (value.length >= 8) out = out.split(value).join('[redacted]');
  }
  return out.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}\b/g, '[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
}

// 写入失败写清动作、期望与实际 HTTP 状态(不含令牌),不回落到别的凭证。
function toWriteError(action, error) {
  const detail = scrubSecrets(error?.message ?? error);
  const status = /HTTP (\d{3})/.exec(detail)?.[1] ?? '(无状态码)';
  return new Error(`${action}失败:期望 GitHub 返回 2xx,实际 HTTP ${status}(${detail.slice(0, 300)})`);
}

function stop(pr, failedChecks, extra = {}) {
  print({ ok: true, pr, submitted: false, failedChecks, reason: failedChecks.join(';'), ...extra });
  process.exit(2);
}

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const lockToken = argValue('--lock-token');
  const expectedHead = argValue('--expected-head');
  const expectedAuthorityDigest = argValue('--expected-authority-digest');
  const bodyFile = argValue('--body-file');
  const dryRun = process.argv.includes('--dry-run');
  const commentOnly = process.argv.includes('--comment-only');
  const commentsFile = argValue('--comments-file');
  if (bodyFile === '-' && commentsFile === '-') throw new Error('正文和 comments 不能同时读取 stdin');
  const comments = commentsFile ? normalizeReviewComments(JSON.parse(readFileSync(commentsFile === '-' ? 0 : commentsFile, 'utf8'))) : [];
  let body = bodyFile ? readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8').trim() : '';
  const gateKind = argValue('--gate-kind');
  const initialFailures = [];
  if (!expectedHead) initialFailures.push('缺少 --expected-head');
  if (!expectedAuthorityDigest) initialFailures.push('缺少 --expected-authority-digest');
  if (!bodyFile) initialFailures.push('缺少 --body-file');
  if (body.length < 4) initialFailures.push('Request Changes 正文过短');
  if (initialFailures.length) stop(pr, initialFailures);
  if (gateKind) body += `\n\n${gateReviewMarker(gateKind, expectedHead)}`;
  const marker = comments.length ? findingsMarker(expectedHead, body, comments) : null;
  if (marker) body += `\n\n${marker}`;
  assertActiveReviewLock(lockToken);

  const identity = readReviewIdentityOrEmpty();
  const viewerLogin = identity.viewerLogin;
  const authority = fetchMaintainerAuthority({ owner, repo });
  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug, '--json', 'state,author,headRefOid',
  ]);
  const reviewerApps = loadRules().reviewerApps ?? [];
  const policy = evaluateMaintainerApprovalPolicy({
    authorLogin: reviewRecordActor({ author: meta.author }),
    viewerLogin,
    authority,
    reviewerIdentity: identity,
    reviewerApps,
  });
  const failedChecks = [];
  if (authority.digest !== expectedAuthorityDigest) {
    failedChecks.push(`维护者权限已变化:${expectedAuthorityDigest} → ${authority.digest}`);
  }
  // 审查 App(reviewerApps)可以发审查;它不是维护者,其它放行动作不在这里。
  if (!policy.viewerIsMaintainer && !policy.viewerIsReviewerApp) failedChecks.push(`当前 viewer ${viewerLogin || '(empty)'} 不在最终维护者集合中`);
  if (meta.state !== 'OPEN') failedChecks.push(`PR state=${meta.state || '(empty)'}`);
  if (String(meta.headRefOid ?? '').toLowerCase() !== expectedHead.toLowerCase()) {
    failedChecks.push(`当前 head 已变化:${expectedHead} → ${meta.headRefOid ?? '(empty)'}`);
  }
  if (policy.viewerIsAuthor && !commentOnly) failedChecks.push('GitHub 不允许给自己的 PR 提 Request Changes；问题 thread 可显式用 --comment-only');
  if (commentOnly && !comments.length) failedChecks.push('--comment-only 必须附带实际问题 thread');
  if (failedChecks.length) stop(pr, failedChecks, { approvalPolicy: policy });

  if (dryRun) {
    print({ ok: true, pr, submitted: false, dryRun: true, expectedHead, approvalPolicy: policy, body, comments, event: commentOnly ? 'COMMENT' : 'REQUEST_CHANGES' });
    process.exit(0);
  }

  assertActiveReviewLock(lockToken);
  const freshIdentity = readReviewIdentityOrEmpty();
  const freshViewer = freshIdentity.viewerLogin;
  const freshAuthority = fetchMaintainerAuthority({ owner, repo });
  const freshMeta = ghJson([
    'pr', 'view', String(pr), '--repo', slug, '--json', 'state,author,headRefOid',
  ]);
  const freshPolicy = evaluateMaintainerApprovalPolicy({
    authorLogin: reviewRecordActor({ author: freshMeta.author }),
    viewerLogin: freshViewer,
    authority: freshAuthority,
    reviewerIdentity: freshIdentity,
    reviewerApps,
  });
  const finalFailures = [];
  if (!sameReviewActor(freshViewer, viewerLogin)) finalFailures.push(`GitHub viewer 已变化:${viewerLogin} → ${freshViewer}`);
  if (freshAuthority.digest !== expectedAuthorityDigest) finalFailures.push(`写操作前维护者权限已变化:${expectedAuthorityDigest} → ${freshAuthority.digest}`);
  if (!freshPolicy.viewerIsMaintainer && !freshPolicy.viewerIsReviewerApp) finalFailures.push('写操作前 viewer 已不在最终维护者集合中');
  if (freshMeta.state !== 'OPEN') finalFailures.push(`写操作前 PR state=${freshMeta.state || '(empty)'}`);
  if (String(freshMeta.headRefOid ?? '').toLowerCase() !== expectedHead.toLowerCase()) {
    finalFailures.push(`写操作前 head 已变化:${expectedHead} → ${freshMeta.headRefOid ?? '(empty)'}`);
  }
  if (freshPolicy.viewerIsAuthor && !commentOnly) finalFailures.push('写操作前变成自己的 PR');
  if (finalFailures.length) stop(pr, finalFailures, { approvalPolicy: freshPolicy });

  assertActiveReviewLock(lockToken);
  const write = createPrWriteGuard({ owner, repo, pr, lockToken, expectedHead, expectedAuthorityDigest, expectedViewer: freshViewer, purpose: 'review', reviewerApps });
  const event = commentOnly ? 'COMMENT' : 'REQUEST_CHANGES';
  const existing = marker ? fetchRestPages(`repos/${slug}/pulls/${pr}/reviews`).find((review) =>
    review.body?.includes(marker) && review.commit_id === expectedHead &&
    isReviewIdentity(review.user, freshIdentity) && ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(review.state)) : null;
  const lineComments = comments.filter((comment) => comment.subject_type !== 'file');
  let review = existing;
  if (!review) {
    try {
      review = JSON.parse(write([
        'api', '--method', 'POST', `repos/${slug}/pulls/${pr}/reviews`, '--input', '-',
      ], { input: JSON.stringify({ event, commit_id: expectedHead, body, ...(lineComments.length ? { comments: lineComments } : {}) }),
        noCredFallback: true, timeoutMs: 60_000 }).stdout);
    } catch (error) {
      throw toWriteError(`提交 ${event} review`, error);
    }
  }
  const threadUrls = [];
  // GitHub's create-review schema supports line comments; file-level threads use
  // the separate review-comments endpoint. Per-comment markers permit safe resume.
  const fileComments = comments.filter((comment) => comment.subject_type === 'file');
  const priorComments = fileComments.length ? fetchRestPages(`repos/${slug}/pulls/${pr}/comments`) : [];
  for (const [i, comment] of fileComments.entries()) {
    const fileMarker = `${marker}\n<!-- review-pr:file-finding index=${i} -->`;
    let posted = priorComments.find((item) => item.body?.includes(fileMarker) && isReviewIdentity(item.user, freshIdentity));
    if (!posted) {
      try {
        posted = JSON.parse(write(['api', '--method', 'POST', `repos/${slug}/pulls/${pr}/comments`, '--input', '-'], {
          input: JSON.stringify({ ...comment, commit_id: expectedHead, body: `${comment.body}\n\n${fileMarker}` }), timeoutMs: 60_000,
        }).stdout);
      } catch (error) {
        stop(pr, [toWriteError('提交文件级 thread', error).message], { reviewId: review.id, partial: true, threadUrls });
      }
    }
    if (posted.html_url) threadUrls.push(posted.html_url);
  }
  if (lineComments.length) {
    const reviewComments = fetchRestPages(`repos/${slug}/pulls/${pr}/reviews/${review.id}/comments`);
    if (reviewComments.length < lineComments.length) stop(pr, ['GitHub 未返回全部行内 thread'], { partial: true, reviewId: review.id });
    threadUrls.push(...reviewComments.map((comment) => comment.html_url).filter(Boolean));
  }
  print({ ok: true, pr, submitted: true, alreadySubmitted: Boolean(existing), action: commentOnly ? 'comment-findings' : 'request-changes',
    expectedHead, reviewId: review.id, reviewUrl: review.html_url, threadUrls, approvalPolicy: freshPolicy });
  process.exit(0);
} catch (error) {
  fail(new Error(scrubSecrets(error?.message ?? error)));
}
