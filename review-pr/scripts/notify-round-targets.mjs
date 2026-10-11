#!/usr/bin/env node
// Notify stacked PRs skipped before workers exist; also repairs resumed old plans.
// node notify-round-targets.mjs --plan <plan.json> --lock-token <token>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRepo, loadMaintainerAuthoritySnapshot, assertActiveReviewLock, spawnScriptJson, print, fail } from './lib.mjs';
import { atomicWriteJson } from './runtime-io.mjs';
import { needsTargetBranchNotice, validateTargetBranchNotice } from './review-round.mjs';
import { startReviewHeartbeat } from './review-heartbeat.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
  return process.argv[i + 1];
};

try {
  const planFile = arg('--plan');
  const token = arg('--lock-token');
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const { owner, repo } = parseRepo();
  if (plan.repo !== `${owner}/${repo}` || !['auto', 'review-only'].includes(plan.mode)) throw new Error('计划仓库或模式无效');
  const authority = loadMaintainerAuthoritySnapshot({ owner, repo, lockToken: token });
  if (authority.digest !== plan.authorityDigest) throw new Error('计划的维护者权限已变化');
  const results = [];
  const heartbeat = await startReviewHeartbeat(token);
  try {
    for (const item of plan.skipped) {
      if (!['dependency', 'retarget'].includes(item.outcome)) continue;
      // Older frozen plans omitted branch evidence retained in their contexts.
      if ((!item.defaultBranch || item.basePr === undefined) && item.contextFile) {
        const context = JSON.parse(readFileSync(item.contextFile, 'utf8'));
        if (context.pr !== item.pr || context.meta?.headRefOid !== item.head || context.meta?.baseRefName !== item.baseRefName) {
          throw new Error(`PR #${item.pr} 的旧计划 context 与 head/base 不一致`);
        }
        item.defaultBranch = context.meta?.defaultBranch;
        item.basePr = context.meta?.basePr ?? null;
      }
      if (!needsTargetBranchNotice(item)) continue;
      if (item.targetBranchNotice) {
        validateTargetBranchNotice(item);
        continue; // At most one attempt per round; failures retry in the next round.
      }
      heartbeat.assertHealthy();
      assertActiveReviewLock(token);
      let response;
      try {
        if (!item.baseRefName || !item.defaultBranch) throw new Error('目标分支证据不完整');
        response = await spawnScriptJson(fileURLToPath(new URL('./notify-author-resolve.mjs', import.meta.url)),
          [String(item.pr), '--target-branch', '--lock-token', token, '--expected-head', item.head,
            '--expected-base-ref', item.baseRefName, '--expected-authority-digest', authority.digest,
            ...(plan.mode === 'review-only' ? ['--review-only'] : [])], { timeoutMs: 180_000 });
      } catch (error) { response = { ok: false, error: error.message }; }
      heartbeat.assertHealthy();
      assertActiveReviewLock(token);
      if (response.ok && (response.reason === 'state-changed' ||
          (response.defaultBranch && response.defaultBranch !== item.defaultBranch))) {
        item.outcome = 'state-changed';
        item.reason = '提醒前 PR 的 head、目标分支或依赖已变化；下轮重新采集';
        item.retry = true;
      } else {
        const completed = response.ok && response.head === item.head && response.baseRefName === item.baseRefName &&
          response.defaultBranch === item.defaultBranch && /^[0-9a-f]{64}$/.test(response.fingerprint ?? '') &&
          (response.posted === true || response.reason === 'already-commented');
        item.targetBranchNotice = { head: item.head, baseRefName: item.baseRefName, defaultBranch: item.defaultBranch,
          status: completed ? response.posted ? 'posted' : 'deduplicated' : 'failed',
          ...(completed ? { fingerprint: response.fingerprint, url: response.url } :
            { reason: response.error || response.reason || '目标分支提醒未确认' }) };
        if (!completed) {
          item.retry = true;
          item.errors = [...(item.errors ?? []), `目标分支提醒失败：${item.targetBranchNotice.reason}`];
        }
      }
      atomicWriteJson(planFile, plan); // Persist each receipt before proceeding.
      results.push({ pr: item.pr, outcome: item.outcome, notice: item.targetBranchNotice });
    }
    atomicWriteJson(planFile, plan);
  } finally { await heartbeat.stop(); }
  print({ ok: true, results });
} catch (error) { fail(error); }
