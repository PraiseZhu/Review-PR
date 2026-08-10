#!/usr/bin/env node
// resolve-threads.mjs — thread 代 triage 的执行端(对应 SKILL「thread 清理」)
//
// 背景:Require conversation resolution 下 bot 从不点 resolve、作者修完常忘点 → thread
// 卡死合并(#251 型停滞)。「意见是否已被处理」是 LLM 语义活,字符串分析证明不了——两行
// 普通埋点 + 一句 justification 即可绕过任何 token 共现判据(R2 blocker 实测;原
// assessThreadEvidence 已删,见 SKILL 3.10 启用前提)。本脚本只做两类事、三终态:
//   - reply(无条件,可纠正,反停滞全部价值):白名单 bot thread 且无白名单外参与者;
//   - resolve(默认不执行,机器可核实才做):线程已 resolved / 己方(state=replied)
//     marker + 同 headSha + **marker 年龄 ≥ 反对窗口**(MIN_MARKER_AGE_MS) + 白名单
//     复核通过 / 己方 state=resolved marker 后又 reopen(人工翻案,永久留人工);
//   - 终态:`replied-only` / `resolved` / `skipped-<reason>`。
// marker 可信度 = 评论作者身份(viewer login 比对),非文本形状(pr/thread/sha 公开可复制);
// 白名单复核只豁免 viewer 自己的评论。状态全在 GitHub 侧,无本地回执。
// 并发至多一次:每 thread 一把独占文件锁(TTL 两阶段抢占 + takeover 60s TTL 自愈 + wx
// 复核,同 #11 signoff-hold round3),锁内重查活态兑 TOCTOU。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段。
//
// 跑:node <skill-root>/scripts/resolve-threads.mjs <PR> --payload-file <path|-> [--dry-run]
//   payload 结构(threads[].id 来自 context.mjs 的 history.reviewThreads[].id):
//   {
//     "threads": [ {
//       "id": "PRRT_xxx",
//       "reply": "已在 abc1234 处理;有异议可 reopen",
//       "justification": "编排层对「为什么这段 diff 回应了这条 claim」的说明(契约字段,
//                        非 resolve 判据——resolve 只看机器可核实条件,见上)"
//     } ],
//     "allowedBots": ["greptile-apps"],   // 执行层白名单复核,必填,空则整体 fail-closed
//     "headSha": "abc1234"                // 写入 marker 并参与 resolve 条件判定,非必填
//   }
//
// 测试隔离用环境变量:
//   REVIEW_PR_RESOLVE_LOCK_DIR  锁文件目录(默认 tmpdir 下固定子目录;并发测试必须各自
//                               传独立目录,否则会跨测试串锁)

import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  parseRepo, parsePR, ghGraphql, print, fail,
} from './lib.mjs';

const TRIAGE_MARKER_PREFIX = '<!-- review-pr:thread-triage';
const MAX_PAGES = 50;

const VIEWER_QUERY = `query ViewerLogin { viewer { login } }`;

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
              nodes{ body author{ login } id createdAt }
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
          nodes{ body author{ login } id createdAt }
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
        comments(first:50){ nodes{ body author{ login } id createdAt } }
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

