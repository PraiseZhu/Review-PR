#!/usr/bin/env node
// resolve-threads.mjs — thread 代 resolve(triage 的执行端,对应 SKILL「thread 清理」)
//
// 背景:分支保护开了 Require conversation resolution,thread 不 resolve 就 GitHub 层面
// 合不了;而 bot(greptile 等)从不回来点 resolve,作者修完也常忘点 —— 台账里十几轮
// 整轮空转都是这个原因。判「意见是否已被处理」是语义活,由调用方(编排层按 SKILL
// 「thread 清理」+ lib.mjs assessThreadEvidence 的语义绑定判据)做;本脚本执行
// 确定性动作(**回复 + resolve**),并在执行层自带独立安全边界(不依赖调用方已经
// 过滤干净,defense-in-depth):
//   - 每次代 resolve 都带一条回复(写明验证依据的 commit)——原 reviewer 收到 GitHub
//     通知,不同意一键 unresolve,下一轮流程看到 thread 又开了就重新阻断。不允许静默
//     resolve;
//   - 只操作当前 PR 上真实存在且未 resolve 的 thread(id 必须能在 PR 的 thread 列表
//     里找到),列表经**分页**取全(reviewThreads / 每 thread 的 comments 均分页);
//   - **执行层白名单复核**:live 查询取到 thread 首条评论的作者,不在调用方传入的
//     allowedBots 里 一律拒绝,fail-closed(即使调用方判断有误,这里再挡一次);
//   - 幂等:已 resolve 的跳过;回复带**身份绑定** marker(编入 pr 号 + 当前 thread
//     id,不是裸子串)——预存 / 从别的 thread 复制过来的 marker 文本,pr/thread 对
//     不上就不采信,不会被误判"已处理过";
//   - 翻案保护:身份绑定 marker 存在但仍未 resolve = 有人点过 unresolve(re-open 不
//     产生评论,只能靠标记推断)—— 一律拒绝再碰(reopened-after-triage),永久留
//     人工,不与人拉锯。**例外**:本地回执显示上一轮是我们自己 resolve mutation 失败
//     (reply 成功但 resolve 报错)而不是人工翻案 —— 这种情况只重试 resolve,不重复
//     回复,不算翻案;
//   - **并发至多一次**:每个 thread id 一把独占文件锁(`wx` 原子创建),拿到锁后在
//     临界区内重查一次活态(闭合"批量查询→加锁"之间的 TOCTOU 窗口),避免双进程各
//     发一次 reply+resolve。
//
// 移植自 lizi 上游 resolve-threads.mjs(2026-08-09);mivo 侧语义判定(白名单 bot +
// 修复证据语义绑定)在编排层经 lib.mjs assessThreadEvidence 落实,本脚本不自选
// thread、只执行调用方给的 --payload-file,但对"谁能被代 resolve"仍有自己的
// 独立执行层校验(见上)。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段。
//
// 跑:node <skill-root>/scripts/resolve-threads.mjs <PR> --payload-file <path|-> [--dry-run]
//   payload 结构(threads[].id 来自 context.mjs 的 history.reviewThreads[].id):
//   {
//     "threads": [ { "id": "PRRT_xxx", "reply": "已在 abc1234 处理,代为 resolve;有异议可 reopen" } ],
//     "allowedBots": ["greptile-apps"],   // 执行层白名单复核,必填,空则整体 fail-closed
//     "headSha": "abc1234"                // 写入 marker 供审计,非必填
//   }
//
// 测试隔离用环境变量:
//   REVIEW_PR_RESOLVE_LOCK_DIR  锁文件 / 本地回执文件目录(默认 tmpdir 下固定子目录;
//                               并发测试必须各自传独立目录,否则会跨测试串锁)

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseRepo, parsePR, ghGraphql, print, fail } from './lib.mjs';

const TRIAGE_MARKER_PREFIX = '<!-- review-pr:thread-triage';
const MAX_PAGES = 50;

const RESOLVE_MUTATION = `
  mutation($tid:ID!){ resolveReviewThread(input:{threadId:$tid}){ thread{ isResolved } } }`;
const REPLY_MUTATION = `
  mutation($tid:ID!,$body:String!){
    addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$tid, body:$body}){ comment{ id } }
  }`;

// ── SC-5:分页(reviewThreads 顶层 + 每 thread 的 comments)── 仿 fetchHeadCheckContexts
// 的 cursor-loop 惯例,MAX_PAGES 兜底防死循环。
const THREADS_PAGE_QUERY = `
  query ReviewThreadsPage($owner:String!,$repo:String!,$num:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100, after:$after){
          pageInfo{ hasNextPage endCursor }
          nodes{
            id isResolved path
            comments(first:50){
              pageInfo{ hasNextPage endCursor }
              nodes{ body author{ login } id }
            }
          }
        }
      }
    }
  }`;

