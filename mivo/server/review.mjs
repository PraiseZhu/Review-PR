#!/usr/bin/env node
// review.mjs — 服务器后置审查(GitHub Actions 的 review-pr.yml 调用)。分四个阶段,每个阶段一个 step,
// 各 step 只拿自己需要的凭据:
//   prepare  有 GitHub 令牌:检出 PR、拿审查锁与维护者权限、进场复核(context.mjs)、算审查范围、写 check(审查中)
//   deps     无任何凭据:按 lockfile 预装依赖(不跑 install 脚本);heavy 档跑 security-scan
//   codex    只有模型网关凭据:Codex CLI 审查,产出报告与问题清单
//   publish  有 GitHub 令牌:用 Cindy 脚本发 Request Changes / guarded Approve,写 check 结论,输出结果
// 输入全部来自环境变量 INPUT_*(workflow_dispatch 的 inputs),工作目录 MIVO_REVIEW_WORK。
import { existsSync, readFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_ROOT, SCRIPTS, SHA_RE, REPO_RE, MODES, run, runScript, readJson, writeJson, writeText, requireMatch, nowIso } from '../lib/common.mjs';
import { decideGate, PENDING_GATE_TEXT } from '../lib/gates.mjs';
import { splitDiffByFile, filePatchHashes, computeReviewScope, previousFromResult } from '../lib/scope.mjs';
import { ANSWER_SCHEMA, validateAnswer, finalizeReport, reusedReport, scrubSecrets } from '../lib/report.mjs';
import { loadReviewSpec, buildReviewPrompt, buildSpecManifest, specDigestOf } from '../lib/prompt.mjs';
import { parseDeferrals, verifyDeferrals, toIssueRead, toDeferredSummary } from '../lib/deferrals.mjs';
import { collectRulings, collectRebuttals } from '../lib/rulings.mjs';
import { TIER_DEFAULTS, DEFAULT_JOB_TIMEOUT_MIN, tierConfig, nextAttempt, codexBudgetMs, pickJobStart } from '../lib/models.mjs';
import { checkTarget, toMirrorDispatchArgs } from '../lib/checks.mjs';
import { readHealth, toHealthReason } from '../lib/health.mjs';
import { runCodex } from './codex.mjs';

const WORK = process.env.MIVO_REVIEW_WORK || '';
const STATE_FILE = join(WORK, 'state.json');
const OUT = join(WORK, 'out');
const REPO_DIR = join(WORK, 'repo');
const INPUT_DIR = join(WORK, 'input');
const CHECK_NAME = 'review-pr';
const MERGE_READY_LABEL = 'review:merge-ready';

function inputs() {
  const env = process.env;
  const mode = String(env.INPUT_MODE ?? '').trim();
  if (!MODES.includes(mode)) throw new Error(`输入 mode 不合法:${mode}`);
  const action = String(env.INPUT_ACTION || 'review').trim();
  if (!['review', 'protected-approve'].includes(action)) throw new Error(`输入 action 不合法:${action}`);
  const tier = String(env.INPUT_TIER || 'standard').trim();
  if (!TIER_DEFAULTS[tier]) throw new Error(`输入 tier 不合法:${tier}`);
  return {
    targetRepo: requireMatch('target_repo', env.INPUT_TARGET_REPO, REPO_RE),
    workflowRepo: requireMatch('workflow_repo', env.GITHUB_REPOSITORY, REPO_RE),
    pr: Number(requireMatch('pr', env.INPUT_PR, /^[1-9]\d{0,6}$/)),
    head: requireMatch('head_sha', env.INPUT_HEAD_SHA, SHA_RE),
    base: requireMatch('base_sha', env.INPUT_BASE_SHA, SHA_RE),
    tier,
    prevRunId: env.INPUT_PREV_RUN_ID ? requireMatch('prev_run_id', env.INPUT_PREV_RUN_ID, /^\d{1,15}$/) : '',
    roundId: requireMatch('round_id', env.INPUT_ROUND_ID, /^[A-Za-z0-9-]{8,80}$/),
    attempt: Number(env.INPUT_ATTEMPT || 1),
    mode,
    action,
    skillSha: requireMatch('skill_sha', env.MIVO_REVIEW_SKILL_SHA, SHA_RE),
    runId: env.GITHUB_RUN_ID || '',
    runUrl: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '',
  };
}

// Cindy 脚本只认 cwd 的 git remote 与这些变量;令牌只经 GH_TOKEN 给 gh,不写进任何文件。
function scriptEnv(extra = {}) {
  const env = { ...process.env, REVIEW_PR_REPO_ROOT: REPO_DIR, REVIEW_PR_STATE_DIR: join(WORK, 'review-state'), ...extra };
  if (process.env.MIVO_REVIEW_RULES_FILE) env.REVIEW_PR_RULES_FILE = process.env.MIVO_REVIEW_RULES_FILE;
  return env;
}

const gitAuth = ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=${GH_TOKEN}"; }; f'];
const git = (args, options = {}) => run('git', [...gitAuth, ...args], { cwd: REPO_DIR, ...options });
const gh = (args, options = {}) => run('gh', args, { cwd: REPO_DIR, ...options });

function loadState() { return readJson(STATE_FILE); }
function saveState(state) { writeJson(STATE_FILE, state); }

