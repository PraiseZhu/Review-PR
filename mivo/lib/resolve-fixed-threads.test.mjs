// resolve-fixed-threads.mjs 的测试:runner 用替身依赖;契约测试走生产的 realDeps 写入路径,gh 用 PATH 上的 fail-closed 替身
// (同时记录 reply 与 resolve 两种 mutation),不碰任何真实 GitHub。覆盖 #115 SC3/SC4/SC5,以及 #185「只回复、不 resolve」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as runner from './resolve-fixed-threads.mjs';
import { runScript, SCRIPTS } from './common.mjs';

const { resolveFixedThreads } = runner;
const lib = await import(pathToFileURL(join(SCRIPTS, 'lib.mjs')).href);

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

// addPullRequestReviewThreadReply 的 GraphQL 回执形状。
const replyReceipt = (id) => ({ data: { addPullRequestReviewThreadReply: { comment: { id } } } });

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
    replyOne: (item) => {
      log.push(`reply:${item.id}`);
      return receipts[item.id] ?? replyReceipt(`reply-${item.id}`);
    },
  };
}

test('SC1/SC4 候选逐条:先核对绑定、再 fresh 读取;逐条先核对绑定、最后一次重读后立即回复,回复含 head/run/key 与 thread-fixed 标记', () => {
  const threads = [thread('T1', K1), thread('T2', K2)];
  const deps = makeDeps({ reviewed: threads });
  const sent = [];
  const original = deps.replyOne;
  deps.replyOne = (item, opts) => { sent.push(item); return original(item, opts); };
  const out = resolveFixedThreads(request({ excludedKeys: [K2] }), deps);
  assert.equal(out.status, 'completed');
  assert.equal(out.repliedCount, 1);
  assert.deepEqual(deps.log, ['binding', 'fetch', 'binding', 'fetch', 'reply:T1']);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].reply.includes(HEAD) && sent[0].reply.includes(RUN) && sent[0].reply.includes(K1));
  assert.ok(sent[0].reply.endsWith(`<!-- mivo-review:thread-fixed key=${K1} head=${HEAD} -->`));
});

test('SC4 dry-run / sandbox 不访问 GitHub、不回复', () => {
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
  assert.ok(!deps.log.some((entry) => entry.startsWith('reply:')));
});

test('逐条复核:第二条前 head 变了 → 第二条起停止,已完成的保留', () => {
  const deps = makeDeps({ reviewed: [thread('T1', K1), thread('T2', K2)], bindingFails: 3 });
  const out = resolveFixedThreads(request(), deps);
  assert.equal(out.status, 'partial');
  assert.equal(out.repliedCount, 1);
  assert.deepEqual(out.items.map((i) => i.status), ['replied', 'skipped']);
  assert.deepEqual(deps.log.filter((e) => e.startsWith('reply:')), ['reply:T1']);
});

// 每条 thread 动手前单独现查(F1):处理 T1 期间 T2 发生的变化,T2 必须被跳过并记 warning。
function liveDuringBatch(mutateT2) {
  const reviewed = [thread('T1', K1), thread('T2', K2)];
  const live = [thread('T1', K1), thread('T2', K2)];
  const deps = makeDeps({ reviewed, live });
  const original = deps.replyOne;
  deps.replyOne = (item, opts) => {
    const receipt = original(item, opts);
    if (item.id === 'T1') mutateT2(live);
    return receipt;
  };
  return { deps, out: resolveFixedThreads(request(), deps) };
}
const repliedIds = (deps) => deps.log.filter((e) => e.startsWith('reply:'));

test('F1 处理 T1 期间 T2 新增维护者裁定 → T2 不回复,记 warning', () => {
  const { deps, out } = liveDuringBatch((live) => live[1].comments.push({ id: 'r-new', author: { login: 'maint' }, body: '维护者裁定不改:产品意图' }));
  assert.deepEqual(repliedIds(deps), ['reply:T1']);
  assert.deepEqual(out.items.map((i) => i.status), ['replied', 'skipped']);
  assert.equal(out.items[1].reason, 'changed-since-plan');
  assert.ok(out.warnings.some((w) => w.includes(K2)));
});

