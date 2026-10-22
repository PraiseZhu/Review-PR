import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeferrals, verifyDeferrals, mentionsPr, toIssueRead, toDeferredSummary, MAX_DEFERRALS } from './deferrals.mjs';

const repo = 'xindong/mivo-canvas-plugin';
const pr = 941;
const prUrl = `https://github.com/${repo}/pull/941`;
const parse = (body) => parseDeferrals(body, { repo, pr });
const section = (items, heading = '## 转 issue 跟进的审查问题') => ['## 风险', '说明', heading, ...items, '## 影响与回滚', '- #9999 不算'].join('\n');

test('解析:## 到 #### 的精确标题都认,其他级别和改过字的标题不认', () => {
  for (const level of ['##', '###', '####']) {
    assert.deepEqual(parse(section(['- #1001 漏列'], `${level} 转 issue 跟进的审查问题`)).entries.map((e) => e.issue), [1001], level);
  }
  for (const heading of ['# 转 issue 跟进的审查问题', '##### 转 issue 跟进的审查问题', '## 转 issue 跟进的审查问题（补充）']) {
    assert.equal(parse(section(['- #1001 漏列'], heading)).found, false, heading);
  }
  assert.deepEqual(parse(null), { found: false, entries: [], rejected: [] });
  assert.deepEqual(parse('## 风险\n- #1001'), { found: false, entries: [], rejected: [] });
});

test('解析:CRLF、HTML 注释和代码块里的示例不算登记', () => {
  const body = [
    '<!-- ## 转 issue 跟进的审查问题', '- #999 模板示例 -->',
    '## 转 issue 跟进的审查问题', '- #1001 漏列', '```', '- #1004 代码块里的', '```', '- #1005 第二条',
  ].join('\r\n');
  const parsed = parse(body);
  assert.equal(parsed.found, true);
  assert.deepEqual(parsed.entries.map((e) => e.issue), [1001, 1005]);
});

test('解析:一节到下一个同级或更高级标题为止,更深的子标题仍在本节内', () => {
  const body = ['### 转 issue 跟进的审查问题', '- #1001 a', '#### 补充', '- #1002 b', '### 影响与回滚', '- #1003 c'].join('\n');
  assert.deepEqual(parse(body).entries.map((e) => e.issue), [1001, 1002]);
});

test('解析:引用形式、跳过本 PR 和本仓 PR 链接、跨仓与重复', () => {
  const parsed = parse(section([
    '- 来自 #941 的 P1 → #1001 漏列',
    `- https://github.com/Xindong/Mivo-Canvas-Plugin/issues/1002#issuecomment-1 大小写不同也算本仓`,
    '1. #1003 有序列表',
    '- [ ] #1007 任务框',
    `- 见 https://github.com/${repo}/pull/700 和 https://foo.com/page#12,不算登记`,
    '- 没有引用的说明行',
    '- other/repo#5 跨仓',
    '- https://github.com/other/repo/issues/6 跨仓链接',
    '- #1001 重复',
  ]));
  assert.deepEqual(parsed.entries.map((e) => e.issue), [1001, 1002, 1003, 1007]);
  assert.equal(parsed.entries[0].text, '来自 #941 的 P1 → #1001 漏列');
  assert.deepEqual(parsed.rejected.map((r) => [r.issue, r.reason]), [
    [null, '跨仓引用,只认本仓 issue'],
    [null, '跨仓引用,只认本仓 issue'],
    [1001, '重复登记'],
  ]);
});

test('解析:最多 10 项,超出的记未采用;文字压成单行并截断', () => {
  const items = Array.from({ length: 12 }, (_, i) => `- #${2000 + i} 问题 ${i}`);
  const parsed = parse(section(items));
  assert.equal(parsed.entries.length, MAX_DEFERRALS);
  assert.deepEqual(parsed.rejected.map((r) => r.reason), ['超过 10 项上限', '超过 10 项上限']);
  const long = parse(section([`- #1001 ${'很长'.repeat(200)}`])).entries[0].text;
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
});

