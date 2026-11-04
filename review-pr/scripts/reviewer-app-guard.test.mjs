// [MIVO-PATCH reviewer-app] 写前 guard 对审查 App 只开 purpose='review' 的两个精确端点;其它目的、其它端点一律拒绝。
// 通过依赖注入离线测试,没有 GitHub 调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrWriteGuard } from './pr-write-guard.mjs';
import { evaluateMaintainerApprovalPolicy, createReviewIdentity, normalizeReviewActor } from './lib.mjs';

const head = 'a'.repeat(40);
const digest = `sha256:${'d'.repeat(64)}`;
const SENTINEL = 'ghs_SENTINEL_TOKEN_DO_NOT_LEAK';
const authority = { members: ['maintainer'], teamMembers: [], allowlistedMembers: ['maintainer'], codeowners: { teamHandle: null }, digest };

function setup({ viewer = 'praisebuild[bot]', author = 'outsider', reviewerApps = ['praisebuild[bot]'], purpose = 'review', metaPatch = {}, aliases = [] } = {}) {
  const calls = [];
  const guard = createPrWriteGuard({ owner: 'o', repo: 'r', pr: 1, lockToken: 'lock', expectedHead: head, expectedAuthorityDigest: digest,
    expectedViewer: viewer, purpose, reviewerApps }, {
    assertActiveReviewLock: () => {},
    readReviewIdentity: () => createReviewIdentity({ viewerLogin: viewer, viewerAliases: aliases }),
    fetchMaintainerAuthority: () => authority,
    ghJson: () => ({ state: 'OPEN', isDraft: false, headRefOid: head, author: { login: author }, updatedAt: '2026-11-04T00:00:00Z', ...metaPatch }),
    gh: (args, options) => { calls.push({ args, options }); return { ok: true, stdout: '{}', stderr: '' }; },
    recordSelfWrite: () => {},
    isSignoffExemptAuthor: () => false,
  });
  return { guard, calls };
}
const REVIEWS = ['api', '--method', 'POST', 'repos/o/r/pulls/1/reviews', '--input', '-'];
const COMMENTS = ['api', '--method', 'POST', 'repos/o/r/pulls/1/comments', '--input', '-'];

test('审查 App + purpose=review:只能 POST 当前 PR 的 reviews / comments,且不回落到别的凭证', () => {
  for (const args of [REVIEWS, COMMENTS]) {
    const { guard, calls } = setup();
    guard(args, { input: '{}' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.noCredFallback, true);
  }
});

test('审查 App + purpose=review:其它端点/方法/PR 号/GraphQL/命令都拒绝,gh 一次都没调', () => {
  const bad = [
    ['api', '--method', 'POST', 'repos/o/r/issues/1/comments', '--input', '-'],
    ['api', '--method', 'POST', 'repos/o/r/issues/1/labels', '-f', 'labels[]=x'],
    ['api', '--method', 'POST', 'repos/o/r/pulls/2/reviews', '--input', '-'],
    ['api', '--method', 'POST', 'repos/other/r/pulls/1/reviews', '--input', '-'],
    ['api', '--method', 'DELETE', 'repos/o/r/pulls/1/reviews', '--input', '-'],
    ['api', '--method', 'PUT', 'repos/o/r/pulls/1/merge'],
    ['api', 'graphql', '--input', '-'],
    ['pr', 'merge', '1', '--repo', 'o/r', '--squash'],
    ['pr', 'comment', '1', '--repo', 'o/r', '--body-file', '-'],
    ['issue', 'close', '5', '--repo', 'o/r'],
  ];
  for (const args of bad) {
    const { guard, calls } = setup();
    assert.throws(() => guard(args, { input: '{}' }), /purpose=review|不允许/, args.join(' '));
    assert.equal(calls.length, 0, args.join(' '));
  }
});

test('审查 App 在其它目的(默认/hold/protected-hold/signoff-notice)下仍被拒绝', () => {
  for (const purpose of [null, 'hold', 'protected-hold', 'signoff-notice']) {
    const { guard, calls } = setup({ purpose });
    assert.throws(() => guard(REVIEWS, { input: '{}' }), /权限不足/, String(purpose));
    assert.equal(calls.length, 0);
  }
});

test('未配置的 bot、同名普通用户:purpose=review 也拒绝', () => {
  for (const options of [{ reviewerApps: [] }, { viewer: 'praisebuild' }, { viewer: 'other-app[bot]' }]) {
    const { guard, calls } = setup(options);
    assert.throws(() => guard(REVIEWS, { input: '{}' }), /权限不足/);
    assert.equal(calls.length, 0);
  }
});

test('漂移:head / viewer 变化拒绝,错误信息含期望与实际值,不含令牌', () => {
  const { guard, calls } = setup({ metaPatch: { headRefOid: 'c'.repeat(40) } });
  process.env.GH_TOKEN = SENTINEL;
  try {
    assert.throws(() => guard(REVIEWS, { input: '{}' }), (error) => {
      assert.match(error.message, new RegExp(head));
      assert.match(error.message, /c{40}/);
      assert.equal(error.message.includes(SENTINEL), false);
      return true;
    });
  } finally { delete process.env.GH_TOKEN; }
  assert.equal(calls.length, 0);
});

test('真人维护者的原路径不变:任何目的、任何端点照旧放行', () => {
  for (const purpose of [null, 'hold', 'review']) {
    const { guard, calls } = setup({ viewer: 'maintainer', purpose });
    guard(['api', '--method', 'POST', 'repos/o/r/issues/1/comments', '--input', '-'], { input: '{}' });
    assert.equal(calls.length, 1);
  }
});

test('作者在审查身份集合内的自批问题由调用方 COMMENT 处理;guard 对 App 仍只放行 review 端点', () => {
  const policy = evaluateMaintainerApprovalPolicy({ authorLogin: 'maintainer', viewerLogin: 'praisebuild[bot]', authority,
    reviewerIdentity: createReviewIdentity({ viewerLogin: 'praisebuild[bot]', viewerAliases: ['maintainer'] }), reviewerApps: ['praisebuild[bot]'] });
  assert.equal(policy.viewerCanApprove, false);
  assert.equal(normalizeReviewActor('praisebuild[bot]').isBot, true);
});