test('F1 处理 T1 期间 T2 有了作者申辩 / 评论被改 → T2 不回复', () => {
  const reply = liveDuringBatch((live) => live[1].comments.push({ id: 'n', author: { login: 'author' }, body: '我不同意' }));
  assert.deepEqual(repliedIds(reply.deps), ['reply:T1']);
  assert.equal(reply.out.items[1].reason, 'changed-since-plan');
  const edited = liveDuringBatch((live) => { live[1].comments[0].body += ' (edited)'; });
  assert.deepEqual(repliedIds(edited.deps), ['reply:T1']);
});

test('F1 处理 T1 期间 T2 被人 resolve 或维护者在同 key 的另一条 thread 上裁定 → T2 不再回复', () => {
  const resolved = liveDuringBatch((live) => { live[1].isResolved = true; });
  assert.deepEqual(repliedIds(resolved.deps), ['reply:T1']);
  const sameKey = liveDuringBatch((live) => live.push(thread('T9', K2, { replies: [{ id: 'r9', author: { login: 'maint' }, body: '维护者裁定不改:产品意图' }] })));
  assert.deepEqual(repliedIds(sameKey.deps), ['reply:T1']);
});

test('F1 处理 T1 期间 T2 又被 unresolve 过(出现 triage 标记)→ T2 不回复', () => {
  const { deps } = liveDuringBatch((live) => live[1].comments.push({ id: 'tr', author: { login: REVIEWER }, body: '<!-- review-pr:thread-triage -->' }));
  assert.deepEqual(repliedIds(deps), ['reply:T1']);
});

test('F1 处理 T1 期间重新读取 thread 不完整 → 该条及之后不回复,记 warning', () => {
  const reviewed = [thread('T1', K1), thread('T2', K2)];
  const deps = makeDeps({ reviewed });
  let fetches = 0;
  const fetchThreads = deps.fetchThreads;
  deps.fetchThreads = () => { fetches += 1; return fetches >= 3 ? { threads: [], verified: false, errors: ['分页失败'] } : fetchThreads(); };
  const out = resolveFixedThreads(request(), deps);
  assert.deepEqual(repliedIds(deps), ['reply:T1']);
  assert.equal(out.status, 'partial');
  assert.ok(out.warnings.some((w) => w.includes('分页失败')));
});

test('F3 逐条绑定检查(多次网络查询)期间该条新增维护者裁定 → 不回复,重读紧贴写操作', () => {
  const reviewed = [thread('T1', K1), thread('T2', K2)];
  const live = [thread('T1', K1), thread('T2', K2)];
  const deps = makeDeps({ reviewed, live });
  const binding = deps.assertBinding;
  let calls = 0;
  deps.assertBinding = () => {
    const result = binding();
    calls += 1;
    if (calls === 3) live[1].comments.push({ id: 'r-new', author: { login: 'maint' }, body: '维护者裁定不改:产品意图' });
    return result;
  };
  const out = resolveFixedThreads(request(), deps);
  assert.deepEqual(repliedIds(deps), ['reply:T1']);
  assert.equal(out.items[1].reason, 'changed-since-plan');
  assert.ok(out.warnings.some((w) => w.includes(K2)));
  // 每次回复前最近一条日志必须是 fetch:重读与调用之间不得插入别的网络请求。
  deps.log.forEach((entry, i) => { if (entry.startsWith('reply:')) assert.equal(deps.log[i - 1], 'fetch'); });
});

