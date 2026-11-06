// fuse-gate.test.mjs — 审查熔断接进判门(PraiseZhu/Review-PR#209):用 round.mjs 里真实的 holdForFuse 等函数源码(vm),
// gh 与本机 reviews.json 换成内存替身。证明:满 10 版不派审、作者再推也不派;熔断 issue 只开一次;「继续审」后恢复并关 issue;
// dry-run 不写 GitHub;作者是维护者也照样熔断。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import * as fuse from '../lib/fuse.mjs';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
const section = /^\/\/ ── 审查熔断\(#209\)[\s\S]*?(?=^async function executeGateAction)/m.exec(source)?.[0];
assert.ok(section, '找不到 round.mjs 的审查熔断段');
assert.match(source, /return holdForFuse\(ctx, task, live, result\) \?\? dispatchReview\(ctx, task, \{ tier: decision\.tier, action: 'review' \}/,
  '判门送审前必须先过 holdForFuse');
assert.match(source, /if \(next\.dispatch\) return holdForFuse\(ctx, task, live, result\) \?\? dispatchReview\(/, '受保护路径复核派审前也要过 holdForFuse');

const CONFIG_FUSE = { enabled: true, maxVersions: 10, resumeLine: '继续审', maintainers: ['praisezhu', 'aj0928'] };
const tenVersions = (prefix = 'h') => Array.from({ length: 10 }, (_, i) => ({ fp: `patch:${prefix}${i}`, head: `${prefix}${i}`, at: `2026-11-07T0${i}:00:00.000Z` }));

function makeWorld({ mode = 'live', record = {}, comments = [], createOk = true, closeOk = true, commentsOk = true, listOk = true, openIssues = [] } = {}) {
  const store = { prs: { 1704: structuredClone(record) } };
  const calls = [];
  const finished = [];
  const logs = [];
  let issueNo = 900;
  const runGh = (cmd, args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'create') return createOk ? { ok: true, stdout: `https://github.com/o/r/issues/${++issueNo}\n` } : { ok: false, stderr: 'HTTP 403' };
    if (args[0] === 'issue' && args[1] === 'close') return closeOk ? { ok: true, stdout: '' } : { ok: false, stderr: 'HTTP 502' };
    return { ok: false, stderr: `unexpected ${args.join(' ')}` };
  };
  const sandbox = {
    CONFIG: { mode, targetRepo: 'o/r', repoRoot: '/repo' }, ENV: {}, join,
    ...fuse,
    fuseConfig: () => CONFIG_FUSE,
    loadStore: () => structuredClone(store),
    bumpOwned: (ctx, task, patch) => { store.prs[task.pr] = { ...(store.prs[task.pr] ?? {}), ...structuredClone(patch) }; },
    finishGate: (ctx, task, result) => { finished.push(structuredClone(result)); return { dispatched: false }; },
    toLiveBlockers: () => [],
    run: runGh,
    ghRead: (args) => {
      calls.push(args);
      if (args.includes('graphql')) {
        return commentsOk ? { ok: true, stdout: JSON.stringify({ data: { repository: { issue: { comments: { nodes: comments } } } } }) } : { ok: false, stderr: 'HTTP 502' };
      }
      if (args.includes('repos/o/r/issues')) return listOk ? { ok: true, stdout: JSON.stringify([openIssues]) } : { ok: false, stderr: 'HTTP 502' };
      return { ok: false, stderr: `unexpected ${args.join(' ')}` };
    },
    log: (event, detail) => logs.push({ event, ...detail }),
    assertNotFenced: () => {},
    writeText: () => {},
    nowIso: () => '2026-11-07T12:00:00.000Z',
  };
  vm.runInNewContext(`${section}\nglobalThis.hold = holdForFuse;`, sandbox);
  const live = { meta: { title: '对话出图判定', url: 'https://github.com/o/r/pull/1704', author: 'aj0928' } };
  const gate = (head) => {
    const result = { outcome: 'review', reason: '', errors: [], warnings: [], gate: { stage: 'review', actions: [] } };
    const out = sandbox.hold({ roundDir: '/round' }, { pr: 1704, head }, live, result);
    return { out, result };
  };
  return { gate, store, calls, finished, logs, comments };
}

test('SC3 满 10 版:判门不派审,记 maintainer-signoff + gate.fuse;作者再推 3 个提交仍不派审', () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } } });
  const first = world.gate('h9');
  assert.deepEqual(first.out, { dispatched: false }, '返回非 null 即不调 dispatchReview');
  assert.equal(first.result.outcome, 'maintainer-signoff');
  assert.equal(first.result.gate.fuse.count, 10);
  for (const head of ['n1', 'n2', 'n3']) assert.deepEqual(world.gate(head).out, { dispatched: false }, head);
  assert.equal(world.finished.length, 4);
  assert.ok(world.finished.every((r) => r.outcome === 'maintainer-signoff' && r.reviewClean !== true));
});

