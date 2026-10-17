#!/usr/bin/env node
// Guarded Approve with a verified REST receipt and durable uncertain-write recovery.
// A pending attempt is reconciled by reads only; it is never blindly POSTed again.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseRepo, parsePR, gh, ghJson, fetchAllReviewThreads, fetchMaintainerAuthority,
  evaluateMaintainerApprovalPolicy, latestSubstantiveReviews, selectStandingViewerHumanChangesRequest,
  assertActiveReviewLock, stateFile, print } from './lib.mjs';
import { atomicWriteJson } from './runtime-io.mjs';
import { approvalReceiptFromReview, existingMaintainerApprovalReceipt, pendingApproval, APPROVAL_REPOST_AFTER_MS } from './approval-state.mjs';
import { recordSelfWrite } from './self-write-receipts.mjs';

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : '';
};
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

function readReviewPages(slug, pr) {
  const result = gh(['api', '--method', 'GET', '--paginate', '--slurp',
    `repos/${slug}/pulls/${pr}/reviews`, '-f', 'per_page=100'],
  { allowFail: true, noCredFallback: true, timeoutMs: 20_000 });
  if (!result.ok) return { verified: false, reviews: [], error: 'review 分页读取失败' };
  try {
    const pages = JSON.parse(result.stdout);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error('shape');
    return { verified: true, reviews: pages.flat(), error: null };
  } catch { return { verified: false, reviews: [], error: 'review 分页结果无法完整解析' }; }
}

function existingReceipt(result, viewer, head) {
  if (!result.verified) return null;
  const review = latestSubstantiveReviews(result.reviews).find((item) => same(item.user?.login, viewer));
  return approvalReceiptFromReview(review, { viewer, head });
}