// ── prepare ────────────────────────────────────────────────────────────────
async function prepare() {
  const input = inputs();
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(INPUT_DIR, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const state = { version: 1, input, startedAt: nowIso(), phase: 'prepare', warnings: [], errors: [] };
  saveState(state);
  // 与老审查机 gate 的第一次检查相同:营业窗口 + healthy.marker,不过就不开审(不碰 PR、不写 check)。
  if (!checkHealth(state, 'prepare')) return state;
  // codex 阶段按作业的真实开始时间算模型预算(codex 步骤没有 GitHub 令牌,这里先读好)。
  state.jobStart = readJobStart(input);
  saveState(state);
  try {
    // 1. 检出 PR head(detached),只取需要的对象。
    const repoMeta = JSON.parse(gh(['api', `repos/${input.targetRepo}`], { cwd: WORK }).stdout);
    const defaultBranch = repoMeta.default_branch;
    run('git', ['init', '-q', REPO_DIR]);
    git(['remote', 'add', 'origin', `https://github.com/${input.targetRepo}.git`]);
    git(['fetch', '-q', '--filter=blob:none', '--no-tags', 'origin',
      `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`, `+refs/pull/${input.pr}/head:refs/remotes/pr/head`], { timeoutMs: 600_000 });
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${defaultBranch}`]);
    const fetchedHead = git(['rev-parse', 'refs/remotes/pr/head']).stdout.trim();
    if (fetchedHead !== input.head) return finishEarly(state, 'state-changed', `PR head 已变化(${input.head.slice(0, 12)} → ${fetchedHead.slice(0, 12)}),下一轮重新采集`);
    git(['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', input.head], { timeoutMs: 600_000 });
    // 审查步骤没有网络,partial clone 缺的 base 侧 blob 届时取不到:这里先把 base...head 涉及的对象取齐,
    // 审查时 `git diff <base>...HEAD` 才能离线运行。失败只记警告,审查仍以完整 diff 为准。
    const warmed = git(['fetch', '-q', '--filter=blob:none', '--no-tags', 'origin', input.base], { allowFail: true, timeoutMs: 600_000 }).ok &&
      git(['diff', '--numstat', `${input.base}...${input.head}`], { allowFail: true, timeoutMs: 600_000 }).ok;
    if (!warmed) state.warnings.push(`base ${input.base.slice(0, 12)} 的对象没取齐,审查时本地 git diff 可能不可用`);

    // 2. 审查锁与维护者权限(锁只在本 job 的临时目录,与 Mini 的锁互不相干)。
    const prep = runScript('prepare.mjs', ['--skip-skill-pull'], { cwd: REPO_DIR, env: scriptEnv() });
    if (!prep.ok || !prep.lock?.acquired || !prep.maintainerAuthority?.verified) {
      return finishEarly(state, 'error', `prepare 未取得锁或维护者权限:${prep.error || JSON.stringify(prep.lock ?? {})}`, true);
    }
    state.lockToken = prep.lock.token;
    state.authorityDigest = prep.maintainerAuthority.digest;
    saveState(state);

    // 3. 进场复核:重跑 context(几秒,不调模型),确认版本没变、前置门全部通过。
    const contextFile = join(INPUT_DIR, 'context.json');
    const diffFile = join(INPUT_DIR, 'pr.diff');
    const ctx = runScript('context.mjs', [String(input.pr), '--lock-token', state.lockToken, '--diff-output', diffFile],
      { cwd: REPO_DIR, env: scriptEnv(), timeoutMs: 300_000 });
    if (!ctx.ok) return finishEarly(state, 'error', `context 读取失败:${ctx.error}`, true);
    writeJson(contextFile, ctx);
    state.context = { file: contextFile, diffFile, evidence: ctx.evidence, author: ctx.meta.author, viewer: ctx.approvalPolicy?.viewer,
      viewerIsAuthor: ctx.approvalPolicy?.viewerIsAuthor === true, url: ctx.meta.url, baseRefName: ctx.meta.baseRefName,
      title: ctx.meta.title, protectedFiles: ctx.auto?.action === 'skip-protected-path' };
    if (ctx.meta.state !== 'OPEN' || ctx.meta.isDraft) return finishEarly(state, 'state-changed', 'PR 已关闭或转为 draft');
    if (ctx.meta.headRefOid !== input.head || ctx.meta.baseRefOid !== input.base) {
      return finishEarly(state, 'state-changed', `PR 的 head/base 已变化(base ${input.base.slice(0, 12)} → ${String(ctx.meta.baseRefOid).slice(0, 12)}),下一轮重新采集`);
    }

    if (input.action === 'protected-approve') return prepareProtectedApprove(state, ctx);

    const gate = decideGate(ctx);
    if (gate.stage !== 'review') {
      return finishEarly(state, gate.outcome ?? 'state-changed', `进场复核未通过:${gate.reason}`, gate.outcome === 'error');
    }
    // 只缺界面证据或只剩机器人 thread:照审,但没有 P0/P1 也不放行(publishAdvisory)。
    state.pendingGates = gate.pendingGates ?? [];
    const tier = ctx.review?.tier ?? input.tier;
    if (tier !== input.tier) state.warnings.push(`档位与前置给出的不同(${input.tier} → ${tier}),按进场复核结果审查`);
    state.tier = tier;

    // 3b. 转 issue 跟进的审查问题:解析 PR 说明里登记的 issue 并逐个核验;读失败只记未采用,不让整轮失败。
    state.deferrals = collectDeferrals(input, ctx, state);
    writeJson(join(INPUT_DIR, 'deferrals.json'), state.deferrals);
    // 3c. 维护者裁定不改(见 lib/rulings.mjs):只认维护者在审查机 thread 里的裁定回复。
    state.rulings = collectRulings({ threads: ctx.history?.reviewThreads ?? [], reviewer: ctx.approvalPolicy?.viewer, maintainers: ctx.signoff?.maintainers ?? [] });
    for (const r of state.rulings.rejected) state.warnings.push(`裁定不改没有采用(${r.path ?? r.threadId}):${r.reason}`);
    // 3d. 作者申辩:作者一方在审查机 thread 里说明不成立的依据,任务书要求逐条核对(见 lib/rulings.mjs)。
    state.rebuttals = collectRebuttals({ threads: ctx.history?.reviewThreads ?? [], reviewer: ctx.approvalPolicy?.viewer, author: ctx.meta?.author });

    // 4. 审查范围(增量复审,方案第 8 节)。上一轮结果来自上一次 run 的 artifact。
    const diffText = readFileSync(diffFile, 'utf8');
    const diffFiles = splitDiffByFile(diffText);
    const previous = input.prevRunId ? downloadPrevious(input, state) : null;
    // 任务书版本:按审查实际读的版本(PR head)取规则文件,算 scope 之前生成(lib/prompt.mjs)。
    const specDigest = specDigestOf(buildSpecManifest({ spec: loadReviewSpec(SKILL_ROOT), tier, files: Object.keys(diffFiles),
      readFile: (path) => { const r = git(['show', `${input.head}:${path}`], { allowFail: true }); return r.ok ? r.stdout : null; },
      config: readFileSync(process.env.MIVO_REVIEW_RULES_FILE || join(SKILL_ROOT, 'review-pr', 'config', 'pr-rules.json'), 'utf8') }));
    const current = {
      head: input.head, baseRefName: ctx.meta.baseRefName, diffHash: ctx.evidence?.diffHash,
      filePatchHashes: filePatchHashes(diffFiles),
      fileChangedLines: Object.fromEntries(Object.entries(diffFiles).map(([p, f]) => [p, f.changedLines])),
      totalDiffLines: ctx.totalDiffLines, tier, triggerKinds: (ctx.signoff?.triggers ?? []).map((t) => t.kind).sort(),
      skillSha: input.skillSha, specDigest, now: Date.now(),
    };
    let headIsDescendant = null;
    if (previous?.head && previous.head !== input.head) {
      run('git', [...gitAuth, 'fetch', '-q', '--filter=blob:none', '--no-tags', 'origin', previous.head], { cwd: REPO_DIR, allowFail: true });
      headIsDescendant = run('git', ['merge-base', '--is-ancestor', previous.head, input.head], { cwd: REPO_DIR, allowFail: true }).status === 0;
      if (headIsDescendant) git(['diff', '--numstat', previous.head, input.head], { allowFail: true, timeoutMs: 600_000 }); // 同上:增量复审离线要用
    }
    const scope = computeReviewScope({ previous, current, headIsDescendant });
    state.scope = scope;
    state.current = current;
    state.previous = previous ? { head: previous.head, runId: input.prevRunId, lastFullReviewAt: previous.lastFullReviewAt } : null;
    writeJson(join(INPUT_DIR, 'scope.json'), scope);

    // 5. check:审查中(live 审本仓时直接写;sandbox 审沙箱仓时派发沙箱的检查镜像,见 lib/checks.mjs)。
    const pendingCheck = { status: 'in_progress', title: '审查中', summary: `${scope.mode === 'reuse' ? '沿用上一轮结论' : `档位 ${tier},${scope.reason}`}` };
    if (checkTarget(input) === 'direct') state.checkRunId = createCheckRun(input, pendingCheck);
    if (checkTarget(input) === 'sandbox-mirror') {
      const mirrored = dispatchSandboxCheck(input, pendingCheck);
      if (!mirrored.ok) state.warnings.push(`沙箱检查镜像派发失败:${mirrored.error}`);
    }
    state.phase = 'prepared';
    saveState(state);
  } catch (error) {
    finishEarly(state, 'error', `prepare 异常:${error.message}`, true);
  }
}

// 作业开始时间:优先读本 job 的 started_at;读不到就用这次 run 的 created_at,它一定不晚于 job 开始,是可靠下界。
// 两个都读不到时 codex 阶段不启动付费模型、记 error,交给 Mini 按现有规则重试。不用「现在 − 已知步骤耗时」去估:
// 下载解压 skill 等步骤的耗时不全知道,估出来的起点会偏晚,挤掉发布余量。
function readJobStart(input) {
  if (!input.runId) return { at: null, from: null, error: '没有 GITHUB_RUN_ID' };
  const api = (path) => run('gh', ['api', path], { cwd: WORK, allowFail: true, timeoutMs: 60_000 });
  const parse = (r) => { if (!r.ok) return null; try { return JSON.parse(r.stdout); } catch { return null; } };
  const jobs = api(`repos/${input.workflowRepo}/actions/runs/${input.runId}/jobs?filter=latest&per_page=100`);
  const fromJob = pickJobStart({ jobsJson: parse(jobs), runnerName: process.env.RUNNER_NAME });
  if (fromJob) return fromJob;
  const view = api(`repos/${input.workflowRepo}/actions/runs/${input.runId}`);
  return pickJobStart({ runJson: parse(view) }) ??
    { at: null, from: null, error: `读不到作业开始时间:${(view.stderr || jobs.stderr || '').trim().slice(0, 200) || '返回内容没有时间字段'}` };
}

function prepareProtectedApprove(state, ctx) {
  // 受保护路径的 PR 不自动审查;维护者在当前 head 上 Approve 后,这里核验那条 Approve 再写 check。
  const author = String(ctx.meta.author ?? '').toLowerCase();
  const maintainers = new Set((ctx.signoff?.maintainers ?? []).map((m) => String(m).toLowerCase()));
  if (!state.context.protectedFiles) return finishEarly(state, 'state-changed', '当前 head 已不涉及受保护路径,按普通 PR 重新送审');
  const approval = findHeadApproval(state.input, maintainers, author);
  if (!approval) return finishEarly(state, 'protected', '受保护路径:当前 head 还没有作者之外的维护者 Approve');
  state.protectedApproval = approval;
  state.phase = 'prepared';
  saveState(state);
}

function findHeadApproval(input, maintainers, author) {
  const reviews = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${input.targetRepo}/pulls/${input.pr}/reviews?per_page=100`]).stdout).flat();
  const latest = new Map();
  for (const review of reviews) {
    const login = String(review.user?.login ?? '').toLowerCase();
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(login, review);
  }
  for (const [login, review] of latest) {
    if (review.state === 'APPROVED' && login !== author && maintainers.has(login) && review.commit_id === input.head) {
      return { by: review.user.login, reviewId: review.id, at: review.submitted_at };
    }
  }
  return null;
}

