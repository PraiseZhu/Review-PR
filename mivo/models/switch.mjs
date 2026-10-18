#!/usr/bin/env node
// switch.mjs — 在 Mini 上切换服务器审查机某个角色(主审 / 备用模型 / 核对员)的模型和思考档位(维护者 2026-10-18)。
// 由 Mini 上三个 Cindy 自动化「审查机主审模型」「审查机备用模型」「审查机核对员模型」调用:自动化读出自己选的模型和档位,
// 原样传进来。流程:
//   1. 把 Cindy 的模型 id 映射成网关 id(openai/...),校验档位;同一角色同时只跑一个(本机锁);
//   2. 读仓库变量:已经是这个配置就不动;主审被测试用的单档覆盖变量压住时拒绝;
//   3. 派发 Mivo 的 review-model-check.yml(服务器上用实际审查 key 验证模型、档位、工具调用、结构化输出),等它跑完、取结果;
//   4. 验证通过才写这个角色的仓库变量 MIVO_REVIEW_ROLE_<角色>,写完读回核对;读回不一致就恢复原值。验证没通过,原配置不动。
//   5. 每次写入记一行历史,`--rollback` 恢复这个角色上一次切换之前的值。
// 只用本机 gh(PraiseZhu 登录)的 REST 调用。新配置从下一次派发的服务器审查开始生效,正在跑的审查不受影响。
//
//   node mivo/models/switch.mjs --role primary|fallback|verifier --model <Cindy 模型 id> --effort <档位> [--provider <来源>]
//   node mivo/models/switch.mjs --role <角色> --rollback
//   node mivo/models/switch.mjs --status
// 自动化里的 agent 跑终端命令有单次超时,而服务器验证可能要几十分钟,所以自动化用后台方式:
//   node mivo/models/switch.mjs --role ... --model ... --effort ... --detach   立刻返回 job id,切换在后台跑
//   node mivo/models/switch.mjs --wait <job id> [--max-wait-sec 240]           最多等这么久;没跑完退出码 3,再运行同一条
// 通用参数:[--repo xindong/mivo-canvas-plugin] [--json]。
// 退出码:0 已切换或本来就是;1 没切换(原配置不动);2 写入异常或后台任务意外结束,要人工核对;3 还在进行(只有 --wait)。
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync, writeFileSync, mkdtempSync, openSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { run, readJson, nowIso, SKILL_ROOT, REPO_RE } from '../lib/common.mjs';
import { ROLE_ENV, parseRoleModel } from '../lib/models.mjs';
import { loadFeatures } from '../lib/verify.mjs';
import { ROLE_TEXT, CHECK_WORKFLOW, toServerModel, toEffort, toRole, toRoleValue, toEffectiveRoles, toSwitchBlocker, toSwitchWarnings, toCheckVerdict } from '../lib/model-switch.mjs';

const DEFAULT_REPO = 'xindong/mivo-canvas-plugin';
const FIND_RUN_MS = 3 * 60_000;
const WAIT_RUN_MS = 35 * 60_000;
const LOCK_STALE_MS = 60 * 60_000;
// 轮询间隔;测试用 MIVO_MODEL_SWITCH_POLL_MS 调小。
const POLL_MS = Number(process.env.MIVO_MODEL_SWITCH_POLL_MS) || 10_000;

const JOB_ID_RE = /^job-[a-z]+-[0-9a-f]{12}$/;
const DEFAULT_WAIT_SEC = 240;

function parseArgs(argv) {
  const opts = { repo: DEFAULT_REPO, json: false, rollback: false, status: false, detach: false, maxWaitSec: DEFAULT_WAIT_SEC };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const v = argv[i + 1]; if (v === undefined) throw new Error(`${arg} 缺少参数值`); i += 1; return v; };
    if (arg === '--role') opts.role = value();
    else if (arg === '--model') opts.model = value();
    else if (arg === '--effort') opts.effort = value();
    else if (arg === '--provider') opts.provider = value();
    else if (arg === '--repo') opts.repo = value();
    else if (arg === '--json') opts.json = true;
    else if (arg === '--rollback') opts.rollback = true;
    else if (arg === '--status') opts.status = true;
    else if (arg === '--detach') opts.detach = true;
    else if (arg === '--wait') opts.wait = value();
    else if (arg === '--job') opts.job = value();
    else if (arg === '--max-wait-sec') opts.maxWaitSec = Number(value());
    else throw new Error(`不认识的参数:${arg}`);
  }
  for (const id of [opts.wait, opts.job].filter((v) => v !== undefined)) if (!JOB_ID_RE.test(id)) throw new Error(`job id 不合法:${String(id).slice(0, 40)}`);
  if (!Number.isInteger(opts.maxWaitSec) || opts.maxWaitSec < 1 || opts.maxWaitSec > 3600) throw new Error('--max-wait-sec 要在 1–3600 之间');
  if (!REPO_RE.test(opts.repo)) throw new Error(`--repo 不合法:${opts.repo}`);
  return opts;
}

