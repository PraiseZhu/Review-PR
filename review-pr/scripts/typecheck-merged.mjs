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

import { git, run, print, fail, loadRules } from './lib.mjs';
import process from 'node:process';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

const ROOT = path.resolve(process.cwd());
const currentMode = process.argv.includes('--current');

// tsc 诊断行:既要认 `file(line,col): error TSxxxx`,也要认没有文件前缀的配置类诊断
// (如 `error TS5058: The specified path does not exist`)。只认前者会把「tsconfig
// 路径不对」这类失败过滤成 errors:[],输出成说不出原因的 pass:false 假阴性。
const ERROR_LINE = /(?:^|:\s)error TS\d{3,5}/;

// 把 references 里的一项(可能是目录,也可能直接是 tsconfig 文件)解析成实际配置文件
function resolveProjectPath(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return null;
  try {
    if (statSync(abs).isDirectory()) {
      const nested = path.join(rel, 'tsconfig.json');
      return existsSync(path.join(ROOT, nested)) ? nested : null;
    }
  } catch {
    return null;
  }
  return rel;
}

// 解析本仓要 typecheck 的 tsconfig 清单。原先硬编码 apps/desktop/tsconfig.json(Cindy
// 仓布局):接入仓库布局不同时 tsc 报 TS5058 直接退 1,而该诊断无文件前缀又被错误提取
// 过滤掉 → 健康检查永远 pass:false + errors:[],既拦不住真问题也说不出为什么。
function resolveTypecheckProjects(rules) {
  const configured = rules?.typecheckProjects ?? rules?.typecheckProject ?? null;
  const fromConfig = (Array.isArray(configured) ? configured : configured ? [configured] : [])
    .map(resolveProjectPath)
    .filter(Boolean);
  if (fromConfig.length) return { projects: fromConfig, source: 'config' };

  // 零配置探测:先照顾 Cindy 仓既有布局,保持向后兼容
  const legacy = resolveProjectPath('apps/desktop/tsconfig.json');
  if (legacy) return { projects: [legacy], source: 'probe:apps/desktop' };

  if (!existsSync(path.join(ROOT, 'tsconfig.json'))) return { projects: [], source: 'none' };

  // solution 式根配置(files:[] + references):对它跑 --noEmit 编译的是零个文件,
  // 会空转退 0 —— 那是比报错更危险的假绿。展开 references 逐个查才是真检查。
  let refs = [];
  try {
    const raw = readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const parsed = JSON.parse(raw);
    refs = Array.isArray(parsed.references)
      ? parsed.references.map((r) => r?.path).filter((p) => typeof p === 'string')
      : [];
  } catch {
    refs = [];
  }

  const refProjects = refs.map((p) => resolveProjectPath(p.replace(/^\.\//, ''))).filter(Boolean);
  if (refProjects.length) return { projects: refProjects, source: 'probe:root-references' };

  return { projects: ['tsconfig.json'], source: 'probe:root' };
}

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

  // 3. 跑 tsc --noEmit(每个 project 10 分钟硬超时,防挂死 auto 轮)
  const { projects, source: projectSource } = resolveTypecheckProjects(loadRules());
  if (!projects.length) {
    cleanup();
    fail(`在 ${ROOT} 找不到可用的 tsconfig(既无 typecheckProject 配置也探测不到),无法 typecheck`);
  }

  const rawParts = [];
  let allOk = true;
  for (const project of projects) {
    const r = run(tscBin, ['--noEmit', '--project', project], {
      allowFail: true,
      timeoutMs: 10 * 60_000,
    });
    if (!r.ok) allOk = false;
    const raw = r.stdout || r.stderr || '';
    if (raw.trim()) rawParts.push(raw);
    // 退了非 0 却一个字都没输出时留个痕,别让它变成无从下手的 errors:[]
    if (!r.ok && !raw.trim()) rawParts.push(`error TS0000: tsc --project ${project} 非零退出但无输出`);
  }

  // 4. 还原(--current 模式为 no-op)
  cleanup();

  // 5. 解析结果
  if (allOk) {
    print({
      ok: true,
      pr: prArg ? Number(prArg) : null,
      mode: currentMode ? 'current' : 'trial-merge',
      pass: true,
      mergeConflict: false,
      projects,
      projectSource,
      errors: [],
    });
  } else {
    // 提取 tsc 错误(常见格式: file(line,col): error TSxxxx: message;配置类诊断无文件前缀)
    const allLines = rawParts.join('\n').split('\n').filter((l) => ERROR_LINE.test(l));
    const errorLines = allLines.map((l) => l.trim()).slice(0, 30); // 最多 30 条,避免输出爆炸
    const totalErrors = allLines.length;

    print({
      ok: true,
      pr: prArg ? Number(prArg) : null,
      mode: currentMode ? 'current' : 'trial-merge',
      pass: false,
      mergeConflict: false,
      projects,
      projectSource,
      errors: errorLines,
      totalErrors,
      note: totalErrors > 30 ? `共 ${totalErrors} 个错误,仅展示前 30 条` : undefined,
    });
  }
} catch (e) {
  cleanup();
  fail(e);
}
