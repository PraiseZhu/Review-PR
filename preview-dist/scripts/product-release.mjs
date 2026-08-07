#!/usr/bin/env node
// product-release.mjs — 「产品 / UI 变更门」「技术架构变更门」的自动放行动作:把被
// product-hold.mjs 转成 draft 的 PR 标回 Ready for review + 发告知评论。与 product-hold
// 互为镜像:hold 拦下、release 放行,作者全程无需任何操作(白名单在讨论 issue 里明确
// 同意后,下一轮 auto 扫描判出同意即调本脚本,详见 SKILL「产品 / UI 变更门」的放行状态机)。
//
// 「issue 留言是否构成明确同意」是语义活,由主 agent 判(判定与豁免原料在 context.mjs 的
// productGate / archGate 字段),本脚本只执行动作 + 守确定性安全边界:
//   - 只放行「被本流程 hold 过」的 PR(必须有 product-hold 的隐藏标记评论)——作者自己
//     转 draft 的 PR 一律拒绝(reason=not-held-by-flow),绝不替作者做「我还没写完」的决定;
//   - 幂等:PR 已是 Ready → 不动(alreadyReady);告知评论带隐藏 release 标记,同一 issue
//     的放行评论只发一次,重跑不刷屏;
//   - 文案(告知评论)由调用方(主 agent 按 SKILL 语气规范拟,写明是谁在 issue 里同意的)
//     经 --payload-file 传入;缺文案时照样标回 Ready(放行语义优先),commented=false 如实上报。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段,让 auto 轮转能继续下一候选。
//
// 跑:node <skill-root>/scripts/product-release.mjs <PR> [--payload-file <path|->] [--dry-run]
//   --payload-file:JSON 文案来源,`-` = stdin。结构:{ "commentBody": "...{{ISSUE_URL}}..." }
//     commentBody 里的 {{ISSUE_URL}} 会被替换成当初的讨论 issue 链接。
//   --dry-run:只探测(是否被 hold 过 / 是否已 Ready / 将做什么),不写任何外部状态

import { readFileSync } from 'node:fs';
import { parseRepo, parsePR, gh, ghJson, print, fail, parseLastHoldMarker, renderIssueUrl } from './lib.mjs';

// 放行去重标记(与 product-hold 的 hold 标记同族,GitHub 渲染不可见):内嵌 issue 链接,
// 重跑时按「同一 issue 已发过放行评论」去重——PR 若经历「放行 → 又被 hold(新 issue)→
// 再放行」的多轮,每轮 issue 不同,各发一条,语义正确。
const RELEASE_MARKER_PREFIX = '<!-- review-pr:product-release';
const releaseMarker = (issueUrl) => `${RELEASE_MARKER_PREFIX} issue=${issueUrl} -->`;

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const pfIdx = process.argv.indexOf('--payload-file');
  const payloadSrc = pfIdx >= 0 ? process.argv[pfIdx + 1] : null;
  const commentBody = payloadSrc
    ? (JSON.parse(readFileSync(payloadSrc === '-' ? 0 : payloadSrc, 'utf8'))?.commentBody ?? '').trim()
    : '';

  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'number,state,isDraft,mergedAt,author,url,comments',
  ]);
  const author = meta.author?.login ?? '';
  const bodies = (meta.comments ?? []).map((c) => c.body);
  const holdMarker = parseLastHoldMarker(bodies);

  if (meta.state !== 'OPEN' || meta.mergedAt) {
    print({ ok: true, pr, author, released: false, reason: 'pr-not-open', state: meta.state });
  } else if (!holdMarker) {
    // 没有 hold 标记 = 不是本流程转的 draft(作者自己转的 / 从未被拦),坚决不碰
    print({ ok: true, pr, author, released: false, reason: 'not-held-by-flow', isDraft: meta.isDraft === true });
  } else {
    const wasDraft = meta.isDraft === true;
    const alreadyCommented = bodies.some((b) => (b ?? '').includes(releaseMarker(holdMarker.issueUrl)));

    if (dryRun) {
      print({
        ok: true, pr, author, dryRun: true,
        kind: holdMarker.kind, issueUrl: holdMarker.issueUrl,
        wasDraft, alreadyCommented,
        wouldReady: wasDraft,
        wouldComment: wasDraft && commentBody !== '' && !alreadyCommented,
      });
    } else {
      // 1) 标回 Ready(已 Ready 则跳过——幂等)
      let readied = false;
      let readyError = null;
      if (wasDraft) {
        const r = gh(['pr', 'ready', String(pr), '--repo', slug], { allowFail: true });
        if (r.ok) readied = true;
        else readyError = (r.stderr || '').trim().slice(0, 300);
      }

      // 2) 发告知评论(带隐藏放行标记;仅在放行确实生效、有文案、且同 issue 没发过时)
      let commented = false;
      let commentError = null;
      if ((readied || !wasDraft) && commentBody !== '' && !alreadyCommented) {
        const rendered = commentBody.includes('{{ISSUE_URL}}')
          ? renderIssueUrl(commentBody, holdMarker.issueUrl)
          : commentBody;
        const r = gh(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], {
          input: `${rendered}\n\n${releaseMarker(holdMarker.issueUrl)}`,
          allowFail: true,
        });
        if (r.ok) commented = true;
        else commentError = (r.stderr || '').trim().slice(0, 300);
      }

      print({
        ok: true, pr, author, kind: holdMarker.kind, issueUrl: holdMarker.issueUrl,
        released: readied || !wasDraft,
        readied, alreadyReady: !wasDraft, readyError,
        commented, alreadyCommented, commentError,
        url: meta.url,
      });
    }
  }
} catch (e) {
  fail(e);
}
