// 代码扫描状态变了(CodeQL success ⇄ neutral)时唤醒对应 PR 的接线(round.mjs 的 wakeCodeScanPrs)。
// 审查 P2-2:PR 指纹里的 ci 是聚合状态,CodeQL 变化不改它;别的门一直 BLOCKED 时 mergeStateStatus 也不动。
// 没有独立依据,已挂的标签不会被摘,修好 CodeQL 的 PR(作者自批后 review-pr 留在进行中)也停在原地。
// 做法同 stale-merge-ready.test.mjs:从 round.mjs 抽出具名函数放进 vm,gh / 文件 / 日志用替身,判据函数用真的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { fetchCodeScanFacts, toCodeScanGate, toCodeScanWakeState, toCodeScanWake, toCodeScanSweepSet } from '../lib/code-scan.mjs';
import { toHeldWake } from '../lib/admission.mjs';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
function extractFunction(name) {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(source);
  assert.ok(declaration, `round.mjs 里找不到函数 ${name}`);
  const closing = /^\}/m.exec(source.slice(declaration.index));
  assert.ok(closing, `${name} 没有顶格的结束括号`);
  return source.slice(declaration.index, declaration.index + closing.index + 1);
}
// 常量放在 main 之前(世界夹具的 prefix 会带上),这里从源码取值,不在测试里另写一份
const constant = (name) => Number(eval(new RegExp(`^const ${name} = (.*);$`, 'm').exec(source)?.[1]));
const SWEEP_MS = constant('CODE_SCAN_SWEEP_EVERY_MS');
const MAX_WATCHED = constant('CODE_SCAN_MAX_WATCHED');

const SCAN_RULE = { type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] } };
const NOW = Date.parse('2026-10-17T20:00:00Z');
const codeql = (conclusion, status = 'completed') => [{ name: 'CodeQL', app: { slug: 'github-advanced-security' }, status, conclusion,
  output: { title: conclusion === 'neutral' ? '1 configuration not found' : '' }, completed_at: status === 'completed' ? new Date(NOW - 600_000).toISOString() : null }];

function makeWorld({ records = {}, checks = {}, issues = [], rs = null, rulesStatus = 'ok', rules = [SCAN_RULE], watch = undefined, now = NOW, storeThrows = false } = {}) {
  const files = new Map();
  if (rs) files.set('/state/key/round-state.json', rs);
  if (watch) files.set('/state/mivo/code-scan-watch.json', watch);
  const gh = [];
  const logs = [];
  const ok = (value) => ({ ok: true, stdout: JSON.stringify(value), stderr: '' });
  const sandbox = {
    fetchCodeScanFacts, toCodeScanGate, toCodeScanWakeState, toCodeScanWake, toCodeScanSweepSet, toHeldWake, encodeURIComponent, join, Date: class extends Date { static now() { return now; } },
    CODE_SCAN_SWEEP_EVERY_MS: SWEEP_MS, CODE_SCAN_MAX_WATCHED: MAX_WATCHED,
    CONFIG: { targetRepo: 'o/r', stateDir: '/state', repoRoot: '/repo' }, ENV: {},
    loadStore: () => { if (storeThrows) throw new Error('reviews.json 损坏'); return { prs: records }; },
    stateFile: (name) => `/state/mivo/${name}`,
    roundStateKey: () => 'key',
    nowIso: () => new Date(now).toISOString(),
    readJson: (file, fallback) => (files.has(file) ? structuredClone(files.get(file)) : fallback),
    writeJson: (file, value) => files.set(file, structuredClone(value)),
    log: (event, detail) => logs.push({ event, ...detail }),
    ghRead: (args) => {
      const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
      gh.push(path);
      // wakeHeldPrs 读的开放 issue 列表(--paginate --slurp:每页一个数组)
      if (args.includes('--slurp') && path === 'repos/o/r/issues') return ok([[...issuesList, { number: 999 }]]);
      if (path.includes('/rules/branches/')) return rulesStatus === 'ok' ? ok(rules) : { ok: false, stdout: '', stderr: 'HTTP 502' };
      const sha = path.match(/commits\/([^/]+)\/check-runs/)?.[1];
      if (sha) return ok({ total_count: (checks[sha] ?? []).length, check_runs: checks[sha] ?? [] });
      throw new Error(`意外的读取:${args.join(' ')}`);
    },
  };
  const issuesList = issues.map((number) => ({ number, pull_request: {} }));
  vm.runInNewContext(`${extractFunction('codeScanCache')}\n${extractFunction('wakeCodeScanPrs')}\n${extractFunction('wakeHeldPrs')}\nglobalThis.api = { wakeCodeScanPrs, wakeHeldPrs };`, sandbox);
  return { sweep: (busy = new Set()) => sandbox.api.wakeCodeScanPrs([...issuesList, { number: 999 }], busy), wakeHeld: (busy = new Set()) => sandbox.api.wakeHeldPrs(busy), gh, logs, files };
}
const record = (state, head = 'h1') => ({ codeScan: { head, base: 'main', required: true, state, at: '2026-10-17T19:00:00Z' } });
const retryOf = (world, pr) => world.files.get('/state/key/round-state.json').prs[pr].retry;
const roundState = (...prs) => ({ version: 1, prs: Object.fromEntries(prs.map((pr) => [pr, { retry: false }])) });

