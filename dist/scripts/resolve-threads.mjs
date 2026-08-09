#!/usr/bin/env node
// resolve-threads.mjs — thread 代 resolve(triage 的执行端,对应 SKILL「thread 清理」)
//
// 背景:分支保护开了 Require conversation resolution,thread 不 resolve 就 GitHub 层面
// 合不了;而 bot(greptile 等)从不回来点 resolve,作者修完也常忘点 —— 台账里十几轮
// 整轮空转都是这个原因。判「意见是否已被处理」是语义活,由调用方(编排层按 SKILL
// 「thread 清理」+ lib.mjs assessThreadEvidence 的语义绑定判据)做;本脚本只执行
// 确定性动作:**回复 + resolve**,并守安全边界:
//   - 每次代 resolve 必带一条回复(写明验证依据的 commit)——原 reviewer 收到 GitHub 通知,
//     不同意一键 unresolve,下一轮流程看到 thread 又开了就重新阻断。不允许静默 resolve;
//   - 只操作当前 PR 上真实存在且未 resolve 的 thread(id 必须能在 PR 的 thread 列表里找到);
//   - 幂等:已 resolve 的跳过;回复带隐藏标记 <!-- review-pr:thread-triage -->;
//   - 翻案保护:带 triage 标记回复却又处于未 resolve = 有人点过 unresolve(re-open 不产生
//     评论,只能靠标记推断),一律拒绝再碰(reopened-after-triage)—— 翻案一次永久留人工,
//     不与人拉锯。
//
// 移植自 lizi 上游 resolve-threads.mjs(2026-08-09);mivo 侧语义判定(白名单 bot +
// 修复证据语义绑定)在编排层经 lib.mjs assessThreadEvidence 落实,本脚本不自选 thread、
// 零配置依赖,只执行调用方给的 --payload-file。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段。
//
// 跑:node <skill-root>/scripts/resolve-threads.mjs <PR> --payload-file <path|-> [--dry-run]
//   payload 结构(threads[].id 来自 context.mjs 的 history.reviewThreads[].id):
//   { "threads": [ { "id": "PRRT_xxx", "reply": "已在 abc1234 处理,代为 resolve;有异议可 reopen" } ] }

import { readFileSync } from 'node:fs';
import { parseRepo, parsePR, ghGraphql, print, fail } from './lib.mjs';

const TRIAGE_MARKER = '<!-- review-pr:thread-triage -->';

const THREADS_QUERY = `
  query($owner:String!,$repo:String!,$num:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100){ nodes{
          id isResolved path
          comments(first:50){ nodes{ body } }
        }}
      }
    }
  }`;

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

  const data = ghGraphql(THREADS_QUERY, { owner, repo, num: pr });
  const live = new Map(
    (data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((t) => [t.id, t]),
  );

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
    const alreadyReplied = (t.comments?.nodes ?? []).some((c) => (c.body ?? '').includes(TRIAGE_MARKER));
    // 翻案保护:带 triage 标记回复却又处于未 resolve = 有人点过 unresolve(re-open 不产生
    // 评论,只能靠标记推断)。拒绝再碰,永久留人工 —— 旧逻辑「跳过回复直接补 resolve」会把
    // 人刚翻案的 thread 再点回去,与人拉锯。代价:「回复成功但 resolve 瞬时失败」的场景也
    // 落到这里留给人工 —— 方向安全(宁可漏放不错杀 reviewer 的翻案),不要把它当故障「修复」。
    if (alreadyReplied) {
      results.push({ id: w.id, path: t.path, done: false, reason: 'reopened-after-triage(已代 resolve 过又被 unresolve,人工翻案,永久留人工)' });
      continue;
    }
    if (dryRun) {
      results.push({ id: w.id, path: t.path, dryRun: true, wouldReply: true, wouldResolve: true });
      continue;
    }
    // 1) 回复(必带,不允许静默 resolve)
    let replied = false;
    let replyError = null;
    try {
      ghGraphql(
        `mutation($tid:ID!,$body:String!){
          addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$tid, body:$body}){ comment{ id } }
        }`,
        { tid: w.id, body: `${w.reply.trim()}\n\n${TRIAGE_MARKER}` },
      );
      replied = true;
    } catch (e) {
      replyError = String(e?.message ?? e).slice(0, 200);
    }
    // 2) resolve(回复失败就不 resolve —— 不允许静默吞意见)
    let resolved = false;
    let resolveError = null;
    if (replied) {
      try {
        const r = ghGraphql(
          `mutation($tid:ID!){ resolveReviewThread(input:{threadId:$tid}){ thread{ isResolved } } }`,
          { tid: w.id },
        );
        resolved = r?.data?.resolveReviewThread?.thread?.isResolved === true;
      } catch (e) {
        resolveError = String(e?.message ?? e).slice(0, 200);
      }
    }
    results.push({
      id: w.id, path: t.path, done: resolved,
      replied, ...(replyError ? { replyError } : {}),
      resolved, ...(resolveError ? { resolveError } : {}),
    });
  }

  print({
    ok: true,
    pr,
    requested: wanted.length,
    resolvedCount: results.filter((r) => r.done).length,
    results,
    ...(rejected.length ? { rejected } : {}),
    note: '每条代 resolve 都带回复通知原 reviewer,对方可一键 unresolve;被 unresolve 过的 thread(reopened-after-triage)本脚本永久拒绝再碰,留人工。判「意见是否已处理」是调用方(编排层)的语义责任:只传「白名单 bot + 修复证据语义绑定(assessThreadEvidence)确凿」的——同文件被后续 commit 触碰 / isOutdated 只是必要线索不是充分条件,拿不准不传进来;真人 thread 永不自动 resolve',
  });
} catch (e) {
  fail(e);
}
