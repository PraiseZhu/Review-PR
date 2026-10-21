// resolve-fixed-threads.mjs 的测试:runner 用替身依赖;契约测试跑真实的 resolve-threads.mjs,gh 用 PATH 上的 fail-closed 替身,
// 不碰任何真实 GitHub。覆盖 #115 SC3/SC4/SC5。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveFixedThreads } from './resolve-fixed-threads.mjs';
import { runScript } from './common.mjs';

const HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const OLD = 'a'.repeat(12);
const REVIEWER = 'review-bot';
const RUN = 'https://github.com/o/r/actions/runs/42';
const K1 = '111111111111';
const K2 = '222222222222';
const marker = (key) => `<!-- mivo-finding key=${key} round=1 head=${OLD} -->`;
const thread = (id, key, extra = {}) => ({
  id, isResolved: false, path: 'a.ts',
  comments: [{ id: `c-${id}`, author: { login: REVIEWER }, body: `[P1] t\n\n${marker(key)}` }, ...(extra.replies ?? [])],
});
const ROUND = { mode: 'live', reviewed: true, reportComplete: true, sourceComplete: true, published: true, scopeMode: 'full', outcome: 'findings', finalFullOutcome: null };
const BINDING = { targetRepo: 'o/r', pr: 7, head: HEAD, base: BASE, baseRefName: 'main', reviewer: REVIEWER, lockToken: 'tok', authorityDigest: 'd', runUrl: RUN, mode: 'live' };
const request = (over = {}) => ({ binding: BINDING, round: ROUND, contextFile: 'ctx.json', excludedKeys: [], ...over });

function makeDeps({ reviewed, live = reviewed, verified = true, receipts = {}, bindingFails = null } = {}) {
  const log = [];
  let bindingCalls = 0;
  return {
    log,
    readContext: () => ({ history: { reviewThreads: reviewed } }),
    assertBinding: () => {
      bindingCalls += 1;
      log.push('binding');
      if (bindingFails && bindingCalls >= bindingFails) throw new Error('head 已变化');
      return { maintainers: ['maint'] };
    },
    fetchThreads: () => { log.push('fetch'); return { threads: live, verified, errors: verified ? [] : ['分页失败'] }; },
    resolveOne: (item) => {
      log.push(`resolve:${item.id}`);
      return receipts[item.id] ?? { ok: true, results: [{ id: item.id, done: true, replied: true, resolved: true }] };
    },
  };
}

test('SC1/SC4 候选逐条:先核对绑定、再 fresh 读取、再逐条核对后调用共享脚本,回复含 head/run/key', () => {
  const threads = [thread('T1', K1), thread('T2', K2)];
  const deps = makeDeps({ reviewed: threads });
  const sent = [];
  const original = deps.resolveOne;
  deps.resolveOne = (item, opts) => { sent.push(item); return original(item, opts); };
  const out = resolveFixedThreads(request({ excludedKeys: [K2] }), deps);
  assert.equal(out.status, 'completed');
  assert.equal(out.resolvedCount, 1);
  assert.deepEqual(deps.log, ['binding', 'fetch', 'binding', 'resolve:T1']);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].reply.includes(HEAD) && sent[0].reply.includes(RUN) && sent[0].reply.includes(K1));
});

test('SC4 dry-run / sandbox 不访问 GitHub、不调用共享脚本', () => {
  for (const mode of ['dry-run', 'sandbox']) {
    const deps = makeDeps({ reviewed: [thread('T1', K1)] });
    const out = resolveFixedThreads(request({ binding: { ...BINDING, mode }, round: { ...ROUND, mode } }), deps);
    assert.equal(out.status, 'skipped');
    assert.deepEqual(deps.log, []);
  }
});

test('SC3 reuse / error / 报告不完整 / 收口待补 → 清单为空,不访问网络', () => {
  for (const patch of [{ scopeMode: 'reuse' }, { outcome: 'error' }, { reportComplete: false }, { finalFullOutcome: 'pending-budget' }, { sourceComplete: false }]) {
    const deps = makeDeps({ reviewed: [thread('T1', K1)] });
    const out = resolveFixedThreads(request({ round: { ...ROUND, ...patch } }), deps);
    assert.equal(out.status, 'skipped', JSON.stringify(patch));
    assert.deepEqual(deps.log, [], JSON.stringify(patch));
  }
});

