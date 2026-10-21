#!/usr/bin/env node
// resolve-fixed-threads.mjs — 发布本轮结论之后,代 resolve 已修好的旧 thread(Review-PR #115)。
// 共享的 resolve-threads.mjs 只负责「回复 + resolve」,不校验锁、head、账号权限,所以这里在每一条调用前补这些检查,
// 并只处理 thread-resolution.mjs 选出来的 thread;共享脚本本身不改。
// 失败只返回 warning,不让整轮审查失败。每条 thread 动手前单独现查并重算清单(批次中途出现的新裁定 / 新评论不会被旧清单覆盖)。
// 每条顺序:绑定检查(锁 / 账号 / 权限 / head)→ 重读该 thread 并重算清单 → 立即调用共享脚本,重读与调用之间不插别的网络请求。
// 残余窗口:只剩共享脚本内部「再读 threads → 回复 → resolve」之间 head / thread 仍可能变化,不能逐 mutation 原子校验。
//
// 用法:node resolve-fixed-threads.mjs < request.json(cwd 必须是目标仓检出目录;令牌只走环境变量,不进请求)
// request: { binding:{targetRepo,pr,head,base,baseRefName,reviewer,lockToken,authorityDigest,runUrl,mode}, round, contextFile, excludedKeys }
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCRIPTS, readJson, runScript } from './common.mjs';
import { buildThreadResolutionPlan } from './thread-resolution.mjs';

const TOTAL_BUDGET_MS = 180_000;
const ITEM_TIMEOUT_MS = 60_000;
const MIN_ITEM_MS = 5_000;

const clip = (text, max = 240) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const summary = (status, skippedReason, items = [], warnings = []) => ({
  ok: true, status, skippedReason: skippedReason ?? null,
  plannedCount: items.length,
  resolvedCount: items.filter((i) => i.status === 'resolved').length,
  alreadyResolvedCount: items.filter((i) => i.status === 'already-resolved').length,
  items, warnings,
});

/**
 * @param {object} request 见文件头
 * @param {object} deps
 *   readContext(file) → prepare 的 context.json
 *   assertBinding(binding) → {maintainers:string[]};锁、写账号、权限、authority、PR 状态/head/base 任一不符就抛错
 *   fetchThreads() → {threads, verified, errors}   发布后重新完整分页读取
 *   resolveOne({id, reply}, {timeoutMs}) → 共享 resolve-threads.mjs 对这一条的回执(ok/results/rejected)
 *   now() → 毫秒时间戳
 */
export function resolveFixedThreads(request, deps) {
  const warnings = [];
  const { binding = {}, round = {}, contextFile, excludedKeys } = request ?? {};
  const now = deps.now ?? Date.now;
  const startedAt = now();
  try {
    // 先查模式:dry-run / sandbox / 非法值直接跳过,不访问 GitHub。
    if (binding.mode !== 'live' || round.mode !== 'live') return summary('skipped', 'not-live');
    const context = deps.readContext(contextFile);
    const reviewedThreads = context?.history?.reviewThreads;
    if (!Array.isArray(reviewedThreads)) return summary('skipped', 'no-reviewed-threads');
    const base = { round, head: binding.head, reviewer: binding.reviewer, runUrl: binding.runUrl, reviewedThreads, excludedKeys };
    // 先用 prepare 快照预筛:没有候选就不访问网络。
    const pre = buildThreadResolutionPlan({ ...base, liveThreads: reviewedThreads, threadsVerified: true, maintainers: [] });
    if (!pre.threads.length) return summary('skipped', pre.skippedReason);

    const { maintainers } = deps.assertBinding(binding);
    const fresh = deps.fetchThreads();
    if (!fresh?.verified) {
      warnings.push(`代 resolve 跳过:发布后重新读取 thread 不完整(${clip((fresh?.errors ?? []).join('; '))})`);
      return summary('skipped', 'threads-unverified', [], warnings);
    }
    const plan = buildThreadResolutionPlan({ ...base, liveThreads: fresh.threads, threadsVerified: true, maintainers });
    if (!plan.threads.length) return summary('skipped', plan.skippedReason);

    const items = [];
    let stopped = false;
    for (const thread of plan.threads) {
      const entry = { id: thread.id, key: thread.key };
      const remaining = TOTAL_BUDGET_MS - (now() - startedAt);
      if (stopped || remaining < MIN_ITEM_MS) {
        items.push({ ...entry, status: 'skipped', reason: stopped ? 'stopped-after-failure' : 'budget-exhausted' });
        if (!stopped) { warnings.push('代 resolve 预算用完,剩余 thread 留给下一轮'); stopped = true; }
        continue;
      }
      // 每条先核对锁 / 账号 / 权限 / head(多次网络查询),变了就停。
      try {
        deps.assertBinding(binding);
      } catch (error) {
        items.push({ ...entry, status: 'skipped', reason: 'binding-changed' });
        warnings.push(`代 resolve 停止:${clip(error.message)}`);
        stopped = true;
        continue;
      }
      // 再单独现查并重算清单:处理前面几条、以及上面的绑定查询期间,这一条可能新增维护者裁定 / 作者申辩 / 被 resolve / unresolve,
      // 旧清单不能当授权。用同一个纯选择器重算,这条不在新清单里(或回复正文变了)就跳过。
      // 这次重读必须是调用共享脚本前的最后一个网络请求,中间不再插入别的查询。
      const live = deps.fetchThreads();
      if (!live?.verified) {
        items.push({ ...entry, status: 'skipped', reason: 'threads-unverified' });
        warnings.push(`代 resolve 停止:处理前重新读取 thread 不完整(${clip((live?.errors ?? []).join('; '))})`);
        stopped = true;
        continue;
      }
      const current = buildThreadResolutionPlan({ ...base, liveThreads: live.threads, threadsVerified: true, maintainers }).threads.find((t) => t.id === thread.id);
      if (!current || current.reply !== thread.reply) {
        items.push({ ...entry, status: 'skipped', reason: 'changed-since-plan' });
        warnings.push(`代 resolve 跳过(${thread.key}):处理前现查发现该 thread 已变化(新裁定 / 新评论 / 已 resolve / head 变化),留给下一轮`);
        continue;
      }
      let receipt;
      try {
        receipt = deps.resolveOne({ id: thread.id, reply: thread.reply }, { timeoutMs: Math.min(ITEM_TIMEOUT_MS, remaining) });
      } catch (error) {
        items.push({ ...entry, status: 'failed', reason: clip(error.message) });
        warnings.push(`代 resolve 失败(${thread.key}):${clip(error.message)}`);
        stopped = true;
        continue;
      }
      const result = (receipt?.results ?? []).find((r) => r?.id === thread.id);
      if (!receipt?.ok || !result || (receipt.results ?? []).length !== 1) {
        items.push({ ...entry, status: 'failed', reason: clip(receipt?.error ?? 'resolve-threads 回执不完整') });
        warnings.push(`代 resolve 回执异常(${thread.key}),停止后续`);
        stopped = true; // 未知写结果不重试,也不再碰后面的
      } else if (result.resolved === true) items.push({ ...entry, status: 'resolved' });
      else if (result.done === true && /already-resolved/.test(result.reason ?? '')) items.push({ ...entry, status: 'already-resolved' });
      else if (/reopened-after-triage/.test(result.reason ?? '')) items.push({ ...entry, status: 'skipped', reason: 'reopened-after-triage' });
      else {
        const reason = clip(result.replyError ?? result.resolveError ?? result.reason ?? 'unresolved');
        items.push({ ...entry, status: 'failed', reason });
        warnings.push(`代 resolve 未完成(${thread.key}):${reason}`);
      }
    }
    const failed = items.some((i) => i.status === 'failed') || stopped;
    return summary(failed ? 'partial' : 'completed', null, items, warnings);
  } catch (error) {
    warnings.push(`代 resolve 跳过:${clip(error.message)}`);
    return summary('skipped', 'error', [], warnings);
  }
}

