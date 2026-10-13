#!/usr/bin/env node
// dismiss-stale-reviews.mjs — 当前 head 已解决此前 viewer 自己提的 CR 问题时,清理掉旧的
// CHANGES_REQUESTED review,避免「问题已修但 review 状态没更新」卡住合并。
//
// 场景:本流程账号(viewer)之前因格式门/安全门/代码审查提交了 REQUEST_CHANGES,作者
// 在后续 commit 中修复了问题。当前 head 的 gates 已干净(formatPass + security.pass),
// 但 GitHub 的 reviewDecision 仍然是 CHANGES_REQUESTED —— 这些旧 review 不再代表
// 当前 head,需要 dismiss 掉才能继续合并流程。
//
// ⚠️ 安全边界:
// - 只 dismiss viewer 自己的 CR review,绝不碰别人的 review
// - 只在 gates 明确干净时才 dismiss(由调用方传入 --gate-clean 确认)
// - dismiss 时带 message 说明原因,原 reviewer(自己)可追溯
// - 任何前置条件不满足 → 返回 dismissed:false + reason,不强行操作
//
// 跑:node <skill-root>/scripts/dismiss-stale-reviews.mjs <PR> --gate-clean --lock-token <prepare.lock.token>
//   --gate-clean:调用方确认当前 head 的格式门和安全门均已通过(格式完整+无凭证硬命中)
//   没有此标记时脚本只做检查不实际 dismiss(安全阀:防止脚本被误调)
//
// 退出码:0 = 已完成(含无需操作);1 = 脚本自身出错;2 = 已拒绝(前置条件不满足)

import {
  parseRepo,
  parsePR,
  gh,
  ghJson,
  latestSubstantiveReviews,
  assertActiveReviewLock,
  print,
  fail,
} from './lib.mjs';
import { selectGateReviewsToDismiss } from './review-markers.mjs';

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const dryRun = process.argv.includes('--dry-run');
  const gateClean = process.argv.includes('--gate-clean');
  const lockTokenIndex = process.argv.indexOf('--lock-token');
  const lockToken = lockTokenIndex >= 0 ? String(process.argv[lockTokenIndex + 1] ?? '').trim() : '';
  const slug = `${owner}/${repo}`;
  assertActiveReviewLock(lockToken);

  // ── 拉取当前状态 ──
  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'state,reviewDecision,headRefOid',
  ]);

  if (meta.state !== 'OPEN') {
    print({ ok: true, pr, dismissed: false, reason: `PR state=${meta.state}(非 OPEN,无需清理)` });
    process.exit(0);
  }

  const pages = ghJson([
    'api', '--method', 'GET', '--paginate', '--slurp',
    `repos/${slug}/pulls/${pr}/reviews`, '-f', 'per_page=100',
  ]);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('review REST 分页结果形状异常');
  }
  const allReviews = pages.flat();
  const changesRequestedReviews = latestSubstantiveReviews(allReviews)
    .filter((review) => review.state === 'CHANGES_REQUESTED');
  if (changesRequestedReviews.length === 0) {
    print({ ok: true, pr, dismissed: false, reason: '没有 CHANGES_REQUESTED review,无需清理' });
    process.exit(0);
  }

  // 获取 viewer 身份
  const viewerLogin = (gh(['api', 'user', '--jq', '.login']).stdout ?? '').trim();

  // 先用每个 reviewer 的最新实质 review 判断当前 blocker；确认只有 viewer 有效 CR 后，
  // dismiss viewer 的全部历史 CR，避免 dismiss 最新一条后更早 CR 又重新浮上来。
  const effectiveOwnCRs = changesRequestedReviews.filter(
    (r) => (r.user?.login ?? r.author?.login ?? '') === viewerLogin,
  );
  if (effectiveOwnCRs.length === 0) {
    print({
      ok: true, pr, dismissed: false,
      reason: `${changesRequestedReviews.length} 条当前有效 CHANGES_REQUESTED 但都不是 viewer(${viewerLogin}) 的,不替别人撤 review`,
    });
    process.exit(0);
  }

  const otherCRs = changesRequestedReviews.filter(
    (r) => (r.user?.login ?? r.author?.login ?? '') !== viewerLogin,
  );
  const ownCRs = selectGateReviewsToDismiss(allReviews, viewerLogin, meta.headRefOid);
  if (otherCRs.length > 0) {
    print({
      ok: true, pr, dismissed: false,
      reason: `${ownCRs.length} 条 viewer 自己的 CR + ${otherCRs.length} 条别人的当前有效 CR(作者:${[...new Set(otherCRs.map(r => r.user?.login ?? r.author?.login))].join('/')}),别人的还在 → 不单独 dismiss 自己的`,
    });
    process.exit(0);
  }
  if (ownCRs.length === 0) {
    print({ ok: true, pr, dismissed: false, reason: '没有可撤的旧格式/安全门 review；内容审查、未标记的旧 review 和当前 head 的 CR 保留，需完整重审后 Approve' });
    process.exit(0);
  }

  // ── 安全阀:调用方必须显式传 --gate-clean 确认 gates 已通过 ──
  if (!gateClean) {
    print({
      ok: true, pr, dismissed: false,
      reason: '缺少 --gate-clean 标记(调用方未确认当前 head 的格式门/安全门已通过),拒绝 dismiss。这是安全阀:防止脚本被误调而 dismiss 仍有问题的 review',
    });
    process.exit(2);
  }

  // ── 全满足 → dismiss 每条 viewer 自己的 CR ──
  if (dryRun) {
    print({
      ok: true, pr, dismissed: false, dryRun: true,
      reason: `dry-run:将 dismiss ${ownCRs.length} 条 viewer(${viewerLogin}) 的 CHANGES_REQUESTED review`,
      reviewIds: ownCRs.map((r) => r.id),
    });
    process.exit(0);
  }

  const message =
    '这些问题已在当前 head 的后续 commit 中修复(格式门/安全门已通过),' +
    '自动 dismiss 旧的 CHANGES_REQUESTED 以解除合并阻塞。';

  const dismissed = [];
  const errors = [];
  assertActiveReviewLock(lockToken);
  for (const r of ownCRs) {
    try {
      assertActiveReviewLock(lockToken);
      const fresh = ghJson(['pr', 'view', String(pr), '--repo', slug, '--json', 'state,headRefOid']);
      if (fresh.state !== 'OPEN' || fresh.headRefOid !== meta.headRefOid) throw new Error('dismiss 前 head/state 已变化，停止清理');
      gh([
        'api',
        '--method', 'PUT',
        `repos/${slug}/pulls/${pr}/reviews/${r.id}/dismissals`,
        '--input', '-',
      ], {
        input: JSON.stringify({ message, event: 'DISMISS' }),
        timeoutMs: 15_000,
        noCredFallback: true,
      });
      dismissed.push({ id: r.id, author: r.user?.login ?? r.author?.login, submittedAt: r.submittedAt });
    } catch (e) {
      errors.push({ id: r.id, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  if (errors.length > 0) {
    print({
      ok: true, pr,
      dismissed: dismissed.length > 0,
      partial: errors.length > 0,
      dismissedCount: dismissed.length,
      errorCount: errors.length,
      dismissed,
      errors,
      message,
    });
  } else {
    print({
      ok: true, pr,
      dismissed: true,
      dismissedCount: dismissed.length,
      dismissed,
      message,
    });
  }
  process.exit(0);
} catch (e) {
  fail(e);
}