const THREAD_COMMENTS_PAGE_QUERY = `
  query ThreadCommentsPage($tid:ID!,$after:String){
    node(id:$tid){
      ... on PullRequestReviewThread{
        comments(first:50, after:$after){
          pageInfo{ hasNextPage endCursor }
          nodes{ body author{ login } id }
        }
      }
    }
  }`;

// 拿锁之后的临界区重查:只查这一个 thread 的最新状态(id 复用同一形状,first:50
// 应付「刚被并发处理完」这一秒级窗口内新增的评论数,足够;不追求分页完整性——
// 分页完整性由上面的批量查询保证)。
const THREAD_RECHECK_QUERY = `
  query ThreadRecheck($tid:ID!){
    node(id:$tid){
      ... on PullRequestReviewThread{
        id isResolved
        comments(first:50){ nodes{ body author{ login } id } }
      }
    }
  }`;

function fetchAllThreads(owner, repo, pr) {
  const nodes = [];
  let after;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const vars = { owner, repo, num: pr };
    if (after) vars.after = after;
    const data = ghGraphql(THREADS_PAGE_QUERY, vars);
    const page = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!page || !Array.isArray(page.nodes)) break;
    for (const t of page.nodes) {
      let comments = t.comments?.nodes ?? [];
      let cAfter = t.comments?.pageInfo?.endCursor;
      let cHasNext = t.comments?.pageInfo?.hasNextPage === true;
      for (let j = 0; j < MAX_PAGES && cHasNext; j += 1) {
        const cvars = { tid: t.id };
        if (cAfter) cvars.after = cAfter;
        const cdata = ghGraphql(THREAD_COMMENTS_PAGE_QUERY, cvars);
        const cpage = cdata?.data?.node?.comments;
        if (!cpage || !Array.isArray(cpage.nodes)) break;
        comments = comments.concat(cpage.nodes);
        cAfter = cpage.pageInfo?.endCursor;
        cHasNext = cpage.pageInfo?.hasNextPage === true;
      }
      nodes.push({ ...t, comments: { nodes: comments } });
    }
    if (page.pageInfo?.hasNextPage === true && page.pageInfo?.endCursor) {
      after = page.pageInfo.endCursor;
    } else {
      break;
    }
  }
  return nodes;
}

// ── SC-4:身份绑定 marker —— 编入 pr 号 + 当前 thread id,校验时两者都要对得上当前
// 上下文才采信。预存 / 从别的 thread 复制过来的评论文本即使含 marker 字样,parseMarker
// 解出的 pr/thread 对不上,不会被采信为"我们自己代 resolve 过"。
function buildMarker(pr, threadId, headSha) {
  return `${TRIAGE_MARKER_PREFIX} pr=${pr} thread=${threadId} sha=${headSha ?? 'unknown'} -->`;
}
function parseMarker(body) {
  const m = /<!--\s*review-pr:thread-triage\s+pr=(\S+)\s+thread=(\S+)\s+sha=(\S+)\s*-->/.exec(String(body ?? ''));
  if (!m) return null;
  return { pr: m[1], thread: m[2], sha: m[3] };
}
function findOwnMarkerComment(comments, pr, threadId) {
  for (const c of comments ?? []) {
    const parsed = parseMarker(c.body);
    if (parsed && parsed.pr === String(pr) && parsed.thread === threadId) return { comment: c, marker: parsed };
  }
  return null;
}

// ── SC-2:并发至多一次 —— 每 thread 一把独占文件锁(wx 原子创建同 prepare.mjs 的
// 加锁原语,但这里的临界区只是一次 reply+resolve(秒级),不需要 prepare.mjs 那套
// 60 分钟 TTL / 两阶段抢占(那是给整轮 skill 运行时长设计的,语义不同,硬套会引入
// 不必要的复杂度)。锁目录默认落 tmpdir 固定子目录,测试可用
// REVIEW_PR_RESOLVE_LOCK_DIR 隔离,避免跨测试串锁。
function lockDir() {
  const d = process.env.REVIEW_PR_RESOLVE_LOCK_DIR || join(tmpdir(), 'review-pr-resolve-threads-locks');
  mkdirSync(d, { recursive: true });
  return d;
}
function safeIdPart(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}
function lockPathFor(pr, threadId) {
  return join(lockDir(), `${pr}__${safeIdPart(threadId)}.lock`);
}
function acquireThreadLock(pr, threadId, { retries = 200, spinMs = 15 } = {}) {
  const p = lockPathFor(pr, threadId);
  const token = randomUUID();
  for (let i = 0; i <= retries; i += 1) {
    try {
      writeFileSync(p, token, { flag: 'wx' });
      return { path: p, token };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      const until = Date.now() + spinMs;
      while (Date.now() < until) { /* 短暂忙等:临界区是秒级,不引入异步复杂度 */ }
    }
  }
  return null; // 拿不到锁 —— 另一进程正在处理同一 thread,本次让它去做
}
function releaseThreadLock(lock) {
  if (!lock) return;
  try {
    if (existsSync(lock.path) && readFileSync(lock.path, 'utf8') === lock.token) unlinkSync(lock.path);
  } catch { /* best-effort 释放,失败不影响主流程(锁文件留着,下次是新 token 会 EEXIST 重试直到人工清) */ }
}

