#!/usr/bin/env node
// product-hold.mjs — 「产品 / UI 变更门」的拦截动作:自动创建讨论 issue → 在 PR 上发评论
// 告知作者(带 issue 链接)→ 把 PR 转成 draft,直到白名单成员人肉放行(详见 SKILL
// 「产品 / UI 变更门」;判定与豁免在 context.mjs 的 productGate 字段,本脚本只执行动作)。
//
// 为什么单独成脚本(而非让 LLM 手敲 gh):
//   - 「开 issue → 发评论 → 转 draft」三步的顺序、去重与容错固化在代码里,可复现:
//     * issue 去重靠 PR 评论里的隐藏 HTML 标记(渲染不可见,内嵌 issue 链接)——有标记
//       就绝不重复开 issue / 重发评论;作者未经放行标回 ready 时只重新转 draft,不刷屏。
//       标记随评论存在 GitHub 上,跨机器 / 跨 checkout 都稳,不依赖本地状态文件。
//     * issue 创建失败时不发评论(评论的意义就是给链接),转 draft 照做,下轮自动重试;
//     * issue body 末尾自动追加「关联 PR」footer,回链确定性由代码保证。
//   - 文案(issue 标题 / issue 正文 / PR 评论)是语义活,由调用方(主 agent 按 SKILL 要求
//     与语气规范拟)经 --payload-file 传 JSON 进来,脚本不生成任何一句对外文字。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段,让 auto 轮转能继续下一候选。
//
// 跑:node <skill-root>/scripts/product-hold.mjs <PR> [--payload-file <path|->] [--kind arch] [--dry-run]
//   --payload-file:JSON 文案来源,`-` = stdin(推荐,避开中文/引号问题)。结构:
//     { "issueTitle": "...", "issueBody": "...", "commentBody": "...{{ISSUE_URL}}..." }
//     commentBody 里的 {{ISSUE_URL}} 会被替换成新建 issue 的链接;没写占位符则自动在
//     末尾追加一行「讨论 issue:<url>」。已存在标记评论时 payload 可省(只做转 draft)。
//   --kind arch:「技术架构变更门」拦截(默认 product=产品/UI 门)。机制完全同款,只有
//     两处差异:marker 里带 kind=arch(供 context.mjs 识别是哪道门 hold 的)、issue footer
//     措辞换成技术架构版。footer 保留「由 review-pr 流程自动创建」签名与「关联 PR:#N」
//     格式——close-product-issue.mjs 的定向关闭与 sweep 兜底对两种门天然通用,零改动。
//   --dry-run:只探测(是否已拦截过 / 是否已 draft / 将做什么),不写任何外部状态

import { readFileSync } from 'node:fs';
import { parseRepo, parsePR, gh, ghJson, print, fail, renderIssueUrl, PRODUCT_GATE_MARKER_PREFIX } from './lib.mjs';

