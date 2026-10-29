#!/usr/bin/env node
// round.mjs — Mini 上的前置审查(launchd 每 3 分钟拉起一次;上一个进程还在跑时不会再起第二个)。
// 流程照搬 review-pr-auto 的主 session:pre-check → prepare → plan → 滚动队列 → finalize。
// 不同点(D1):每个 PR 的「子 agent」拆成两段——判门在本机用 Cindy 脚本做完(不调模型),
// 需要代码审查时派发服务器上的 review-pr.yml,服务器审完把结果包回传,这里写进本轮目录。
// 滚动接单:一个进程可以同时推进多轮。已有轮次在等服务器审查时,每 3 分钟检查一次新候选,有空槽就另开一轮;
// 全进程在审(已派发、还没收回结果的服务器 run,以及还不知道有没有派出的派发)不超过 maxParallel。
// 所有轮次结束时进程退出,launchd 再拉起;进入 06:00 维护窗口、检出新 SHA、维护者名单变化、部署暂停时不再开新轮,
// 运行满 24 小时是保险上限。不再开新轮之后,在审只剩查不清的派发的轮次按停机握手停下,进程照样退出。规则见 lib/admission.mjs。
//
//   node mivo/prereview/round.mjs --config <配置 JSON>
// 配置字段见 mivo/README.md。退出码:0=正常(含没有候选、部署停机握手),1=本轮异常或续锁失败。
import { existsSync, mkdirSync, readFileSync, copyFileSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { checkNameFor, loadGateBases } from '../../review-pr/scripts/gate-bases.mjs'; // [MIVO-PATCH gate-bases]
import { SKILL_ROOT, SCRIPTS, MODES, run, runScript, runScriptAsync, readJson, writeJson, writeText, nowIso } from '../lib/common.mjs';
import { decideGate, buildSignoffPayload, buildGatePushback, toProtectedDispatch, withProtectedAuthorNotice, toSignoffReleaseArgs, toAutoReleaseNotice, toAutoReleaseCloseComment, dropStaleProtectedNotice, withProtectedGateRetry, toStaleMergeReadyReason, STATUS_LABELS, toClosedStatusLabelRemovals } from '../lib/gates.mjs';
import { fetchCodeScanFacts, toCodeScanGate, toCodeScanWakeState, toCodeScanWake, toCodeScanSweepSet, toCodeScanRecord } from '../lib/code-scan.mjs';
import { inBusinessWindow } from '../lib/health.mjs';
import { loadHandoffMode, readHandoffFacts } from '../lib/handoff.mjs';
import { toKeyStatus, toKeyStatusReason } from '../lib/key-status.mjs';
import { previousFromResult } from '../lib/scope.mjs';
import { toRetryDecision, toFailureRecord, toDispatchAttempt, toCompletedRunsRecord } from '../lib/retry.mjs';
import { ADMIT_INTERVAL_MS, MAX_EXEC_MINUTES, MAX_QUEUE_MINUTES, toAdmissionDecision, toFreeSlots, toBusyPrs, canReleaseDeferredGate, toHeldWake, toOutcomeWake, toCiWake, toRunTiming, toDispatchFailure, findDispatchRun, toGateSkip, isGateSkipCandidate } from '../lib/admission.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MERGE_READY_LABEL = 'review:merge-ready';
const QUOTA_PAUSE_MS = 60 * 60_000;
const HEALTH_PAUSE_MS = 30 * 60_000;
// 派发后从意图时间起 60 分钟还找不到 run:记 dispatch-unresolved,并停写心跳,让 Mini 之外的看门狗发 Slack 等人核对;
// 占槽和未决记录都保留,不重派。停止接单之后在审的只剩这种派发时,这一轮按停机握手停下,下次启动接着找。
const DISPATCH_UNRESOLVED_MS = 60 * 60_000;
// 派发后 5 分钟内还没找到 run 的,每次轮询都查一次(所有未绑定的派发共用一组分页调用),之后回到 3 分钟一次。
const FRESH_DISPATCH_MS = 5 * 60_000;
const HEARTBEAT_EVERY_MS = 15 * 60_000;
const HEARTBEAT_VARIABLE = 'MIVO_PREREVIEW_HEARTBEAT';
// 主 key / 备用 key(维护者 2026-10-18,服务器规则见 server/keys.mjs):主 key 审到一半才报 key 错误时,之后 60 分钟新派的审查直接用备用 key;
// 主 key 状态(primary / backup / down)变化时写给看门狗发 Slack。两个变量都只由生产实例写,写失败只记日志,下次再写。
const PREFER_BACKUP_VARIABLE = 'MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL';
const PREFER_BACKUP_MS = 60 * 60_000;
const KEY_STATUS_VARIABLE = 'MIVO_REVIEW_KEY_STATUS';
const PRIMARY_SECRET = 'LITELLM_CREDENTIALS_JSON';
// 代码扫描状态对照:每隔 10 分钟对开放 PR 里服务器记过三态的各读一次 head 的 check run(REST),最多看 30 个。
const CODE_SCAN_SWEEP_EVERY_MS = 10 * 60_000;
const CLOSED_LABEL_SWEEP_EVERY_MS = 10 * 60_000;
const CODE_SCAN_MAX_WATCHED = 30;
// 仓库副本每周手动 gc 一次(后台 gc 已关,见 setupEnv)。
const REPO_GC_EVERY_MS = 7 * 24 * 60 * 60_000;

// ── 配置与环境 ─────────────────────────────────────────────────────────────
function loadConfig() {
  const i = process.argv.indexOf('--config');
  if (i < 0 || !process.argv[i + 1]) throw new Error('用法: round.mjs --config <配置 JSON>');
  const config = readJson(resolve(process.argv[i + 1]));
  if (!MODES.includes(config.mode)) throw new Error(`mode 不合法:${config.mode}`);
  for (const key of ['repoRoot', 'stateDir', 'workflowRepo', 'workflowRef', 'logDir', 'targetRepo']) {
    if (!config[key]) throw new Error(`配置缺少 ${key}`);
  }
  config.maxParallel = Math.max(1, Math.min(10, Number(config.maxParallel) || 3));
  config.dailyCap = Number(config.dailyCap) || 30;
  config.pollSeconds = Number(config.pollSeconds) || 30;
  // 判门并行数(#141):每次判门要跑 context.mjs 等脚本约 20–30 秒,串行时每小时最多派一百个左右。
  if (config.gateParallel === undefined) config.gateParallel = 8;
  if (!Number.isInteger(config.gateParallel) || config.gateParallel < 1 || config.gateParallel > 16) {
    throw new Error(`gateParallel 须是 1–16 的整数:${JSON.stringify(config.gateParallel)}`);
  }
  if (config.viewerLogin !== undefined
      && (typeof config.viewerLogin !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(config.viewerLogin))) {
    throw new Error(`viewerLogin 不是合法的 GitHub 登录名:${JSON.stringify(config.viewerLogin)}`);
  }
  // [MIVO-PATCH branch-protection-cache] 分支保护读取的缓存时长(毫秒)。分支保护要 Administration 读,App 令牌读不了,
  // 每轮重读都记在 PraiseZhu 额度上;规则很少变,配 600000(10 分钟)即可。不配=每次都读。
  if (config.branchProtectionCacheMs !== undefined
      && (!Number.isInteger(config.branchProtectionCacheMs) || config.branchProtectionCacheMs < 0 || config.branchProtectionCacheMs > 3_600_000)) {
    throw new Error(`branchProtectionCacheMs 须是 0–3600000 的整数毫秒:${JSON.stringify(config.branchProtectionCacheMs)}`);
  }
  return config;
}

let CONFIG;
let ENV;
// 滚动接单的进程级状态。ROUNDS[i]:{ runId, planFile, plan, inflight: Map, queued, finished, completed, released }
// finished = 这一轮的 drive 已结束(成功、失败或停机握手);completed = 已写 completed.json(正常关闭或放弃);
// released = 换 HEAD 或已收尾的暂缓判门任务提前释放的 PR(轮次目录的 mivo-released.json)。
// inflight 里的条目 runId 为 null 时是「还不知道有没有派出」的派发:照样占槽,按 dispatch_id 找回,不重派。
const STARTED_AT = Date.now();
const ROUNDS = [];
const ADMIT_ERRORS = [];
let ADMISSION_CLOSED = null; // 不再接新轮的原因
let SKILL_HEAD = null;
// 同时恢复几轮时,要等每一轮都登记完已派发的 run,才放任何一轮领取新任务。
// 否则先启动的那一轮只看见自己的在途数,会把别的轮次已占的槽位当成空槽派出去。
let releaseResumeBarrier;
const RESUME_BARRIER = new Promise((resolve) => { releaseResumeBarrier = resolve; });
// 某一轮失败时,如果手里还有已派发的 run,这些 run 没人回收,占的槽位永远不会释放。
// 这时其它轮次停下、不收尾,整个进程退出;launchd 重启后,未完成的轮次一起恢复(已派发的 run 从 queue.json 重新登记)。
let ABORTED = null;
class RoundAborted extends Error {}
// 停机握手:部署暂停时这一轮已没有在审 run;或停止接单之后,在审的只剩还不知道有没有派出的派发。
// 停下等下次启动恢复(不收尾,还没领取的任务和派发意图都留在轮次目录里)。
class RoundQuiesced extends Error {}
// 续锁返回不是 refreshed:true:锁已不属于本进程。之后不领取、不派发、不取消、不写评论和标签,不写心跳,
// 也不释放锁(那是接管者的),非 0 退出让巡检报出来。
let FENCED = false;
// 看到部署暂停文件的时间:不开新轮、不领取、不派发;在审 run 归零(只剩未决派发也算,意图留给新版本接着找)后完成停机握手。
let QUIESCING = null;
// 正在判门的任务数(全进程):判门改成异步后最多 CONFIG.gateParallel 路并行;判门中的任务也算占槽(roundLoads)。
let GATING = 0;
// PR 当前 head 的缓存(作者推新提交时取消旧审查用):最多 3 分钟查一次全部开着的 PR。
const HEADS = { atMs: 0, map: null };
// 同一件事只记一次日志(未决派发、排队过慢、无效的人工解除记录、归属已转走)。
const LOGGED_ONCE = new Set();

function setupEnv(config) {
  const env = { ...process.env, REVIEW_PR_REPO_ROOT: config.repoRoot, REVIEW_PR_STATE_DIR: config.stateDir };
  if (config.rulesFile) env.REVIEW_PR_RULES_FILE = config.rulesFile;
  else delete env.REVIEW_PR_RULES_FILE;
  // Mini 的 gh 经 GitHub App 分流:查询里有 viewer 或 headRepository 的读请求会整条交给 PraiseZhu。
  // viewerLogin(审查账号,即 gh 登录的账号)让 context 不再查 viewer;open PR 快照不读 fork 名(MIVO-PATCH app-readable-snapshot)。
  if (config.viewerLogin) env.REVIEW_PR_VIEWER_LOGIN = String(config.viewerLogin);
  else delete env.REVIEW_PR_VIEWER_LOGIN;
  env.REVIEW_PR_SNAPSHOT_FORK_NAME = '0';
  // 不从 launchd 环境继承:只认配置文件里的值。
  if (config.branchProtectionCacheMs > 0) env.REVIEW_PR_BRANCH_PROTECTION_CACHE_MS = String(config.branchProtectionCacheMs);
  else delete env.REVIEW_PR_BRANCH_PROTECTION_CACHE_MS;
  if (config.mode === 'dry-run') {
    // dry-run:Cindy 脚本里的任何 GitHub 写入都被垫片拦下;只放行派发 dry-run 服务器审查。
    const realGh = run('/bin/sh', ['-c', 'command -v gh']).stdout.trim();
    env.MIVO_REAL_GH = realGh;
    env.MIVO_DRYRUN_ALLOW_DISPATCH = '1';
    env.MIVO_DRYRUN_LOG = join(config.logDir, 'dry-run-blocked.log');
    env.PATH = `${join(HERE, 'gh-dryrun')}:${env.PATH}`;
  }
  // 前置的仓库副本关掉后台 gc、维护任务和 commit-graph:两次整轮失败都出在 fetch 刚结束、建工作目录的时刻,
  // 同一秒有新包和新 commit-graph 写出,最可能是后台 gc 抢了副本(推测,未证实)。手动 gc 每周一次,在维护窗口里做(weeklyRepoGc)。
  const gitConfig = [['gc.auto', '0'], ['maintenance.auto', 'false'], ['core.commitGraph', 'false']];
  const offset = Number(env.GIT_CONFIG_COUNT) || 0;
  gitConfig.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${offset + i}`] = key;
    env[`GIT_CONFIG_VALUE_${offset + i}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(offset + gitConfig.length);
  return env;
}

function log(event, detail = {}) {
  const at = nowIso();
  const line = JSON.stringify({ at, event, ...detail });
  // 进程可能跨过 UTC 零点:每条日志按写入时的日期选文件。
  try { appendFileSync(join(CONFIG.logDir, `round-${at.slice(0, 10)}.jsonl`), `${line}\n`); } catch { /* 日志失败不影响本轮 */ }
  if (process.env.MIVO_PREREVIEW_VERBOSE) console.log(line);
}
function logOnce(key, event, detail = {}) {
  if (LOGGED_ONCE.has(key)) return;
  LOGGED_ONCE.add(key);
  log(event, detail);
}

const script = (name, args, options = {}) => runScript(name, args, { cwd: CONFIG.repoRoot, env: ENV, ...options });
// 判门里的脚本用异步版:子进程跑着时事件循环照常走,别的判门、进度轮询不被挡住。
const scriptAsync = (name, args, options = {}) => runScriptAsync(name, args, { cwd: CONFIG.repoRoot, env: ENV, ...options });
// 门禁动作脚本(发提醒、改标签、开关 issue、重跑 CI)在进程内排队、一次只跑一个(#141 单审 P2):有的脚本读改写共享状态,
// 例如 notify-author-resolve.mjs 的 reminded.json 去重表,并发会互相覆盖。判门里最慢的 context.mjs 照常并行。
// 排在后面的动作开跑前再查一次锁(单审 P1):排队期间可能已经丢锁,而 approve-workflows、close-product-issue 这类脚本自己不核对锁。
let GATE_ACTION_CHAIN = Promise.resolve();
// precheck:开跑前的额外核对,返回一个结果就不跑脚本、直接用它(例如 head 已变不批准 workflow)。
const gateActionScript = (name, args, options = {}, precheck = null) => {
  const next = GATE_ACTION_CHAIN.then(() => {
    assertNotFenced();
    const blocked = precheck?.();
    if (blocked) return blocked;
    return scriptAsync(name, args, options);
  });
  GATE_ACTION_CHAIN = next.catch(() => {});
  return next;
};
const ghRead = (args, options = {}) => run('gh', args, { cwd: CONFIG.repoRoot, env: ENV, ...options });
const stateFile = (name) => join(CONFIG.stateDir, 'mivo', name);

// ── 本机记录:每个 PR 的服务器审查记录、每日派发账本、额度暂停、部署暂停 ─────
function loadStore() { return readJson(stateFile('reviews.json'), { version: 1, prs: {} }); }
function saveStore(store) { writeJson(stateFile('reviews.json'), store); }
function dispatchesToday() {
  const ledger = readJson(stateFile('dispatch-ledger.json'), []);
  const today = new Date().toISOString().slice(0, 10);
  return ledger.filter((entry) => String(entry.at).slice(0, 10) === today).length;
}
function recordDispatch(entry) {
  const ledger = readJson(stateFile('dispatch-ledger.json'), []);
  const cutoff = Date.now() - 3 * 24 * 60 * 60_000;
  writeJson(stateFile('dispatch-ledger.json'), [...ledger.filter((e) => Date.parse(e.at) > cutoff), entry]);
}
function pausedUntil() {
  const pause = readJson(stateFile('pause.json'), null);
  return pause && Date.parse(pause.until) > Date.now() ? pause : null;
}
// 部署暂停(方案 Step 5 用):文件在就算,读不懂也算(宁可不开新轮)。
function deployHold() {
  const file = stateFile('deploy-hold.json');
  return existsSync(file) ? readJson(file, {}) : null;
}

// 心跳(Mini 之外的看门狗读):只有生产实例(instance=mivo 且 live)写,15 分钟内最多一次,隔离后不再写。
// 有超过 60 分钟还查不清的派发时不写(heartbeatPaused),让看门狗报到 Slack。写失败只记日志,不影响审查。
function writeHeartbeat() {
  if (FENCED || CONFIG.instance !== 'mivo' || CONFIG.mode !== 'live') return;
  if (heartbeatPaused()) return;
  const last = Date.parse(readJson(stateFile('heartbeat.json'), {})?.at ?? '');
  if (Number.isFinite(last) && Date.now() - last < HEARTBEAT_EVERY_MS) return;
  const at = nowIso();
  const r = run('gh', ['variable', 'set', HEARTBEAT_VARIABLE, '-R', CONFIG.workflowRepo, '--body', at],
    { cwd: CONFIG.repoRoot, env: ENV, allowFail: true, timeoutMs: 60_000 });
  if (!r.ok) { log('heartbeat-error', { error: String(r.stderr || r.error || '').trim().slice(0, 200) }); return; }
  writeJson(stateFile('heartbeat.json'), { at });
  resetPreferBackupIfRotated();
}

// ── 主 key / 备用 key 的冷却期与状态 ─────────────────────────────────────
const isKeyWriter = () => !FENCED && CONFIG.instance === 'mivo' && CONFIG.mode === 'live';
function setRepoVariable(name, body, event) {
  const r = run('gh', ['variable', 'set', name, '-R', CONFIG.workflowRepo, '--body', body],
    { cwd: CONFIG.repoRoot, env: ENV, allowFail: true, timeoutMs: 60_000 });
  if (!r.ok) log(`${event}-error`, { error: String(r.stderr || r.error || '').trim().slice(0, 200) });
  return r.ok;
}

// 服务器结果收回后调用:审到一半主 key 报 key 错误 → 写冷却期;key 状态变了 → 写状态变量(本机记一份,没变不重写)。
function noteKeyState(server, { pr, runId }) {
  const credential = server.mivo?.codex?.credential;
  if (!credential || !isKeyWriter()) return;
  const attempts = server.mivo?.codex?.attempts ?? [];
  if (credential.primaryFailedMidRun && credential.backupConfigured) {
    const until = new Date(Date.now() + PREFER_BACKUP_MS).toISOString();
    if (setRepoVariable(PREFER_BACKUP_VARIABLE, until, 'key-prefer-backup')) {
      writeJson(stateFile('key-prefer-backup.json'), { until, setAt: nowIso(), pr, runId });
      log('key-prefer-backup', { pr, runId, until });
    }
  }
  const status = toKeyStatus(credential, attempts);
  if (!status || readJson(stateFile('key-status.json'), null)?.status === status) return;
  const record = { status, since: nowIso(), reason: toKeyStatusReason(status, credential, attempts), pr, runId };
  if (setRepoVariable(KEY_STATUS_VARIABLE, JSON.stringify(record), 'key-status')) {
    writeJson(stateFile('key-status.json'), record);
    log('key-status', record);
  }
}

// 冷却期里维护者换了主 key(仓库 Secret 的更新时间晚于冷却开始):提前结束冷却,下一轮就先试新的主 key。
// 跟心跳一起最多 15 分钟查一次;读不到 Secret 的更新时间(权限不够、网络)就等冷却自然到期。
function resetPreferBackupIfRotated() {
  const local = readJson(stateFile('key-prefer-backup.json'), null);
  if (!local) return;
  if (!(Date.parse(local.until) > Date.now())) { rmQuiet(stateFile('key-prefer-backup.json')); return; }
  const r = run('gh', ['api', `repos/${CONFIG.workflowRepo}/actions/secrets/${PRIMARY_SECRET}`, '--jq', '.updated_at'],
    { cwd: CONFIG.repoRoot, env: ENV, allowFail: true, timeoutMs: 60_000 });
  const rotatedAt = Date.parse(String(r.stdout ?? '').trim());
  if (!r.ok || !Number.isFinite(rotatedAt) || rotatedAt <= Date.parse(local.setAt)) return;
  const del = run('gh', ['variable', 'delete', PREFER_BACKUP_VARIABLE, '-R', CONFIG.workflowRepo],
    { cwd: CONFIG.repoRoot, env: ENV, allowFail: true, timeoutMs: 60_000 });
  if (!del.ok) { log('key-prefer-backup-reset-error', { error: String(del.stderr || del.error || '').trim().slice(0, 200) }); return; }
  rmQuiet(stateFile('key-prefer-backup.json'));
  log('key-prefer-backup-reset', { rotatedAt: new Date(rotatedAt).toISOString() });
}
function rmQuiet(file) { try { unlinkSync(file); } catch { /* 已经没有了 */ } }

// 停写心跳的登记 <stateDir>/mivo/heartbeat-pause.json:{dispatches:{<dispatch_id>:{pr, intentAt, intentFile}}},由
// settleDispatch 在派发查不清满 60 分钟时写,跨进程保留(停机握手退出、重启后照样不写)。每次都按意图文件复核:文件没了、
// 那一轮已收尾(completed.json),或状态已不是 dispatching / sent(找到了 run、人工解除),就从登记里去掉;
// 去光了删掉登记,记 heartbeat-resumed,照常写心跳。
function heartbeatPaused() {
  const file = stateFile('heartbeat-pause.json');
  const pause = readJson(file, null);
  if (!pause) return false;
  const listed = pause.dispatches ?? {};
  const kept = {};
  for (const [dispatchId, item] of Object.entries(listed)) {
    const intent = item?.intentFile ? readJson(item.intentFile, null) : null;
    if (intent?.dispatchId === dispatchId && ['dispatching', 'sent'].includes(intent.state) &&
        !existsSync(join(dirname(item.intentFile), 'completed.json'))) kept[dispatchId] = item;
  }
  const ids = Object.keys(kept).sort();
  if (!ids.length) {
    try { unlinkSync(file); } catch { /* 已被删,结果相同 */ }
    log('heartbeat-resumed', { dispatches: Object.keys(listed) });
    return false;
  }
  if (ids.length !== Object.keys(listed).length) writeJson(file, { dispatches: kept });
  logOnce(`heartbeat-paused:${ids.join(',')}`, 'heartbeat-paused',
    { reason: 'dispatch-unresolved', dispatches: ids.map((id) => ({ dispatchId: id, pr: kept[id].pr, intentAt: kept[id].intentAt })) });
  return true;
}

// ── 滚动接单的小工具 ────────────────────────────────────────────────────────
// 判门中的任务也算占槽:判门是异步的,判完可能马上派发,不算进去别的轮次会把这个槽当空槽再领一个。
const roundLoads = () => ROUNDS.map((r) => ({ finished: r.finished, queued: r.queued, inflight: r.inflight.size + (r.gating ?? 0) }));
const freeSlots = () => toFreeSlots({ rounds: roundLoads(), maxParallel: CONFIG.maxParallel });
const busyPrs = () => toBusyPrs(ROUNDS.filter((r) => !r.completed).map((r) => ({ ...r.plan, released: r.released })));
const admitScript = (args) => script(join(HERE, 'admit-candidates.mjs'), ['--repo-root', CONFIG.repoRoot, ...args], { timeoutMs: 120_000 });
const skillHead = () => run('git', ['-C', SKILL_ROOT, 'rev-parse', 'HEAD'], { allowFail: true }).stdout.trim();
function incompletePlanFiles() {
  const r = admitScript(['--incomplete-only']);
  if (!r.ok) throw new Error(`读取未完成轮次失败:${r.error}`);
  return r.incompletePlans ?? [];
}
function closeAdmission(reason) {
  if (ADMISSION_CLOSED) return;
  ADMISSION_CLOSED = reason;
  log('admission-closed', { reason, runningRounds: ROUNDS.filter((r) => !r.finished).map((r) => r.runId) });
}
function abortRounds(reason) {
  if (ABORTED) return;
  ABORTED = reason;
  log('rounds-aborting', { reason, runningRounds: ROUNDS.filter((r) => !r.finished).map((r) => r.runId) });
}
// 续锁:返回不是 refreshed:true 就隔离——锁已不属于本进程(被接管、被删,或读写锁文件失败)。
function refreshLock(token) {
  if (FENCED) return false;
  const r = script('refresh-lock.mjs', ['--token', token]);
  if (r.refreshed === true) return true;
  FENCED = true;
  log('lock-lost', { refreshed: r.refreshed ?? null, lost: r.lost ?? null, error: r.error ?? null });
  closeAdmission('lock-lost');
  abortRounds('lock-lost');
  return false;
}
function assertNotFenced() {
  if (FENCED) throw new RoundAborted('lock-lost');
}
function startQuiescing() {
  if (QUIESCING) return;
  QUIESCING = nowIso();
  log('deploy-hold', { running: true, rounds: ROUNDS.filter((r) => !r.finished).map((r) => r.runId) });
  closeAdmission('deploy-hold');
}

// ── 讨论 issue 有新留言(Slack 同步)时唤醒对应 PR ──────────────────────────
// pre-check 的指纹只看 PR 自身;Slack「同意放行」落在讨论 issue 上,不改 PR 的指纹。
// 这里比对确认 issue 的 updatedAt,变了就把本机 round-state 里该 PR 标成需要重查。
// 正在某一轮里的 PR 先不唤醒(那一轮 finalize 会覆盖 retry),记录保留旧值,等它不在审时再触发。
function wakeHeldPrs(busy = new Set()) {
  const issues = ghRead(['api', '--method', 'GET', '--paginate', '--slurp', `repos/${CONFIG.targetRepo}/issues`,
    '-f', 'state=open', '-f', 'per_page=100'], { allowFail: true });
  if (!issues.ok) { log('wake-held-skip', { reason: issues.stderr.trim().slice(0, 200) }); return; }
  const seenFile = stateFile('held-issues.json');
  const openIssues = JSON.parse(issues.stdout).flat();
  const { next, wake, deferred } = toHeldWake({ issues: openIssues, seen: readJson(seenFile, {}), busyPrs: busy });
  if (deferred.length) log('wake-held-deferred', { prs: deferred });
  if (wake.length) {
    const rs = readJson(join(CONFIG.stateDir, roundStateKey(), 'round-state.json'), null);
    if (rs?.prs) {
      for (const pr of wake) if (rs.prs[pr]) rs.prs[pr].retry = true;
      writeJson(join(CONFIG.stateDir, roundStateKey(), 'round-state.json'), rs);
    }
    log('wake-held', { prs: wake });
  }
  writeJson(seenFile, next);
  wakeCodeScanPrs(openIssues, busy);
  wakeCiFailedPrs(openIssues, busy);
}

// ── 代码扫描状态变了(CodeQL success ⇄ neutral)时唤醒对应 PR ────────────────────
// PR 指纹里的 ci 是 statusCheckRollup 的聚合状态,CodeQL 变化不改它;别的门一直 BLOCKED(例如作者自批后 review-pr 留在进行中)时
// mergeStateStatus 也不动。没有独立依据,已挂的标签不会被摘,修好 CodeQL 的 PR 也停在原地。
// 这里复用 wakeHeldPrs 已读的开放 issue 列表(零额外请求),对服务器上次评估时记了三态的开放 PR,每隔 10 分钟各读一次 head 的
// check run(规则按 base 缓存),稳定状态(通过 / 不通过)与基线不同才把本机 round-state 里该 PR 标 retry;瞬态(进行中、缺失、读不到)
// 不唤醒,避免 CodeQL 重跑时来回加摘。基线是服务器那次评估(head 与评估时间都对得上才沿用上次扫描记的状态)。
// 一次最多读 30 个,按上次读取时间轮转,开放 PR 多于 30 个也轮得到。在审的 PR 先推迟。任何意外都只记日志,不影响接单。
function wakeCodeScanPrs(openIssues, busy = new Set()) {
  try {
    const open = new Set((openIssues ?? []).filter((issue) => issue?.pull_request).map((issue) => issue.number));
    const records = loadStore().prs;
    const watched = [...open].map((pr) => ({ pr, ...records[pr]?.codeScan })).filter((entry) => entry.required === true && entry.head && entry.base && entry.state && entry.at);
    if (watched.length === 0) return;
    const watchFile = stateFile('code-scan-watch.json');
    const watch = readJson(watchFile, {}) ?? {};
    if (Date.now() - (Date.parse(watch.lastSweepAt) || 0) < CODE_SCAN_SWEEP_EVERY_MS) return;
    const cache = codeScanCache();
    const batch = toCodeScanSweepSet({ watched, checked: watch.checked ?? {}, max: CODE_SCAN_MAX_WATCHED });
    const observed = {};
    const checked = {};
    for (const entry of batch) {
      observed[entry.pr] = toCodeScanWakeState(toCodeScanGate(fetchCodeScanFacts({ ghFn: (args) => ghRead(args, { allowFail: true }),
        repo: CONFIG.targetRepo, baseRefName: entry.base, head: entry.head, cache })));
      checked[entry.pr] = Date.now();
    }
    const { wake, deferred, next } = toCodeScanWake({ watched, observed, seen: watch.seen ?? {}, busyPrs: busy });
    if (deferred.length) log('wake-code-scan-deferred', { prs: deferred });
    if (wake.length) {
      const roundStatePath = join(CONFIG.stateDir, roundStateKey(), 'round-state.json');
      const roundState = readJson(roundStatePath, null);
      if (roundState?.prs) {
        for (const pr of wake) if (roundState.prs[pr]) roundState.prs[pr].retry = true;
        writeJson(roundStatePath, roundState);
      }
      log('wake-code-scan', { prs: wake });
    }
    // checked 只留还开放的 PR:没读这轮的沿用上次的读取时间,轮转才有依据
    const keptChecked = Object.fromEntries(watched.map((entry) => [entry.pr, checked[entry.pr] ?? watch.checked?.[entry.pr] ?? 0]));
    writeJson(watchFile, { lastSweepAt: nowIso(), seen: next, checked: keptChecked });
  } catch (error) {
    log('wake-code-scan-skip', { reason: String(error?.message ?? error).slice(0, 200) });
  }
}

// ── 上轮 ci-failed、GitHub 聚合 ci 已是 SUCCESS 时唤醒对应 PR ────────────────────
// 指纹里的 ci 是 statusCheckRollup 的聚合 state;判门用 classifyRollupContexts 的逐条去重,旧事件重跑会把
// 已刷新 startedAt 的红当最新,outcome=ci-failed 又不带 retry。PR 之后没改动 → 永远不重判,status:ci-failed 一直挂着。
// 复用 wakeHeldPrs 已读的开放 issue 列表和 round-state 里上次快照的聚合 ci,不另打 GraphQL。只重判门:
// 聚合仍红不唤醒;唤醒过一次、同一 head+ci 不再唤醒,避免每 3 分钟重派服务器审查。在审的 PR 先推迟。任何意外只记日志。
function wakeCiFailedPrs(openIssues, busy = new Set()) {
  try {
    const open = new Set((openIssues ?? []).filter((issue) => issue?.pull_request).map((issue) => issue.number));
    const roundStatePath = join(CONFIG.stateDir, roundStateKey(), 'round-state.json');
    const roundState = readJson(roundStatePath, null);
    const rows = roundState?.prs ?? {};
    const watched = [...open].flatMap((pr) => {
      const row = rows[pr];
      if (row?.outcome !== 'ci-failed') return [];
      return [{ pr, head: row.fingerprintFields?.head ?? null, ci: row.fingerprintFields?.ci ?? null }];
    });
    if (watched.length === 0) return;
    const watchFile = stateFile('ci-wake.json');
    const watch = readJson(watchFile, {}) ?? {};
    const { wake, deferred, next } = toCiWake({ watched, seen: watch.seen ?? {}, busyPrs: busy });
    if (deferred.length) log('wake-ci-deferred', { prs: deferred });
    if (wake.length) {
      if (roundState?.prs) {
        for (const pr of wake) if (roundState.prs[pr]) roundState.prs[pr].retry = true;
        writeJson(roundStatePath, roundState);
      }
      log('wake-ci', { prs: wake });
    }
    writeJson(watchFile, { seen: next });
  } catch (error) {
    log('wake-ci-skip', { reason: String(error?.message ?? error).slice(0, 200) });
  }
}

// ── 已关闭 / 合并的 PR 摘掉 status 标签 ─────────────────────────────────────
// 关闭的 PR 不再进轮次,合并前挂上的 status:* 没人摘(2026-10-22 统计 16 个,多数是 awaiting-bot-review)。
// 每 10 分钟最多查一次:每个受管 status 标签读一次 REST issues 列表(state=closed,只读第一页 100 条),逐个删。
// 不用搜索接口:Mini 的读请求走 GitHub App,上线首轮用 search/issues 没查到任何 PR。
// 只在 live 模式;只删 status 组;任何失败只记日志,不影响接单。
function sweepClosedPrLabels() {
  if (CONFIG.mode !== 'live' || FENCED) return;
  try {
    const file = stateFile('closed-label-sweep.json');
    if (Date.now() - (Date.parse(readJson(file, {})?.at) || 0) < CLOSED_LABEL_SWEEP_EVERY_MS) return;
    const items = new Map();
    const readErrors = [];
    for (const label of STATUS_LABELS) {
      const found = ghRead(['api', '--method', 'GET', `repos/${CONFIG.targetRepo}/issues`, '-f', 'state=closed', '-f', `labels=${label}`, '-f', 'per_page=100'], { allowFail: true });
      if (!found.ok) { readErrors.push(`${label}:${found.stderr.trim().slice(0, 120)}`); continue; }
      for (const item of JSON.parse(found.stdout)) items.set(item?.number, item);
    }
    const removed = [];
    const failed = [...readErrors];
    for (const { pr, labels } of toClosedStatusLabelRemovals([...items.values()])) {
      for (const label of labels) {
        const r = run('gh', ['api', '--method', 'DELETE', `repos/${CONFIG.targetRepo}/issues/${pr}/labels/${encodeURIComponent(label)}`],
          { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
        if (r.ok || /404/.test(r.stderr)) removed.push(`${pr}:${label}`);
        else failed.push(`${pr}:${label}:${r.stderr.trim().slice(0, 120)}`);
      }
    }
    writeJson(file, { at: nowIso(), scanned: items.size, removed, failed });
    if (removed.length || failed.length) log('closed-label-sweep', { scanned: items.size, removed, failed });
  } catch (error) {
    log('closed-label-sweep-skip', { reason: String(error?.message ?? error).slice(0, 200) });
  }
}

// ── 绕过必需检查合入、又没写原因的 PR:提醒一次 ─────────────────────────────────
// 子脚本 bypass-reason.mjs 自己限流(一小时最多真正扫一次)、自己记账、自己只读 GitHub 后才发评论;这里只管调用。
// 失败、超时、抛异常都只记日志,绝不影响本轮接单。只在 live 模式调用,沙箱和干跑不碰真实仓库的评论。
function sweepBypassReminders() {
  if (CONFIG.mode !== 'live') return;
  try {
    const sweep = script(join(HERE, 'bypass-reason.mjs'), ['--sweep', '--repo', CONFIG.targetRepo, '--state-dir', CONFIG.stateDir], { timeoutMs: 60_000 });
    if (sweep.skipped === 'throttled') return;
    log('bypass-reminder', { ok: sweep.ok === true, reminded: sweep.reminded, initialized: sweep.initialized, skipped: sweep.skipped, error: sweep.error });
  } catch (error) {
    log('bypass-reminder', { ok: false, error: String(error.message).slice(0, 200) });
  }
}

// 服务器结果是「GitHub 限额用完」造成的错误(例如读 PR 信息时 GraphQL 限额已用完):这不是这个提交的问题。
// 只限还没花过模型调用的情况(mivo.codex.attempts 为空):模型审完才在发布阶段撞限额的,照旧记失败走退避,
// 否则下一轮会不带退避地重跑一次完整的付费审查。
const GITHUB_RATE_LIMIT_RE = /API rate limit already exceeded|RATE_LIMITED/;
// 同一个提交最多退回这么多次:限额一直不恢复(或每次都撞)时,第 4 次起照旧记失败走退避,不会无限重派。
const RATE_LIMIT_REFUNDS_PER_HEAD = 3;
function isGithubRateLimited(server) {
  if (server?.outcome !== 'error') return false;
  if ((server.mivo?.codex?.attempts ?? []).length > 0) return false;
  return GITHUB_RATE_LIMIT_RE.test([server.reason, ...(server.errors ?? [])].map(String).join('\n'));
}

// #68 上线前 outcome=protected 的 round-state 指纹没变,会被 pre-check 当成 unchanged。
// 只给这些 PR 标 retry 一次,不清空缓存、不让全部 PR 重审。标记写在 Mini 本机 mivo 状态目录。
// 「作者为维护者自动放行」上线时同理:已 hold 住的维护者受保护路径 PR 指纹没变,要再唤醒一次,
// 用独立的标记文件,不和 #68 那次互相挡。
// [MIVO-PATCH gate-bases] 第三个标记 gate-base-wake.json:门禁分支上线时,停在 dependency/retarget 的行同样要再判一次。
function wakeProtectedHoldOnce(markerName = 'protected-hold-wake.json', { outcomes = ['protected'], event = 'wake-protected-hold' } = {}) {
  const markerFile = stateFile(markerName);
  const already = readJson(markerFile, { done: false });
  const rsPath = join(CONFIG.stateDir, roundStateKey(), 'round-state.json');
  const rs = readJson(rsPath, null);
  const result = toOutcomeWake({ roundState: rs, alreadyDone: already.done === true, outcomes });
  if (result.wake.length && rs?.prs) writeJson(rsPath, result.next);
  if (result.wake.length) log(event, { prs: result.wake });
  writeJson(markerFile, { done: true, at: nowIso(), wake: result.wake });
}

// Cindy 的状态目录按目标仓库 git common-dir 的哈希分子目录;用 lib 的同一算法定位。
let STATE_KEY = null;
let GATE_BASES = null; // [MIVO-PATCH gate-bases]
function roundStateKey() {
  if (STATE_KEY) return STATE_KEY;
  const r = run(process.execPath, ['-e', `import(${JSON.stringify(join(SCRIPTS, 'lib.mjs'))}).then((m) => console.log(m.STATE_DIR))`],
    { cwd: CONFIG.repoRoot, env: ENV });
  STATE_KEY = r.stdout.trim().split('/').pop();
  return STATE_KEY;
}

// ── 一轮 ────────────────────────────────────────────────────────────────────
async function main() {
  CONFIG = loadConfig();
  mkdirSync(CONFIG.logDir, { recursive: true });
  mkdirSync(join(CONFIG.stateDir, 'mivo'), { recursive: true });
  ENV = setupEnv(CONFIG);
  // 心跳只在本机确实能干活时写:部署暂停、暂停、维护窗口三处合法的提前返回先写再返回(额度暂停一次 60 分钟,
  // 不写就会被看门狗误判成停机);正常路径等 skill 版本核对和 pre-check 都过了再写。版本不一致、读不了 GitHub
  // 而每次整轮报错时不写,看门狗才报得出来。
  // 部署暂停:不拿锁直接退出。停机握手退出后到部署脚本 bootout 之间,launchd 再拉起的进程不会拿到锁。
  if (deployHold()) { writeHeartbeat(); log('deploy-hold'); return; }
  const pause = pausedUntil();
  if (pause) { writeHeartbeat(); log('paused', pause); return; }
  // 与老审查机同一个维护窗口:06:00–07:00(Asia/Shanghai)不开新一轮;07:00 后照常采集,窗口里来的 PR 自动补上。
  if (!inBusinessWindow()) { writeHeartbeat(); weeklyRepoGc(); log('maintenance-window'); return; }
  verifySkillPin();
  let busyAtStart = null;
  try { busyAtStart = toBusyPrs(incompletePlanFiles().map((file) => ({ ...readJson(file), released: readJson(join(dirname(file), 'mivo-released.json'), {}) }))); } catch (error) {
    log('wake-held-skip', { reason: error.message.slice(0, 200) });
  }
  if (busyAtStart) wakeHeldPrs(busyAtStart);
  sweepBypassReminders();
  sweepClosedPrLabels();
  for (const [markerName, options] of [['protected-hold-wake.json', {}], ['protected-author-release-wake.json', {}],
    ['gate-base-wake.json', { outcomes: ['dependency', 'retarget'], event: 'wake-gate-base' }]]) {
    try { wakeProtectedHoldOnce(markerName, options); } catch (error) {
      log('wake-protected-hold-skip', { marker: markerName, reason: error.message.slice(0, 200) });
    }
  }

  const pre = runScript('pre-check.mjs', ['--repo-root', CONFIG.repoRoot, '--review-only'], { cwd: CONFIG.repoRoot, env: ENV, timeoutMs: 120_000 });
  if (pre.exitCode === 2) { writeHeartbeat(); log('no-candidates', { reason: pre.reason }); return; }
  if (pre.exitCode !== 0 || !pre.decision) throw new Error(`pre-check 失败:${pre.error || pre.reason || `exit ${pre.exitCode}`}`);
  writeHeartbeat();

  const prep = script('prepare.mjs', ['--skip-skill-pull']);
  if (!prep.ok || !prep.lock?.acquired) { log('lock-not-acquired', { lock: prep.lock, error: prep.error }); return; }
  if (!prep.maintainerAuthority?.verified) throw new Error(`维护者权限未核实:${prep.error}`);
  const token = prep.lock.token;
  const digest = prep.maintainerAuthority.digest;
  let lockHandled = false;
  try {
    let planFiles;
    if (pre.reason === 'unfinished-round') {
      // 中断后恢复:拿锁后重读一次,所有未完成的轮次一起接着跑(pre-check 只给最早那一轮)。
      planFiles = incompletePlanFiles();
      if (!planFiles.length) planFiles = [pre.resumePlan];
      log('resume-rounds', { planFiles, count: planFiles.length });
    } else {
      const plan = script('plan-review-round.mjs', ['--lock-token', token, '--mode', 'review-only', '--candidate-list', pre.candidateList], { timeoutMs: 1_800_000 });
      if (!plan.ok) throw new Error(`plan 失败:${plan.error}`);
      planFiles = [plan.planFile];
      log('plan', { runId: plan.runId, groups: plan.groups?.map((g) => g.prs.map((p) => p.pr)), skipped: plan.skipped?.map((s) => [s.pr, s.outcome]) });
    }
    const drives = [];
    for (const file of planFiles) startDrive(file, token, digest, drives);
    releaseResumeBarrier();
    await admitLoop(token, digest, drives);
    const ended = await Promise.all(drives);
    if (FENCED) {
      // 锁已不属于本进程:不释放锁(那是接管者的),未完成的轮次留给持锁者恢复。
      lockHandled = true;
      throw new Error('续锁失败,锁已不属于本进程:已停止一切写入,不释放锁');
    }
    const failures = ended.filter((error) => error && !(error instanceof RoundQuiesced)).map((error) => error.message);
    failures.push(...ADMIT_ERRORS);
    if (failures.length) throw new Error(`${failures.length} 项失败:${failures.join(' | ')}`.slice(0, 1000));
    if (QUIESCING && deployHold()) {
      lockHandled = quiesce(token);
      return;
    }
    if (CONFIG.mode === 'live') {
      const sweep = script('close-product-issue.mjs', ['--sweep']);
      log('product-issue-sweep', { closed: sweep.closedCount, error: sweep.error });
    }
  } finally {
    if (!lockHandled) script('release-lock.mjs', ['--token', token]);
  }
}

// 部署停机握手(方案 Step 1 第 6 条):所有轮次已没有在审 run(只剩查不清的派发也算,意图文件留给新版本接着找),
// 还没领取的任务留在轮次文件里给新版本。
// 用自己的 token 释放锁;release-lock 失败时也输出 ok:true,所以只有 released:true 才写 lockReleased:true。
function quiesce(token) {
  let released = null;
  for (let attempt = 0; attempt < 3 && released?.released !== true; attempt += 1) {
    if (attempt > 0) run('sleep', ['2']);
    released = script('release-lock.mjs', ['--token', token]);
  }
  const lockReleased = released?.released === true;
  writeJson(stateFile('quiesced.json'), { pid: process.pid, at: nowIso(), lockReleased, ...(lockReleased ? {} : { release: released }) });
  log('quiesced', { lockReleased, rounds: ROUNDS.map((r) => r.runId) });
  return true;
}

function verifySkillPin() {
  const own = run('git', ['-C', SKILL_ROOT, 'rev-parse', 'HEAD']).stdout.trim();
  const read = ghRead(['variable', 'get', 'MIVO_REVIEW_SKILL_SHA', '-R', CONFIG.workflowRepo], { allowFail: true });
  if (!read.ok) throw new Error(`读不到仓库变量 MIVO_REVIEW_SKILL_SHA(${String(read.stderr || read.error || '').trim().slice(0, 200)}),拒绝运行`);
  const pinned = read.stdout.trim();
  if (own !== pinned) throw new Error(`本机 skill 版本 ${own.slice(0, 12)} 与服务器钉住的 MIVO_REVIEW_SKILL_SHA ${pinned.slice(0, 12) || '(变量为空)'} 不一致,拒绝运行`);
  SKILL_HEAD = own;
}

// 仓库副本每周手动 gc 一次(修正方案 Step 7 第 2 条)。只在维护窗口里、launchd 刚拉起的进程做:同一个 launchd 任务
// 不会同时跑两个,前一个进程退出后没有别人动这个副本。成功才记时间(repo-gc.json),失败只记日志,下一次窗口再试。
function weeklyRepoGc() {
  const file = stateFile('repo-gc.json');
  const last = Date.parse(readJson(file, {})?.at ?? '');
  if (Number.isFinite(last) && Date.now() - last < REPO_GC_EVERY_MS) return;
  const packs = () => {
    const r = run('git', ['-C', CONFIG.repoRoot, 'count-objects', '-v'], { env: ENV, allowFail: true });
    const n = Number(/^packs: (\d+)$/m.exec(r.stdout ?? '')?.[1]);
    return Number.isFinite(n) ? n : null;
  };
  const packsBefore = packs();
  const startedMs = Date.now();
  const r = run('git', ['-C', CONFIG.repoRoot, 'gc', '--quiet'], { env: ENV, allowFail: true, timeoutMs: 30 * 60_000 });
  if (!r.ok) {
    log('repo-gc-error', { packsBefore, error: String(r.stderr || r.error || '').trim().slice(0, 200) });
    return;
  }
  const done = { at: nowIso(), packsBefore, packsAfter: packs(), seconds: Math.round((Date.now() - startedMs) / 1000) };
  writeJson(file, done);
  log('repo-gc', done);
}

// ── 滚动接单 ─────────────────────────────────────────────────────────────────
function startDrive(planFile, token, digest, drives) {
  let plan;
  try { plan = readJson(planFile); } catch (error) {
    // 读不到计划不能让 main 提前释放锁(别的轮次还在跑):记成失败,收尾时报错,下次启动再恢复。
    ADMIT_ERRORS.push(error.message);
    log('round-failed', { planFile, error: error.message });
    closeAdmission('round-failed');
    return;
  }
  const round = { runId: plan.runId, planFile, plan, inflight: new Map(), queued: 0, finished: false, completed: false,
    released: readJson(join(dirname(planFile), 'mivo-released.json'), {}) };
  ROUNDS.push(round);
  // resolve 成 null 或 Error,不留 rejected promise:要等所有轮次跑完才汇总,挂着的 rejection 会让 Node 直接退出进程。
  drives.push(drive(round, token, digest).then(() => null, (error) => {
    if (error instanceof RoundAborted) {
      log('round-aborted', { runId: round.runId, reason: error.message, inflight: round.inflight.size });
      return error;
    }
    if (error instanceof RoundQuiesced) {
      log('round-quiesced', { runId: round.runId, reason: error.message, queued: round.queued, unresolved: round.inflight.size });
      return error;
    }
    log('round-failed', { runId: round.runId, error: error.message, inflight: round.inflight.size });
    closeAdmission('round-failed');
    if (round.inflight.size > 0) abortRounds(`轮次 ${round.runId} 失败,还有 ${round.inflight.size} 个已派发的服务器审查没收回`);
    return error;
  }).finally(() => { round.finished = true; }));
}

// 有轮次在跑就每 3 分钟检查一次:续锁、写心跳、看部署暂停,再决定要不要另开一轮;所有轮次结束就返回
// (进程退出,launchd 再拉起)。本函数不抛错。
async function admitLoop(token, digest, drives) {
  let nextAt = STARTED_AT + ADMIT_INTERVAL_MS;
  let lastSkip = null;
  while (ROUNDS.some((r) => !r.finished)) {
    const wait = Math.min(CONFIG.pollSeconds * 1000, nextAt - Date.now());
    if (wait > 0) { await new Promise((r) => setTimeout(r, wait)); continue; }
    nextAt = Date.now() + ADMIT_INTERVAL_MS;
    if (FENCED) continue;
    try {
      if (!refreshLock(token)) continue;
      writeHeartbeat();
      sweepClosedPrLabels();
      // Mini 上检出了新 SHA:不再用内存里的旧代码开新轮,手上的跑完退出,launchd 用新代码拉起。
      if (!ADMISSION_CLOSED && skillHead() !== SKILL_HEAD) closeAdmission('skill-updated');
      const hold = Boolean(deployHold());
      if (hold) startQuiescing();
      const decision = toAdmissionDecision({ nowMs: Date.now(), startedAtMs: STARTED_AT, closedReason: ADMISSION_CLOSED, deployHold: hold,
        paused: Boolean(pausedUntil()), inWindow: inBusinessWindow(), rounds: roundLoads(), maxParallel: CONFIG.maxParallel });
      if (decision.close) closeAdmission(decision.reason);
      if (!decision.admit) {
        if (decision.reason !== lastSkip) log('admit-skip', { reason: decision.reason, inflight: CONFIG.maxParallel - freeSlots() });
        lastSkip = decision.reason;
        continue;
      }
      lastSkip = null;
      await admitRound(token, digest, drives, decision.freeSlots);
    } catch (error) {
      ADMIT_ERRORS.push(`接单检查失败:${error.message}`);
      log('admit-error', { error: error.message });
      closeAdmission('admit-error');
    }
  }
}

async function admitRound(token, digest, drives, slots) {
  wakeHeldPrs(busyPrs());
  // 维护者名单只读比对一次(不写快照:快照按锁 token 命名、同一个锁只能写一次)。变了就停止接单,
  // 手上的轮次跑完退出,launchd 重启时 prepare 写新快照。
  const authority = admitScript(['--authority-only']);
  if (!authority.ok) { log('admit-error', { error: `维护者权限读取失败:${authority.error || `exit ${authority.exitCode}`}` }); return; }
  if (authority.digest !== digest) {
    log('authority-changed', { from: digest, to: authority.digest });
    closeAdmission('authority-changed');
    return;
  }
  const admit = admitScript([]);
  if (admit.exitCode === 2) { log('admit-none', { excluded: admit.excludedPrs }); return; }
  // 采集只读、没有副作用:失败记日志,下个检查点再试。
  if (admit.exitCode !== 0 || !admit.ok) { log('admit-error', { error: admit.error || `exit ${admit.exitCode}` }); return; }
  // plan 要几分钟:异步跑,别的轮次照常轮询、续锁。
  const plan = await runScriptAsync('plan-review-round.mjs', ['--lock-token', token, '--mode', 'review-only', '--candidate-list', admit.candidateList],
    { cwd: CONFIG.repoRoot, env: ENV, timeoutMs: 1_800_000 });
  if (!plan.ok) {
    // plan 可能已写出 plan.json 或发过目标分支提醒:停止接单,手上的轮次收尾后报错,下次启动按未完成轮次恢复。
    ADMIT_ERRORS.push(`接单 plan 失败:${plan.error}`);
    log('admit-plan-error', { error: plan.error, runId: admit.runId });
    closeAdmission('admit-plan-failed');
    return;
  }
  // plan 跑了几分钟:启动这一轮前重查锁、skill SHA、维护窗口和部署暂停。任一不满足就不启动,
  // plan 文件留在轮次目录里,下次启动按未完成轮次恢复。
  const blocked = startBlocker(token);
  if (blocked) {
    log('admit-deferred', { runId: plan.runId, planFile: plan.planFile, reason: blocked });
    if (blocked === 'deploy-hold') startQuiescing();
    closeAdmission(blocked);
    return;
  }
  log('plan', { runId: plan.runId, admitted: true, freeSlots: slots, excluded: admit.excludedPrs,
    groups: plan.groups?.map((g) => g.prs.map((p) => p.pr)), skipped: plan.skipped?.map((s) => [s.pr, s.outcome]) });
  startDrive(plan.planFile, token, digest, drives);
}

function startBlocker(token) {
  if (!refreshLock(token)) return 'lock-lost';
  if (skillHead() !== SKILL_HEAD) return 'skill-updated';
  if (!inBusinessWindow()) return 'maintenance-window';
  if (deployHold()) return 'deploy-hold';
  return null;
}

async function drive(round, token, authorityDigest) {
  const { planFile, plan, inflight } = round;
  const queue = (action, extra = []) => runScript('review-queue.mjs', [action, '--plan', planFile, '--lock-token', token, ...extra],
    { cwd: CONFIG.repoRoot, env: ENV, timeoutMs: 600_000 });
  const roundDir = dirname(planFile);
  if (!existsSync(join(roundDir, 'queue.json'))) {
    const init = queue('init', ['--concurrency', String(CONFIG.maxParallel)]);
    if (!init.ok) throw new Error(`queue init 失败:${init.error}`);
  }
  const spawnWatch = () => spawn(process.execPath, [join(SCRIPTS, 'review-queue.mjs'), 'watch', '--plan', planFile, '--lock-token', token],
    { cwd: CONFIG.repoRoot, env: ENV, stdio: 'ignore' });
  let watch = spawnWatch();
  // 多轮并存时,别的轮次一次长时间的同步处理会让本轮 coordinator 超过 10 分钟没刷新,watch 自行退出、停止续锁:退出了就重启。
  const ensureWatch = () => {
    if (watch.exitCode === null && watch.signalCode === null) return;
    log('watch-restart', { runId: plan.runId, exitCode: watch.exitCode, signal: watch.signalCode });
    watch = spawnWatch();
  };
  const ctx = { round, plan, planFile, roundDir, token, authorityDigest, queue, inflight, ensureWatch, gates: new Set(), gateError: null, wake: null };
  try {
    resumeInflight(ctx, inflight, queue);
    await RESUME_BARRIER;
    for (let pass = 0; pass < 2; pass += 1) {
      // 本轮还在判门的任务先等它们结束(中止、停机握手也一样),不在后台留下没人收尾的判门。
      try { await runQueue(ctx); } finally { await Promise.allSettled([...ctx.gates]); }
      const reconcile = queue('reconcile');
      if (!reconcile.ok) throw new Error(`reconcile 失败:${reconcile.error}`);
      log('reconcile', { runId: plan.runId, reopened: reconcile.reopened, allComplete: reconcile.allComplete });
      if (reconcile.reconciled) break;
    }
    const final = script('finalize-review-round.mjs', ['--plan', planFile, '--lock-token', token], { timeoutMs: 300_000 });
    if (!final.ok) {
      // 无人值守:同一轮收尾连续失败两次就放弃这一轮(写 completed.json 标 abandoned),
      // 下一轮按旧的 round-state 重新采集,不让一个坏轮次永久卡住前置审查。
      const attemptsFile = join(roundDir, 'mivo-finalize-attempts.json');
      const attempts = [...readJson(attemptsFile, []), { at: nowIso(), error: final.error }];
      writeJson(attemptsFile, attempts);
      if (attempts.length >= 2) {
        writeJson(join(roundDir, 'completed.json'), { runId: plan.runId, completedAt: nowIso(), abandoned: true, reason: final.error });
        round.completed = true;
        log('round-abandoned', { runId: plan.runId, error: final.error });
        return;
      }
      throw new Error(`finalize 失败:${final.error}`);
    }
    // Mivo 不发每轮汇总(2026-10-11 决定):写明确的 disabled 回执,队列才能关闭。
    writeJson(join(roundDir, 'notification.json'), { runId: plan.runId,
      pages: [{ page: 1, status: 'disabled', reason: 'Mivo 不发每轮汇总(owner 2026-10-11 决定)', attemptedAt: nowIso() }] });
    const closed = queue('close');
    if (!closed.ok) throw new Error(`queue close 失败:${closed.error}`);
    round.completed = true;
    log('round-complete', { runId: plan.runId, entered: final.enteredCount, skipped: final.skippedCount });
  } finally {
    queue('stop');
    watch.kill('SIGTERM');
  }
}

async function runQueue(ctx) {
  const { round, queue, inflight } = ctx;
  for (;;) {
    // 只有在等待期间别的轮次才可能失败,所以每次醒来先看一眼。中止的轮次不收尾,留给重启后恢复。
    if (ABORTED) throw new RoundAborted(ABORTED);
    if (!QUIESCING && deployHold()) startQuiescing();
    ctx.ensureWatch();
    queue('status');
    releaseDeferredGates(ctx);
    if (ctx.gateError) throw ctx.gateError;
    // 全进程在审数满了就不领取;部署暂停后也不领取。判门异步、最多 gateParallel 路并行(#141);判门中的任务从领取起就算占槽
    // (round.gating),判完派发后先登记在途再释放,别的轮次看不到过时的空槽。
    while (!QUIESCING && freeSlots() > 0 && GATING < CONFIG.gateParallel) {
      assertNotFenced();
      const claim = queue('claim');
      if (!claim.ok) throw new Error(`claim 失败:${claim.error}`);
      if (!claim.claimed) break;
      const task = claim.task;
      // 归属:最近一次接走这个 PR 的轮次。旧轮晚收尾时,归属已经转走的 PR 不写回本机记录。
      bumpStore(task, { ownerRoundId: round.runId });
      const skipped = gateSkipFor(ctx, task);
      if (skipped) {
        // gate.actions 为空:和没有动作的真判门一样,可以提前从轮次释放(canReleaseDeferredGate,#155)。
        writeTaskResult(ctx, task, { ...skipped, reason: `${skipped.reason}(head、CI、讨论状态都没变,沿用上次判门结论)`, gateSkipped: true, gate: { actions: [] } });
        log('gate-skipped', { pr: task.pr, head: task.head, outcome: skipped.outcome });
        completeGate(ctx, task);
        continue;
      }
      startGate(ctx, task);
    }
    // 进度和未绑定派发各查一次(各是一组分页调用),请求数与在审数无关;每个在审 run 不再单独 `gh run view`。
    const lookup = dispatchLookup(inflight);
    const active = [...inflight.values()].some((entry) => entry.runId) ? listActiveRuns() : null;
    for (const [pr, entry] of inflight) {
      if (ABORTED) break;
      if (!entry.runId) {
        const settled = settleDispatch(ctx, entry, lookup);
        if (settled === 'not-submitted') {
          completeUnstarted(queue, pr);
          inflight.delete(pr);
          continue;
        }
        if (settled !== 'bound') continue;
      }
      cancelIfSuperseded(ctx, entry);
      const done = collectServerRun(ctx, entry, active);
      if (!done) continue;
      completeTask(queue, pr, entry.agentId);
      inflight.delete(pr);
      if (entry.cancelIntent?.newHead) releasePr(ctx, entry);
    }
    if (ABORTED) throw new RoundAborted(ABORTED);
    const status = queue('status');
    round.queued = status.queued?.length ?? 0;
    if (!inflight.size && round.queued === 0 && (status.active?.length ?? 0) === 0) return;
    // 在审的只剩还不知道有没有派出的派发(runId 为 null):它们可能一直查不清,这一轮也就一直结束不了。
    const onlyUnresolved = inflight.size > 0 && !round.gating && [...inflight.values()].every((entry) => !entry.runId);
    // 部署暂停:这一轮已没有在审 run(或只剩未决派发),停下;还没领取的任务和派发意图留在轮次目录里给新版本。
    if (QUIESCING && !round.gating && (!inflight.size || onlyUnresolved)) throw new RoundQuiesced('deploy-hold');
    // 已停止接单(维护窗口、24 小时上限、换版本、维护者名单变化等),又只剩未决派发、领不到新任务时不再空等:
    // 这一轮停下,进程才能退出,launchd 拉起的新进程带着这个占位接着找,并照常接单。
    if (ADMISSION_CLOSED && onlyUnresolved && (round.queued === 0 || freeSlots() === 0)) throw new RoundQuiesced('unresolved-only');
    // 有判门结束就提前醒来,接着领取下一个,不等满一个轮询间隔。
    await new Promise((r) => {
      const timer = setTimeout(r, CONFIG.pollSeconds * 1000);
      ctx.wake = () => { clearTimeout(timer); r(); };
    });
    ctx.wake = null;
  }
}

// 判门在后台跑:结束后派出的登记在途,没派的收尾;判门中的任务一直算占槽,登记完才释放。
function startGate(ctx, task) {
  GATING += 1;
  ctx.round.gating = (ctx.round.gating ?? 0) + 1;
  const gate = handleTask(ctx, task).then((outcome) => {
    recordLastGate(task);
    if (outcome.dispatched) {
      // 找到 run 才绑定;还不知道有没有派出的,先占槽,之后按 dispatch_id 找回或等人工解除。
      if (outcome.runId) bind(ctx.queue, task.pr, outcome.agentId);
      ctx.inflight.set(task.pr, { ...outcome, task });
    } else completeGate(ctx, task);
  }, (error) => {
    if (error instanceof RoundAborted) throw error;
    log('task-error', { pr: task.pr, error: error.message });
    writeTaskResult(ctx, task, { outcome: 'error', reason: `前置审查异常:${error.message}`, retry: true, errors: [error.message] });
    completeGate(ctx, task);
  }).catch((error) => { ctx.gateError ??= error; }).finally(() => {
    GATING -= 1;
    ctx.round.gating -= 1;
    ctx.gates.delete(gate);
    ctx.wake?.();
  });
  ctx.gates.add(gate);
}

function completeGate(ctx, task) {
  const agentId = `mini-gate:${task.pr}:${randomUUID().slice(0, 8)}`;
  bind(ctx.queue, task.pr, agentId);
  completeTask(ctx.queue, task.pr, agentId);
}

// 上次真正判门的 head 和时间(进程间保留),toGateSkip 的兜底:同一 head 满 30 分钟照样重判。
function recordLastGate(task) {
  const file = stateFile('gate-last.json');
  writeJson(file, { ...readJson(file, {}), [task.pr]: { head: task.head, atMs: Date.now() } });
}

function gateSkipFor(ctx, task) {
  const candidate = (ctx.plan.manifest?.candidates ?? []).find((item) => item.number === task.pr);
  // 多数任务在这一步就排除,不读 round-state(roundStateKey 第一次要起一个子进程)。
  if (!isGateSkipCandidate(candidate)) return null;
  const previous = readJson(join(CONFIG.stateDir, roundStateKey(), 'round-state.json'), null)?.prs?.[task.pr];
  return toGateSkip({ candidate, previous, lastGate: readJson(stateFile('gate-last.json'), {})[task.pr], nowMs: Date.now() });
}

function bind(queue, pr, agentId) {
  const r = queue('bind', ['--pr', String(pr), '--agent-id', agentId]);
  if (!r.ok) throw new Error(`bind #${pr} 失败:${r.error}`);
}
function completeTask(queue, pr, agentId) {
  const r = queue('complete', ['--pr', String(pr), '--agent-id', agentId, '--agent-exited']);
  if (!r.ok) throw new Error(`complete #${pr} 失败:${r.error}`);
}
function completeUnstarted(queue, pr) {
  const r = queue('complete', ['--pr', String(pr), '--no-agent-started', '--agent-exited']);
  if (!r.ok) throw new Error(`complete #${pr} 失败:${r.error}`);
}

// 中断后恢复:队列里已绑定到服务器 run 的任务继续轮询;没绑定的看派发意图——只有 prepared(或没有意图)
// 能证明没外发,按「判门中途断了」补一条 error 结果再 complete;dispatching / sent 不自动重发,按 dispatch_id 找回;
// 已找到 run(bound)就补绑定;人工核实没派出(not-submitted)就按没派出收尾。只领取没绑定的,当作没启动过。
function resumeInflight(ctx, inflight, queue) {
  const queueFile = join(ctx.roundDir, 'queue.json');
  if (!existsSync(queueFile)) return;
  const planned = ctx.plan.groups.flatMap((g) => g.prs);
  for (const task of readJson(queueFile).tasks) {
    if (task.phase === 'queued') continue;
    const item = { ...planned.find((p) => p.pr === task.pr), ...task, resultFile: join(ctx.roundDir, 'results', `pr-${task.pr}.json`) };
    const cancelIntent = readJson(cancelIntentFile(ctx, task.pr), null);
    if (task.phase === 'complete') {
      // 取消旧审查后已收尾、但还没记下提前释放就中断了:补上释放。
      if (cancelIntent?.newHead && !ctx.round.released?.[task.pr]) releasePr(ctx, { task: item, runId: cancelIntent.runId, cancelIntent });
      continue;
    }
    if (task.phase === 'cleanup-pending') {
      // review-queue complete 已记下收尾、删审查 worktree 时中断(或领取时建 worktree 失败):沿同一个 agent 再 complete
      // 一次把清理做完。不按派发意图重新 bind(bind 只接受 ready/running),也不重派。
      finishResolution(readIntent(ctx, task.pr));
      if (!existsSync(item.resultFile)) writeTaskResult(ctx, item, { outcome: 'error', reason: '上次运行在收尾清理中途中断,下一轮重新处理', retry: true });
      if (task.agentId) completeTask(queue, task.pr, task.agentId);
      else completeUnstarted(queue, task.pr);
      if (cancelIntent?.newHead && !ctx.round.released?.[task.pr]) releasePr(ctx, { task: item, runId: cancelIntent.runId, cancelIntent });
      log('resume-cleanup', { pr: task.pr, agentId: task.agentId ?? null });
      continue;
    }
    const m = String(task.agentId ?? '').match(/^gha:(\d+):([^:]*)/);
    const intent = readIntent(ctx, task.pr);
    if (m && task.phase === 'running') {
      // 前置判门的状态(errors / retry / authorNotice)随派发意图落盘;只认 dispatch_id 对得上的那份。
      const entry = { dispatched: true, agentId: task.agentId, runId: m[1], dispatchId: m[2], task: item, dispatchedAt: task.boundAt,
        gateResult: intent?.dispatchId === m[2] ? intent.gateResult ?? {} : {} };
      if (cancelIntent?.runId === m[1]) Object.assign(entry, { cancelIntent, cancelResend: true });
      finishResolution(intent);
      inflight.set(task.pr, entry);
      continue;
    }
    if (intent && intent.claimAttempt === task.attempts && ['dispatching', 'sent', 'bound', 'not-submitted'].includes(intent.state)) {
      const entry = { dispatched: true, dispatchId: intent.dispatchId, intentAt: intent.intentAt, attempt: intent.attempt,
        dispatchedAt: intent.intentAt, gateResult: intent.gateResult ?? {}, runId: null, agentId: null, task: item };
      if (intent.state === 'not-submitted') {
        finishResolution(intent);
        if (!existsSync(item.resultFile)) writeTaskResult(ctx, item, { outcome: 'error', reason: '人工核实这次派发没有发出,下一轮重新送审', retry: true });
        completeUnstarted(queue, task.pr);
        log('resume-dispatch', { pr: task.pr, dispatchId: intent.dispatchId, state: intent.state });
        continue;
      }
      if (intent.state === 'bound' && intent.runId) {
        entry.runId = String(intent.runId);
        entry.agentId = `gha:${entry.runId}:${intent.dispatchId}`;
        bind(queue, task.pr, entry.agentId);
        finishResolution(intent);
      }
      inflight.set(task.pr, entry);
      log('resume-dispatch', { pr: task.pr, dispatchId: intent.dispatchId, state: intent.state, runId: entry.runId });
      continue;
    }
    if (!existsSync(item.resultFile)) writeTaskResult(ctx, item, { outcome: 'error', reason: '上次运行在判门中途中断,下一轮重新处理', retry: true });
    if (task.agentId) completeTask(queue, task.pr, task.agentId);
    else completeUnstarted(queue, task.pr);
    log('resume-orphan', { pr: task.pr, phase: task.phase, intent: intent?.state ?? null });
  }
}

// ── 单个 PR:判门(本机) ─────────────────────────────────────────────────────
async function handleTask(ctx, task) {
  const { roundDir, token, authorityDigest } = ctx;
  const liveFile = join(roundDir, `pr-${task.pr}-live.json`);
  const live = await scriptAsync('context.mjs', [String(task.pr), '--lock-token', token, '--cached-context', task.contextFile,
    '--diff-output', join(roundDir, `pr-${task.pr}-live.diff`)], { timeoutMs: 300_000 });
  writeJson(liveFile, live);
  if (!live.ok) return finishGate(ctx, task, { outcome: 'error', reason: `context 读取失败:${live.error}`, retry: true, errors: [live.error] });
  if (live.meta.state !== 'OPEN' || live.meta.isDraft || live.meta.headRefOid !== task.head ||
      live.meta.baseRefOid !== task.base || live.meta.baseRefName !== task.baseRefName) {
    return finishGate(ctx, task, { outcome: 'state-changed', reason: '名单生成后 PR 已关闭、转 draft,或 head/base 已变化;下轮重新采集' });
  }
  const bindings = ['--lock-token', token, '--expected-head', task.head, '--expected-authority-digest', authorityDigest];
  // 作者交接(lib/handoff.mjs):开关 off 时不读,判门与改动前完全一致。
  const handoffMode = loadHandoffMode(process.env.MIVO_REVIEW_FEATURES_FILE || join(SKILL_ROOT, 'mivo', 'config', 'review-features.json'));
  live.mivoHandoff = { featureMode: handoffMode.mode,
    facts: handoffMode.mode === 'off' ? null : readHandoffFacts({ repo: CONFIG.targetRepo, head: task.head, ghFn: (args) => ghRead(args, { allowFail: true }) }) };
  const decision = decideGate(live);
  const result = { outcome: decision.outcome, reason: decision.reason, errors: [], warnings: [], gate: { stage: decision.stage, actions: decision.actions } };
  if (handoffMode.warning) result.warnings.push(handoffMode.warning);
  if (live.mivoHandoff.facts?.readError) result.warnings.push(`交接事实读不到:${live.mivoHandoff.facts.readError}`);
  const dry = CONFIG.mode === 'dry-run';
  if (dry && decision.actions.length) result.dryRunActions = decision.actions.map((a) => `${a.script}${a.mode ? `:${a.mode}` : ''}${a.kind ? `:${a.kind}` : ''}${a.issueMode ? `:${a.issueMode}` : ''}${a.gateKind ? `:${a.gateKind}` : ''}`);

  for (const action of dry ? [] : decision.actions) await executeGateAction({ action, live, task, bindings, result, roundDir });
  if (dry) {
    // dry-run 不发作者提醒;受保护路径 / rebase 终态按 Cindy 规则必须带提醒回执,如实记「没发」并下轮重试。
    for (const action of decision.actions) {
      const kind = action.script === 'notify-protected' ? 'protected-path' : action.script === 'notify-rebase' ? 'stale-rebase' : null;
      if (kind) {
        result.authorNotice = { kind, status: 'failed', head: task.head, reason: 'dry-run:没有发提醒' };
        result.retry = true;
      }
    }
  }
  // 作者是维护者、受保护路径自动放行:不发「转人工审核」提醒,作者提醒回执记 deduplicated(轮次汇总要求 protected 有终态)。
  if (decision.autoRelease) result.authorNotice = toAutoReleaseNotice({ head: task.head, by: decision.autoRelease.by });
  if (!dry) syncDisplayLabels(live, task, result);
  if (!dry) dropStaleMergeReady(live, task, result, decision);

  if (decision.stage === 'protected' && decision.outcome === 'protected') {
    // 受保护路径的人工放行(维护者 Approve / 确认 issue 上的「同意放行」,不绑 head)成立:review-pr 还没写成功就派
    // 服务器独立复核并写;已经成功就由 Mini 补关确认 issue(服务器令牌的 issue 写权限未核实,关 issue 不交给服务器)。
    const protectedPath = live.protectedPath;
    const next = toProtectedDispatch({ decision, protectedPath, checkDone: protectedCheckDone(task) });
    if (next.closeIssue && !dry) {
      await executeGateAction({ action: { script: 'signoff-release', mode: 'labels-only-close-issue', ...(decision.autoRelease ? { autoRelease: decision.autoRelease } : {}) }, live, task, bindings, result, roundDir });
    }
    if (next.dispatch) return dispatchReview(ctx, task, { tier: live.review?.tier ?? 'standard', action: 'protected-approve' }, result);
  }
  if (decision.stage !== 'review') {
    if (decision.retry) result.retry = true;
    return finishGate(ctx, task, result);
  }
  return dispatchReview(ctx, task, { tier: decision.tier, action: 'review' }, result);
}

async function executeGateAction({ action, live, task, bindings, result, roundDir }) {
  assertNotFenced();
  const pr = String(task.pr);
  const record = (name, out) => {
    result.gate[name] = out;
    if (out?.ok === false || out?.error) result.errors.push(`${name}:${out.error || out.reason || '失败'}`);
    if (out?.labelWarning) result.warnings.push(`${name}:${out.labelWarning}`);
  };
  switch (action.script) {
    case 'signoff-hold': {
      const payloadFile = join(roundDir, `signoff-payload-pr-${pr}.json`);
      writeJson(payloadFile, buildSignoffPayload(live, action.kind, action.issueMode));
      // issueMode: protected = 受保护路径确认 issue;notice = 豁免作者的通知 issue(创建后即关闭,不拦 PR)。
      const modeArgs = action.issueMode ? ['--signoff-mode', action.issueMode] : [];
      const args = action.mode === 'labels-only'
        ? [pr, '--labels-only', '--kind', action.kind, ...modeArgs, ...bindings]
        : [pr, '--kind', action.kind, ...modeArgs, '--payload-file', payloadFile, ...bindings];
      let out = await gateActionScript('signoff-hold.mjs', args);
      if (out.needsFreshHold || out.reason === 'missing-payload') out = await gateActionScript('signoff-hold.mjs', [pr, '--kind', action.kind, ...modeArgs, '--payload-file', payloadFile, ...bindings]);
      if (out.issueError) result.errors.push(`确认 issue 创建失败:${out.issueError}`);
      if (out.commentError) result.errors.push(`确认首评发布失败:${out.commentError}`);
      if (action.issueMode === 'notice') {
        // 通知没发出去不挡送审,下一轮重判时再发(PR 上没有去重标记就会重来);关闭失败只记警告。
        result.gate.signoffNotice = out;
        if (out.closeError) result.warnings.push(`通知 issue 没关掉:${out.closeError}`);
      }
      record('signoffHold', out);
      if (out.issueError || out.commentError) result.retry = true;
      break;
    }
    case 'signoff-release': {
      // 补关 issue 只关绑定本 PR 的:hold 标记评论任何人都能发,指向别的 PR 的 issue 时不关、不评论,只记 warning。
      // 自动放行关存量 protected issue:说明文案写进 payload 文件(closeCommentBody)交给 signoff-release。
      let payloadFile = '';
      if (action.autoRelease) {
        payloadFile = join(roundDir, `auto-release-close-pr-${pr}.json`);
        writeJson(payloadFile, { closeCommentBody: toAutoReleaseCloseComment({ pr, url: live.meta?.url, by: live.meta?.author ?? action.autoRelease.by }) });
      }
      const { args, warning } = toSignoffReleaseArgs({ action, pr, held: live.signoff?.held, heldIssue: live.signoff?.heldIssue, bindings, payloadFile });
      if (warning) result.warnings.push(`signoffRelease:${warning}`);
      record('signoffRelease', await gateActionScript('signoff-release.mjs', args));
      break;
    }
    case 'close-product-issue':
      // close-product-issue.mjs 不核对 head:排队期间推了新提交,新 head 可能又要确认,不按旧判门结论关讨论 issue。
      record('closeProductIssue', await gateActionScript('close-product-issue.mjs', [pr, '--no-longer-required'], {}, () => {
        const head = readLiveHead(task.pr);
        if (head === task.head) return null;
        return { ok: false, error: head ? `判门后 head 已变为 ${head.slice(0, 12)},不关讨论 issue` : '读不到当前 head,不关讨论 issue' };
      }));
      if (result.gate.closeProductIssue?.ok === false) result.retry = true;
      break;
    case 'request-changes': {
      const pushback = buildGatePushback(live, action.gateKind);
      const bodyFile = join(roundDir, `gate-${action.gateKind}-pr-${pr}.md`);
      writeText(bodyFile, pushback.body);
      const own = live.approvalPolicy?.viewerIsAuthor === true;
      if (own && !pushback.comments.length) {
        result.warnings.push(`作者是审查账号本人,${action.gateKind} 打回没有可锚定的文件,不发布`);
        break;
      }
      const args = [pr, '--body-file', bodyFile, '--gate-kind', action.gateKind, ...bindings];
      if (pushback.comments.length) {
        const commentsFile = join(roundDir, `gate-${action.gateKind}-pr-${pr}.json`);
        writeJson(commentsFile, pushback.comments);
        args.push('--comments-file', commentsFile);
      }
      if (own) args.push('--comment-only');
      const out = await gateActionScript('request-changes-reviewed-pr.mjs', args, { timeoutMs: 180_000 });
      record('pushback', out);
      if (out.submitted) result.threadUrls = out.threadUrls ?? [];
      else result.retry = true;
      break;
    }
    case 'notify-protected': {
      const out = await gateActionScript('notify-author-resolve.mjs', [pr, '--protected-path', ...bindings]);
      result.authorNotice = noticeFrom('protected-path', out, task.head);
      if (result.authorNotice.status === 'failed') result.retry = true;
      break;
    }
    case 'notify-rebase': {
      const out = await gateActionScript('notify-author-resolve.mjs', [pr, '--stale-rebase', ...bindings]);
      if (out.ok && !out.posted && out.reason !== 'already-commented') {
        // 脚本重查发现卡点已消失:改记状态变化,交下一轮重新采集(pr-worker 第 3 节)。
        result.outcome = 'state-changed';
        result.reason = `rebase 卡点已消失:${out.reason}`;
        break;
      }
      result.authorNotice = noticeFrom('stale-rebase', out, task.head);
      if (result.authorNotice.status === 'failed') result.retry = true;
      break;
    }
    case 'approve-workflows':
      // 只批判门时那个 head 的 workflow(--expected-head,脚本里按 head_sha 查 run):排队期间作者推了新提交,
      // 不能替没判过门的新 head 放行 CI(单审 P1)。
      record('approveWorkflows', await gateActionScript('approve-workflows.mjs', [pr, '--expected-head', task.head]));
      result.retry = true;
      break;
    case 'retry-ci': {
      const out = await gateActionScript('retry-ci.mjs', [pr, ...bindings]);
      record('retryCi', out);
      if (['rerun-requested', 'already-requested', 'reconciled', 'pending-reconciliation'].includes(out.action)) {
        result.outcome = 'ci-pending';
        result.retry = true;
      } else if (out.action === 'state-changed') {
        result.outcome = 'state-changed';
        result.reason = `CI 重跑前 PR 已变化:${out.reason}`;
      }
      break;
    }
    default:
      result.errors.push(`未知动作 ${action.script}`);
  }
}

function noticeFrom(kind, out, head) {
  if (out.posted) return { kind, status: 'posted', head, fingerprint: String(out.fingerprint ?? head) };
  if (out.reason === 'already-commented') return { kind, status: 'deduplicated', head, fingerprint: String(out.fingerprint ?? head) };
  return { kind, status: 'failed', head, reason: out.error || out.reason || '提醒没有发出' };
}

function syncDisplayLabels(live, task, result) {
  const labels = live.statusLabels;
  if (!labels?.enabled || !labels.stale) return;
  assertNotFenced();
  const out = script('sync-status-labels.mjs', [String(task.pr), '--desired', (labels.desired ?? []).join(','), '--current', (labels.current ?? []).join(',')]);
  if (out.warning || out.errors?.length) result.warnings.push(`展示标签同步:${out.warning || out.errors.join('; ')}`);
}

// 摘掉不再成立的 review:merge-ready。标签只对「审查通过的那个 head、且门禁仍然全过」成立:
//   - head 变了(审查通过的 head 不是当前 head);
//   - 门禁失效:与 base 冲突、人工讨论未 resolve 等稳定卡点(判据见 lib/gates.mjs 的 toStaleMergeReadyReason)。
//     这两类只用本轮判门已经拿到的 context,不多打 API;摘掉后标签不在了,下一轮不会重复 DELETE。
//     门禁重新全过后,判门回到送审阶段,服务器沿用结论(同 head 走复用)再把标签加回来。
//   - 代码扫描 / 质量门稳定不通过(CodeQL neutral / failure,2026-10-18 #1025):只在前两类都没发现问题时才读一次
//     (规则按 base 缓存 30 分钟,head 上的 check run 一次 REST,不碰 GraphQL);进行中、缺失、读不到不摘,避免来回加摘。
function dropStaleMergeReady(live, task, result, decision) {
  if (!(live.meta?.labels ?? []).includes(MERGE_READY_LABEL)) return;
  const record = loadStore().prs[task.pr];
  const headMatches = record?.cleanHead === task.head;
  let gateReason = toStaleMergeReadyReason({ decision, meta: live.meta });
  if (headMatches && !gateReason) gateReason = toStaleMergeReadyReason({ decision, meta: live.meta, codeScan: readCodeScanGate(task) });
  if (headMatches && !gateReason) return;
  assertNotFenced();
  const r = run('gh', ['api', '--method', 'DELETE', `repos/${CONFIG.targetRepo}/issues/${task.pr}/labels/${encodeURIComponent(MERGE_READY_LABEL)}`],
    { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
  if (!r.ok && !/404/.test(r.stderr)) result.warnings.push(`review:merge-ready 没摘掉:${r.stderr.trim().slice(0, 200)}`);
  else if (r.ok) log('merge-ready-dropped', { pr: task.pr, head: task.head, reason: gateReason ?? 'head-changed' });
}

// 代码扫描门的事实:规则按 base 缓存在本机状态目录(code-scan-rules.json),读不到时 toCodeScanGate 给出 unverified,调用方不摘。
// 这一步只是多一道摘标签的依据:任何意外(缓存文件损坏、gh 起不来)都按「读不到」处理,不影响判门和派发。
function codeScanCache() {
  const file = stateFile('code-scan-rules.json');
  return { get: (key) => readJson(file, {})?.[key] ?? null, set: (key, value) => writeJson(file, { ...readJson(file, {}), [key]: value }) };
}
function readCodeScanGate(task) {
  try {
    return toCodeScanGate(fetchCodeScanFacts({ ghFn: (args) => ghRead(args, { allowFail: true }), repo: CONFIG.targetRepo,
      baseRefName: task.baseRefName, head: task.head, cache: codeScanCache() }));
  } catch (error) {
    log('code-scan-gate-error', { pr: task.pr, head: task.head, error: String(error?.message ?? error).slice(0, 200) });
    return null;
  }
}

// 受保护路径:当前 head 的 review-pr check 是否已经写成 success。放行信号本身由 context 的 protectedPath 给出。
// check 读不到按「没写成功」处理:最多多派一次服务器复核,服务器写 check 是幂等的。
// [MIVO-PATCH gate-bases] 检查名按任务的目标分支取(门禁分支为 review-pr (integration)),与服务器写检查同一个函数。
function gateBases() {
  GATE_BASES ??= loadGateBases(CONFIG.rulesFile || join(SKILL_ROOT, 'review-pr', 'config', 'pr-rules.json'));
  return GATE_BASES;
}
function reviewCheckName(task) {
  return checkNameFor(task.baseRefName, gateBases());
}

function protectedCheckDone(task) {
  try {
    const name = reviewCheckName(task);
    const checks = ghRead(['api', `repos/${CONFIG.targetRepo}/commits/${task.head}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`, '--paginate', '--slurp'], { allowFail: true });
    if (!checks.ok) return false;
    const prefix = `https://github.com/${CONFIG.workflowRepo}/actions/runs/`;
    const formal = JSON.parse(checks.stdout).flatMap((page) => page.check_runs ?? [])
      .filter((check) => check.name === name && check.head_sha === task.head
        && check.app?.slug === 'github-actions' && typeof check.external_id === 'string'
        && check.external_id.startsWith(prefix) && /^[1-9]\d*$/.test(check.external_id.slice(prefix.length)))
      .sort((left, right) => right.id - left.id)[0];
    if (formal?.status !== 'completed' || formal.conclusion !== 'success') return false;
    const response = ghRead(['api', `repos/${CONFIG.workflowRepo}/actions/runs/${formal.external_id.slice(prefix.length)}`], { allowFail: true });
    if (!response.ok) return false;
    const workflow = JSON.parse(response.stdout);
    return workflow?.html_url === formal.external_id && workflow.repository?.full_name === CONFIG.workflowRepo
      && workflow.path === '.github/workflows/review-pr.yml' && workflow.event === 'workflow_dispatch'
      && workflow.head_branch === CONFIG.workflowRef && workflow.status === 'completed' && workflow.conclusion === 'success';
  } catch {
    return false;
  }
}

// ── 派发服务器审查 ──────────────────────────────────────────────────────────
// 派发分四个落盘状态,写在轮次目录的 dispatch-intent-<pr>.json:prepared(生成了 dispatch_id、还没外发)→
// dispatching(调 gh workflow run 之前)→ sent(gh 返回成功)→ bound(找到 runId)。恢复时只有 prepared 能证明没外发。
// PR 当前 head(一次 REST 读)。判门是异步的,context 返回后到派发、批准 workflow 之间作者可能推了新提交。读不到返回 null。
function readLiveHead(pr) {
  const r = ghRead(['api', `repos/${CONFIG.targetRepo}/pulls/${pr}`, '--jq', '.head.sha'], { allowFail: true, timeoutMs: 30_000 });
  const head = r.ok ? r.stdout.trim() : '';
  return head && !/\s/.test(head) ? head : null;
}

function dispatchReview(ctx, task, { tier, action }, gateResult) {
  // 判门期间作者推了新提交:不派旧 head 的审查,按状态变化收尾,下一轮按新 head 重判(单审 P1)。读不到 head 照常派,
  // 服务器发布前还会核对 head。
  const liveHead = readLiveHead(task.pr);
  if (liveHead && liveHead !== task.head) {
    log('dispatch-head-moved', { pr: task.pr, head: task.head, liveHead });
    return finishGate(ctx, task, { ...gateResult, outcome: 'state-changed', reason: `判门期间 PR 推了新提交(${liveHead.slice(0, 12)}),这次不派发,下一轮重判` });
  }
  if (!inBusinessWindow()) {
    return finishGate(ctx, task, { ...gateResult, outcome: 'error', reason: '维护窗口(06:00–07:00 Asia/Shanghai)不派服务器审查,07:00 后继续', retry: true });
  }
  // 部署暂停:不派发,也不算失败;上线后的新版本重审。
  if (QUIESCING || deployHold()) {
    log('dispatch-held', { pr: task.pr, head: task.head, reason: 'deploy-hold' });
    return finishGate(ctx, task, { ...gateResult, outcome: 'error', reason: '部署暂停,本次没有派发服务器审查,上线后自动重审', retry: true });
  }
  assertNotFenced();
  const store = loadStore();
  const record = store.prs[task.pr] ?? {};
  if (dispatchesToday() >= CONFIG.dailyCap) {
    return finishGate(ctx, task, { ...gateResult, outcome: 'error', reason: `今日服务器审查已达上限 ${CONFIG.dailyCap} 次,明天继续`, retry: true });
  }
  // attempt = 连续失败数 + 1(服务器据此升级模型、判定最终失败,review-pr.yml 的守卫只收 1–9)。不再累计成功的派发:
  // 摘标签后门禁恢复要再派发一次才能把标签加回,同 head 累计派发满 9 次就加不回来(2026-10-17 补审)。
  // 防失控靠 completedRuns 上限;record.attempts 只留作遥测,旧记录里累计到 9 的 head 也因此自动解开。
  const failure = record.failures?.[task.head];
  const attempt = toDispatchAttempt(failure);
  const retry = toRetryDecision({ failure, attempt, completedRuns: record.completedRuns?.[task.head] ?? 0 });
  if (!retry.dispatch) {
    log('retry-held', { pr: task.pr, head: task.head, attempt, reason: retry.reason });
    return finishGate(ctx, task, { ...gateResult, outcome: 'error', reason: retry.reason, retry: true });
  }
  // 同 head 上一次运行的收口全量没做完(预算不足/收口失败):prev_run_id 指向那次运行,服务器下载后直接全量补跑;否则沿用最近一次完整结果。
  const prevRunId = previousRunIdFor(record, task.head);
  const dispatchId = randomUUID().slice(0, 8);
  const inputs = {
    target_repo: CONFIG.targetRepo, pr: String(task.pr), head_sha: task.head, base_sha: task.base, tier,
    round_id: ctx.plan.runId, mode: CONFIG.mode, action, prev_run_id: String(prevRunId), attempt: String(attempt), dispatch_id: dispatchId,
  };
  // gateResult(判门留下的 errors / warnings / retry / 作者提醒回执)一起落盘:派发后进程重启,恢复出来的 entry 才不会丢掉
  // 「通知没发出去」这类还没了结的状态(否则 round-state 写 retry=false,下一轮判 unchanged,通知永久缺失)。
  const intent = { pr: task.pr, head: task.head, dispatchId, attempt, claimAttempt: task.attempts, tier, action, intentAt: nowIso(), state: 'prepared', gateResult };
  saveIntent(ctx, intent);
  saveIntent(ctx, { ...intent, state: 'dispatching' });
  const args = ['workflow', 'run', 'review-pr.yml', '-R', CONFIG.workflowRepo, '--ref', CONFIG.workflowRef];
  for (const [key, value] of Object.entries(inputs)) args.push('-f', `${key}=${value}`);
  const fired = run('gh', args, { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
  const stderr = String(fired.stderr ?? '').trim().slice(0, 300);
  if (!fired.ok && toDispatchFailure({ stderr: fired.stderr, error: fired.error }) === 'rejected') {
    // 明确被拒(HTTP 4xx 且有错误内容):没有派出,按失败重试。
    saveIntent(ctx, { ...intent, state: 'rejected', error: stderr });
    return finishGate(ctx, task, { ...gateResult, outcome: 'error', reason: `派发服务器审查被拒:${stderr.slice(0, 200)}`, retry: true });
  }
  if (fired.ok) saveIntent(ctx, { ...intent, state: 'sent', sentAt: nowIso() });
  recordDispatch({ at: nowIso(), pr: task.pr, head: task.head, dispatchId, action, ...(fired.ok ? {} : { uncertain: true }) });
  // 超时、断线、5xx 都按「不知道有没有派出」:不重发,先占槽,按 dispatch_id 找回。gh 返回成功也可能一时找不到 run:
  // 只查一次、不等待,没找到的交给 settleDispatch(刚派出的每次轮询都查),主线程不在这里空等。
  const found = fired.ok ? lookupDispatchedRun(task.pr, dispatchId, intent.intentAt) : { runId: null };
  log('dispatched', { pr: task.pr, head: task.head, tier, action, runId: found.runId, dispatchId, prevRunId, attempt,
    ...(fired.ok ? {} : { uncertain: stderr || String(fired.error ?? '').slice(0, 200) }) });
  const entry = { dispatched: true, dispatchId, intentAt: intent.intentAt, attempt, dispatchedAt: nowIso(), gateResult, runId: null, agentId: null,
    ...(fired.ok ? { lookedUpAt: Date.now() } : {}) };
  if (!found.runId) {
    log('dispatch-unknown', { pr: task.pr, head: task.head, dispatchId, sent: fired.ok });
    return entry;
  }
  markBound(ctx, task, entry, found.runId);
  return entry;
}

function intentFile(ctx, pr) { return join(ctx.roundDir, `dispatch-intent-${pr}.json`); }
function cancelIntentFile(ctx, pr) { return join(ctx.roundDir, `cancel-intent-${pr}.json`); }
function resolutionFile(dispatchId) { return stateFile(`dispatch-resolution-${dispatchId}.json`); }
function readIntent(ctx, pr) { return readJson(intentFile(ctx, pr), null); }
function saveIntent(ctx, intent) { writeJson(intentFile(ctx, intent.pr), intent); }

// 派发找到了 run:意图记 bound,登记这个 head 的派发次数。队列绑定由调用方做。
function markBound(ctx, task, entry, runId) {
  entry.runId = String(runId);
  entry.agentId = `gha:${entry.runId}:${entry.dispatchId}`;
  const intent = readIntent(ctx, task.pr) ?? { pr: task.pr, head: task.head, dispatchId: entry.dispatchId, intentAt: entry.intentAt };
  saveIntent(ctx, { ...intent, state: 'bound', runId: entry.runId, boundAt: nowIso() });
  const record = loadStore().prs[task.pr] ?? {};
  bumpStore(task, { attempts: { ...(record.attempts ?? {}), [task.head]: Math.max(Number(entry.attempt) || 1, record.attempts?.[task.head] ?? 0) } });
}

// 按 dispatch_id 在意图时间前后分页找自己派的 run(不只看最近 30 条)。查询失败、列表不完整都算「未知」。
function lookupDispatchedRun(pr, dispatchId, intentAt) {
  const pages = fetchDispatchPages(Date.parse(intentAt));
  return pages ? findDispatchRun(pages, { pr, dispatchId }) : { runId: null };
}

// 意图时间前 5 分钟起派出的 review-pr run,一组分页调用;失败或读不懂返回 null。
function fetchDispatchPages(intentMs) {
  const since = new Date(intentMs - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const r = run('gh', ['api', '--paginate', '--slurp',
    `repos/${CONFIG.workflowRepo}/actions/workflows/review-pr.yml/runs?event=workflow_dispatch&created=>=${since}&per_page=100`],
  { cwd: CONFIG.repoRoot, env: ENV, allowFail: true, timeoutMs: 120_000 });
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// 这次轮询要找 run 的未绑定派发:刚派出 5 分钟内每次轮询都查,之后 3 分钟一次。到期的共用一组分页调用,从其中最早的意图时间查起。
function dispatchLookup(inflight) {
  const now = Date.now();
  const due = [...inflight.values()].filter((entry) => !entry.runId && (!entry.lookedUpAt
    || now - entry.lookedUpAt >= (now - Date.parse(entry.intentAt) < FRESH_DISPATCH_MS ? CONFIG.pollSeconds * 1000 : ADMIT_INTERVAL_MS)));
  if (!due.length) return { due: new Set(), pages: null };
  return { due: new Set(due.map((entry) => entry.dispatchId)), pages: fetchDispatchPages(Math.min(...due.map((entry) => Date.parse(entry.intentAt)))) };
}

// 还不知道有没有派出的派发(runId 为 null):不自动重发。先看人工解除记录,再按 dispatch_id 找 run;
// 都没有就继续占槽,从意图时间起满 60 分钟记 dispatch-unresolved,并登记停写心跳,由看门狗报到 Slack。
// 作者推了新提交不算解除的证据:这个 PR 还在本轮,新 head 要等解除后才派。
function settleDispatch(ctx, entry, lookup) {
  const { task } = entry;
  const resolution = readJson(resolutionFile(entry.dispatchId), null);
  if (resolution) {
    const outcome = applyResolution(ctx, entry, resolution);
    if (outcome) return outcome;
  }
  // 按 dispatch_id 找 run 按 dispatchLookup 的节奏(查到期的才查,结果共用);人工解除记录每次轮询都看。
  if (lookup?.due.has(entry.dispatchId)) {
    entry.lookedUpAt = Date.now();
    const found = lookup.pages ? findDispatchRun(lookup.pages, { pr: task.pr, dispatchId: entry.dispatchId }) : { runId: null };
    if (found.runId) {
      markBound(ctx, task, entry, found.runId);
      bind(ctx.queue, task.pr, entry.agentId);
      log('dispatch-found', { pr: task.pr, dispatchId: entry.dispatchId, runId: entry.runId });
      return 'bound';
    }
  }
  if (Date.now() - Date.parse(entry.intentAt) > DISPATCH_UNRESOLVED_MS) {
    logOnce(`unresolved:${entry.dispatchId}`, 'dispatch-unresolved', { pr: task.pr, head: task.head, dispatchId: entry.dispatchId, intentAt: entry.intentAt });
    pauseHeartbeatFor(ctx, entry);
  }
  return 'pending';
}

// 登记停写心跳(见 heartbeatPaused);已登记的不重复写。
function pauseHeartbeatFor(ctx, entry) {
  const file = stateFile('heartbeat-pause.json');
  const pause = readJson(file, null) ?? {};
  if (pause.dispatches?.[entry.dispatchId]) return;
  writeJson(file, { dispatches: { ...(pause.dispatches ?? {}),
    [entry.dispatchId]: { pr: entry.task.pr, intentAt: entry.intentAt, intentFile: intentFile(ctx, entry.task.pr) } } });
}

// 人工解除记录 <stateDir>/mivo/dispatch-resolution-<dispatch_id>.json,二选一:
//   {"resolution":"not-submitted"}          核实没有派出:按没派出收尾,不计失败,PR 回到候选;
//   {"resolution":"found","runId":"<id>"}   找到了:只把「不知道」变成「已知是这个 run」,占槽不变,run 结束才释放。
// 处理顺序:先把结果写进意图文件,再记 dispatch-resolved,最后删解除记录;中途被杀,重启后只补后两步。
function applyResolution(ctx, entry, resolution) {
  const { task } = entry;
  const intent = readIntent(ctx, task.pr) ?? { pr: task.pr, head: task.head, dispatchId: entry.dispatchId, intentAt: entry.intentAt };
  const kind = resolution?.resolution;
  if (kind === 'not-submitted') {
    saveIntent(ctx, { ...intent, state: 'not-submitted', resolution: { kind, at: nowIso() } });
    finishResolution(readIntent(ctx, task.pr));
    writeTaskResult(ctx, task, { ...entry.gateResult, outcome: 'error', reason: '人工核实这次派发没有发出,下一轮重新送审', retry: true });
    return 'not-submitted';
  }
  if (kind === 'found') {
    const runId = String(resolution.runId ?? '');
    const match = /^\d{1,20}$/.test(runId) ? runMatchesDispatch(runId, task.pr, entry.dispatchId) : 'mismatch';
    if (match === 'unknown') return null;
    if (match === 'mismatch') {
      logOnce(`invalid:${entry.dispatchId}:${runId}`, 'dispatch-resolution-invalid', { pr: task.pr, dispatchId: entry.dispatchId, runId });
      return null;
    }
    saveIntent(ctx, { ...intent, state: 'bound', runId, boundAt: nowIso(), resolution: { kind, runId, at: nowIso() } });
    finishResolution(readIntent(ctx, task.pr));
    markBound(ctx, task, entry, runId);
    bind(ctx.queue, task.pr, entry.agentId);
    return 'bound';
  }
  logOnce(`invalid:${entry.dispatchId}:${kind}`, 'dispatch-resolution-invalid', { pr: task.pr, dispatchId: entry.dispatchId, resolution: kind ?? null });
  return null;
}

// 解除结果已写进意图文件之后的两步:记日志、删解除记录。重复调用不重复记。
function finishResolution(intent) {
  if (!intent?.resolution) return;
  const file = resolutionFile(intent.dispatchId);
  if (!existsSync(file)) return;
  log('dispatch-resolved', { pr: intent.pr, dispatchId: intent.dispatchId, resolution: intent.resolution.kind, runId: intent.resolution.runId ?? null });
  try { unlinkSync(file); } catch { /* 已被删,结果相同 */ }
}

function runMatchesDispatch(runId, pr, dispatchId) {
  const view = run('gh', ['run', 'view', runId, '-R', CONFIG.workflowRepo, '--json', 'displayTitle'], { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
  if (!view.ok) return /not found|HTTP 404/i.test(view.stderr) ? 'mismatch' : 'unknown';
  try { return JSON.parse(view.stdout).displayTitle === `review-pr #${pr} ${dispatchId}` ? 'match' : 'mismatch'; } catch { return 'unknown'; }
}

// PR 当前 head:最多 3 分钟查一次全部开着的 PR(一次分页调用),失败沿用上一次的结果。
function currentHeads() {
  if (HEADS.atMs && Date.now() - HEADS.atMs < ADMIT_INTERVAL_MS) return HEADS.map;
  HEADS.atMs = Date.now();
  const r = ghRead(['api', '--paginate', '--slurp', `repos/${CONFIG.targetRepo}/pulls?state=open&per_page=100`], { allowFail: true, timeoutMs: 60_000 });
  if (!r.ok) { log('heads-skip', { reason: String(r.stderr || r.error || '').trim().slice(0, 200) }); return HEADS.map; }
  try { HEADS.map = new Map(JSON.parse(r.stdout).flat().map((pr) => [Number(pr.number), pr.head?.sha])); } catch { /* 读不懂沿用上次 */ }
  return HEADS.map;
}

// 作者在审查中途推了新提交:先在轮次目录写持久取消意图,再取消旧 run。旧 run 确认结束前仍占槽。
// 已经在取消(换 head 或超时)的不再处理;取消请求失败或迟迟不生效时由 collectServerRun 确认 run 还没结束后重发。
function cancelIfSuperseded(ctx, entry) {
  if (!entry.runId || entry.cancelIntent) return;
  const head = currentHeads()?.get(entry.task.pr);
  if (!head || head === entry.task.head) return;
  entry.cancelIntent = { runId: entry.runId, reason: 'superseded', oldHead: entry.task.head, newHead: head, at: nowIso() };
  writeJson(cancelIntentFile(ctx, entry.task.pr), entry.cancelIntent);
  requestCancel(entry);
}

function requestCancel(entry) {
  assertNotFenced();
  entry.cancelResend = false;
  entry.cancelSentAt = Date.now();
  const intent = entry.cancelIntent;
  const r = run('gh', ['run', 'cancel', entry.runId, '-R', CONFIG.workflowRepo], { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
  log(intent.newHead ? 'cancel-superseded' : 'cancel-timeout', { pr: entry.task.pr, runId: entry.runId,
    ...(intent.newHead ? { oldHead: intent.oldHead, newHead: intent.newHead } : { kind: intent.kind }),
    cancelled: r.ok, ...(r.ok ? {} : { error: String(r.stderr || r.error || '').trim().slice(0, 200) }) });
}

// 换 HEAD 或未派服务器的暂缓判门任务提前释放,新一轮仍执行全部门禁。
function releasePr(ctx, entry) {
  const file = join(ctx.roundDir, 'mivo-released.json');
  const released = { ...readJson(file, {}), [entry.task.pr]: { at: nowIso(), runId: entry.runId,
    oldHead: entry.cancelIntent?.oldHead ?? null, newHead: entry.cancelIntent?.newHead ?? null,
    ...(entry.deferredGate ? { reason: 'gate-deferred', roundId: ctx.plan.runId, pr: entry.task.pr,
      head: entry.task.head, base: entry.task.base, outcome: entry.deferredGate.outcome } : {}) } };
  writeJson(file, released);
  ctx.round.released = released;
  log('pr-released', { pr: entry.task.pr, roundId: ctx.plan.runId, runId: entry.runId, newHead: entry.cancelIntent?.newHead ?? null });
}

function releaseDeferredGates(ctx) {
  if (!ctx.inflight.size) return;
  const planned = ctx.plan.groups.flatMap((group) => group.prs);
  for (const queued of readJson(join(ctx.roundDir, 'queue.json')).tasks) {
    if (ctx.round.released?.[queued.pr] || ctx.inflight.has(queued.pr)) continue;
    const task = { ...planned.find((item) => item.pr === queued.pr), ...queued };
    const result = readJson(join(ctx.roundDir, 'results', `pr-${task.pr}.json`), null);
    const dispatchIntent = existsSync(intentFile(ctx, task.pr)) ? readJson(intentFile(ctx, task.pr)) : null;
    if (!canReleaseDeferredGate({ task, result, roundId: ctx.plan.runId, dispatchIntent })) continue;
    assertNotFenced();
    releasePr(ctx, { task, runId: null, deferredGate: result });
  }
}

// 排队中、执行中的 review-pr run(两组分页调用),按 run id 索引;任一失败返回 null,这次轮询不收结果。
// 先列排队中再列执行中:两次调用之间开始执行的 run 会出现在第二个列表里;两次之间结束的不在列表里,由 readServerRun 单查。
function listActiveRuns() {
  const runs = new Map();
  for (const status of ['queued', 'in_progress']) {
    const r = run('gh', ['api', '--paginate', '--slurp', `repos/${CONFIG.workflowRepo}/actions/workflows/review-pr.yml/runs?status=${status}&per_page=100`],
      { cwd: CONFIG.repoRoot, env: ENV, allowFail: true, timeoutMs: 60_000 });
    if (!r.ok) return null;
    try { for (const item of JSON.parse(r.stdout).flatMap((page) => page?.workflow_runs ?? [])) runs.set(String(item.id), item); } catch { return null; }
  }
  return runs;
}

// 一个在审 run 的当前状态:在 listActiveRuns 的列表里就直接用;不在列表里(多半刚结束)才单查一次;列表没取到返回 null。
function readServerRun(runId, active) {
  if (!active) return null;
  if (active.has(String(runId))) return active.get(String(runId));
  const r = run('gh', ['api', `repos/${CONFIG.workflowRepo}/actions/runs/${runId}`], { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// 服务器 run 结束后取回结果包,写进本轮目录;没结束返回 false。排队和执行分开计时(lib/admission.mjs 的 toRunTiming)。
// active 是这次轮询 listActiveRuns 的结果,所有在审 run 共用。
function collectServerRun(ctx, entry, active) {
  const { task } = entry;
  const info = readServerRun(entry.runId, active);
  if (!info) return false;
  if (info.status !== 'completed') {
    const timing = toRunTiming({ nowMs: Date.now(), run: info });
    if (timing.slow) logOnce(`queue-slow:${entry.runId}`, 'queue-slow', { pr: task.pr, runId: entry.runId, queueMin: Math.round(timing.queueMin) });
    if (entry.cancelIntent) {
      // 已经在取消(换 head 或超时):run 确认结束前一直占槽、不写结果;取消请求失败或迟迟不生效,隔一个检查间隔再发。
      if (entry.cancelResend || Date.now() - (entry.cancelSentAt ?? 0) >= ADMIT_INTERVAL_MS) requestCancel(entry);
      return false;
    }
    if (!timing.cancel) return false;
    // 超时:先写持久取消意图再取消。失败记录和放槽都等 run 确认结束,否则在审数会超过上限、同 head 会在退避后被派第二次。
    entry.cancelIntent = { runId: entry.runId, reason: 'timeout', kind: timing.cancel, at: nowIso() };
    writeJson(cancelIntentFile(ctx, task.pr), entry.cancelIntent);
    requestCancel(entry);
    return false;
  }
  if (entry.cancelIntent && info.conclusion === 'cancelled') {
    if (entry.cancelIntent.newHead) {
      // 作者推了新提交、旧审查已取消:合法终态 state-changed,不算失败,派发账本保留。
      writeTaskResult(ctx, task, { ...entry.gateResult, outcome: 'state-changed', reason: '作者推了新提交,旧审查已取消', retry: true });
      bumpOwned(ctx, task, { lastRunId: entry.runId });
      log('collected', { pr: task.pr, runId: entry.runId, head: task.head, outcome: 'state-changed', superseded: true });
      return true;
    }
    const kind = entry.cancelIntent.kind;
    const reason = kind === 'exec'
      ? `服务器审查执行超过 ${MAX_EXEC_MINUTES} 分钟未结束,已取消`
      : `服务器审查排队超过 ${MAX_QUEUE_MINUTES} 分钟没有开始,已取消`;
    writeTaskResult(ctx, task, { ...entry.gateResult, outcome: 'error', reason, retry: true, enteredReview: kind === 'exec' });
    bumpOwned(ctx, task, { lastRunId: entry.runId });
    recordFailure(ctx, task, true);
    log('collected', { pr: task.pr, runId: entry.runId, head: task.head, outcome: 'error', cancelled: kind });
    return true;
  }
  const dir = join(ctx.roundDir, 'server', `pr-${task.pr}-${entry.runId}`);
  const dl = run('gh', ['run', 'download', entry.runId, '-R', CONFIG.workflowRepo, '-n', `review-pr-${task.pr}`, '-D', dir],
    { cwd: CONFIG.repoRoot, env: ENV, allowFail: true, timeoutMs: 180_000 });
  if (!dl.ok || !existsSync(join(dir, 'result.json'))) {
    writeTaskResult(ctx, task, { ...entry.gateResult, outcome: 'error', reason: `服务器审查没有产出结果(run ${entry.runId} ${info.conclusion})`, retry: true });
    bumpOwned(ctx, task, { lastRunId: entry.runId });
    recordFailure(ctx, task, true);
    log('collected', { pr: task.pr, runId: entry.runId, head: task.head, outcome: 'error', missingResult: true });
    return true;
  }
  const server = readJson(join(dir, 'result.json'));
  if (server.pr !== task.pr || server.head !== task.head || server.runId !== ctx.plan.runId) {
    writeTaskResult(ctx, task, { ...entry.gateResult, outcome: 'error', reason: '服务器结果与任务不匹配(PR/head/轮次)', retry: true });
    recordFailure(ctx, task, true);
    return true;
  }
  // 服务器复核没认到放行时只回 protected、不带作者提醒回执:沿用前置判门这一轮的回执,否则整轮汇总会抛错。
  const result = withProtectedGateRetry(withProtectedAuthorNotice({ ...server }, { gateResult: entry.gateResult, head: task.head }), entry.gateResult);
  if (existsSync(join(dir, 'report.md'))) {
    const reportFile = join(ctx.roundDir, 'reports', `pr-${task.pr}.md`);
    mkdirSync(dirname(reportFile), { recursive: true });
    copyFileSync(join(dir, 'report.md'), reportFile);
    result.reportFile = reportFile;
  } else delete result.reportFile;
  if (existsSync(join(dir, 'finish.json'))) copyFileSync(join(dir, 'finish.json'), join(ctx.roundDir, `finish-pr-${task.pr}.json`));
  result.errors = [...(entry.gateResult?.errors ?? []), ...(server.errors ?? [])];
  result.warnings = [...(entry.gateResult?.warnings ?? []), ...(server.warnings ?? [])];
  result.mivo = { ...server.mivo, filePatchHashes: undefined, filePatchHashesV2: undefined, findings: (server.mivo?.findings ?? []).length, deferred: (server.mivo?.deferred ?? []).length };
  writeTaskResult(ctx, task, result, { raw: true });
  if (server.mivo?.quota) {
    writeJson(stateFile('pause.json'), { until: new Date(Date.now() + QUOTA_PAUSE_MS).toISOString(), reason: server.reason, runId: entry.runId });
    log('quota-pause', { pr: task.pr, reason: server.reason });
  }
  noteKeyState(server, { pr: task.pr, runId: entry.runId });
  const health = server.mivo?.health;
  let completedRun = false;
  if (health && health.ok === false) {
    // 维护窗口或工具链不健康:服务器没有审,这次派发不算一次尝试;工具链不健康时暂停派发 30 分钟再试。
    const record = loadStore().prs[task.pr] ?? {};
    bumpOwned(ctx, task, { attempts: { ...(record.attempts ?? {}), [task.head]: Math.max(0, (record.attempts?.[task.head] ?? 1) - 1) } });
    if (health.reason !== 'outside-business-window') {
      writeJson(stateFile('pause.json'), { until: new Date(Date.now() + HEALTH_PAUSE_MS).toISOString(), reason: server.reason, runId: entry.runId });
      log('health-pause', { pr: task.pr, reason: server.reason });
    }
  } else if (isGithubRateLimited(server) && (loadStore().prs[task.pr]?.rateLimitRefunds?.[task.head] ?? 0) < RATE_LIMIT_REFUNDS_PER_HEAD) {
    // GitHub 限额用完:服务器没读到 PR 信息就没审成,这次派发不算一次尝试、也不算一次失败,
    // 同一提交的派发上限和退避不被白白占用。不加整体暂停:额度没恢复时下一轮 pre-check 自己会失败,也就不会派发;
    // 自带封顶:同一个提交最多退回 RATE_LIMIT_REFUNDS_PER_HEAD 次,之后照旧记失败走退避。
    const record = loadStore().prs[task.pr] ?? {};
    const refunds = record.rateLimitRefunds?.[task.head] ?? 0;
    bumpOwned(ctx, task, {
      attempts: { ...(record.attempts ?? {}), [task.head]: Math.max(0, (record.attempts?.[task.head] ?? 1) - 1) },
      rateLimitRefunds: { ...(record.rateLimitRefunds ?? {}), [task.head]: refunds + 1 },
    });
    log('github-rate-limited', { pr: task.pr, runId: entry.runId, head: task.head, refunds: refunds + 1 });
  } else {
    recordFailure(ctx, task, server.outcome === 'error');
    completedRun = server.outcome !== 'error';
  }
  bumpOwned(ctx, task, {
    lastRunId: entry.runId,
    // 这次收回的是一次完成的审查(不是失败、不是健康/限额退回):累计这个 head 的已完成次数,toRetryDecision 据此封顶。
    ...(completedRun ? { completedRuns: toCompletedRunsRecord(loadStore().prs[task.pr]?.completedRuns, task.head) } : {}),
    ...(server.reviewed && server.mivo?.reportComplete ? { lastCompleteRunId: entry.runId } : {}),
    ...finalFullStorePatch({ server, head: task.head, record: loadStore().prs[task.pr] ?? {}, runId: entry.runId }),
    ...(server.reviewClean && ['review-only', 'approval'].includes(server.outcome) ? { cleanHead: task.head } : {}),
    // 服务器评估的代码扫描三态:wakeCodeScanPrs 的对照基线。
    ...toCodeScanRecord({ codeScan: server.mivo?.codeScan, head: task.head, base: task.baseRefName, completed: completedRun, at: nowIso() }),
  });
  log('collected', { pr: task.pr, runId: entry.runId, head: task.head, outcome: server.outcome, reviewClean: server.reviewClean });
  return true;
}

// 收口全量的补跑游标(store.prs[pr].pendingFinalFull = { head, runId }):
// 同 head 的待补/收口失败包 → 记下那次运行(服务器按 prev_run_id 下载后直接全量),并清掉这个 head 的 cleanHead,旧的干净缓存不能抑制补跑;
// 同 head 的收口/全量真的做完了(clean / findings / manual-review,且顶层不是 error)→ 清游标;
// 其余(普通失败、取消、没有结果包)不动游标,不能被后一次失败覆盖。待补不更新 lastCompleteRunId(那里只认完整结果)。
function finalFullStorePatch({ server, head, record, runId }) {
  const pending = previousFromResult(server).pendingFinalFull;
  if (pending && pending.head === head && server.head === head) {
    return { pendingFinalFull: { head, runId: String(pending.runId) }, ...(record?.cleanHead === head ? { cleanHead: null } : {}) };
  }
  const done = server.mivo?.finalFull;
  const completed = server.outcome !== 'error' && done && done.head === head && server.head === head && String(done.runId) === String(server.mivo?.runId)
    && ['clean', 'findings', 'manual-review'].includes(done.outcome);
  if (completed && record?.pendingFinalFull) return { pendingFinalFull: null };
  return {};
}

// 派发时的 prev_run_id:同 head 有待补游标就用它,否则用最近一次完整结果。新 head 永远不消费旧 head 的游标。
function previousRunIdFor(record, head) {
  const pending = record?.pendingFinalFull;
  if (pending && pending.head === head && /^\d{1,15}$/.test(String(pending.runId ?? ''))) return String(pending.runId);
  return record?.lastCompleteRunId ?? '';
}

function bumpStore(task, patch) {
  const store = loadStore();
  store.prs[task.pr] = { ...(store.prs[task.pr] ?? {}), ...patch, updatedAt: nowIso() };
  saveStore(store);
}

// 归属已经转给更新的轮次(作者推了新提交、旧轮晚收尾)时不写回:旧结果不覆盖新 head 的 cleanHead、lastCompleteRunId。
function bumpOwned(ctx, task, patch) {
  const owner = loadStore().prs[task.pr]?.ownerRoundId;
  if (owner && owner !== ctx.plan.runId) {
    logOnce(`stale-owner:${ctx.plan.runId}:${task.pr}`, 'store-skip', { pr: task.pr, roundId: ctx.plan.runId, owner });
    return;
  }
  bumpStore(task, patch);
}

// 记这个 head 的一次失败或成功,dispatchReview 据此退避(规则见 lib/retry.mjs)。
function recordFailure(ctx, task, failed) {
  const record = loadStore().prs[task.pr] ?? {};
  bumpOwned(ctx, task, { failures: toFailureRecord(record.failures, task.head, failed, nowIso()) });
}

function finishGate(ctx, task, result) {
  writeTaskResult(ctx, task, result);
  return { dispatched: false };
}

// pr-worker 第 6 节的终态文件;判门阶段的结果都没有进入代码审查。
function writeTaskResult(ctx, task, result, { raw = false } = {}) {
  const base = raw ? {} : { enteredReview: false, reviewed: false, reviewClean: false, merged: false, threadUrls: [] };
  const payload = dropStaleProtectedNotice({
    runId: ctx.plan.runId, mode: 'review-only', pr: task.pr, head: task.head, base: task.base,
    ...base, ...result,
    outcome: result.outcome ?? 'error', reason: String(result.reason || result.outcome || '未知'),
    errors: result.errors ?? [], warnings: result.warnings ?? [],
  });
  if (!raw && payload.outcome === 'error') payload.retry = true;
  writeJson(task.resultFile, payload);
}

main().catch((error) => {
  log('round-error', { error: error.message });
  console.error(`[prereview] ${error.message}`);
  process.exitCode = 1;
});