// ── F4:head 与 thread 来自同一次 GraphQL 响应 ────────────────────────────────────
// 假 GraphQL 服务:只在查询里带了 headRefOid 等字段时才回它们,所以包装器没注入就等于「读不到 head」。
const NEW_HEAD = 'd'.repeat(40);
function fakeWorld(pages, over = {}) {
  const world = { head: HEAD, base: BASE, baseRefName: 'main', state: 'OPEN', isDraft: false, pages, calls: 0, onCall: null, omitMeta: false, ...over };
  const meta = (query) => (query.includes('headRefOid') && !world.omitMeta
    ? { state: world.state, isDraft: world.isDraft, headRefOid: world.head, baseRefOid: world.base, baseRefName: world.baseRefName } : {});
  world.graphql = (query, vars) => {
    world.calls += 1;
    world.onCall?.(world.calls, query, vars);
    if (query.includes('reviewThreads(')) {
      const idx = vars.cursor ? Number(vars.cursor) : 0;
      const nodes = world.pages[idx].map((t) => ({
        id: t.id, isResolved: t.isResolved,
        comments: { pageInfo: { hasNextPage: Boolean(t.pagedComments), endCursor: t.pagedComments ? 'cc' : null }, nodes: t.pagedComments ? t.comments.slice(0, 1) : t.comments },
      }));
      return { data: { repository: { pullRequest: { ...meta(query), reviewThreads: { pageInfo: { hasNextPage: idx + 1 < world.pages.length, endCursor: String(idx + 1) }, nodes } } } } };
    }
    const t = world.pages.flat().find((x) => x.id === vars.id);
    const second = Boolean(vars.cursor);
    const m = meta(query);
    return { data: { node: { ...(m.headRefOid || m.state ? { pullRequest: m } : {}),
      comments: { pageInfo: { hasNextPage: !second, endCursor: second ? null : 'c2' }, nodes: second ? t.comments.slice(1) : t.comments.slice(0, 1) } } } };
  };
  return world;
}
const bind = (world, binding = BINDING) => runner.bindGraphqlToPr(binding, world.graphql);
const readThreads = (graphql) => lib.fetchAllReviewThreads('o', 'r', 7, { includeComments: true, ghGraphqlFn: graphql });

test('F4 包装器:thread 分页与评论分页的每一次响应都带并校验 head/base/state', () => {
  const t1 = { ...thread('T1', K1), pagedComments: true };
  const world = fakeWorld([[t1], [thread('T2', K2)]]);
  const queries = [];
  const seen = world.graphql;
  world.graphql = (query, vars) => { queries.push(query); return seen(query, vars); };
  const out = readThreads(bind(world));
  assert.equal(out.verified, true, out.errors.join(';'));
  assert.deepEqual(out.threads.map((t) => t.id), ['T1', 'T2']);
  assert.equal(queries.length, 4); // thread 第 1 页、T1 评论第 1 / 2 页、thread 第 2 页
  assert.ok(queries.every((q) => q.includes('headRefOid') && q.includes('baseRefOid') && q.includes('isDraft')));
});

test('F4 包装器:任何一页里 head / base / baseRefName / state / draft 与绑定不符,或响应缺这些字段 → 读取未验证', () => {
  const cases = [
    ['head', (w) => { w.head = NEW_HEAD; }], ['base', (w) => { w.base = NEW_HEAD; }], ['baseRefName', (w) => { w.baseRefName = 'other'; }],
    ['state', (w) => { w.state = 'CLOSED'; }], ['draft', (w) => { w.isDraft = true; }], ['缺字段', (w) => { w.omitMeta = true; }],
  ];
  for (const [name, mutate] of cases) {
    for (const when of [1, 2, 3, 4]) { // thread 第 1 页 / 评论第 1 页 / 评论第 2 页 / thread 第 2 页
      const world = fakeWorld([[{ ...thread('T1', K1), pagedComments: true }], [thread('T2', K2)]]);
      world.onCall = (n) => { if (n === when) mutate(world); };
      const out = readThreads(bind(world));
      assert.equal(out.verified, false, `${name}@${when} 应当未验证`);
    }
  }
});

test('F4 包装器:没有注入点的查询直接拒绝(不放行未绑定的读取)', () => {
  const graphql = runner.bindGraphqlToPr(BINDING, () => { throw new Error('不应走到底层'); });
  assert.throws(() => graphql('query { viewer { login } }', {}), /绑定/);
});

test('F4/F5 真实依赖的 thread 读取走 fetchSingleSnapshot(接线守卫)', () => {
  const source = readFileSync(new URL('./resolve-fixed-threads.mjs', import.meta.url), 'utf8');
  assert.match(source, /fetchThreads: \(\) => fetchSingleSnapshot\(\{[^\n]*ghGraphqlFn: lib\.ghGraphql, fetchAllReviewThreads: lib\.fetchAllReviewThreads \}\)/);
});

