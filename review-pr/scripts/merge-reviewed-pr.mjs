#!/usr/bin/env node
// merge-reviewed-pr.mjs — 把 pre-merge 全门复核与最终 authority/head 复核贴近 merge 写入。
//
// 跑:node <skill-root>/scripts/merge-reviewed-pr.mjs <PR>
//   --lock-token <prepare.lock.token> --expected-head <sha> --expected-authority-digest <digest>
//   --method <squash|merge|rebase> [--admin] [--delete-branch] [--dry-run]
// 退出码:0 = 已合并 / dry-run 可执行；2 = 前置条件不满足；1 = 脚本异常。

import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseRepo,
  parsePR,
  gh,
  ghJson,
  fetchMaintainerAuthority,
  evaluateMaintainerApprovalPolicy,
  evaluateMaintainerReview,
  evaluateFinalMergeAuthorization,
  assertActiveReviewLock,
  STATE_DIR,
  print,
  fail,
} from './lib.mjs';
import { acquireBaseMergeLock } from './base-merge-lock.mjs';
import { classifyMergeRejection } from './merge-write-state.mjs';
import { isTransientMergeCheck } from './merge-retry.mjs';

let mergeLock = null;
let mergeConfirmed = false;
let mergeAttempted = false;
function releaseMergeLock() {
  if (!mergeLock) return null;
  const result = mergeLock.release({ confirmed: mergeConfirmed });
  mergeLock = null;
  return result;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : '';
}

function fetchReviewPages(slug, pr) {
  const result = gh([
    'api', '--method', 'GET', '--paginate', '--slurp',
    `repos/${slug}/pulls/${pr}/reviews`, '-f', 'per_page=100',
  ], { allowFail: true, timeoutMs: 20_000 });
  if (!result.ok) return { verified: false, reviews: [], error: String(result.stderr || result.stdout || '').trim().slice(0, 300) };
  try {
    const pages = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      return { verified: false, reviews: [], error: 'review 分页结果形状异常' };
    }
    return { verified: true, reviews: pages.flat(), error: null };
  } catch (error) {
    return { verified: false, reviews: [], error: `review 分页 JSON 解析失败:${error.message}` };
  }
}