// 转 issue 跟进的登记(见 lib/deferrals.mjs):只放核验通过的条目进任务书;没采用的连同原因写进报告。
function collectDeferrals(input, ctx, state) {
  try {
    const parsed = parseDeferrals(ctx.meta?.body, { repo: input.targetRepo, pr: input.pr });
    const checked = verifyDeferrals({
      entries: parsed.entries, repo: input.targetRepo, pr: input.pr, prUrl: ctx.meta?.url,
      author: ctx.meta?.author, maintainers: ctx.signoff?.maintainers ?? [],
      readIssue: (number) => toIssueRead(gh(['api', `repos/${input.targetRepo}/issues/${number}`], { allowFail: true, timeoutMs: 60_000 })),
    });
    return { found: parsed.found, verified: checked.verified, rejected: [...parsed.rejected, ...checked.rejected] };
  } catch (error) {
    state.warnings.push(`转 issue 登记没有核验成(${error.message}),本轮不采用任何登记`);
    return { found: false, verified: [], rejected: [], error: error.message };
  }
}

function downloadPrevious(input, state) {
  const dir = join(WORK, 'prev');
  rmSync(dir, { recursive: true, force: true });
  const r = run('gh', ['run', 'download', input.prevRunId, '-R', input.workflowRepo, '-n', `review-pr-${input.pr}`, '-D', dir],
    { cwd: WORK, allowFail: true, timeoutMs: 120_000 });
  if (!r.ok || !existsSync(join(dir, 'result.json'))) {
    state.warnings.push(`上一轮结果(run ${input.prevRunId})下载失败,按全量审查`);
    return null;
  }
  const result = readJson(join(dir, 'result.json'), null);
  if (!result || result.pr !== input.pr || result.mivo?.targetRepo !== input.targetRepo) {
    state.warnings.push('上一轮结果与本 PR 不匹配,按全量审查');
    return null;
  }
  return previousFromResult(result, existsSync(join(dir, 'report.md')) ? readFileSync(join(dir, 'report.md'), 'utf8') : '');
}

