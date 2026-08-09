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
//   - **执行层白名单复核**:live 查询取到 thread 内全部评论(不止首条)的作者,任何
//     一条不在调用方传入的 allowedBots 里 一律拒绝,fail-closed(即使调用方判断有误,
//     这里再挡一次;真人在白名单 bot 首条之后追加的异议同样被扫到);
//   - 幂等:已 resolve 的跳过;回复带**身份绑定** marker(编入 pr 号 + 当前 thread
//     id,不是裸子串)——预存 / 从别的 thread 复制过来的 marker 文本,pr/thread 对
//     不上就不采信,不会被误判"已处理过";
//   - 翻案保护区分**可重试**与**永久**(D6):marker 正文是普通 thread 回复,pr 号与
//     thread id 都是公开信息,任何有评论权限的账号都能定向伪造,故 marker 只在同时
//     满足身份绑定与本地持久回执时采信为「己方已 triage」——仅有 marker 而无回执 →
//     marker-not-trustworthy(来源不可信),进可重试路径,不做永久翻案判定;marker +
//     回执且非我们自己失败 → reopened-after-triage(有人 unresolve 过 = 人工翻案),
//     永久留人工,不与人拉锯。**例外**:回执显示上一轮是我们自己 resolve mutation
//     失败(reply 成功但 resolve 报错)而不是人工翻案 —— 只重试 resolve,不重复回复;
//   - **并发至多一次**:每个 thread id 一把独占文件锁(`wx` 原子创建 + TTL 过期两阶段
//     抢占,无 PID 存活判定,理由同 prepare.mjs 的 acquireLock()),拿到锁后在临界区
//     内重查一次活态(闭合"批量查询→加锁"之间的 TOCTOU 窗口),避免双进程各发一次
//     reply+resolve;
//   - **白名单复核扫描 thread 内全部评论**(不止首条)——真人在 bot 首条评论之后追加
//     的反对意见,同样会被扫到并 fail-closed 拒绝,不会因为只看首条被漏判。
//
// 移植自 lizi 上游 resolve-threads.mjs(2026-08-09);mivo 侧语义判定(白名单 bot +
// token 共现 + 编排层显式 justification,见 lib.mjs assessThreadEvidence,2026-08-09
// 二轮对抗复审后降级,不再声称"语义绑定")在编排层落实,本脚本不自选 thread、只执行
// 调用方给的 --payload-file,但对"谁能被代 resolve"仍有自己的独立执行层校验(见上,
// 含对 justification 字段存在性的独立复核)。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段。
//
// 跑:node <skill-root>/scripts/resolve-threads.mjs <PR> --payload-file <path|-> [--dry-run]
//   payload 结构(threads[].id 来自 context.mjs 的 history.reviewThreads[].id):
//   {
//     "threads": [ {
//       "id": "PRRT_xxx",
//       "reply": "已在 abc1234 处理,代为 resolve;有异议可 reopen",
//       "justification": "为什么这段 diff 回应了这条 claim(必填,执行层独立复核)"
//     } ],
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
import {
  parseRepo, parsePR, ghGraphql, print, fail, stateFile, writeJsonAtomic,
} from './lib.mjs';

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

