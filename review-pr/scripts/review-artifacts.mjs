// Check durable review evidence before deleting a disposable checkout and again
// before finalization. A path written in a result is not proof the report exists.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { needsMergeRetry, isFinishInProgress } from './merge-retry.mjs';

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const blockedCheck = (check) => check?.ok === true && check.canMerge === false &&
  check.normalMergeAvailable !== true && (check.blockers?.some(nonempty) ||
    check.mergeable === 'UNKNOWN' || check.mergeStateStatus === 'UNKNOWN' || check.mergeableUnknown === true);

export function verifyReviewArtifacts(planFile, plan, result, { allowIncomplete = false } = {}) {
  if (!result.reviewClean) return;
  const directory = realpathSync(dirname(planFile));
  const report = result.reportFile;
  let rel = '..';
  if (typeof report === 'string' && isAbsolute(report) && existsSync(report)) rel = relative(directory, realpathSync(report));
  if (rel.startsWith('..') || isAbsolute(rel) || /^worktrees[\\/]/i.test(rel) ||
      !readFileSync(report, 'utf8').trim()) throw new Error(`PR #${result.pr} 的审查报告必须实际保存在 roundDir、worktree 之外`);
  if (result.approval.status === 'verified') {
    const receipt = JSON.parse(readFileSync(join(directory, `finish-pr-${result.pr}.json`), 'utf8'));
    if (receipt.runId !== plan.runId || receipt.pr !== result.pr || receipt.head !== result.head ||
        receipt.mode !== plan.mode || receipt.approval?.status !== 'verified' ||
        ['reviewId', 'reviewer', 'head'].some((key) => String(receipt.approval[key]) !== String(result.approval[key]))) {
      throw new Error(`PR #${result.pr} 的 Approve 结论与 guarded finish 的实际回执不一致`);
    }
    if (!result.merged && needsMergeRetry(receipt) && result.retry !== true) {
      throw new Error(`PR #${result.pr} 的 guarded finish 临时异常必须保留 retry=true，不能缓存为普通 merge-blocked`);
    }
    if (isFinishInProgress(receipt)) {
      // Cleanup is allowed after an interrupted worker exits, but completion is
      // not: the coordinator must resume the durable checkpoint this round.
      if (!allowIncomplete || result.outcome !== 'error' || result.retry !== true || result.merged) {
        throw new Error(`PR #${result.pr} 的 guarded finish 尚未完成，必须记录 error/retry 并恢复收尾`);
      }
      return receipt;
    }
    if (result.merged || receipt.merged) {
      if (receipt.stage !== 'merged' || receipt.merged !== true || receipt.merge?.merged !== true ||
          result.merged !== true || result.outcome !== 'merged') {
        throw new Error(`PR #${result.pr} 的合并结论与 guarded finish 的实际回执不一致`);
      }
      return receipt;
    }
    let terminal = false;
    switch (receipt.stage) {
      case 'reviewed-only':
        terminal = plan.mode === 'review-only' && result.outcome === 'review-only';
        break;
      case 'merge-queued':
        terminal = plan.mode === 'auto' && result.outcome === 'merge-queued' &&
          receipt.queued === true && receipt.merge?.queued === true;
        break;
      case 'merge-blocked': {
        const merge = receipt.merge;
        terminal = plan.mode === 'auto' && ['merge-blocked', 'error'].includes(result.outcome) &&
          (merge ? merge.merged !== true && merge.queued !== true &&
            (blockedCheck(merge.preMerge) || merge.failedChecks?.some(nonempty) ||
             nonempty(merge.code) && nonempty(merge.reason) || merge.ok === false && nonempty(merge.error))
            : blockedCheck(receipt.preMerge));
        break;
      }
      case 'label-sync-blocked':
        terminal = receipt.release?.ok === false || receipt.release?.labels?.errors?.length > 0 ||
          nonempty(receipt.release?.labelWarning);
        break;
      case 'check-failed':
        terminal = receipt.preMerge?.ok === false && nonempty(receipt.preMerge.error || receipt.preMerge.reason);
        break;
      case 'approval-checkpoint-failed':
        terminal = receipt.approvalResult?.ok === false && result.retry === true;
        break;
    }
    if (!terminal || !nonempty(receipt.reason)) {
      throw new Error(`PR #${result.pr} 缺少可核验的合并终态或阻塞证据，不能只凭 Approve 结束本轮`);
    }
    return receipt;
  }
}