function createCheckRun(input, { status, title, summary }) {
  const token = process.env.CHECKS_TOKEN;
  if (!token) return null;
  // GitHub 会把 Actions 写的检查的 details_url 改成检查页面,只有 external_id 原样保留;
  // 盯梢与交付脚本按 external_id 找到写检查的这次 review-pr.yml run。
  const body = { name: CHECK_NAME, head_sha: input.head, status, external_id: input.runUrl || undefined, details_url: input.runUrl || undefined,
    output: { title, summary } };
  const r = run('gh', ['api', '--method', 'POST', `repos/${input.targetRepo}/check-runs`, '--input', '-'],
    { cwd: WORK, env: { ...process.env, GH_TOKEN: token }, input: JSON.stringify(body), allowFail: true });
  return r.ok ? JSON.parse(r.stdout).id : null;
}

function completeCheckRun(input, checkRunId, { conclusion, title, summary }) {
  if (checkTarget(input) === 'sandbox-mirror') return dispatchSandboxCheck(input, { conclusion, title, summary });
  const token = process.env.CHECKS_TOKEN;
  if (!token || checkTarget(input) !== 'direct') return { skipped: true };
  const body = conclusion
    ? { name: CHECK_NAME, head_sha: input.head, status: 'completed', conclusion, completed_at: nowIso(), external_id: input.runUrl || undefined, details_url: input.runUrl || undefined, output: { title, summary } }
    : { name: CHECK_NAME, head_sha: input.head, status: 'in_progress', external_id: input.runUrl || undefined, details_url: input.runUrl || undefined, output: { title, summary } };
  const path = checkRunId ? `repos/${input.targetRepo}/check-runs/${checkRunId}` : `repos/${input.targetRepo}/check-runs`;
  const r = run('gh', ['api', '--method', checkRunId ? 'PATCH' : 'POST', path, '--input', '-'],
    { cwd: WORK, env: { ...process.env, GH_TOKEN: token }, input: JSON.stringify(body), allowFail: true });
  return r.ok ? { ok: true, id: JSON.parse(r.stdout).id } : { ok: false, error: r.stderr.trim().slice(0, 300) };
}

// 沙箱仓的 review-pr 检查:用 GH_TOKEN(审查账号)派发沙箱仓的检查镜像 workflow。
function dispatchSandboxCheck(input, check) {
  const r = run('gh', toMirrorDispatchArgs(input, check), { cwd: WORK, allowFail: true });
  return r.ok ? { ok: true, mirrored: true } : { ok: false, mirrored: true, error: r.stderr.trim().slice(0, 300) };
}

function finishEarly(state, outcome, reason, retry = false, extra = {}) {
  state.phase = 'done-early';
  state.early = { outcome, reason, retry, ...extra };
  saveState(state);
  return state;
}

// 营业窗口与 healthy.marker(lib/health.mjs,语义同老审查机 review_tool_health.py)。
// 不通过:prepare 阶段直接收尾;codex 阶段记下原因、不调模型,由 publish 把本轮标成「推迟」。
function checkHealth(state, phase) {
  const health = readHealth();
  state.health = { ...(state.health ?? {}), [phase]: health };
  if (health.markerStale && phase === 'prepare') {
    state.warnings.push(`healthy.marker 已 ${health.markerAgeHours} 小时没更新(阈值 26 小时,每日更新器可能没在跑)`);
  }
  if (health.ok) { saveState(state); return true; }
  const reason = toHealthReason(health);
  if (phase === 'prepare') finishEarly(state, 'error', reason, true, { health });
  else { state.healthHold = { reason, health }; saveState(state); }
  return false;
}

// ── deps(无凭据)─────────────────────────────────────────────────────────
function deps() {
  const state = loadState();
  if (state.phase !== 'prepared' || state.protectedApproval || state.scope?.mode === 'reuse') return;
  const started = Date.now();
  if (existsSync(join(REPO_DIR, 'package-lock.json')) && state.tier !== 'light') {
    const r = run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error'],
      { cwd: REPO_DIR, allowFail: true, timeoutMs: 15 * 60_000, env: stripSecrets(process.env) });
    state.deps = { installed: r.ok, durationMs: Date.now() - started, error: r.ok ? null : (r.stderr || r.error || '').trim().split('\n').slice(-2).join(' | ').slice(0, 300) };
  } else {
    state.deps = { installed: false, skipped: state.tier === 'light' ? 'light 档不装依赖' : '没有 package-lock.json' };
  }
  if (state.tier === 'heavy') {
    state.semgrep = ensureSemgrep();
    const ctx = readJson(state.context.file);
    const deps = [...new Set((ctx.signoff?.triggers ?? []).flatMap((t) => t.newDependencyNames ?? []))];
    const scan = runScript('security-scan.mjs', ['--base', state.input.base, ...deps.flatMap((d) => ['--dep', d])],
      { cwd: REPO_DIR, env: { ...stripSecrets(process.env), PATH: semgrepPath(), REVIEW_PR_REPO_ROOT: REPO_DIR, REVIEW_PR_STATE_DIR: join(WORK, 'scan-state') }, timeoutMs: 10 * 60_000 });
    writeJson(join(INPUT_DIR, 'security-scan.json'), scan);
    state.securityScan = { file: join(INPUT_DIR, 'security-scan.json'), ok: scan.ok !== false };
  }
  saveState(state);
}

// heavy 档的 semgrep:装进 runner 用户自己的 ~/.local(不需要 root),装过就复用;装不上如实记下,
// security-scan 会输出 available:false,审查报告必须写「未执行」。
const SEMGREP_VERSION = '1.175.0';
const semgrepPath = () => `${process.env.HOME}/.local/bin:${process.env.PATH}`;
function ensureSemgrep() {
  const probe = run('semgrep', ['--version'], { allowFail: true, env: { ...stripSecrets(process.env), PATH: semgrepPath() }, timeoutMs: 60_000 });
  if (probe.ok && probe.stdout.trim() === SEMGREP_VERSION) return { available: true, version: SEMGREP_VERSION, installed: false };
  const install = run('python3', ['-m', 'pip', 'install', '--user', '--quiet', '--disable-pip-version-check', `semgrep==${SEMGREP_VERSION}`],
    { allowFail: true, env: stripSecrets(process.env), timeoutMs: 10 * 60_000 });
  const again = run('semgrep', ['--version'], { allowFail: true, env: { ...stripSecrets(process.env), PATH: semgrepPath() }, timeoutMs: 60_000 });
  return { available: again.ok, version: again.ok ? again.stdout.trim() : null, installed: install.ok,
    error: again.ok ? null : (install.stderr || again.stderr || '').trim().split('\n').slice(-2).join(' | ').slice(0, 300) };
}

