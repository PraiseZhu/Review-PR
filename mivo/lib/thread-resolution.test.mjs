// thread-resolution.mjs 的单测:选择器只看输入,覆盖 #115 的 SC1/SC2/SC3/SC5,以及 #185 的回复文案与 thread-fixed 去重。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThreadResolutionPlan, renderResolveReply, renderThreadFixedMarker, TRIAGE_MARKER } from './thread-resolution.mjs';
import { createReviewIdentity } from '../../review-pr/scripts/reviewer-identity.mjs';

const HEAD = 'b'.repeat(40);
const OLD = 'a'.repeat(12);
const REVIEWER = 'Review-Bot';
const RUN = 'https://github.com/PraiseZhu/Review-PR/actions/runs/123456';
const K1 = '111111111111';
const K2 = '222222222222';
const K3 = '333333333333';
const marker = (key, head = OLD) => `<!-- mivo-finding key=${key} round=1 head=${head} -->`;
const thread = (id, key, patch = {}) => ({
  id, isResolved: false, path: 'src/a.ts',
  comments: [{ id: `c-${id}`, author: { login: REVIEWER }, body: `[P1] 标题 ${key}\n\n${patch.marker ?? marker(key, patch.head)}` }, ...(patch.replies ?? [])],
  ...(patch.thread ?? {}),
});
const ROUND = { mode: 'live', reviewed: true, reportComplete: true, sourceComplete: true, published: true, scopeMode: 'full', outcome: 'findings', finalFullOutcome: null };
const plan = (threads, over = {}) => buildThreadResolutionPlan({
  round: ROUND, head: HEAD, reviewer: REVIEWER.toLowerCase(), runUrl: RUN, reviewedThreads: threads, liveThreads: threads,
  threadsVerified: true, excludedKeys: [], maintainers: ['maint'], ...over,
});

test('SC1 旧 key 本轮没再报 → 进清单;本轮又报了 → 不进', () => {
  const threads = [thread('T1', K1), thread('T2', K2)];
  const result = plan(threads, { excludedKeys: [K2] });
  assert.deepEqual(result.threads.map((t) => t.id), ['T1']);
  assert.equal(result.threads[0].key, K1);
  assert.equal(result.threads[0].oldHead, OLD);
});

test('SC1 同 key 多个 thread:key 被排除则全部排除', () => {
  const result = plan([thread('T1', K1), thread('T2', K1)], { excludedKeys: [K1] });
  assert.deepEqual(result.threads, []);
});

test('SC2 非审查账号 / 无 marker / 坏 marker / 当前 head 上发的 → 不进', () => {
  const other = thread('T1', K1);
  other.comments[0].author.login = 'someone-else';
  const noMarker = thread('T2', K2, { marker: '' });
  const badMarker = thread('T3', K3, { marker: '<!-- mivo-finding key=zzz round=1 head=aaa -->' });
  const sameHead = thread('T4', K1, { head: HEAD.slice(0, 12) });
  const fullHead = thread('T5', K2, { head: HEAD });
  const shortHead = thread('T6', K3, { head: HEAD.slice(0, 7) });
  assert.deepEqual(plan([other, noMarker, badMarker, sameHead, fullHead, shortHead]).threads, []);
});

test('SC2 审查账号大小写不同仍识别;marker 只在回复里、已 resolve、状态不明 → 不进', () => {
  const ok = thread('T1', K1);
  ok.comments[0].author.login = 'REVIEW-bot';
  const inReply = thread('T2', K2, { marker: '', replies: [{ id: 'r', author: { login: REVIEWER }, body: marker(K2) }] });
  const resolved = thread('T3', K3, { thread: { isResolved: true } });
  const unknown = thread('T4', K3, { thread: { isResolved: undefined } });
  assert.deepEqual(plan([ok, inReply, resolved, unknown]).threads.map((t) => t.id), ['T1']);
});

test('SC2 首条评论缺 id、重复 thread id → 不进', () => {
  const noId = thread('T1', K1);
  delete noId.comments[0].id;
  assert.deepEqual(plan([noId, thread('T2', K2), thread('T2', K2)]).threads, []);
});

test('SC3 round 条件不满足 → 清单为空', () => {
  const threads = [thread('T1', K1)];
  const cases = [
    { mode: 'dry-run' }, { mode: 'sandbox' }, { scopeMode: 'reuse' }, { scopeMode: undefined }, { outcome: 'error' }, { outcome: 'state-changed' },
    { outcome: 'approval-pending' }, { reportComplete: false }, { reviewed: false }, { sourceComplete: false }, { published: false },
    { finalFullOutcome: 'pending-budget' }, { finalFullOutcome: 'error' },
  ];
  for (const patch of cases) {
    const result = plan(threads, { round: { ...ROUND, ...patch } });
    assert.deepEqual(result.threads, [], JSON.stringify(patch));
    assert.ok(result.skippedReason, JSON.stringify(patch));
  }
});