// ── marker:pr/thread 绑定 + sha + state(2026-08-09 三轮收敛后加 state)──
// state=replied:上一轮己方已回复,resolve 待机器可核实条件(同 headSha 重跑);
// state=resolved:己方已 resolve 成功(此后 reopen = 人工翻案,永久留人工)。
// 可信度靠**作者身份**(viewer),不靠文本:pr/thread/sha 都是公开信息,任何有评论权限
// 的账号都能定向复制文本,但没人能以 viewer 身份发评论。
function buildMarker(pr, threadId, headSha, state = 'replied') {
  return `${TRIAGE_MARKER_PREFIX} pr=${pr} thread=${threadId} sha=${headSha ?? 'unknown'} state=${state} -->`;
}
// state 缺省 'replied':兼容旧四字段 marker(2026-08-09 前无 state)。
function parseMarker(body) {
  const m = /<!--\s*review-pr:thread-triage\s+pr=(\S+)\s+thread=(\S+)\s+sha=(\S+)(?:\s+state=(\S+))?\s*-->/.exec(String(body ?? ''));
  if (!m) return null;
  return { pr: m[1], thread: m[2], sha: m[3], state: m[4] ?? 'replied' };
}
// 己方 marker 收集:只认 viewer 身份作者写的、且 pr/thread 与当前上下文一致的 marker。
// 攻击者无法以 viewer 身份发评论,身份绑定不可伪造;pr/thread 对不上(预存/复制)不算。
function ownMarkersFrom(comments, pr, threadId, viewerLogin) {
  const own = [];
  for (const c of comments ?? []) {
    if (String(c?.author?.login ?? '').toLowerCase() !== viewerLogin.toLowerCase()) continue;
    const parsed = parseMarker(c.body);
    if (parsed && parsed.pr === String(pr) && parsed.thread === threadId) own.push({ comment: c, marker: parsed });
  }
  return own;
}