// ── gh 与本机状态 ─────────────────────────────────────────────────────────
const stateDir = () => process.env.MIVO_MODEL_SWITCH_STATE || join(homedir(), 'mivo-prereview', 'state', 'model-switch');
const gh = (args, options = {}) => run('gh', args, { allowFail: true, timeoutMs: 120_000, ...options });
const ghText = (r) => String(r.stderr || r.error || r.stdout || '').trim().split('\n').slice(-2).join(' | ').slice(0, 300);

function readVariables(repo) {
  const r = gh(['api', `repos/${repo}/actions/variables?per_page=100`, '--paginate', '--jq', '.variables[] | [.name, .value] | @json']);
  if (!r.ok) throw new Error(`读不到 ${repo} 的仓库变量:${ghText(r)}`);
  return Object.fromEntries(r.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

function setVariable(repo, name, value) {
  return value === null
    ? gh(['variable', 'delete', name, '-R', repo])
    : gh(['variable', 'set', name, '-R', repo, '--body', value]);
}

function verifierDefault() {
  return loadFeatures(join(SKILL_ROOT, 'mivo', 'config', 'review-features.json')).verify;
}

function takeLock(role) {
  const dir = join(stateDir(), `lock-${role}`);
  mkdirSync(stateDir(), { recursive: true });
  try { mkdirSync(dir); } catch {
    const held = readJson(join(dir, 'owner.json'), null);
    const alive = held?.pid ? (() => { try { process.kill(held.pid, 0); return true; } catch { return false; } })() : false;
    if (alive && Date.now() - Date.parse(held.at) < LOCK_STALE_MS) throw new Error(`${ROLE_TEXT[role]}切换正在进行(pid ${held.pid},${held.at} 开始),等它结束再运行`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  }
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, at: nowIso() }));
  return () => rmSync(dir, { recursive: true, force: true });
}

