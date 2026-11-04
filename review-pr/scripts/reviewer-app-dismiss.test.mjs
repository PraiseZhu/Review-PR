// [MIVO-PATCH reviewer-app] 审查 App 自己发出的 REQUEST_CHANGES 的清理:资格判断与单条 dismissal 写入。纯函数 + 注入 gh,无 GitHub 调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOwnReviewDismissal } from './lib.mjs';
import { createReviewIdentity } from './reviewer-identity.mjs';
import { putDismissal } from './dismiss-review.mjs';
import { scrubSecrets } from './secret-scrub.mjs';

const head = 'a'.repeat(40);
const APP = 'praisebuild[bot]';
const appIdentity = createReviewIdentity({ viewerLogin: APP });
const aliasIdentity = createReviewIdentity({ viewerLogin: APP, viewerAliases: ['PraiseZhu'] });
const cr = (id, login, type, at = '2026-11-03T00:00:00Z') => ({ id, state: 'CHANGES_REQUESTED', user: { login, type }, submitted_at: at, submittedAt: at, commit_id: head });
const base = (patch = {}) => ({ reviewClean: true, state: 'OPEN', mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED',
  viewerLogin: APP, reviews: [cr(11, APP, 'Bot')], unresolvedCount: 0, threadsVerified: true, expectedHead: head, actualHead: head, ...patch });

test('非维护者作者 + 没有 reviewerApp 资格:仍按旧规则拒绝(回归)', () => {
  const r = evaluateOwnReviewDismissal({ ...base(), approvalExempt: false, reviewerIdentity: appIdentity });
  assert.equal(r.available, false);
  assert.match(r.failedChecks.join(';'), /作者不在最终维护者集合中/);
});