test('服务器记 pass 的 PR(标签已挂),CodeQL 稳定变成 neutral:标 retry 唤醒,让 Mini 重新判门摘标签', () => {
  const world = makeWorld({ records: { 1: record('pass') }, issues: [1], rs: roundState(1), checks: { h1: codeql('neutral') } });
  world.sweep();
  assert.equal(retryOf(world, 1), true);
  assert.equal(world.logs.find((entry) => entry.event === 'wake-code-scan').prs[0], 1);
  assert.deepEqual(world.files.get('/state/mivo/code-scan-watch.json').seen, { 1: { head: 'h1', state: 'fail', at: '2026-10-17T19:00:00Z' } });
});

test('服务器记 fail 的 PR(作者自批 advisory / 标签被拦),CodeQL 重跑成 success:唤醒,重新放行', () => {
  const world = makeWorld({ records: { 2: record('fail', 'h2') }, issues: [2], rs: roundState(2), checks: { h2: codeql('success') } });
  world.sweep();
  assert.equal(retryOf(world, 2), true);
});

test('没变 / 瞬态(CodeQL 重跑中)/ 读不到:不唤醒;重复扫描同一个状态不重复唤醒', () => {
  const same = makeWorld({ records: { 1: record('pass') }, issues: [1], rs: roundState(1), checks: { h1: codeql('success') } });
  same.sweep();
  assert.equal(retryOf(same, 1), false);
  const rerun = makeWorld({ records: { 1: record('pass') }, issues: [1], rs: roundState(1), checks: { h1: codeql(null, 'in_progress') } });
  rerun.sweep();
  assert.equal(retryOf(rerun, 1), false, '重跑中不算变化,避免来回加摘');
  const unreadable = makeWorld({ records: { 1: record('pass') }, issues: [1], rs: roundState(1), checks: { h1: codeql('neutral') }, rulesStatus: 'fail' });
  unreadable.sweep();
  assert.equal(retryOf(unreadable, 1), false);
  // 唤醒一次后(基线已推到 fail),过了间隔再扫同一个状态不再唤醒
  const once = makeWorld({ records: { 1: record('pass') }, issues: [1], rs: roundState(1), checks: { h1: codeql('neutral') } });
  once.sweep();
  once.files.get('/state/key/round-state.json').prs[1].retry = false;
  once.files.set('/state/mivo/code-scan-watch.json', { ...once.files.get('/state/mivo/code-scan-watch.json'), lastSweepAt: new Date(NOW - SWEEP_MS - 1).toISOString() });
  once.sweep();
  assert.equal(retryOf(once, 1), false);
});