// ── SC-6:reply 成功但 resolve 失败 ≠ 人工翻案 —— 本地留一张"未决回执",下一轮
// 看到「own marker 存在 + 回执显示我们自己失败」时只重试 resolve,不算翻案。
function receiptPathFor(pr, threadId) {
  return join(lockDir(), `${pr}__${safeIdPart(threadId)}.receipt.json`);
}
function writeReceipt(pr, threadId, data) {
  try { writeFileSync(receiptPathFor(pr, threadId), JSON.stringify(data)); } catch { /* best-effort */ }
}
function readReceipt(pr, threadId) {
  try {
    const p = receiptPathFor(pr, threadId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return null; }
}
function clearReceipt(pr, threadId) {
  try { const p = receiptPathFor(pr, threadId); if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
}

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const dryRun = process.argv.includes('--dry-run');
  const pfIdx = process.argv.indexOf('--payload-file');
  const payloadSrc = pfIdx >= 0 ? process.argv[pfIdx + 1] : null;
  if (!payloadSrc) fail('--payload-file 必填(threads[].id + reply)');
  const payload = JSON.parse(readFileSync(payloadSrc === '-' ? 0 : payloadSrc, 'utf8'));
  const wanted = (payload?.threads ?? []).filter((t) => t?.id && (t?.reply ?? '').trim() !== '');
  const rejected = (payload?.threads ?? []).filter((t) => !t?.id || (t?.reply ?? '').trim() === '')
    .map((t) => ({ id: t?.id ?? null, reason: 'missing-id-or-reply(不允许静默 resolve,回复必填)' }));
  const allowedBots = (payload?.allowedBots ?? []).map((s) => String(s).toLowerCase()).filter(Boolean);
  const headSha = String(payload?.headSha ?? process.env.REVIEW_PR_HEAD_SHA ?? 'unknown');

  const liveNodes = fetchAllThreads(owner, repo, pr);
  const live = new Map(liveNodes.map((t) => [t.id, t]));

  const results = [];
  for (const w of wanted) {
    const t = live.get(w.id);
    if (!t) {
      results.push({ id: w.id, done: false, reason: 'thread-not-found(id 不在当前 PR 的 thread 列表里)' });
      continue;
    }
    if (t.isResolved) {
      results.push({ id: w.id, path: t.path, done: true, reason: 'already-resolved' });
      continue;
    }
    // SC-3:执行层白名单复核(defense-in-depth,不依赖调用方已经过滤干净)——
    // live 查询取到 thread 首条评论的作者,不在 allowedBots 就 fail-closed 拒绝。
    const comments = t.comments?.nodes ?? [];
    const firstAuthor = String(comments[0]?.author?.login ?? '').toLowerCase();
    if (!allowedBots.length) {
      results.push({ id: w.id, path: t.path, done: false, reason: 'triage-disabled(未传 allowedBots,执行端 fail-closed 拒绝)' });
      continue;
    }
    if (!firstAuthor || !allowedBots.includes(firstAuthor)) {
      results.push({
        id: w.id, path: t.path, done: false,
        reason: 'author-not-in-whitelist(执行端复核:live 查询到的作者不在白名单,拒绝代 resolve)',
        author: comments[0]?.author?.login ?? null,
      });
      continue;
    }
    if (dryRun) {
      results.push({ id: w.id, path: t.path, dryRun: true, wouldReply: true, wouldResolve: true });
      continue;
    }
    // SC-2:并发至多一次。拿不到锁 = 另一进程正在处理同一 thread,本进程不动。
    const lock = acquireThreadLock(pr, w.id);
    if (!lock) {
      results.push({ id: w.id, path: t.path, done: false, reason: 'lock-busy(另一进程正在处理同一 thread,本次不动)' });
      continue;
    }
    try {
      // 临界区内重查一次活态,闭合"批量查询→加锁"之间的 TOCTOU 窗口。
      const rc = ghGraphql(THREAD_RECHECK_QUERY, { tid: w.id });
      const freshNode = rc?.data?.node;
      if (freshNode?.isResolved === true) {
        results.push({ id: w.id, path: t.path, done: true, reason: 'already-resolved(锁内重查发现已被并发处理)' });
        continue;
      }
      // marker 检测必须用「批量分页取全的 comments」兜底,不能只信 freshNode 的
      // 前 50 条——否则第 50 条之后的历史 marker 会被判「未翻案」而误当新 thread
      // 走一遍正常 reply+resolve(SC-5 实测暴露:52 条评论里第 52 条才是 marker)。
      // 合并去重(按 id):批量分页结果为主,recheck 的新鲜评论补充"锁窗口内新增"的部分。
      const seenIds = new Set();
      const mergedComments = [];
      for (const c of comments) {
        if (c?.id) { if (seenIds.has(c.id)) continue; seenIds.add(c.id); }
        mergedComments.push(c);
      }
      for (const c of (freshNode?.comments?.nodes ?? [])) {
        if (c?.id) { if (seenIds.has(c.id)) continue; seenIds.add(c.id); }
        mergedComments.push(c);
      }
      const own = findOwnMarkerComment(mergedComments, pr, w.id);
      if (own) {
        // 身份绑定 marker 命中 = 我们自己确实对这个 thread 回复过。仍未 resolve,
        // 要区分:人工翻案(留人工)vs 我们自己上一轮 resolve mutation 失败(重试)。
        const receipt = readReceipt(pr, w.id);
        const isOwnPendingFailure = receipt?.resolveOutcome === 'error'
          && receipt?.markerCommentId && receipt.markerCommentId === own.comment?.id;
        if (!isOwnPendingFailure) {
          results.push({ id: w.id, path: t.path, done: false, reason: 'reopened-after-triage(已代 resolve 过又被 unresolve,人工翻案,永久留人工)' });
          continue;
        }
        let resolved = false;
        let resolveError = null;
        try {
          const r = ghGraphql(RESOLVE_MUTATION, { tid: w.id });
          resolved = r?.data?.resolveReviewThread?.thread?.isResolved === true;
          if (resolved) clearReceipt(pr, w.id);
        } catch (e) {
          resolveError = String(e?.message ?? e).slice(0, 200);
          writeReceipt(pr, w.id, { resolveOutcome: 'error', markerCommentId: own.comment?.id, at: Date.now() });
        }
        results.push({
          id: w.id, path: t.path, done: resolved, replied: true, resolved,
          ...(resolveError ? { resolveError } : {}),
          reason: resolved
            ? 'resolve-retry-succeeded(此前 reply 成功但 resolve 失败,本轮重试 resolve 成功,非人工翻案)'
            : 'resolve-retry-still-failing(此前 reply 成功但 resolve 失败,本轮重试仍未成功,非人工翻案,留待下一轮重试)',
        });
        continue;
      }
      // 无 own marker → 正常首轮:回复(必带,不允许静默 resolve)+ resolve。
      let replied = false;
      let replyError = null;
      let markerCommentId = null;
      try {
        const rr = ghGraphql(REPLY_MUTATION, { tid: w.id, body: `${w.reply.trim()}\n\n${buildMarker(pr, w.id, headSha)}` });
        replied = true;
        markerCommentId = rr?.data?.addPullRequestReviewThreadReply?.comment?.id ?? null;
      } catch (e) {
        replyError = String(e?.message ?? e).slice(0, 200);
      }
      let resolved = false;
      let resolveError = null;
      if (replied) {
        try {
          const r = ghGraphql(RESOLVE_MUTATION, { tid: w.id });
          resolved = r?.data?.resolveReviewThread?.thread?.isResolved === true;
          if (resolved) clearReceipt(pr, w.id);
        } catch (e) {
          resolveError = String(e?.message ?? e).slice(0, 200);
          // SC-6:留回执 —— 下一轮看到「own marker 存在 + 这张回执」就知道这是我们
          // 自己 resolve 失败,不是人工翻案,只重试 resolve。
          writeReceipt(pr, w.id, { resolveOutcome: 'error', markerCommentId, at: Date.now() });
        }
      }
      results.push({
        id: w.id, path: t.path, done: resolved,
        replied, ...(replyError ? { replyError } : {}),
        resolved, ...(resolveError ? { resolveError } : {}),
      });
    } finally {
      releaseThreadLock(lock);
    }
  }

  print({
    ok: true,
    pr,
    requested: wanted.length,
    resolvedCount: results.filter((r) => r.done).length,
    results,
    ...(rejected.length ? { rejected } : {}),
    note: '每条代 resolve 都带回复通知原 reviewer,对方可一键 unresolve;被 unresolve 过的 thread(reopened-after-triage)本脚本永久拒绝再碰,留人工(除非是我们自己上一轮 resolve 失败留下的回执,那种情况只重试 resolve)。判「意见是否已处理」是调用方(编排层)的语义责任:只传「白名单 bot + 修复证据语义绑定(assessThreadEvidence)确凿」的;本脚本执行层再做一次白名单复核 + 身份绑定 marker + 并发锁,defense-in-depth,不单纯信任调用方。',
  });
} catch (e) {
  fail(e);
}
