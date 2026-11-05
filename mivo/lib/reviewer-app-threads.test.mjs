// [MIVO-PATCH reviewer-app] 服务器侧 thread 选择器按「审查身份集合」认首帖作者,回复(thread-fixed 说明)的执行资格允许配置的审查 App。纯函数 + 注入依赖,无 GitHub 调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRulings, collectRebuttals, collectAdjudications } from './rulings.mjs';
import { collectMarkerHistory } from './convergence.mjs';
import { buildThreadResolutionPlan } from './thread-resolution.mjs';
import { resolveFixedThreads, createAssertBinding } from './resolve-fixed-threads.mjs';
import { createReviewIdentity } from '../../review-pr/scripts/reviewer-identity.mjs';

const HEAD = 'b'.repeat(40);
const OLD = 'a'.repeat(12);
const K1 = '111111111111';
const RUN = 'https://github.com/o/r/actions/runs/42';
const APP = 'praisebuild[bot]';
const identity = createReviewIdentity({ viewerLogin: APP });
const aliasIdentity = createReviewIdentity({ viewerLogin: APP, viewerAliases: ['PraiseZhu'] });
const finding = (key = K1) => `[P1] 问题\n\n<!-- mivo-finding key=${key} round=1 head=${OLD} -->`;
// GraphQL 的 Bot 登录名不带 [bot],靠 __typename 区分。
const botAuthor = { login: 'praisebuild', __typename: 'Bot' };
const thread = (id, firstAuthor, replies = [], extra = {}) => ({ id, isResolved: false, path: 'a.ts', line: 3,
  comments: [{ id: `c-${id}`, author: firstAuthor, body: finding(), url: 'https://x/1' }, ...replies], ...extra });
const ruling = (author, id = 'r1') => ({ id, author, body: '维护者裁定不改:历史行为就是这样' });

test('collectRulings:裸 login + __typename:Bot 的旧 thread 在身份集合下被选中,维护者(非 Bot)的裁定核验通过', () => {
  const t = thread('T1', botAuthor, [ruling({ login: 'maintainer', __typename: 'User' })]);
  const out = collectRulings({ threads: [t], reviewer: APP, reviewerIdentity: identity, maintainers: ['maintainer'] });
  assert.equal(out.verified.length, 1);
  assert.equal(out.verified[0].by, 'maintainer');
});

test('collectRulings:同名 User、他人开的 thread 不算审查机的;PraiseZhu 旧 thread 在别名集合下仍认', () => {
  const rep = [ruling({ login: 'maintainer' })];
  const sameNameUser = thread('T2', { login: 'praisebuild', __typename: 'User' }, rep);
  const other = thread('T3', { login: 'someone', __typename: 'User' }, rep);
  const out = collectRulings({ threads: [sameNameUser, other], reviewer: APP, reviewerIdentity: identity, maintainers: ['maintainer'] });
  assert.deepEqual(out, { verified: [], rejected: [] });
  const legacy = thread('T4', { login: 'PraiseZhu' }, rep);
  assert.equal(collectRulings({ threads: [legacy], reviewer: APP, reviewerIdentity: aliasIdentity, maintainers: ['maintainer'] }).verified.length, 1);
  assert.equal(collectRulings({ threads: [legacy], reviewer: APP, reviewerIdentity: identity, maintainers: ['maintainer'] }).verified.length, 0);
});

test('collectRulings:「维护者裁定不改」的回复作者必须是非 Bot 的维护者(名单里有同名裸 slug 也不行)', () => {
  const t = thread('T5', botAuthor, [ruling({ login: 'praisebuild', __typename: 'Bot' })]);
  const out = collectRulings({ threads: [t], reviewer: APP, reviewerIdentity: identity, maintainers: ['maintainer', 'praisebuild'] });
  assert.equal(out.verified.length, 0);
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0].reason, /Bot/);
});

test('旧调用方只传 reviewer 字符串:行为不变(人类账号、大小写不敏感)', () => {
  const t = thread('T6', { login: 'PraiseZhu' }, [ruling({ login: 'Maintainer' })]);
  assert.equal(collectRulings({ threads: [t], reviewer: 'praisezhu', maintainers: ['maintainer'] }).verified.length, 1);
  assert.equal(collectRulings({ threads: [t], reviewer: '', maintainers: ['maintainer'] }).verified.length, 0);
});

