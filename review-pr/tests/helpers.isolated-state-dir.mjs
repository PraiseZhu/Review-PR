// helpers.isolated-state-dir.mjs — 每个测试进程一个私有 STATE_DIR(第 4 轮核验 R0)。
//
// 修的洞:convergence-state / lib.review-receipt 两个文件在**真实**持久状态目录里用
// 固定 PR 号写状态,并在断言前调 resetPr() 清同名文件。两份默认全量测试并发跑时,
// 彼此的 reset 会互删对方刚写的状态 → 431/432 随机红(核验席实测;主线程那份 432/432,
// 并发的另一份挂在 convergence-state 的状态文件"断言前被别人删了")。
//
// 必须在 import '../scripts/lib.mjs' 与 '../scripts/convergence-state.mjs' **之前**被
// import:lib.mjs 在模块加载期就把 STATE_DIR 定死(resolvePersistentStateRoot 在顶层
// 求值),之后再改 env 无效。ESM 按声明顺序求值依赖,所以"这行 import 写在它们之前"
// 就是时序保证。static-source-hygiene 有守卫钉死这个顺序。
//
// 子进程自动继承:本文件改的是 process.env,spawn 时不显式传 env 的子进程直接继承同一
// 隔离目录;显式构造 env 的用例按自己的值走(不被本文件覆盖)。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// 外部已显式指定时不覆盖(宿主/CI 要求跑在特定目录的场景)
if (!process.env.REVIEW_PR_STATE_DIR) {
  process.env.REVIEW_PR_STATE_DIR = mkdtempSync(join(tmpdir(), 'review-pr-state-'));
}

export const ISOLATED_STATE_ROOT = process.env.REVIEW_PR_STATE_DIR;