// ── SC-2:并发至多一次 —— 每 thread 一把独占文件锁(wx 原子创建 + TTL 两阶段抢占,
// 与 prepare.mjs acquireLock 同套依据:**不做 PID 存活判定**,判 stale 只靠时间戳)。
// takeover 自愈(同 #11 signoff-hold round3 D3/D4):takeover 文件写 JSON {startedAt,
// token} + 60s TTL——残留未超 TTL 视为"另一实例正在接管"放弃本轮,超 TTL 清理后重试;
// wx 成功后复核内容防双持有。锁目录默认 tmpdir 固定子目录,测试用
// REVIEW_PR_RESOLVE_LOCK_DIR 隔离。
const THREAD_LOCK_TTL_MS = Number(process.env.REVIEW_PR_RESOLVE_LOCK_TTL_MS || 5 * 60 * 1000);
const THREAD_TAKEOVER_TTL_MS = 60 * 1000;
// ── 人工反对窗口(D1 两阶段协议的核心价值)──
// resolve 的机器可核实条件之一:己方 reply marker 必须**至少存在 MIN_MARKER_AGE_MS**
// 才能 resolve——这段窗口让真人在「我们回复」与「自动关闭」之间有时间介入反对。
// 若双实例重叠(定时巡审 + 手动运行)时窗口塌成 0,两阶段就退化成单轮 auto-resolve
// (D1 明确否决的东西)。阈值取巡审间隔量级(默认 10 分钟)。
// 年龄从评论 createdAt(GitHub 侧字段,跨机器可信,与 D3 无本地状态一致)推导。
//
// env 覆盖必须显式校验(R4,同 #11 SIGNOFF_HOLD_GH_TIMEOUT_MS 模式):安全不变量不能
// 悬在一个未校验的 env 旋钮上——`Number(env || default)` 会让 `-1` 悄悄关掉年龄门、
// `0` 语义两可。规则:
//   - 解析失败 / 负值 / 低于下限 → 一律回落默认,stderr + JSON warnings 双通道警告;
//   - 下限 1 分钟:它保护的是人工反对窗口,下限应当是"人来得及看见"的量级——1 分钟
//     是可感知的最短人工介入窗口;更小(如 30s/0/-1)在语义上退化成"无窗口",几乎
//     必然是单位/量级配置错误(把 600000 误写成 600),不应当被当作合法配置放行;
//   - 要关闭年龄门只能显式设 REVIEW_PR_DISABLE_MARKER_AGE_GATE=1(仅运维一次性批量
//     清理积压 thread 用),不许用"把年龄设成奇怪数字"这种隐蔽方式;门关闭只豁免
//     年龄条件,"无 createdAt 保守不 resolve"照旧生效。
const MIN_MARKER_AGE_MS_DEFAULT = 10 * 60 * 1000;
const MIN_MARKER_AGE_MS_FLOOR = 60 * 1000;
const warnings = [];
function resolveMinMarkerAgeMs() {
  if (process.env.REVIEW_PR_DISABLE_MARKER_AGE_GATE === '1') {
    const w = '[resolve-threads] 警告:REVIEW_PR_DISABLE_MARKER_AGE_GATE=1 —— 年龄门已关闭,本轮 resolve 不保留人工反对窗口(仅限显式的一次性批量清理)';
    warnings.push(w);
    process.stderr.write(`${w}\n`);
    return null; // null = 年龄门关闭(无 createdAt 的保守判定不受影响)
  }
  const raw = process.env.REVIEW_PR_MIN_MARKER_AGE_MS;
  if (raw === undefined || raw === '') return MIN_MARKER_AGE_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_MARKER_AGE_MS_FLOOR) {
    const w = `[resolve-threads] 警告:REVIEW_PR_MIN_MARKER_AGE_MS=${JSON.stringify(raw)} 非法(须为 ≥${MIN_MARKER_AGE_MS_FLOOR}ms 的数字;设 0/负值/非数字无法关闭年龄门),已回落默认 ${MIN_MARKER_AGE_MS_DEFAULT}ms`;
    warnings.push(w);
    process.stderr.write(`${w}\n`);
    return MIN_MARKER_AGE_MS_DEFAULT;
  }
  return n;
}
const MIN_MARKER_AGE_MS = resolveMinMarkerAgeMs();
function markerAgeMs(comment) {
  if (!comment?.createdAt) return null; // 读不到时间(旧缓存/形状变化)→ 不满足,不 resolve
  const t = Date.parse(comment.createdAt);
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null;
}

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
// takeover 文件读回:JSON {startedAt, token};解析失败/旧裸格式 → null,视为可清理残留。
function readTakeoverInfo(p) {
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (parsed && typeof parsed.token === 'string') return parsed;
  } catch { /* 残留旧格式 / 内容损坏 → 交给调用方当陈旧残留处理 */ }
  return null;
}
function tryTakeoverStaleLock(p, takeoverPath, token) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload = JSON.stringify({ startedAt: new Date().toISOString(), token });
    if (tryCreateLockFile(takeoverPath, payload)) {
      try {
        // wx 成功后复核内容:防另一实例基于更早的 stale 读把我们刚建的接管锁误删重建
        // (与 prepare.mjs / signoff-hold.mjs 同款复核)——内容不是自己的就退出竞争,
        // 避免两个实例同时自认持有接管锁 → 双持有主锁。
        const own = readTakeoverInfo(takeoverPath);
        if (!own || own.token !== token) return false;
        // 持有接管锁后复核主锁:可能已被别的实例接管重建(变新),那就不是我们的了。
        const recheck = readLockRaw(p);
        if (!isLockStale(recheck)) return false;
        try { unlinkSync(p); } catch { /* 已被抢占清理过 */ }
        return tryCreateLockFile(p, JSON.stringify({ token, startedAt: Date.now() }));
      } finally {
        try { unlinkSync(takeoverPath); } catch { /* 本就没有,或已清理 */ }
      }
    }
    // EEXIST:读 takeover 文件,未超 TTL → 另一实例正在接管,放弃本轮(交外层轮询重试);
    // 超 TTL 的残留(含旧裸格式)→ 清理后重试一轮。
    const info = readTakeoverInfo(takeoverPath);
    const startedAt = info?.startedAt == null ? NaN : Date.parse(info.startedAt);
    if (Number.isFinite(startedAt) && Date.now() - startedAt < THREAD_TAKEOVER_TTL_MS) {
      return false;
    }
    try { unlinkSync(takeoverPath); } catch { return false; }
  }
  return false;
}
async function acquireThreadLock(pr, threadId, { retries = 40, spinMs = 250 } = {}) {
  const p = lockPathFor(pr, threadId);
  const takeoverPath = `${p}.takeover`;
  const token = randomUUID();
  for (let i = 0; i <= retries; i += 1) {
    const content = JSON.stringify({ token, startedAt: Date.now() });
    if (tryCreateLockFile(p, content)) return { path: p, token };
    if (isLockStale(readLockRaw(p)) && tryTakeoverStaleLock(p, takeoverPath, token)) {
      return { path: p, token };
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

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const dryRun = process.argv.includes('--dry-run');
  const pfIdx = process.argv.indexOf('--payload-file');
  const payloadSrc = pfIdx >= 0 ? process.argv[pfIdx + 1] : null;
  if (!payloadSrc) fail('--payload-file 必填(threads[].id + reply + justification)');
  const payload = JSON.parse(readFileSync(payloadSrc === '-' ? 0 : payloadSrc, 'utf8'));
  // 契约复核(机械):thread 必填 id + reply + justification,缺任一 → rejected,不静默
  // 进入执行流程。justification 是编排层契约字段(审计用),**不是 resolve 判据**——
  // resolve 只看机器可核实条件(见下)。
  const wanted = (payload?.threads ?? []).filter(
    (t) => t?.id && (t?.reply ?? '').trim() !== '' && (t?.justification ?? '').trim() !== '',
  );
  const rejected = (payload?.threads ?? []).filter(
    (t) => !t?.id || (t?.reply ?? '').trim() === '' || (t?.justification ?? '').trim() === '',
  ).map((t) => ({
    id: t?.id ?? null,
    reason: 'missing-id-or-reply-or-justification(thread id / reply / justification 三者必填,缺失一律拒绝)',
  }));
  const allowedBotsRaw = payload?.allowedBots ?? [];
  if (!Array.isArray(allowedBotsRaw)) fail(`allowedBots 必须是数组,收到:${JSON.stringify(allowedBotsRaw)}(fail-closed 拒绝,不静默 TypeError)`);
  const allowedBots = allowedBotsRaw.map((s) => String(s).toLowerCase()).filter(Boolean);
  const headSha = String(payload?.headSha ?? process.env.REVIEW_PR_HEAD_SHA ?? 'unknown');

  // D3:marker 可信度的唯一依据 = 评论作者是否就是当前执行身份。viewer 查询失败 →
  // fail-closed(拿不到身份就没法区分「我们发的 marker」与「伪造的 marker」)。
  const viewerData = ghGraphql(VIEWER_QUERY);
  const viewerLogin = String(viewerData?.data?.viewer?.login ?? '').trim();
  if (!viewerLogin) fail('无法获取 viewer login(GraphQL viewer 查询失败)——marker 作者身份判定依赖它,fail-closed');

  const liveNodes = fetchAllThreads(owner, repo, pr);
  const live = new Map(liveNodes.map((t) => [t.id, t]));

  // 白名单复核(按作者身份豁免,不是按文本形状):只豁免 viewer 自己的评论(本脚本上一轮
  // 的 marker 回复 / state=resolved 追加 marker);非白名单作者的评论一律拒绝,marker
  // 形状也不例外——文本谁都能复制,身份不能。
  const isOwn = (c) => String(c?.author?.login ?? '').toLowerCase() === viewerLogin.toLowerCase();
  const findNonWhitelisted = (comments) => {
    const reviewerComments = comments.filter((c) => !isOwn(c));
    const offender = reviewerComments.find((c) => {
      const a = String(c?.author?.login ?? '').toLowerCase();
      return !a || !allowedBots.includes(a);
    });
    return { reviewerComments, offender };
  };

  const results = [];
  for (const w of wanted) {
    const t = live.get(w.id);
    if (!t) {
      results.push({ id: w.id, outcome: 'skipped', done: false, replied: false, resolved: false, reason: 'skipped-thread-not-found(thread id 不在当前 PR 的 thread 列表里)' });
      continue;
    }
    if (t.isResolved) {
      results.push({ id: w.id, path: t.path, outcome: 'resolved', done: true, replied: false, resolved: true, reason: 'already-resolved(线程已是 resolved,无需动作)' });
      continue;
    }
    // SC-3:执行层白名单复核(defense-in-depth,不依赖调用方已经过滤干净)——扫描 thread
    // 内**全部**评论的作者(不止首条)。只看 comments[0] 会漏判:真人在 bot 首条评论之后
    // 追加反对意见时,首条仍是白名单 bot,若不扫后续评论就会被误判可代处理,把真人的
    // 异议当空气。任何一条非白名单作者出现就 fail-closed 拒绝。
    const comments = t.comments?.nodes ?? [];
    if (!allowedBots.length) {
      results.push({ id: w.id, path: t.path, outcome: 'skipped', done: false, replied: false, resolved: false, reason: 'skipped-triage-disabled(未传 allowedBots,执行端 fail-closed 拒绝)' });
      continue;
    }
    if (comments.length === 0) {
      results.push({ id: w.id, path: t.path, outcome: 'skipped', done: false, replied: false, resolved: false, reason: 'skipped-author-not-in-whitelist(thread 无评论,拒绝代处理)', author: null });
      continue;
    }
    const { reviewerComments, offender } = findNonWhitelisted(comments);
    if (offender) {
      // 命中的是首条(触发 review 的)评论本身 → author-not-in-whitelist;命中的是首条
      // 之后追加的评论 → non-whitelisted-comment-present,区分"审核发起者本身不在
      // 白名单"与"真人在白名单 bot 之后追加了异议"两种场景。
      const isFirstComment = offender === reviewerComments[0];
      results.push({
        id: w.id, path: t.path, outcome: 'skipped', done: false, replied: false, resolved: false,
        reason: isFirstComment
          ? 'skipped-author-not-in-whitelist(执行端复核:评论作者不在白名单,拒绝代处理)'
          : 'skipped-non-whitelisted-comment-present(执行端复核:thread 内存在非白名单作者的评论,拒绝代处理)',
        author: offender?.author?.login ?? null,
      });
      continue;
    }
    if (dryRun) {
      // dry-run 不拿锁、不重查;resolve 预演按批量评论里的己方 marker 判定。
      const pre = ownMarkersFrom(comments, pr, w.id, viewerLogin);
      const preAge = pre.length ? markerAgeMs(pre[pre.length - 1].comment) : null;
      const wouldResolve = pre.length > 0
        && !pre.some((m) => m.marker.state === 'resolved')
        && pre[pre.length - 1].marker.sha === headSha
        && preAge !== null
        && (MIN_MARKER_AGE_MS === null || preAge >= MIN_MARKER_AGE_MS);
      results.push({ id: w.id, path: t.path, dryRun: true, wouldReply: true, wouldResolve, ...(preAge === null ? {} : { markerAgeMs: preAge }) });
      continue;
    }
    // SC-2:并发至多一次。拿不到锁 = 另一进程正在处理同一 thread,本进程不动。
    const lock = await acquireThreadLock(pr, w.id);
    if (!lock) {
      results.push({ id: w.id, path: t.path, outcome: 'skipped', done: false, replied: false, resolved: false, reason: 'skipped-lock-busy(另一进程正在处理同一 thread,本次不动)' });
      continue;
    }
    try {
      // 临界区内重查一次活态,闭合"批量查询→加锁"之间的 TOCTOU 窗口。
      const rc = ghGraphql(THREAD_RECHECK_QUERY, { tid: w.id });
      const freshNode = rc?.data?.node;
      if (freshNode?.isResolved === true) {
        results.push({ id: w.id, path: t.path, outcome: 'resolved', done: true, replied: false, resolved: true, reason: 'already-resolved(锁内重查发现已被并发处理)' });
        continue;
      }
      // marker 检测必须用「批量分页取全的 comments」兜底,不能只信 freshNode 的
      // 前 50 条——否则第 50 条之后的历史 marker 会被误判「无己方 marker」而走首轮
      // 重复回复(SC-5 实测暴露:52 条评论里第 52 条才是 marker)。
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
      // 锁内重查一次白名单——TOCTOU 窗口内可能刚好新增了一条真人反对评论,批量查询
      // 阶段的白名单复核看不到它,必须在临界区内用合并后的全量评论再扫一次。同样只
      // 豁免 viewer 自己的评论。
      const mergedScan = findNonWhitelisted(mergedComments);
      if (mergedScan.offender) {
        results.push({
          id: w.id, path: t.path, outcome: 'skipped', done: false, replied: false, resolved: false,
          reason: 'skipped-non-whitelisted-comment-present(锁内重查:合并后的评论列表出现非白名单作者,拒绝代处理)',
          author: mergedScan.offender?.author?.login ?? null,
        });
        continue;
      }
      // 己方 marker 判定(机器可核实条件)。只认 viewer 身份作者、pr/thread 对得上的
      // marker;state=resolved 的 marker 说明我们 resolve 成功过。
      const ownMarkers = ownMarkersFrom(mergedComments, pr, w.id, viewerLogin);
      if (ownMarkers.some((m) => m.marker.state === 'resolved')) {
        // 我们已 resolve 过、thread 又被 reopen → 人工翻案,永久留人工,不与人拉锯。
        results.push({ id: w.id, path: t.path, outcome: 'skipped', done: false, replied: false, resolved: false, reason: 'skipped-reopened-after-triage(己方已 resolve 过(state=resolved marker)又被 reopen = 人工翻案,永久留人工)' });
        continue;
      }
      const doReply = async () => {
        let replied = false;
        let replyError = null;
        try {
          ghGraphql(REPLY_MUTATION, { tid: w.id, body: `${w.reply.trim()}\n\n${buildMarker(pr, w.id, headSha, 'replied')}` });
          replied = true;
        } catch (e) {
          replyError = String(e?.message ?? e).slice(0, 200);
        }
        return { replied, replyError };
      };
      if (ownMarkers.length > 0) {
        // 上一轮己方已 reply(state=replied marker)。机器可核实条件(全部满足才 resolve,
        // 不重复回复):
        //   a. sha 与本次 headSha 一致——不一致说明上一轮 triage 针对旧 head,按新 head
        //      重新走首轮(只回复),由编排层按当前 head 重新生成 reply;
        //   b. 己方 marker 年龄 ≥ MIN_MARKER_AGE_MS(人工反对窗口,见常量注释)。
        const last = ownMarkers[ownMarkers.length - 1];
        if (last.marker.sha !== headSha) {
          const { replied, replyError } = await doReply();
          results.push({
            id: w.id, path: t.path, outcome: replied ? 'replied-only' : 'skipped',
            done: false, replied, resolved: false,
            ...(replyError ? { replyError } : {}),
            reason: replied
              ? 'replied-only(head 已移动,上一轮 triage 失效,按当前 head 重新回复;resolve 待下一轮同 headSha 机器可核实)'
              : 'skipped-reply-failed(回复发送失败,下一轮可重试)',
          });
          continue;
        }
        const lastAge = markerAgeMs(last.comment);
        if (lastAge === null || (MIN_MARKER_AGE_MS !== null && lastAge < MIN_MARKER_AGE_MS)) {
          // 人工反对窗口未过(或读不到 marker 时间戳,保守不 resolve)。不重复回复,只
          // 等下一轮重查;窗口内有人 resolve 掉(手动)→ 下一轮看到 already-resolved。
          // 门显式关闭(REVIEW_PR_DISABLE_MARKER_AGE_GATE=1)时跳过年龄比较,但
          // lastAge === null(无 createdAt)的保守判定不豁免。
          results.push({
            id: w.id, path: t.path, outcome: 'replied-only', done: false, replied: false,
            resolved: false, markerAgeMs: lastAge,
            reason: lastAge === null
              ? 'replied-only(己方 marker 无 createdAt,缺时间戳保守不 resolve——下一轮自动重查)'
              : `replied-only(己方 marker 年龄 ${Math.floor(lastAge / 1000)}s < 人工反对窗口 ${Math.floor(MIN_MARKER_AGE_MS / 1000)}s,不 resolve——窗口期内保留人工介入机会;下一轮自动重查)`,
          });
          continue;
        }
        let resolved = false;
        let resolveError = null;
        try {
          const r = ghGraphql(RESOLVE_MUTATION, { tid: w.id });
          resolved = r?.data?.resolveReviewThread?.thread?.isResolved === true;
        } catch (e) {
          resolveError = String(e?.message ?? e).slice(0, 200);
        }
        if (resolved) {
          // 追加 state=resolved marker:审计 + 后续 reopen 时区分「我们 resolve 后被
          // 翻案」(永久留人工)与「从未 resolve 过」(可重试)。
          try {
            ghGraphql(REPLY_MUTATION, { tid: w.id, body: buildMarker(pr, w.id, headSha, 'resolved') });
          } catch { /* best-effort:线程已 resolve,下轮看到 already-resolved;reopen 场景缺
             state=resolved 标记的代价只是多 resolve 一次,不致命 */ }
        }
        results.push({
          id: w.id, path: t.path, outcome: resolved ? 'resolved' : 'skipped',
          done: resolved, replied: false, resolved,
          ...(resolveError ? { resolveError } : {}),
          reason: resolved
            ? 'resolved-own-triage(上一轮己方已 reply 同一 headSha(己方 marker 可验证)且白名单复核通过,本轮 resolve)'
            : 'skipped-resolve-failed(resolve mutation 失败,marker 仍是 replied 态,下一轮自动重试 resolve,不重复回复)',
        });
        continue;
      }
      // 无己方 marker → 首轮:只回复不关闭(reply 可纠正,是反停滞的全部价值;resolve
      // 需机器可核实条件——本线程尚无己方历史 triage,下一轮同 headSha 重跑将 resolve)。
      const { replied, replyError } = await doReply();
      results.push({
        id: w.id, path: t.path, outcome: replied ? 'replied-only' : 'skipped',
        done: false, replied, resolved: false,
        ...(replyError ? { replyError } : {}),
        reason: replied
          ? 'replied-only(默认只回复不关闭:resolve 需机器可核实条件——本线程无己方历史 triage marker,下一轮同 headSha 重跑将由脚本自动 resolve)'
          : 'skipped-reply-failed(回复发送失败,下一轮可重试)',
      });
    } finally {
      releaseThreadLock(lock);
    }
  }

  print({
    ok: true,
    pr,
    viewer: viewerLogin,
    requested: wanted.length,
    resolvedCount: results.filter((r) => r.done).length,
    repliedOnlyCount: results.filter((r) => r.outcome === 'replied-only').length,
    skippedCount: results.filter((r) => r.outcome === 'skipped').length,
    results,
    ...(rejected.length ? { rejected } : {}),
    ...(warnings.length ? { warnings } : {}),
    note: '回复优先设计:reply 按调用方 payload 无条件发(白名单 bot thread 且无非白名单参与者);resolve 默认不执行,只在机器可核实条件满足时执行——线程已 resolved / 上一轮己方已 reply 同一 headSha 且白名单复核通过 / 己方 state=resolved marker 后又 reopen(人工翻案,永久留人工)。marker 可信度按评论作者身份(GraphQL viewer)判定,文本形状谁都能复制;状态全部在 GitHub 侧,无本地回执。三种终态:replied-only / resolved / skipped-<reason>。',
  });
} catch (e) {
  fail(e);
}