test('提到本 PR:#941 后面不能跟数字;PR 链接不区分大小写', () => {
  assert.equal(mentionsPr('来自 #941 的审查', { pr, prUrl }), true);
  assert.equal(mentionsPr('来自 #9410', { pr, prUrl }), false);
  assert.equal(mentionsPr(`见 ${prUrl.toUpperCase()}#discussion_r1`, { pr, prUrl }), true);
  assert.equal(mentionsPr(`见 ${prUrl}0`, { pr, prUrl }), false);
  assert.equal(mentionsPr(null, { pr, prUrl }), false);
});

const issue = (over = {}) => ({
  repository_url: `https://api.github.com/repos/${repo}`, state: 'open', user: { login: 'Alice' },
  title: '旧 ghost 列表静默漏列', body: '来自 #941 的审查 P1', html_url: `https://github.com/${repo}/issues/1001`, ...over,
});
const verify = (issues, over = {}) => verifyDeferrals({
  entries: Object.keys(issues).map((n) => ({ issue: Number(n), ref: `#${n}`, text: `#${n} 说明` })),
  repo, pr, prUrl, author: 'alice', maintainers: ['Bob'], ...over,
  readIssue: (n) => { const v = issues[n]; if (v instanceof Error) throw v; return v; },
});

test('核验:同时满足全部条件才采用,不满足的写明原因', () => {
  const { verified, rejected } = verify({
    1001: { ok: true, issue: issue() },
    1002: { ok: true, issue: issue({ user: { login: 'BOB' } }) },
    1003: { ok: false, notFound: true, error: 'HTTP 404' },
    1004: { ok: false, error: 'timeout' },
    1005: new Error('boom'),
    1006: { ok: true, issue: issue({ pull_request: { url: 'x' } }) },
    1007: { ok: true, issue: issue({ state: 'closed' }) },
    1008: { ok: true, issue: issue({ user: { login: 'mallory' } }) },
    1009: { ok: true, issue: issue({ title: '无关', body: '来自 #9410' }) },
    1010: { ok: true, issue: issue({ repository_url: 'https://api.github.com/repos/other/repo' }) },
    1011: { ok: true, issue: issue({ title: '无关', body: null }) },
    1012: { ok: true, issue: issue({ title: '无关', body: `见 ${prUrl}#discussion_r1` }) },
  });
  assert.deepEqual(verified.map((v) => v.issue), [1001, 1002, 1012]);
  assert.deepEqual(verified[0], { issue: 1001, title: '旧 ghost 列表静默漏列', url: `https://github.com/${repo}/issues/1001`, opener: 'Alice', text: '#1001 说明', keys: [] });
  const reasons = Object.fromEntries(rejected.map((r) => [r.issue, r.reason]));
  assert.equal(reasons[1003], 'issue 不存在');
  assert.equal(reasons[1004], '读取失败:timeout');
  assert.equal(reasons[1005], '读取失败:boom');
  assert.equal(reasons[1006], '这是 PR,不是 issue');
  assert.match(reasons[1007], /不是 OPEN\(closed\)/);
  assert.match(reasons[1008], /`mallory` 不是 PR 作者或维护者/);
  assert.doesNotMatch(reasons[1008], /@/, '原因会写进 PR 报告,不能 @ 人');
  assert.match(reasons[1009], /没有提到本 PR/);
  assert.match(reasons[1010], /不在本仓/);
  assert.match(reasons[1011], /没有提到本 PR/);
});

test('gh 读取结果转换与摘要', () => {
  assert.deepEqual(toIssueRead({ ok: true, stdout: '{"number":1}' }), { ok: true, issue: { number: 1 } });
  assert.equal(toIssueRead({ ok: true, stdout: 'oops' }).ok, false);
  assert.deepEqual(toIssueRead({ ok: false, stderr: 'gh: Not Found (HTTP 404)' }), { ok: false, notFound: true, error: 'gh: Not Found (HTTP 404)' });
  assert.equal(toIssueRead({ ok: false, stderr: 'network down' }).notFound, false);
  assert.equal(toDeferredSummary([]), null);
  assert.deepEqual(toDeferredSummary([{ deferredTo: 1001 }, { deferredTo: 1000 }, { deferredTo: 1001 }]),
    { count: 3, issues: [1000, 1001], text: '3 条 P1/P2 已转 issue 跟进(#1000、#1001)' });
});