test('没有候选(prepare 快照里没有旧 thread)→ 不访问网络', () => {
  const deps = makeDeps({ reviewed: [] });
  assert.equal(resolveFixedThreads(request(), deps).skippedReason, 'no-candidates');
  assert.deepEqual(deps.log, []);
});

test('绑定检查失败(锁 / 账号 / head)→ 零写,只给 warning', () => {
  const deps = makeDeps({ reviewed: [thread('T1', K1)], bindingFails: 1 });
  const out = resolveFixedThreads(request(), deps);
  assert.equal(out.status, 'skipped');
  assert.ok(out.warnings.some((w) => w.includes('head 已变化')));
  assert.ok(!deps.log.some((entry) => entry.startsWith('resolve:')));
});

test('逐条复核:第二条前 head 变了 → 第二条起停止,已完成的保留', () => {
  const deps = makeDeps({ reviewed: [thread('T1', K1), thread('T2', K2)], bindingFails: 3 });
  const out = resolveFixedThreads(request(), deps);
  assert.equal(out.status, 'partial');
  assert.equal(out.resolvedCount, 1);
  assert.deepEqual(out.items.map((i) => i.status), ['resolved', 'skipped']);
  assert.deepEqual(deps.log.filter((e) => e.startsWith('resolve:')), ['resolve:T1']);
});

test('发布后重新读取 thread 不完整 → 零写', () => {
  const deps = makeDeps({ reviewed: [thread('T1', K1)], verified: false });
  const out = resolveFixedThreads(request(), deps);
  assert.equal(out.skippedReason, 'threads-unverified');
  assert.ok(!deps.log.some((entry) => entry.startsWith('resolve:')));
});

test('发布后出现新回复(内容变化)→ 不 resolve', () => {
  const reviewed = [thread('T1', K1)];
  const live = [thread('T1', K1, { replies: [{ id: 'n', author: { login: 'author' }, body: '我不同意' }] })];
  const deps = makeDeps({ reviewed, live });
  assert.equal(resolveFixedThreads(request(), deps).skippedReason, 'no-candidates');
  assert.ok(!deps.log.some((entry) => entry.startsWith('resolve:')));
});

test('共享脚本回执:单项失败只记 warning;already-resolved 不算新解决;翻案跳过;回执缺项停止后续', () => {
  const threads = [thread('T1', K1), thread('T2', K2)];
  const failed = makeDeps({ reviewed: threads, receipts: { T1: { ok: true, results: [{ id: 'T1', done: false, replied: false, replyError: '回复失败' }] } } });
  const out = resolveFixedThreads(request(), failed);
  assert.equal(out.status, 'partial');
  assert.equal(out.items[0].status, 'failed');
  assert.ok(out.warnings.some((w) => w.includes('回复失败')));

  const already = makeDeps({ reviewed: [thread('T1', K1)], receipts: { T1: { ok: true, results: [{ id: 'T1', done: true, reason: 'already-resolved' }] } } });
  const out2 = resolveFixedThreads(request(), already);
  assert.equal(out2.resolvedCount, 0);
  assert.equal(out2.alreadyResolvedCount, 1);

  const reopened = makeDeps({ reviewed: [thread('T1', K1)], receipts: { T1: { ok: true, results: [{ id: 'T1', done: false, reason: 'reopened-after-triage(...)' }] } } });
  assert.equal(resolveFixedThreads(request(), reopened).items[0].status, 'skipped');

  const empty = makeDeps({ reviewed: threads, receipts: { T1: { ok: true, results: [] } } });
  const out3 = resolveFixedThreads(request(), empty);
  assert.deepEqual(empty.log.filter((e) => e.startsWith('resolve:')), ['resolve:T1']);
  assert.equal(out3.status, 'partial');
});

test('预算用完 → 剩余项留给下一轮,已完成的保留', () => {
  let clock = 0;
  const deps = makeDeps({ reviewed: [thread('T1', K1), thread('T2', K2)] });
  deps.now = () => clock;
  const original = deps.resolveOne;
  deps.resolveOne = (item, opts) => { clock += 178_000; return original(item, opts); };
  const out = resolveFixedThreads(request(), deps);
  assert.deepEqual(out.items.map((i) => i.status), ['resolved', 'skipped']);
  assert.equal(out.items[1].reason, 'budget-exhausted');
  assert.equal(out.status, 'partial');
});

