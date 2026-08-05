// audit-merged-loop-prs.mjs 的取全/游标推进单测(F-A5-PAGINATION-CURSOR-LOSS 二审修复)。
//
// 根因:此前生产查询固定 `gh pr list --search ... --limit 100`,单页硬顶且无翻页/截断
// 检测;随后无条件把游标推进到 now。若某审计窗口内 merged 的 loop 托管 PR 超过 100 条,
// 超出的那些既不核验回执、不告警、也不开 revert PR,且游标已经前移,永久漏审、无法回溯
// 发现(seat②codex-adversarial R1 finding)。
//
// 修复:fetchAllMergedPrs 用 GraphQL search 的 pageInfo.hasNextPage/endCursor 翻页
// 到确认取全(而不是用「返回数量==limit 就可能被截断」这种启发式),取不全(超过硬上限)
// 时返回 null;decideCursorAfterFetch 把「游标推进的前提是已确认取全」这条不变量抽成
// 独立可单测的纯函数——pages===null 时游标原地不动并标记 windowPossiblyTruncated。
//
// 跑:node --test review-pr/tests/audit-merged-loop-prs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllMergedPrs, decideCursorAfterFetch } from '../scripts/audit-merged-loop-prs.mjs';

function pr(number) {
  return { number, title: `pr ${number}`, body: '', headRefOid: 'a'.repeat(40), mergeCommit: { oid: 'b'.repeat(40) }, mergedAt: '2026-08-01T00:00:00Z' };
}

// ---- fetchAllMergedPrs ----

test('(c) 现有场景不变:单页(数量 < limit,hasNextPage=false)一次调用即返回全部,不多翻页', () => {
  let calls = 0;
  const fetchPage = (after) => {
    calls += 1;
    assert.equal(after, undefined, '首次调用不应带 after');
    return { nodes: [pr(1), pr(2), pr(3)], pageInfo: { hasNextPage: false, endCursor: null } };
  };
  const all = fetchAllMergedPrs({ slug: 'x/y', sinceDate: '2026-08-01', fetchPage });
  assert.ok(Array.isArray(all));
  assert.equal(all.length, 3);
  assert.equal(calls, 1, '单页场景不应发起第二次请求');
});

test('(b) 分页补齐:150 条分 2 页(100+50),必须聚合成完整的 150 条,不能只读第一页', () => {
  const page1 = Array.from({ length: 100 }, (_, i) => pr(i + 1));
  const page2 = Array.from({ length: 50 }, (_, i) => pr(i + 101));
  let calls = 0;
  const fetchPage = (after) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(after, undefined);
      return { nodes: page1, pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } };
    }
    assert.equal(after, 'cursor-1', '第二页必须带上第一页给出的 endCursor');
    return { nodes: page2, pageInfo: { hasNextPage: false, endCursor: null } };
  };
  const all = fetchAllMergedPrs({ slug: 'x/y', sinceDate: '2026-08-01', fetchPage });
  assert.ok(Array.isArray(all), 'fetchAllMergedPrs 应返回数组,不是 null');
  assert.equal(all.length, 150, '两页共 150 条必须全部拉到,不能被第一页的 100 条硬顶截断');
  assert.equal(calls, 2);
  assert.deepEqual(all.map((p) => p.number), Array.from({ length: 150 }, (_, i) => i + 1));
});

test('(a) 截断检测:hasNextPage 恒为 true(模拟持续有下一页/可能被截断),超过 maxPages 硬上限仍未翻完 → fail-closed 返回 null', () => {
  let calls = 0;
  const fetchPage = () => {
    calls += 1;
    return { nodes: [pr(calls)], pageInfo: { hasNextPage: true, endCursor: `cursor-${calls}` } };
  };
  const all = fetchAllMergedPrs({ slug: 'x/y', sinceDate: '2026-08-01', fetchPage, maxPages: 3 });
  assert.equal(all, null, '未确认取全时必须返回 null,不能返回已拉到的部分结果(那会被误当作"取全"推进游标)');
  assert.equal(calls, 3, '应该恰好尝试 maxPages 次就停止,不会无限翻页');
});

test('起始页就失败(fetchPage 首次调用返回 null,如 GraphQL 请求失败)→ 直接返回 null', () => {
  const fetchPage = () => null;
  const all = fetchAllMergedPrs({ slug: 'x/y', sinceDate: '2026-08-01', fetchPage });
  assert.equal(all, null);
});

test('hasNextPage=true 但 endCursor 缺失(数据不自洽)→ fail-closed 返回 null,不当作已翻完', () => {
  const fetchPage = () => ({ nodes: [pr(1)], pageInfo: { hasNextPage: true, endCursor: null } });
  const all = fetchAllMergedPrs({ slug: 'x/y', sinceDate: '2026-08-01', fetchPage });
  assert.equal(all, null);
});

test('nodes 里混入 null(GraphQL inline fragment 不匹配 PullRequest 的节点)→ 被过滤,不进入结果集合', () => {
  const fetchPage = () => ({ nodes: [pr(1), null, pr(2)], pageInfo: { hasNextPage: false, endCursor: null } });
  const all = fetchAllMergedPrs({ slug: 'x/y', sinceDate: '2026-08-01', fetchPage });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((p) => p.number), [1, 2]);
});

// ---- decideCursorAfterFetch ----

test('(a)(不变量核心)pages===null(未确认取全)→ 游标原地不动,windowPossiblyTruncated=true', () => {
  const r = decideCursorAfterFetch({ pages: null, cursor: '2026-08-01T00:00:00.000Z', now: '2026-08-05T12:00:00.000Z' });
  assert.equal(r.cursor, '2026-08-01T00:00:00.000Z', '未确认取全时游标不得推进,否则超出部分永久漏审');
  assert.equal(r.windowPossiblyTruncated, true);
});

test('(c) pages 为完整数组(含 0 条)→ 游标正常推进到 now,windowPossiblyTruncated=false', () => {
  const r = decideCursorAfterFetch({ pages: [pr(1), pr(2)], cursor: '2026-08-01T00:00:00.000Z', now: '2026-08-05T12:00:00.000Z' });
  assert.equal(r.cursor, '2026-08-05T12:00:00.000Z');
  assert.equal(r.windowPossiblyTruncated, false);
});

test('空数组([])不是 null——已确认窗口内确实零条 merged PR,游标仍应推进,不能被误判为截断', () => {
  const r = decideCursorAfterFetch({ pages: [], cursor: '2026-08-01T00:00:00.000Z', now: '2026-08-05T12:00:00.000Z' });
  assert.equal(r.cursor, '2026-08-05T12:00:00.000Z');
  assert.equal(r.windowPossiblyTruncated, false);
});
