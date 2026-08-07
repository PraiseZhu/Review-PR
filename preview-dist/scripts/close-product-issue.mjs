#!/usr/bin/env node
// close-product-issue.mjs — 「产品 / UI 变更门」的收尾动作:PR 真正合并后,自动关闭当初
// product-hold.mjs 开的讨论 issue(先发一条说明评论、再 close),不让讨论 issue 悬空。
//
// 两种模式:
//   node <skill-root>/scripts/close-product-issue.mjs <PR> [--dry-run]
//     定向:review-pr 流程自己合并完某个 PR 后立刻调(3A / bypass 合并后)。PR 上没有
//     product-gate 隐藏标记 = 非产品门 PR,no-op;PR 没真合并(closed 未 merge)也不动。
//   node <skill-root>/scripts/close-product-issue.mjs --sweep [--dry-run]
//     兜底:扫描本仓库仍 open、由 review-pr 流程自动创建的讨论 issue(按 footer 签名
//     识别,footer 由 product-hold.mjs 确定性追加),其关联 PR 已合并的补关——覆盖
//     「白名单放行后有人直接在 GitHub 网页手动合并」这类不经过本流程的合并路径。
//
// 幂等与去重全在代码里:issue 已关闭就不再碰;先用 `gh issue comment --body-file -` 发说明
// 评论(body 走 stdin,规避 Windows 下 cmd.exe 对含空格中文/URL 的拆词)、再 `gh issue close`,
// 只在真正执行关闭的那一次发,不存在重复评论;关联 PR 未合并(含 closed 未 merge)一律
// 不动、如实上报,留给人处置。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段,让 auto 轮转能继续。

import { parseRepo, parsePR, gh, ghJson, print, fail } from './lib.mjs';

// 与 product-hold.mjs 的隐藏标记保持一致(定向模式从 PR 评论里读出当时开的 issue)
const MARKER_PREFIX = '<!-- review-pr:product-gate';
// product-hold.mjs 给 issue 追加的 footer 签名(sweep 模式识别"流程自建 issue"的依据)
const FOOTER_SIGN = '由 review-pr 流程自动创建';
const FOOTER_PR_RE = /关联 PR[::]#(\d+)/;

const closeComment = (pr, prUrl) =>
  `关联 PR #${pr} 已合并(${prUrl}),这次产品讨论的结论已随 PR 落地,自动关闭本 issue。` +
  `后续还有想继续聊的,直接 reopen 或另开 issue 都行。`;

/** 关一个 issue(先发说明评论、再 close)。返回 { closed, closeError, commentPosted, commentError }。
 *  评论 body 走 stdin(--body-file -):`gh issue close` 没有 --comment-file,而内联 --comment 在
 *  Windows 下(lib.run 走 shell:true)会被 cmd.exe 按空格拆词——含空格的中文/URL body 会被拆成
 *  多个位置参数触发 "accepts 1 arg(s)" 报错。与 notify/product-hold 等脚本统一改走 gh issue
 *  comment --body-file - 的 stdin 通道,close 命令本身不再带长参数。 */
function closeIssue(slug, issueNumber, pr, prUrl, dryRun) {
  if (dryRun) return { closed: false, wouldClose: true, closeError: null };
  // 先发说明评论(body 走 stdin,规避命令行引号/拆词问题)
  const c = gh(
    ['issue', 'comment', String(issueNumber), '--repo', slug, '--body-file', '-'],
    { input: closeComment(pr, prUrl), allowFail: true },
  );
  // 再 close(无内联长参数)
  const r = gh(['issue', 'close', String(issueNumber), '--repo', slug], { allowFail: true });
  return {
    closed: r.ok,
    closeError: r.ok ? null : (r.stderr || r.stdout || '').trim().slice(0, 300),
    commentPosted: c.ok,
    commentError: c.ok ? null : (c.stderr || c.stdout || '').trim().slice(0, 300),
  };
}

/** 从 issue URL 解析出本仓库的 issue 编号;跨仓库 / 解析失败返回 null。 */
function issueNumberFromUrl(slug, url) {
  const m = String(url ?? '').match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i);
  if (!m) return null;
  if (m[1].toLowerCase() !== slug.toLowerCase()) return null; // product-hold 只在本仓库开 issue
  return Number(m[2]);
}

try {
  const { owner, repo } = parseRepo();
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const sweep = process.argv.includes('--sweep');

  if (!sweep) {
    // —— 定向模式:<PR> ——
    const pr = parsePR(process.argv[2]);
    const meta = ghJson([
      'pr', 'view', String(pr), '--repo', slug,
      '--json', 'number,state,mergedAt,url,comments',
    ]);

    if (!meta.mergedAt) {
      print({ ok: true, pr, closed: false, reason: 'pr-not-merged', state: meta.state });
    } else {
      // 与 product-hold 同款取法:最后一条带 issue= 的标记为准
      const issueUrl = (meta.comments ?? [])
        .filter((c) => (c.body ?? '').includes(MARKER_PREFIX))
        .map((c) => c.body.match(/issue=(\S+?)\s*-->/)?.[1] ?? null)
        .filter(Boolean)
        .pop() ?? null;

      if (!issueUrl) {
        print({ ok: true, pr, closed: false, reason: 'no-product-gate-marker' });
      } else {
        const issueNumber = issueNumberFromUrl(slug, issueUrl);
        if (issueNumber == null) {
          print({ ok: true, pr, closed: false, reason: 'issue-url-unparsable', issueUrl });
        } else {
          const issue = ghJson(['issue', 'view', String(issueNumber), '--repo', slug, '--json', 'state,url,title']);
          if (issue.state !== 'OPEN') {
            print({ ok: true, pr, closed: false, alreadyClosed: true, issueUrl, issueNumber });
          } else {
            const r = closeIssue(slug, issueNumber, pr, meta.url, dryRun);
            print({ ok: true, pr, issueUrl, issueNumber, issueTitle: issue.title, dryRun, ...r });
          }
        }
      }
    }
  } else {
    // —— sweep 兜底模式 ——
    const issues = ghJson([
      'issue', 'list', '--repo', slug, '--state', 'open',
      '--limit', '100', '--json', 'number,title,body,url',
    ]) ?? [];

    const candidates = issues.filter(
      (i) => (i.body ?? '').includes(FOOTER_SIGN) && FOOTER_PR_RE.test(i.body ?? ''),
    );

    const results = [];
    for (const issue of candidates) {
      const pr = Number(issue.body.match(FOOTER_PR_RE)[1]);
      const item = { issueNumber: issue.number, issueUrl: issue.url, issueTitle: issue.title, pr };
      const r = gh(['pr', 'view', String(pr), '--repo', slug, '--json', 'state,mergedAt,url'], { allowFail: true });
      if (!r.ok) {
        results.push({ ...item, action: 'error', error: (r.stderr || '').trim().slice(0, 300) });
        continue;
      }
      const prMeta = JSON.parse(r.stdout || '{}');
      if (prMeta.mergedAt) {
        results.push({ ...item, action: dryRun ? 'would-close' : 'close', prState: 'MERGED', ...closeIssue(slug, issue.number, pr, prMeta.url, dryRun) });
      } else {
        // OPEN = 还在流程里,正常;CLOSED 未合并 = 提案可能被放弃,issue 去留留给人定,只上报
        results.push({ ...item, action: 'skip', prState: prMeta.state, merged: false });
      }
    }

    print({
      ok: true, sweep: true, dryRun,
      scannedOpenIssues: issues.length,
      matched: candidates.length,
      closedCount: results.filter((x) => x.closed).length,
      results,
    });
  }
} catch (e) {
  fail(e);
}