test('扫描间隔:10 分钟内不重复扫;只看开放 PR;没有服务器记过三态的 PR 时一次请求都不发,也不写文件', () => {
  const recent = makeWorld({ records: { 1: record('pass') }, issues: [1], rs: roundState(1), checks: { h1: codeql('neutral') },
    watch: { lastSweepAt: new Date(NOW - 60_000).toISOString(), seen: {} } });
  recent.sweep();
  assert.equal(recent.gh.length, 0);
  assert.equal(retryOf(recent, 1), false);
  const closed = makeWorld({ records: { 1: record('pass') }, issues: [], rs: roundState(1), checks: { h1: codeql('neutral') } });
  closed.sweep();
  assert.equal(closed.gh.length, 0, '不在开放列表里的 PR 不读');
  const none = makeWorld({ records: { 1: { cleanHead: 'h1' } }, issues: [1], rs: roundState(1) });
  none.sweep();
  assert.equal(none.gh.length, 0);
  assert.equal(none.files.has('/state/mivo/code-scan-watch.json'), false);
});

test('在审的 PR 先推迟(不标 retry、基线不动);规则按 base 缓存,同 base 的多个 PR 只读一次规则', () => {
  const busy = makeWorld({ records: { 1: record('pass') }, issues: [1], rs: roundState(1), checks: { h1: codeql('neutral') } });
  busy.sweep(new Set([1]));
  assert.equal(retryOf(busy, 1), false);
  assert.ok(busy.logs.some((entry) => entry.event === 'wake-code-scan-deferred'));
  const two = makeWorld({ records: { 1: record('pass', 'h1'), 2: record('pass', 'h2') }, issues: [1, 2], rs: roundState(1, 2), checks: { h1: codeql('neutral'), h2: codeql('success') } });
  two.sweep();
  assert.equal(two.gh.filter((path) => path.includes('/rules/branches/')).length, 1);
  assert.equal(two.gh.filter((path) => path.includes('/check-runs')).length, 2);
  assert.equal(retryOf(two, 1), true);
  assert.equal(retryOf(two, 2), false);
});

test('任何意外只记日志、不抛:round-state 里没有这个 PR 时不报错;状态文件读不了也不影响接单', () => {
  const world = makeWorld({ records: { 1: record('pass') }, issues: [1], rs: roundState(7), checks: { h1: codeql('neutral') } });
  assert.doesNotThrow(() => world.sweep());
  assert.ok(world.logs.some((entry) => entry.event === 'wake-code-scan'));
  assert.equal(world.files.get('/state/key/round-state.json').prs[7].retry, false);
  const broken = makeWorld({ storeThrows: true, issues: [1] });
  assert.doesNotThrow(() => broken.sweep());
  assert.match(broken.logs[0].reason, /reviews\.json 损坏/);
  assert.equal(broken.logs[0].event, 'wake-code-scan-skip');
});

test('接线:wakeHeldPrs 读完开放 issue 列表后顺带对照代码扫描状态,不另读 issue 列表', () => {
  const world = makeWorld({ records: { 1: record('pass') }, issues: [1], rs: roundState(1), checks: { h1: codeql('neutral') } });
  world.wakeHeld();
  assert.equal(retryOf(world, 1), true);
  assert.equal(world.gh.filter((path) => path === 'repos/o/r/issues').length, 1, '开放 issue 列表只读一次');
  // 没有任何 PR 记过代码扫描三态:wakeHeldPrs 的请求数与原来相同(只有 issue 列表这一次)
  const plain = makeWorld({ records: {}, issues: [1], rs: roundState(1) });
  plain.wakeHeld();
  assert.deepEqual(plain.gh, ['repos/o/r/issues']);
});

