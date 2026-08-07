#!/usr/bin/env node
// checkout.mjs — 把 PR 分支拉到本地(对应 skill 1.4)
//
// 两种模式:
// 1. 默认(主工作树 / 交互模式):checkout 成本地分支,统一命名 pr-<N>。
//    统一本地分支名(别踩坑):gh pr checkout 默认切到 PR 的 head 分支名,和清理章节
//    用的 pr-<N> 不一致会删错 / 删不掉。这里用 --branch 强制成 pr-<N>;gh 失败再用
//    git fetch refs/pull/<N>/head 兜底。
// 2. --detach(auto 批处理的审查 worktree 用):fetch refs/pull/<N>/head 后以
//    detached HEAD 检出,**不创建任何本地分支**。git worktree 之间共享 refs,
//    并行的多个审查 worktree 若都建分支会互相踩(同名分支不能在两个 worktree
//    同时 checkout),detach 模式天然无此问题,worktree 用完即弃、无需清理分支。
//
// 跑:node <skill-root>/scripts/checkout.mjs <PR> [--detach]

import { parseRepo, parsePR, gh, git, print, fail } from './lib.mjs';

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const detach = process.argv.includes('--detach');

  if (detach) {
    const f = git(['fetch', 'origin', `refs/pull/${pr}/head`], { allowFail: true });
    if (!f.ok) fail(`git fetch refs/pull/${pr}/head 失败: ${f.stderr.trim()}`);
    git(['checkout', '--detach', 'FETCH_HEAD']);
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    print({ ok: true, detached: true, head, branch: null });
  } else {
    const branch = `pr-${pr}`;
    const r = gh(
      ['pr', 'checkout', String(pr), '--repo', `${owner}/${repo}`, '--branch', branch],
      { allowFail: true },
    );
    if (!r.ok) {
      // 兜底:fetch PR head 到 pr-<N> 再 checkout
      const f = git(['fetch', 'origin', `refs/pull/${pr}/head:${branch}`], { allowFail: true });
      if (!f.ok) {
        fail(`gh pr checkout 失败: ${r.stderr.trim()}\nfetch 兜底也失败: ${f.stderr.trim()}`);
      }
      git(['checkout', branch]);
    }
    const actual = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    print({ ok: true, detached: false, branch: actual, expected: branch, matched: actual === branch });
  }
} catch (e) {
  fail(e);
}
