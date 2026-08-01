// computeLatestPushDate 单测 —— P2-1(2026-08-02):/approve-merge 授权时效检查的锚点
// 改用 GitHub 服务端记录、不可伪造的 commit.pushedDate + HeadRefForcePushedEvent.createdAt,
// 不用可在本地任意伪造的 commit.committedDate(`git commit --date=...`/rebase 都能改)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLatestPushDate } from '../scripts/lib.mjs';

test('取所有 commit.pushedDate 与 force-push 事件时间的最大值', () => {
  const r = computeLatestPushDate({
    commits: [{ pushedDate: '2026-08-01T09:00:00Z' }, { pushedDate: '2026-08-01T10:00:00Z' }],
    forcePushEvents: [{ createdAt: '2026-08-01T08:00:00Z' }],
  });
  assert.equal(r, '2026-08-01T10:00:00Z');
});

test('P2-1 核心场景:force-push 回退到早已存在的旧 commit,没有新 commit 对象产生新 pushedDate —— force-push 事件时间是唯一能证明"分支刚变过"的信号', () => {
  const r = computeLatestPushDate({
    commits: [{ pushedDate: '2026-07-01T00:00:00Z' }], // 回退目标 commit 很早以前就 push 过
    forcePushEvents: [{ createdAt: '2026-08-01T12:00:00Z' }], // 但强推动作发生在刚才
  });
  assert.equal(r, '2026-08-01T12:00:00Z', '必须采信 force-push 事件时间,不能只看 commit 的 pushedDate 而漏判"刚强推过"');
});

test('pushedDate 缺失(字段没取到)的 commit 被忽略,不污染最大值计算', () => {
  const r = computeLatestPushDate({
    commits: [{ pushedDate: null }, { pushedDate: '2026-08-01T09:00:00Z' }, {}],
    forcePushEvents: [],
  });
  assert.equal(r, '2026-08-01T09:00:00Z');
});

test('两类信号都拿不到 → 返回空字符串(调用方必须按"无法确定"fail-closed 处理)', () => {
  assert.equal(computeLatestPushDate({ commits: [], forcePushEvents: [] }), '');
  assert.equal(computeLatestPushDate({ commits: [{ pushedDate: null }], forcePushEvents: [{ createdAt: null }] }), '');
  assert.equal(computeLatestPushDate({ commits: undefined, forcePushEvents: undefined }), '');
});

test('只有 commits 没有 forcePushEvents(常见情形:非 force-push 的正常增量推送)', () => {
  const r = computeLatestPushDate({ commits: [{ pushedDate: '2026-08-01T09:30:00Z' }], forcePushEvents: [] });
  assert.equal(r, '2026-08-01T09:30:00Z');
});