test('collectRebuttals / collectAdjudications / collectMarkerHistory 同样按身份集合认首帖', () => {
  const rebut = thread('T7', botAuthor, [{ id: 'a1', author: { login: 'author' }, body: '不成立,因为……' }]);
  assert.equal(collectRebuttals({ threads: [rebut], reviewer: APP, reviewerIdentity: identity, author: 'author' }).length, 1);
  assert.equal(collectRebuttals({ threads: [thread('T8', { login: 'praisebuild', __typename: 'User' }, rebut.comments.slice(1))], reviewer: APP, reviewerIdentity: identity, author: 'author' }).length, 0);
  const history = collectMarkerHistory({ threads: [thread('T9', botAuthor)], reviewer: APP, reviewerIdentity: identity, currentHead: 'c'.repeat(40) });
  assert.equal(history.reviewerThreads, 1);
  assert.equal(collectMarkerHistory({ threads: [thread('T9', botAuthor)], reviewer: APP, currentHead: 'c'.repeat(40) }).reviewerThreads, 1);
  const adj = collectAdjudications({ threads: [thread('T10', botAuthor)], reviewer: APP, reviewerIdentity: identity, standardVersion: 'v' });
  assert.deepEqual(adj.verified, []);
});

const ROUND = { mode: 'live', reviewed: true, reportComplete: true, sourceComplete: true, published: true, scopeMode: 'full', outcome: 'findings', finalFullOutcome: null };
const plan = (threads, reviewerIdentity, extra = {}) => buildThreadResolutionPlan({ round: ROUND, head: HEAD, reviewer: APP, reviewerIdentity, runUrl: RUN,
  reviewedThreads: threads, liveThreads: threads, threadsVerified: true, excludedKeys: [], maintainers: ['maintainer'], ...extra });

test('buildThreadResolutionPlan:Bot 首帖的旧 thread 被选中;同名 User / 他人不选;REST 与 GraphQL 的 Bot 写法不产生假变更', () => {
  assert.equal(plan([thread('T1', botAuthor)], identity).threads.length, 1);
  assert.equal(plan([thread('T2', { login: 'praisebuild', __typename: 'User' })], identity).threads.length, 0);
  assert.equal(plan([thread('T3', { login: 'someone' })], identity).threads.length, 0);
  const reviewed = [thread('T4', botAuthor)];
  const live = [thread('T4', { login: 'praisebuild[bot]', __typename: 'Bot' })];
  assert.equal(plan(reviewed, identity, { liveThreads: live }).threads.length, 1, '同一个 Bot 的两种表示不是「评论变化」');
  assert.equal(plan(reviewed, identity, { liveThreads: [thread('T4', { login: 'praisebuild', __typename: 'User' })] }).threads.length, 0, '换成同名 User 才算变化');
});

test('buildThreadResolutionPlan:维护者对这条 thread 的新裁定、新评论仍排除', () => {
  const ruled = thread('T5', botAuthor, [ruling({ login: 'maintainer' })]);
  assert.equal(plan([ruled], identity).threads.length, 0);
});

// ── 回复的执行资格 ──
const authority = { digest: 'd', members: ['maintainer'], teamMembers: [], allowlistedMembers: ['maintainer'], codeowners: { teamHandle: null } };
const BINDING = { targetRepo: 'o/r', pr: 7, head: HEAD, base: 'c'.repeat(40), baseRefName: 'main', reviewer: APP, lockToken: 'tok', authorityDigest: 'd', runUrl: RUN, mode: 'live' };
function fakeLib({ viewer = APP, metaPatch = {}, reviewerApps = [APP], digest = 'd' } = {}) {
  const viewerIdentity = createReviewIdentity({ viewerLogin: viewer });
  return {
    assertActiveReviewLock: () => {},
    readReviewIdentityOrEmpty: () => viewerIdentity,
    sameReviewActor: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
    fetchMaintainerAuthority: () => ({ ...authority, digest }),
    ghJson: () => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: 'c'.repeat(40), baseRefName: 'main', author: { login: 'outsider' }, ...metaPatch }),
    loadRules: () => ({ reviewerApps }),
    evaluateMaintainerApprovalPolicy: null,
  };
}
async function realLib(options) {
  const { evaluateMaintainerApprovalPolicy, sameReviewActor, normalizeReviewActor } = await import('../../review-pr/scripts/lib.mjs');
  return { ...fakeLib(options), evaluateMaintainerApprovalPolicy, sameReviewActor, normalizeReviewActor };
}