test('没满 10 版或当前 head 已审查通过:不拦,照常派审', () => {
  assert.equal(makeWorld({ record: { fuse: { versions: tenVersions().slice(0, 9) } } }).gate('h9').out, null);
  assert.equal(makeWorld({ record: { fuse: { versions: tenVersions() }, cleanHead: 'h9' } }).gate('h9').out, null);
});

test('SC4 熔断 issue 只开一次:标题前缀与标记正确,issue 号记进本机记录;作者 aj0928 是维护者也照样熔断', () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), lastFindings: { P0: 0, P1: 0, P2: 5 } } } });
  world.gate('h9');
  world.gate('h9');
  world.gate('n1');
  const creates = world.calls.filter((args) => args[0] === 'issue' && args[1] === 'create');
  assert.equal(creates.length, 1);
  assert.ok(creates[0][creates[0].indexOf('--title') + 1].startsWith('审查熔断 · PR #1704'));
  assert.equal(world.store.prs[1704].fuse.trip.issue, 901);
  assert.equal(world.finished.at(-1).gate.fuse.issue, 901);
  assert.match(world.finished.at(-1).reason, /#901 回「继续审」/);
});

test('开 issue 失败:记 error 并 retry,不写熔断记录,下一轮再开', () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, createOk: false });
  const { result } = world.gate('h9');
  assert.equal(result.retry, true);
  assert.match(result.errors[0], /熔断 issue 没开出来/);
  assert.equal(world.store.prs[1704].fuse.trip, undefined);
});

test('SC5「继续审」:有效评论 → 清熔断、记 resumedAt、关 issue,这一轮照常派审;版本数从 0 重新算', () => {
  const trip = { issue: 901, at: '2026-11-07T11:00:00.000Z', count: 10, head: 'h9' };
  const world = makeWorld({
    record: { fuse: { versions: tenVersions(), trip } },
    comments: [{ author: { login: 'kirozeng' }, body: '继续审', createdAt: '2026-11-07T11:05:00Z', isMinimized: false, databaseId: 5 },
      { author: { login: 'aj0928' }, body: '继续审', createdAt: '2026-11-07T11:30:00Z', isMinimized: false, databaseId: 6 }],
  });
  const { out } = world.gate('h9');
  assert.equal(out, null, '恢复后这一轮照常派审');
  assert.equal(world.store.prs[1704].fuse.trip, null);
  assert.equal(world.store.prs[1704].fuse.resumedAt, '2026-11-07T11:30:00Z', '作者本人(也是维护者)那条有效;kirozeng 不在本测试的维护者名单里');
  const close = world.calls.find((args) => args[0] === 'issue' && args[1] === 'close');
  assert.equal(close[0], 'issue');
  assert.equal(close[1], 'close');
  assert.equal(close[2], '901');
  assert.equal(fuse.toFuseCount(world.store.prs[1704].fuse), 0);
});

test('SC5 没有有效「继续审」:照旧停审,不关 issue,不重开 issue', () => {
  const trip = { issue: 901, at: '2026-11-07T11:00:00.000Z', count: 10, head: 'h9' };
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), trip } },
    comments: [{ author: { login: 'aj0928' }, body: '先别继续审', createdAt: '2026-11-07T11:05:00Z', isMinimized: false }] });
  assert.deepEqual(world.gate('n1').out, { dispatched: false });
  assert.equal(world.calls.filter((args) => args[0] === 'issue').length, 0);
});

