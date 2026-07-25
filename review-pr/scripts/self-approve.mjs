#!/usr/bin/env node
// self-approve.mjs — auto 模式「自解死锁」专用的确定性写操作(对应 SKILL 3A 第 0 步)。
//
// 场景:某 PR 的 mergeStateStatus=BLOCKED 唯一根因是本流程账号(viewer)自己之前 3B 打回
// 挂的 CHANGES_REQUESTED,且所有 conversation 已 resolve、重审已通过(零 [阻断]/[必改])。
// 此时用同一账号重新提交 APPROVE 覆盖掉自己的旧 CR,把 reviewDecision 推回 APPROVED、
// 解除 BLOCKED,再进合并。
//
// ⚠️ 安全边界写在代码里,不靠调用方记得检查:脚本 approve 前自己重新核验
// selfBlockedResolvable 仍成立 —— BLOCKED + reviewDecision=CHANGES_REQUESTED +
// 所有 CR 都是 viewer 自己的 + 0 条未 resolve thread。任一不满足 → 拒绝 approve、
// 返回 approved:false + reason(exit 2),**绝不替别人撤 review、绝不在 thread 没 resolve 时放行**。
//
// 职责分界:「重审是否通过」是 LLM 的语义判断(代码没改的问题别 approve),脚本无从得知,
// 由调用方(SKILL 3A)负责只在重审通过后才调本脚本;脚本只守「机械前置条件」这一半。
// 两边各守一半,合起来才放行。
//
// 退出码:0 = 已 approve;2 = 前置条件不满足、已拒绝;1 = 脚本自身出错。
// 跑:node <skill-root>/scripts/self-approve.mjs <PR> [--dry-run]
//   --dry-run:只核验前置条件并打印将做的,不真提交 APPROVE(供调试 / 自测)。

import { parseRepo, parsePR, gh, ghJson, ghGraphql, print, fail } from './lib.mjs';

// viewer(本流程账号)+ review thread resolve 状态,够核验前置即可,轻量。
const GQL = `
  query($owner:String!,$repo:String!,$num:Int!){
    viewer{ login }
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100){ nodes{ isResolved } }
      }
    }
  }`;

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const dryRun = process.argv.includes('--dry-run');
  const slug = `${owner}/${repo}`;

  // 机械前置条件的全部输入:meta(state / mergeStateStatus / reviewDecision / reviews)+ viewer + threads
  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'state,mergeStateStatus,reviewDecision,reviews',
  ]);
  const changesRequestedReviews = (meta.reviews ?? []).filter((r) => r.state === 'CHANGES_REQUESTED');

  const gqlData = ghGraphql(GQL, { owner, repo, num: pr })?.data ?? {};
  const viewerLogin = gqlData.viewer?.login ?? '';
  const threads = gqlData.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const unresolvedCount = threads.filter((t) => !t.isResolved).length;

  // ── 机械前置条件核验(与 context.mjs 的 selfBlockedResolvable 同口径,任一不满足即拒绝)──
  const reasons = [];
  if (meta.state !== 'OPEN') reasons.push(`PR state=${meta.state}(非 OPEN)`);
  if (meta.mergeStateStatus !== 'BLOCKED') reasons.push(`mergeStateStatus=${meta.mergeStateStatus}(非 BLOCKED,无需 self-approve 解锁)`);
  if (meta.reviewDecision !== 'CHANGES_REQUESTED') reasons.push(`reviewDecision=${meta.reviewDecision}(非 CHANGES_REQUESTED)`);
  if (changesRequestedReviews.length === 0) reasons.push('没有任何 CHANGES_REQUESTED review');
  const allBySelf = viewerLogin !== '' && changesRequestedReviews.every((r) => (r.author?.login ?? '') === viewerLogin);
  if (changesRequestedReviews.length > 0 && !allBySelf) {
    reasons.push('存在「别人」挂的 CHANGES_REQUESTED —— 绝不替别人撤 review');
  }
  if (unresolvedCount > 0) reasons.push(`${unresolvedCount} 条 conversation 未 resolve`);

  if (reasons.length > 0) {
    print({ ok: true, pr, approved: false, viewer: viewerLogin, reason: reasons.join(';') });
    process.exit(2);
  }

  const body =
    '重审通过:此前 request-changes 指出的问题已在后续 commit 中处理,所有 conversation 已 resolve,' +
    '故覆盖掉先前的 CHANGES_REQUESTED 解除合并阻塞。';

  if (dryRun) {
    print({ ok: true, pr, approved: false, reason: 'dry-run', viewer: viewerLogin, body });
    process.exit(0);
  }

  // ── 全部满足 → 同身份提交 APPROVE(body 走 stdin,避开命令行引号坑)──
  gh(['pr', 'review', String(pr), '--repo', slug, '--approve', '--body-file', '-'], { input: body });
  print({ ok: true, pr, approved: true, viewer: viewerLogin, body });
  process.exit(0);
} catch (e) {
  fail(e);
}