function stop(pr, failedChecks, extra = {}) {
  const released = releaseMergeLock();
  print({ ok: true, pr, merged: false, mergeAttempted, failedChecks, reason: failedChecks.join(';'), ...extra,
    ...(released ? { mergeLock: released } : {}),
    ...(released?.pending ? { pending: true, retry: true, mergeLock: released } : {}) });
  process.exit(2);
}

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const lockToken = argValue('--lock-token');
  const expectedHead = argValue('--expected-head');
  const expectedBase = argValue('--expected-base');
  const expectedBaseRef = argValue('--expected-base-ref');
  const expectedAuthorityDigest = argValue('--expected-authority-digest');
  const method = argValue('--method');
  const admin = process.argv.includes('--admin');
  const deleteBranch = process.argv.includes('--delete-branch');
  const dryRun = process.argv.includes('--dry-run');
  const initialFailures = [];
  if (!expectedHead) initialFailures.push('缺少 --expected-head');
  if (!expectedAuthorityDigest) initialFailures.push('缺少 --expected-authority-digest');
  if (!['squash', 'merge', 'rebase'].includes(method)) initialFailures.push('--method 必须是 squash / merge / rebase');
  if (initialFailures.length) stop(pr, initialFailures);
  assertActiveReviewLock(lockToken);

  // Approve and code review run outside this short lock. This guarded entrypoint
  // owns it while re-reading all merge gates and submitting the merge only.
  const baseMeta = ghJson(['pr', 'view', String(pr), '--repo', slug,
    '--json', 'state,headRefOid,baseRefName,baseRefOid']);
  const baseRefName = baseMeta.baseRefName;
  const mergeBase = expectedBase || baseMeta.baseRefOid;
  if (!baseRefName || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(mergeBase ?? '') ||
      baseMeta.state !== 'OPEN' || baseMeta.headRefOid !== expectedHead ||
      baseMeta.baseRefOid !== mergeBase || expectedBaseRef && expectedBaseRef !== baseRefName) {
    stop(pr, ['PR head/base/state 已变化，需重新核验 diff 后审查'], { code: 'base-or-head-changed' });
  }
  const acquired = await acquireBaseMergeLock({ directory: STATE_DIR, repo: slug, baseRefName, pr, head: expectedHead,
    reconcileAbandoned: async (owner) => {
      try {
        const current = ghJson(['pr', 'view', String(owner.pr), '--repo', slug, '--json', 'state,mergedAt']);
        return current.state === 'CLOSED' || current.state === 'MERGED' && Boolean(current.mergedAt);
      } catch { return false; }
    } });
  if (!acquired.acquired) stop(pr, [acquired.reason], { code: acquired.code, pending: true, retry: true });
  mergeLock = acquired;
  mergeLock.assertOwned();
  assertActiveReviewLock(lockToken);

  const preMergePath = fileURLToPath(new URL('./pre-merge-check.mjs', import.meta.url));
  const checked = spawnSync(process.execPath, [
    preMergePath,
    String(pr),
    '--expected-head', expectedHead,
    '--expected-authority-digest', expectedAuthorityDigest,
    '--expected-base', mergeBase,
    '--expected-base-ref', baseRefName,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (checked.error) throw new Error(`pre-merge-check 执行失败:${checked.error.message}`);
  let check;
  try {
    check = JSON.parse(checked.stdout || 'null');
  } catch (error) {
    throw new Error(`pre-merge-check 输出无法解析:${error.message}`);
  }
  if (!check || check.ok !== true) {
    throw new Error(`pre-merge-check 失败:${String(checked.stderr ?? '').trim() || '无有效 JSON'}`);
  }

  const routeAvailable = admin
    ? Boolean(check.structuralBypassAvailable)
    : Boolean(check.normalMergeAvailable || (
      check.canMerge && check.approvalPolicy?.approvalRequired === true
    ));
  if (!routeAvailable) {
    stop(pr, [
      admin
        ? 'pre-merge-check 未授权 admin merge route'
        : 'pre-merge-check 未授权普通 merge route',
      ...(check.blockers ?? []),
    ], { preMerge: check, retry: isTransientMergeCheck(check) });
  }

  // 跟 pre-merge 绑定当前 viewer；否则 auth switch 后会拿旧账号的 bypass 结论给新账号用。
  const viewerLogin = String(gh(['api', 'user', '--jq', '.login']).stdout ?? '').trim();
  // 写入前最后一次完整 authority + PR 绑定。任何 Team/成员/权限/CODEOWNERS 变化都重新 review。
  const authority = fetchMaintainerAuthority({ owner, repo });
  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'state,author,headRefOid,baseRefName,baseRefOid,reviewDecision,mergeable,mergeStateStatus,commits',
  ]);
  if (meta.baseRefName !== baseRefName || meta.baseRefOid !== mergeBase) {
    stop(pr, ['写入前 base 分支或 SHA 已变化，需重新核验 diff 后审查'], { code: 'base-changed', preMerge: check });
  }
  const policy = evaluateMaintainerApprovalPolicy({
    authorLogin: meta.author?.login ?? '',
    viewerLogin,
    authority,
  });
  const latestCommitDate = (meta.commits ?? []).reduce(
    (latest, commit) => String(commit?.committedDate ?? '') > latest ? String(commit.committedDate) : latest,
    '',
  );
  const finalReviews = fetchReviewPages(slug, pr);
  const finalMaintainerReview = finalReviews.verified
    ? evaluateMaintainerReview({
      reviews: finalReviews.reviews.map((review) => ({
        login: review.user?.login ?? '',
        state: review.state,
        at: review.submitted_at ?? '',
      })),
      maintainers: authority.members,
      latestCommitDate,
      authorLogin: policy.author,
    })
    : null;
  const finalAuthorization = evaluateFinalMergeAuthorization({
    admin,
    approvalExemptAdminAvailable: false,
    structuralBypassAvailable: Boolean(check.structuralBypassAvailable),
    expectedHead,
    actualHead: meta.headRefOid,
    expectedAuthorityDigest,
    actualAuthorityDigest: authority.digest,
    expectedViewer: check.approvalPolicy?.viewer,
    actualViewer: viewerLogin,
    expectedAuthor: check.approvalPolicy?.author,
    actualAuthor: policy.author,
    authorIsMaintainer: policy.authorIsMaintainer,
    approvalRequired: policy.approvalRequired,
    maintainerReviewsVerified: finalReviews.verified,
    effectiveMaintainerApproval: finalMaintainerReview?.released?.via === 'github-approve',
    reviewDecision: meta.reviewDecision,
    state: meta.state,
  });
  if (!finalAuthorization.available) {
    stop(pr, finalAuthorization.failedChecks, {
      authority: { digest: authority.digest, teamHandle: authority.codeowners.teamHandle },
      approvalPolicy: policy,
    });
  }

  assertActiveReviewLock(lockToken);
  mergeLock.assertOwned();
  const mergeArgs = [
    'pr', 'merge', String(pr), '--repo', slug,
    `--${method}`,
    '--match-head-commit', expectedHead,
  ];
  if (admin) mergeArgs.push('--admin');
  if (deleteBranch) mergeArgs.push('--delete-branch');

  if (dryRun) {
    releaseMergeLock();
    print({
      ok: true,
      pr,
      merged: false,
      mergeAttempted,
      dryRun: true,
      route: admin ? 'admin' : 'normal',
      method,
      deleteBranch,
      authority: { digest: authority.digest, teamHandle: authority.codeowners.teamHandle },
      approvalPolicy: policy,
      preMerge: check,
    });
    process.exit(0);
  }

  // merge 是不可逆写入；禁止凭证 fallback 在最后一跳悄悄切换 GitHub 身份。
  // Persist the uncertain-write phase before spawning gh. If this process dies,
  // another worker must reconcile this PR before reclaiming the base lock.
  mergeAttempted = true;
  mergeLock.markMerging();
  const response = gh(mergeArgs, { timeoutMs: 120_000, noCredFallback: true, allowFail: true });
  const rejection = classifyMergeRejection(response);
  if (rejection) {
    // Persist proof before unlinking: a crash in between remains reclaimable,
    // and a later OPEN PR is not mistaken for an unresolved mutation forever.
    mergeLock.markRejected(rejection);
    stop(pr, [rejection.reason], { code: rejection.code, mergeAttempt: rejection });
  }
  const mergedState = ghJson(['pr', 'view', String(pr), '--repo', slug, '--json', 'state,mergedAt']);
  const actuallyMerged = mergedState.state === 'MERGED' && Boolean(mergedState.mergedAt);
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(mergedState.state) || mergedState.state === 'MERGED' && !actuallyMerged) {
    throw new Error('合并后 PR 状态或 mergedAt 未完整核验，保留不明写入记录');
  }
  if (!response.ok && !actuallyMerged && mergedState.state !== 'CLOSED') {
    throw new Error('合并请求失败且只读回查仍不能确认终态；不得重发或释放不明写入记录');
  }
  mergeConfirmed = ['OPEN', 'CLOSED', 'MERGED'].includes(mergedState.state);
  const released = releaseMergeLock();
  print({
    ok: true,
    pr,
    merged: actuallyMerged,
    mergeAttempted,
    queued: !actuallyMerged && mergedState.state === 'OPEN',
    reason: actuallyMerged ? '已合并' : mergedState.state === 'CLOSED' ? 'PR 已关闭，未合并'
      : 'GitHub 已接受请求，但尚未完成合并；保留在 merge queue 等待',
    route: admin ? 'admin' : 'normal',
    method,
    deleteBranch,
    expectedHead,
    expectedBase: mergeBase,
    baseRefName,
    expectedBaseRef: expectedBaseRef || baseRefName,
    reconciled: !response.ok,
    mergeLock: released,
    authority: { digest: authority.digest, teamHandle: authority.codeowners.teamHandle },
    approvalPolicy: policy,
  });
  process.exit(0);
} catch (error) {
  const released = releaseMergeLock();
  if (released?.pending) {
    print({ ok: false, merged: false, mergeAttempted, pending: true, retry: true, mergeLock: released,
      code: 'merge-reconciliation-pending', reason: '合并写入结果不明，保留 base 锁记录供只读核验', error: error.message });
    process.exit(1);
  }
  fail(error);
}