// ── SC-2:并发至多一次 —— 每 thread 一把独占文件锁(wx 原子创建)。此前版本(round-1)
// 只有裸 EEXIST 忙等,持锁进程若中途崩溃(未走到 finally 的 releaseThreadLock),锁文件
// 永久留存,该 thread id 从此被永久锁死——没有任何自愈路径。改为 TTL + 两阶段抢占,
// 与 prepare.mjs 的 acquireLock() 同一套依据(仓级锁的设计说明见该文件头注):**不做
// PID 存活判定**——本脚本秒级完工,写自己的 PID 进锁文件毫无意义(下一轮 kill(pid,0)
// 永远 ESRCH,永远判 stale,锁形同虚设);判 stale 只能靠时间戳。TTL 定得比该锁真实
// 临界区(一次 reply+resolve 的网络往返)大两个量级,避免把"正常慢"误判成"崩溃"。
// 两阶段抢占:抢主锁前先抢 `<lock>.takeover` 位,抢到后复核主锁仍 stale 才真正接管,
// 防止两个"同时判定 stale"的进程抢占竞态(prepare.mjs 同款自我复核)。
// 锁目录默认落 tmpdir 固定子目录,测试可用 REVIEW_PR_RESOLVE_LOCK_DIR 隔离,避免跨
// 测试串锁。
const THREAD_LOCK_TTL_MS = Number(process.env.REVIEW_PR_RESOLVE_LOCK_TTL_MS || 5 * 60 * 1000);
const THREAD_TAKEOVER_TTL_MS = 15 * 1000;

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
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
function tryCreateLockFile(p, content) {
  try {
    writeFileSync(p, content, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  }
}
function readLockRaw(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}
function parseLockStartedAt(raw) {
  try {
    const t = Number(JSON.parse(raw)?.startedAt);
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}
function isLockStale(raw) {
  if (raw === null) return true; // 锁文件读不到(被并发释放/损坏)—— 视为可抢占
  const startedAt = parseLockStartedAt(raw);
  return startedAt === null || (Date.now() - startedAt) > THREAD_LOCK_TTL_MS;
}
async function acquireThreadLock(pr, threadId, { retries = 40, spinMs = 250 } = {}) {
  const p = lockPathFor(pr, threadId);
  const takeoverPath = `${p}.takeover`;
  const token = randomUUID();
  for (let i = 0; i <= retries; i += 1) {
    const content = JSON.stringify({ token, startedAt: Date.now() });
    if (tryCreateLockFile(p, content)) return { path: p, token };
    const raw = readLockRaw(p);
    if (isLockStale(raw)) {
      // 两阶段抢占:先抢 takeover 位,抢到才有资格接管主锁;抢不到说明另一个进程
      // 正在做同一件事,让它去做,本轮不重复抢。
      if (tryCreateLockFile(takeoverPath, content)) {
        try {
          const raw2 = readLockRaw(p);
          if (isLockStale(raw2)) {
            try { unlinkSync(p); } catch { /* best-effort:可能已被别的进程删了 */ }
            if (tryCreateLockFile(p, content)) return { path: p, token };
          }
        } finally {
          try { unlinkSync(takeoverPath); } catch { /* best-effort */ }
        }
      } else {
        await sleep(Math.min(spinMs, THREAD_TAKEOVER_TTL_MS));
        continue;
      }
    }
    await sleep(spinMs);
  }
  return null; // 拿不到锁 —— 另一进程正在处理同一 thread,本次让它去做
}
function releaseThreadLock(lock) {
  if (!lock) return;
  try {
    const raw = readLockRaw(lock.path);
    if (raw === null) return;
    const parsed = (() => { try { return JSON.parse(raw); } catch { return null; } })();
    if (parsed?.token === lock.token) unlinkSync(lock.path);
  } catch { /* best-effort 释放,失败不影响主流程(锁文件留着,TTL 过期后会被下个进程两阶段抢占接管) */ }
}

// ── SC-6:reply 成功但 resolve 失败 ≠ 人工翻案 —— 留一张"未决回执",下一轮看到
// 「own marker 存在 + 回执显示我们自己失败」时只重试 resolve,不算翻案。
// 存储改为 lib.mjs 的 stateFile()/writeJsonAtomic()(与 review-receipt-<pr>.json 同一
// 套持久状态根,同一套原子写),不再用 tmpdir 下的锁目录——锁是"进程级互斥"语义,
// 天然该短命;回执是"跨轮次判断依据",落在 tmpdir 在无状态 CI runner(每次全新
// tmpdir)上会导致下一轮找不到回执,把"我们自己 resolve mutation 失败"误判成
// "人工翻案"并永久锁死,这正是回执要防的场景本身。
function threadReceiptFile(pr, threadId) {
  return stateFile(`resolve-thread-receipt-${pr}__${safeIdPart(threadId)}.json`);
}
function writeReceipt(pr, threadId, data) {
  try { writeJsonAtomic(threadReceiptFile(pr, threadId), data); } catch { /* best-effort */ }
}
function readReceipt(pr, threadId) {
  try {
    const p = threadReceiptFile(pr, threadId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return null; }
}
function clearReceipt(pr, threadId) {
  try { const p = threadReceiptFile(pr, threadId); if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
}

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const dryRun = process.argv.includes('--dry-run');
  const pfIdx = process.argv.indexOf('--payload-file');
  const payloadSrc = pfIdx >= 0 ? process.argv[pfIdx + 1] : null;
  if (!payloadSrc) fail('--payload-file 必填(threads[].id + reply + justification)');
  const payload = JSON.parse(readFileSync(payloadSrc === '-' ? 0 : payloadSrc, 'utf8'));
  // D1 执行层复核(编排层之外的第二道防线):thread 必填 id + reply + justification,
  // 缺任一 → rejected,不静默进入执行流程(编排层在 lib.mjs assessThreadEvidence 已要求
  // justification,这里独立再查一遍,不单纯信任调用方过滤过)。
  const wanted = (payload?.threads ?? []).filter(
    (t) => t?.id && (t?.reply ?? '').trim() !== '' && (t?.justification ?? '').trim() !== '',
  );
  const rejected = (payload?.threads ?? []).filter(
    (t) => !t?.id || (t?.reply ?? '').trim() === '' || (t?.justification ?? '').trim() === '',
  ).map((t) => ({
    id: t?.id ?? null,
    reason: 'missing-id-or-reply-or-justification(不允许静默 resolve:thread id / reply / justification 三者必填,缺失一律拒绝)',
  }));
  const allowedBotsRaw = payload?.allowedBots ?? [];
  if (!Array.isArray(allowedBotsRaw)) fail(`allowedBots 必须是数组,收到:${JSON.stringify(allowedBotsRaw)}(fail-closed 拒绝,不静默 TypeError)`);
  const allowedBots = allowedBotsRaw.map((s) => String(s).toLowerCase()).filter(Boolean);
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
    // SC-3/D2:执行层白名单复核(defense-in-depth,不依赖调用方已经过滤干净)——
    // 扫描 thread 内**全部**评论的作者(不止首条)。只看 comments[0] 会漏判:真人在
    // bot 首条评论之后追加反对意见时,首条仍是白名单 bot,若不扫后续评论就会被误判
    // 可代 resolve,把真人的异议当空气。任何一条非白名单作者出现就 fail-closed 拒绝。
    const comments = t.comments?.nodes ?? [];
    if (!allowedBots.length) {
      results.push({ id: w.id, path: t.path, done: false, reason: 'triage-disabled(未传 allowedBots,执行端 fail-closed 拒绝)' });
      continue;
    }
    if (comments.length === 0) {
      results.push({ id: w.id, path: t.path, done: false, reason: 'author-not-in-whitelist(thread 无评论,拒绝代 resolve)', author: null });
      continue;
    }
    // 排除本脚本自己写过的身份绑定 marker 回复再扫作者——那是执行层留下的审计痕迹,
    // 作者是触发 resolve 的自动化身份本身(fake-gh-resolve 里是 review-pr-bot,真实环境
    // 是执行 token 的身份),几乎必然不在 allowedBots(白名单列的是 reviewer bot,如
    // greptile-apps)里;若不排除,任何重试轮次(上一轮已留过 marker)都会被自己的
    // 回复误判"非白名单评论"而永久拒绝重试。排除后若一条非 marker 评论都不剩,说明
    // 这是"我们已经处理过、还没轮到重查 marker"的合法中间态,交给下面的锁+marker 逻辑
    // 判断(reopened-after-triage / 我们自己失败重试),这里不提前拒绝。
    const reviewerComments = comments.filter((c) => !parseMarker(c?.body));
    const nonWhitelisted = reviewerComments.find((c) => {
      const a = String(c?.author?.login ?? '').toLowerCase();
      return !a || !allowedBots.includes(a);
    });
    if (nonWhitelisted) {
      // 命中的是首条(触发 review 的)评论本身 → 沿用 SC-3 原命名 author-not-in-whitelist;
      // 命中的是首条之后追加的评论(D2 新增的扫描范围)→ non-whitelisted-comment-present,
      // 区分"审核发起者本身不在白名单"与"真人在白名单 bot 之后追加了异议"两种场景。
      const isFirstComment = nonWhitelisted === reviewerComments[0];
      results.push({
        id: w.id, path: t.path, done: false,
        reason: isFirstComment
          ? 'author-not-in-whitelist(执行端复核:首条评论作者不在白名单,拒绝代 resolve)'
          : 'non-whitelisted-comment-present(执行端复核:thread 内存在非白名单作者的评论,拒绝代 resolve)',
        author: nonWhitelisted?.author?.login ?? null,
      });
      continue;
    }
    if (dryRun) {
      results.push({ id: w.id, path: t.path, dryRun: true, wouldReply: true, wouldResolve: true });
      continue;
    }
    // SC-2:并发至多一次。拿不到锁 = 另一进程正在处理同一 thread,本进程不动。
    const lock = await acquireThreadLock(pr, w.id);
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
      // D2:锁内重查一次白名单——TOCTOU 窗口内可能刚好新增了一条真人反对评论,
      // 批量查询阶段的白名单复核看不到它,必须在临界区内用合并后的全量评论再扫一次。
      // 同样要排除本脚本自己的身份绑定 marker 回复,否则重试轮次(上一轮已留过
      // marker)会把自己的回执误判成"非白名单评论"而永久拒绝。
      const mergedNonWhitelisted = mergedComments.filter((c) => !parseMarker(c?.body)).find((c) => {
        const a = String(c?.author?.login ?? '').toLowerCase();
        return !a || !allowedBots.includes(a);
      });
      if (mergedNonWhitelisted) {
        results.push({
          id: w.id, path: t.path, done: false,
          reason: 'non-whitelisted-comment-present(锁内重查:合并后的评论列表出现非白名单作者,拒绝代 resolve)',
          author: mergedNonWhitelisted?.author?.login ?? null,
        });
        continue;
      }
      const own = findOwnMarkerComment(mergedComments, pr, w.id);
      const receipt = readReceipt(pr, w.id);
      if (own) {
        // D6:marker 正文就是一条普通 thread 回复,pr 号与 thread id 都是公开信息,任何
        // 有该 PR 评论权限的账号都能定向伪造(后果:该 thread 被永久判「已 triage 后
        // 人工翻案」而永久拒 triage)。因此 marker 只在**同时**满足身份绑定(pr/thread
        // 对上)与本地持久回执时,才被采信为「己方已 triage」:
        //   - 仅有 marker 而无本地回执 → 来源不可信,不得判永久 reopened,进可重试路径
        //     (本轮不动,输出明确标出 marker 来源不可信,下一轮仍可重试);
        //   - marker + 回执 → 采信为己方 triage,再区分人工翻案(留人工)vs 我们自己
        //     上一轮 resolve mutation 失败(重试)。
        if (!receipt) {
          results.push({
            id: w.id, path: t.path, done: false,
            reason: 'marker-not-trustworthy(marker 来源不可信:命中 marker 但无本地持久回执佐证,可能是伪造/复制,不做 reopened 判定,进入可重试路径)',
          });
          continue;
        }
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
    note: '每条代 resolve 都带回复通知原 reviewer,对方可一键 unresolve。翻案保护分两类:reopened-after-triage(身份绑定 marker + 本地回执同时存在且非我们自己失败 = 人工翻案)本脚本永久拒绝再碰,留人工;marker-not-trustworthy(仅有 marker 无回执,来源不可信——可能是伪造/复制)不进永久判定,可重试。除非本地回执显示上一轮是我们自己 resolve mutation 失败,那种情况只重试 resolve。判「意见是否已处理」是调用方(编排层)的语义责任:只传「白名单 bot + token 共现 + 非空 justification(assessThreadEvidence)确凿」的;本脚本执行层再做一次白名单复核 + justification 存在性复核 + 身份绑定 marker + 并发锁,defense-in-depth,不单纯信任调用方。',
  });
} catch (e) {
  fail(e);
}
