#!/usr/bin/env node
// cleanup.mjs — 收尾(对应 skill 清理章节 + 3A「同步本地主干」)
//
// 覆盖所有结束路径:回到最初分支、删本地 pr-<N>、可选同步默认分支、报告 git 状态。
// 参数:
//   --original <branch>   必需,最初记录的分支(回到这里)
//   --pr <N>              可选,删本地 pr-<N>(存在才删;格式门未 checkout 就不传)
//   --sync-main           可选,合并成功后用:切默认分支 + git pull --ff-only
//   --token <t>           可选,prepare.mjs 输出的 lock.token;带上后只释放归属
//                         匹配的锁(防误删接管者的新锁),新流程一律带
//
// 锁释放不依赖 git 收尾成功:checkout 失败(脏文件挡道等)也必须释放自己的锁,
// 否则一次收尾失败会让后续轮次白等 60 分钟 TTL。
// 退出码:0 = 干净收尾;1 = 脚本自身出错(此时锁的释放结果也在输出 JSON 里)。
// 跑:node <skill-root>/scripts/cleanup.mjs --original main --pr 123 [--sync-main] [--token <t>]

import { git, print, fail, releaseLockOwned } from './lib.mjs';

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const original = flag('--original');
const pr = flag('--pr');
const token = flag('--token');
const syncMain = process.argv.includes('--sync-main');
if (!original) fail('缺少 --original <分支名>');

let gitError = null;
const body = {
  currentBranch: null,
  clean: null,
  deletedBranch: false,
  mainSynced: false,
  defaultBranch: null,
};

try {
  git(['checkout', original]);

  if (pr) {
    const br = `pr-${pr}`;
    const exists = git(['rev-parse', '--verify', '--quiet', br], { allowFail: true }).ok;
    if (exists) {
      git(['branch', '-D', br]);
      body.deletedBranch = true;
    }
  }

  if (syncMain) {
    const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
    body.defaultBranch = sym.ok && sym.stdout.trim()
      ? sym.stdout.trim().replace(/^refs\/remotes\/origin\//, '')
      : 'main';
    git(['checkout', body.defaultBranch]);
    body.mainSynced = git(['pull', '--ff-only', 'origin', body.defaultBranch], { allowFail: true }).ok;
  }

  body.clean = git(['status', '--porcelain']).stdout.trim() === '';
  body.currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
} catch (e) {
  gitError = String(e && e.message ? e.message : e);
}

// 释放互斥锁——无论上面 git 收尾成败都执行
let lockReleased = false;
let lockNotOwner = false;
let lockError = null;
try {
  const r = releaseLockOwned(token);
  lockReleased = r.released;
  lockNotOwner = r.notOwner;
} catch (e) {
  lockError = String(e && e.message ? e.message : e);
}

if (gitError) {
  print({ ok: false, error: gitError, lockReleased, lockNotOwner, lockError });
  process.exit(1);
}
print({ ok: true, ...body, lockReleased, lockNotOwner, lockError });