test('reviewerApp 资格:App 自己的 CR 可撤,即使作者不是维护者,且不要求 BLOCKED / reviewDecision 聚合', () => {
  const r = evaluateOwnReviewDismissal({ ...base({ mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED' }), approvalExempt: false, reviewerApp: true, reviewerIdentity: appIdentity });
  assert.equal(r.available, true, r.failedChecks.join(';'));
  assert.deepEqual(r.reviewIds, [11]);
});

test('reviewerApp 资格:仍要求 review-clean、threads 全 resolve、head 一致', () => {
  for (const [patch, pattern] of [
    [{ reviewClean: false }, /review-clean/], [{ unresolvedCount: 2 }, /未 resolve/], [{ actualHead: 'c'.repeat(40) }, /head 已变化/],
    [{ threadsVerified: false }, /未完整验证/], [{ state: 'CLOSED' }, /非 OPEN/],
  ]) {
    const r = evaluateOwnReviewDismissal({ ...base(patch), approvalExempt: false, reviewerApp: true, reviewerIdentity: appIdentity });
    assert.equal(r.available, false);
    assert.match(r.failedChecks.join(';'), pattern);
  }
});

test('reviewerApp 资格:只清当前实际 App 的 CR;别名里 PraiseZhu 的人工 CR 一律挡住,不被顺手撤', () => {
  const reviews = [cr(11, APP, 'Bot', '2026-11-03T00:00:00Z'), cr(12, 'PraiseZhu', 'User', '2026-11-03T01:00:00Z')];
  const r = evaluateOwnReviewDismissal({ ...base({ reviews }), approvalExempt: false, reviewerApp: true, reviewerIdentity: aliasIdentity });
  assert.equal(r.available, false);
  assert.match(r.failedChecks.join(';'), /别人|其它身份/);
  assert.equal(r.reviewIds.includes(12), false);
  // 他人 CR 同样挡住
  const other = evaluateOwnReviewDismissal({ ...base({ reviews: [cr(11, APP, 'Bot'), cr(13, 'someone', 'User', '2026-11-03T02:00:00Z')] }), approvalExempt: false, reviewerApp: true, reviewerIdentity: appIdentity });
  assert.equal(other.available, false);
});

test('PraiseZhu 旧 CR 的既有行为不变:approvalExempt 路径下别名集合内的 CR 照旧可撤', () => {
  const r = evaluateOwnReviewDismissal({ ...base({ viewerLogin: 'PraiseZhu', reviews: [cr(12, 'PraiseZhu', 'User')] }), approvalExempt: true, reviewerIdentity: createReviewIdentity({ viewerLogin: 'PraiseZhu' }) });
  assert.equal(r.available, true, r.failedChecks.join(';'));
  assert.deepEqual(r.reviewIds, [12]);
});

const fakeGh = (script) => { const calls = []; const fn = (args, options) => { calls.push({ args, options }); return script(args, options, calls.length); }; fn.calls = calls; return fn; };
const PUT = (args) => args.includes('PUT');

test('putDismissal 成功:PUT dismissals 一次,noCredFallback', () => {
  const gh = fakeGh(() => ({ ok: true, stdout: '{"id":11,"state":"DISMISSED"}', stderr: '' }));
  const r = putDismissal({ slug: 'o/r', pr: 1, reviewId: 11, message: 'm', ghFn: gh });
  assert.equal(r.status, 'dismissed');
  assert.deepEqual(gh.calls[0].args.slice(0, 4), ['api', '--method', 'PUT', 'repos/o/r/pulls/1/reviews/11/dismissals']);
  assert.equal(gh.calls[0].options.noCredFallback, true);
  assert.equal(gh.calls.length, 1);
});

test('putDismissal 403:失败,错误含期望与实际,令牌被抹掉,不重试不换凭证', () => {
  process.env.GH_TOKEN = 'ghs_SENTINEL_TOKEN_DO_NOT_LEAK';
  try {
    const gh = fakeGh(() => ({ ok: false, stdout: '', stderr: `HTTP 403: Resource not accessible by integration (${process.env.GH_TOKEN})` }));
    const r = putDismissal({ slug: 'o/r', pr: 1, reviewId: 11, message: 'm', ghFn: gh });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /期望 HTTP 2xx 或 review 已是 DISMISSED,实际 HTTP 403/);
    assert.equal(r.error.includes('ghs_SENTINEL'), false);
    assert.equal(gh.calls.length, 1, '403 不回读、不重试');
  } finally { delete process.env.GH_TOKEN; }
});

test('putDismissal 422:回读确认 DISMISSED 才算幂等成功;回读不是 DISMISSED 仍失败', () => {
  const dismissed = fakeGh((args) => PUT(args) ? { ok: false, stdout: '', stderr: 'HTTP 422 Unprocessable Entity' }
    : { ok: true, stdout: '{"id":11,"state":"DISMISSED"}', stderr: '' });
  assert.equal(putDismissal({ slug: 'o/r', pr: 1, reviewId: 11, message: 'm', ghFn: dismissed }).status, 'already-dismissed');
  assert.deepEqual(dismissed.calls[1].args.slice(0, 3), ['api', '--method', 'GET']);
  assert.ok(dismissed.calls[1].args.includes('repos/o/r/pulls/1/reviews/11'));
  const still = fakeGh((args) => PUT(args) ? { ok: false, stdout: '', stderr: 'HTTP 422 Unprocessable Entity' }
    : { ok: true, stdout: '{"id":11,"state":"CHANGES_REQUESTED"}', stderr: '' });
  const r = putDismissal({ slug: 'o/r', pr: 1, reviewId: 11, message: 'm', ghFn: still });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /实际 HTTP 422.*回读 state=CHANGES_REQUESTED/);
});

test('scrubSecrets:抹掉环境令牌原值、gh*_ 格式与 Bearer', () => {
  process.env.GH_TOKEN = 'plain-token-value-123';
  try {
    const text = scrubSecrets('x plain-token-value-123 ghp_abcdefghijklmnopqrstuvwx Bearer abc.def');
    assert.equal(/plain-token|ghp_abc|abc\.def/.test(text), false);
  } finally { delete process.env.GH_TOKEN; }
});
