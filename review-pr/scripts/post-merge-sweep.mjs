#!/usr/bin/env node
// post-merge-sweep.mjs — 合并后迟到 bot 意见清扫(对应 SKILL「合并后迟到意见清扫」)
//
// 背景:机器人静默期有两个已知放行窗口(20 分钟超时、greptile 不在必等名单),
// 迟到的 bot 意见会落在已合并的 PR 上,历史上没人管(#716 的 5 条 P1 靠人碰巧看到)。
// 本脚本把这个环闭上:每轮扫最近 windowHours 小时内合并的 PR,发现**合并之后**新出现的
// bot review thread → 在 PR 上评论点名作者(带隐藏去重标记,一个 PR 只提醒一次),
// 并把清单返回给汇总单列一组。纯通知,不加任何权限;失败不阻塞流程。
//
// 退出码恒 0(脚本自身异常才 1)。
//
// 跑:node <skill-root>/scripts/post-merge-sweep.mjs [--window-hours <n>] [--dry-run]
//   窗口缺省读 pr-rules.json 的 postMergeSweep.windowHours(再缺省 24);
//   postMergeSweep.enabled=false 时直接跳过。

import { parseRepo, gh, ghGraphql, print, fail, loadRules, mapPool } from './lib.mjs';

const NOTICE_MARKER = '<!-- review-pr:late-bot-notice -->';

const PR_QUERY = `
  query($owner:String!,$repo:String!,$num:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        author{ login }
        mergedAt
        comments(last:100){ nodes{ body } }
        reviewThreads(first:100){ nodes{
          isResolved path
          comments(first:10){ nodes{ author{ login __typename } createdAt body } }
        }}
      }
    }
  }`;

const isBot = (a) => a?.__typename === 'Bot' || /\[bot\]$/i.test(a?.login ?? '');

try {
  const rules = loadRules();
  const cfg = rules.postMergeSweep ?? {};
  if (cfg.enabled === false) {
    print({ ok: true, skipped: 'disabled' });
    process.exit(0);
  }
  const { owner, repo } = parseRepo();
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const whIdx = process.argv.indexOf('--window-hours');
  const windowHours = whIdx >= 0 ? Number(process.argv[whIdx + 1]) || 24 : Number(cfg.windowHours) || 24;
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString().slice(0, 19) + 'Z';

  const merged = JSON.parse(
    gh(
      ['pr', 'list', '--repo', slug, '--state', 'merged', '--search', `merged:>=${since}`, '--limit', '50', '--json', 'number,title,url,mergedAt'],
      { timeoutMs: 60_000 },
    ).stdout || '[]',
  );

  const findings = (await mapPool(merged, 4, async (p) => {
    try {
      const d = ghGraphql(PR_QUERY, { owner, repo, num: p.number });
      const node = d?.data?.repository?.pullRequest;
      if (!node?.mergedAt) return null;
      const lateThreads = (node.reviewThreads?.nodes ?? [])
        .map((t) => {
          const first = t.comments?.nodes?.[0];
          return first && isBot(first.author) && (first.createdAt ?? '') > node.mergedAt
            ? { path: t.path, bot: first.author?.login ?? '', at: first.createdAt, isResolved: t.isResolved, snippet: (first.body ?? '').slice(0, 200) }
            : null;
        })
        .filter(Boolean);
      if (lateThreads.length === 0) return null;
      const alreadyNotified = (node.comments?.nodes ?? []).some((c) => (c.body ?? '').includes(NOTICE_MARKER));
      return {
        pr: p.number, title: p.title, url: p.url, author: node.author?.login ?? '',
        mergedAt: node.mergedAt, lateThreads, alreadyNotified,
      };
    } catch (e) {
      return { pr: p.number, error: String(e?.message ?? e).slice(0, 200) };
    }
  })).filter(Boolean);

  // 评论点名作者(一个 PR 只提醒一次;dry-run 不写)
  for (const f of findings) {
    if (f.error || f.alreadyNotified) continue;
    if (dryRun) { f.wouldNotify = true; continue; }
    const lines = f.lateThreads.slice(0, 10).map((t) => `- \`${t.path}\`(${t.bot})`).join('\n');
    const body = `@${f.author} 本 PR 合并后,review 机器人补交了 ${f.lateThreads.length} 条意见(合并前静默期已到上限放行):\n${lines}\n\n请过一眼:确认是真问题的,开个 follow-up PR 处理;不是问题的直接 resolve 即可。\n\n${NOTICE_MARKER}`;
    const r = gh(['pr', 'comment', String(f.pr), '--repo', slug, '--body-file', '-'], { input: body, allowFail: true });
    f.notified = r.ok;
    if (!r.ok) f.notifyError = (r.stderr || '').trim().slice(0, 200);
  }

  print({
    ok: true,
    windowHours,
    scanned: merged.length,
    findings,
    note: 'findings 非空时汇总单列一组「合并后迟到意见」,写 PR 号 + bot + 条数;alreadyNotified=true 的不重复提醒。selfFixAuthors 的 PR 照常评论(收件人就是维护者本人,同时进汇总)',
  });
} catch (e) {
  fail(e);
}