// ── 契约:真实 resolve-threads.mjs + fail-closed 假 gh ────────────────────────────
function makeGhFixture(state) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mivo-resolve-')));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ calls: [], ...state }));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const input = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const out = (value) => { save(); process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (args[0] === 'api' && args[1] === 'graphql' && input) {
  const q = input.query;
  if (/reviewThreads/.test(q)) {
    state.calls.push('read');
    out({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null },
      nodes: state.threads.map((t) => ({ id: t.id, isResolved: t.isResolved, path: t.path, line: 1, isOutdated: false,
        comments: { pageInfo: { hasNextPage: false }, nodes: t.comments } })) } } } } });
  }
  if (/addPullRequestReviewThreadReply/.test(q)) {
    state.calls.push('reply:' + input.variables.tid);
    state.replies = [...(state.replies || []), input.variables];
    const t = state.threads.find((x) => x.id === input.variables.tid);
    if (state.failReply) out({ errors: [{ message: 'nope' }], data: null });
    t.comments.push({ id: 'reply-' + t.id, author: { login: 'review-bot' }, body: input.variables.body });
    out({ data: { addPullRequestReviewThreadReply: { comment: { id: 'reply-' + t.id } } } });
  }
  if (/resolveReviewThread/.test(q)) {
    state.calls.push('resolve:' + input.variables.tid);
    state.threads.find((x) => x.id === input.variables.tid).isResolved = true;
    out({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
  }
}
state.calls.push('UNKNOWN:' + args.join(' '));
save();
console.error('unexpected gh call: ' + args.join(' '));
process.exit(1);
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, REVIEW_PR_NO_CRED_FALLBACK: '1', GH_TOKEN: 'fake', GITHUB_TOKEN: '',
    REVIEW_PR_REPO_ROOT: repo, REVIEW_PR_STATE_DIR: join(dir, 'state'), HOME: dir, REVIEW_PR_RULES_FILE: process.env.REVIEW_PR_RULES_FILE };
  delete env.REVIEW_PR_READ_TOKEN;
  return { dir, repo, env, read: () => JSON.parse(readFileSync(stateFile, 'utf8')) };
}

test('契约 SC4 真实 resolve-threads.mjs:先回复再 resolve,回复含 head/run/key 与 triage 标记', (t) => {
  const reviewed = [thread('T1', K1), thread('T2', K2)];
  const fx = makeGhFixture({ threads: JSON.parse(JSON.stringify(reviewed)) });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const deps = makeDeps({ reviewed });
  deps.fetchThreads = () => ({ threads: JSON.parse(JSON.stringify(reviewed)), verified: true, errors: [] });
  deps.resolveOne = (item, { timeoutMs }) => runScript('resolve-threads.mjs', ['7', '--payload-file', '-'],
    { cwd: fx.repo, env: fx.env, input: JSON.stringify({ threads: [item] }), timeoutMs });
  const out = resolveFixedThreads(request({ excludedKeys: [K2] }), deps);
  assert.equal(out.status, 'completed', JSON.stringify(out));
  const state = fx.read();
  assert.deepEqual(state.calls.filter((c) => !c.startsWith('read')), ['reply:T1', 'resolve:T1']);
  assert.ok(!state.calls.some((c) => c.startsWith('UNKNOWN')));
  const body = state.replies[0].body;
  assert.ok(body.includes(HEAD) && body.includes(RUN) && body.includes(K1));
  assert.ok(body.includes('<!-- review-pr:thread-triage -->'));
  assert.equal(state.threads.find((x) => x.id === 'T2').isResolved, false);
});

test('契约 回复失败 → 共享脚本不 resolve,runner 记 warning', (t) => {
  const reviewed = [thread('T1', K1)];
  const fx = makeGhFixture({ threads: JSON.parse(JSON.stringify(reviewed)), failReply: true });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const deps = makeDeps({ reviewed });
  deps.fetchThreads = () => ({ threads: JSON.parse(JSON.stringify(reviewed)), verified: true, errors: [] });
  deps.resolveOne = (item, { timeoutMs }) => runScript('resolve-threads.mjs', ['7', '--payload-file', '-'],
    { cwd: fx.repo, env: fx.env, input: JSON.stringify({ threads: [item] }), timeoutMs });
  const out = resolveFixedThreads(request(), deps);
  assert.equal(out.status, 'partial');
  assert.equal(out.resolvedCount, 0);
  assert.ok(!fx.read().calls.some((c) => c.startsWith('resolve:')));
  assert.ok(existsSync(fx.dir));
});