function stripSecrets(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|LITELLM/i.test(key)) delete clean[key];
  }
  return clean;
}

// ── codex(只有模型网关凭据)─────────────────────────────────────────────
async function codex() {
  const state = loadState();
  if (state.phase !== 'prepared' || state.protectedApproval || state.scope?.mode === 'reuse') return;
  // 与老审查机「上席前再查一次窗口和 marker」相同:等依赖的这段时间可能已经进了 06:00。
  if (!checkHealth(state, 'codex')) return;
  const input = state.input;
  const ctx = readJson(state.context.file);
  // 模型预算(lib/models.mjs):作业截止 = 开始 + 作业上限;预算 = min(120 分钟, 截止 − 现在 − 发布预留),主备共用。
  const jobTimeoutMin = Number(process.env.MIVO_REVIEW_JOB_TIMEOUT_MIN) || DEFAULT_JOB_TIMEOUT_MIN;
  const jobStartMs = Date.parse(state.jobStart?.at ?? '');
  const budget = { jobStartAt: state.jobStart?.at ?? null, jobStartFrom: state.jobStart?.from ?? null, jobTimeoutMin };
  if (!Number.isFinite(jobStartMs)) {
    state.codex = { attempts: [], skipped: 'job-start-unknown', budget: { ...budget, error: state.jobStart?.error || '没有作业开始时间' } };
    saveState(state);
    return;
  }
  budget.budgetMs = codexBudgetMs({ jobStartMs, jobTimeoutMin, nowMs: Date.now() });
  const tierCfg = tierConfig(state.tier, process.env, { budgetMs: budget.budgetMs });
  budget.primaryTimeoutMs = tierCfg.timeoutMs;
  const prompt = buildReviewPrompt({
    spec: loadReviewSpec(SKILL_ROOT), ctx, scope: state.scope, workdir: REPO_DIR, tier: state.tier,
    inputs: { contextFile: state.context.file, diffFile: state.context.diffFile, scopeFile: join(INPUT_DIR, 'scope.json'),
      securityScanFile: state.securityScan?.file },
    deferrals: state.deferrals?.verified ?? [],
    rulings: state.rulings?.verified ?? [],
    rebuttals: state.rebuttals ?? [],
  }) + (state.deps?.installed ? '\n\n依赖已按 lockfile 预装(未执行 install 脚本),可以运行定向测试。' : `\n\n依赖没有预装(${state.deps?.skipped || state.deps?.error || '未知原因'}),不要尝试安装;需要运行才能确认的点在 Verification 写「未执行 + 原因」。`);
  writeText(join(INPUT_DIR, 'prompt.md'), prompt);
  const attempts = [];
  const startedAt = Date.now();
  // 主模型一次;非额度类失败再换备用模型一次(额度类报错不换,交给 Mini 暂停新系统)。
  for (let next = nextAttempt({ primary: tierCfg, attempts, elapsedMs: 0, budgetMs: budget.budgetMs }); next;
    next = nextAttempt({ primary: tierCfg, attempts, elapsedMs: Date.now() - startedAt, budgetMs: budget.budgetMs })) {
    const result = await runCodex({
      codexBin: process.env.CODEX_BIN || '/AIGC_Group/github-actions-runner/mivo-review-tools/bin/codex',
      workdir: REPO_DIR, prompt, schema: ANSWER_SCHEMA, model: next.model, effort: next.effort,
      timeoutMs: next.timeoutMs, credentials: process.env.LITELLM_CREDENTIALS_JSON,
      tmpRoot: join(WORK, 'codex'), label: `${attempts.length + 1}`,
    });
    // 每次调用按事件留下时长记录(codex.mjs):只是记录,不能单独当作变慢原因的证据;stderrTail 只在失败时有。
    attempts.push({ model: next.model, effort: next.effort, timeoutMs: next.timeoutMs, ok: result.ok, error: result.error,
      quota: result.quota, durationMs: result.durationMs, exitCode: result.exitCode, timedOut: result.timedOut, idleKilled: result.idleKilled,
      firstEventSec: result.firstEventSec ?? null, lastEventSec: result.lastEventSec ?? null, eventCount: result.eventCount ?? 0,
      maxGapSec: result.maxGapSec ?? null, usage: result.usage ?? null, ...(result.stderrTail ? { stderrTail: result.stderrTail } : {}) });
    if (result.ok) writeJson(join(WORK, 'answer.json'), result.answer);
  }
  state.codex = { attempts, model: attempts.at(-1)?.model, effort: attempts.at(-1)?.effort, budget,
    ...(attempts.length ? {} : { skipped: 'budget-exhausted' }) };
  saveState(state);
}