test('assertBinding:配置的审查 App 是写账号且绑定一致 → 通过;未配置的 bot / 非维护者人类 → 拒绝', async () => {
  const ok = createAssertBinding({ lib: await realLib(), owner: 'o', repo: 'r' });
  assert.deepEqual(ok(BINDING).maintainers, ['maintainer']);
  const human = createAssertBinding({ lib: await realLib({ viewer: 'maintainer' }), owner: 'o', repo: 'r' });
  assert.deepEqual(human({ ...BINDING, reviewer: 'maintainer' }).maintainers, ['maintainer']);
  for (const options of [{ reviewerApps: [] }, { viewer: 'outsider2' }]) {
    const bad = createAssertBinding({ lib: await realLib(options), owner: 'o', repo: 'r' });
    assert.throws(() => bad({ ...BINDING, reviewer: options.viewer ?? APP }), /维护者名单已变化或写账号既不是维护者也不是配置的审查 App/);
  }
});

test('assertBinding:写账号与绑定不一致、head/base/authority 漂移 → 拒绝,信息含期望与实际', async () => {
  const lib = await realLib();
  const driftLib = await realLib({ metaPatch: { headRefOid: 'd'.repeat(40) } });
  const digestLib = await realLib({ digest: 'other' });
  assert.throws(() => createAssertBinding({ lib, owner: 'o', repo: 'r' })({ ...BINDING, reviewer: 'someone-else' }), /当前写账号不是本轮审查账号.*someone-else.*praisebuild\[bot\]/);
  assert.throws(() => createAssertBinding({ lib: driftLib, owner: 'o', repo: 'r' })(BINDING), /head.*d{12}.*b{12}|期望.*实际/);
  assert.throws(() => createAssertBinding({ lib: digestLib, owner: 'o', repo: 'r' })(BINDING), /维护者名单已变化/);
  assert.throws(() => createAssertBinding({ lib, owner: 'o', repo: 'r' })({ ...BINDING, pr: 0 }), /缺少绑定字段 pr/);
});

// ── 回复回执:成功 / 失败 ──
const replyReceipt = (id) => ({ data: { addPullRequestReviewThreadReply: { comment: { id } } } });
function deps(replyOne) {
  const reviewed = [thread('T1', botAuthor)];
  return { readContext: () => ({ history: { reviewThreads: reviewed } }), assertBinding: () => ({ maintainers: ['maintainer'] }),
    fetchThreads: () => ({ threads: reviewed, verified: true, errors: [] }), replyOne };
}
const request = { binding: BINDING, round: ROUND, contextFile: 'c.json', excludedKeys: [] };
const withIdentity = { ...request, binding: { ...BINDING, reviewerIdentity: identity } };

test('Bot 首帖旧 thread:回复成功 → replied,只计回复条数', () => {
  const out = resolveFixedThreads(withIdentity, deps(() => replyReceipt('reply-1')));
  assert.equal(out.status, 'completed');
  assert.equal(out.repliedCount, 1);
  assert.deepEqual(out.items, [{ id: 'T1', key: K1, status: 'replied', commentId: 'reply-1' }]);
});

test('403 与缺 comment id:回复失败写明原因,不含令牌,也没有「代 resolve」字样', () => {
  const saved = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'ghs_SENTINEL_TOKEN_DO_NOT_LEAK';
  try {
    const forbidden = resolveFixedThreads(withIdentity, deps(() => { throw new Error(`GraphQL mutation 未完成:HTTP 403: Resource not accessible (${process.env.GH_TOKEN})`); }));
    assert.equal(forbidden.items[0].status, 'failed');
    assert.match(forbidden.items[0].reason, /HTTP 403/);
    assert.equal(forbidden.warnings[0], `旧 thread 修复说明回复失败(${K1}):${forbidden.items[0].reason}`);
    const noId = resolveFixedThreads(withIdentity, deps(() => ({ data: { addPullRequestReviewThreadReply: { comment: {} } } })));
    assert.equal(noId.items[0].status, 'failed');
    assert.match(noId.items[0].reason, /回复未返回 comment id/);
    for (const out of [forbidden, noId]) {
      assert.equal(out.repliedCount, 0);
      assert.equal(JSON.stringify(out).includes('ghs_SENTINEL'), false);
      assert.equal(JSON.stringify(out).includes('代 resolve'), false);
    }
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved;
  }
});
