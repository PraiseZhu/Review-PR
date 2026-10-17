/**
 * round.mjs rolling-admission regression tests (the two counterexamples from the PR #54 review);
 * no real GitHub, subprocess, or state-directory I/O.
 * Extracts named top-level functions from round.mjs, including main, startDrive,
 * drive, runQueue, resumeInflight, and admitLoop. Executes the real main, so its
 * proposed RESUME_BARRIER release and process-level ABORTED logic remain active.
 * Replacements: fs/common JSON and log I/O use a Map; runScript emulates external
 * queue/preflight/prepare/finalize/lock CLIs; run emulates git and gh dispatch;
 * spawn is an inert watch; collectServerRun controls completion/fault injection.
 * Gate, retry, admission, handleTask, dispatchReview, and all coordination logic
 * come from the source. Clock/timers are virtual; pure business-window logic
 * receives that clock. No actual process or timer survives a test.
 * Extraction assumes named top-level function declarations start in column 0,
 * their closing brace is alone in column 0, imports before main are single-line,
 * and HERE is initialized on one line. Non-function runtime declarations added
 * after main, or renamed functions, require updating this fixture explicitly.
 * ROUND_FIXTURE_REPO_ROOT may select another checkout; default is this checkout.
 * ROUND_FIXTURE_SOURCE_REV selects committed round.mjs via read-only git show (e.g. a5315cd);
 * omitted means the current file, including uncommitted fixes. Pure helpers load
 * from the checkout. Neither source selection writes or switches the worktree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const REPO_ROOT = process.env.ROUND_FIXTURE_REPO_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const load = (file) => import(pathToFileURL(join(REPO_ROOT, file)).href);
const common = await load('mivo/lib/common.mjs');
const admission = await load('mivo/lib/admission.mjs');
const gates = await load('mivo/lib/gates.mjs');
const retry = await load('mivo/lib/retry.mjs');
const health = await load('mivo/lib/health.mjs');
const source = process.env.ROUND_FIXTURE_SOURCE_REV
  ? execFileSync('git', ['show', `${process.env.ROUND_FIXTURE_SOURCE_REV}:mivo/prereview/round.mjs`], { cwd: REPO_ROOT, encoding: 'utf8' })
  : readFileSync(join(REPO_ROOT, 'mivo/prereview/round.mjs'), 'utf8');

function extractFunction(name) {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(source);
  assert.ok(declaration, `Missing source function: ${name}`);
  const closing = /^\}/m.exec(source.slice(declaration.index));
  assert.ok(closing, `Missing column-zero closing brace: ${name}`);
  return source.slice(declaration.index, declaration.index + closing.index + 1);
}

function makeFixture(scenario) {
  for (const name of ['main', 'startDrive', 'drive', 'runQueue', 'resumeInflight', 'admitLoop']) extractFunction(name);
  const mainAt = /^(?:async\s+)?function\s+main\s*\(/m.exec(source).index;
  const prefix = source.slice(0, mainAt)
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^const HERE = .*;$/m, "const HERE = '/fixture/prereview';");
  const functions = [...source.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(/gm)]
    .filter((match) => match.index >= mainAt && match[1] !== 'collectServerRun')
    .map((match) => extractFunction(match[1])).join('\n\n');
  const files = new Map();
  const timers = [];
  const remoteRuns = new Map();
  const samples = [];
  const planFiles = [];
  const logs = [];
  let clockMs = Date.parse('2026-10-14T10:00:00Z');
  let nextRunId = 1000;
  let injected = false;
  let collectionsEnabled = scenario === 'failed';
  let releaseCount = 0;
  let dispatchCount = 0;
  const clone = (value) => structuredClone(value);
  const sample = (event) => samples.push({ event, actualInflight: remoteRuns.size });
  const configuration = { mode: 'sandbox', repoRoot: '/fixture/repo', stateDir: '/fixture/state',
    logDir: '/fixture/log', workflowRepo: 'fixture/review', workflowRef: 'main',
    targetRepo: 'fixture/target', maxParallel: 10, dailyCap: 100, pollSeconds: 30 };
  files.set('/fixture/config.json', configuration);
  const layout = scenario === 'resume'
    ? [['A', 1, 9, 1], ['B', 9, 0, 20]]
    : [['A', 10, 0, 1], ['B', 0, 1, 20]];
  for (const [name, running, queued, firstPr] of layout) {
    const planFile = `/fixture/${name}/plan.json`;
    planFiles.push(planFile);
    const prs = Array.from({ length: running + queued }, (_, index) => ({
      pr: firstPr + index, head: `head-${firstPr + index}`, base: 'base', baseRefName: 'main',
      contextFile: `/fixture/${name}/context-${firstPr + index}.json`,
    }));
    files.set(planFile, { runId: name, mode: 'review-only', repo: 'fixture/target',
      manifest: { candidates: prs.map((pr) => ({ number: pr.pr })) }, groups: [{ id: 1, prs }] });
    const tasks = prs.map((pr, index) => {
      const runId = String(nextRunId++);
      if (index < running) remoteRuns.set(runId, { pr: pr.pr, displayTitle: `existing-${pr.pr}` });
      return { pr: pr.pr, head: pr.head, phase: index < running ? 'running' : 'queued',
        agentId: index < running ? `gha:${runId}:existing` : null, boundAt: new Date(clockMs).toISOString() };
    });
    files.set(`/fixture/${name}/queue.json`, { tasks });
  }
  sample('existing runs before restart');
  const readJson = (file, fallback) => {
    if (files.has(file)) return clone(files.get(file));
    if (fallback !== undefined) return clone(fallback);
    throw new Error(`Unexpected missing fixture JSON: ${file}`);
  };
  const writeJson = (file, value) => files.set(file, clone(value));
  const queueCommand = (args) => {
    const action = args[0];
    const planFile = args[args.indexOf('--plan') + 1];
    const queue = files.get(join(dirname(planFile), 'queue.json'));
    assert.ok(queue, `Unknown fixture queue: ${planFile}`);
    const summary = () => ({ ok: true, queued: queue.tasks.filter((t) => t.phase === 'queued').map((t) => t.pr),
      active: queue.tasks.filter((t) => !['queued', 'complete'].includes(t.phase)),
      reconciled: queue.tasks.every((t) => t.phase === 'complete'), allComplete: queue.tasks.every((t) => t.phase === 'complete') });
    if (action === 'claim') {
      const task = queue.tasks.find((t) => t.phase === 'queued');
      if (!task || summary().active.length >= 10) return { ...summary(), claimed: false };
      task.phase = 'ready';
      const plan = files.get(planFile);
      const planned = plan.groups.flatMap((group) => group.prs).find((p) => p.pr === task.pr);
      return { ...summary(), claimed: true, task: { ...planned, ...clone(task), resultFile: join(dirname(planFile), 'results', `pr-${task.pr}.json`) } };
    }
    if (action === 'bind' || action === 'complete') {
      const pr = Number(args[args.indexOf('--pr') + 1]);
      const task = queue.tasks.find((t) => t.pr === pr);
      assert.ok(task, `Unknown fixture PR: ${pr}`);
      if (action === 'bind') { task.phase = 'running'; task.agentId = args[args.indexOf('--agent-id') + 1]; }
      else task.phase = 'complete';
    }
    if (action === 'close') writeJson(join(dirname(planFile), 'completed.json'), { completed: true });
    return { ...summary(), reopened: [] };
  };
  const runScript = (file, args) => {
    switch (basename(file)) {
      case 'admit-candidates.mjs':
        if (args.includes('--incomplete-only')) return { ok: true, incompletePlans: planFiles, exitCode: 0 };
        if (args.includes('--authority-only')) return { ok: true, digest: 'fixture-digest', exitCode: 0 };
        return { ok: true, exitCode: 2, excludedPrs: [] };
      case 'refresh-lock.mjs': return { ok: true, refreshed: true, lost: false };
      case 'pre-check.mjs': return { decision: 'run', reason: 'unfinished-round', resumePlan: planFiles[0], exitCode: 0 };
      case 'prepare.mjs': return { ok: true, lock: { acquired: true, token: 'fixture-token' }, maintainerAuthority: { verified: true, digest: 'fixture-digest' } };
      case 'review-queue.mjs': return queueCommand(args);
      case 'context.mjs': return { ok: true, meta: { state: 'OPEN', isDraft: false, headRefOid: `head-${args[0]}`, baseRefOid: 'base', baseRefName: 'main', labels: [] }, auto: { action: 'review' }, review: { tier: 'standard' } };
      case 'finalize-review-round.mjs': return { ok: true };
      case 'release-lock.mjs': releaseCount++; return { ok: true };
      case 'close-product-issue.mjs': return { ok: true, closedCount: 0 };
      default: throw new Error(`Unexpected external script: ${file}`);
    }
  };
  const run = (command, args) => {
    const output = (stdout) => ({ ok: true, status: 0, stdout, stderr: '' });
    if (command === 'git' || command === 'gh' && args[0] === 'variable') return output('fixture-sha\n');
    if (command === 'gh' && args[0] === 'api') return output('[]');
    if (command === 'gh' && args[0] === 'workflow' && args[1] === 'run') {
      const inputs = Object.fromEntries(args.filter((_, index) => args[index - 1] === '-f').map((arg) => arg.split('=')));
      const runId = String(nextRunId++);
      remoteRuns.set(runId, { pr: Number(inputs.pr), displayTitle: `review-pr #${inputs.pr} ${inputs.dispatch_id}` });
      dispatchCount++; sample(`dispatch ${runId}`);
      return output('');
    }
    if (command === 'gh' && args[0] === 'run' && args[1] === 'list') {
      return output(JSON.stringify([...remoteRuns].map(([databaseId, row]) => ({ databaseId, displayTitle: row.displayTitle }))));
    }
    throw new Error(`Unexpected external command: ${command} ${args.join(' ')}`);
  };
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clockMs])); }
    static now() { return clockMs; }
  }
  const sandbox = { ...common, ...admission, ...gates, ...retry,
    dirname, join, resolve, randomUUID, Date: FixtureDate,
    inBusinessWindow: () => health.inBusinessWindow(new Date(clockMs)),
    nowIso: () => new Date(clockMs).toISOString(), readJson, writeJson,
    writeText: (file, value) => files.set(file, value), run, runScript,
    runScriptAsync: async (...args) => { throw new Error(`Unexpected async script: ${args[0]}`); },
    mkdirSync() {}, appendFileSync(file, text) { logs.push(text); },
    existsSync: (file) => files.has(file),
    spawn: () => ({ exitCode: null, signalCode: null, kill() {} }),
    process: { argv: ['node', 'round.mjs', '--config', '/fixture/config.json'], env: {}, execPath: 'fixture-node' },
    console,
    setTimeout: (callback, delay) => { const timer = { callback, due: clockMs + Math.max(0, Number(delay) || 0) }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    collectServerRun: (ctx, entry) => {
      if (scenario === 'failed' && ctx.plan.runId === 'A' && !injected) {
        injected = true;
        throw new Error('fixture: server result collection failed');
      }
      if (!collectionsEnabled) return false;
      assert.ok(remoteRuns.delete(String(entry.runId)), `Unknown collected run: ${entry.runId}`);
      sample(`collect ${entry.runId}`);
      return true;
    },
  };
  vm.runInNewContext(`${prefix}\n${functions}\n globalThis.fixtureAPI = {
    start: () => main(),
    rounds: () => ROUNDS.map(r => ({runId:r.runId, finished:r.finished, inflight:r.inflight.size, queued:r.queued})),
  };`, sandbox, { filename: join(REPO_ROOT, 'mivo/prereview/round.mjs') });
  let settled = false;
  let failure = null;
  const completion = sandbox.fixtureAPI.start().then(() => { settled = true; }, (error) => { settled = true; failure = error; });
  const flush = () => new Promise(setImmediate);
  const step = async () => {
    await flush();
    timers.sort((a, b) => a.due - b.due);
    const timer = timers.shift();
    if (timer) { clockMs = timer.due; timer.callback(); }
    await flush();
  };
  return { completion, flush, step, samples, logs, enableCollections() { collectionsEnabled = true; },
    get peak() { return Math.max(...samples.map((sample) => sample.actualInflight)); },
    get settled() { return settled; }, get failure() { return failure; }, get injected() { return injected; },
    get releaseCount() { return releaseCount; }, get dispatchCount() { return dispatchCount; },
    snapshot: () => sandbox.fixtureAPI.rounds(),
  };
}

test('恢复全部轮次之前不得领取新任务；任何时刻实际服务器在途不得超过 10', { timeout: 3000 }, async () => {
  const fixture = makeFixture('resume');
  await fixture.flush();
  assert.equal(fixture.snapshot().length, 2, '必须恢复 A、B 两轮，不能靠漏恢复 B 满足上限');
  assert.ok(fixture.peak <= 10,
    `恢复时突破 maxParallel=10：实际服务器在途峰值=${fixture.peak}；${JSON.stringify(fixture.samples)}`);
  fixture.enableCollections();
  for (let step = 0; step < 48 && !fixture.settled; step++) {
    await fixture.step();
    assert.ok(fixture.peak <= 10, `恢复后处理 queued 时突破 maxParallel=10：实际服务器在途峰值=${fixture.peak}`);
  }
  assert.ok(fixture.settled, `恢复后主流程未在 48 步内结束：${JSON.stringify(fixture.snapshot())}`);
  assert.equal(fixture.failure, null, `恢复失败：${fixture.failure?.stack}`);
  assert.equal(fixture.dispatchCount, 9, '原有 10 个在途只续收；仅派发 A 的 9 个 queued');
  assert.equal(fixture.releaseCount, 1, '主流程结束后恰好释放一次锁');
});

test('失败轮次保留满额在途时，主流程必须在有限步内结束或整体中止', { timeout: 3000 }, async () => {
  const fixture = makeFixture('failed');
  for (let step = 0; step < 48 && !fixture.settled; step++) await fixture.step();
  assert.equal(fixture.injected, true, '必须实际触发 A 的收集异常');
  assert.equal(fixture.snapshot().length, 2, '必须包含正在等待的 B 轮');
  assert.ok(fixture.settled,
    `失败轮次永久占槽：主流程在 48 次虚拟定时器推进后仍未结束；${JSON.stringify(fixture.snapshot())}`);
  assert.equal(fixture.releaseCount, 1, '退出前必须恰好释放一次锁');
  // 允许正常回收后结束，或由 RoundAborted 使主流程 reject；禁止把 fixture 错误当作成功退出。
  if (fixture.failure) assert.match(String(fixture.failure.message), /server result collection failed|RoundAborted|abort|中止/i);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 「小世界」夹具(2026-10-14 修正方案 Step 1、2 的回归):假 GitHub(PR head、run 的排队/执行/结束/取消、按时间出现的
// run 列表)、假队列与 Cindy 脚本、虚拟时钟。round.mjs 从 main 起的全部函数原样运行,collectServerRun 也是真的。
// 同一个世界可以停掉一个进程再起新进程(进程内状态丢掉,磁盘、锁和 GitHub 状态保留)。
// ════════════════════════════════════════════════════════════════════════════════════════════════
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const WORLD_SOURCE = (() => {
  const mainAt = /^(?:async\s+)?function\s+main\s*\(/m.exec(source).index;
  const prefix = source.slice(0, mainAt).replace(/^import[^\n]*\n/gm, '').replace(/^const HERE = .*;$/m, "const HERE = '/w/prereview';");
  const functions = [...source.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(/gm)]
    .filter((m) => m.index >= mainAt).map((m) => extractFunction(m[1])).join('\n\n');
  return `${prefix}\n${functions}\nglobalThis.fixtureAPI = { start: () => main() };`;
})();

function makeWorld({ start = '2026-10-14T02:00:00Z', maxParallel = 10, instance = 'sandbox', mode = 'sandbox' } = {}) {
  const w = { now: Date.parse(start), files: new Map(), logs: [], procs: [], events: [], prs: new Map(), runs: new Map(), nextRunId: 5000,
    lock: null, nextToken: 1, authorityDigest: 'digest-1', skillSha: 'skill-1', dispatches: [], cancels: [], heartbeats: [], releases: [],
    dispatchFailures: [], hiddenUntil: new Map(), cancelFails: new Set(), noArtifact: new Set(), roundNo: 0, planDelayMs: 15_000, cancelDelayMs: 30_000,
    // 仓库副本 gc、钉住的 skill 版本、pre-check 的故障注入
    gitCalls: [], packs: 49, gcFails: false, pinned: null, pinFails: false, precheckFail: null,
    // 绕过原因提醒脚本:调用顺序记录、可注入的返回值或异常;服务器结果报 GitHub 限额的 PR 集合
    scriptOrder: [], bypassCalls: [], bypassResult: null, bypassThrows: false, rateLimited: new Set(),
    // 维护者作者改了受保护路径的 PR 集合(判门自动放行 + notice issue,派 protected-approve);notice 创建的故障注入与调用记录
    protectedAuthors: new Set(), noticeFailures: 0, noticeCalls: [],
    // 带 review:merge-ready 的 PR 集合、按 PR 覆盖 context 的字段(meta 浅合并)、被摘标签的 DELETE 路径记录
    labeled: new Set(), contextPatch: new Map(), labelDeletes: [] };
  const clone = (value) => structuredClone(value);
  w.files.set('/w/config.json', { instance, mode, repoRoot: '/w/repo', stateDir: '/w/state', logDir: '/w/log', workflowRepo: 'o/wf',
    workflowRef: 'main', targetRepo: 'o/target', maxParallel, dailyCap: 1000, pollSeconds: 30 });
  w.state = (name) => `/w/state/mivo/${name}`;
  w.read = (file) => (w.files.has(file) ? clone(w.files.get(file)) : undefined);
  w.openPr = (number, head, { durationMs = 10 * MIN, queueMs = 4_000 } = {}) => w.prs.set(number, { head, open: true, durationMs, queueMs });
  w.push = (number, head) => { w.prs.get(number).head = head; };
  w.schedule = (atMs, fn) => w.events.push({ atMs, fn });
  w.logged = (event) => w.logs.filter((line) => line.event === event);
  w.dispatchesOf = (pr) => w.dispatches.filter((d) => d.pr === pr);
  w.roundDir = (name) => `/w/state/rounds/${name}`;
  const planFiles = () => [...w.files.keys()].filter((f) => /^\/w\/state\/rounds\/[^/]+\/plan\.json$/.test(f))
    .sort((a, b) => w.files.get(a).createdMs - w.files.get(b).createdMs);
  w.incomplete = () => planFiles().filter((f) => !w.files.has(`${dirname(f)}/completed.json`));
  const busy = () => admission.toBusyPrs(w.incomplete().map((f) => ({ ...w.files.get(f), released: w.files.get(`${dirname(f)}/mivo-released.json`) ?? {} })));
  // 简化的候选规则:开着、不在未完成轮次里、round-state 里没有这个 head 的结论或标了 retry。
  const candidates = () => {
    const rows = admission.withDeferredGateRetries(w.files.get('/w/state/round-state.json') ?? {},
      w.incomplete().map((file) => ({ ...w.files.get(file), released: w.files.get(`${dirname(file)}/mivo-released.json`) ?? {} }))).prs;
    const taken = busy();
    return [...w.prs].filter(([n, p]) => p.open && !taken.has(n) && (!rows[n] || rows[n].head !== p.head || rows[n].retry))
      .map(([n, p]) => ({ number: n, head: p.head }));
  };
  w.seedRound = (name, tasks, { createdMs = w.now - MIN } = {}) => {
    const dir = w.roundDir(name);
    const prs = tasks.map((t) => ({ pr: t.pr, head: t.head, base: 'base', baseRefName: 'main', contextFile: `${dir}/context-${t.pr}.json` }));
    w.files.set(`${dir}/plan.json`, { runId: name, mode: 'review-only', repo: 'o/target', roundDir: dir, createdMs,
      manifest: { createdAt: iso(createdMs), candidates: prs.map((p) => ({ number: p.pr })) }, groups: [{ id: 1, prs }], execution: { worktreeCleanupRequired: true } });
    w.files.set(`${dir}/queue.json`, { tasks: tasks.map((t) => ({ pr: t.pr, head: t.head, phase: t.phase ?? 'queued', attempts: t.attempts ?? 0,
      agentId: t.agentId ?? null, boundAt: iso(createdMs) })) });
    return dir;
  };
  w.seedRun = (pr, head, roundId, dispatchId, { createdMs = w.now - MIN, durationMs = 10 * MIN, queueMs = 4_000 } = {}) => {
    const id = String(w.nextRunId++);
    w.runs.set(id, { id, pr, head, roundId, dispatchId, title: `review-pr #${pr} ${dispatchId}`, createdMs, durationMs, queueMs });
    return id;
  };
  const makePlan = (list) => {
    const name = `R${++w.roundNo}`;
    const dir = w.roundDir(name);
    const prs = list.map((c) => ({ pr: c.number, head: c.head, base: 'base', baseRefName: 'main', contextFile: `${dir}/context-${c.number}.json` }));
    w.files.set(`${dir}/plan.json`, { runId: name, mode: 'review-only', repo: 'o/target', roundDir: dir, createdMs: w.now,
      manifest: { createdAt: iso(w.now), candidates: list.map((c) => ({ number: c.number })) }, groups: [{ id: 1, prs }], execution: { worktreeCleanupRequired: true } });
    return { ok: true, runId: name, planFile: `${dir}/plan.json`, groups: [{ prs: prs.map((p) => ({ pr: p.pr })) }], skipped: [] };
  };
  const argOf = (args, name) => args[args.indexOf(name) + 1];
  const queueCommand = (args) => {
    const action = args[0];
    const planFile = argOf(args, '--plan');
    if (!w.lock || w.lock.token !== argOf(args, '--lock-token')) return { ok: false, error: '当前活动锁不属于本轮 review' };
    const dir = dirname(planFile);
    const plan = w.files.get(planFile);
    if (action === 'init') w.files.set(`${dir}/queue.json`, { tasks: plan.groups.flatMap((g) => g.prs).map((p) => ({ pr: p.pr, head: p.head, phase: 'queued', attempts: 0, agentId: null })) });
    const queue = w.files.get(`${dir}/queue.json`);
    const summary = () => ({ ok: true, queued: queue.tasks.filter((t) => t.phase === 'queued').map((t) => t.pr),
      active: queue.tasks.filter((t) => !['queued', 'complete'].includes(t.phase)),
      reconciled: queue.tasks.every((t) => t.phase === 'complete'), allComplete: queue.tasks.every((t) => t.phase === 'complete') });
    const task = queue.tasks.find((t) => t.pr === Number(argOf(args, '--pr')));
    if (action === 'claim') {
      const next = queue.tasks.find((t) => t.phase === 'queued');
      if (!next) return { ...summary(), claimed: false };
      next.phase = 'ready';
      next.attempts += 1;
      next.agentId = null;
      const planned = plan.groups.flatMap((g) => g.prs).find((p) => p.pr === next.pr);
      return { ...summary(), claimed: true, task: { ...planned, ...clone(next), resultFile: `${dir}/results/pr-${next.pr}.json` } };
    }
    if (action === 'bind') {
      const agentId = argOf(args, '--agent-id');
      if (!['ready', 'running'].includes(task.phase)) return { ok: false, error: `只能绑定已准备的任务(${task.phase})` };
      if (task.agentId && task.agentId !== agentId) return { ok: false, error: '该 PR 已有其他 agent' };
      Object.assign(task, { agentId, phase: 'running', boundAt: iso(w.now) });
    }
    if (action === 'complete') {
      if (task.phase === 'queued') return { ok: false, error: '未领取任务不能完成' };
      if (task.agentId ? task.agentId !== argOf(args, '--agent-id') : !args.includes('--no-agent-started')) return { ok: false, error: '退出回执不匹配' };
      if (!w.files.has(`${dir}/results/pr-${task.pr}.json`)) return { ok: false, error: '没有结果文件' };
      task.phase = 'complete';
    }
    if (action === 'close') w.files.set(`${dir}/completed.json`, { runId: plan.runId });
    return { ...summary(), reopened: [] };
  };
  const finalize = (args) => {
    const planFile = argOf(args, '--plan');
    if (!w.lock || w.lock.token !== argOf(args, '--lock-token')) return { ok: false, error: 'lock' };
    const dir = dirname(planFile);
    const plan = w.files.get(planFile);
    const state = w.files.get('/w/state/round-state.json') ?? { version: 1, mode: 'review-only', prs: {} };
    for (const p of plan.groups.flatMap((g) => g.prs)) {
      const result = w.files.get(`${dir}/results/pr-${p.pr}.json`);
      if (!result) return { ok: false, error: `#${p.pr} 没有结果` };
      if (w.files.get(`${dir}/mivo-released.json`)?.[p.pr]?.reason === 'gate-deferred') continue;
      // 与 review-round.mjs 的 round-owner 补丁同一规则:更新的轮次写过的行不写回。
      if (Date.parse(state.prs[p.pr]?.roundCreatedAt ?? '') > plan.createdMs) continue;
      state.prs[p.pr] = { head: result.head, outcome: result.outcome, roundCreatedAt: plan.manifest.createdAt,
        retry: result.retry === true || ['error', 'state-changed'].includes(result.outcome) };
    }
    w.files.set('/w/state/round-state.json', state);
    return { ok: true, enteredCount: 0, skippedCount: 0 };
  };
  const runScript = (file, args) => {
    switch (basename(file)) {
      case 'admit-candidates.mjs': {
        if (args.includes('--incomplete-only')) return { ok: true, incompletePlans: w.incomplete(), exitCode: 0 };
        if (args.includes('--authority-only')) return { ok: true, digest: w.authorityDigest, exitCode: 0 };
        const list = candidates();
        if (!list.length) return { ok: true, exitCode: 2, excludedPrs: [...busy()] };
        w.files.set('/w/state/admit-candidates.json', { candidates: list });
        return { ok: true, exitCode: 0, candidateList: '/w/state/admit-candidates.json', excludedPrs: [...busy()] };
      }
      case 'pre-check.mjs': {
        w.scriptOrder.push('pre-check');
        if (w.precheckFail) return { decision: null, reason: 'error', error: w.precheckFail, exitCode: 1 };
        const pending = w.incomplete();
        if (pending.length) return { decision: 'run', reason: 'unfinished-round', resumePlan: pending[0], exitCode: 0 };
        const list = candidates();
        if (!list.length) return { decision: 'skip', reason: 'no-review-candidates', exitCode: 2 };
        w.files.set('/w/state/review-candidates.json', { candidates: list });
        return { decision: 'run', reason: 'candidates-ready', candidateList: '/w/state/review-candidates.json', exitCode: 0 };
      }
      case 'prepare.mjs':
        if (w.lock && w.now - w.lock.refreshedAt < 60 * MIN) return { ok: true, lock: { acquired: false } };
        w.lock = { token: `tok-${w.nextToken++}`, refreshedAt: w.now };
        return { ok: true, lock: { acquired: true, token: w.lock.token }, maintainerAuthority: { verified: true, digest: w.authorityDigest } };
      case 'plan-review-round.mjs': return makePlan(w.files.get(argOf(args, '--candidate-list')).candidates);
      case 'review-queue.mjs': return queueCommand(args);
      case 'context.mjs': {
        const pr = w.prs.get(Number(args[0]));
        const author = w.protectedAuthors.has(Number(args[0]));
        const context = { ok: true, meta: { state: pr.open ? 'OPEN' : 'CLOSED', isDraft: false, headRefOid: pr.head, baseRefOid: 'base', baseRefName: 'main',
          labels: w.labeled.has(Number(args[0])) ? ['review:merge-ready'] : [],
          ...(author ? { author: 'PraiseZhu', url: `https://github.com/o/target/pull/${args[0]}` } : {}) },
        auto: { action: author ? 'skip-protected-path' : 'review' }, review: { tier: 'standard' },
        ...(author ? { signoff: {}, protectedPath: { files: ['.github/workflows/ci.yml'], released: { by: 'praisezhu', via: 'author-maintainer' } } } : {}) };
        const patch = w.contextPatch.get(Number(args[0]));
        return patch ? { ...context, ...clone(patch), meta: { ...context.meta, ...clone(patch.meta ?? {}) } } : context;
      }
      case 'signoff-hold.mjs':
        w.noticeCalls.push([...args]);
        if (w.noticeFailures > 0) {
          w.noticeFailures -= 1;
          return { ok: true, issueCreated: false, issueError: 'temporary 503' };
        }
        return { ok: true, issueCreated: true };
      case 'finalize-review-round.mjs': return finalize(args);
      case 'refresh-lock.mjs':
        if (w.lock?.token !== argOf(args, '--token')) return { ok: true, refreshed: false, lost: true, error: null };
        w.lock.refreshedAt = w.now;
        return { ok: true, refreshed: true, lost: false, error: null };
      case 'release-lock.mjs':
        if (w.lock?.token !== argOf(args, '--token')) return { ok: true, released: false, notOwner: Boolean(w.lock), alreadyAbsent: !w.lock };
        w.releases.push(w.lock.token);
        w.lock = null;
        return { ok: true, released: true };
      case 'close-product-issue.mjs': return { ok: true, closedCount: 0 };
      case 'bypass-reason.mjs':
        w.scriptOrder.push('bypass-reason');
        w.bypassCalls.push([...args]);
        if (w.bypassThrows) throw new Error('spawn 失败');
        return w.bypassResult ?? { ok: true, reminded: [], skipped: [], exitCode: 0 };
      default: throw new Error(`Unexpected external script: ${file}`);
    }
  };
  const runView = (r) => {
    const startMs = r.createdMs + r.queueMs;
    let endMs = startMs + r.durationMs;
    let conclusion = 'success';
    if (r.cancelMs !== undefined && r.cancelMs + w.cancelDelayMs < endMs) { endMs = r.cancelMs + w.cancelDelayMs; conclusion = 'cancelled'; }
    const base = { createdAt: iso(r.createdMs) };
    if (w.now >= endMs) return { ...base, status: 'completed', conclusion, jobs: startMs < endMs ? [{ status: 'completed', startedAt: iso(startMs) }] : [] };
    if (w.now >= startMs) return { ...base, status: 'in_progress', conclusion: null, jobs: [{ status: 'in_progress', startedAt: iso(startMs) }] };
    return { ...base, status: 'queued', conclusion: null, jobs: [{ status: 'queued', startedAt: '0001-01-01T00:00:00Z' }] };
  };
  const ok = (stdout = '') => ({ ok: true, status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', error: null });
  const fail = (stderr) => ({ ok: false, status: 1, stdout: '', stderr, error: null });
  const run = (command, args) => {
    if (command === 'sleep') { w.now += Number(args[0]) * 1000; return ok(); }
    if (command === 'git') {
      w.gitCalls.push([...args]); // 复制成本测试的数组,deepStrictEqual 才不比较到 vm 里的原型
      if (args.includes('count-objects')) return ok(`count: 0\nsize: 0\nin-pack: 100\npacks: ${w.packs}\n`);
      if (args.includes('gc')) {
        if (w.gcFails) return fail('fatal: gc is already running on machine');
        w.packs = 1;
        return ok();
      }
      return ok(`${w.skillSha}\n`);
    }
    if (args[0] === '-c' && String(args[1]).includes('command -v gh')) return ok('gh-real\n');
    if (command !== 'gh') throw new Error(`Unexpected external command: ${command}`);
    const path = args.find((a) => /^repos\//.test(a)) ?? '';
    if (args[0] === 'variable' && args[1] === 'get') return w.pinFails ? fail('HTTP 502: Bad Gateway') : ok(`${w.pinned ?? w.skillSha}\n`);
    if (args[0] === 'variable' && args[1] === 'set') { w.heartbeats.push({ at: w.now, value: argOf(args, '--body') }); return ok(); }
    if (args[0] === 'api' && path.startsWith('repos/o/target/issues')) {
      if (args.includes('DELETE') && path.includes('/labels/')) {
        w.labelDeletes.push(path);
        w.labeled.delete(Number(path.match(/issues\/(\d+)\//)[1]));
      }
      return ok(args.includes('DELETE') ? '' : '[]');
    }
    if (args[0] === 'api' && path.includes('/check-runs')) return ok({ check_runs: [] });
    if (args[0] === 'api' && path.startsWith('repos/o/target/pulls?state=open')) {
      return ok([[...w.prs].filter(([, p]) => p.open).map(([number, p]) => ({ number, head: { sha: p.head } }))]);
    }
    if (args[0] === 'api' && path.includes('/actions/workflows/review-pr.yml/runs')) {
      const since = Date.parse(path.match(/created=>=([^&]+)/)[1]);
      const list = [...w.runs.values()].filter((r) => r.createdMs >= since && !((w.hiddenUntil.get(r.dispatchId) ?? 0) > w.now))
        .map((r) => ({ id: Number(r.id), display_title: r.title }));
      return ok([{ total_count: list.length, workflow_runs: list }]);
    }
    if (args[0] === 'workflow' && args[1] === 'run') {
      const inputs = Object.fromEntries(args.filter((_, i) => args[i - 1] === '-f').map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
      const failure = w.dispatchFailures.shift();
      if (failure === 'rejected') return fail('could not create workflow dispatch event: HTTP 422: Unexpected inputs provided');
      const pr = Number(inputs.pr);
      if (failure !== 'lost') {
        const spec = w.prs.get(pr);
        const id = String(w.nextRunId++);
        w.runs.set(id, { id, pr, head: inputs.head_sha, roundId: inputs.round_id, dispatchId: inputs.dispatch_id,
          title: `review-pr #${pr} ${inputs.dispatch_id}`, createdMs: w.now, durationMs: spec.durationMs, queueMs: spec.queueMs });
        w.dispatches.push({ at: w.now, pr, head: inputs.head_sha, dispatchId: inputs.dispatch_id, runId: id, attempt: inputs.attempt });
      }
      return failure ? fail('HTTP 502: Bad Gateway') : ok();
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const r = w.runs.get(args[2]);
      if (!r) return fail('HTTP 404: Not Found');
      return argOf(args, '--json') === 'displayTitle' ? ok({ displayTitle: r.title }) : ok(runView(r));
    }
    if (args[0] === 'run' && args[1] === 'cancel') {
      const r = w.runs.get(args[2]);
      w.cancels.push({ at: w.now, runId: args[2] });
      if (w.cancelFails.has(args[2])) return fail('HTTP 500: Internal Server Error');
      if (runView(r).status === 'completed') return fail('Cannot cancel a workflow run that is completed.');
      r.cancelMs ??= w.now;
      return ok();
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const r = w.runs.get(args[2]);
      const view = runView(r);
      if (view.status !== 'completed' || view.conclusion !== 'success' || w.noArtifact.has(r.pr)) return fail('no valid artifacts found to download');
      const same = w.prs.get(r.pr).head === r.head;
      const dir = argOf(args, '-D');
      const limited = w.rateLimited.has(r.pr);
      const limitedReason = `context 读取失败:gh pr view ${r.pr} --repo o/target --json headRefOid,baseRefOid,baseRefName 退出码 1: GraphQL: API rate limit already exceeded for user ID 1.`;
      w.files.set(`${dir}/result.json`, w.protectedAuthors.has(r.pr)
        ? { runId: r.roundId, mode: 'review-only', pr: r.pr, head: r.head, base: 'base', merged: false, threadUrls: [], enteredReview: false, reviewed: false, reviewClean: false,
          outcome: 'protected', reason: '受保护路径:作者为维护者,自动放行', authorNotice: gates.toAutoReleaseNotice({ head: r.head, by: 'praisezhu' }),
          errors: [], warnings: [], mivo: { reportComplete: false } }
        : limited
        ? { runId: r.roundId, mode: 'review-only', pr: r.pr, head: r.head, base: 'base', merged: false, threadUrls: [], enteredReview: false, reviewed: false, reviewClean: false,
          outcome: 'error', reason: limitedReason, retry: true, errors: [limitedReason], warnings: [],
          mivo: { reportComplete: false, ...(w.rateLimitedAfterModel ? { codex: { attempts: [{ model: 'm', ok: true }] } } : {}) } }
        : { runId: r.roundId, mode: 'review-only', pr: r.pr, head: r.head, base: 'base', merged: false, threadUrls: [],
          enteredReview: same, reviewed: same, reviewClean: same, outcome: same ? 'approval' : 'state-changed', reason: same ? '审查通过' : '发布前 PR 已变化',
          retry: !same, errors: [], warnings: [], mivo: { reportComplete: same } });
      w.files.set(`${dir}/report.md`, 'report');
      return ok();
    }
    throw new Error(`Unexpected external command: gh ${args.join(' ')}`);
  };
  w.start = () => {
    const proc = { no: w.procs.length + 1, timers: [], settled: false, failure: null, stopped: false };
    const vSetTimeout = (callback, delay) => { const t = { callback, due: w.now + Math.max(0, Number(delay) || 0), proc }; proc.timers.push(t); return t; };
    class FixtureDate extends Date {
      constructor(...args) { super(...(args.length ? args : [w.now])); }
      static now() { return w.now; }
    }
    const sandbox = { ...common, ...admission, ...gates, ...retry, dirname, join, resolve, randomUUID, Date: FixtureDate,
      inBusinessWindow: () => health.inBusinessWindow(new Date(w.now)), nowIso: () => iso(w.now),
      readJson: (file, fallback) => {
        if (w.files.has(file)) return clone(w.files.get(file));
        if (fallback !== undefined) return clone(fallback);
        throw new Error(`读取 ${file} 失败`);
      },
      writeJson: (file, value) => { w.files.set(file, clone(value)); },
      writeText: (file, value) => { w.files.set(file, value); },
      run, runScript,
      runScriptAsync: (file, args) => new Promise((done) => vSetTimeout(() => done(runScript(file, args)), w.planDelayMs)),
      mkdirSync() {}, copyFileSync: (from, to) => { w.files.set(to, w.files.get(from)); }, unlinkSync: (file) => { w.files.delete(file); },
      appendFileSync(file, text) { w.logs.push({ ...JSON.parse(text), proc: proc.no }); },
      existsSync: (file) => w.files.has(file),
      spawn: () => ({ exitCode: null, signalCode: null, kill() {} }),
      process: { argv: ['node', 'round.mjs', '--config', '/w/config.json'], env: {}, execPath: 'fixture-node', pid: 4242 + proc.no },
      console, setTimeout: vSetTimeout,
      clearTimeout: (t) => { const i = proc.timers.indexOf(t); if (i >= 0) proc.timers.splice(i, 1); },
    };
    vm.runInNewContext(WORLD_SOURCE, sandbox, { filename: join(REPO_ROOT, 'mivo/prereview/round.mjs') });
    sandbox.fixtureAPI.start().then(() => { proc.settled = true; }, (error) => { proc.settled = true; proc.failure = error; });
    proc.stop = () => { proc.stopped = true; proc.timers.length = 0; };
    w.procs.push(proc);
    return proc;
  };
  const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(setImmediate); };
  w.step = async () => {
    await flush();
    const timers = w.procs.filter((p) => !p.stopped && !p.settled).flatMap((p) => p.timers).sort((a, b) => a.due - b.due);
    if (!timers.length) return false;
    const next = timers[0];
    next.proc.timers.splice(next.proc.timers.indexOf(next), 1);
    w.now = Math.max(w.now, next.due);
    for (const event of w.events.filter((e) => e.atMs <= w.now).sort((a, b) => a.atMs - b.atMs)) {
      w.events.splice(w.events.indexOf(event), 1);
      event.fn();
    }
    next.callback();
    await flush();
    return true;
  };
  // 推进到条件成立、没有可推进的定时器或超过 maxMs 为止;返回条件是否成立。
  w.runUntil = async (predicate, { maxMs = 24 * 60 * MIN } = {}) => {
    const limit = w.now + maxMs;
    await flush();
    while (!predicate() && w.now <= limit) if (!(await w.step())) break;
    return predicate();
  };
  return w;
}

test('世界:轮次重叠满 61 分钟仍接单;在审 heavy 没结束时,后到的 PR 在下一个检查点被接单', async () => {
  const w = makeWorld();
  const t0 = w.now;
  w.openPr(1, 'h1', { durationMs: 130 * MIN });
  w.schedule(t0 + 65 * MIN, () => w.openPr(2, 'h2', { durationMs: 9 * MIN }));
  w.schedule(t0 + 80 * MIN, () => w.openPr(3, 'h3', { durationMs: 9 * MIN }));
  const proc = w.start();
  assert.ok(await w.runUntil(() => w.dispatchesOf(3).length > 0, { maxMs: 100 * MIN }));
  for (const [pr, openedAt] of [[2, 65], [3, 80]]) {
    const waited = (w.dispatchesOf(pr)[0].at - (t0 + openedAt * MIN)) / MIN;
    assert.ok(waited <= 4, `#${pr} 等了 ${waited.toFixed(1)} 分钟`);
  }
  assert.equal(w.logged('admission-closed').length, 0, '轮次重叠 60 分钟以上也不关门');
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 200 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.deepEqual([1, 2, 3].map((pr) => w.dispatchesOf(pr).length), [1, 1, 1], '没有重复派发');
  assert.equal(w.lock, null, '所有轮次结束后释放锁、进程退出');
});

test('世界:进入 06:00 维护窗口停止接单,手上的跑完就退出;空闲时照旧正常退出', async () => {
  const w = makeWorld({ start: '2026-10-14T21:50:00Z' }); // 北京 05:50
  w.openPr(1, 'h1', { durationMs: 30 * MIN });
  w.schedule(Date.parse('2026-10-14T22:02:00Z'), () => w.openPr(2, 'h2'));
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.deepEqual(w.logged('admission-closed').map((e) => e.reason), ['maintenance-window']);
  assert.equal(w.dispatchesOf(2).length, 0, '窗口里来的 PR 不开新轮');
  assert.ok(w.logged('collected').some((e) => e.pr === 1), '在审的自然跑完');
  const idle = makeWorld();
  const quiet = idle.start();
  assert.ok(await idle.runUntil(() => quiet.settled));
  assert.equal(quiet.failure, null);
  assert.equal(idle.logged('no-candidates').length, 1);
  assert.equal(idle.lock, null);
});

test('世界:续锁失败后不再领取、派发、取消、写心跳,也不释放锁;进程非 0 退出,未完成轮次留给持锁者', async () => {
  const w = makeWorld({ maxParallel: 1, instance: 'mivo', mode: 'live' });
  w.openPr(1, 'h1', { durationMs: 60 * MIN });
  w.openPr(2, 'h2');
  const proc = w.start();
  assert.ok(await w.runUntil(() => w.dispatchesOf(1).length === 1));
  w.push(1, 'h1b'); // 有人推了新提交:没丢锁时会取消旧审查
  const heartbeats = w.heartbeats.length;
  w.lock = { token: 'other-process', refreshedAt: w.now };
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 30 * MIN }));
  assert.match(String(proc.failure?.message), /续锁失败/);
  assert.equal(w.logged('lock-lost').length, 1);
  assert.equal(w.dispatchesOf(2).length, 0, '不再领取和派发');
  assert.equal(w.cancels.length, 0, '不再取消');
  assert.equal(w.heartbeats.length, heartbeats, '隔离后不写心跳');
  assert.equal(w.lock.token, 'other-process', '不释放别人的锁');
  assert.equal(w.releases.length, 0);
  assert.equal(w.incomplete().length, 1, '未完成轮次留给持锁者恢复');
});

test('世界:维护者名单不变时连续开两轮;名单变了就停止接单,手上的跑完退出', async () => {
  const w = makeWorld();
  const t0 = w.now;
  w.openPr(1, 'h1', { durationMs: 40 * MIN });
  w.schedule(t0 + 4 * MIN, () => w.openPr(2, 'h2', { durationMs: 30 * MIN }));
  w.schedule(t0 + 10 * MIN, () => w.openPr(3, 'h3', { durationMs: 20 * MIN }));
  w.schedule(t0 + 14 * MIN, () => { w.authorityDigest = 'digest-2'; });
  w.schedule(t0 + 16 * MIN, () => w.openPr(4, 'h4'));
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 120 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.deepEqual([2, 3, 4].map((pr) => w.dispatchesOf(pr).length), [1, 1, 0]);
  assert.equal(w.logged('authority-changed').length, 1);
  assert.deepEqual(w.logged('admission-closed').map((e) => e.reason), ['authority-changed']);
});

test('世界:异步 plan 回来时 skill 已换版本就不启动这一轮,plan 留在磁盘上,下次启动恢复', async () => {
  const w = makeWorld();
  const t0 = w.now;
  w.planDelayMs = 5 * MIN;
  w.openPr(1, 'h1', { durationMs: 30 * MIN });
  w.schedule(t0 + 2 * MIN, () => w.openPr(2, 'h2'));
  w.schedule(t0 + 4 * MIN, () => { w.skillSha = 'skill-2'; });
  const first = w.start();
  assert.ok(await w.runUntil(() => first.settled, { maxMs: 60 * MIN }));
  assert.equal(first.failure, null, String(first.failure?.stack));
  assert.deepEqual(w.logged('admit-deferred').map((e) => e.reason), ['skill-updated']);
  assert.equal(w.dispatchesOf(2).length, 0);
  assert.equal(w.incomplete().length, 1, '没启动的 plan 是未完成轮次');
  const next = w.start();
  assert.ok(await w.runUntil(() => next.settled, { maxMs: 60 * MIN }));
  assert.equal(next.failure, null, String(next.failure?.stack));
  assert.equal(w.dispatchesOf(2).length, 1);
});

test('世界:派发意图停在 prepared(还没外发)时进程被杀,恢复后按没派出处理,下一轮只派一次', async () => {
  const w = makeWorld();
  w.openPr(7, 'h7');
  const dir = w.seedRound('R0', [{ pr: 7, head: 'h7', phase: 'ready', attempts: 1 }]);
  w.files.set(`${dir}/dispatch-intent-7.json`, { pr: 7, head: 'h7', dispatchId: 'prep0001', attempt: 1, claimAttempt: 1, intentAt: iso(w.now - MIN), state: 'prepared' });
  for (let i = 0; i < 2; i += 1) {
    const proc = w.start();
    assert.ok(await w.runUntil(() => proc.settled, { maxMs: 60 * MIN }));
    assert.equal(proc.failure, null, String(proc.failure?.stack));
  }
  assert.ok(w.logged('resume-orphan').some((e) => e.pr === 7 && e.intent === 'prepared'));
  assert.equal(w.dispatchesOf(7).length, 1, '恢复后只重发一次');
});

test('世界:dispatching 时被杀而 GitHub 已接受,恢复后不重发,按 dispatch_id 找回并收结果', async () => {
  const w = makeWorld();
  w.openPr(7, 'h7');
  const dir = w.seedRound('R0', [{ pr: 7, head: 'h7', phase: 'ready', attempts: 1 }]);
  w.seedRun(7, 'h7', 'R0', 'disp0002');
  w.files.set(`${dir}/dispatch-intent-7.json`, { pr: 7, head: 'h7', dispatchId: 'disp0002', attempt: 1, claimAttempt: 1, intentAt: iso(w.now - MIN), state: 'dispatching' });
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.equal(w.dispatches.length, 0, '不重发');
  assert.equal(w.logged('dispatch-found').length, 1);
  assert.ok(w.logged('collected').some((e) => e.pr === 7 && e.outcome === 'approval'));
});

test('世界:sent 之后 run 一时查不到:记未知、继续占槽,查到后绑定;占槽期间不派别的 PR', async () => {
  const w = makeWorld({ maxParallel: 1 });
  w.openPr(7, 'h7', { durationMs: 10 * MIN });
  w.openPr(8, 'h8');
  const dir = w.seedRound('R0', [{ pr: 7, head: 'h7', phase: 'ready', attempts: 1 }, { pr: 8, head: 'h8' }]);
  const runId = w.seedRun(7, 'h7', 'R0', 'disp0003', { createdMs: w.now - MIN });
  w.hiddenUntil.set('disp0003', w.now + 10 * MIN);
  w.files.set(`${dir}/dispatch-intent-7.json`, { pr: 7, head: 'h7', dispatchId: 'disp0003', attempt: 1, claimAttempt: 1, intentAt: iso(w.now - MIN), state: 'sent' });
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 90 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  const end = w.runs.get(runId).createdMs + w.runs.get(runId).queueMs + w.runs.get(runId).durationMs;
  assert.ok(w.dispatchesOf(8)[0].at >= end, '#7 的派发查清并结束前,#8 拿不到槽');
  assert.equal(w.dispatchesOf(7).length, 0, '#7 不重发');
});

test('世界:60 分钟还找不到 run:记 dispatch-unresolved,占槽、不重派、新提交也不解锁;人工解除 not-submitted 后才释放', async () => {
  const w = makeWorld({ maxParallel: 1 });
  const t0 = w.now;
  w.openPr(7, 'h7');
  w.openPr(8, 'h8');
  const dir = w.seedRound('R0', [{ pr: 7, head: 'h7', phase: 'ready', attempts: 1 }, { pr: 8, head: 'h8' }]);
  w.files.set(`${dir}/dispatch-intent-7.json`, { pr: 7, head: 'h7', dispatchId: 'lost0004', attempt: 1, claimAttempt: 1, intentAt: iso(t0), state: 'sent' });
  w.schedule(t0 + 70 * MIN, () => w.push(7, 'h7b'));
  const proc = w.start();
  await w.runUntil(() => false, { maxMs: 85 * MIN });
  assert.equal(proc.settled, false, '未决派发占着槽,进程不收尾');
  assert.equal(w.logged('dispatch-unresolved').length, 1);
  assert.equal(w.dispatches.length, 0, '#7 不重派,#8 也拿不到槽');
  w.files.set(w.state('dispatch-resolution-lost0004.json'), { resolution: 'not-submitted' });
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.equal(w.logged('dispatch-resolved').length, 1);
  assert.equal(w.files.has(w.state('dispatch-resolution-lost0004.json')), false, '解除记录处理完就删');
  assert.equal(w.read(`${dir}/dispatch-intent-7.json`).resolution.kind, 'not-submitted', '先写进意图文件');
  assert.equal(w.read(`${dir}/results/pr-7.json`).outcome, 'error');
  assert.equal(w.dispatchesOf(8).length, 1, '解除后才释放槽');
  const next = w.start();
  assert.ok(await w.runUntil(() => next.settled, { maxMs: 60 * MIN }));
  assert.deepEqual(w.dispatchesOf(7).map((d) => d.head), ['h7b'], 'PR 回到候选,新 head 才派');
  assert.deepEqual(w.read(w.state('reviews.json')).prs[7].failures ?? {}, {}, '不计失败次数');
});

test('世界:人工解除 found:runId 对不上就忽略;对上了只把未知变成已知 run,run 结束才释放槽', async () => {
  const w = makeWorld({ maxParallel: 1 });
  w.openPr(7, 'h7', { durationMs: 30 * MIN });
  w.openPr(8, 'h8');
  const dir = w.seedRound('R0', [{ pr: 7, head: 'h7', phase: 'ready', attempts: 1 }, { pr: 8, head: 'h8' }]);
  const runId = w.seedRun(7, 'h7', 'R0', 'hide0005', { createdMs: w.now, durationMs: 30 * MIN });
  const other = w.seedRun(9, 'h9', 'R9', 'zzzz9999', { createdMs: w.now });
  w.hiddenUntil.set('hide0005', Infinity);
  w.files.set(`${dir}/dispatch-intent-7.json`, { pr: 7, head: 'h7', dispatchId: 'hide0005', attempt: 1, claimAttempt: 1, intentAt: iso(w.now), state: 'sent' });
  w.files.set(w.state('dispatch-resolution-hide0005.json'), { resolution: 'found', runId: other });
  const proc = w.start();
  await w.runUntil(() => false, { maxMs: 5 * MIN });
  assert.equal(w.logged('dispatch-resolution-invalid').length, 1, 'runId 不带这个 dispatch_id:忽略');
  assert.equal(w.logged('dispatch-resolved').length, 0);
  w.files.set(w.state('dispatch-resolution-hide0005.json'), { resolution: 'found', runId });
  await w.runUntil(() => w.logged('dispatch-resolved').length === 1, { maxMs: 5 * MIN });
  assert.equal(w.read(`${dir}/dispatch-intent-7.json`).state, 'bound');
  assert.equal(w.files.has(w.state('dispatch-resolution-hide0005.json')), false);
  assert.equal(w.dispatchesOf(8).length, 0, '找回了 run 也照样占槽,直到它结束');
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 90 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  const end = w.runs.get(runId).createdMs + w.runs.get(runId).queueMs + w.runs.get(runId).durationMs;
  assert.ok(w.dispatchesOf(8)[0].at >= end);
  assert.ok(w.logged('collected').some((e) => e.pr === 7 && e.outcome === 'approval'));
});

test('世界:解除结果已写进意图、解除记录还没删时被杀:重启后只补记日志和删除,不重复处理', async () => {
  const w = makeWorld();
  w.openPr(7, 'h7');
  const dir = w.seedRound('R0', [{ pr: 7, head: 'h7', phase: 'ready', attempts: 1 }]);
  w.files.set(`${dir}/dispatch-intent-7.json`, { pr: 7, head: 'h7', dispatchId: 'half0006', attempt: 1, claimAttempt: 1, intentAt: iso(w.now - 90 * MIN),
    state: 'not-submitted', resolution: { kind: 'not-submitted', at: iso(w.now - MIN) } });
  w.files.set(w.state('dispatch-resolution-half0006.json'), { resolution: 'not-submitted' });
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 30 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.equal(w.logged('dispatch-resolved').length, 1);
  assert.equal(w.files.has(w.state('dispatch-resolution-half0006.json')), false);
  assert.equal(w.logged('dispatch-unresolved').length, 0);
  assert.equal(w.dispatches.length, 0);
});

test('世界:gh workflow run 明确 4xx 被拒才按失败重试;502 按未知,不重发,按 dispatch_id 找回', async () => {
  const w = makeWorld();
  w.openPr(7, 'h7');
  w.openPr(8, 'h8');
  w.dispatchFailures.push('rejected', 'unknown-created');
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  const r7 = w.read(`${w.roundDir('R1')}/results/pr-7.json`);
  assert.match(r7.reason, /派发服务器审查被拒/);
  assert.equal(w.read(`${w.roundDir('R1')}/dispatch-intent-7.json`).state, 'rejected');
  assert.equal(w.dispatchesOf(8).length, 1, '502 但已建出的 run 只有一个');
  assert.ok(w.logged('dispatch-unknown').some((e) => e.pr === 8));
  assert.ok(w.logged('collected').some((e) => e.pr === 8 && e.outcome === 'approval'));
});

test('世界:部署暂停——在跑的进程不开新轮、不领取、不派发,在审归零后握手退出;再拉起不拿锁;新版本恢复剩下的任务', async () => {
  const held = makeWorld();
  held.openPr(1, 'h1');
  held.files.set(held.state('deploy-hold.json'), { at: iso(held.now) });
  const early = held.start();
  assert.ok(await held.runUntil(() => early.settled));
  assert.equal(held.lock, null, '启动即退出,不拿锁');
  assert.equal(held.logged('deploy-hold').length, 1);

  const w = makeWorld({ maxParallel: 1 });
  w.openPr(1, 'h1', { durationMs: 20 * MIN });
  w.openPr(2, 'h2');
  w.openPr(3, 'h3');
  const proc = w.start();
  assert.ok(await w.runUntil(() => w.dispatchesOf(1).length === 1));
  w.files.set(w.state('deploy-hold.json'), { at: iso(w.now) });
  w.schedule(w.now + 5 * MIN, () => w.openPr(4, 'h4'));
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.deepEqual(w.read(w.state('quiesced.json')).lockReleased, true);
  assert.equal(w.lock, null);
  assert.equal(w.dispatches.length, 1, '暂停后不再派发');
  assert.deepEqual(w.read(`${w.roundDir('R1')}/queue.json`).tasks.filter((t) => t.phase === 'queued').map((t) => t.pr), [2, 3], '还没领取的任务留在轮次文件里');
  const again = w.start();
  assert.ok(await w.runUntil(() => again.settled));
  assert.equal(w.lock, null, '握手后 launchd 再拉起:不拿锁');
  w.files.delete(w.state('deploy-hold.json'));
  w.files.delete(w.state('quiesced.json'));
  const fresh = w.start();
  assert.ok(await w.runUntil(() => fresh.settled, { maxMs: 120 * MIN }));
  assert.equal(fresh.failure, null, String(fresh.failure?.stack));
  assert.deepEqual([2, 3].map((pr) => w.dispatchesOf(pr).length), [1, 1], '新版本立即拿到锁并恢复这些任务');
});

test('世界:部署暂停时只剩未决派发:照样握手退出,意图留着;新版本接着按 dispatch_id 找、照样占槽,别的 PR 照常派', async () => {
  const w = makeWorld({ maxParallel: 2 });
  w.openPr(7, 'h7');
  const dir = w.seedRound('R0', [{ pr: 7, head: 'h7', phase: 'ready', attempts: 1 }]);
  w.files.set(`${dir}/dispatch-intent-7.json`, { pr: 7, head: 'h7', dispatchId: 'lost0007', attempt: 1, claimAttempt: 1, intentAt: iso(w.now), state: 'dispatching' });
  const proc = w.start();
  await w.runUntil(() => false, { maxMs: 2 * MIN });
  w.files.set(w.state('deploy-hold.json'), { at: iso(w.now) });
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 10 * MIN }), '未决派发不再挡住停机握手');
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.equal(w.read(w.state('quiesced.json')).lockReleased, true);
  assert.equal(w.lock, null);
  assert.deepEqual(w.logged('round-quiesced').map((e) => [e.runId, e.reason, e.unresolved]), [['R0', 'deploy-hold', 1]]);
  assert.equal(w.read(`${dir}/dispatch-intent-7.json`).state, 'dispatching', '意图文件留给新版本');
  assert.equal(w.files.has(`${dir}/completed.json`), false, '这一轮不收尾');
  w.files.delete(w.state('deploy-hold.json'));
  w.files.delete(w.state('quiesced.json'));
  w.openPr(8, 'h8');
  const fresh = w.start();
  assert.ok(await w.runUntil(() => w.dispatchesOf(8).length === 1, { maxMs: 30 * MIN }), '新版本照常接单');
  assert.equal(w.dispatchesOf(7).length, 0, '#7 不重派');
  assert.ok(w.logged('resume-dispatch').some((e) => e.pr === 7 && e.state === 'dispatching'), '按 dispatch_id 接着找');
  w.files.set(w.state('dispatch-resolution-lost0007.json'), { resolution: 'not-submitted' });
  assert.ok(await w.runUntil(() => fresh.settled, { maxMs: 90 * MIN }));
  assert.equal(fresh.failure, null, String(fresh.failure?.stack));
});

test('世界:06:00 停止接单后只剩未决派发:这一轮停下、放锁退出;07:00 后新进程带着占位接着找,并照常接新 PR', async () => {
  const w = makeWorld({ start: '2026-10-14T21:00:00Z', maxParallel: 2 }); // 北京 05:00
  w.openPr(7, 'h7');
  const dir = w.seedRound('R0', [{ pr: 7, head: 'h7', phase: 'ready', attempts: 1 }]);
  w.files.set(`${dir}/dispatch-intent-7.json`, { pr: 7, head: 'h7', dispatchId: 'lost0011', attempt: 1, claimAttempt: 1, intentAt: iso(w.now - 10 * MIN), state: 'sent' });
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 90 * MIN }), '停止接单后不再空等');
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.ok(w.now >= Date.parse('2026-10-14T22:00:00Z'), '06:00 之前照常等');
  assert.deepEqual(w.logged('admission-closed').map((e) => e.reason), ['maintenance-window']);
  assert.deepEqual(w.logged('round-quiesced').map((e) => [e.runId, e.reason, e.unresolved]), [['R0', 'unresolved-only', 1]]);
  assert.equal(w.lock, null, '放锁,launchd 能拉起新进程');
  assert.equal(w.read(`${dir}/dispatch-intent-7.json`).state, 'sent', '意图文件留着');
  assert.equal(w.files.has(`${dir}/completed.json`), false, '这一轮不收尾');
  w.now = Date.parse('2026-10-14T23:05:00Z'); // 北京 07:05,launchd 拉起新进程
  w.openPr(8, 'h8');
  const next = w.start();
  assert.ok(await w.runUntil(() => w.dispatchesOf(8).length === 1, { maxMs: 30 * MIN }), '新 PR 照常派出');
  assert.equal(w.dispatchesOf(7).length, 0, '#7 不重派');
  assert.ok(w.logged('resume-dispatch').some((e) => e.pr === 7 && e.state === 'sent'), '带着占位接着找');
  assert.equal(next.settled, false, '占位还在,这一轮继续找');
});

test('世界:未决派发满 60 分钟就停写心跳,跨进程保留(维护窗口里启动也不写);人工解除后恢复写', async () => {
  const w = makeWorld({ start: '2026-10-14T21:00:00Z', maxParallel: 2, instance: 'mivo', mode: 'live' }); // 北京 05:00
  w.openPr(7, 'h7');
  const dir = w.seedRound('R0', [{ pr: 7, head: 'h7', phase: 'ready', attempts: 1 }]);
  const intentAt = w.now - 10 * MIN;
  w.files.set(`${dir}/dispatch-intent-7.json`, { pr: 7, head: 'h7', dispatchId: 'lost0012', attempt: 1, claimAttempt: 1, intentAt: iso(intentAt), state: 'sent' });
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 90 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.ok(w.heartbeats.length >= 2, '满 60 分钟之前照常写');
  assert.ok(w.heartbeats.every((h) => h.at <= intentAt + 63 * MIN), `满 60 分钟后不再写:${w.heartbeats.map((h) => iso(h.at))}`);
  assert.equal(w.logged('heartbeat-paused').length, 1);
  assert.deepEqual(Object.keys(w.read(w.state('heartbeat-pause.json')).dispatches), ['lost0012']);
  const before = w.heartbeats.length;
  w.now = Date.parse('2026-10-14T22:30:00Z'); // 北京 06:30:维护窗口里启动,提前返回前本该写
  const inWindow = w.start();
  assert.ok(await w.runUntil(() => inWindow.settled));
  w.now = Date.parse('2026-10-14T23:05:00Z'); // 北京 07:05:新进程恢复这一轮
  const next = w.start();
  await w.runUntil(() => false, { maxMs: 20 * MIN });
  assert.equal(w.heartbeats.length, before, '登记跨进程保留,重启后仍不写');
  w.files.set(w.state('dispatch-resolution-lost0012.json'), { resolution: 'not-submitted' });
  assert.ok(await w.runUntil(() => next.settled, { maxMs: 30 * MIN }));
  assert.equal(next.failure, null, String(next.failure?.stack));
  w.start(); // launchd 再拉起
  assert.ok(await w.runUntil(() => w.heartbeats.length > before, { maxMs: 10 * MIN }), '解除后恢复写心跳');
  assert.equal(w.logged('heartbeat-resumed').length, 1);
  assert.equal(w.files.has(w.state('heartbeat-pause.json')), false);
});

test('世界:skill 版本不一致、读不到钉住的版本、pre-check 失败时整轮报错且不写心跳;没有候选时照常写', async () => {
  const cases = [
    [(w) => { w.pinned = 'skill-other'; }, /不一致,拒绝运行/],
    [(w) => { w.pinFails = true; }, /读不到仓库变量 MIVO_REVIEW_SKILL_SHA/],
    [(w) => { w.precheckFail = 'HTTP 401: Bad credentials'; }, /pre-check 失败/],
  ];
  for (const [inject, pattern] of cases) {
    const w = makeWorld({ instance: 'mivo', mode: 'live' });
    w.openPr(1, 'h1');
    inject(w);
    const proc = w.start();
    assert.ok(await w.runUntil(() => proc.settled));
    assert.match(String(proc.failure?.message), pattern);
    assert.equal(w.heartbeats.length, 0, `${pattern} 时不写心跳`);
  }
  const idle = makeWorld({ instance: 'mivo', mode: 'live' });
  const quiet = idle.start();
  assert.ok(await idle.runUntil(() => quiet.settled));
  assert.equal(quiet.failure, null, String(quiet.failure?.stack));
  assert.equal(idle.heartbeats.length, 1, '没有候选也是正常运行,照常写');
});

test('世界:维护窗口里刚拉起的进程每 7 天 gc 一次仓库副本;失败下一次窗口再试;窗口外不做', async () => {
  const w = makeWorld({ start: '2026-10-14T22:10:00Z' }); // 北京 06:10
  const gcCalls = () => w.gitCalls.filter((args) => args.includes('gc'));
  const first = w.start();
  assert.ok(await w.runUntil(() => first.settled));
  assert.equal(first.failure, null, String(first.failure?.stack));
  assert.deepEqual(gcCalls(), [['-C', '/w/repo', 'gc', '--quiet']], '只对仓库副本做一次');
  assert.deepEqual(w.logged('repo-gc').map((e) => [e.packsBefore, e.packsAfter]), [[49, 1]]);
  w.now += 3 * MIN;
  const again = w.start();
  assert.ok(await w.runUntil(() => again.settled));
  assert.equal(gcCalls().length, 1, '7 天内不重做');
  w.now += 7 * 24 * 60 * MIN;
  w.gcFails = true;
  const failing = w.start();
  assert.ok(await w.runUntil(() => failing.settled));
  assert.equal(failing.failure, null, 'gc 失败不影响本次运行');
  assert.equal(w.logged('repo-gc-error').length, 1);
  w.now += 24 * 60 * MIN;
  w.gcFails = false;
  const retried = w.start();
  assert.ok(await w.runUntil(() => retried.settled));
  assert.equal(w.logged('repo-gc').length, 2, '失败没记时间,下一次窗口再做');
  const day = makeWorld(); // 北京 10:00
  const busy = day.start();
  assert.ok(await day.runUntil(() => busy.settled));
  assert.equal(day.gitCalls.filter((args) => args.includes('gc')).length, 0, '窗口外不做');
});

test('世界:心跳只由生产实例写,15 分钟内最多一次;暂停中启动也写;沙箱实例不写', async () => {
  const w = makeWorld({ instance: 'mivo', mode: 'live' });
  w.openPr(1, 'h1', { durationMs: 40 * MIN });
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  const times = w.heartbeats.map((h) => h.at);
  assert.ok(times.length >= 3, `写了 ${times.length} 次`);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= 15 * MIN);
  const paused = makeWorld({ instance: 'mivo', mode: 'live' });
  paused.files.set(paused.state('pause.json'), { until: iso(paused.now + 60 * MIN), reason: '额度' });
  const p = paused.start();
  assert.ok(await paused.runUntil(() => p.settled));
  assert.equal(paused.heartbeats.length, 1, '额度暂停期间启动也写心跳');
  for (const [instance, mode] of [['sandbox', 'sandbox'], ['mivo', 'dry-run'], ['mivo', 'sandbox']]) {
    const other = makeWorld({ instance, mode });
    other.openPr(1, 'h1');
    const q = other.start();
    assert.ok(await other.runUntil(() => q.settled, { maxMs: 60 * MIN }));
    assert.equal(other.heartbeats.length, 0, `${instance}/${mode} 不写心跳`);
  }
});

test('世界:真实收结果——正常收回;执行超过 170 分钟取消;结果包缺失;排队 40 + 执行 160 不误取消;排队超过 120 分钟取消', async () => {
  const cases = [
    { name: 'normal', durationMs: 10 * MIN, check: (w, result) => { assert.equal(result.outcome, 'approval'); assert.equal(w.read(w.state('reviews.json')).prs[1].cleanHead, 'h1'); } },
    { name: 'exec', durationMs: 200 * MIN, check: (w, result) => { assert.match(result.reason, /执行超过 170 分钟/); assert.equal(w.cancels.length, 1); assert.equal(w.read(w.state('reviews.json')).prs[1].failures.h1.count, 1); } },
    { name: 'missing', durationMs: 10 * MIN, noArtifact: true, check: (w, result) => { assert.match(result.reason, /没有产出结果/); assert.equal(w.read(w.state('reviews.json')).prs[1].failures.h1.count, 1); } },
    { name: 'queue40', queueMs: 40 * MIN, durationMs: 160 * MIN, check: (w, result) => { assert.equal(result.outcome, 'approval'); assert.equal(w.cancels.length, 0); assert.equal(w.logged('queue-slow').length, 1); } },
    { name: 'queue130', queueMs: 130 * MIN, durationMs: 10 * MIN, check: (w, result) => { assert.match(result.reason, /排队超过 120 分钟/); assert.equal(w.cancels.length, 1); } },
  ];
  for (const c of cases) {
    const w = makeWorld();
    w.openPr(1, 'h1', { durationMs: c.durationMs, queueMs: c.queueMs ?? 4_000 });
    if (c.noArtifact) w.noArtifact.add(1);
    const proc = w.start();
    assert.ok(await w.runUntil(() => proc.settled, { maxMs: 300 * MIN }), c.name);
    assert.equal(proc.failure, null, `${c.name}:${proc.failure?.stack}`);
    c.check(w, w.read(`${w.roundDir('R1')}/results/pr-1.json`));
    assert.ok(w.logged('collected').every((e) => e.head === 'h1'), 'collected 日志带 head');
  }
});

test('世界:同 HEAD 等待判门在长审查期间释放并重判,旧轮不能覆盖新轮结论', async () => {
  for (const outcome of ['bot-pending', 'ci-pending']) {
    const w = makeWorld();
    const start = w.now;
    w.openPr(1025, 'same', { durationMs: 5 * MIN });
    w.openPr(1071, 'long', { durationMs: 90 * MIN });
    const gate = outcome === 'bot-pending' ? { botSettle: { settled: false } } : { ci: { status: 'pending' } };
    w.contextPatch.set(1025, { auto: { action: 'skip-gate' }, gate });
    const proc = w.start();
    assert.ok(await w.runUntil(() => w.logged('pr-released').some((entry) => entry.pr === 1025), { maxMs: 5 * MIN }));
    assert.equal(w.dispatchesOf(1025).length, 0);
    w.contextPatch.delete(1025);
    assert.ok(await w.runUntil(() => w.dispatchesOf(1025).length === 1, { maxMs: 8 * MIN }));
    assert.ok(w.now - start < 15 * MIN);
    assert.equal(w.dispatchesOf(1071).length, 1);
    assert.ok(await w.runUntil(() => proc.settled, { maxMs: 150 * MIN }));
    assert.equal(proc.failure, null, String(proc.failure?.stack));
    assert.equal(w.dispatchesOf(1025).length, 1);
    assert.equal(w.read('/w/state/round-state.json').prs[1025].outcome, 'approval');
    assert.equal(w.read(`${w.roundDir('R1')}/results/pr-1025.json`).outcome, outcome);
  }
});

test('世界:完成暂缓任务后释放前中断,恢复时补释放且不重复执行旧任务', async () => {
  const w = makeWorld();
  w.openPr(1025, 'same');
  w.openPr(1071, 'long');
  const runId = w.seedRun(1071, 'long', 'R0', 'existing', { durationMs: 90 * MIN });
  const dir = w.seedRound('R0', [
    { pr: 1025, head: 'same', phase: 'complete', agentId: 'mini-gate:1025:done' },
    { pr: 1071, head: 'long', phase: 'running', agentId: `gha:${runId}:existing` },
  ]);
  w.files.set(`${dir}/results/pr-1025.json`, { runId: 'R0', pr: 1025, head: 'same', base: 'base', mode: 'review-only',
    outcome: 'bot-pending', enteredReview: false, reviewed: false, errors: [] });
  const proc = w.start();
  assert.ok(await w.runUntil(() => w.dispatchesOf(1025).length === 1, { maxMs: 8 * MIN }));
  assert.equal(w.read(`${dir}/mivo-released.json`)[1025].reason, 'gate-deferred');
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 150 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.equal(w.dispatchesOf(1025).length, 1);
  assert.equal(w.read('/w/state/round-state.json').prs[1025].outcome, 'approval');
});

test('世界:作者推新提交(A→B→C):取消旧审查,state-changed 不计失败,只有换了 head 的 PR 提前释放;同轮其它 PR 不受影响', async () => {
  const w = makeWorld();
  const t0 = w.now;
  w.openPr(1, 'A', { durationMs: 100 * MIN });
  w.openPr(2, 'Y', { durationMs: 150 * MIN });
  w.openPr(3, 'Z', { durationMs: 5 * MIN });
  w.schedule(t0 + 10 * MIN, () => w.push(1, 'B'));
  w.schedule(t0 + 25 * MIN, () => w.push(1, 'C'));
  const proc = w.start();
  assert.ok(await w.runUntil(() => w.dispatchesOf(1).some((d) => d.head === 'C'), { maxMs: 60 * MIN }));
  const at = (head) => w.dispatchesOf(1).find((d) => d.head === head).at;
  const cancelledAt = (oldHead) => w.cancels.find((c) => w.runs.get(c.runId).head === oldHead).at;
  const releasedAt = (newHead) => Date.parse(w.logged('pr-released').find((e) => e.pr === 1 && e.newHead === newHead).at);
  // 推新提交后最多一个 head 缓存周期(3 分钟)加一次轮询就发取消;旧 run 确认结束、提前释放后,下一个检查点就派新 head。
  for (const [oldHead, newHead, pushedMin] of [['A', 'B', 10], ['B', 'C', 25]]) {
    assert.ok(cancelledAt(oldHead) - (t0 + pushedMin * MIN) <= 3.5 * MIN, `${oldHead} 的取消晚了`);
    assert.ok(releasedAt(newHead) >= cancelledAt(oldHead) + w.cancelDelayMs, '旧 run 确认结束后才释放');
    assert.ok(at(newHead) - releasedAt(newHead) <= 3.5 * MIN, `${newHead} 释放后等了 ${(at(newHead) - releasedAt(newHead)) / MIN} 分钟`);
  }
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 400 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.deepEqual(w.cancels.map((c) => w.runs.get(c.runId).head), ['A', 'B'], '旧 head 的 run 被取消');
  assert.ok(at('B') < w.runs.get(w.dispatchesOf(2)[0].runId).createdMs + 150 * MIN, '新 head 的派发不等同轮的长审查结束');
  const r1 = w.read(`${w.roundDir('R1')}/results/pr-1.json`);
  assert.deepEqual([r1.outcome, r1.reason], ['state-changed', '作者推了新提交,旧审查已取消']);
  const store = w.read(w.state('reviews.json')).prs[1];
  assert.deepEqual(store.failures ?? {}, {}, '取消旧审查不计失败');
  assert.equal(store.cleanHead, 'C', '旧结果不覆盖新 head 的 cleanHead');
  assert.equal(store.lastCompleteRunId, w.dispatchesOf(1).find((d) => d.head === 'C').runId);
  assert.equal(w.read(w.state('dispatch-ledger.json')).filter((e) => e.pr === 1).length, 3, '派发账本保留');
  assert.deepEqual([2, 3].map((pr) => w.dispatchesOf(pr).length), [1, 1], '同 head 的 PR 不被重选');
  assert.deepEqual(Object.keys(w.read(`${w.roundDir('R1')}/mivo-released.json`)), ['1'], '只有换了 head 的 PR 提前释放');
  assert.equal(w.read('/w/state/round-state.json').prs[1].head, 'C', '旧轮晚收尾不把新 head 写回成旧的');
});

test('世界:取消意图写下后被杀,恢复时补发取消并收尾;旧 run 确认结束前仍占槽', async () => {
  const w = makeWorld({ maxParallel: 1 });
  w.openPr(1, 'B');
  w.openPr(2, 'h2');
  const runId = w.seedRun(1, 'A', 'R0', 'canc0008', { durationMs: 100 * MIN });
  const dir = w.seedRound('R0', [{ pr: 1, head: 'A', phase: 'running', attempts: 1, agentId: `gha:${runId}:canc0008` }, { pr: 2, head: 'h2' }]);
  w.files.set(`${dir}/cancel-intent-1.json`, { runId, oldHead: 'A', newHead: 'B', at: iso(w.now) });
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.equal(w.cancels.length, 1, '恢复时补发取消');
  const cancelledAt = w.runs.get(runId).cancelMs + w.cancelDelayMs;
  assert.ok(w.dispatchesOf(2)[0].at >= cancelledAt, '旧 run 结束前仍占槽');
  assert.equal(w.read(`${dir}/results/pr-1.json`).outcome, 'state-changed');
  assert.ok(w.read(`${dir}/mivo-released.json`)[1]);
});

test('世界:取消请求失败、旧 run 仍在排队、取消没赶上自然结束:都按正常流程收尾并提前释放', async () => {
  for (const variant of ['cancel-fails', 'queued', 'late']) {
    const w = makeWorld();
    const t0 = w.now;
    w.openPr(1, 'A', { durationMs: variant === 'late' ? 10 * MIN : 40 * MIN, queueMs: variant === 'queued' ? 20 * MIN : 4_000 });
    w.openPr(2, 'Y', { durationMs: 120 * MIN });
    if (variant === 'late') w.cancelDelayMs = 5 * MIN;
    // cancel-fails:推新提交之前就让取消请求一直失败,旧 run 只能自己跑完。
    w.schedule(t0 + (variant === 'late' ? 8 : 5) * MIN, () => {
      if (variant === 'cancel-fails') w.cancelFails.add(w.dispatchesOf(1)[0].runId);
      w.push(1, 'B');
    });
    const proc = w.start();
    assert.ok(await w.runUntil(() => proc.settled, { maxMs: 300 * MIN }), variant);
    assert.equal(proc.failure, null, `${variant}:${proc.failure?.stack}`);
    if (variant === 'cancel-fails') {
      const old = w.runs.get(w.dispatchesOf(1)[0].runId);
      assert.equal(old.cancelMs, undefined, '取消一直没成功');
      assert.ok(w.cancels.filter((c) => c.runId === old.id).length >= 2, '取消失败后隔几分钟再发');
      assert.ok(w.dispatchesOf(1)[1].at >= old.createdMs + old.queueMs + old.durationMs, '旧 run 自己跑完前,新 head 不派');
    }
    const r1 = w.read(`${w.roundDir('R1')}/results/pr-1.json`);
    assert.equal(r1.outcome, 'state-changed', variant);
    assert.deepEqual(w.dispatchesOf(1).map((d) => d.head), ['A', 'B'], variant);
    assert.equal(w.read(w.state('reviews.json')).prs[1].failures?.A, undefined, `${variant}:旧 head 不计失败`);
    assert.equal(w.read(w.state('reviews.json')).prs[1].cleanHead, 'B', variant);
  }
});

// 超时取消必须等旧 run 确认结束:取消失败或迟迟不生效时,提前放槽会让在审数超过上限、同 head 在退避后被派第二次、
// 部署停点在旧 run 还在跑时就声称已排空。
test('世界:超时取消失败或迟迟不生效:旧 run 确认结束前仍占槽,不重派同 head;部署停点等它结束才握手', async () => {
  const endOf = (r) => r.createdMs + r.queueMs + r.durationMs;
  // 排队超过 120 分钟,取消一直失败:run 在 130 分钟开跑、140 分钟跑完。
  const queued = makeWorld({ maxParallel: 1 });
  queued.openPr(1, 'h1', { queueMs: 130 * MIN, durationMs: 10 * MIN });
  queued.openPr(2, 'h2');
  const q = queued.start();
  assert.ok(await queued.runUntil(() => queued.dispatchesOf(1).length === 1));
  const stuck = queued.runs.get(queued.dispatchesOf(1)[0].runId);
  queued.cancelFails.add(stuck.id);
  assert.ok(await queued.runUntil(() => q.settled, { maxMs: 300 * MIN }));
  assert.equal(q.failure, null, String(q.failure?.stack));
  assert.ok(queued.cancels.filter((c) => c.runId === stuck.id).length >= 2, '取消失败后隔几分钟再发');
  assert.ok(queued.dispatchesOf(2)[0].at >= endOf(stuck), `#2 在 ${(queued.dispatchesOf(2)[0].at - endOf(stuck)) / MIN} 分钟派出,旧 run 还没结束`);
  assert.equal(queued.read(`${queued.roundDir('R1')}/results/pr-1.json`).outcome, 'approval', '取消没成功、run 自己跑完:按正常结果收');

  // 执行超过 170 分钟,取消被接受但 5 分钟后才生效。
  const slow = makeWorld({ maxParallel: 1 });
  slow.cancelDelayMs = 5 * MIN;
  slow.openPr(1, 'h1', { durationMs: 200 * MIN });
  slow.openPr(2, 'h2');
  const s1 = slow.start();
  assert.ok(await slow.runUntil(() => s1.settled, { maxMs: 400 * MIN }));
  assert.equal(s1.failure, null, String(s1.failure?.stack));
  const cancelled = slow.runs.get(slow.dispatchesOf(1)[0].runId);
  assert.ok(slow.dispatchesOf(2)[0].at >= cancelled.cancelMs + slow.cancelDelayMs, '取消生效、旧 run 结束后才放槽');
  const r1 = slow.read(`${slow.roundDir('R1')}/results/pr-1.json`);
  assert.match(r1.reason, /执行超过 170 分钟/);
  assert.equal(slow.read(slow.state('reviews.json')).prs[1].failures.h1.count, 1);

  // 执行超过 170 分钟,取消一直失败:同一个 head 只派一次,等 run 自己结束。
  const dup = makeWorld();
  dup.openPr(1, 'h1', { durationMs: 200 * MIN });
  const d = dup.start();
  assert.ok(await dup.runUntil(() => dup.dispatchesOf(1).length === 1));
  dup.cancelFails.add(dup.dispatchesOf(1)[0].runId);
  assert.ok(await dup.runUntil(() => d.settled, { maxMs: 400 * MIN }));
  assert.equal(d.failure, null, String(d.failure?.stack));
  assert.equal(dup.dispatchesOf(1).length, 1, '同 PR 同 head 不出现第二个在审 run');

  // 部署暂停时旧 run 还在排队、取消一直失败:旧 run 结束前不握手、不放锁。
  const hold = makeWorld();
  hold.openPr(1, 'h1', { queueMs: 130 * MIN, durationMs: 10 * MIN });
  const h = hold.start();
  assert.ok(await hold.runUntil(() => hold.dispatchesOf(1).length === 1));
  const held = hold.runs.get(hold.dispatchesOf(1)[0].runId);
  hold.cancelFails.add(held.id);
  hold.schedule(held.createdMs + 119 * MIN, () => hold.files.set(hold.state('deploy-hold.json'), { at: iso(hold.now) }));
  assert.ok(await hold.runUntil(() => hold.now >= endOf(held) - MIN, { maxMs: 300 * MIN }));
  assert.equal(hold.files.has(hold.state('quiesced.json')), false, '旧 run 还在,不算停点');
  assert.ok(hold.lock, '锁还在本进程手里');
  assert.ok(await hold.runUntil(() => h.settled, { maxMs: 60 * MIN }));
  assert.equal(h.failure, null, String(h.failure?.stack));
  assert.equal(hold.read(hold.state('quiesced.json')).lockReleased, true);
});

test('世界:超时取消意图写下后被杀:恢复时补发取消,旧 run 结束后按超时记一次失败', async () => {
  const w = makeWorld();
  w.openPr(1, 'h1');
  const runId = w.seedRun(1, 'h1', 'R0', 'slow0010', { createdMs: w.now - 175 * MIN, durationMs: 200 * MIN });
  const dir = w.seedRound('R0', [{ pr: 1, head: 'h1', phase: 'running', attempts: 1, agentId: `gha:${runId}:slow0010` }]);
  w.files.set(`${dir}/cancel-intent-1.json`, { runId, reason: 'timeout', kind: 'exec', at: iso(w.now - 5 * MIN) });
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.equal(w.cancels.length, 1, '恢复时补发取消');
  assert.match(w.read(`${dir}/results/pr-1.json`).reason, /执行超过 170 分钟/);
  assert.equal(w.read(w.state('reviews.json')).prs[1].failures.h1.count, 1);
  assert.equal(w.files.has(`${dir}/mivo-released.json`), false, '超时取消不提前释放');
});

// 正常收尾时 review-queue complete 先把任务记成 cleanup-pending 再删审查 worktree;删到一半进程没了,
// 恢复时要沿同一个 agent 再 complete,不能按派发意图重新 bind(bind 只接受 ready/running)。
test('世界:收尾清理中途中断(cleanup-pending):重启后续做清理收尾,不重新绑定、不重派', async () => {
  const w = makeWorld();
  w.openPr(7, 'h7');
  const runId = w.seedRun(7, 'h7', 'R0', 'done0009', { createdMs: w.now - 30 * MIN });
  const dir = w.seedRound('R0', [{ pr: 7, head: 'h7', phase: 'cleanup-pending', attempts: 1, agentId: `gha:${runId}:done0009` }]);
  w.files.set(`${dir}/dispatch-intent-7.json`, { pr: 7, head: 'h7', dispatchId: 'done0009', attempt: 1, claimAttempt: 1, intentAt: iso(w.now - 30 * MIN), state: 'bound', runId });
  w.files.set(`${dir}/results/pr-7.json`, { runId: 'R0', mode: 'review-only', pr: 7, head: 'h7', outcome: 'approval', reason: '审查通过', retry: false });
  for (let i = 0; i < 2; i += 1) {
    const proc = w.start();
    assert.ok(await w.runUntil(() => proc.settled, { maxMs: 30 * MIN }));
    assert.equal(proc.failure, null, String(proc.failure?.stack));
  }
  assert.equal(w.read(`${dir}/queue.json`).tasks[0].phase, 'complete');
  assert.ok(w.files.has(`${dir}/completed.json`), '这一轮收尾了');
  assert.equal(w.dispatches.length, 0, '不重派');
  assert.equal(w.read(`${dir}/results/pr-7.json`).outcome, 'approval', '已有结果不被改写');
});

test('round-state 归属(review-round.mjs 的 round-owner 补丁):旧轮晚收尾不把新轮写过的行写回成旧 head', async () => {
  const { nextRoundState } = await load('review-pr/scripts/review-round.mjs');
  const planOf = (runId, createdAt, head) => ({ runId, mode: 'review-only',
    manifest: { createdAt, candidates: [{ number: 1 }], snapshot: [{ number: 1, head, createdAt: '2026-10-14T00:00:00Z' }] } });
  const payloadOf = (outcome, retry) => ({ processed: [{ pr: 1, outcome, reason: outcome, retry, dependencyPrs: [] }] });
  const oldRound = planOf('R1', '2026-10-14T18:00:00.000+08:00', 'A');
  const newRound = planOf('R2', '2026-10-14T18:30:00.000+08:00', 'B');
  // 新 head 先完成,旧轮(手里还有别的长审查)后收尾:保持新 head 的状态。
  const afterNew = nextRoundState(newRound, payloadOf('approval', false), {});
  const afterOld = nextRoundState(oldRound, payloadOf('state-changed', true), afterNew);
  assert.equal(afterOld.prs[1].fingerprintFields.head, 'B');
  assert.equal(afterOld.prs[1].retry, false);
  assert.equal(afterOld.prs[1].roundRunId, 'R2');
  // 旧轮先收尾、新轮后收尾:新轮照常覆盖。
  const oldFirst = nextRoundState(newRound, payloadOf('approval', false), nextRoundState(oldRound, payloadOf('state-changed', true), {}));
  assert.equal(oldFirst.prs[1].fingerprintFields.head, 'B');
  // 没有轮次时间的旧行(补丁之前写的)照常覆盖。
  const legacy = { version: 1, mode: 'review-only', prs: { 1: { fingerprint: 'x', outcome: 'approval', retry: false } } };
  assert.equal(nextRoundState(oldRound, payloadOf('state-changed', true), legacy).prs[1].roundRunId, 'R1');
});

// ── 绕过必需检查合入、又没写原因的 PR:Mini 提醒一次(mivo/prereview/bypass-reason.mjs) ───────────

test('世界:live 模式每轮在 wake-held 之后、pre-check 之前调一次提醒脚本,参数是仓库和状态目录', async () => {
  const w = makeWorld({ instance: 'mivo', mode: 'live' });
  w.openPr(1, 'h1');
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.deepEqual(w.bypassCalls[0], ['--sweep', '--repo', 'o/target', '--state-dir', '/w/state']);
  assert.equal(w.scriptOrder.indexOf('bypass-reason') < w.scriptOrder.indexOf('pre-check'), true, '提醒在 pre-check 之前');
  assert.equal(w.dispatchesOf(1).length, 1, '照常接单、派发');
});

test('世界:非 live 模式(sandbox / dry-run)不调提醒脚本', async () => {
  for (const mode of ['sandbox', 'dry-run']) {
    const w = makeWorld({ instance: 'sandbox', mode });
    w.openPr(1, 'h1');
    const proc = w.start();
    assert.ok(await w.runUntil(() => proc.settled), mode);
    assert.deepEqual(w.bypassCalls, [], mode);
  }
});

test('世界:提醒脚本失败、超时、抛异常或返回 ok:false 时,本轮照常接单、派发、收结果', async () => {
  const cases = [
    ['ok:false', (w) => { w.bypassResult = { ok: false, error: 'bypass-reason.mjs 没有返回 JSON(exit null):timeout', exitCode: null }; }],
    ['非零退出码', (w) => { w.bypassResult = { ok: false, error: '读规则集记录失败:HTTP 403', exitCode: 1, reminded: [] }; }],
    ['抛异常', (w) => { w.bypassThrows = true; }],
  ];
  for (const [name, inject] of cases) {
    const w = makeWorld({ instance: 'mivo', mode: 'live' });
    w.openPr(1, 'h1');
    inject(w);
    const proc = w.start();
    assert.ok(await w.runUntil(() => proc.settled), name);
    assert.equal(proc.failure, null, `${name}:${proc.failure?.stack}`);
    assert.equal(w.dispatchesOf(1).length, 1, `${name}:照常派发`);
    assert.equal(w.read(`${w.roundDir('R1')}/results/pr-1.json`).outcome, 'approval', `${name}:照常收结果`);
    const logged = w.logged('bypass-reminder');
    assert.equal(logged.length >= 1 && logged.every((e) => e.ok === false), true, `${name}:只记日志`);
  }
});

test('世界:提醒脚本被节流(skipped: throttled)时不刷日志;真正扫描了才记 bypass-reminder', async () => {
  const w = makeWorld({ instance: 'mivo', mode: 'live' });
  w.bypassResult = { ok: true, skipped: 'throttled', reminded: [], exitCode: 0 };
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled));
  assert.equal(w.logged('bypass-reminder').length, 0);
  const scanned = makeWorld({ instance: 'mivo', mode: 'live' });
  scanned.bypassResult = { ok: true, reminded: [941], skipped: [], exitCode: 0 };
  const proc2 = scanned.start();
  assert.ok(await scanned.runUntil(() => proc2.settled));
  assert.deepEqual(scanned.logged('bypass-reminder')[0].reminded, [941]);
});

// ── GitHub 限额用完不算一次审查失败 ─────────────────────────────────────────────

test('世界:服务器结果报 GitHub 限额用完:这个提交的尝试次数和失败次数都不变;其它报错照旧计数', async () => {
  const limited = makeWorld();
  limited.openPr(1, 'h1');
  limited.rateLimited.add(1);
  const limitedProc = limited.start();
  assert.ok(await limited.runUntil(() => limited.logged('collected').length >= 1));
  const store = limited.read(limited.state('reviews.json')).prs[1];
  assert.deepEqual(store.failures ?? {}, {}, '不计失败次数');
  assert.equal(store.attempts?.h1 ?? 0, 0, '退回这次尝试,和派发前一样');
  assert.equal(limited.logged('github-rate-limited').length, 1);
  assert.match(limited.read(`${limited.roundDir('R1')}/results/pr-1.json`).reason, /API rate limit already exceeded/, '结果文件照实记录这次没审成');
  limitedProc.stop();
  // 对照:同样的 world、同样是 error 结果但不是限额(结果包缺失)→ 失败 1 次、尝试 1 次
  const other = makeWorld();
  other.openPr(1, 'h1');
  other.noArtifact.add(1);
  other.start();
  assert.ok(await other.runUntil(() => other.logged('collected').length >= 1));
  const counted = other.read(other.state('reviews.json')).prs[1];
  assert.equal(counted.failures.h1.count, 1);
  assert.equal(counted.attempts.h1, 1);
  assert.equal(other.logged('github-rate-limited').length, 0);
});

test('世界:同一个提交连续撞限额,退回尝试最多 3 次;第 4 次起照旧记失败走退避(限额分支自带封顶)', async () => {
  const w = makeWorld();
  w.openPr(1, 'h1');
  w.rateLimited.add(1);
  // launchd 每 3 分钟拉起一个新进程:一个进程收完这个提交的结果就退出,下一个进程再派发。
  for (let i = 0; i < 6 && w.logged('collected').length < 4; i += 1) {
    const proc = w.start();
    assert.ok(await w.runUntil(() => proc.settled, { maxMs: 300 * MIN }), `第 ${i + 1} 个进程结束`);
    assert.equal(proc.failure, null, String(proc.failure?.stack));
    w.now += 3 * MIN;
  }
  const store = w.read(w.state('reviews.json')).prs[1];
  assert.equal(w.logged('collected').length, 4, '同一个提交派发了 4 次');
  assert.equal(w.logged('github-rate-limited').length, 3, '只退回 3 次');
  assert.equal(store.rateLimitRefunds.h1, 3);
  assert.equal(store.failures.h1.count, 1, '第 4 次起记失败,进入退避');
  assert.equal(store.attempts.h1, 1, '第 4 次的尝试次数不再退回');
});

test('世界:正常审过的结果不会被误当成限额', async () => {
  const w = makeWorld();
  w.openPr(1, 'h1');
  w.start();
  assert.ok(await w.runUntil(() => w.logged('collected').length >= 1));
  assert.equal(w.logged('github-rate-limited').length, 0);
  assert.equal(w.read(w.state('reviews.json')).prs[1].cleanHead, 'h1');
});

test('世界:模型已经调用过(attempts 非空)之后才报的限额,照旧记一次失败——退回尝试只限没花过模型调用的情况', async () => {
  const w = makeWorld();
  w.openPr(1, 'h1');
  w.rateLimited.add(1);
  w.rateLimitedAfterModel = true;
  w.start();
  assert.ok(await w.runUntil(() => w.logged('collected').length >= 1));
  const store = w.read(w.state('reviews.json')).prs[1];
  assert.equal(store.failures.h1.count, 1);
  assert.equal(store.attempts.h1, 1);
  assert.equal(w.logged('github-rate-limited').length, 0);
});

// ── 通知(notice issue)没发出去的重试状态要熬过 Mini 重启 ────────────────────────────────────────
// 维护者作者改了受保护路径:判门自动放行并建 notice issue,同轮派 protected-approve。notice 创建遇到临时错误时
// executeGateAction 记下 errors 和 retry,但派发后进程在收回服务器结果前被杀;恢复分支原先用空的 gateResult,
// retry 和错误记录一起丢,round-state 写 retry=false,下一轮判 unchanged,GitHub / Slack 通知永久缺失。

// 跑到派发绑定 run(意图 bound、任务 running)就杀进程,返回第一轮目录。resumeAs: 'running' 照原样重启(绑定后被杀);
// 'sent' 把磁盘回退成「gh 返回成功、run 还没绑定」(派发意图 sent、任务 ready 没 agent)再重启——两个恢复分支各走一遍。
async function killAfterProtectedDispatch(w, { resumeAs }) {
  const first = w.start();
  const dir = w.roundDir('R1');
  assert.ok(await w.runUntil(() => w.read(`${dir}/dispatch-intent-7.json`)?.state === 'bound'), '派发已绑定 run');
  first.stop();
  w.lock = null;
  if (resumeAs === 'sent') {
    const { runId, boundAt, ...sent } = w.read(`${dir}/dispatch-intent-7.json`);
    w.files.set(`${dir}/dispatch-intent-7.json`, { ...sent, state: 'sent' });
    const queue = w.read(`${dir}/queue.json`);
    Object.assign(queue.tasks[0], { phase: 'ready', agentId: null });
    w.files.set(`${dir}/queue.json`, queue);
  }
  return dir;
}

for (const resumeAs of ['running', 'sent']) {
  test(`世界:notice 创建失败后已派发,Mini 重启(${resumeAs} 分支)收回结果:retry 和错误记录保留,下一轮仍补发通知`, async () => {
    const w = makeWorld();
    w.openPr(7, 'h7');
    w.protectedAuthors.add(7);
    w.noticeFailures = 1;
    const dir = await killAfterProtectedDispatch(w, { resumeAs });
    assert.equal(w.noticeCalls.length, 1, '第一轮判门试过一次 notice,失败');
    const second = w.start();
    assert.ok(await w.runUntil(() => second.settled, { maxMs: 6 * 60 * MIN }));
    assert.equal(second.failure, null, String(second.failure?.stack));
    const first = w.read(`${dir}/results/pr-7.json`);
    assert.equal(first.outcome, 'protected');
    assert.equal(first.retry, true, '通知没发出去,这一轮结果必须标 retry');
    assert.match(first.errors.join('\n'), /temporary 503/, '错误记录不丢');
    assert.equal(w.noticeCalls.length, 1, '一个进程只跑一轮');
    const third = w.start();
    assert.ok(await w.runUntil(() => third.settled, { maxMs: 6 * 60 * MIN }));
    assert.equal(third.failure, null, String(third.failure?.stack));
    assert.equal(w.noticeCalls.length, 2, '下一轮重判,notice 补发');
    assert.equal(w.read('/w/state/round-state.json').prs[7].retry, false, '补发成功后不再重试');
    assert.equal(w.dispatches.length, 2, '两轮各派一次 protected-approve');
  });

  test(`世界:notice 创建成功(正常路径),Mini 重启(${resumeAs} 分支)后不多补发通知、不多开一轮`, async () => {
    const w = makeWorld();
    w.openPr(7, 'h7');
    w.protectedAuthors.add(7);
    const dir = await killAfterProtectedDispatch(w, { resumeAs });
    const second = w.start();
    assert.ok(await w.runUntil(() => second.settled, { maxMs: 6 * 60 * MIN }));
    assert.equal(second.failure, null, String(second.failure?.stack));
    const result = w.read(`${dir}/results/pr-7.json`);
    assert.equal(result.outcome, 'protected');
    assert.notEqual(result.retry, true);
    assert.deepEqual(result.errors, []);
    assert.equal(w.read('/w/state/round-state.json').prs[7].retry, false);
    const third = w.start();
    assert.ok(await w.runUntil(() => third.settled, { maxMs: 6 * 60 * MIN }));
    assert.equal(third.failure, null, String(third.failure?.stack));
    assert.equal(w.noticeCalls.length, 1, '没有下一轮');
    assert.equal(w.dispatches.length, 1);
  });
}

test('世界:notice 创建失败后已派发,进程没有重启:retry 和错误记录保留,下一轮补发(对照:夹具本身没问题)', async () => {
  const w = makeWorld();
  w.openPr(7, 'h7');
  w.protectedAuthors.add(7);
  w.noticeFailures = 1;
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 6 * 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  const first = w.read(`${w.roundDir('R1')}/results/pr-7.json`);
  assert.equal(first.retry, true);
  assert.match(first.errors.join('\n'), /temporary 503/);
  assert.equal(w.noticeCalls.length, 1);
  const next = w.start();
  assert.ok(await w.runUntil(() => next.settled, { maxMs: 6 * 60 * MIN }));
  assert.equal(next.failure, null, String(next.failure?.stack));
  assert.equal(w.noticeCalls.length, 2);
  assert.equal(w.read('/w/state/round-state.json').prs[7].retry, false);
});

// 2026-10-17 P2-3:标签只在 head 变化时摘,#978 冲突了一天标签还在。门禁失效(冲突/人工讨论未 resolve 等稳定卡点)也要摘;
// CI 在跑这类瞬态不摘(否则 CI 重跑一次标签就被摘、审完又加回来);正常送审不动。
test('世界:review:merge-ready 在冲突、人工讨论未 resolve 时摘,head 变了照摘;CI 在跑和正常送审不摘,且各摘一次', async () => {
  const w = makeWorld();
  const label = (pr) => `repos/o/target/issues/${pr}/labels/review%3Amerge-ready`;
  for (const pr of [1, 2, 3, 4, 5]) { w.openPr(pr, `h${pr}`); w.labeled.add(pr); }
  // 审查通过过的 head:除 #4 外都等于当前 head(#4 之后又推了新提交)
  w.files.set(w.state('reviews.json'), { version: 1, prs: { 1: { cleanHead: 'h1' }, 2: { cleanHead: 'h2' }, 3: { cleanHead: 'h3' }, 4: { cleanHead: 'old' }, 5: { cleanHead: 'h5' } } });
  w.contextPatch.set(1, { meta: { mergeStateStatus: 'DIRTY' }, auto: { action: 'skip-gate' }, gate: { blockClass: 'conflict' } });
  w.contextPatch.set(2, { auto: { action: 'skip-gate' }, gate: { blockClass: 'ci-pending', ci: { status: 'pending' } } });
  w.contextPatch.set(5, { gate: { unresolvedThreads: [{ isBot: false }] } });
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 6 * 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.deepEqual([...w.labelDeletes].sort(), [label(1), label(4), label(5)].sort(), '冲突、旧 head、人工讨论各摘一次;CI 在跑(#2)和正常送审(#3)不摘');
  assert.deepEqual([...w.labeled].sort(), [2, 3]);
  assert.deepEqual([1, 2, 3, 4, 5].map((pr) => w.dispatchesOf(pr).length), [0, 0, 1, 1, 0], '判门没过的不派发服务器审查');
});

// 2026-10-17 补审:attempts 原先累计同 head 的所有派发(含成功的复用),满 9 次就停;摘标签后门禁恢复要靠再派发把标签加回,
// 同 head 已派 9 次时就加不回来。现在 attempt = 连续失败数 + 1,旧记录里已经累计到 9 的 head 自动解开;
// 防失控的保险改成「同 head 已完成审查次数」上限(20)。
test('世界:旧记录 attempts 已累计到 9 的 head,摘标签后门禁恢复仍能再派发(attempt 从 1 起),并累计已完成次数', async () => {
  const w = makeWorld();
  w.openPr(1, 'h1');
  w.labeled.add(1);
  w.files.set(w.state('reviews.json'), { version: 1, prs: { 1: { cleanHead: 'h1', attempts: { h1: 9 } } } });
  w.contextPatch.set(1, { gate: { unresolvedThreads: [{ isBot: false }] } });
  const first = w.start();
  assert.ok(await w.runUntil(() => first.settled, { maxMs: 6 * 60 * MIN }));
  assert.equal(first.failure, null, String(first.failure?.stack));
  assert.equal(w.labelDeletes.length, 1, '人工讨论未 resolve:标签被摘');
  assert.equal(w.dispatchesOf(1).length, 0, '判门没过不派发');
  // 讨论 resolve:门禁恢复,指纹变化让它重新成为候选
  w.contextPatch.delete(1);
  w.files.get('/w/state/round-state.json').prs[1].retry = true;
  const next = w.start();
  assert.ok(await w.runUntil(() => next.settled, { maxMs: 6 * 60 * MIN }));
  assert.equal(next.failure, null, String(next.failure?.stack));
  assert.equal(w.dispatchesOf(1).length, 1, '门禁恢复后再派发一次(旧版这里 attempt=10 被拒)');
  assert.equal(w.dispatchesOf(1)[0].attempt, '1', 'attempt 是连续重试第几次,不是累计派发数');
  assert.equal(w.read(w.state('reviews.json')).prs[1].completedRuns.h1, 1);
});

test('世界:同 head 已完成审查满 20 次就停,记原因、不派发;推新提交重新计数', async () => {
  const w = makeWorld();
  w.openPr(1, 'h1');
  w.files.set(w.state('reviews.json'), { version: 1, prs: { 1: { completedRuns: { h1: 20 } } } });
  const proc = w.start();
  assert.ok(await w.runUntil(() => proc.settled, { maxMs: 6 * 60 * MIN }));
  assert.equal(proc.failure, null, String(proc.failure?.stack));
  assert.equal(w.dispatchesOf(1).length, 0);
  const held = w.read(`${w.roundDir('R1')}/results/pr-1.json`);
  assert.match(held.reason, /已完成 20 次服务器审查.*停止自动重试/);
  assert.equal(held.retry, true);
  // 作者推了新提交:新 head 没有记录,正常派发
  w.push(1, 'h2');
  const next = w.start();
  assert.ok(await w.runUntil(() => next.settled, { maxMs: 6 * 60 * MIN }));
  assert.equal(next.failure, null, String(next.failure?.stack));
  assert.equal(w.dispatchesOf(1).filter((d) => d.head === 'h2').length, 1);
});