test('#185 接线守卫:生产文件不再引用共享 resolve-threads.mjs / runScript,也不含 resolveReviewThread mutation', () => {
  const source = readFileSync(new URL('./resolve-fixed-threads.mjs', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  assert.doesNotMatch(code, /resolve-threads\.mjs|runScript|resolveReviewThread/);
  assert.match(code, /addPullRequestReviewThreadReply/);
});

const snapshot = (world) => runner.fetchSingleSnapshot({ owner: 'o', repo: 'r', pr: 7, binding: BINDING, ghGraphqlFn: world.graphql, fetchAllReviewThreads: lib.fetchAllReviewThreads });

test('F5 一次响应读完的快照照常可用,且仍校验 head', () => {
  const ok = snapshot(fakeWorld([[thread('T1', K1), thread('T2', K2)]]));
  assert.equal(ok.verified, true, ok.errors?.join(';'));
  assert.deepEqual(ok.threads.map((t) => t.id), ['T1', 'T2']);
  const moved = fakeWorld([[thread('T1', K1)]], { head: NEW_HEAD });
  assert.equal(snapshot(moved).verified, false);
});

test('F5 thread 要翻页或评论要翻页 → 快照未验证(各页不是同一时刻)', () => {
  for (const pages of [[[thread('T1', K1)], [thread('T2', K2)]], [[{ ...thread('T1', K1), pagedComments: true }]]]) {
    const out = snapshot(fakeWorld(pages));
    assert.equal(out.verified, false);
    assert.deepEqual(out.threads, []);
    assert.match(out.errors.join(';'), /翻页/);
  }
});

test('F5 T1 在第 1 页、第 2 页请求期间维护者给 T1 加裁定 → 不回复,记 warning', () => {
  const world = fakeWorld([[thread('T1', K1)], [thread('T2', K2)]]);
  const deps = makeDeps({ reviewed: [thread('T1', K1)] });
  deps.fetchThreads = () => { deps.log.push('fetch'); return snapshot(world); };
  world.onCall = (n, query, vars) => { if (vars.cursor === '1') world.pages[0][0].comments.push({ id: 'r-new', author: { login: 'maint' }, body: '维护者裁定不改:产品意图' }); };
  const out = resolveFixedThreads(request(), deps);
  assert.deepEqual(repliedIds(deps), []);
  assert.equal(out.repliedCount, 0);
  assert.ok(out.warnings.some((w) => /翻页/.test(w)), out.warnings.join('|'));
});

test('F4 重读 thread 期间 PR head 变化(含回退到 marker 的旧 head)→ 不回复,记 warning', () => {
  for (const moved of [NEW_HEAD, 'a'.repeat(40)]) {
    const world = fakeWorld([[thread('T1', K1)]]);
    const deps = makeDeps({ reviewed: [thread('T1', K1)] });
    let fetches = 0;
    deps.fetchThreads = () => { fetches += 1; deps.log.push('fetch'); return readThreads(bind(world)); };
    world.onCall = (n) => { if (n === 2) world.head = moved; }; // 第 2 次 thread 读取(逐条重读)时 head 变化
    const out = resolveFixedThreads(request(), deps);
    assert.deepEqual(repliedIds(deps), [], `moved=${moved.slice(0, 4)}`);
    assert.equal(fetches, 2);
    assert.equal(out.repliedCount, 0);
    assert.ok(out.warnings.some((w) => /head/.test(w)), out.warnings.join('|'));
  }
});

test('F4 + F3 多页:head 不变但绑定检查期间 T2 新增裁定 → 只回复 T1;T2 所在第 2 页读取时 head 变化 → 一条都不再写', () => {
  const build = () => {
    const world = fakeWorld([[{ ...thread('T1', K1), pagedComments: true }], [thread('T2', K2)]]);
    const deps = makeDeps({ reviewed: [thread('T1', K1), thread('T2', K2)] });
    deps.fetchThreads = () => { deps.log.push('fetch'); return readThreads(bind(world)); };
    return { world, deps };
  };
  // F3:裁定出现在 world 里,head 不变 → 分页读取都通过,T2 因 changed-since-plan 被跳过。
  const f3 = build();
  const binding = f3.deps.assertBinding;
  let bindings = 0;
  f3.deps.assertBinding = () => {
    const result = binding();
    bindings += 1;
    if (bindings === 3) f3.world.pages[1][0].comments.push({ id: 'r-new', author: { login: 'maint' }, body: '维护者裁定不改:产品意图' });
    return result;
  };
  const f3out = resolveFixedThreads(request(), f3.deps);
  assert.deepEqual(repliedIds(f3.deps), ['reply:T1']);
  assert.equal(f3out.items[1].reason, 'changed-since-plan');
  // F4:T1 处理完后,读 T2 前的 thread 读取里(第 2 页)head 变化 → T2 不写。
  const f4 = build();
  const original = f4.deps.replyOne;
  let armed = false;
  f4.deps.replyOne = (item, opts) => { const r = original(item, opts); if (item.id === 'T1') armed = true; return r; };
  f4.world.onCall = (n, query, vars) => { if (armed && vars.cursor === '1') f4.world.head = NEW_HEAD; };
  const f4out = resolveFixedThreads(request(), f4.deps);
  assert.deepEqual(repliedIds(f4.deps), ['reply:T1']);
  assert.equal(f4out.items[1].status, 'skipped');
  assert.equal(f4out.items[1].reason, 'threads-unverified');
  assert.ok(f4out.warnings.some((w) => /head/.test(w)), f4out.warnings.join('|'));
});

test('发布后重新读取 thread 不完整 → 零写', () => {
  const deps = makeDeps({ reviewed: [thread('T1', K1)], verified: false });
  const out = resolveFixedThreads(request(), deps);
  assert.equal(out.skippedReason, 'threads-unverified');
  assert.ok(!deps.log.some((entry) => entry.startsWith('reply:')));
});

test('发布后出现新回复(内容变化)→ 不回复', () => {
  const reviewed = [thread('T1', K1)];
  const live = [thread('T1', K1, { replies: [{ id: 'n', author: { login: 'author' }, body: '我不同意' }] })];
  const deps = makeDeps({ reviewed, live });
  assert.equal(resolveFixedThreads(request(), deps).skippedReason, 'no-candidates');
  assert.ok(!deps.log.some((entry) => entry.startsWith('reply:')));
});

test('回复回执:缺 comment id / data / comment、errors 伴随部分 data、抛错、403 → 记 failed + warning,停止后续,不重试;成功项保留', () => {
  const threads = [thread('T1', K1), thread('T2', K2)];
  const bad = {
    '空 id': replyReceipt(''),
    'id 不是字符串': replyReceipt(42),
    '缺 comment': { data: { addPullRequestReviewThreadReply: {} } },
    '缺 data': {},
    '没有回执': undefined,
    'errors 伴随部分 data': { errors: [{ message: 'FORBIDDEN' }], ...replyReceipt('reply-T1') },
  };
  for (const [name, receipt] of Object.entries(bad)) {
    const deps = makeDeps({ reviewed: threads, receipts: { T1: receipt } });
    deps.replyOne = ((original) => (item, opts) => { const r = original(item, opts); return item.id === 'T1' ? receipt : r; })(deps.replyOne);
    const out = resolveFixedThreads(request(), deps);
    assert.equal(out.status, 'partial', name);
    assert.equal(out.repliedCount, 0, name);
    assert.deepEqual(out.items.map((i) => i.status), ['failed', 'skipped'], name);
    assert.equal(out.items[1].reason, 'stopped-after-failure', name);
    assert.deepEqual(repliedIds(deps), ['reply:T1'], `${name}:未知写结果不重试、不碰后面的`);
    assert.ok(out.warnings.some((w) => w.startsWith(`旧 thread 修复说明回复失败(${K1}):`)), `${name}: ${out.warnings.join('|')}`);
    assert.ok(!out.warnings.some((w) => w.includes('代 resolve')), name);
  }
  const noId = resolveFixedThreads(request(), (() => { const d = makeDeps({ reviewed: threads }); d.replyOne = () => ({ data: { addPullRequestReviewThreadReply: { comment: {} } } }); return d; })());
  assert.match(noId.warnings.join('|'), /回复未返回 comment id/);
  assert.match(noId.items[0].reason, /回复未返回 comment id/);

  for (const message of ['HTTP 403: Resource not accessible by integration', 'gh 超时 60000ms']) {
    const deps = makeDeps({ reviewed: threads });
    deps.replyOne = (item) => { deps.log.push(`reply:${item.id}`); throw new Error(message); };
    const out = resolveFixedThreads(request(), deps);
    assert.equal(out.status, 'partial');
    assert.equal(out.items[0].status, 'failed');
    assert.ok(out.items[0].reason.includes(message), out.items[0].reason);
    assert.deepEqual(repliedIds(deps), ['reply:T1'], '抛错后不重试、不碰 T2');
    assert.equal(out.items[1].reason, 'stopped-after-failure');
  }
});

test('回复回执:成功项带 commentId;第二条失败时第一条保留', () => {
  const deps = makeDeps({ reviewed: [thread('T1', K1), thread('T2', K2)], receipts: { T2: { data: {} } } });
  const out = resolveFixedThreads(request(), deps);
  assert.deepEqual(out.items.map((i) => i.status), ['replied', 'failed']);
  assert.equal(out.items[0].commentId, 'reply-T1');
  assert.equal(out.repliedCount, 1);
  assert.equal(out.status, 'partial');
  assert.ok(!('resolvedCount' in out) && !('alreadyResolvedCount' in out), '不再有关闭相关的计数');
});

test('失败信息不带令牌:抛错与 errors 里的令牌原值、ghp_ 格式都被抹掉', () => {
  const saved = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'ghs_SENTINEL_TOKEN_DO_NOT_LEAK';
  try {
    const thrown = makeDeps({ reviewed: [thread('T1', K1)] });
    thrown.replyOne = () => { throw new Error(`HTTP 403 (${process.env.GH_TOKEN}) Bearer abc123def456`); };
    const viaErrors = makeDeps({ reviewed: [thread('T1', K1)], receipts: { T1: { errors: [{ message: `denied ${process.env.GH_TOKEN}` }] } } });
    for (const deps of [thrown, viaErrors]) {
      const out = resolveFixedThreads(request(), deps);
      assert.equal(out.items[0].status, 'failed');
      assert.equal(JSON.stringify(out).includes('SENTINEL'), false, JSON.stringify(out));
      assert.equal(JSON.stringify(out).includes('abc123def456'), false);
    }
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved;
  }
});

test('#185 同 key + 同 head 已回复过(盯梢还没关)→ 再跑一轮不重复回复;换 head 才再回复一条', () => {
  const replied = thread('T1', K1, { replies: [{ id: 'fx', author: { login: REVIEWER }, body: `已修复\n\n<!-- mivo-review:thread-fixed key=${K1} head=${HEAD} -->` }] });
  const same = makeDeps({ reviewed: [replied] });
  assert.equal(resolveFixedThreads(request(), same).skippedReason, 'no-candidates');
  assert.deepEqual(same.log, [], '同 head 已回复过:预筛就没有候选,不访问网络');
  const older = thread('T1', K1, { replies: [{ id: 'fx0', author: { login: REVIEWER }, body: `已修复\n\n<!-- mivo-review:thread-fixed key=${K1} head=${'c'.repeat(40)} -->` }] });
  const moved = makeDeps({ reviewed: [older] });
  const out = resolveFixedThreads(request(), moved);
  assert.equal(out.repliedCount, 1);
  assert.deepEqual(repliedIds(moved), ['reply:T1']);
});

test('预算用完 → 剩余项留给下一轮,已完成的保留', () => {
  let clock = 0;
  const deps = makeDeps({ reviewed: [thread('T1', K1), thread('T2', K2)] });
  deps.now = () => clock;
  const original = deps.replyOne;
  deps.replyOne = (item, opts) => { clock += 178_000; return original(item, opts); };
  const out = resolveFixedThreads(request(), deps);
  assert.deepEqual(out.items.map((i) => i.status), ['replied', 'skipped']);
  assert.equal(out.items[1].reason, 'budget-exhausted');
  assert.equal(out.status, 'partial');
});

// ── 契约:生产的 realDeps 写入路径 + fail-closed 假 gh ───────────────────────────────
// 假 gh 同时记录 reply 与 resolve 两种 mutation:服务器路径上只要出现 resolve,下面的零 resolve 断言就会失败。
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

// 子进程驱动:cwd 是夹具仓,用生产 realDeps(request) 拿写入依赖(replyOne),只把读上下文 / 绑定检查 / 读 thread 换成夹具,
// 再跑真实的 resolveFixedThreads。子进程里 process.env 指向假 gh,真实网络调用不可能发生。
const RUNNER_URL = pathToFileURL(fileURLToPath(new URL('./resolve-fixed-threads.mjs', import.meta.url))).href;
function runProductionRunner(fx, { reviewed, over = {} }) {
  const driver = join(fx.dir, 'driver.mjs');
  writeFileSync(driver, `import { readFileSync } from 'node:fs';
import { realDeps, resolveFixedThreads } from ${JSON.stringify(RUNNER_URL)};
const { request, reviewed } = JSON.parse(readFileSync(0, 'utf8'));
const deps = await realDeps(request);
const fixed = { ...deps,
  readContext: () => ({ history: { reviewThreads: reviewed } }),
  assertBinding: () => ({ maintainers: ['maint'] }),
  fetchThreads: () => ({ threads: JSON.parse(JSON.stringify(reviewed)), verified: true, errors: [] }) };
console.log(JSON.stringify(resolveFixedThreads(request, fixed)));
`);
  const r = spawnSync(process.execPath, [driver], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ request: request(over), reviewed }), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  return JSON.parse(r.stdout);
}
const writeCalls = (state) => state.calls.filter((c) => c !== 'read');

test('契约 SC1/SC2 生产写入路径:只发一条 reply:T1,零 resolve,回复正文含「已修复，由盯梢关闭」与 thread-fixed 标记,thread 仍未 resolve', (t) => {
  const reviewed = [thread('T1', K1), thread('T2', K2)];
  const fx = makeGhFixture({ threads: JSON.parse(JSON.stringify(reviewed)) });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const out = runProductionRunner(fx, { reviewed, over: { excludedKeys: [K2] } });
  const state = fx.read();
  // 先断言写调用:有人把写入接回共享脚本时,失败信息直接带出 resolve:T1。
  assert.deepEqual(writeCalls(state), ['reply:T1'], `服务器路径上只能有一次回复写入,不能出现 resolve;实际 ${state.calls.join(',')}`);
  assert.ok(!state.calls.some((c) => c.startsWith('resolve:') || c.startsWith('UNKNOWN')), state.calls.join(','));
  assert.deepEqual(state.threads.map((x) => x.isResolved), [false, false], '服务器不关 thread');
  assert.equal(out.status, 'completed', JSON.stringify(out));
  assert.equal(out.repliedCount, 1);
  assert.deepEqual(out.items, [{ id: 'T1', key: K1, status: 'replied', commentId: 'reply-T1' }]);
  assert.equal(state.replies.length, 1);
  assert.equal(state.replies[0].body, `本轮在提交 ${HEAD} 完成复核:本轮复核未再发现该问题(key=${K1})。已修复，由盯梢关闭；如仍有异议，可在此回复。审查运行:${RUN}。\n\n<!-- mivo-review:thread-fixed key=${K1} head=${HEAD} -->`);
  assert.ok(!state.replies[0].body.includes('<!-- review-pr:thread-triage -->'), '不再带 triage 标记');
});

test('契约 正对照:同一假 gh 下跑共享 resolve-threads.mjs 会记录 resolve:T1(证明假 gh 看得见 resolve)', (t) => {
  const reviewed = [thread('T1', K1)];
  const fx = makeGhFixture({ threads: JSON.parse(JSON.stringify(reviewed)) });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const receipt = runScript('resolve-threads.mjs', ['7', '--payload-file', '-'], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ threads: [{ id: 'T1', reply: '已处理' }] }), timeoutMs: 60_000 });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  const state = fx.read();
  assert.deepEqual(writeCalls(state), ['reply:T1', 'resolve:T1']);
  assert.equal(state.threads[0].isResolved, true);
});

test('契约 回复失败(GraphQL errors)→ 生产路径记 failed + warning,不 resolve、不重试', (t) => {
  const reviewed = [thread('T1', K1), thread('T2', K2)];
  const fx = makeGhFixture({ threads: JSON.parse(JSON.stringify(reviewed)), failReply: true });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const out = runProductionRunner(fx, { reviewed });
  assert.deepEqual(writeCalls(fx.read()), ['reply:T1'], '失败后不 resolve、不重试、不碰 T2');
  assert.equal(out.status, 'partial');
  assert.equal(out.repliedCount, 0);
  assert.deepEqual(out.items.map((i) => i.status), ['failed', 'skipped']);
  assert.ok(out.warnings.some((w) => w.startsWith(`旧 thread 修复说明回复失败(${K1}):`) && w.includes('nope')), out.warnings.join('|'));
  assert.ok(!out.warnings.some((w) => w.includes('代 resolve')), out.warnings.join('|'));
  assert.ok(existsSync(fx.dir));
});