const historyFile = () => join(stateDir(), 'history.jsonl');
function appendHistory(entry) {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(historyFile(), `${JSON.stringify(entry)}\n`);
}
function readHistory() {
  if (!existsSync(historyFile())) return [];
  return readFileSync(historyFile(), 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

// 写一个角色变量,读回核对;不一致就恢复原值。返回 { ok, exitCode, reason }。
// 读回失败(网络、额度)时结果未知:不能报「没切换」,按要人工核对处理。
function writeRole(repo, name, value, previous) {
  const readBack = () => { try { return { ok: true, value: readVariables(repo)[name] ?? null }; } catch { return { ok: false, value: null }; } };
  const w = setVariable(repo, name, value);
  const back = readBack();
  if (!back.ok) return { ok: false, exitCode: 2, reason: `写入后读不回 ${name},结果未知:请到仓库变量里人工核对` };
  if (w.ok && back.value === value) return { ok: true, exitCode: 0, reason: '已写入并读回核对' };
  const restore = setVariable(repo, name, previous);
  const again = readBack();
  const restored = again.ok && again.value === previous;
  return restore.ok && restored
    ? { ok: false, exitCode: 1, reason: `写入没有生效(${w.ok ? '读回不一致' : ghText(w)}),已恢复原值` }
    : { ok: false, exitCode: 2, reason: `写入没有生效,恢复原值也失败:请到仓库变量里人工核对 ${name}` };
}

// ── 服务器验证 ────────────────────────────────────────────────────────────
async function serverCheck({ repo, role, model, effort, requestId, log }) {
  const wf = gh(['api', `repos/${repo}/actions/workflows/${CHECK_WORKFLOW}`, '--jq', '.state']);
  if (!wf.ok || wf.stdout.trim() !== 'active') return { check: null, runId: null, error: `服务器验证入口 ${CHECK_WORKFLOW} 还没在 ${repo} 的 main 上线(或被停用)` };
  const dispatched = gh(['workflow', 'run', CHECK_WORKFLOW, '-R', repo, '--ref', 'main',
    '-f', `role=${role}`, '-f', `model=${model}`, '-f', `effort=${effort}`, '-f', `request_id=${requestId}`]);
  if (!dispatched.ok) return { check: null, runId: null, error: `派发服务器验证失败:${ghText(dispatched)}` };
  log(`已派发服务器验证(request ${requestId}),等待 runner 接手…`);
  let runId = null;
  for (const deadline = Date.now() + FIND_RUN_MS; !runId && Date.now() < deadline;) {
    await sleep(POLL_MS);
    const list = gh(['run', 'list', '-R', repo, '--workflow', CHECK_WORKFLOW, '--event', 'workflow_dispatch', '--limit', '30',
      '--json', 'databaseId,displayTitle']);
    if (list.ok) runId = (JSON.parse(list.stdout || '[]').find((r) => String(r.displayTitle).includes(requestId)) ?? {}).databaseId ?? null;
  }
  if (!runId) return { check: null, runId: null, error: `派发后 ${FIND_RUN_MS / 60_000} 分钟找不到这次服务器验证的运行` };
  log(`服务器验证运行中:https://github.com/${repo}/actions/runs/${runId}`);
  let info = null;
  for (const deadline = Date.now() + WAIT_RUN_MS; Date.now() < deadline;) {
    const view = gh(['run', 'view', String(runId), '-R', repo, '--json', 'status,conclusion']);
    if (view.ok) { info = JSON.parse(view.stdout); if (info.status === 'completed') break; }
    await sleep(POLL_MS);
  }
  if (info?.status !== 'completed') return { check: null, runId, error: `服务器验证 ${WAIT_RUN_MS / 60_000} 分钟没有跑完` };
  const dir = mkdtempSync(join(tmpdir(), 'mivo-model-check-'));
  try {
    const dl = gh(['run', 'download', String(runId), '-R', repo, '-n', `review-model-check-${requestId}`, '-D', dir]);
    const check = dl.ok ? readJson(join(dir, 'check.json'), null) : null;
    return { check, runId, error: check ? null : `服务器验证没有产出结果(run 结论 ${info.conclusion})` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── 三个动作 ──────────────────────────────────────────────────────────────
async function doSwitch(opts, log) {
  const role = toRole(opts.role);
  const model = toServerModel(opts.model);
  const effort = toEffort(opts.effort);
  const name = ROLE_ENV[role];
  const text = `${ROLE_TEXT[role]} → ${model} / ${effort}`;
  const release = takeLock(role);
  try {
    const variables = readVariables(opts.repo);
    const previous = variables[name] ?? null;
    const current = parseRoleModel(previous).value;
    if (current && current.model === model && current.effort === effort) return { exitCode: 0, changed: false, summary: `${ROLE_TEXT[role]}已经是 ${model} / ${effort},没有改动` };
    const blocker = toSwitchBlocker({ role, variables });
    if (blocker) return { exitCode: 1, changed: false, summary: `没有切换(${text}):${blocker}` };
    const warnings = toSwitchWarnings({ role, target: { model, effort }, effective: toEffectiveRoles(variables, verifierDefault()) });
    const requestId = `msw-${role}-${randomUUID().slice(0, 13)}`;
    const { check, runId, error } = await serverCheck({ repo: opts.repo, role, model, effort, requestId, log });
    if (error) return { exitCode: 1, changed: false, runId, summary: `没有切换(${text}):${error},原配置不动`, warnings };
    const verdict = toCheckVerdict(check, { requestId, role, model, effort });
    const allWarnings = [...warnings, ...verdict.warnings];
    if (!verdict.ok) return { exitCode: 1, changed: false, runId, summary: `没有切换(${text}):服务器验证没通过——${verdict.reason},原配置不动`, warnings: allWarnings, available: check?.keys?.primary?.models?.available };
    const value = toRoleValue({ model, effort, cindyModel: opts.model, provider: opts.provider, checkRunId: runId, setAt: nowIso() });
    const written = writeRole(opts.repo, name, value, previous);
    if (written.ok) appendHistory({ at: nowIso(), kind: 'switch', role, name, from: previous, to: value, checkRunId: runId });
    return written.ok
      ? { exitCode: 0, changed: true, runId, summary: `已切换 ${text}(${verdict.reason});下一次派发的服务器审查开始生效`, warnings: allWarnings }
      : { exitCode: written.exitCode, changed: false, runId, summary: `没有切换(${text}):${written.reason}`, warnings: allWarnings };
  } finally { release(); }
}

function doRollback(opts) {
  const role = toRole(opts.role);
  const name = ROLE_ENV[role];
  const release = takeLock(role);
  try {
    const current = readVariables(opts.repo)[name] ?? null;
    const last = readHistory().filter((e) => e.role === role && e.kind === 'switch' && e.to === current).at(-1);
    if (!last) return { exitCode: 1, changed: false, summary: `${ROLE_TEXT[role]}的当前值不是本机切换写的,找不到可以恢复的上一个值;没有改动` };
    const written = writeRole(opts.repo, name, last.from, current);
    if (written.ok) appendHistory({ at: nowIso(), kind: 'rollback', role, name, from: current, to: last.from });
    const target = parseRoleModel(last.from).value;
    return written.ok
      ? { exitCode: 0, changed: true, summary: `已回退${ROLE_TEXT[role]}到 ${target ? `${target.model} / ${target.effort}` : '默认值(删除变量)'}` }
      : { exitCode: written.exitCode, changed: false, summary: `回退没有完成:${written.reason}` };
  } finally { release(); }
}

function doStatus(opts) {
  const variables = readVariables(opts.repo);
  const effective = toEffectiveRoles(variables, verifierDefault());
  const lines = Object.entries(effective).map(([role, value]) => `${ROLE_TEXT[role]}:${value ? `${value.model} / ${value.effort}` : '未配置'}${variables[ROLE_ENV[role]] ? '' : '(默认值)'}`);
  const keyStatus = variables.MIVO_REVIEW_KEY_STATUS ? (() => { try { return JSON.parse(variables.MIVO_REVIEW_KEY_STATUS); } catch { return null; } })() : null;
  if (keyStatus) lines.push(`网关 key:${keyStatus.status}(${keyStatus.reason},${keyStatus.since})`);
  const until = Date.parse(variables.MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL ?? '');
  if (until > Date.now()) lines.push(`冷却期:${new Date(until).toISOString()} 之前新派的审查直接用备用 key`);
  return { exitCode: 0, changed: false, summary: lines.join('\n'), effective };
}

// ── 后台方式(给自动化用)────────────────────────────────────────────────────
const jobsDir = () => join(stateDir(), 'jobs');
const jobFile = (id, ext) => join(jobsDir(), `${id}.${ext}`);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 先把参数校验完(错了立刻报,不开后台),再以 --job 拉起自己,输出写进 jobs/<id>.log,结果写 jobs/<id>.json。
function doDetach(opts) {
  const role = toRole(opts.role);
  toServerModel(opts.model);
  toEffort(opts.effort);
  mkdirSync(jobsDir(), { recursive: true });
  const id = `job-${role}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const out = openSync(jobFile(id, 'log'), 'a');
  const args = ['--role', role, '--model', opts.model, '--effort', opts.effort, ...(opts.provider ? ['--provider', opts.provider] : []), '--repo', opts.repo, '--job', id];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args],
    { detached: true, stdio: ['ignore', out, out], env: process.env });
  closeSync(out);
  writeFileSync(jobFile(id, 'started.json'), JSON.stringify({ pid: child.pid, at: nowIso(), role }));
  child.unref();
  return { exitCode: 0, changed: false, jobId: id, summary: `已在后台开始${ROLE_TEXT[role]}切换(job ${id})。接着运行:node ${fileURLToPath(import.meta.url)} --wait ${id}` };
}

async function doWait(opts) {
  const deadline = Date.now() + opts.maxWaitSec * 1000;
  for (;;) {
    const result = readJson(jobFile(opts.wait, 'json'), null);
    if (result) return result;
    const started = readJson(jobFile(opts.wait, 'started.json'), null);
    if (!started) return { exitCode: 1, changed: false, summary: `找不到后台任务 ${opts.wait}` };
    if (!pidAlive(started.pid)) {
      await sleep(1000);
      const late = readJson(jobFile(opts.wait, 'json'), null);
      if (late) return late;
      return { exitCode: 2, changed: false, summary: `后台任务 ${opts.wait} 意外结束,没有留下结果;请运行 --status 核对当前配置,日志在 ${jobFile(opts.wait, 'log')}` };
    }
    if (Date.now() >= deadline) {
      const last = existsSync(jobFile(opts.wait, 'log')) ? readFileSync(jobFile(opts.wait, 'log'), 'utf8').trim().split('\n').filter(Boolean).at(-1) : '';
      return { exitCode: 3, changed: false, jobId: opts.wait, summary: `还在进行(job ${opts.wait}${last ? `,最近一步:${last.slice(0, 200)}` : ''}),请再运行同一条 --wait 命令` };
    }
    await sleep(Math.min(POLL_MS, 5000));
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (line) => { if (!opts.json) console.error(line); };
  let result;
  try {
    if (opts.wait) result = await doWait(opts);
    else if (opts.status) result = doStatus(opts);
    else if (opts.rollback) result = doRollback(opts);
    else if (opts.detach) result = doDetach(opts);
    else result = await doSwitch(opts, opts.job ? (line) => console.error(line) : log);
  } catch (error) {
    result = { exitCode: 1, changed: false, summary: `没有切换:${String(error?.message ?? error).slice(0, 300)}` };
  }
  if (opts.job) {
    const tmp = `${jobFile(opts.job, 'json')}.tmp`;
    writeFileSync(tmp, JSON.stringify(result));
    renameSync(tmp, jobFile(opts.job, 'json'));
  }
  if (opts.json) console.log(JSON.stringify(result));
  else {
    console.log(result.summary);
    for (const w of result.warnings ?? []) console.log(`告警:${w}`);
    if (result.available?.length) console.log(`网关上可用的 openai/ 模型:${result.available.join('、')}`);
  }
  process.exit(result.exitCode);
}

main();