// ── publish ────────────────────────────────────────────────────────────────
async function publish() {
  if (!existsSync(STATE_FILE)) return writeBareError('prepare 没有留下状态(多半是输入校验失败),本轮没有审查');
  const state = loadState();
  const input = state.input;
  const result = baseResult(state);
  try {
    if (state.phase === 'done-early') {
      Object.assign(result, { outcome: state.early.outcome, reason: state.early.reason, retry: state.early.retry === true });
      if (state.early.health) {
        // 维护窗口 / 工具链不健康:不算一次失败的审查,也不写 check。
        result.mivo.health = state.early.health;
        return writeResult(result);
      }
      if (state.early.outcome === 'error') result.errors.push(state.early.reason);
      if (state.early.outcome === 'error' && input.attempt >= 2) {
        result.mivo.checkRun = completeCheckRun(input, state.checkRunId, { conclusion: 'failure', title: '审查两次未完成,需要人工处理', summary: state.early.reason });
      }
      return writeResult(result);
    }
    if (state.protectedApproval) {
      const by = state.protectedApproval.by;
      result.outcome = 'protected';
      result.reason = `受保护路径:由 ${by} 人工审查通过`;
      result.authorNotice = { kind: 'protected-path', status: 'deduplicated', head: input.head, reason: 'manual-approved', fingerprint: `manual:${state.protectedApproval.reviewId}` };
      if (input.mode !== 'dry-run') {
        result.mivo.checkRun = completeCheckRun(input, null, { conclusion: 'success', title: `受保护路径:由 ${by} 人工审查通过`, summary: `维护者 ${by} 在当前 head 上 Approve(review ${state.protectedApproval.reviewId})。` });
      }
      return writeResult(result);
    }

    const ctx = readJson(state.context.file);
    const diffFiles = splitDiffByFile(readFileSync(state.context.diffFile, 'utf8'));
    let report;
    let findings;
    let deferred = [];
    if (state.scope.mode === 'reuse') {
      const previous = readJson(join(WORK, 'prev', 'result.json'));
      findings = previous.mivo?.findings ?? [];
      deferred = previous.mivo?.deferred ?? [];
      report = reusedReport({ previousReport: readFileSync(join(WORK, 'prev', 'report.md'), 'utf8'), scope: state.scope });
      result.mivo.lastFullReviewAt = previous.mivo?.lastFullReviewAt;
    } else {
      if (state.healthHold) return holdReview(state, result, state.healthHold);
      const answerFile = join(WORK, 'answer.json');
      if (!existsSync(answerFile)) {
        const last = state.codex?.attempts?.at(-1);
        const why = last?.error || (state.codex?.skipped
          ? `没有启动模型(${state.codex.budget?.error || (state.codex.skipped === 'budget-exhausted' ? '作业剩余时间不够一次模型调用' : state.codex.skipped)})`
          : '没有答卷');
        return failReview(state, result, `模型审查没有完成:${why}`, { quota: last?.quota === true });
      }
      const checked = validateAnswer(readJson(answerFile), { diffFiles, deferrals: state.deferrals?.verified ?? [] });
      if (!checked.ok) return failReview(state, result, `模型答卷不合格:${checked.error}`);
      result.warnings.push(...checked.notes);
      findings = checked.findings.slice(0, 100);
      if (checked.findings.length > 100) result.warnings.push(`问题超过 100 条,只发布前 100 条`);
      deferred = checked.deferred.slice(0, 100);
      if (checked.deferred.length > 100) result.warnings.push(`转 issue 跟进的问题超过 100 条,只记前 100 条`);
      report = finalizeReport({ report: checked.report, findings, deferred, deferralsRejected: state.deferrals?.rejected ?? [],
        pr: input.pr, url: state.context.url, head: input.head,
        base: input.base, diffHash: state.context.evidence?.diffHash, tier: state.tier, scope: state.scope });
      result.mivo.lastFullReviewAt = state.scope.mode === 'full' ? nowIso() : state.previous?.lastFullReviewAt;
    }
    const scrubbed = scrubSecrets(report);
    let secretHits = scrubbed.hits;
    report = scrubbed.text;
    findings = findings.map((finding) => { const s = scrubSecrets(finding.body); secretHits += s.hits; return { ...finding, body: s.text }; });
    deferred = deferred.map((finding) => { const s = scrubSecrets(finding.body); secretHits += s.hits; return { ...finding, body: s.text }; });
    if (secretHits) result.warnings.push(`报告里有 ${secretHits} 处疑似凭证格式,已脱敏后再发布`);
    const reportFile = join(OUT, 'report.md');
    writeText(reportFile, report);
    Object.assign(result, { enteredReview: true, reviewed: true, reviewClean: findings.length === 0, reportFile: 'report.md' });
    // 结果包只带 issue 号和未采用原因,不带 PR 说明原文。
    Object.assign(result.mivo, { reportComplete: true, findings, deferred, deferrals: {
      verified: (state.deferrals?.verified ?? []).map((d) => d.issue),
      rejected: (state.deferrals?.rejected ?? []).map((r) => ({ issue: r.issue, ref: r.ref, reason: r.reason })),
    } });

    if (findings.length > 0) await publishFindings(state, result, reportFile, findings);
    else if (state.pendingGates?.length) await publishAdvisory(state, result, reportFile);
    else await publishClean(state, result, reportFile);
    return writeResult(result);
  } catch (error) {
    result.errors.push(`publish 异常:${error.message}`);
    Object.assign(result, { outcome: 'error', reason: `publish 异常:${error.message}`, retry: true });
    return writeResult(result);
  } finally {
    if (state.lockToken) runScript('release-lock.mjs', ['--token', state.lockToken], { cwd: existsSync(REPO_DIR) ? REPO_DIR : WORK, env: scriptEnv() });
  }
}

function baseResult(state) {
  const input = state.input;
  const current = state.current ?? {};
  return {
    runId: input.roundId, mode: 'review-only', pr: input.pr, head: input.head, base: input.base,
    enteredReview: false, reviewed: false, reviewClean: false, merged: false,
    outcome: 'error', reason: '', threadUrls: [], errors: [...(state.errors ?? [])], warnings: [...(state.warnings ?? [])], retry: false,
    reviewEvidence: state.context?.evidence ? { head: state.context.evidence.head, base: state.context.evidence.base,
      baseRefName: state.context.evidence.baseRefName, diffHash: state.context.evidence.diffHash } : undefined,
    mivo: {
      targetRepo: input.targetRepo, serverMode: input.mode, runId: input.runId, runUrl: input.runUrl, attempt: input.attempt,
      tier: state.tier, scope: state.scope, skillSha: input.skillSha, specDigest: current.specDigest,
      filePatchHashes: current.filePatchHashes, totalDiffLines: current.totalDiffLines, triggerKinds: current.triggerKinds,
      codex: state.codex, deps: state.deps, reportComplete: false, findings: [], deferred: [], completedAt: null,
    },
  };
}

async function publishFindings(state, result, reportFile, findings) {
  const input = state.input;
  result.outcome = 'findings';
  result.reason = `发现 ${findings.length} 条 P0/P1`;
  const deferredSummary = toDeferredSummary(result.mivo.deferred);
  const deferHint = findings.some((finding) => /^\s*\[P1\]/.test(finding.body)) ? '本 PR 修不了的 P1 可以转 issue 跟进,做法见报告。' : '';
  const conclusionCheck = { conclusion: 'failure', title: `发现 ${findings.length} 条 P0/P1`,
    summary: `档位 ${state.tier}。问题已在 PR 上开 review thread,修复并 resolve 后自动重审。${deferHint}${deferredSummary ? `另有 ${deferredSummary.text},不阻断。` : ''}` };
  if (input.mode === 'dry-run') {
    result.reason += '(dry-run:没有写入 GitHub)';
    return;
  }
  const commentsFile = join(WORK, 'comments.json');
  writeJson(commentsFile, findings);
  const args = [String(input.pr), '--lock-token', state.lockToken, '--expected-head', input.head,
    '--expected-authority-digest', state.authorityDigest, '--body-file', reportFile, '--comments-file', commentsFile];
  if (state.context.viewerIsAuthor) args.push('--comment-only');
  const posted = runScript('request-changes-reviewed-pr.mjs', args, { cwd: REPO_DIR, env: scriptEnv(), timeoutMs: 180_000 });
  if (posted.submitted) {
    result.threadUrls = posted.threadUrls ?? [];
    result.mivo.review = { id: posted.reviewId, url: posted.reviewUrl, action: posted.action };
    removeMergeReady(state, result);
    result.mivo.checkRun = completeCheckRun(input, state.checkRunId, conclusionCheck);
    return;
  }
  const reason = posted.reason || posted.error || 'Request Changes 未提交';
  if (/head 已变化|state=/.test(reason)) Object.assign(result, { outcome: 'state-changed', reason: `发布前 PR 已变化:${reason}`, retry: true });
  else Object.assign(result, { outcome: 'error', reason: `问题已审出但发布失败:${reason}`, retry: true, errors: [...result.errors, reason] });
}

