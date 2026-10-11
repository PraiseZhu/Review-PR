#!/usr/bin/env node
// close-product-issue.mjs — review-pr 维护者确认讨论 issue 的收尾动作。
//
// 两种生命周期:
//   ① 合并收尾(默认):
//        node <skill-root>/scripts/close-product-issue.mjs <PR> [--dry-run]
//      PR 真正合并后,自动关闭当初 signoff-hold.mjs 开的讨论 issue(先发说明评论、再 close),
//      不让讨论 issue 悬空。PR 上没有确认门隐藏标记 = 非确认门 PR,no-op;PR 没真合并
//      (closed 未 merge)也不动。另有兜底:
//        node <skill-root>/scripts/close-product-issue.mjs --sweep [--dry-run]
//      扫描本仓库仍 open、由 review-pr 流程自动创建的讨论 issue(按 footer 签名识别,footer
//      由 signoff-hold.mjs 确定性追加),其关联 PR 已合并的补关 —— 覆盖「维护者确认通过后
//      有人直接在 GitHub 网页手动合并」这类不经过本流程的合并路径。
//   ② 触发消失收尾:
//        node <skill-root>/scripts/close-product-issue.mjs <PR> --no-longer-required [--dry-run]
//      作者的新 head 已彻底移除全部确认门触发(context 的 signoff.held != null 且
//      signoff.triggers 为空)时调用:给旧讨论 issue 留明确收尾评论并关闭,别让维护者对着
//      一个已不存在的改动继续讨论。仍有 trigger、只是 Approve / Request Changes 令
//      blocking=false 时**不要**调本模式 —— issue 仍是当前改动的讨论记录。之后 gate 再亮
//      起来,signoff-hold.mjs 会新开当前讨论 issue(复用判定见 lib.mjs decideIssueReuse)。
//
// 幂等与去重全在代码里:issue 已关闭就不再碰(两种生命周期同口径,重复调用 no-op);先用
// `gh issue comment --body-file -` 发说明评论(body 走 stdin,规避 Windows 下 cmd.exe 对含
// 空格中文/URL 的拆词)、再 `gh issue close`,只在真正执行关闭的那一次发,不存在重复评论;
// 合并收尾模式下关联 PR 未合并(含 closed 未 merge)一律不动、如实上报,留给人处置。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段,让 auto 轮转能继续。

import { parseRepo, parsePR, gh, ghJson, print, fail, issueNumberFromUrl } from './lib.mjs';

// 与 signoff-hold.mjs 的隐藏标记保持一致(定向模式从 PR 评论里读出当时开的 issue)
const MARKER_PREFIX = '<!-- review-pr:product-gate';
// signoff-hold.mjs 给 issue 追加的 footer 签名(sweep 模式识别"流程自建 issue"的依据)
const FOOTER_SIGN = '由 review-pr 流程自动创建';
const FOOTER_PR_RE = /关联 PR[::]#(\d+)/;
// sweep 拉 open issue 的窗口。见下方 truncated 注释:必须显著大于门禁 issue 存量。
const SWEEP_LIST_LIMIT = 500;

const mergedComment = (pr, prUrl) =>
  `关联 PR #${pr} 已合并(${prUrl}),这次产品讨论的结论已随 PR 落地,自动关闭本 issue。` +
  `后续还有想继续聊的,直接 reopen 或另开 issue 都行。`;
const noLongerRequiredComment = (pr, prUrl) =>
  `关联 PR #${pr}(${prUrl})的最新提交已不再触发任何维护者确认门 —— 当初需要讨论的改动` +
  `已被作者移除或改写,流程自动关闭本 issue 收尾。该 PR 之后若再次命中确认门,流程会另开` +
  `新的讨论 issue;想继续这里的话题,直接 reopen 就行。`;

/** 关一个 issue(先发说明评论、再 close)。返回 { closed, closeError, commentPosted, commentError }。
 *  评论 body 走 stdin(--body-file -):`gh issue close` 没有 --comment-file,而内联 --comment 在
 *  Windows 下(lib.run 走 shell:true)会被 cmd.exe 按空格拆词——含空格的中文/URL body 会被拆成
 *  多个位置参数触发 "accepts 1 arg(s)" 报错。与 notify/signoff-hold 等脚本统一改走 gh issue
 *  comment --body-file - 的 stdin 通道,close 命令本身不再带长参数。 */
