#!/usr/bin/env node
// checkout.mjs — 把 PR 代码拉到本地(审查检出)
//
// 默认 **detached HEAD**:fetch refs/pull/<N>/head 后直接检出,**不创建任何本地分支**。
// 审查是只读的,不需要分支;历史上 `gh pr checkout` 建出的同名本地分支是孤儿分支膨胀的
// 最大来源(实测一轮扫出 200+ 条 worktree-agent-* / pr-* 遗留),还会让并行审查 worktree
// 互相踩(同名分支不能在两个 worktree 同时 checkout)、下一轮 checkout 报
// "refusing to fetch into branch"。detach 模式天然无此问题,worktree 用完即弃、零分支残留。
//
// --branch:显式要求建本地分支 pr-<N>(冲突代合并等需要在分支上工作的场景才用;
// 用完由调用方在同一轮删掉,见 SKILL 收尾)。
//
// 跑:node <skill-root>/scripts/checkout.mjs <PR> [--branch]

import { parseRepo, parsePR, gh, git, print, fail } from './lib.mjs';

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const wantBranch = process.argv.includes('--branch');

  if (!wantBranch) {
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