async function publishClean(state, result, reportFile) {
  const input = state.input;
  // 只有转 issue 跟进的 P1 时也走这里:不阻断,check 标题和摘要写明条数与 issue 号。
  const deferredSummary = toDeferredSummary(result.mivo.deferred);
  const clean = deferredSummary ? `没有阻断的 P0/P1;${deferredSummary.text},不阻断本 PR` : '没有 P0/P1';
  if (input.mode === 'dry-run') {
    Object.assign(result, { outcome: 'approval', reason: `审查通过,${clean}(dry-run:没有写入 GitHub)`,
      approval: { status: 'blocked', code: 'dry-run', reason: 'dry-run 只审查,不写入 GitHub' } });
    return;
  }
  const finishFile = join(OUT, 'finish.json');
  const finish = runScript('finish-reviewed-pr.mjs', [String(input.pr), '--mode', 'review-only', '--review-clean',
    '--lock-token', state.lockToken, '--expected-head', input.head, '--expected-authority-digest', state.authorityDigest,
    '--expected-base', input.base, '--expected-base-ref', state.context.baseRefName, '--method', 'squash',
    '--body-file', reportFile, '--run-id', input.roundId, '--result-file', finishFile], { cwd: REPO_DIR, env: scriptEnv(), timeoutMs: 600_000 });
  const receipt = existsSync(finishFile) ? readJson(finishFile, null) : null;
  result.approval = receipt?.approval ?? finish.approval ?? { status: 'pending', code: 'approval-result-unverified', reason: finish.error || 'finish 没有回执' };
  if (receipt?.retry || finish.retry) result.retry = true;
  const check = { conclusion: 'success', title: deferredSummary ? `审查通过(${state.tier}),${deferredSummary.count} 条 P1 已转 issue` : `审查通过(${state.tier})`,
    summary: `${clean}。${state.scope.reason}` };
  if (receipt?.stage === 'reviewed-only' && result.approval.status === 'verified') {
    Object.assign(result, { outcome: 'review-only', reason: `审查通过,已 Approve${deferredSummary ? `(${deferredSummary.text})` : ''};review-only 不执行合并,由维护者手动合并` });
    addMergeReady(state, result);
    result.mivo.checkRun = completeCheckRun(input, state.checkRunId, check);
    return;
  }
  if (result.approval.status === 'blocked' && result.approval.code === 'independent-approval-required' && state.context.viewerIsAuthor) {
    // 作者就是审查账号(PraiseZhu 自己的 PR):不能自批,改用 COMMENT 发同样的报告(同 Cindy --comment-only)。
    const comment = postReportComment(state, reportFile);
    Object.assign(result, { outcome: 'approval', reason: `审查通过,${clean};作者是审查账号本人,以评论发布报告,需另一位维护者 Approve` });
    result.mivo.reportComment = comment;
    if (comment.ok) {
      addMergeReady(state, result);
      result.mivo.checkRun = completeCheckRun(input, state.checkRunId, check);
    } else {
      result.errors.push(`报告评论发布失败:${comment.error}`);
      result.retry = true;
    }
    return;
  }
  if (result.approval.status === 'pending') {
    Object.assign(result, { outcome: 'approval-pending', reason: `审查通过,Approve 尚待确认:${result.approval.reason}`, retry: true });
    return;
  }
  if (result.approval.status === 'blocked') {
    const headMoved = /head-changed|base-changed|state-changed/.test(result.approval.code ?? '');
    Object.assign(result, headMoved
      ? { outcome: 'state-changed', reason: `发布前 PR 已变化:${result.approval.reason}`, retry: true }
      : { outcome: 'approval', reason: `审查通过,但 Approve 被拦:${result.approval.reason}` });
    if (!headMoved) result.mivo.checkRun = completeCheckRun(input, state.checkRunId, check);
    return;
  }
  Object.assign(result, { outcome: 'error', reason: `guarded finish 未完成:${receipt?.reason || finish.error || '未知'}`, retry: true });
}

// 代码没有 P0/P1,但还有前置门没过(缺界面证据、机器人 thread 没 resolve):以评论发报告,不 Approve、
// 不挂 review:merge-ready,check 留在进行中。补齐后下一轮重审(同 head 走复用)才放行。
// reviewClean 记 false:Mini 不把这个 head 当成审查通过,也不会为补 Approve 反复派发。
async function publishAdvisory(state, result, reportFile) {
  const input = state.input;
  const pending = state.pendingGates.map((gate) => PENDING_GATE_TEXT[gate] ?? gate);
  // threads-unresolved 表示「前置门没过、没进审查」,轮次汇总会拒绝它带 enteredReview;只剩机器人 thread 记 merge-blocked。
  const outcome = state.pendingGates.includes('ui-evidence') ? 'format' : 'merge-blocked';
  const why = pending.join(';');
  Object.assign(result, { outcome, reviewClean: false, reason: `代码审查没有 P0/P1,但还不能放行:${why}` });
  result.approval = { status: 'blocked', code: 'gates-pending', reason: why };
  result.mivo.advisory = { pendingGates: state.pendingGates };
  if (input.mode === 'dry-run') { result.reason += '(dry-run:没有写入 GitHub)'; return; }
  const banner = [
    `> **代码审查没有发现 P0/P1,但这个 PR 还不能放行**:${why}。`,
    '> 补齐后审查机会自动重审;代码没变时直接沿用这次的结论并 Approve。',
    '',
  ].join('\n');
  const comment = postReportComment(state, reportFile, { marker: `<!-- mivo-review:advisory head=${input.head} -->`, prefix: banner });
  result.mivo.reportComment = comment;
  if (!comment.ok) {
    result.errors.push(`报告评论发布失败:${comment.error}`);
    result.retry = true;
    return;
  }
  removeMergeReady(state, result);
  result.mivo.checkRun = completeCheckRun(input, state.checkRunId, { conclusion: null,
    title: `代码审查没有 P0/P1(${state.tier}),等补齐后放行`, summary: `${why}。${state.scope.reason}` });
}