// 隐藏去重标记:HTML 注释,GitHub 渲染不可见,但 API 返回的 body 里查得到。
// 前缀常量在 lib.mjs(context.mjs 扫描 / product-release.mjs 放行共用同一份)。
// 完整形态内嵌 issue 链接,供后续轮次直接读出「当时开的哪个 issue」。
// 去重按前缀、不分 kind:一个 PR 同一时间只会被一道门 hold(context.mjs 里产品门优先),
// 一个 PR 永远只开一个讨论 issue。
const MARKER_PREFIX = PRODUCT_GATE_MARKER_PREFIX;
const marker = (issueUrl, kind) =>
  kind === 'arch' ? `${MARKER_PREFIX} kind=arch issue=${issueUrl} -->` : `${MARKER_PREFIX} issue=${issueUrl} -->`;

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const kindIdx = process.argv.indexOf('--kind');
  const kind = kindIdx >= 0 && process.argv[kindIdx + 1] === 'arch' ? 'arch' : 'product';
  const pfIdx = process.argv.indexOf('--payload-file');
  const payloadSrc = pfIdx >= 0 ? process.argv[pfIdx + 1] : null;
  let payload = null;
  if (payloadSrc) {
    payload = JSON.parse(readFileSync(payloadSrc === '-' ? 0 : payloadSrc, 'utf8'));
  }
  const issueTitle = (payload?.issueTitle ?? '').trim();
  const issueBody = (payload?.issueBody ?? '').trim();
  const commentBody = (payload?.commentBody ?? '').trim();
  const payloadComplete = issueTitle !== '' && issueBody !== '' && commentBody !== '';

  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'number,state,isDraft,mergedAt,author,url,comments',
  ]);
  const author = meta.author?.login ?? '';

  // 已合并 / 已关闭的 PR 不碰(转 draft 会直接报错,提前拦出清晰原因)
  if (meta.state !== 'OPEN' || meta.mergedAt) {
    print({ ok: true, pr, author, held: false, reason: 'pr-not-open', state: meta.state });
  } else {
    // 找既有标记评论,读出当时开的 issue 链接。取「最后一条带 issue= 的标记」为准:
    //   - 有 issue 链接 → 完整拦截过,不再开 issue / 不再评论;
    //   - 只有旧版标记(无 issue=,旧流程是让作者自己开 issue)→ 视为「issue 还欠着」,
    //     本次补开 issue + 补发跟进评论(带新标记),完成向新流程的自愈迁移。
    const markerComments = (meta.comments ?? []).filter((c) => (c.body ?? '').includes(MARKER_PREFIX));
    const alreadyHeld = markerComments.length > 0;
    const priorIssueUrl = markerComments
      .map((c) => c.body.match(/issue=(\S+?)\s*-->/)?.[1] ?? null)
      .filter(Boolean)
      .pop() ?? null;
    const wasDraft = meta.isDraft === true;
    const needIssue = priorIssueUrl == null; // 覆盖「从未拦截」与「旧版拦截但没 issue」两种情况

    if (dryRun) {
      print({
        ok: true, pr, author, dryRun: true,
        alreadyHeld, priorIssueUrl, wasDraft,
        wouldCreateIssue: needIssue && payloadComplete,
        wouldComment: needIssue && payloadComplete,
        wouldDraft: !wasDraft,
        missingPayload: needIssue && !payloadComplete,
      });
    } else if (needIssue && !payloadComplete) {
      // 开 issue / 发评论必须有完整文案——光转 draft 会让作者一头雾水,拒绝执行
      print({ ok: true, pr, author, held: false, reason: 'missing-payload', alreadyHeld, wasDraft });
    } else {
      // 1) 开讨论 issue(没有既有 issue 时;失败则本轮不发评论,下轮凭「无 issue 标记」自动重试)
      let issueUrl = priorIssueUrl;
      let issueCreated = false;
      let issueError = null;
      if (needIssue) {
        // footer 由代码追加,保证 issue 一定回链到 PR / 点名作者,不依赖调用方记得写。
        // 两种 kind 都保留「由 review-pr 流程自动创建」签名(close-product-issue.mjs sweep 依赖)。
        const topic = kind === 'arch' ? '技术架构调整' : '产品 / UI 变更';
        const footer = `\n\n---\n关联 PR:#${pr}(作者 @${author});本 issue 由 review-pr 流程自动创建,用于先讨论该 PR 涉及的${topic},聊清楚后 PR 会恢复审查。`;
        const r = gh(['issue', 'create', '--repo', slug, '--title', issueTitle, '--body-file', '-'], {
          input: issueBody + footer,
          allowFail: true,
        });
        // gh issue create 成功时 stdout 是 issue 的 URL
        const created = (r.stdout || '').trim().split('\n').pop()?.trim() ?? '';
        if (r.ok && /^https:\/\//.test(created)) {
          issueUrl = created;
          issueCreated = true;
        } else {
          issueError = (r.stderr || r.stdout || '').trim().slice(0, 300);
        }
      }

      // 2) 发评论(带隐藏标记;仅在本轮新开了 issue 时——评论的核心就是给 issue 链接)
      let commented = false;
      let commentError = null;
      if (issueCreated && issueUrl) {
        const rendered = commentBody.includes('{{ISSUE_URL}}')
          ? renderIssueUrl(commentBody, issueUrl)
          : `${commentBody}\n\n讨论 issue:<${issueUrl}>`;
        const r = gh(['pr', 'comment', String(pr), '--repo', slug, '--body-file', '-'], {
          input: `${rendered}\n\n${marker(issueUrl, kind)}`,
          allowFail: true,
        });
        if (r.ok) commented = true;
        else commentError = (r.stderr || '').trim().slice(0, 300);
      }

      // 3) 转 draft(前两步成败不影响本步——hold 语义至少要把 PR 停下来,结果如实上报)
      let drafted = false;
      let draftError = null;
      if (!wasDraft) {
        const r = gh(['pr', 'ready', String(pr), '--repo', slug, '--undo'], { allowFail: true });
        if (r.ok) drafted = true;
        else draftError = (r.stderr || '').trim().slice(0, 300);
      }

      const held = (wasDraft || drafted) && (priorIssueUrl != null || commented);
      print({
        ok: true, pr, author, kind, held,
        issueUrl, issueCreated, issueError,
        commented, alreadyHeld, commentError,
        drafted, wasDraft, draftError,
        url: meta.url,
      });
    }
  }
} catch (e) {
  fail(e);
}
