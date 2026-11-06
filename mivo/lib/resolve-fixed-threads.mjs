#!/usr/bin/env node
// resolve-fixed-threads.mjs — 发布本轮结论之后,在已修好的旧 thread 里回复一条带 thread-fixed 标记的说明(Review-PR #115,#185 改为只回复)。
// 服务器不关 thread:关闭交给 Mini 盯梢(用 App 身份,按标记里的 key + head 认)。这里只发 addPullRequestReviewThreadReply 一个 mutation,
// 不再调用共享的 resolve-threads.mjs(那个脚本是交互式 review-pr 的「回复 + resolve」,保持原样),也不发 resolveReviewThread。
// 回复前在每一条补上锁、head、账号权限检查,并只处理 thread-resolution.mjs 选出来的 thread。
// 失败只返回 warning,不让整轮审查失败。每条 thread 动手前单独现查并重算清单(批次中途出现的新裁定 / 新评论不会被旧清单覆盖)。
// 每条顺序:绑定检查(锁 / 账号 / 权限 / head)→ 重读该 thread 并重算清单 → 立即回复,重读与回复之间不插别的网络请求。
// 重读 thread 的每一次 GraphQL 响应(thread 分页、评论分页)同时带回并校验 PR 的 head / base / state(bindGraphqlToPr),
// 所以重读期间 head 变化会让读取未验证、该条跳过;校验不到(缺字段 / 不符)一律保守停止。
// thread 快照必须一次响应读完(fetchSingleSnapshot):要翻页(thread 超过 100 条或单条评论超过 100 条)时各页不是同一时刻,本轮不回复。
// 残余窗口:从最后一次已验证的重读响应到那一次回复 mutation 之间,head / thread 仍可能变化,不能逐 mutation 原子校验。
//
// 用法:node resolve-fixed-threads.mjs < request.json(cwd 必须是目标仓检出目录;令牌只走环境变量,不进请求)
// request: { binding:{targetRepo,pr,head,base,baseRefName,reviewer,lockToken,authorityDigest,runUrl,mode}, round, contextFile, excludedKeys }
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCRIPTS, readJson } from './common.mjs';
import { buildThreadResolutionPlan } from './thread-resolution.mjs';
import { scrubSecrets } from '../../review-pr/scripts/secret-scrub.mjs';

const TOTAL_BUDGET_MS = 180_000;
const ITEM_TIMEOUT_MS = 60_000;
const MIN_ITEM_MS = 5_000;

const PR_FIELDS = 'state isDraft headRefOid baseRefOid baseRefName';

/**
 * 包装 fetchAllReviewThreads 的 ghGraphqlFn 注入点:往每个查询里加 PR 的 state / isDraft / headRefOid / baseRefOid / baseRefName,
 * 并校验同一次响应里的值和 binding 一致。thread 页查询从 pullRequest 取,评论翻页查询从 thread.pullRequest 取。
 * 查询没有注入点、响应缺字段、或任一字段不符都抛错,让读取器返回 verified=false(调用方记 warning、不写)。
 */