// ── 真实依赖(只在 CLI 里用;测试注入替身)────────────────────────────────────
async function realDeps({ binding }) {
  const lib = await import(pathToFileURL(join(SCRIPTS, 'lib.mjs')).href);
  const [owner, repo] = String(binding.targetRepo).split('/');
  const parsed = lib.parseRepo();
  if (`${parsed.owner}/${parsed.repo}`.toLowerCase() !== String(binding.targetRepo).toLowerCase()) throw new Error('cwd 的 git remote 与目标仓不一致');
  const lower = (v) => String(v ?? '').toLowerCase();
  const assertBinding = (b) => {
    for (const field of ['targetRepo', 'pr', 'head', 'base', 'baseRefName', 'reviewer', 'lockToken', 'authorityDigest']) {
      if (!b?.[field]) throw new Error(`缺少绑定字段 ${field}`);
    }
    lib.assertActiveReviewLock(b.lockToken);
    const viewer = String(lib.gh(['api', 'user', '--jq', '.login'], { noCredFallback: true }).stdout).trim();
    if (!viewer || lower(viewer) !== lower(b.reviewer)) throw new Error('当前写账号不是本轮审查账号');
    const authority = lib.fetchMaintainerAuthority({ owner, repo });
    const meta = lib.ghJson(['pr', 'view', String(b.pr), '--repo', b.targetRepo, '--json', 'state,isDraft,headRefOid,baseRefOid,baseRefName,author']);
    const policy = lib.evaluateMaintainerApprovalPolicy({ authorLogin: meta.author?.login, viewerLogin: viewer, authority });
    if (authority.digest !== b.authorityDigest || !policy.viewerIsMaintainer) throw new Error('维护者名单已变化或写账号不是维护者');
    if (meta.state !== 'OPEN' || meta.isDraft || meta.headRefOid !== b.head || meta.baseRefOid !== b.base || meta.baseRefName !== b.baseRefName) {
      throw new Error('PR 状态、head 或 base 已变化');
    }
    lib.assertActiveReviewLock(b.lockToken);
    return { maintainers: authority.members ?? [] };
  };
  return {
    readContext: (file) => readJson(file),
    assertBinding,
    fetchThreads: () => lib.fetchAllReviewThreads(owner, repo, Number(binding.pr), { includeComments: true }),
    resolveOne: (thread, { timeoutMs }) => runScript('resolve-threads.mjs', [String(binding.pr), '--payload-file', '-'],
      { cwd: process.cwd(), env: process.env, input: JSON.stringify({ threads: [thread] }), timeoutMs }),
  };
}

async function main() {
  let request;
  try { request = JSON.parse(readFileSync(0, 'utf8')); } catch { console.log(JSON.stringify(summary('skipped', 'bad-request', [], ['请求不是合法 JSON']))); return; }
  let deps;
  try { deps = await realDeps(request); } catch (error) {
    console.log(JSON.stringify(summary('skipped', 'deps-unavailable', [], [`代 resolve 跳过:${clip(error.message)}`])));
    return;
  }
  console.log(JSON.stringify(resolveFixedThreads(request, deps)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
