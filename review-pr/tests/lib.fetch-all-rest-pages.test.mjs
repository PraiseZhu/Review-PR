// fetchAllRestPages / parseLinkHeader 单测(P1-1 三审修复)—— REST 分页遍历,
// fetchExpectedRequiredContexts 与 probeBranchProtection 共用的分页机制。
// fetchPage 参数注入构造场景,不发真实网络请求。
// 跑:node --test review-pr/tests/lib.fetch-all-rest-pages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllRestPages, parseLinkHeader } from '../scripts/lib.mjs';

test('parseLinkHeader:标准三段 Link header 解析出 next/last 两个 rel', () => {
  const header =
    '<https://api.github.com/repos/x/y/rules/branches/main?per_page=2&page=2>; rel="next", ' +
    '<https://api.github.com/repos/x/y/rules/branches/main?per_page=2&page=5>; rel="last"';
  const links = parseLinkHeader(header);
  assert.equal(links.next, 'https://api.github.com/repos/x/y/rules/branches/main?per_page=2&page=2');
  assert.equal(links.last, 'https://api.github.com/repos/x/y/rules/branches/main?per_page=2&page=5');
});

test('parseLinkHeader:空/undefined 输入返回空对象,不抛错', () => {
  assert.deepEqual(parseLinkHeader(''), {});
  assert.deepEqual(parseLinkHeader(undefined), {});
});

test('parseLinkHeader:只有一页(无 Link header)场景对应的空字符串同样安全', () => {
  assert.deepEqual(parseLinkHeader(null), {});
});

test('P1-1 核心场景:required_status_checks 规则落在第 2 页,必须遍历完才能看到', () => {
  // 模拟 mivo 真实观察到的形状:第 1 页只有 code_scanning/code_quality,
  // required_status_checks 落在第 2 页(最后一页,无 next)。
  const pages = {
    'start-url': {
      body: [{ type: 'code_scanning' }, { type: 'code_quality' }],
      nextUrl: 'page-2-url',
    },
    'page-2-url': {
      body: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint' }] } }],
      nextUrl: null,
    },
  };
  const fetchPage = (url) => pages[url] ?? null;
  const all = fetchAllRestPages('start-url', { fetchPage });
  assert.ok(Array.isArray(all), 'fetchAllRestPages 应返回数组,不是 null');
  assert.equal(all.length, 3, '两页共 3 条规则必须全部拉到,不能只读第一页');
  const found = all.find((r) => r.type === 'required_status_checks');
  assert.ok(found, '落在第 2 页的 required_status_checks 规则不能被静默丢弃');
  assert.deepEqual(found.parameters.required_status_checks, [{ context: 'lint' }]);
});

test('P1-1 核心场景:中途某页失败(fetchPage 返回 null)→ 整体返回 null,不返回部分结果', () => {
  const pages = {
    'start-url': { body: [{ type: 'code_scanning' }], nextUrl: 'page-2-url' },
    // page-2-url 故意不在 pages 里 → fetchPage 返回 null,模拟网络失败/解析失败
  };
  const fetchPage = (url) => pages[url] ?? null;
  const all = fetchAllRestPages('start-url', { fetchPage });
  assert.equal(all, null, '中途页失败必须 fail-closed 返回 null,不能只返回已拉到的第一页');
});

test('单页场景(无 next):一次调用即返回,不多发请求', () => {
  let callCount = 0;
  const fetchPage = (url) => {
    callCount += 1;
    assert.equal(url, 'only-page');
    return { body: [{ type: 'required_status_checks', parameters: { required_status_checks: [] } }], nextUrl: null };
  };
  const all = fetchAllRestPages('only-page', { fetchPage });
  assert.equal(callCount, 1);
  assert.equal(all.length, 1);
});

test('超过 maxPages 硬上限仍未结束 → fail-closed 返回 null(防御性,真实场景不会发生)', () => {
  let calls = 0;
  const fetchPage = () => {
    calls += 1;
    return { body: [{ type: 'noop' }], nextUrl: `page-${calls}` };
  };
  const all = fetchAllRestPages('page-0', { fetchPage, maxPages: 3 });
  assert.equal(all, null);
  assert.equal(calls, 3, '应该恰好尝试 maxPages 次就停止,不会无限循环');
});

test('起始页就失败(fetchPage 首次调用返回 null)→ 直接返回 null', () => {
  const fetchPage = () => null;
  const all = fetchAllRestPages('start-url', { fetchPage });
  assert.equal(all, null);
});