function postReportComment(state, reportFile, { marker = `<!-- mivo-review:report head=${state.input.head} -->`, prefix = '' } = {}) {
  const input = state.input;
  const existing = run('gh', ['api', '--paginate', '--slurp', `repos/${input.targetRepo}/pulls/${input.pr}/reviews?per_page=100`], { cwd: REPO_DIR, allowFail: true });
  if (existing.ok && JSON.parse(existing.stdout).flat().some((r) => String(r.body ?? '').includes(marker))) return { ok: true, deduplicated: true };
  const body = `${prefix}${readFileSync(reportFile, 'utf8').trim()}\n\n${marker}`;
  const r = run('gh', ['api', '--method', 'POST', `repos/${input.targetRepo}/pulls/${input.pr}/reviews`, '--input', '-'],
    { cwd: REPO_DIR, input: JSON.stringify({ event: 'COMMENT', commit_id: input.head, body }), allowFail: true });
  return r.ok ? { ok: true, id: JSON.parse(r.stdout).id } : { ok: false, error: r.stderr.trim().slice(0, 300) };
}

function addMergeReady(state, result) {
  const input = state.input;
  run('gh', ['api', '--method', 'POST', `repos/${input.targetRepo}/labels`, '-f', `name=${MERGE_READY_LABEL}`, '-f', 'color=0E8A16',
    '-f', 'description=Mivo 自动审查:当前 head 审查通过'], { cwd: REPO_DIR, allowFail: true });
  const meta = JSON.parse(gh(['api', `repos/${input.targetRepo}/pulls/${input.pr}`]).stdout);
  if (meta.head?.sha !== input.head) { result.warnings.push('加 review:merge-ready 前 head 已变化,不加标签'); return; }
  // 已有就不再 POST:重复加同一个标签不留事件,但会刷新 PR 的 updatedAt,下一轮指纹就变了,会一直重审。
  if ((meta.labels ?? []).some((label) => label?.name === MERGE_READY_LABEL)) return;
  const r = run('gh', ['api', '--method', 'POST', `repos/${input.targetRepo}/issues/${input.pr}/labels`, '-f', `labels[]=${MERGE_READY_LABEL}`], { cwd: REPO_DIR, allowFail: true });
  if (!r.ok) result.warnings.push(`review:merge-ready 标签没加上:${r.stderr.trim().slice(0, 200)}`);
}

function removeMergeReady(state, result) {
  const input = state.input;
  const r = run('gh', ['api', '--method', 'DELETE', `repos/${input.targetRepo}/issues/${input.pr}/labels/${encodeURIComponent(MERGE_READY_LABEL)}`], { cwd: REPO_DIR, allowFail: true });
  if (!r.ok && !/404|Label does not exist/i.test(r.stderr)) result.warnings.push(`review:merge-ready 标签没摘掉:${r.stderr.trim().slice(0, 200)}`);
}

function failReview(state, result, reason, { quota = false } = {}) {
  const input = state.input;
  Object.assign(result, { outcome: 'error', reason, retry: true, enteredReview: true, reviewed: false });
  result.errors.push(reason);
  result.mivo.quota = quota;
  const final = input.attempt >= 2;
  result.mivo.checkRun = completeCheckRun(input, state.checkRunId, final
    ? { conclusion: 'failure', title: '审查两次未完成,需要人工处理', summary: reason }
    : { conclusion: null, title: '审查未完成,下一轮重试', summary: reason });
  return writeResult(result);
}

// 上模型前窗口关了或工具链不健康:本轮推迟,不算失败;check 保持「审查中」并写明原因,下一轮重审覆盖。
function holdReview(state, result, hold) {
  Object.assign(result, { outcome: 'error', reason: hold.reason, retry: true, enteredReview: false, reviewed: false });
  result.mivo.health = hold.health;
  result.mivo.checkRun = completeCheckRun(state.input, state.checkRunId, { conclusion: null, title: '审查推迟', summary: hold.reason });
  return writeResult(result);
}

// prepare 在写下状态之前就失败时,仍按 pr-worker 第 6 节交一份 error 终态,前置审查才能收尾。
function writeBareError(reason) {
  const env = process.env;
  const result = {
    runId: String(env.INPUT_ROUND_ID ?? ''), mode: 'review-only', pr: Number(env.INPUT_PR), head: String(env.INPUT_HEAD_SHA ?? ''),
    base: String(env.INPUT_BASE_SHA ?? ''), enteredReview: false, reviewed: false, reviewClean: false, merged: false,
    outcome: 'error', reason, threadUrls: [], errors: [reason], warnings: [], retry: true,
    mivo: { targetRepo: String(env.INPUT_TARGET_REPO ?? ''), serverMode: String(env.INPUT_MODE ?? ''), runId: env.GITHUB_RUN_ID || '', findings: [], deferred: [], reportComplete: false },
  };
  mkdirSync(OUT, { recursive: true });
  return writeResult(result);
}

function writeResult(result) {
  result.mivo.completedAt = nowIso();
  if (!result.reason) result.reason = result.outcome;
  writeJson(join(OUT, 'result.json'), result);
  console.log(JSON.stringify({ ok: true, pr: result.pr, outcome: result.outcome, reason: result.reason, reviewClean: result.reviewClean }));
  return result;
}

// ── 入口 ───────────────────────────────────────────────────────────────────
const phase = process.argv[2];
if (!WORK) { console.error('缺少 MIVO_REVIEW_WORK'); process.exit(2); }
const phases = { prepare, deps, codex, publish };
if (!phases[phase]) { console.error(`用法: review.mjs <${Object.keys(phases).join('|')}>`); process.exit(2); }
try {
  await phases[phase]();
} catch (error) {
  console.error(`[review ${phase}] ${error.message}`);
  // prepare/deps/codex 的异常都落进 state,由 publish 统一产出结果;publish 自己的异常写 error 结果。
  if (phase !== 'publish' && existsSync(STATE_FILE)) {
    const state = readJson(STATE_FILE, null);
    if (state && state.phase !== 'done-early') finishEarly(state, 'error', `${phase} 异常:${error.message}`, true);
  }
  process.exitCode = phase === 'publish' ? 1 : 0;
}
