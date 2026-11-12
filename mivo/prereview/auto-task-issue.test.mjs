// auto-task-issue.test.mjs — 前置审查给没写任务 issue 的 PR 补开任务 issue(PraiseZhu/Review-PR#246 SC4,总 issue #132 D20)。
// 用 round.mjs 里真实的 ensureTaskIssue 等函数源码(vm),gh 换成内存替身。证明:用审查机同一套查找(readTaskIssue,只定位),审查机会判「未关联」才开;
// 能读到任务 issue 不开;读不到、有读取缺口这一轮不开;已有自动 issue 复用;读失败、开失败都不挡送审,记 warning;豁免分支、开关 off、dry-run 不写 GitHub。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { toTaskIssueLinks, readTaskIssue, toAutoTaskIssue, isAutoTaskIssue, AUTO_LINK_MARKER, AUTO_ISSUE_MARKER, DEFAULT_AUTO_ISSUE } from '../lib/task-issue.mjs';
import { splitDiffByFile } from '../lib/scope.mjs';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
const section = /^\/\/ ── 补任务 issue\(#246[\s\S]*?(?=^\/\/ ── 审查熔断\(#209\))/m.exec(source)?.[0];
assert.ok(section, '找不到 round.mjs 的补任务 issue 段');
assert.match(source, /try \{ ensureTaskIssue\(ctx, task, live, result\); \} catch \(error\) \{ result\.warnings = \[\.\.\.\(result\.warnings \?\? \[\]\), `自动任务 issue:异常/,
  '补任务 issue 包在 try 里,异常只记 warning');
assert.match(source, /try \{ ensureTaskIssue\(ctx, task, live, result\); \}[^\n]*\n  return \(await holdForFuse\(ctx, task, live, result\)\) \?\? dispatchReview\(ctx, task, \{ tier: decision\.tier, action: 'review' \}/,
  '补任务 issue 在判门送审之前');

const R = 'o/r';
// vm 里产生的数组、对象和测试这边不是同一个原型:比较前转成普通 JSON 值。
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-x', '+y',
  'diff --git a/docs/pr/7/review.md b/docs/pr/7/review.md', '--- a/docs/pr/7/review.md', '+++ b/docs/pr/7/review.md', '@@ -1 +1 @@', '-x', '+y'].join('\n');
const PR_BODY = '## 这次改了什么\n\n### 摘要\n\n修好 x。\n\n### 范围\n\n- 本 PR 包含：`src/a.ts`\n- 明确不包含：别的模块\n\n## 怎么验证的\n\n### 自动验证\n\n```text\n命令：npm test\n结果：通过\n```\n';

// GraphQL 形状的 issue 节点(审查机读任务 issue 用的查询返回这个形状)。
const node = (number, over = {}) => ({ number, title: `[子] ${number}`, url: `https://github.com/${R}/issues/${number}`, body: '', createdAt: '2026-11-01T00:00:00Z',
  author: { login: 'PraiseZhu', __typename: 'User' }, userContentEdits: { nodes: [] }, comments: { nodes: [] }, timelineItems: { totalCount: 0, nodes: [] }, ...over });

// issues:存在的 issue(GraphQL 节点);prs:是 PR 的编号;pulls:质检来源 PR {title, body, comments};closing:GitHub 记的 Closes 关联;failIssues / failPulls:读失败的编号。
function makeWorld({ mode = 'live', features = { mode: 'enforce', autoIssue: { ...DEFAULT_AUTO_ISSUE, mode: 'enforce' } }, body = PR_BODY, title = 'fix: 修好 x', head = 'feat/x',
  comments = [], issues = {}, prs = [], pulls = {}, closing = [], openIssues = [], listOk = true, createOk = true, commentOk = true, failIssues = [], failPulls = [] } = {}) {
  const calls = [];
  const logs = [];
  const written = {};
  let issueNo = 800;
  const notFound = (n) => ({ type: 'NOT_FOUND', message: `Could not resolve to an issue or pull request with the number of ${n}.` });
  const graphql = (options) => {
    const q = JSON.parse(options?.input ?? '{}');
    const n = q.variables?.number;
    const reply = (data, errors = []) => ({ ok: !errors.length, stdout: JSON.stringify({ data, ...(errors.length ? { errors } : {}) }) });
    if (/closingIssuesReferences/.test(q.query)) return reply({ repository: { pullRequest: { closingIssuesReferences: { nodes: closing.map((c) => ({ number: c, title: issues[c]?.title ?? null, url: `https://github.com/${R}/issues/${c}` })) } } } });
    if (/p0:issueOrPullRequest/.test(q.query)) {
      const numbers = [0, 1, 2, 3].map((i) => q.variables[`n${i}`]);
      if (numbers.some((m) => failIssues.includes(m))) return { ok: false, stdout: '', stderr: 'HTTP 502' };
      const kind = (m) => (issues[m] ? { __typename: 'Issue', number: m, title: issues[m].title } : prs.includes(m) || m in pulls ? { __typename: 'PullRequest' } : null);
      return reply({ repository: Object.fromEntries(numbers.map((m, i) => [`p${i}`, kind(m)])) }, numbers.filter((m) => !kind(m)).map(notFound));
    }
    if (/on PullRequest\{number title body comments/.test(q.query)) {
      if (failPulls.includes(n)) return { ok: false, stdout: '', stderr: 'HTTP 502' };
      const hit = pulls[n] ? { __typename: 'PullRequest', number: n, title: pulls[n].title ?? '', body: pulls[n].body ?? '', comments: { nodes: pulls[n].comments ?? [] } } : null;
      return reply({ repository: { issueOrPullRequest: hit } }, hit ? [] : [notFound(n)]);
    }
    if (/timelineItems/.test(q.query)) {
      if (failIssues.includes(n)) return { ok: false, stdout: '', stderr: 'HTTP 502' };
      return reply({ repository: { issue: issues[n] ?? null } }, issues[n] ? [] : [notFound(n)]);
    }
    return { ok: false, stderr: 'unexpected graphql' };
  };
  const ghRead = (args, options) => {
    calls.push(plain(args));
    if (args[1] === 'graphql') return graphql(options);
    const path = args.find((a) => String(a).startsWith('repos/'));
    if (args.includes('--method') && path === `repos/${R}/issues`) return listOk ? { ok: true, stdout: JSON.stringify([openIssues]) } : { ok: false, stderr: 'HTTP 502' };
    return { ok: false, stderr: `unexpected ${args.join(' ')}` };
  };
  const run = (cmd, args) => {
    calls.push(plain(args));
    if (args[0] === 'issue' && args[1] === 'create') return createOk ? { ok: true, stdout: `https://github.com/o/r/issues/${++issueNo}\n` } : { ok: false, stderr: 'HTTP 403' };
    if (args[0] === 'pr' && args[1] === 'comment') return commentOk ? { ok: true, stdout: 'https://github.com/o/r/pull/7#issuecomment-1\n' } : { ok: false, stderr: 'HTTP 502' };
    return { ok: false, stderr: `unexpected ${args.join(' ')}` };
  };
  const sandbox = {
    CONFIG: { mode, targetRepo: R, repoRoot: '/repo' }, ENV: {}, SKILL_ROOT: '/skill', join, process: { env: {} },
    loadTaskIssueMode: () => structuredClone(features),
    readTaskIssue, toAutoTaskIssue, isAutoTaskIssue, AUTO_LINK_MARKER, splitDiffByFile,
    readFileSync: (file) => { if (String(file).endsWith('pr-7-live.diff')) return DIFF; throw new Error(`unexpected read ${file}`); },
    ghRead, run,
    log: (event, detail) => logs.push({ event, ...detail }),
    writeText: (file, text) => { written[file] = text; },
    assertNotFenced: () => {},
  };
  vm.runInNewContext(`${section}\nglobalThis.ensure = ensureTaskIssue;`, sandbox);
  const live = { meta: { title, body, author: 'aj0928', headRefName: head }, history: { comments } };
  const gate = () => {
    const result = { outcome: 'review', reason: '', errors: [], warnings: [], gate: { stage: 'review', actions: [] } };
    sandbox.ensure({ roundDir: '/round' }, { pr: 7, head: 'h1' }, live, result);
    return plain(result);
  };
  const writes = () => calls.filter((a) => (a[0] === 'issue' && a[1] === 'create') || (a[0] === 'pr' && a[1] === 'comment'));
  return { gate, calls, logs, written, writes };
}
const botLink = (pr, issue) => ({ author: 'praisebuild[bot]', isBot: true, body: AUTO_LINK_MARKER(pr, issue) });
const confirm = (n) => node(n, { title: '维护者确认 · PR #7 是否改 x' });

test('SC4 认不出任务 issue:按模板开一个自动 issue(走 issue create),再在 PR 下发一条带标记的关联评论', () => {
  const world = makeWorld();
  const result = world.gate();
  const [create, comment] = world.writes();
  assert.deepEqual(create.slice(0, 4), ['issue', 'create', '-R', R]);
  assert.equal(create[create.indexOf('--title') + 1], '任务 issue · PR #7 fix: 修好 x');
  const body = world.written['/round/auto-task-issue-pr-7.md'];
  assert.equal(body.split('\n')[0], AUTO_ISSUE_MARKER(7));
  assert.match(body, /- `src\/a\.ts`：本 PR 改动\n- `docs\/pr\/7\/review\.md`：本 PR 改动/);
  assert.match(body, /## 不做\n\n- 明确不包含：别的模块/);
  assert.match(body, /- \[ \] SC1 npm test：通过。验证：unit/);
  assert.deepEqual(comment.slice(0, 4), ['pr', 'comment', '7', '-R']);
  const link = world.written['/round/auto-task-issue-link-pr-7.md'];
  assert.match(link, /^任务 issue：o\/r#801（前置审查按本 PR 自动开/);
  assert.ok(link.includes(AUTO_LINK_MARKER(7, 801)));
  assert.deepEqual(result.gate.taskIssue, { issue: 801, created: true, linked: true });
  assert.deepEqual(result.warnings, []);
  // 关联评论能被审查机认出来(同一个 toTaskIssueLinks)
  assert.deepEqual(toTaskIssueLinks({ body: '', comments: [{ author: 'praisebuild[bot]', isBot: true, body: link }], repo: R, pr: 7 }).autoLink, { repo: R, number: 801 });
});

test('SC4 审查机能读到任务 issue 就不开:「任务 issue：」行、Closes、关联评论、别的写法指向的都是 issue', () => {
  for (const over of [
    { body: `任务 issue：o/r#12\n${PR_BODY}`, issues: { 12: node(12) } },
    { closing: [12], issues: { 12: node(12) } },
    { comments: [botLink(7, 600)], issues: { 600: node(600) } },
    { body: `- 关联 Issue / 需求：Refs #12\n${PR_BODY}`, issues: { 12: node(12) } },
    { body: `- 关联 Issue / 需求：缓解 #21 的超时，见 #12\nRefs #12\n${PR_BODY}`, prs: [21], issues: { 12: node(12) } },
  ]) {
    const world = makeWorld(over);
    const result = world.gate();
    assert.deepEqual(world.writes(), [], JSON.stringify(Object.keys(over)));
    assert.equal(result.gate.taskIssue, undefined);
    assert.deepEqual(result.warnings, []);
  }
});

test('SC4 审查机会判「未关联」就开:别的写法指向 PR 或不存在、「任务 issue：」行指向维护者确认 issue、关联评论指向的 issue 已不存在', () => {
  for (const over of [
    { body: `- 关联 Issue / 需求：缓解 #21 的超时\n${PR_BODY}`, prs: [21] },
    { body: `Refs #99\n${PR_BODY}` },
    { body: `任务 issue：o/r#30\n${PR_BODY}`, issues: { 30: confirm(30) } },
    { closing: [30], issues: { 30: confirm(30) } },
    { comments: [botLink(7, 600)] },
  ]) {
    const world = makeWorld(over);
    const result = world.gate();
    assert.equal(world.writes().length, 2, JSON.stringify(over));
    assert.deepEqual(result.warnings, []);
    // 开出来的 issue 加上新的关联评论,审查机就读得到(同一套查找)
    const link = world.written['/round/auto-task-issue-link-pr-7.md'];
    const auto = node(801, { title: '任务 issue · PR #7 fix: 修好 x', body: world.written['/round/auto-task-issue-pr-7.md'], author: { login: 'praisebuild', __typename: 'Bot' } });
    const after = makeWorld({ ...over, comments: [...(over.comments ?? []), { author: 'praisebuild[bot]', isBot: true, body: link }], issues: { ...(over.issues ?? {}), 801: auto } });
    after.gate();
    assert.deepEqual(after.writes(), [], `补开后不再开:${JSON.stringify(over)}`);
  }
});

test('SC4 审查机会判「读不到」或有读取缺口:这一轮不开、记 warning,不挡送审', () => {
  const failing = makeWorld({ body: `Refs #22\n${PR_BODY}`, failIssues: [22] });
  const r1 = failing.gate();
  assert.deepEqual(failing.writes(), []);
  assert.match(r1.warnings[0], /^自动任务 issue:任务 issue 读不到.*,这一轮不开$/);
  assert.equal(r1.outcome, 'review', '不改判门结论');
  const strictPr = makeWorld({ body: `任务 issue：o/r#21\n${PR_BODY}`, prs: [21] });
  const r2 = strictPr.gate();
  assert.deepEqual(strictPr.writes(), [], '「任务 issue：」行指向 PR:严格按读不到算,不补开');
  assert.match(r2.warnings[0], /任务 issue 读不到/);
});

test('SC4 质检修复 PR:来源 PR 有任务 issue 或关联评论就不开;来源也没有就开;读来源失败(有缺口)这一轮不开', () => {
  const origin = (body, comments = []) => ({ 2134: { title: 'fix: 来源', body, comments } });
  const linked = makeWorld({ body: 'QA: #2134', pulls: origin('任务 issue：o/r#2130'), issues: { 2130: node(2130) } });
  linked.gate();
  assert.deepEqual(linked.writes(), []);
  const viaComment = makeWorld({ body: 'QA: #2134', pulls: origin('', [{ author: { login: 'praisebuild', __typename: 'Bot' }, body: AUTO_LINK_MARKER(2134, 3000) }]), issues: { 3000: node(3000) } });
  viaComment.gate();
  assert.deepEqual(viaComment.writes(), [], '来源 PR 有关联评论也算');
  const none = makeWorld({ body: 'QA: #2134', pulls: origin('没写') });
  none.gate();
  assert.equal(none.writes().length, 2);
  const failing = makeWorld({ body: 'QA: #2134', failPulls: [2134] });
  const result = failing.gate();
  assert.deepEqual(failing.writes(), []);
  assert.match(result.warnings[0], /找任务 issue 时有读取缺口\(.*质检来源 PR #2134.*\),这一轮不开/);
});

test('SC4 已有带本 PR 标记的开着的自动 issue:复用、不另开,只补关联评论;别人开的、别的 PR 的不算', () => {
  const mine = { number: 650, title: '任务 issue · PR #7 fix: 修好 x', body: `${AUTO_ISSUE_MARKER(7)}\n> 子 issue`, user: { login: 'praisebuild[bot]', type: 'Bot' } };
  const fake = { ...mine, number: 651, user: { login: 'praisebuild', type: 'User' } };
  const other = { ...mine, number: 652, title: '任务 issue · PR #8 x', body: `${AUTO_ISSUE_MARKER(8)}` };
  const pull = { ...mine, number: 653, pull_request: {} };
  const world = makeWorld({ openIssues: [fake, other, pull, mine] });
  const result = world.gate();
  const writes = world.writes();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].slice(0, 2), ['pr', 'comment']);
  assert.ok(world.written['/round/auto-task-issue-link-pr-7.md'].includes(AUTO_LINK_MARKER(7, 650)));
  assert.deepEqual(result.gate.taskIssue, { issue: 650, created: false, linked: true });
});

test('SC4 失败不挡送审:列 issue 失败不开;开 issue 失败不发评论;评论失败记 warning,下一次判门复用', () => {
  const noList = makeWorld({ listOk: false });
  assert.match(noList.gate().warnings[0], /读不到开着的 issue 列表,这一轮不开/);
  assert.deepEqual(noList.writes(), []);
  const noCreate = makeWorld({ createOk: false });
  const r1 = noCreate.gate();
  assert.equal(noCreate.writes().length, 1, '只试了开 issue');
  assert.match(r1.warnings[0], /issue 没开出来\(HTTP 403\),下一次判门再试/);
  const noComment = makeWorld({ commentOk: false });
  const r2 = noComment.gate();
  assert.deepEqual(r2.gate.taskIssue, { issue: 801, created: true, linked: false });
  assert.match(r2.warnings[0], /#801 已开,关联评论没发出去\(HTTP 502\),下一次判门复用这个 issue 再发/);
});

test('SC4 不开的情况:豁免分支前缀、autoIssue 关、taskIssue 关;dry-run 只记 dryRunActions、不读不写 GitHub 的写端点', () => {
  for (const over of [
    { head: 'chore/changelog-2026-11-12' },
    { features: { mode: 'enforce', autoIssue: { ...DEFAULT_AUTO_ISSUE, mode: 'off' } } },
    { features: { mode: 'off', autoIssue: { ...DEFAULT_AUTO_ISSUE, mode: 'enforce' } } },
  ]) {
    const world = makeWorld(over);
    world.gate();
    assert.deepEqual(world.calls, [], `一次 GitHub 都不读:${JSON.stringify(over)}`);
  }
  const dry = makeWorld({ mode: 'dry-run' });
  const result = dry.gate();
  assert.deepEqual(dry.writes(), []);
  assert.deepEqual(result.dryRunActions, ['auto-task-issue:create']);
});