test('SC3 完整增量(含有其他阻断、advisory 的 merge-blocked)照常选', () => {
  for (const patch of [{ scopeMode: 'incremental' }, { outcome: 'merge-blocked' }, { outcome: 'format' }, { outcome: 'review-only' }, { finalFullOutcome: 'skipped-fix-round' }]) {
    assert.equal(plan([thread('T1', K1)], { round: { ...ROUND, ...patch } }).threads.length, 1, JSON.stringify(patch));
  }
});

test('SC3 输入缺失 / 非法 / 线程快照没核实 → 清单为空', () => {
  const threads = [thread('T1', K1)];
  for (const patch of [{ head: 'abc' }, { reviewer: '' }, { runUrl: 'http://x/y' }, { runUrl: 'https://github.com/o/r/pull/1' }, { threadsVerified: false },
    { threadsVerified: undefined }, { excludedKeys: undefined }, { excludedKeys: ['short'] }, { maintainers: undefined }, { liveThreads: undefined }]) {
    assert.deepEqual(plan(threads, patch).threads, [], JSON.stringify(patch));
  }
});

test('SC5 key 在 deferred / preexisting / ruledKept / 核对员推翻等排除集合里 → 不 resolve', () => {
  const threads = [thread('T1', K1), thread('T2', K2), thread('T3', K3)];
  assert.deepEqual(plan(threads, { excludedKeys: [K1, K2, K3] }).threads, []);
  assert.deepEqual(plan(threads, { excludedKeys: [K2] }).threads.map((t) => t.id), ['T1', 'T3']);
});

test('SC5 维护者裁定不改:key 不在 excludedKeys 里,模型服从裁定没再报,仍按 live thread 上的裁定排除', () => {
  const ruled = thread('T1', K1, { replies: [{ id: 'r1', author: { login: 'maint' }, body: '维护者裁定不改:产品意图' }] });
  // 同 key 的另一条 thread(无裁定)也要被排除
  const sibling = thread('T2', K1);
  const free = thread('T3', K2);
  assert.deepEqual(plan([ruled, sibling, free]).threads.map((t) => t.id), ['T3']);
  // 非维护者的裁定不算
  const fake = thread('T4', K3, { replies: [{ id: 'r2', author: { login: 'rando' }, body: '维护者裁定不改:x' }] });
  assert.deepEqual(plan([fake]).threads.map((t) => t.id), ['T4']);
});

test('SC5 裁定在已 resolve 的同 key thread 上也排除', () => {
  const ruledResolved = thread('T1', K1, { thread: { isResolved: true }, replies: [{ id: 'r1', author: { login: 'maint' }, body: '维护者裁定不改:产品意图' }] });
  assert.deepEqual(plan([ruledResolved, thread('T2', K1)]).threads, []);
});

test('prepare 之后 thread 内容变了(新回复 / 正文被改 / 新出现 / 已被 resolve) → 不选', () => {
  const reviewed = [thread('T1', K1), thread('T2', K2), thread('T3', K3)];
  const live = [
    thread('T1', K1, { replies: [{ id: 'new', author: { login: 'author' }, body: '我改好了' }] }),
    { ...thread('T2', K2), comments: [{ ...thread('T2', K2).comments[0], body: '[P1] 被改过' }] },
    thread('T4', K3),
  ];
  assert.deepEqual(plan(reviewed, { liveThreads: live }).threads, []);
  assert.deepEqual(plan(reviewed, { liveThreads: [{ ...thread('T1', K1), isResolved: true }] }).threads, []);
  assert.deepEqual(plan(reviewed, { liveThreads: [thread('T1', K1)] }).threads.map((t) => t.id), ['T1']);
});

test('已带 triage 标记(被代 resolve 过又被 unresolve)→ 不选', () => {
  const reopened = thread('T1', K1, { replies: [{ id: 'r', author: { login: REVIEWER }, body: `回复\n\n${TRIAGE_MARKER}` }] });
  assert.deepEqual(plan([reopened]).threads, []);
});

test('comments 两种形状({nodes} 与数组)都识别;入参不被修改', () => {
  const asNodes = { ...thread('T1', K1), comments: { nodes: thread('T1', K1).comments } };
  const threads = [asNodes];
  const snapshot = JSON.stringify(threads);
  assert.equal(plan(threads).threads.length, 1);
  assert.equal(JSON.stringify(threads), snapshot);
});

test('SC4 回复含完整 head、run 链接、key,且不含 triage marker', () => {
  const [item] = plan([thread('T1', K1)]).threads;
  assert.equal(item.reply, renderResolveReply({ head: HEAD, runUrl: RUN, key: K1 }));
  for (const part of [HEAD, RUN, K1]) assert.ok(item.reply.includes(part));
  assert.ok(!item.reply.includes(TRIAGE_MARKER));
});

// ── #185:只回复、不关闭;回复末尾带 thread-fixed 标记 ──
const FIXED = (key, head = HEAD) => `<!-- mivo-review:thread-fixed key=${key} head=${head} -->`;
const fixedReply = (key, head = HEAD, author = { login: REVIEWER }) => ({ id: `fx-${key}-${head.slice(0, 4)}`, author, body: `已修复,由盯梢关闭\n\n${FIXED(key, head)}` });

