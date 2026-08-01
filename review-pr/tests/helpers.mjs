// helpers.mjs — state-dir / run-log 测试共用的 fixture 构造与子进程封装。
//
// 为什么用子进程而不是直接 import 后调用内部函数:`lib.mjs` 的状态根解析
// (resolvePersistentStateRoot 及其依赖的 git 探针函数)全部在模块顶层执行,
// 结果由 REVIEW_PR_REPO_ROOT / REVIEW_PR_STATE_DIR 环境变量与 cwd 决定;ESM
// 模块加载后会被缓存,同一进程内无法用不同环境变量重跑一遍拿到不同结果。
// 每个场景都启一个真实子进程(`node -e "import(...)"`),这与生产环境的真实
// 调用方式(scheduler 每轮起一个新进程)完全一致,也是本轮审核人工重放时验证
// 过的方式——测试只是把那套手工重放固化下来。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LIB_PATH = join(__dirname, '..', 'scripts', 'lib.mjs');
export const RUN_LOG_PATH = join(__dirname, '..', 'scripts', 'run-log.mjs');
export const LIB_URL = pathToFileURL(LIB_PATH).href;

/** 跑 git 命令,非 0 退出码直接抛错(fixture 搭建阶段失败就没必要继续)。 */
export function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败(exit ${r.status}): ${r.stderr || r.stdout}`);
  }
  return r;
}

/**
 * 新建一个已消解符号链接的临时目录(`realpathSync`)。macOS 的 `/var` 是到
 * `/private/var` 的符号链接,`mktemp -d` 默认落在 `/var/folders/...`——如果
 * 测试断言依赖"同一目录算出同一个 STATE_DIR",而两次拿到的路径字符串一个带
 * `/private` 前缀一个不带,会产生与被测逻辑无关的假失败。生产环境的真实
 * checkout(如 `/Users/praise/mivo-ops/mivo-canvas`)不在这类符号链接下,这里
 * realpath 只是为了让测试断言本身可靠,不代表"生产也需要这样处理"。
 */
export function freshTempDir(prefix = 'review-pr-test-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** 初始化一个最小 git 仓库;`gitignore` 给定时写入 `.gitignore` 并一并提交。 */
export function initRepo(dir, { gitignore } = {}) {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], { cwd: dir });
  git(['config', 'user.email', 'test@example.com'], { cwd: dir });
  git(['config', 'user.name', 'review-pr-test'], { cwd: dir });
  if (gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), gitignore);
  writeFileSync(join(dir, 'f.txt'), 'x');
  git(['add', '-A'], { cwd: dir });
  git(['commit', '-q', '-m', 'init'], { cwd: dir });
}

/**
 * 在一个真实子进程里 import `lib.mjs`,返回其 `STATE_DIR`(以及 stdout/stderr/
 * exit code 供更细的断言)。`env` 里显式传 `undefined` 表示"确保该变量不存在"
 * (用于覆盖 REVIEW_PR_STATE_DIR 等外部环境残留)。
 */
export function resolveStateDir(repoRoot, env = {}) {
  const childEnv = { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const code = `import(${JSON.stringify(LIB_URL)}).then(m=>process.stdout.write(m.STATE_DIR)).catch(e=>{console.error(e);process.exit(1);})`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
  return { stateDir: r.stdout.trim(), stderr: r.stderr, status: r.status };
}

/** 跑 run-log.mjs,stdin 传入 `bodyText`,返回解析后的 stdout JSON(以及原始 stderr/status)。 */
export function runRunLog(repoRoot, bodyText, env = {}) {
  const childEnv = { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const r = spawnSync(process.execPath, [RUN_LOG_PATH], {
    cwd: repoRoot, encoding: 'utf8', env: childEnv, input: bodyText,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch { /* 某些异常路径 stdout 可能不是 JSON,交给调用方按 status/stderr 断言 */ }
  return { json, stdout: r.stdout, stderr: r.stderr, status: r.status };
}