// 审查 P2(复审):服务器在唤醒之后又评估了一次(同 head、新的评估时间)时,旧的 seen 作废。
test('服务器重新评估后(同 head、新的 at),上次扫描的 seen 作废:仍按服务器新记录对照,不漏唤醒', () => {
  const world = makeWorld({ records: { 1: record('fail') }, issues: [1], rs: roundState(1), checks: { h1: codeql('success') } });
  world.sweep();
  assert.equal(retryOf(world, 1), true);
  // 唤醒后服务器复核时 CodeQL 仍是 fail,采纳时 Mini 记下新的评估(同一个 head,at 变了)
  world.files.get('/state/key/round-state.json').prs[1].retry = false;
  world.files.set('/state/mivo/code-scan-watch.json', { ...world.files.get('/state/mivo/code-scan-watch.json'), lastSweepAt: new Date(NOW - SWEEP_MS - 1).toISOString() });
  const sweepAgain = makeWorld({ records: { 1: { codeScan: { ...record('fail').codeScan, at: '2026-10-17T19:30:00Z' } } }, issues: [1], rs: world.files.get('/state/key/round-state.json'),
    checks: { h1: codeql('success') }, watch: world.files.get('/state/mivo/code-scan-watch.json') });
  sweepAgain.sweep();
  assert.equal(retryOf(sweepAgain, 1), true, '新记录 fail、现在 pass:要再唤醒一次');
});

test('开放 PR 多于一次的读取上限:按上次读取时间轮转,后面的 PR 下一轮就轮到', () => {
  const total = MAX_WATCHED + 1;
  const prs = Array.from({ length: total }, (_, i) => i + 1);
  const records = Object.fromEntries(prs.map((pr) => [pr, record('pass', `h${pr}`)]));
  const checks = Object.fromEntries(prs.map((pr) => [pr, 0]).map(([pr]) => [`h${pr}`, codeql(pr === total ? 'neutral' : 'success')]));
  const world = makeWorld({ records, issues: prs, rs: roundState(...prs), checks });
  world.sweep();
  assert.equal(world.gh.filter((path) => path.includes('/check-runs')).length, MAX_WATCHED, '一次只读上限个');
  assert.equal(retryOf(world, total), false, '第 31 个这轮没轮到');
  // 过了间隔再扫一次:上一轮没读到的排最前,第 31 个被读到并唤醒
  world.files.set('/state/mivo/code-scan-watch.json', { ...world.files.get('/state/mivo/code-scan-watch.json'), lastSweepAt: new Date(NOW - SWEEP_MS - 1).toISOString() });
  world.gh.length = 0;
  world.sweep();
  assert.ok(world.gh.some((path) => path.includes(`commits/h${total}/check-runs`)));
  assert.equal(retryOf(world, total), true);
});

// 审查(第三轮)P2:服务器读规则遇到 5xx 记了 transient,恢复后规则其实不要求扫描(或规则被撤销)——这是确定的放行状态,必须唤醒一次重判。
test('服务器记 transient / fail 的 PR,之后读到规则不再要求扫描:唤醒一次重判;本来是 pass 的不必', () => {
  const recovered = makeWorld({ records: { 1: record('transient') }, issues: [1], rs: roundState(1), rules: [{ type: 'deletion' }] });
  recovered.sweep();
  assert.equal(retryOf(recovered, 1), true);
  assert.equal(recovered.gh.filter((path) => path.includes('/check-runs')).length, 0, '不要求扫描时不读 check run');
  const revoked = makeWorld({ records: { 2: record('fail', 'h2') }, issues: [2], rs: roundState(2), rules: [] });
  revoked.sweep();
  assert.equal(retryOf(revoked, 2), true);
  const wasPass = makeWorld({ records: { 3: record('pass', 'h3') }, issues: [3], rs: roundState(3), rules: [] });
  wasPass.sweep();
  assert.equal(retryOf(wasPass, 3), false);
  // 规则读不到(5xx)不是「不受约束」:仍然不唤醒
  const unreadable = makeWorld({ records: { 4: record('transient', 'h4') }, issues: [4], rs: roundState(4), rulesStatus: 'fail' });
  unreadable.sweep();
  assert.equal(retryOf(unreadable, 4), false);
});
