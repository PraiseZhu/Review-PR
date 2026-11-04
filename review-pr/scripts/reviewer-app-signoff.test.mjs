// [MIVO-PATCH reviewer-app] 审查 App 的 review / 评论不构成任何维护者确认:不进独立 Approve 判断,也不能当签核放行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignoffReleaseEvents, selectTrustedSignoffReleases, evaluateMaintainerReview } from './lib.mjs';
import { existingMaintainerApprovalReceipt } from './approval-state.mjs';

const head = 'a'.repeat(40);
const reviewerApps = ['praisebuild[bot]'];
const marker = (by) => `<!-- review-pr:signoff-release gates=product by=${by} -->`;
const comment = (by, author) => ({ body: marker(by), createdAt: '2026-11-04T00:00:00Z', author });

test('release 事件带出评论作者类型', () => {
  const [event] = parseSignoffReleaseEvents([comment('maintainer', { login: 'maintainer', __typename: 'User' })]);
  assert.equal(event.commentAuthor, 'maintainer');
  assert.equal(event.commentAuthorType, 'User');
  const [legacy] = parseSignoffReleaseEvents([{ body: marker('maintainer'), createdAt: 't', author: { login: 'maintainer' } }]);
  assert.equal(legacy.commentAuthorType, '');
});

test('signoff 放行:bot 评论作者、by 是 bot(两种写法)都不可信,即使名单里有同名裸 slug', () => {
  const maintainers = ['maintainer', 'praisebuild', 'praisebuild[bot]'];
  const cases = [
    comment('praisebuild[bot]', { login: 'praisebuild[bot]', __typename: 'Bot' }),
    comment('praisebuild', { login: 'praisebuild', __typename: 'Bot' }),
    comment('praisebuild', { login: 'praisebuild', __typename: 'User' }), // 与审查 App 同 slug,按配置也不接受
    comment('maintainer', { login: 'maintainer', __typename: 'Bot' }), // 作者类型是 Bot,哪怕 login 在名单里
  ];
  for (const item of cases) {
    const { trusted, untrusted } = selectTrustedSignoffReleases(parseSignoffReleaseEvents([item]), maintainers, reviewerApps);
    assert.equal(trusted.size, 0, JSON.stringify(item.author));
    assert.equal(untrusted.length, 1);
  }
});

test('signoff 放行:真人维护者、旧式无类型评论照旧可信(回归)', () => {
  for (const author of [{ login: 'maintainer', __typename: 'User' }, { login: 'maintainer' }]) {
    const { trusted } = selectTrustedSignoffReleases(parseSignoffReleaseEvents([comment('maintainer', author)]), ['maintainer'], reviewerApps);
    assert.equal(trusted.size, 1, JSON.stringify(author));
  }
  // 没传 reviewerApps(旧调用)也照旧。
  const { trusted } = selectTrustedSignoffReleases(parseSignoffReleaseEvents([comment('maintainer', { login: 'maintainer' })]), ['maintainer']);
  assert.equal(trusted.size, 1);
});

test('维护者 review 判断:Bot 的 Approve/CR 不进历史,不形成放行', () => {
  const mk = (extra) => evaluateMaintainerReview({
    reviews: [{ login: 'maintainer', state: 'APPROVED', at: '2026-11-04T00:00:00Z', ...extra }],
    maintainers: ['maintainer'], authorLogin: 'outsider' });
  assert.equal(mk({}).released?.via, 'github-approve'); // 真人:不变
  assert.equal(mk({ author: { login: 'maintainer', __typename: 'Bot' } }).released, null);
  assert.equal(mk({ user: { login: 'maintainer', type: 'Bot' } }).released, null);
});

test('独立维护者 Approve 回执:Bot 的 Approve(即使 login 在维护者名单里)不算', () => {
  const review = (user) => ({ id: 5, state: 'APPROVED', commit_id: head, user, submitted_at: '2026-11-04T00:00:00Z' });
  const options = { author: 'outsider', maintainers: ['maintainer'], reviewDecision: 'APPROVED', head };
  assert.ok(existingMaintainerApprovalReceipt(review({ login: 'maintainer', type: 'User' }), options));
  assert.equal(existingMaintainerApprovalReceipt(review({ login: 'maintainer', type: 'Bot' }), options), null);
  assert.equal(existingMaintainerApprovalReceipt(review({ login: 'maintainer[bot]', type: 'Bot' }), { ...options, maintainers: ['maintainer[bot]'] }), null);
});