export function bindGraphqlToPr(binding, ghGraphqlFn) {
  return (query, vars, opts) => {
    let kind = null;
    let bound = String(query);
    if (/pullRequest\(number:\$num\)\s*\{/.test(bound)) {
      kind = 'page';
      bound = bound.replace(/(pullRequest\(number:\$num\)\s*\{)/, `$1 ${PR_FIELDS}`);
    } else if (/\.\.\.\s*on\s+PullRequestReviewThread\s*\{/.test(bound)) {
      kind = 'comments';
      bound = bound.replace(/(\.\.\.\s*on\s+PullRequestReviewThread\s*\{)/, `$1 pullRequest{ ${PR_FIELDS} }`);
    }
    if (!kind) throw new Error('无法把 PR head / base 绑定进这次读取,保守停止');
    const result = ghGraphqlFn(bound, vars, opts);
    if (result?.errors?.length) return result; // 读取器对 errors 一律判未验证
    const pr = kind === 'page' ? result?.data?.repository?.pullRequest : result?.data?.node?.pullRequest;
    if (!pr || [pr.state, pr.headRefOid, pr.baseRefOid, pr.baseRefName].some((v) => typeof v !== 'string' || !v) || typeof pr.isDraft !== 'boolean') {
      throw new Error('读取 thread 的响应缺少 PR state / head / base,无法确认绑定,保守停止');
    }
    if (pr.state !== 'OPEN' || pr.isDraft) throw new Error('读取 thread 期间 PR 已不是 OPEN 非 Draft');
    if (pr.headRefOid !== binding.head) throw new Error(`读取 thread 期间 PR head 已变化(响应 ${String(pr.headRefOid).slice(0, 12)},绑定 ${String(binding.head).slice(0, 12)})`);
    if (pr.baseRefOid !== binding.base || pr.baseRefName !== binding.baseRefName) throw new Error('读取 thread 期间 PR base 已变化');
    return result;
  };
}

/**
 * 用一次 GraphQL 响应读完 thread 快照:thread 超过一页、或某条 thread 的评论要翻页时,各页来自不同时刻,
 * 前一页里的 thread 在后一页请求期间新增的裁定看不到。这种情况整份快照按「未验证」处理,本轮不回复(留给人)。
 * 每次响应仍经 bindGraphqlToPr 校验 PR head / base / state。
 */
export function fetchSingleSnapshot({ owner, repo, pr, binding, ghGraphqlFn, fetchAllReviewThreads }) {
  let responses = 0;
  const bound = bindGraphqlToPr(binding, (...args) => { responses += 1; return ghGraphqlFn(...args); });
  const result = fetchAllReviewThreads(owner, repo, pr, { includeComments: true, ghGraphqlFn: bound });
  if (result?.verified && responses !== 1) {
    return { threads: [], verified: false, errors: [`thread 快照需要翻页(${responses} 次请求),各页不是同一时刻,本轮不回复`] };
  }
  return result;
}

const clip = (text, max = 240) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const summary = (status, skippedReason, items = [], warnings = []) => ({
  ok: true, status, skippedReason: skippedReason ?? null,
  plannedCount: items.length,
  repliedCount: items.filter((i) => i.status === 'replied').length,
  items, warnings,
});
// 只发回复,不 resolve:thread 的关闭由盯梢做。
const REPLY_MUTATION = `mutation($tid:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$tid, body:$body}){ comment{ id } }
}`;

/**
 * @param {object} request 见文件头
 * @param {object} deps
 *   readContext(file) → prepare 的 context.json
 *   assertBinding(binding) → {maintainers:string[]};锁、写账号、权限、authority、PR 状态/head/base 任一不符就抛错
 *   fetchThreads() → {threads, verified, errors}   发布后重新完整分页读取
 *   replyOne({id, reply}, {timeoutMs}) → addPullRequestReviewThreadReply 的 GraphQL 回执;失败可以抛错
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
    const base = { round, head: binding.head, reviewer: binding.reviewer, reviewerIdentity: binding.reviewerIdentity, runUrl: binding.runUrl, reviewedThreads, excludedKeys };
    // 先用 prepare 快照预筛:没有候选就不访问网络。
    const pre = buildThreadResolutionPlan({ ...base, liveThreads: reviewedThreads, threadsVerified: true, maintainers: [] });
    if (!pre.threads.length) return summary('skipped', pre.skippedReason);

    const { maintainers } = deps.assertBinding(binding);
    const fresh = deps.fetchThreads();
    if (!fresh?.verified) {
      warnings.push(`旧 thread 修复说明回复跳过:发布后重新读取 thread 不完整(${clip((fresh?.errors ?? []).join('; '))})`);
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
        if (!stopped) { warnings.push('旧 thread 修复说明回复预算用完,剩余 thread 留给下一轮'); stopped = true; }
        continue;
      }
      // 每条先核对锁 / 账号 / 权限 / head(多次网络查询),变了就停。
      try {
        deps.assertBinding(binding);
      } catch (error) {
        items.push({ ...entry, status: 'skipped', reason: 'binding-changed' });
        warnings.push(`旧 thread 修复说明回复停止:${clip(scrubSecrets(error.message))}`);
        stopped = true;
        continue;
      }
      // 再单独现查并重算清单:处理前面几条、以及上面的绑定查询期间,这一条可能新增维护者裁定 / 作者申辩 / 被 resolve / unresolve,
      // 旧清单不能当授权。用同一个纯选择器重算,这条不在新清单里(或回复正文变了)就跳过。
      // 这次重读必须是回复前的最后一个网络请求,中间不再插入别的查询。
      const live = deps.fetchThreads();
      if (!live?.verified) {
        items.push({ ...entry, status: 'skipped', reason: 'threads-unverified' });
        warnings.push(`旧 thread 修复说明回复停止:处理前重新读取 thread 不完整(${clip((live?.errors ?? []).join('; '))})`);
        stopped = true;
        continue;
      }
      const current = buildThreadResolutionPlan({ ...base, liveThreads: live.threads, threadsVerified: true, maintainers }).threads.find((t) => t.id === thread.id);
      if (!current || current.reply !== thread.reply) {
        items.push({ ...entry, status: 'skipped', reason: 'changed-since-plan' });
        warnings.push(`旧 thread 修复说明回复跳过(${thread.key}):处理前现查发现该 thread 已变化(新裁定 / 新评论 / 已 resolve / head 变化),留给下一轮`);
        continue;
      }
      let receipt;
      try {
        receipt = deps.replyOne({ id: thread.id, reply: thread.reply }, { timeoutMs: Math.min(ITEM_TIMEOUT_MS, remaining) });
      } catch (error) {
        const reason = clip(scrubSecrets(error?.message ?? error));
        items.push({ ...entry, status: 'failed', reason });
        warnings.push(`旧 thread 修复说明回复失败(${thread.key}):${reason}`);
        stopped = true; // 写结果未知(含超时)不重试,也不再碰后面的
        continue;
      }
      // 只有没有 errors、且回执里有非空 comment id 才算回复成功;缺 data / 缺 id / errors 伴随部分 data 都按失败,不计入 repliedCount。
      const commentId = receipt?.data?.addPullRequestReviewThreadReply?.comment?.id;
      if (receipt?.errors?.length || typeof commentId !== 'string' || !commentId) {
        const reason = receipt?.errors?.length
          ? clip(scrubSecrets(`GraphQL errors:${receipt.errors.map((e) => e?.message ?? '').join('; ')}`))
          : '回复未返回 comment id';
        items.push({ ...entry, status: 'failed', reason });
        warnings.push(`旧 thread 修复说明回复失败(${thread.key}):${reason}`);
        stopped = true; // 未知写结果不重试,也不再碰后面的
        continue;
      }
      items.push({ ...entry, status: 'replied', commentId });
    }
    const failed = items.some((i) => i.status === 'failed') || stopped;
    return summary(failed ? 'partial' : 'completed', null, items, warnings);
  } catch (error) {
    warnings.push(`旧 thread 修复说明回复跳过:${clip(scrubSecrets(error.message))}`);
    return summary('skipped', 'error', [], warnings);
  }
}

/**
 * 写前绑定检查(每条回复前都跑)。lib 注入以便测试:锁、写账号与绑定的审查账号完全一致(精确比较,不用别名集合)、
 * 维护者 authority digest、PR 状态/head/base 都不能变。执行资格:写账号是最终维护者,或是配置的审查 App(reviewerApps);
 * 审查 App 只获得这里的回复资格,不是维护者。
 */
export function createAssertBinding({ lib, owner, repo }) {
  return (b) => {
    for (const field of ['targetRepo', 'pr', 'head', 'base', 'baseRefName', 'reviewer', 'lockToken', 'authorityDigest']) {
      if (!b?.[field]) throw new Error(`缺少绑定字段 ${field}`);
    }
    lib.assertActiveReviewLock(b.lockToken);
    const identity = lib.readReviewIdentityOrEmpty();
    const viewer = identity.viewerLogin;
    if (!viewer || !lib.sameReviewActor(viewer, b.reviewer)) throw new Error(`当前写账号不是本轮审查账号(期望 ${b.reviewer},实际 ${viewer || '(empty)'})`);
    const authority = lib.fetchMaintainerAuthority({ owner, repo });
    const meta = lib.ghJson(['pr', 'view', String(b.pr), '--repo', b.targetRepo, '--json', 'state,isDraft,headRefOid,baseRefOid,baseRefName,author']);
    const policy = lib.evaluateMaintainerApprovalPolicy({ authorLogin: meta.author?.login, viewerLogin: viewer, authority, reviewerIdentity: identity,
      reviewerApps: lib.loadRules().reviewerApps ?? [] });
    if (authority.digest !== b.authorityDigest || !(policy.viewerIsMaintainer || policy.viewerIsReviewerApp)) {
      throw new Error(`维护者名单已变化或写账号既不是维护者也不是配置的审查 App(authority 期望 ${b.authorityDigest} 实际 ${authority.digest};写账号 ${viewer})`);
    }
    if (meta.state !== 'OPEN' || meta.isDraft || meta.headRefOid !== b.head || meta.baseRefOid !== b.base || meta.baseRefName !== b.baseRefName) {
      throw new Error(`PR 状态、head 或 base 已变化(期望 OPEN/${b.head}/${b.base}/${b.baseRefName},实际 ${meta.state}${meta.isDraft ? '(draft)' : ''}/${meta.headRefOid}/${meta.baseRefOid}/${meta.baseRefName})`);
    }
    lib.assertActiveReviewLock(b.lockToken);
    return { maintainers: authority.members ?? [] };
  };
}

// ── 真实依赖(只在 CLI 里用;导出是为了让测试走生产写入路径,不是注入协议)────────────────
export async function realDeps({ binding }) {
  const lib = await import(pathToFileURL(join(SCRIPTS, 'lib.mjs')).href);
  const [owner, repo] = String(binding.targetRepo).split('/');
  const parsed = lib.parseRepo();
  if (`${parsed.owner}/${parsed.repo}`.toLowerCase() !== String(binding.targetRepo).toLowerCase()) throw new Error('cwd 的 git remote 与目标仓不一致');
  const assertBinding = createAssertBinding({ lib, owner, repo });
  return {
    readContext: (file) => readJson(file),
    assertBinding,
    fetchThreads: () => fetchSingleSnapshot({ owner, repo, pr: Number(binding.pr), binding, ghGraphqlFn: lib.ghGraphql, fetchAllReviewThreads: lib.fetchAllReviewThreads }),
    replyOne: (thread, { timeoutMs }) => lib.ghGraphql(REPLY_MUTATION, { tid: thread.id, body: thread.reply }, { timeoutMs }),
  };
}

async function main() {
  let request;
  try { request = JSON.parse(readFileSync(0, 'utf8')); } catch { console.log(JSON.stringify(summary('skipped', 'bad-request', [], ['请求不是合法 JSON']))); return; }
  let deps;
  try { deps = await realDeps(request); } catch (error) {
    console.log(JSON.stringify(summary('skipped', 'deps-unavailable', [], [`旧 thread 修复说明回复跳过:${clip(scrubSecrets(error.message))}`])));
    return;
  }
  console.log(JSON.stringify(resolveFixedThreads(request, deps)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