function closeIssue(slug, issueNumber, commentBody, dryRun) {
  if (dryRun) return { closed: false, wouldClose: true, closeError: null };
  // 先发说明评论(body 走 stdin,规避命令行引号/拆词问题)
  const c = gh(
    ['issue', 'comment', String(issueNumber), '--repo', slug, '--body-file', '-'],
    { input: commentBody, allowFail: true },
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

/** 定向模式(合并收尾 / 触发消失收尾)共用:从 PR 评论标记里找出讨论 issue 并校验仍 OPEN。
 *  与 signoff-hold 同款取法:最后一条带 issue= 的标记为准。
 *  返回 { issue: {number,url,title} } 或 { skip: <no-op 结果字段,原因已装好> }。 */
function locateMarkerIssue(slug, meta) {
  const issueUrl = (meta.comments ?? [])
    .filter((c) => (c.body ?? '').includes(MARKER_PREFIX))
    .map((c) => c.body.match(/issue=(\S+?)\s*-->/)?.[1] ?? null)
    .filter(Boolean)
    .pop() ?? null;
  if (!issueUrl) return { skip: { closed: false, reason: 'no-product-gate-marker' } };
  const issueNumber = issueNumberFromUrl(slug, issueUrl);
  if (issueNumber == null) return { skip: { closed: false, reason: 'issue-url-unparsable', issueUrl } };
  const issue = ghJson(['issue', 'view', String(issueNumber), '--repo', slug, '--json', 'state,url,title']);
  if (issue.state !== 'OPEN') return { skip: { closed: false, alreadyClosed: true, issueUrl, issueNumber } };
  return { issue: { number: issueNumber, url: issueUrl, title: issue.title } };
}

try {
  const { owner, repo } = parseRepo();
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const sweep = process.argv.includes('--sweep');
  const noLongerRequired = process.argv.includes('--no-longer-required');

  if (sweep) {
    // —— sweep 兜底模式(只服务合并收尾这条生命周期)——
    // limit 要留足余量:门禁讨论 issue 会长期堆积(2026-08-08 实测 102 条 open),旧值 100 正好
    // 卡在存量线上 —— 超出的部分被**静默**丢掉,表现成「sweep 跑了但没扫干净」。命中上限时
    // 明确回传 truncated,别让调用方把「只看了前 N 条」当成「全仓都干净了」。
    const issues = ghJson([
      'issue', 'list', '--repo', slug, '--state', 'open',
      '--limit', String(SWEEP_LIST_LIMIT), '--json', 'number,title,body,url',
    ]) ?? [];
    const truncated = issues.length >= SWEEP_LIST_LIMIT;

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
        results.push({ ...item, action: dryRun ? 'would-close' : 'close', prState: 'MERGED', ...closeIssue(slug, issue.number, mergedComment(pr, prMeta.url), dryRun) });
      } else {
        // OPEN = 还在流程里,正常;CLOSED 未合并 = 提案可能被放弃,issue 去留留给人定,只上报
        results.push({ ...item, action: 'skip', prState: prMeta.state, merged: false });
      }
    }

    print({
      ok: true, sweep: true, dryRun,
      scannedOpenIssues: issues.length,
      ...(truncated
        ? {
            truncated: true,
            listLimit: SWEEP_LIST_LIMIT,
            truncatedNote:
              `open issue 数量已达拉取上限 ${SWEEP_LIST_LIMIT},本轮只看了这批 —— 不能据此认定`
              + '全仓已扫干净。抬高 SWEEP_LIST_LIMIT 或分页后重跑。',
          }
        : {}),
      matched: candidates.length,
      // 未合并(含 closed 未 merge)的按设计只上报不关闭:提案可能被放弃,issue 去留留给人定。
      // 单独计数,免得「matched 多、closedCount 少」看起来像失败。
      skippedNotMerged: results.filter((x) => x.action === 'skip').length,
      closedCount: results.filter((x) => x.closed).length,
      results,
    });
  } else if (noLongerRequired) {
    // —— 触发消失收尾:<PR> --no-longer-required ——
    // 不看 PR 是否合并 / 关闭:调用前提(triggers 已清空)由 context 判、由调用方核对;
    // 幂等由 issue state 保证 —— 已关闭 no-op、无标记 no-op,重复调用无副作用。
    const pr = parsePR(process.argv[2]);
    const meta = ghJson([
      'pr', 'view', String(pr), '--repo', slug,
      '--json', 'number,state,mergedAt,url,comments',
    ]);
    const located = locateMarkerIssue(slug, meta);
    if (located.skip) {
      print({ ok: true, pr, mode: 'no-longer-required', ...located.skip });
    } else {
      const r = closeIssue(slug, located.issue.number, noLongerRequiredComment(pr, meta.url), dryRun);
      print({
        ok: true, pr, mode: 'no-longer-required',
        issueUrl: located.issue.url, issueNumber: located.issue.number, issueTitle: located.issue.title,
        dryRun, ...r,
      });
    }
  } else {
    // —— 合并收尾定向模式:<PR> ——
    // review-pr 流程自己合并完某个 PR 后立刻调(3A / bypass 合并后)。
    const pr = parsePR(process.argv[2]);
    const meta = ghJson([
      'pr', 'view', String(pr), '--repo', slug,
      '--json', 'number,state,mergedAt,url,comments',
    ]);

    if (!meta.mergedAt) {
      print({ ok: true, pr, closed: false, reason: 'pr-not-merged', state: meta.state });
    } else {
      const located = locateMarkerIssue(slug, meta);
      if (located.skip) {
        print({ ok: true, pr, ...located.skip });
      } else {
        const r = closeIssue(slug, located.issue.number, mergedComment(pr, meta.url), dryRun);
        print({
          ok: true, pr,
          issueUrl: located.issue.url, issueNumber: located.issue.number, issueTitle: located.issue.title,
          dryRun, ...r,
        });
      }
    }
  }
} catch (e) {
  fail(e);
}
