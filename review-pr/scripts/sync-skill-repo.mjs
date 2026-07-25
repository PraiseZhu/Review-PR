#!/usr/bin/env node
// sync-skill-repo.mjs — Skill 仓库自同步 CLI(实现在 lib.mjs,这里只是薄封装)。
//
// Skill 以软链接安装进目标项目时,真实源码在 skills 仓库里;本脚本让 skill
// 「执行前自动到最新、自进化后自动回推」,维护者不必手动同步。
//
// 子命令:
//   pull                 把 skills 仓库 git pull --ff-only 到最新(pre-check.mjs /
//                        prepare.mjs 每轮已自动调用;手动跑用于诊断)。
//   push [--message "…"] 提交 skill 目录下所有未提交改动并推送。用于自进化落地
//                        (SKILL 8.3)之后:agent 已手工 commit 的推上去,漏 commit 的
//                        兜底提交(缺省 message `evo: sync skill state`)再推。
//                        只在 skills 仓库当前分支 == 默认分支(main)时才 push;
//                        台账(ledger/EVOLUTION.md)的提交推送由 evolution-note.mjs
//                        每次写入后自动完成,一般不需要手动跑本命令的 push。
//
// 输出 JSON;同步失败 ok=false 但 exit 0(同步是 best-effort,绝不阻塞 review 流程),
// 只有参数错误 exit 1。
import { skillRepoPull, skillRepoCommitPush, print, fail } from './lib.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
}

const cmd = process.argv[2];
if (cmd === 'pull') {
  print(skillRepoPull());
} else if (cmd === 'push') {
  print(skillRepoCommitPush({ message: arg('message') || 'evo: sync skill state' }));
} else {
  fail(new Error('用法:sync-skill-repo.mjs <pull|push> [--message "…"](见文件头注释)'));
}