let pr;
let attempted = false;
let verified = null;
try {
  const { owner, repo } = parseRepo();
  pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const reviewClean = process.argv.includes('--review-clean');
  const dryRun = process.argv.includes('--dry-run');
  const lockToken = argValue('--lock-token');
  const expectedHead = argValue('--expected-head');
  const expectedBase = argValue('--expected-base');
  const expectedBaseRef = argValue('--expected-base-ref');
  const expectedAuthorityDigest = argValue('--expected-authority-digest');
  const bodyFile = argValue('--body-file');
  const body = bodyFile ? readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8').trim()
    : '代码重审通过：当前 head 未发现 P0/P1，全部 conversation 已 resolve。';
  // [MIVO-PATCH self-review] 交互式重审通过、操作者当面同意后才带它:只放行审查账号上指名的那一条人工
  // Request Changes。无人值守的前置审查和服务器审查永远不传。
  const overrideRequested = process.argv.includes('--allow-override-own-cr');
  const overrideOwnCr = overrideRequested ? argValue('--allow-override-own-cr') : '';

  const collect = () => {
    assertActiveReviewLock(lockToken);
    const beforeObservedAt = Date.now();
    const meta = ghJson(['pr', 'view', String(pr), '--repo', slug,
      '--json', 'state,isDraft,reviewDecision,author,headRefOid,baseRefName,baseRefOid,updatedAt']);
    const viewer = String(gh(['api', 'user', '--jq', '.login'], { noCredFallback: true }).stdout ?? '').trim();
    let authority = null;
    let authorityError;
    try { authority = fetchMaintainerAuthority({ owner, repo }); } catch (error) { authorityError = error.message; }
    const policy = evaluateMaintainerApprovalPolicy({ authorLogin: meta.author?.login ?? '', viewerLogin: viewer, authority });
    const threads = fetchAllReviewThreads(owner, repo, pr);
    const reviews = readReviewPages(slug, pr);
    const substantive = latestSubstantiveReviews(reviews.reviews);
    const changes = substantive.filter((review) => String(review.state).toUpperCase() === 'CHANGES_REQUESTED');
    const independentReceipt = authority && reviews.verified && changes.length === 0
      ? substantive.map((review) => existingMaintainerApprovalReceipt(review, {
        author: meta.author?.login, maintainers: authority.members, reviewDecision: meta.reviewDecision, head: expectedHead,
      })).find(Boolean) ?? null
      : null;
    const failures = [];
    const reject = (code, reason) => failures.push({ code, reason });
    if (!reviewClean) reject('review-not-clean', '调用方未确认独立代码重审通过(--review-clean)');
    if (meta.state !== 'OPEN' || meta.isDraft) reject('state-changed', 'PR 已不是 open、非 draft 状态');
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expectedHead) || !same(meta.headRefOid, expectedHead)) {
      reject('head-changed', '当前 head 未与已审查 SHA 对齐');
    }
    if (expectedBase && (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expectedBase) || !same(meta.baseRefOid, expectedBase))) {
      reject('base-changed', '当前 base 已变化，必须重新核验 diff 后审查');
    }
    if (expectedBaseRef && meta.baseRefName !== expectedBaseRef) {
      reject('base-changed', '当前 base 分支名已变化，即使 SHA 相同也须按原任务重新核验');
    }
    if (authorityError) reject('authority-unverified', `维护者权限未完整读取：${authorityError}`);
    else if (!expectedAuthorityDigest || authority?.digest !== expectedAuthorityDigest) {
      reject('authority-changed', `维护者权限未验证或已变化${authorityError ? `：${authorityError}` : ''}`);
    }
    if (!viewer) reject('viewer-unverified', '当前 GitHub viewer 身份未完整读取');
    if (authority && viewer && !policy.viewerIsMaintainer) reject('viewer-not-maintainer', '当前 viewer 不在最终维护者集合中');
    if (policy.viewerIsAuthor && reviews.verified && !independentReceipt) {
      reject('independent-approval-required', '当前 viewer 是 PR 作者，未核验到另一位维护者的有效 Approve，不能自批');
    }
    if (!threads.verified) reject('threads-unverified', 'review thread 状态未完整读取');
    else if (threads.threads.some((thread) => !thread.isResolved)) reject('threads-unresolved', '仍有 conversation 未 resolve');
    if (!reviews.verified) reject('reviews-unverified', reviews.error);
    if (changes.some((review) => !same(review.user?.login, viewer))) {
      reject('other-changes-requested', '存在别人的有效 CHANGES_REQUESTED，不能靠本次 Approve 覆盖');
    }
    // [MIVO-PATCH self-review] 同一账号上维护者本人的人工 CR 仍有效时,不能靠审查机 Approve 覆盖;
    // 只有 --allow-override-own-cr 指名的正是这一条时放行,其它检查照旧。
    const standingOwnCr = selectStandingViewerHumanChangesRequest(reviews.reviews, viewer);
    if (overrideRequested && !/^\d{1,20}$/.test(overrideOwnCr)) {
      reject('override-id-invalid', `--allow-override-own-cr 需要一条 review id，收到「${overrideOwnCr.slice(0, 40)}」`);
    }
    if (standingOwnCr && String(standingOwnCr.id ?? '') !== overrideOwnCr) {
      reject('other-changes-requested', '审查账号上有维护者本人的 Request Changes，需本人 Approve 或 dismiss 后再审');
    }
    if (meta.reviewDecision === 'CHANGES_REQUESTED' && !changes.length) {
      reject('reviews-unverified', 'reviewDecision=CHANGES_REQUESTED，但未读取到对应 review');
    }
    return { meta, beforeObservedAt, viewer, authority, policy, failures, overriddenOwnCr: standingOwnCr ? String(standingOwnCr.id) : null,
      receipt: independentReceipt ?? existingReceipt(reviews, viewer, expectedHead) };
  };
  const stop = (snapshot, extraFailures = []) => {
    const failures = [...snapshot.failures, ...extraFailures];
    if (!failures.length) return;
    const uncertain = new Set(['authority-unverified', 'viewer-unverified', 'threads-unverified', 'reviews-unverified']);
    const realBlocker = failures.find((failure) => !uncertain.has(failure.code));
    const status = realBlocker ? 'blocked' : 'pending';
    print({ ok: true, pr, approved: false, dryRun, expectedHead, actualHead: snapshot.meta.headRefOid,
      approval: { status, code: (realBlocker || failures[0]).code, reason: failures.map((item) => item.reason).join('; ') },
      retry: status === 'pending',
      // [MIVO-PATCH approval-failures] approval.code 只取第一个真拦截;逐项 {code, reason} 一并带出,
      // 作者就是审查账号时,服务器审查靠它分清「只差另一位维护者 Approve」和「除此之外还有别的没过」。
      failures: failures.map(({ code, reason }) => ({ code, reason })),
      approvalPolicy: snapshot.policy, failedChecks: failures.map((item) => item.reason), reason: failures.map((item) => item.reason).join('; ') });
    process.exit(2);
  };

  const initial = collect();
  stop(initial);
  if (dryRun) {
    print({ ok: true, pr, approved: false, dryRun: true, viewer: initial.viewer, expectedHead,
      approval: { status: 'blocked', code: 'dry-run', reason: 'dry-run 已通过前置检查，未执行 Approve' }, approvalPolicy: initial.policy });
    process.exit(0);
  }
  // Repeat live authority/viewer/head/base/threads/other-review checks immediately
  // before either accepting an existing approval or posting a new one.
  const fresh = collect();
  stop(fresh, same(fresh.viewer, initial.viewer) ? [] : [{ code: 'viewer-changed', reason: '写操作前 GitHub viewer 已变化' }]);
  const key = createHash('sha256').update(`${fresh.viewer.toLowerCase()}|${expectedHead.toLowerCase()}`).digest('hex').slice(0, 24);
  const journalFile = stateFile(`approval-${pr}-${key}.json`);
  let journal = { uncertainWrite: false, attemptedAt: null, repostCount: 0 };
  const persist = (status, approval = null) => atomicWriteJson(journalFile, {
    version: 1, pr, head: expectedHead, viewer: fresh.viewer, status, approval, updatedAt: new Date().toISOString(),
    ...journal,
  });
  const complete = (approval, { alreadyApproved = false, reconciled = false } = {}) => {
    if (approval.status === 'verified') { verified = approval; journal.uncertainWrite = false; }
    persist(approval.status, approval);
    print({ ok: true, pr, approved: approval.status === 'verified', approval, alreadyApproved, reconciled,
      retry: approval.status === 'pending', viewer: fresh.viewer, expectedHead,
      ...(expectedBase ? { expectedBase } : {}), approvalPolicy: fresh.policy,
      ...(expectedBaseRef ? { expectedBaseRef } : {}),
      authority: { digest: fresh.authority.digest, teamHandle: fresh.authority.codeowners.teamHandle, memberCount: fresh.authority.memberCount },
      // [MIVO-PATCH self-review] 本次真的提交了 Approve,才写明盖掉的是哪一条人工打回。
      ...(approval.status === 'verified' && !alreadyApproved && fresh.overriddenOwnCr ? { overrodeOwnHumanCr: fresh.overriddenOwnCr } : {}),
      ...(approval.reason ? { reason: approval.reason } : {}) });
    process.exit(approval.status === 'verified' ? 0 : 2);
  };
  if (fresh.receipt) complete(fresh.receipt, { alreadyApproved: true });

  let previous;
  if (existsSync(journalFile)) {
    try {
      previous = JSON.parse(readFileSync(journalFile, 'utf8'));
      if (!previous || previous.version !== 1 || previous.pr !== pr || !same(previous.head, expectedHead) ||
          !same(previous.viewer, fresh.viewer) || !['posting', 'pending', 'verified', 'blocked'].includes(previous.status)) throw new Error('shape');
    } catch {
      journal.uncertainWrite = true;
      complete(pendingApproval('之前的 Approve 投递记录损坏，无法排除已写入；仅回查，不重复提交', 'approval-journal-unreadable'));
    }
  }
  if (previous) {
    journal = { uncertainWrite: previous.uncertainWrite ?? ['posting', 'pending'].includes(previous.status),
      attemptedAt: previous.attemptedAt ?? previous.updatedAt, repostCount: previous.repostCount ?? 0 };
  }
  if (previous && ['posting', 'pending'].includes(previous.status) && journal.uncertainWrite) {
    const age = Date.now() - Date.parse(journal.attemptedAt);
    if (!Number.isFinite(age) || journal.repostCount >= 1) {
      complete(pendingApproval('Approve 写入仍无法核验且自动重投额度已用完或记录不完整；需要维护者核对 review 后明确处置该投递记录',
        'approval-manual-reconciliation-required'), { reconciled: true });
    }
    if (age < APPROVAL_REPOST_AFTER_MS) {
      complete(pendingApproval('Approve 结果尚未核验；等待至少 10 分钟并完整回查后才允许一次 guarded 重投',
        'approval-reconciliation-pending'), { reconciled: true });
    }
    // Both complete pagination snapshots above found no effective approval.
    // A bounded delayed repost closes the pre-POST crash gap without looping.
    journal.repostCount++;
  }
  // This durable intent survives a killed process between POST and its receipt.
  journal.uncertainWrite = true;
  journal.attemptedAt = new Date().toISOString();
  persist('posting');
  assertActiveReviewLock(lockToken);
  attempted = true;
  const writeStartedAt = Date.now();
  const response = gh(['api', '--method', 'POST', `repos/${slug}/pulls/${pr}/reviews`, '--input', '-'],
    { input: JSON.stringify({ event: 'APPROVE', commit_id: expectedHead, body }), allowFail: true, noCredFallback: true, timeoutMs: 60_000 });
  recordSelfWrite({ directory: process.env.REVIEW_PR_SELF_WRITE_DIR || stateFile('self-writes'),
    repo: slug, pr, head: expectedHead, scope: lockToken, beforeUpdatedAt: fresh.meta.updatedAt, beforeObservedAt: fresh.beforeObservedAt,
    args: ['api', '--method', 'POST', `repos/${slug}/pulls/${pr}/reviews`],
    result: response, startedAt: writeStartedAt, finishedAt: Date.now() });
  let receipt;
  if (response.ok) {
    try { receipt = approvalReceiptFromReview(JSON.parse(response.stdout), { viewer: fresh.viewer, head: expectedHead }); } catch { /* reconcile once */ }
  }
  if (receipt) complete(receipt);
  // A timeout or malformed successful response can hide a successful mutation.
  // Exactly one complete pagination pass is used to reconcile this attempt.
  receipt = existingReceipt(readReviewPages(slug, pr), fresh.viewer, expectedHead);
  if (receipt) complete(receipt, { reconciled: true });
  const limited = !response.ok && (/\bHTTP 429\b/.test(String(response.stderr ?? '')) ||
    /\bHTTP 403\b/.test(String(response.stderr ?? '')) && /rate.?limit|secondary|abuse/i.test(String(response.stderr ?? '')));
  if (limited) {
    journal.uncertainWrite = false; // GitHub explicitly rejected it before execution.
    complete(pendingApproval('GitHub 暂时限制 Approve 请求；稍后重新检查并安全提交', 'approval-rate-limited'));
  }
  const definiteReject = !response.ok && /\bHTTP (?:400|401|403|404|409|422)\b/.test(String(response.stderr ?? ''));
  if (definiteReject) {
    journal.uncertainWrite = false;
    complete({ status: 'blocked', code: 'approval-rejected', reason: 'GitHub 明确拒绝 Approve，且回查未发现有效批准' });
  }
  complete(pendingApproval('Approve 请求结果不明，回查尚未取得真实 review ID；未重复提交', 'approval-receipt-pending'));
} catch (error) {
  const reason = String(error?.message ?? error);
  const approval = verified || (attempted ? pendingApproval(`Approve 请求后未完成回执核验：${reason}`, 'approval-receipt-pending')
    : pendingApproval(`Approve 前置检查尚未完成：${reason}`, 'approval-check-pending'));
  print({ ok: false, ...(pr ? { pr } : {}), approved: approval.status === 'verified', approval,
    retry: approval.status === 'pending', reason, error: reason });
  process.exit(1);
}
