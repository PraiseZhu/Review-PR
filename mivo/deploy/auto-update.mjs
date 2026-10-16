// 每天在运维时间把本仓 main 整组换上(Mini 上的 Cindy 定时任务调用,见 mivo/README.md「每天自动换版本」)。
//
// 用法(在 Mini 上):
//   node auto-update.mjs --check           只读判断:已是最新、CI 还没出结果 exit 2(定时任务跳过本轮);要换或要人看
//                                         exit 0;查不了 exit 1。检查完整成功时最后打印 CINDY_PRECHECK_OK。
//   node auto-update.mjs [--cindy-script]  要换就调 deploy-tuple.mjs --on mini --stop hold 整组换上(停点最多等 40 分钟);
//                                         --cindy-script 时 stdout 只有一行 cindy-script/1 收尾帧,过程写日志。
//   [--log-dir <目录>]                     日志与部署记录目录,默认 ~/Library/Logs/mivo-prereview/deploy。
// 执行模式退出码:0 换好了、已是最新或今天先不换;1 不能自动换(要人看),或没换成但线上仍是旧版本、前置照常;
// 2 换失败且前置保持停止(含新版本已上),要人工处理。--check 不调 deploy-tuple,不拿锁。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WF_PATH, toUpdateDecision, toCheckExit, toCompleteFrame, toDeployArgs, toAutoUpdateFinish } from './tuple-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'xindong/mivo-canvas-plugin';
const SKILL_REPO = 'PraiseZhu/Review-PR';
const SKILL_DIR = path.join(os.homedir(), 'mivo-prereview/skill');
const MAX_WAIT_MIN = 40;
const CHECK = process.argv.includes('--check');
const CINDY = process.argv.includes('--cindy-script');
const LOG_DIR = arg('log-dir', path.join(os.homedir(), 'Library/Logs/mivo-prereview/deploy'));

// helpers
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: String(r.stderr || r.error || '').trim() };
}
function must(r, what) {
  if (!r.ok) throw new Error(`${what} 失败(exit ${r.status}):${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
// 写完结果只设退出码、不调 process.exit:macOS 上 stdout 是管道时写入是异步的,提前退出会丢掉收尾帧。
function finish(code, text) {
  if (code === 0) process.stdout.write(CINDY ? toCompleteFrame(text) : `${text}\n`);
  else process.stderr.write(`${text}\n`);
  process.exitCode = code;
}

// 读线上 tuple 与 main,给出要不要换。
function inspect() {
  const current = must(run('gh', ['variable', 'get', 'MIVO_REVIEW_SKILL_SHA', '-R', REPO]), '读仓库变量 MIVO_REVIEW_SKILL_SHA');
  const checkout = must(run('git', ['-C', SKILL_DIR, 'rev-parse', 'HEAD']), `读 ${SKILL_DIR} 的检出`);
  const target = must(run('gh', ['api', `repos/${SKILL_REPO}/commits/main`, '--jq', '.sha']), '读 Review-PR main');
  if (checkout !== current || target === current) {
    return { current, target, decision: toUpdateDecision({ current, checkout, target, compare: null, checks: [] }) };
  }
  const compare = must(run('gh', ['api', `repos/${SKILL_REPO}/compare/${current}...${target}`, '--jq', '.status']), '比对线上提交和 main');
  const checks = JSON.parse(must(run('gh', ['api', `repos/${SKILL_REPO}/commits/${target}/check-runs?per_page=100`,
    '--jq', '[.check_runs[] | {name, status, conclusion}]']), '读 main 的 CI'));
  return { current, target, decision: toUpdateDecision({ current, checkout, target, compare, checks }) };
}
function mainWorkflowSha() {
  const raw = must(run('gh', ['api', `repos/${REPO}/contents/${WF_PATH}?ref=main`, '--jq', '.content']), `读 Mivo main 上的 ${WF_PATH}`);
  return createHash('sha256').update(Buffer.from(raw.replace(/\s/g, ''), 'base64')).digest('hex');
}
// 整组换上:deploy-tuple 的输出全写日志,stdout 留给收尾帧。
function deploy({ current, target }) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = path.join(LOG_DIR, `auto-update-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.log`);
  const args = toDeployArgs({ current, target, wf: mainWorkflowSha(), recordDir: LOG_DIR, maxWaitMin: MAX_WAIT_MIN });
  const fd = fs.openSync(log, 'a');
  const r = spawnSync(process.execPath, [path.join(HERE, 'deploy-tuple.mjs'), ...args], { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const tail = fs.readFileSync(log, 'utf8').trim().split('\n').slice(-3).join('\n');
  return { status: r.status ?? 1, log, tail: r.error ? `${r.error.message}\n${tail}` : tail };
}

function main() {
  let found;
  try {
    found = inspect();
  } catch (error) {
    return finish(1, `查不了线上或 main 的状态:${error.message}`);
  }
  const { current, target, decision } = found;
  if (CHECK) {
    process.stdout.write(`${decision.reason}\nCINDY_PRECHECK_OK\n`);
    process.exitCode = toCheckExit(decision);
    return;
  }
  if (decision.action === 'blocked') return finish(1, `今天不自动换:${decision.reason}`);
  if (decision.action !== 'update') return finish(0, `今天不换:${decision.reason}`);
  const result = deploy({ current, target });
  const done = toAutoUpdateFinish(result.status ?? 1, { reason: decision.reason, current, log: result.log, tail: result.tail });
  return finish(done.code, done.text);
}

main();
