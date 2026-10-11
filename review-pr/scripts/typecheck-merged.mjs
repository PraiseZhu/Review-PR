#!/usr/bin/env node
// typecheck-merged.mjs — 模拟合并 main 后跑 tsc --noEmit,拦截语义合并冲突
//
// 背景:两个分支各自 typecheck 过,但合并后可能因为删了 import / 改了签名 / 循环依赖
// 而运行时 ReferenceError 或编译不过。这个检查在 review 阶段拦住这类问题。
//
// 跑:node <skill-root>/scripts/typecheck-merged.mjs [<PR>] [--current]
//   PR 参数可选(仅用于输出标识,不影响逻辑——脚本假设当前已在 PR 分支)
//   --current:跳过 trial merge,直接对当前工作树跑 tsc(auto 批处理收尾用:本轮合并
//     ≥2 个 PR 后 cleanup --sync-main 已把主树切到最新 main,此时跑它 = 合并后 main
//     健康检查,拦「两个 PR 各自没问题、合完语义冲突」——auto 模式主树全程不 checkout
//     PR 分支,trial merge 模式只适用于交互模式(主树已在 PR 分支、有 node_modules)。
//
// 流程(默认 trial merge 模式):
//   1. git fetch origin main
//   2. git merge origin/main --no-commit --no-ff (trial merge)
//   3. npx tsc --noEmit
//   4. git merge --abort / git reset --merge (还原)
// --current 模式只跑第 3 步,不动 git。
//
// 输出:
//   { ok:true, mode, pass:true/false, mergeConflict:bool, errors:[] }

import { git, run, print, fail } from './lib.mjs';
import process from 'node:process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = path.resolve(process.cwd());
const currentMode = process.argv.includes('--current');

function cleanup() {
  if (currentMode) return; // --current 不动 git,无需还原
  // 无论如何都要还原 working tree
  git(['merge', '--abort'], { allowFail: true });
  git(['reset', '--merge'], { allowFail: true });
}

try {
  const prArg = process.argv.slice(2).find((a) => /^#?\d+$/.test(a)) ?? null;

  // tsc 依赖本地 node_modules;缺装(典型:全新 worktree)时明确报错而不是让 run 抛
  // 一个含糊的 spawn 失败——消费方(auto 收尾健康检查)按 ok:false 静默跳过即可。
  const tscBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (!existsSync(tscBin)) {
    fail(`未找到 ${tscBin}(node_modules 未安装?),无法 typecheck`);
  }

  if (!currentMode) {
    // 1. fetch 最新 main
    const fetchResult = git(['fetch', 'origin', 'main'], { allowFail: true });
    if (!fetchResult.ok) {
      fail(`git fetch origin main 失败: ${fetchResult.stderr.trim()}`);
    }

    // 2. trial merge
    const mergeResult = git(
      ['merge', 'origin/main', '--no-commit', '--no-ff'],
      { allowFail: true },
    );

    if (!mergeResult.ok) {
      // 检查是否是合并冲突
      const status = git(['status', '--porcelain'], { allowFail: true });
      const hasConflict = (status.stdout || '').split('\n').some((l) => l.startsWith('U'));
      cleanup();
      if (hasConflict || mergeResult.stderr.includes('CONFLICT') || mergeResult.stdout.includes('CONFLICT')) {
        print({
          ok: true,
          pr: prArg ? Number(prArg) : null,
          mode: 'trial-merge',
          pass: false,
          mergeConflict: true,
          errors: ['与 main 存在合并冲突,无法进行 typecheck'],
        });
        process.exit(0);
      }
      // 非冲突的 merge 失败(罕见)
      fail(`git merge origin/main 失败且非冲突: ${mergeResult.stderr.trim()}`);
    }
  }

  // 3. 跑 tsc --noEmit(10 分钟硬超时,防挂死 auto 轮)
  const tscResult = run(tscBin, ['--noEmit', '--project', 'apps/desktop/tsconfig.json'], {
    allowFail: true,
    timeoutMs: 10 * 60_000,
  });

  // 4. 还原(--current 模式为 no-op)
  cleanup();

  // 5. 解析结果
  if (tscResult.ok) {
    print({
      ok: true,
      pr: prArg ? Number(prArg) : null,
      mode: currentMode ? 'current' : 'trial-merge',
      pass: true,
      mergeConflict: false,
      errors: [],
    });
  } else {
    // 提取 tsc 错误(每行一个错误,格式: file(line,col): error TSxxxx: message)
    const rawOutput = tscResult.stdout || tscResult.stderr || '';
    const errorLines = rawOutput
      .split('\n')
      .filter((l) => l.includes(': error TS'))
      .map((l) => l.trim())
      .slice(0, 30); // 最多 30 条,避免输出爆炸

    const totalErrors = rawOutput.split('\n').filter((l) => l.includes(': error TS')).length;

    print({
      ok: true,
      pr: prArg ? Number(prArg) : null,
      mode: currentMode ? 'current' : 'trial-merge',
      pass: false,
      mergeConflict: false,
      errors: errorLines,
      totalErrors,
      note: totalErrors > 30 ? `共 ${totalErrors} 个错误,仅展示前 30 条` : undefined,
    });
  }
} catch (e) {
  cleanup();
  fail(e);
}
