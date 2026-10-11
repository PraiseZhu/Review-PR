#!/usr/bin/env node
// round.mjs — Mini 上的前置审查,一次运行处理一轮(launchd 每 3 分钟拉起一次)。
// 流程照搬 review-pr-auto 的主 session:pre-check → prepare → plan → 滚动队列 → finalize。
// 不同点只有一处(D1):每个 PR 的「子 agent」拆成两段——判门在本机用 Cindy 脚本做完(不调模型),
// 需要代码审查时派发服务器上的 review-pr.yml,服务器审完把结果包回传,这里写进本轮目录。
//
//   node mivo/prereview/round.mjs --config <配置 JSON>
// 配置字段见 mivo/README.md。退出码:0=正常(含没有候选),1=本轮异常。
import { existsSync, mkdirSync, readFileSync, copyFileSync, appendFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SKILL_ROOT, SCRIPTS, MODES, run, runScript, readJson, writeJson, writeText, nowIso } from '../lib/common.mjs';
import { decideGate, buildSignoffPayload, buildGatePushback } from '../lib/gates.mjs';
import { inBusinessWindow } from '../lib/health.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MERGE_READY_LABEL = 'review:merge-ready';
const QUOTA_PAUSE_MS = 60 * 60_000;
const HEALTH_PAUSE_MS = 30 * 60_000;
const MAX_RUN_MINUTES = 120;

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
  return config;
}

let CONFIG;
let ENV;
let LOG_FILE;

function setupEnv(config) {
  const env = { ...process.env, REVIEW_PR_REPO_ROOT: config.repoRoot, REVIEW_PR_STATE_DIR: config.stateDir };
  if (config.rulesFile) env.REVIEW_PR_RULES_FILE = config.rulesFile;
  else delete env.REVIEW_PR_RULES_FILE;
  if (config.mode === 'dry-run') {
    // dry-run:Cindy 脚本里的任何 GitHub 写入都被垫片拦下;只放行派发 dry-run 服务器审查。
    const realGh = run('/bin/sh', ['-c', 'command -v gh']).stdout.trim();
    env.MIVO_REAL_GH = realGh;
    env.MIVO_DRYRUN_ALLOW_DISPATCH = '1';
    env.MIVO_DRYRUN_LOG = join(config.logDir, 'dry-run-blocked.log');
    env.PATH = `${join(HERE, 'gh-dryrun')}:${env.PATH}`;
  }
  return env;
}

function log(event, detail = {}) {
  const line = JSON.stringify({ at: nowIso(), event, ...detail });
  try { appendFileSync(LOG_FILE, `${line}\n`); } catch { /* 日志失败不影响本轮 */ }
  if (process.env.MIVO_PREREVIEW_VERBOSE) console.log(line);
}

const script = (name, args, options = {}) => runScript(name, args, { cwd: CONFIG.repoRoot, env: ENV, ...options });
const ghRead = (args, options = {}) => run('gh', args, { cwd: CONFIG.repoRoot, env: ENV, ...options });
const stateFile = (name) => join(CONFIG.stateDir, 'mivo', name);

// ── 本机记录:每个 PR 的服务器审查记录、每日派发账本、额度暂停 ─────────────
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

