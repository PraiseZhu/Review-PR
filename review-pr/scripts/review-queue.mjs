#!/usr/bin/env node
// Durable host-facing queue. The host, never this shell script, spawns real agents.
import { readFileSync, readdirSync, existsSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from './runtime-io.mjs';
import { validateReviewCompletion, createFixHandoffRequest } from './review-round.mjs';
import { verifyReviewArtifacts } from './review-artifacts.mjs';
import { needsFinishContinuation } from './merge-retry.mjs';

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const items = (plan) => plan.groups.flatMap((g) => g.prs.map((p) => ({ ...p, group: g.id })));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

async function exclusive(file, fn) {
  const nonce = randomUUID();
  let fd;
  try { fd = openSync(file, 'wx', 0o600); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = read(file);
    if (!Number.isSafeInteger(owner.pid) || alive(owner.pid)) throw new Error('另一个调度命令仍在运行；主 session 必须串行调用 queue');
    unlinkSync(file);
    fd = openSync(file, 'wx', 0o600);
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); closeSync(fd);
  try { return await fn(); } finally {
    if (existsSync(file) && read(file).nonce === nonce) unlinkSync(file);
  }
}

export function queueSummary(queue) {
  return { runId: queue.runId, concurrency: queue.concurrency,
    active: queue.tasks.filter((t) => !['queued', 'complete'].includes(t.phase)),
    queued: queue.tasks.filter((t) => t.phase === 'queued').map((t) => t.pr),
    complete: queue.tasks.filter((t) => t.phase === 'complete').map((t) => t.pr),
    reconciled: queue.reconciled === true, allComplete: queue.tasks.every((t) => t.phase === 'complete') };
}

export async function runQueueCommand(options, dependencies = {}) {
  const { action, lockToken, agentId } = options;
  const planFile = resolve(options.planFile);
  const directory = dirname(planFile);
  const plan = read(planFile);
  const planned = items(plan);
  const lib = dependencies.assertLock ? null : await import('./lib.mjs');
  const assertLock = dependencies.assertLock || lib.assertActiveReviewLock;
  assertLock(lockToken);
  if (lib) { const repo = lib.parseRepo(); if (plan.repo !== `${repo.owner}/${repo.repo}`) throw new Error('队列不属于当前仓库'); }
  if (plan.roundDir && resolve(plan.roundDir) !== directory) throw new Error('计划目录不匹配');
  const queueFile = join(directory, 'queue.json');
  const worktrees = dependencies.worktrees || await import('./review-worktree.mjs');
  const now = () => new Date().toISOString();
  return exclusive(join(directory, 'queue-command.lock'), async () => {
    let queue = existsSync(queueFile) ? read(queueFile) : null;
    if (!queue) {
      if (action !== 'init') throw new Error('先 init 队列，再调度 agent');
      const concurrency = Number(options.concurrency);
      if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('concurrency 必须为 1..10 的宿主实际可用子 agent 名额');
      queue = { version: 1, runId: plan.runId, repo: plan.repo, concurrency, reconciled: false,
        tasks: planned.map((p) => ({ pr: p.pr, head: p.head, group: p.group, phase: 'queued', attempts: 0, reconciliationAttempts: 0 })) };
    }
    if (queue.runId !== plan.runId || queue.repo !== plan.repo || queue.tasks.length !== planned.length ||
        queue.tasks.some((t, i) => t.pr !== planned[i].pr || t.head !== planned[i].head)) throw new Error('队列与冻结计划不一致');
    atomicWriteJson(join(directory, 'coordinator.json'), { runId: plan.runId, lastSeenAt: now(), stopped: action === 'stop' });
    const save = () => { assertLock(lockToken); queue.updatedAt = now(); atomicWriteJson(queueFile, queue); };
    const task = queue.tasks.find((t) => t.pr === Number(options.pr));
    const wtOptions = (entry) => ({ planFile, pr: entry.pr, lockToken, repoRoot: options.repoRoot });
    if (action === 'close') {
      if (!existsSync(join(directory, 'finalized.json'))) throw new Error('先 finalize 汇总，不能提前关闭轮次');
      const finalized = read(join(directory, 'finalized.json'));
      if (plan.repo === 'makecindy/cindy') {
        const history = finalized.history;
        const synced = history?.sync?.ok === true &&
          (history.sync.pushed === true || history.sync.reason === 'nothing-to-push');
        if (finalized.runId !== plan.runId || history?.runId !== plan.runId ||
            history.ok !== true || history.enabled !== true || !synced) {
          throw new Error('Git 历史尚未成功发布，不能关闭轮次');
        }
      }
      await verifyQueueCompletion({ planFile, lockToken }, { worktrees });
      const cards = read(join(directory, 'feishu-cards.json'));
      const notification = read(join(directory, 'notification.json'));
      if (notification.runId !== plan.runId || !Array.isArray(notification.pages) || notification.pages.length !== cards.pages.length ||
          new Set(notification.pages.map((p) => p.page)).size !== cards.pages.length || cards.pages.some((page) => {
            const receipt = notification.pages.find((p) => p.page === page.page);
            // [MIVO-PATCH no-summary] 没配汇总群(plan.summaryChat 为空)时允许 status=disabled,并写明原因。
            if (receipt?.status === 'disabled') return plan.summaryChat?.chatId || !String(receipt.reason || '').trim() || !Number.isFinite(Date.parse(receipt.attemptedAt));
            return !receipt || !Number.isFinite(Date.parse(receipt.attemptedAt)) ||
              (receipt.status === 'sent' ? !String(receipt.messageId || '').trim() : receipt.status !== 'failed' || !String(receipt.reason || '').trim());
          })) throw new Error('每页飞书卡片必须有真实发送回执或明确失败记录，不能关闭轮次');
      atomicWriteJson(join(directory, 'completed.json'), { runId: plan.runId, completedAt: now(),
        notificationDelivered: notification.pages.every((p) => p.status === 'sent') });
      atomicWriteJson(join(directory, 'coordinator.json'), { runId: plan.runId, lastSeenAt: now(), stopped: true });
      return { ok: true, closed: true, ...queueSummary(queue) };
    }
    if (action === 'init' || action === 'status' || action === 'stop') { save(); return { ok: true, ...queueSummary(queue) }; }
    if (action === 'claim') {
      if (queueSummary(queue).active.length >= queue.concurrency) return { ok: true, claimed: false, reason: 'capacity', ...queueSummary(queue) };
      const next = queue.tasks.find((t) => t.phase === 'queued');
      if (!next) return { ok: true, claimed: false, reason: 'empty', ...queueSummary(queue) };
      next.phase = 'preparing'; next.attempts++; next.claimedAt = now(); next.agentId = null;
      next.agentExitedAt = null; next.cleanup = null; queue.reconciled = false; save();
      try {
        next.worktree = await worktrees.createReviewWorktree(wtOptions(next));
        next.phase = 'ready'; save();
        return { ok: true, claimed: true, task: { ...planned.find((p) => p.pr === next.pr), ...next,
          resultFile: join(directory, 'results', `pr-${next.pr}.json`), resume: next.attempts > 1 } };
      } catch (e) { next.phase = 'cleanup-pending'; next.error = e.message; save(); throw e; }
    }
    if (action === 'reconcile') {
      if (!queue.tasks.every((t) => t.phase === 'complete')) throw new Error('先完成全部 PR 审查和清理，再补齐 Approve 与合并收尾');
      const reopened = [];
      for (const t of queue.tasks) {
        const result = read(join(directory, 'results', `pr-${t.pr}.json`));
        const receipt = verifyReviewArtifacts(planFile, plan, result, { allowIncomplete: true });
        if (needsFinishContinuation(result, receipt) && t.reconciliationAttempts < 1) {
          t.phase = 'queued'; t.reconciliationAttempts++; reopened.push(t.pr);
        }
      }
      queue.reconciled = reopened.length === 0; save();
      return { ok: true, reopened, ...queueSummary(queue) };
    }
    if (!task) throw new Error('PR 不在队列内');
    if (action === 'bind') {
      if (!['ready', 'running'].includes(task.phase) || !String(agentId || '').trim()) throw new Error('只能把已准备的 worktree 绑定真实 agent ID');
      if (task.agentId && task.agentId !== agentId) throw new Error('该 PR 已有其他 agent，不能重复启动');
      task.agentId = agentId; task.phase = 'running'; task.boundAt = now(); save();
      return { ok: true, task };
    }
    if (action === 'complete') {
      if (task.phase === 'queued') throw new Error('未领取任务不能完成');
      if (!options.agentExited) throw new Error('必须先由宿主确认 agent 已退出');
      if (task.agentId ? task.agentId !== agentId : !options.noAgentStarted) throw new Error('退出回执必须匹配绑定的 agent ID；未启动须显式声明');
      const resultFile = join(directory, 'results', `pr-${task.pr}.json`);
      const result = read(resultFile);
      if (result.runId !== plan.runId || result.pr !== task.pr || result.head !== task.head || result.mode !== plan.mode) throw new Error('结果未绑定当前任务');
      validateReviewCompletion(result, planned.find((p) => p.pr === task.pr));
      verifyReviewArtifacts(planFile, plan, result, { allowIncomplete: true });
      const plannedItem = planned.find((p) => p.pr === task.pr);
      const request = createFixHandoffRequest({ ...result, selfFix: plannedItem.selfFix, base: result.base ?? plannedItem.base });
      if (request && (!['dispatched', 'deduplicated', 'failed', 'stale', 'needs-human'].includes(result.fixHandoff?.status) ||
          result.fixHandoff.fingerprint !== request.fingerprint || !result.fixHandoff.reason ||
          (['dispatched', 'deduplicated', 'needs-human'].includes(result.fixHandoff.status) && !result.fixHandoff.sessionId))) throw new Error('先完成自有 PR 的跟进投递/去重');
      task.agentExitedAt ||= now(); task.phase = 'cleanup-pending'; save();
      try {
        // A failed create may have left only an ownership reservation. Let the
        // lifecycle helper verify it; absence of a result/receipt never means done.
        task.cleanup = await worktrees.removeReviewWorktree({ ...wtOptions(task), agentExited: true,
          noAgentStarted: !task.agentId && options.noAgentStarted === true });
        await worktrees.verifyReviewWorktree({ ...wtOptions(task), expect: 'removed' });
        task.phase = 'complete'; task.completedAt = now(); delete task.error; save();
        return { ok: true, task, ...queueSummary(queue) };
      } catch (e) { task.error = e.message; save(); throw e; }
    }
    throw new Error(`未知 queue action: ${action}`);
  });
}

export async function verifyQueueCompletion({ planFile, lockToken }, dependencies = {}) {
  const plan = read(planFile);
  const queue = read(join(dirname(planFile), 'queue.json'));
  const planned = items(plan);
  if (queue.runId !== plan.runId || queue.repo !== plan.repo || !queue.reconciled || queue.tasks.length !== planned.length ||
      queue.tasks.some((t, i) => t.pr !== planned[i].pr || t.head !== planned[i].head || t.phase !== 'complete' || !t.agentExitedAt)) {
    throw new Error('队列尚未完成全部 PR、Approve/合并补齐与 worktree 清理，不能结束本轮');
  }
  const worktrees = dependencies.worktrees || await import('./review-worktree.mjs');
  for (const task of queue.tasks) {
    const result = read(join(dirname(planFile), 'results', `pr-${task.pr}.json`));
    verifyReviewArtifacts(planFile, plan, result);
    const receipt = await worktrees.verifyReviewWorktree({ planFile, pr: task.pr, lockToken, expect: 'removed' });
    if (receipt.generation !== task.cleanup?.generation) throw new Error('worktree 清理回执来自旧一代任务');
  }
  return queue;
}

// A crashed round is work even if all its PRs have since closed. Wake the host
// for cleanup/finalization before it creates another round and more worktrees.
export function findIncompleteRounds(stateDirectory, repo, mode) {
  return readdirSync(stateDirectory, { withFileTypes: true }).filter((d) => d.isDirectory() && /^round-[a-zA-Z0-9-]+$/.test(d.name))
    .map((d) => join(stateDirectory, d.name, 'plan.json')).filter((file) => existsSync(file))
    .map((file) => ({ file, plan: read(file) }))
    .filter(({ file, plan }) => plan.repo === repo && plan.mode === mode && plan.execution?.worktreeCleanupRequired &&
      !existsSync(join(dirname(file), 'completed.json')))
    .sort((a, b) => String(a.plan.manifest?.createdAt).localeCompare(String(b.plan.manifest?.createdAt)))
    .map(({ file }) => file);
}

async function watch(options) {
  const { assertActiveReviewLock, spawnScriptJson } = await import('./lib.mjs');
  const directory = dirname(resolve(options.planFile));
  const plan = read(options.planFile);
  const heartbeatFile = join(directory, 'heartbeat.json');
  const leaseMs = 10 * 60 * 1000;
  while (true) {
    try {
      const host = read(join(directory, 'coordinator.json'));
      const lastSeen = Date.parse(host.lastSeenAt);
      if (host.runId !== plan.runId || !Number.isFinite(lastSeen) || lastSeen > Date.now() + 60_000) throw new Error('主 session 心跳归属或时间无效');
      if (host.stopped || existsSync(join(directory, 'finalized.json')) || Date.now() - lastSeen > leaseMs) {
        atomicWriteJson(heartbeatFile, { stopped: true, reason: 'host-finished-or-expired', at: new Date().toISOString() }); return;
      }
      assertActiveReviewLock(options.lockToken);
      const refreshed = await spawnScriptJson(fileURLToPath(new URL('./refresh-lock.mjs', import.meta.url)), ['--token', options.lockToken]);
      if (!refreshed.refreshed || refreshed.lost) throw new Error('续锁失败或 review 锁已丢失');
      atomicWriteJson(heartbeatFile, { running: true, pid: process.pid, at: new Date().toISOString() });
    } catch (e) { atomicWriteJson(heartbeatFile, { lost: true, reason: e.message, at: new Date().toISOString() }); throw e; }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = (key) => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
  const options = { action: process.argv[2], planFile: arg('--plan'), lockToken: arg('--lock-token'),
    concurrency: arg('--concurrency'), pr: arg('--pr'), agentId: arg('--agent-id'),
    agentExited: process.argv.includes('--agent-exited'), noAgentStarted: process.argv.includes('--no-agent-started') };
  try { console.log(JSON.stringify(options.action === 'watch' ? await watch(options) || { ok: true, stopped: true } : await runQueueCommand(options))); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; }
}
