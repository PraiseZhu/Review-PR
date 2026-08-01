// findApproveMergeAuthorization 单测 —— 授权快速合并通道的授权检测(decision 1+2+6:
// admins 名单成员、非机器人、`/approve-merge` 独占一行、须晚于最后一次 push、
// admins 缺失/为空 fail-closed)。纯函数,零网络依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findApproveMergeAuthorization } from '../scripts/lib.mjs';

const ADMINS = ['PraiseZhu', 'kirozeng', 'aj0928'];

test('decision 6:admins 为空时 fail-closed,即使评论完全合规也不算授权', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'PraiseZhu', isBot: false, createdAt: '2026-08-01T10:00:00Z', body: '/approve-merge' }],
    admins: [],
    latestCommitDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.adminsConfigured, false);
  assert.equal(r.authorized, null);
});

test('decision 1:非 admins 名单成员发 /approve-merge 不算授权', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'random-contributor', isBot: false, createdAt: '2026-08-01T10:00:00Z', body: '/approve-merge' }],
    admins: ADMINS,
    latestCommitDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
});

test('decision 1:机器人发的评论不算授权,即使 login 命中 admins', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'PraiseZhu', isBot: true, createdAt: '2026-08-01T10:00:00Z', body: '/approve-merge' }],
    admins: ADMINS,
    latestCommitDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
});

test('decision 2:评论早于最后一次 push 视为 stale,不算有效授权', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T08:00:00Z', body: '/approve-merge 看过了,可以合' }],
    admins: ADMINS,
    latestCommitDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].author, 'kirozeng');
});

test('decision 1+2:admins 成员在最后一次 push 之后发 /approve-merge 有效', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', url: 'https://x/comment/1', body: '/approve-merge 已确认 CI 绿,可以合' }],
    admins: ADMINS,
    latestCommitDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized?.author, 'kirozeng');
  assert.equal(r.authorized?.url, 'https://x/comment/1');
});

test('命令必须独占一行(允许行内追加说明),句中子串不应误命中', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', body: '请不要 /approve-mergexyz 这个词误命中' }],
    admins: ADMINS,
    latestCommitDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized, null);
});

test('讨论命令而非下达命令不应误判 —— 命令词出现在句中提及场景', () => {
  const r = findApproveMergeAuthorization({
    comments: [{ author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', body: '我觉得可以发 /approve-merge 了,但让我再看一眼 diff' }],
    admins: ADMINS,
    latestCommitDate: '2026-08-01T09:00:00Z',
  });
  // "/approve-merge" 出现在句中而非独占一行 —— 按裁决口径(维持直译实现,不放宽到句中)不算授权
  assert.equal(r.authorized, null);
});

test('多条有效授权取最新一条(createdAt 最大)', () => {
  const r = findApproveMergeAuthorization({
    comments: [
      { author: 'kirozeng', isBot: false, createdAt: '2026-08-01T10:00:00Z', url: 'u1', body: '/approve-merge' },
      { author: 'aj0928', isBot: false, createdAt: '2026-08-01T11:00:00Z', url: 'u2', body: '/approve-merge' },
    ],
    admins: ADMINS,
    latestCommitDate: '2026-08-01T09:00:00Z',
  });
  assert.equal(r.authorized?.author, 'aj0928');
});