// ── 讨论 issue 有新留言(Slack 同步)时唤醒对应 PR ──────────────────────────
// pre-check 的指纹只看 PR 自身;Slack「同意放行」落在讨论 issue 上,不改 PR 的指纹。
// 这里比对确认 issue 的 updatedAt,变了就把本机 round-state 里该 PR 标成需要重查。
function wakeHeldPrs() {
  const issues = ghRead(['api', '--method', 'GET', '--paginate', '--slurp', `repos/${CONFIG.targetRepo}/issues`,
    '-f', 'state=open', '-f', 'per_page=100'], { allowFail: true });
  if (!issues.ok) { log('wake-held-skip', { reason: issues.stderr.trim().slice(0, 200) }); return; }
  const seenFile = stateFile('held-issues.json');
  const seen = readJson(seenFile, {});
  const next = {};
  const wake = [];
  for (const issue of JSON.parse(issues.stdout).flat()) {
    if (issue.pull_request) continue;
    const m = String(issue.title ?? '').match(/^维护者确认 · PR #(\d+)/);
    if (!m) continue;
    next[issue.number] = { pr: Number(m[1]), updatedAt: issue.updated_at };
    if (seen[issue.number] && seen[issue.number].updatedAt !== issue.updated_at) wake.push(Number(m[1]));
  }
  if (wake.length) {
    const rs = readJson(join(CONFIG.stateDir, roundStateKey(), 'round-state.json'), null);
    if (rs?.prs) {
      for (const pr of wake) if (rs.prs[pr]) rs.prs[pr].retry = true;
      writeJson(join(CONFIG.stateDir, roundStateKey(), 'round-state.json'), rs);
    }
    log('wake-held', { prs: wake });
  }
  writeJson(seenFile, next);
}

// Cindy 的状态目录按目标仓库 git common-dir 的哈希分子目录;用 lib 的同一算法定位。
let STATE_KEY = null;
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
  LOG_FILE = join(CONFIG.logDir, `round-${new Date().toISOString().slice(0, 10)}.jsonl`);
  ENV = setupEnv(CONFIG);
  const pause = pausedUntil();
  if (pause) { log('paused', pause); return; }
  // 与老审查机同一个维护窗口:06:00–07:00(Asia/Shanghai)不开新一轮;07:00 后照常采集,窗口里来的 PR 自动补上。
  if (!inBusinessWindow()) { log('maintenance-window'); return; }
  verifySkillPin();
  wakeHeldPrs();

  const pre = runScript('pre-check.mjs', ['--repo-root', CONFIG.repoRoot, '--review-only'], { cwd: CONFIG.repoRoot, env: ENV, timeoutMs: 120_000 });
  if (pre.exitCode === 2) { log('no-candidates', { reason: pre.reason }); return; }
  if (pre.exitCode !== 0 || !pre.decision) throw new Error(`pre-check 失败:${pre.error || pre.reason || `exit ${pre.exitCode}`}`);

  const prep = script('prepare.mjs', ['--skip-skill-pull']);
  if (!prep.ok || !prep.lock?.acquired) { log('lock-not-acquired', { lock: prep.lock, error: prep.error }); return; }
  if (!prep.maintainerAuthority?.verified) throw new Error(`维护者权限未核实:${prep.error}`);
  const token = prep.lock.token;
  try {
    let planFile;
    if (pre.reason === 'unfinished-round') {
      planFile = pre.resumePlan;
      log('resume-round', { planFile });
    } else {
      const plan = script('plan-review-round.mjs', ['--lock-token', token, '--mode', 'review-only', '--candidate-list', pre.candidateList], { timeoutMs: 1_800_000 });
      if (!plan.ok) throw new Error(`plan 失败:${plan.error}`);
      planFile = plan.planFile;
      log('plan', { runId: plan.runId, groups: plan.groups?.map((g) => g.prs.map((p) => p.pr)), skipped: plan.skipped?.map((s) => [s.pr, s.outcome]) });
    }
    await drive(planFile, token, prep.maintainerAuthority.digest);
    if (CONFIG.mode === 'live') {
      const sweep = script('close-product-issue.mjs', ['--sweep']);
      log('product-issue-sweep', { closed: sweep.closedCount, error: sweep.error });
    }
  } finally {
    script('release-lock.mjs', ['--token', token]);
  }
}

function verifySkillPin() {
  const own = run('git', ['-C', SKILL_ROOT, 'rev-parse', 'HEAD']).stdout.trim();
  const pinned = ghRead(['variable', 'get', 'MIVO_REVIEW_SKILL_SHA', '-R', CONFIG.workflowRepo], { allowFail: true }).stdout.trim();
  if (own !== pinned) throw new Error(`本机 skill 版本 ${own.slice(0, 12)} 与服务器钉住的 MIVO_REVIEW_SKILL_SHA ${pinned.slice(0, 12) || '(未设置)'} 不一致,拒绝运行`);
}

