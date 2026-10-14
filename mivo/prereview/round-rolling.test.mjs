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
      case 'admit-candidates.mjs': return args.includes('--incomplete-only')
        ? { ok: true, incompletePlans: planFiles, exitCode: 0 } : { ok: true, exitCode: 2, excludedPrs: [] };
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