test('#185 SC2 回复正文逐字:人话「已修复，由盯梢关闭」、完整 head、run 链接,末尾恰是 thread-fixed 标记', () => {
  const [item] = plan([thread('T1', K1)]).threads;
  assert.equal(item.reply, `本轮在提交 ${HEAD} 完成复核:本轮复核未再发现该问题(key=${K1})。已修复，由盯梢关闭；如仍有异议，可在此回复。审查运行:${RUN}。\n\n${FIXED(K1)}`);
  assert.ok(item.reply.endsWith(FIXED(K1)), '标记必须在末尾');
  assert.equal(item.reply.match(/mivo-review:thread-fixed/g).length, 1);
  assert.ok(!item.reply.includes('resolve'), '不再宣称由审查机代为 resolve');
  assert.equal(renderThreadFixedMarker({ key: K1, head: HEAD }), FIXED(K1));
});

test('#185 同 key + 同完整 head 审查身份已回复过 → 不重复选;换了 head 才再选', () => {
  const done = thread('T1', K1, { replies: [fixedReply(K1)] });
  assert.deepEqual(plan([done]).threads, []);
  const older = thread('T2', K1, { replies: [fixedReply(K1, 'c'.repeat(40))] });
  assert.deepEqual(plan([older]).threads.map((t) => t.id), ['T2'], '旧 head 的 thread-fixed 不阻止本 head 回复');
});

test('#185 thread-fixed 去重只认审查身份、精确 key 与完整 head', () => {
  const stranger = thread('T1', K1, { replies: [fixedReply(K1, HEAD, { login: 'someone-else' })] });
  const wrongKey = thread('T2', K2, { replies: [fixedReply(K1)] });
  const shortHead = thread('T3', K3, { replies: [{ id: 'sh', author: { login: REVIEWER }, body: `x\n\n<!-- mivo-review:thread-fixed key=${K3} head=${HEAD.slice(0, 12)} -->` }] });
  const garbled = thread('T4', K1, { replies: [{ id: 'g', author: { login: REVIEWER }, body: `<!-- mivo-review:thread-fixed key=${K1} head=${HEAD.slice(0, 39)} -->` }] });
  assert.deepEqual(plan([stranger, wrongKey, shortHead, garbled]).threads.map((t) => t.id), ['T1', 'T2', 'T3', 'T4']);
});

test('#185 thread-fixed 去重:审查身份别名、Bot 与同名 User 区分', () => {
  const identity = createReviewIdentity({ viewerLogin: 'praisebuild[bot]', viewerAliases: ['PraiseZhu'] });
  const bot = (patch) => ({ ...thread('T1', K1, patch), comments: [{ id: 'c-T1', author: { login: 'praisebuild', __typename: 'Bot' }, body: `[P1] x\n\n${marker(K1)}` }, ...(patch.replies ?? [])] });
  const run = (threads) => plan(threads, { reviewer: 'praisebuild[bot]', reviewerIdentity: identity });
  assert.deepEqual(run([bot({ replies: [fixedReply(K1, HEAD, { login: 'praisebuild', __typename: 'Bot' })] })]).threads, [], 'GraphQL Bot 写法');
  assert.deepEqual(run([bot({ replies: [fixedReply(K1, HEAD, { login: 'praisebuild[bot]', __typename: 'Bot' })] })]).threads, [], 'REST Bot 写法');
  assert.deepEqual(run([bot({ replies: [fixedReply(K1, HEAD, { login: 'PraiseZhu' })] })]).threads, [], '旧账号别名');
  assert.equal(run([bot({ replies: [fixedReply(K1, HEAD, { login: 'praisebuild', __typename: 'User' })] })]).threads.length, 1, '同名 User 不算审查机');
});

test('#185 已有同 head thread-fixed 后又有人回复:不补发;triage 标记仍永久跳过,即使换 head', () => {
  const objected = thread('T1', K1, { replies: [fixedReply(K1), { id: 'obj', author: { login: 'author' }, body: '我不同意' }] });
  assert.deepEqual(plan([objected]).threads, []);
  const triaged = thread('T2', K2, { replies: [fixedReply(K2, 'c'.repeat(40)), { id: 'tr', author: { login: REVIEWER }, body: `回复\n\n${TRIAGE_MARKER}` }] });
  assert.deepEqual(plan([triaged]).threads, []);
});

test('#185 thread-fixed 去重对 {nodes} 形状同样生效;每个 thread 各自去重;入参不被修改', () => {
  const done = thread('T1', K1, { replies: [fixedReply(K1)] });
  const asNodes = { ...done, comments: { nodes: done.comments } };
  const fresh = thread('T2', K1);
  const threads = [asNodes, fresh];
  const snapshot = JSON.stringify(threads);
  assert.deepEqual(plan(threads).threads.map((t) => t.id), ['T2'], '同 key 的另一个 thread 不受影响');
  assert.equal(JSON.stringify(threads), snapshot);
});