test('SC6 dry-run:熔断只记 dryRunActions,不写 GitHub、不写本机熔断记录', () => {
  const world = makeWorld({ mode: 'dry-run', record: { fuse: { versions: tenVersions() } } });
  const { result } = world.gate('h9');
  assert.deepEqual(JSON.parse(JSON.stringify(result.dryRunActions)), ['fuse-issue:create']);
  assert.equal(world.calls.length, 0);
  assert.equal(world.store.prs[1704].fuse.trip, undefined);
});

test('熔断关闭时不读 store、不拦', () => {
  const sandbox = { fuseConfig: () => ({ enabled: false }), loadStore: () => { throw new Error('不该读'); } };
  vm.runInNewContext(`${section}\nglobalThis.hold = holdForFuse;`, sandbox);
  assert.equal(sandbox.hold({}, { pr: 1, head: 'h' }, {}, {}), null);
});

// #211 单审的三条 P2:评论读不到要 retry;开 issue 前查重、沿用已开的;恢复时先关 issue,关失败不清熔断。
const TRIP = { issue: 901, at: '2026-11-07T11:00:00.000Z', count: 10, head: 'h9' };
const RESUME = [{ author: { login: 'aj0928' }, body: '继续审', createdAt: '2026-11-07T11:30:00Z', isMinimized: false, databaseId: 6 }];

test('评论读不到:照旧停审,记 retry(同一条「继续审」只唤醒一次,不 retry 就会一直停着)', () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), trip: TRIP } }, comments: RESUME, commentsOk: false });
  const { out, result } = world.gate('h9');
  assert.deepEqual(out, { dispatched: false });
  assert.equal(result.retry, true);
  assert.match(result.warnings.at(-1), /评论读不到,照旧停审,下一轮再读/);
  assert.deepEqual(world.store.prs[1704].fuse.trip, TRIP);
});

test('开 issue 前查重:开着的 issue 里已有这个 PR 的熔断 issue(上一轮开成功、本机没记上)就沿用,不重开', () => {
  const marker = (pr) => `<!-- mivo-fuse pr=${pr} -->\n正文`;
  const openIssues = [
    { number: 950, title: '审查熔断 · PR #17040：审到第 10 版还没放行', body: marker(17040) },
    { number: 951, title: '审查熔断 · PR #1704：审到第 10 版还没放行', body: marker(1704), pull_request: { url: 'x' } },
    { number: 952, title: '审查熔断 · PR #1704：审到第 10 版还没放行', body: marker(1704) },
  ];
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, openIssues });
  const { result } = world.gate('h9');
  assert.equal(world.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 0);
  assert.equal(world.store.prs[1704].fuse.trip.issue, 952);
  assert.equal(result.gate.fuse.issue, 952);
});

test('开 issue 前读不到开着的 issue 列表:不开、记 error 并 retry,不写熔断记录', () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, listOk: false });
  const { out, result } = world.gate('h9');
  assert.deepEqual(out, { dispatched: false }, '照旧停审');
  assert.equal(world.calls.filter((args) => args[0] === 'issue').length, 0);
  assert.equal(result.retry, true);
  assert.match(result.errors[0], /读不到开着的 issue 列表/);
  assert.equal(world.store.prs[1704].fuse.trip, undefined);
});

test('恢复时关 issue 失败:不清熔断、不派审,记 error 并 retry;下一轮关成功才恢复', () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), trip: TRIP } }, comments: RESUME, closeOk: false });
  const first = world.gate('h9');
  assert.deepEqual(first.out, { dispatched: false });
  assert.equal(first.result.retry, true);
  assert.match(first.result.errors[0], /没关掉,先不恢复送审/);
  assert.deepEqual(world.store.prs[1704].fuse.trip, TRIP);
  const retried = makeWorld({ record: structuredClone(world.store.prs[1704]), comments: RESUME });
  assert.equal(retried.gate('h9').out, null);
  assert.equal(retried.store.prs[1704].fuse.trip, null);
});
