// findApproveMergeAuthorization(head 绑定版,SC-A 2026-08-04)+ parseApproveMergeShaCommands 单测。
//
// 语义变更背景:旧版依赖 latestPushDate(Commit.pushedDate + force-push 事件)判「授权须
// 晚于最后真实 push」。实测 pushedDate 已被 GitHub 废弃(#469 的 12 个 commit 全 null)——
// 无 force-push 的 PR 上全部授权被误判 stale,有旧 force-push 再普通 push 则可能漏判。
// 新版:`/approve-merge <完整 40 位 head SHA>`,SHA 精确等于当前 headRefOid 才有效;push
// 换 head 即天然作废。旧裸格式不构成授权,计入 legacyBare 供提醒重发。
// 原 P1-6(独占一行)/ P2-2(编辑拒绝)/ 展示语境剔除(code fence/blockquote)语义全部保留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findApproveMergeAuthorization, parseApproveMergeShaCommands, hasApproveMergeCommand } from '../scripts/lib.mjs';

const HEAD = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const ADMINS = ['PraiseZhu', 'kirozeng'];
const c = (author, body, over = {}) => ({
  author, isBot: false, body, createdAt: '2026-08-04T10:00:00Z', updatedAt: '2026-08-04T10:00:00Z', url: 'u', ...over,
});

test('正确 SHA + admins 成员 + 独占一行 → authorized', () => {
  const r = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${HEAD}`)], admins: ADMINS, headRefOid: HEAD });
  assert.ok(r.authorized);
  assert.equal(r.authorized.author, 'PraiseZhu');
});

test('旧 SHA(push 之后未重发)→ stale,不授权 —— 这是 head 绑定的核心语义', () => {
  const r = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${OLD}`)], admins: ADMINS, headRefOid: HEAD });
  assert.equal(r.authorized, null);
  assert.equal(r.stale.length, 1);
});

test('旧裸格式 /approve-merge(不带 SHA)→ 不授权,计入 legacyBare 供提醒重发', () => {
  const r = findApproveMergeAuthorization({ comments: [c('PraiseZhu', '/approve-merge')], admins: ADMINS, headRefOid: HEAD });
  assert.equal(r.authorized, null);
  assert.equal(r.legacyBare.length, 1);
  assert.equal(r.stale.length, 0);
});

test('headRefOid 缺失/非法 → 全部判 stale(fail-closed,没有"当前 head"可比对绝不放行)', () => {
  for (const head of ['', null, 'deadbeef']) {
    const r = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${HEAD}`)], admins: ADMINS, headRefOid: head });
    assert.equal(r.authorized, null, `head=${head}`);
  }
});

test('非 admins 成员 / bot 的命令不算;admins 未配置 → adminsConfigured=false 恒不授权', () => {
  const r1 = findApproveMergeAuthorization({ comments: [c('outsider', `/approve-merge ${HEAD}`)], admins: ADMINS, headRefOid: HEAD });
  assert.equal(r1.authorized, null);
  const r2 = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${HEAD}`, { isBot: true })], admins: ADMINS, headRefOid: HEAD });
  assert.equal(r2.authorized, null);
  const r3 = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${HEAD}`)], admins: [], headRefOid: HEAD });
  assert.equal(r3.adminsConfigured, false);
});

test('P2-2 保留:评论被编辑过(updatedAt !== createdAt)→ 拒绝并计入 edited', () => {
  const r = findApproveMergeAuthorization({
    comments: [c('PraiseZhu', `/approve-merge ${HEAD}`, { updatedAt: '2026-08-04T11:00:00Z' })],
    admins: ADMINS, headRefOid: HEAD,
  });
  assert.equal(r.authorized, null);
  assert.equal(r.edited.length, 1);
});

test('独占一行保留:行内追加文字不算下达;code fence/blockquote 里的命令是展示不是下达', () => {
  assert.deepEqual(parseApproveMergeShaCommands(`/approve-merge ${HEAD} 请尽快`), []);
  assert.deepEqual(parseApproveMergeShaCommands('```\n/approve-merge ' + HEAD + '\n```'), []);
  assert.deepEqual(parseApproveMergeShaCommands(`> /approve-merge ${HEAD}`), []);
  assert.deepEqual(parseApproveMergeShaCommands(`说明文字\n/approve-merge ${HEAD}\n收尾`), [HEAD]);
  assert.deepEqual(parseApproveMergeShaCommands(`/approve-merge ${HEAD.toUpperCase()}`), [HEAD]);
  assert.equal(hasApproveMergeCommand('/approve-merge'), true);
});

test('多条有效授权取最新一条', () => {
  const r = findApproveMergeAuthorization({
    comments: [
      c('PraiseZhu', `/approve-merge ${HEAD}`, { createdAt: '2026-08-04T09:00:00Z', updatedAt: '2026-08-04T09:00:00Z', url: 'early' }),
      c('kirozeng', `/approve-merge ${HEAD}`, { createdAt: '2026-08-04T12:00:00Z', updatedAt: '2026-08-04T12:00:00Z', url: 'late' }),
    ],
    admins: ADMINS, headRefOid: HEAD,
  });
  assert.equal(r.authorized.url, 'late');
});