async function drive(planFile, token, authorityDigest) {
  const queue = (action, extra = []) => runScript('review-queue.mjs', [action, '--plan', planFile, '--lock-token', token, ...extra],
    { cwd: CONFIG.repoRoot, env: ENV, timeoutMs: 600_000 });
  const plan = readJson(planFile);
  const roundDir = dirname(planFile);
  if (!existsSync(join(roundDir, 'queue.json'))) {
    const init = queue('init', ['--concurrency', String(CONFIG.maxParallel)]);
    if (!init.ok) throw new Error(`queue init 失败:${init.error}`);
  }
  const watch = spawn(process.execPath, [join(SCRIPTS, 'review-queue.mjs'), 'watch', '--plan', planFile, '--lock-token', token],
    { cwd: CONFIG.repoRoot, env: ENV, stdio: 'ignore' });
  const inflight = new Map();
  try {
    resumeInflight({ plan, planFile, roundDir }, inflight, queue);
    for (let pass = 0; pass < 2; pass += 1) {
      await runQueue({ plan, planFile, roundDir, token, authorityDigest, queue, inflight });
      const reconcile = queue('reconcile');
      if (!reconcile.ok) throw new Error(`reconcile 失败:${reconcile.error}`);
      log('reconcile', { reopened: reconcile.reopened, allComplete: reconcile.allComplete });
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
    log('round-complete', { runId: plan.runId, entered: final.enteredCount, skipped: final.skippedCount });
  } finally {
    queue('stop');
    watch.kill('SIGTERM');
  }
}

async function runQueue(ctx) {
  const { queue, inflight } = ctx;
  for (;;) {
    queue('status');
    for (;;) {
      const claim = queue('claim');
      if (!claim.ok) throw new Error(`claim 失败:${claim.error}`);
      if (!claim.claimed) break;
      const task = claim.task;
      try {
        const outcome = await handleTask(ctx, task);
        if (outcome.dispatched) {
          bind(queue, task.pr, outcome.agentId);
          inflight.set(task.pr, { ...outcome, task });
        } else {
          const agentId = `mini-gate:${task.pr}:${randomUUID().slice(0, 8)}`;
          bind(queue, task.pr, agentId);
          completeTask(queue, task.pr, agentId);
        }
      } catch (error) {
        log('task-error', { pr: task.pr, error: error.message });
        writeTaskResult(ctx, task, { outcome: 'error', reason: `前置审查异常:${error.message}`, retry: true, errors: [error.message] });
        const agentId = `mini-gate:${task.pr}:${randomUUID().slice(0, 8)}`;
        bind(queue, task.pr, agentId);
        completeTask(queue, task.pr, agentId);
      }
    }
    for (const [pr, entry] of inflight) {
      const done = collectServerRun(ctx, entry);
      if (!done) continue;
      completeTask(queue, pr, entry.agentId);
      inflight.delete(pr);
    }
    const status = queue('status');
    if (!inflight.size && (status.queued?.length ?? 0) === 0 && (status.active?.length ?? 0) === 0) return;
    await new Promise((r) => setTimeout(r, CONFIG.pollSeconds * 1000));
  }
}

function bind(queue, pr, agentId) {
  const r = queue('bind', ['--pr', String(pr), '--agent-id', agentId]);
  if (!r.ok) throw new Error(`bind #${pr} 失败:${r.error}`);
}
function completeTask(queue, pr, agentId) {
  const r = queue('complete', ['--pr', String(pr), '--agent-id', agentId, '--agent-exited']);
  if (!r.ok) throw new Error(`complete #${pr} 失败:${r.error}`);
}

// 中断后恢复:队列里已绑定到服务器 run 的任务继续轮询;本机判门任务(同步完成)若中途断了,
// 有结果就补 complete,没结果就补一条 error 结果再 complete;只领取没绑定的,当作没启动过。
function resumeInflight(ctx, inflight, queue) {
  const queueFile = join(ctx.roundDir, 'queue.json');
  if (!existsSync(queueFile)) return;
  const planned = ctx.plan.groups.flatMap((g) => g.prs);
  for (const task of readJson(queueFile).tasks) {
    if (['queued', 'complete'].includes(task.phase)) continue;
    const item = { ...planned.find((p) => p.pr === task.pr), ...task, resultFile: join(ctx.roundDir, 'results', `pr-${task.pr}.json`) };
    const m = String(task.agentId ?? '').match(/^gha:(\d+):/);
    if (m && task.phase === 'running') {
      inflight.set(task.pr, { dispatched: true, agentId: task.agentId, runId: m[1], task: item, dispatchedAt: task.boundAt, gateResult: {} });
      continue;
    }
    if (!existsSync(item.resultFile)) writeTaskResult(ctx, item, { outcome: 'error', reason: '上次运行在判门中途中断,下一轮重新处理', retry: true });
    if (task.agentId) completeTask(queue, task.pr, task.agentId);
    else {
      const r = queue('complete', ['--pr', String(task.pr), '--no-agent-started', '--agent-exited']);
      if (!r.ok) throw new Error(`恢复 #${task.pr} 失败:${r.error}`);
    }
    log('resume-orphan', { pr: task.pr, phase: task.phase });
  }
}

// ── 单个 PR:判门(本机) ─────────────────────────────────────────────────────
async function handleTask(ctx, task) {
  const { roundDir, token, authorityDigest } = ctx;
  const liveFile = join(roundDir, `pr-${task.pr}-live.json`);
  const live = script('context.mjs', [String(task.pr), '--lock-token', token, '--cached-context', task.contextFile,
    '--diff-output', join(roundDir, `pr-${task.pr}-live.diff`)], { timeoutMs: 300_000 });
  writeJson(liveFile, live);
  if (!live.ok) return finishGate(ctx, task, { outcome: 'error', reason: `context 读取失败:${live.error}`, retry: true, errors: [live.error] });
  if (live.meta.state !== 'OPEN' || live.meta.isDraft || live.meta.headRefOid !== task.head ||
      live.meta.baseRefOid !== task.base || live.meta.baseRefName !== task.baseRefName) {
    return finishGate(ctx, task, { outcome: 'state-changed', reason: '名单生成后 PR 已关闭、转 draft,或 head/base 已变化;下轮重新采集' });
  }
  const bindings = ['--lock-token', token, '--expected-head', task.head, '--expected-authority-digest', authorityDigest];
  const decision = decideGate(live);
  const result = { outcome: decision.outcome, reason: decision.reason, errors: [], warnings: [], gate: { stage: decision.stage, actions: decision.actions } };
  const dry = CONFIG.mode === 'dry-run';
  if (dry && decision.actions.length) result.dryRunActions = decision.actions.map((a) => `${a.script}${a.mode ? `:${a.mode}` : ''}${a.kind ? `:${a.kind}` : ''}${a.gateKind ? `:${a.gateKind}` : ''}`);

  for (const action of dry ? [] : decision.actions) executeGateAction({ action, live, task, bindings, result, roundDir });
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
  if (!dry) syncDisplayLabels(live, task, result);
  if (!dry) dropStaleMergeReady(live, task, result);

  if (decision.stage === 'protected' && decision.outcome === 'protected') {
    const manual = manualProtectedApproval(live, task);
    if (manual) return dispatchReview(ctx, task, { tier: live.review?.tier ?? 'standard', action: 'protected-approve' }, result);
  }
  if (decision.stage !== 'review') {
    if (decision.retry) result.retry = true;
    return finishGate(ctx, task, result);
  }
  return dispatchReview(ctx, task, { tier: decision.tier, action: 'review' }, result);
}

function executeGateAction({ action, live, task, bindings, result, roundDir }) {
  const pr = String(task.pr);
  const record = (name, out) => {
    result.gate[name] = out;
    if (out?.ok === false || out?.error) result.errors.push(`${name}:${out.error || out.reason || '失败'}`);
    if (out?.labelWarning) result.warnings.push(`${name}:${out.labelWarning}`);
  };
  switch (action.script) {
    case 'signoff-hold': {
      const payloadFile = join(roundDir, `signoff-payload-pr-${pr}.json`);
      writeJson(payloadFile, buildSignoffPayload(live, action.kind));
      const args = action.mode === 'labels-only'
        ? [pr, '--labels-only', '--kind', action.kind, ...bindings]
        : [pr, '--kind', action.kind, '--payload-file', payloadFile, ...bindings];
      let out = script('signoff-hold.mjs', args);
      if (out.needsFreshHold || out.reason === 'missing-payload') out = script('signoff-hold.mjs', [pr, '--kind', action.kind, '--payload-file', payloadFile, ...bindings]);
      if (out.issueError) result.errors.push(`确认 issue 创建失败:${out.issueError}`);
      if (out.commentError) result.errors.push(`确认首评发布失败:${out.commentError}`);
      record('signoffHold', out);
      if (out.issueError || out.commentError) result.retry = true;
      break;
    }
    case 'signoff-release': {
      const args = [pr, '--labels-only', ...(action.mode === 'labels-only-close-issue' ? ['--close-issue'] : []), ...bindings];
      record('signoffRelease', script('signoff-release.mjs', args));
      break;
    }
    case 'close-product-issue':
      record('closeProductIssue', script('close-product-issue.mjs', [pr, '--no-longer-required']));
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
      const out = script('request-changes-reviewed-pr.mjs', args, { timeoutMs: 180_000 });
      record('pushback', out);
      if (out.submitted) result.threadUrls = out.threadUrls ?? [];
      else result.retry = true;
      break;
    }
    case 'notify-protected': {
      const out = script('notify-author-resolve.mjs', [pr, '--protected-path', ...bindings]);
      result.authorNotice = noticeFrom('protected-path', out, task.head);
      if (result.authorNotice.status === 'failed') result.retry = true;
      break;
    }
    case 'notify-rebase': {
      const out = script('notify-author-resolve.mjs', [pr, '--stale-rebase', ...bindings]);
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
      record('approveWorkflows', script('approve-workflows.mjs', [pr]));
      result.retry = true;
      break;
    case 'retry-ci': {
      const out = script('retry-ci.mjs', [pr, ...bindings]);
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
  const out = script('sync-status-labels.mjs', [String(task.pr), '--desired', (labels.desired ?? []).join(','), '--current', (labels.current ?? []).join(',')]);
  if (out.warning || out.errors?.length) result.warnings.push(`展示标签同步:${out.warning || out.errors.join('; ')}`);
}

// head 变了就摘掉旧的 review:merge-ready(它只对审查通过的那个 head 有效)。
function dropStaleMergeReady(live, task, result) {
  if (!(live.meta?.labels ?? []).includes(MERGE_READY_LABEL)) return;
  const record = loadStore().prs[task.pr];
  if (record?.cleanHead === task.head) return;
  const r = run('gh', ['api', '--method', 'DELETE', `repos/${CONFIG.targetRepo}/issues/${task.pr}/labels/${encodeURIComponent(MERGE_READY_LABEL)}`],
    { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
  if (!r.ok && !/404/.test(r.stderr)) result.warnings.push(`review:merge-ready 没摘掉:${r.stderr.trim().slice(0, 200)}`);
}

// 受保护路径:维护者(非作者)在当前 head 上 Approve 了,且 review-pr check 还没写成 success,就派「人工放行」。
function manualProtectedApproval(live, task) {
  const maintainers = new Set((live.signoff?.maintainers ?? []).map((m) => String(m).toLowerCase()));
  const author = String(live.meta?.author ?? '').toLowerCase();
  const reviews = ghRead(['api', '--paginate', '--slurp', `repos/${CONFIG.targetRepo}/pulls/${task.pr}/reviews?per_page=100`], { allowFail: true });
  if (!reviews.ok) return null;
  const approved = JSON.parse(reviews.stdout).flat().some((r) => r.state === 'APPROVED' && r.commit_id === task.head &&
    maintainers.has(String(r.user?.login ?? '').toLowerCase()) && String(r.user?.login ?? '').toLowerCase() !== author);
  if (!approved) return null;
  const checks = ghRead(['api', `repos/${CONFIG.targetRepo}/commits/${task.head}/check-runs?check_name=review-pr`], { allowFail: true });
  const done = checks.ok && (JSON.parse(checks.stdout).check_runs ?? []).some((c) => c.conclusion === 'success');
  return done ? null : { approved: true };
}

// ── 派发服务器审查 ──────────────────────────────────────────────────────────
function dispatchReview(ctx, task, { tier, action }, gateResult) {
  if (!inBusinessWindow()) {
    return finishGate(ctx, task, { ...gateResult, outcome: 'error', reason: '维护窗口(06:00–07:00 Asia/Shanghai)不派服务器审查,07:00 后继续', retry: true });
  }
  const store = loadStore();
  const record = store.prs[task.pr] ?? {};
  if (dispatchesToday() >= CONFIG.dailyCap) {
    return finishGate(ctx, task, { ...gateResult, outcome: 'error', reason: `今日服务器审查已达上限 ${CONFIG.dailyCap} 次,明天继续`, retry: true });
  }
  const attempt = (record.attempts?.[task.head] ?? 0) + 1;
  const prevRunId = record.lastCompleteRunId ?? '';
  const dispatchId = randomUUID().slice(0, 8);
  const inputs = {
    target_repo: CONFIG.targetRepo, pr: String(task.pr), head_sha: task.head, base_sha: task.base, tier,
    round_id: ctx.plan.runId, mode: CONFIG.mode, action, prev_run_id: String(prevRunId), attempt: String(attempt), dispatch_id: dispatchId,
  };
  const args = ['workflow', 'run', 'review-pr.yml', '-R', CONFIG.workflowRepo, '--ref', CONFIG.workflowRef];
  for (const [key, value] of Object.entries(inputs)) args.push('-f', `${key}=${value}`);
  const fired = run('gh', args, { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
  if (!fired.ok) return finishGate(ctx, task, { ...gateResult, outcome: 'error', reason: `派发服务器审查失败:${fired.stderr.trim().slice(0, 200)}`, retry: true });
  const runId = findDispatchedRun(task.pr, dispatchId);
  recordDispatch({ at: nowIso(), pr: task.pr, head: task.head, runId, dispatchId, action });
  log('dispatched', { pr: task.pr, head: task.head, tier, action, runId, prevRunId, attempt });
  if (!runId) return finishGate(ctx, task, { ...gateResult, outcome: 'error', reason: '已派发但找不到对应的服务器 run', retry: true });
  record.attempts = { ...(record.attempts ?? {}), [task.head]: attempt };
  store.prs[task.pr] = record;
  saveStore(store);
  return { dispatched: true, agentId: `gha:${runId}:${dispatchId}`, runId, dispatchedAt: nowIso(), gateResult };
}

function findDispatchedRun(pr, dispatchId) {
  const title = `review-pr #${pr} ${dispatchId}`;
  for (let i = 0; i < 12; i += 1) {
    const list = run('gh', ['run', 'list', '-R', CONFIG.workflowRepo, '--workflow', 'review-pr.yml', '--event', 'workflow_dispatch',
      '--limit', '30', '--json', 'databaseId,displayTitle'], { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
    if (list.ok) {
      const hit = JSON.parse(list.stdout).find((r) => r.displayTitle === title);
      if (hit) return String(hit.databaseId);
    }
    run('sleep', ['5']);
  }
  return null;
}

// 服务器 run 结束后取回结果包,写进本轮目录;没结束返回 false。
function collectServerRun(ctx, entry) {
  const { task } = entry;
  const view = run('gh', ['run', 'view', entry.runId, '-R', CONFIG.workflowRepo, '--json', 'status,conclusion,createdAt'],
    { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
  if (!view.ok) return false;
  const info = JSON.parse(view.stdout);
  if (info.status !== 'completed') {
    if (Date.now() - Date.parse(info.createdAt) > MAX_RUN_MINUTES * 60_000) {
      run('gh', ['run', 'cancel', entry.runId, '-R', CONFIG.workflowRepo], { cwd: CONFIG.repoRoot, env: ENV, allowFail: true });
      writeTaskResult(ctx, task, { ...entry.gateResult, outcome: 'error', reason: `服务器审查超过 ${MAX_RUN_MINUTES} 分钟未结束,已取消`, retry: true, enteredReview: true });
      bumpStore(task, { lastRunId: entry.runId });
      return true;
    }
    return false;
  }
  const dir = join(ctx.roundDir, 'server', `pr-${task.pr}-${entry.runId}`);
  const dl = run('gh', ['run', 'download', entry.runId, '-R', CONFIG.workflowRepo, '-n', `review-pr-${task.pr}`, '-D', dir],
    { cwd: CONFIG.repoRoot, env: ENV, allowFail: true, timeoutMs: 180_000 });
  if (!dl.ok || !existsSync(join(dir, 'result.json'))) {
    writeTaskResult(ctx, task, { ...entry.gateResult, outcome: 'error', reason: `服务器审查没有产出结果(run ${entry.runId} ${info.conclusion})`, retry: true });
    bumpStore(task, { lastRunId: entry.runId });
    return true;
  }
  const server = readJson(join(dir, 'result.json'));
  if (server.pr !== task.pr || server.head !== task.head || server.runId !== ctx.plan.runId) {
    writeTaskResult(ctx, task, { ...entry.gateResult, outcome: 'error', reason: '服务器结果与任务不匹配(PR/head/轮次)', retry: true });
    return true;
  }
  const result = { ...server };
  if (existsSync(join(dir, 'report.md'))) {
    const reportFile = join(ctx.roundDir, 'reports', `pr-${task.pr}.md`);
    mkdirSync(dirname(reportFile), { recursive: true });
    copyFileSync(join(dir, 'report.md'), reportFile);
    result.reportFile = reportFile;
  } else delete result.reportFile;
  if (existsSync(join(dir, 'finish.json'))) copyFileSync(join(dir, 'finish.json'), join(ctx.roundDir, `finish-pr-${task.pr}.json`));
  result.errors = [...(entry.gateResult?.errors ?? []), ...(server.errors ?? [])];
  result.warnings = [...(entry.gateResult?.warnings ?? []), ...(server.warnings ?? [])];
  result.mivo = { ...server.mivo, filePatchHashes: undefined, findings: (server.mivo?.findings ?? []).length };
  writeTaskResult(ctx, task, result, { raw: true });
  if (server.mivo?.quota) {
    writeJson(stateFile('pause.json'), { until: new Date(Date.now() + QUOTA_PAUSE_MS).toISOString(), reason: server.reason, runId: entry.runId });
    log('quota-pause', { pr: task.pr, reason: server.reason });
  }
  const health = server.mivo?.health;
  if (health && health.ok === false) {
    // 维护窗口或工具链不健康:服务器没有审,这次派发不算一次尝试;工具链不健康时暂停派发 30 分钟再试。
    const record = loadStore().prs[task.pr] ?? {};
    bumpStore(task, { attempts: { ...(record.attempts ?? {}), [task.head]: Math.max(0, (record.attempts?.[task.head] ?? 1) - 1) } });
    if (health.reason !== 'outside-business-window') {
      writeJson(stateFile('pause.json'), { until: new Date(Date.now() + HEALTH_PAUSE_MS).toISOString(), reason: server.reason, runId: entry.runId });
      log('health-pause', { pr: task.pr, reason: server.reason });
    }
  }
  bumpStore(task, {
    lastRunId: entry.runId,
    ...(server.reviewed && server.mivo?.reportComplete ? { lastCompleteRunId: entry.runId } : {}),
    ...(server.reviewClean && ['review-only', 'approval'].includes(server.outcome) ? { cleanHead: task.head } : {}),
  });
  log('collected', { pr: task.pr, runId: entry.runId, outcome: server.outcome, reviewClean: server.reviewClean });
  return true;
}

function bumpStore(task, patch) {
  const store = loadStore();
  store.prs[task.pr] = { ...(store.prs[task.pr] ?? {}), ...patch, updatedAt: nowIso() };
  saveStore(store);
}

function finishGate(ctx, task, result) {
  writeTaskResult(ctx, task, result);
  return { dispatched: false };
}

// pr-worker 第 6 节的终态文件;判门阶段的结果都没有进入代码审查。
function writeTaskResult(ctx, task, result, { raw = false } = {}) {
  const base = raw ? {} : { enteredReview: false, reviewed: false, reviewClean: false, merged: false, threadUrls: [] };
  const payload = {
    runId: ctx.plan.runId, mode: 'review-only', pr: task.pr, head: task.head, base: task.base,
    ...base, ...result,
    outcome: result.outcome ?? 'error', reason: String(result.reason || result.outcome || '未知'),
    errors: result.errors ?? [], warnings: result.warnings ?? [],
  };
  if (!raw && payload.outcome === 'error') payload.retry = true;
  writeJson(task.resultFile, payload);
}

main().catch((error) => {
  log('round-error', { error: error.message });
  console.error(`[prereview] ${error.message}`);
  process.exitCode = 1;
});
