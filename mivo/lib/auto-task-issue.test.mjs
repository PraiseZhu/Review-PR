// #246(总 issue #132 D20):每个 Mivo PR 都有任务 issue 对照。认出已有的关联写法、质检修复 PR 沿用被质检 PR 的任务 issue、
// 前置审查发的关联评论;自动开的任务 issue 直接按计划方算;没写任务 issue 的 PR 按模板从 PR 正文生成 issue。
// 三份 PR 夹具是真实 Mivo PR(#2146、#2162、#2190)的标题、正文与改动文件,用来证明模板对真实写法可用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  toTaskIssueLinks, isAutoTaskIssue, toAutoTaskIssue, toAutoIssueConfig, loadTaskIssueMode, readTaskIssue, selectTaskIssue, toChildMaterial, toDerived,
  AUTO_ISSUE_MARKER, AUTO_LINK_MARKER, AUTO_ISSUE_TRUST_NOTE, DEFAULT_AUTO_ISSUE,
} from './task-issue.mjs';

const R = 'o/r';
const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/task-issue/auto-pr-${n}.json`, import.meta.url), 'utf8'));
const links = (body, over = {}) => toTaskIssueLinks({ body, repo: R, pr: 50, ...over });
const nums = (refs) => refs.map((r) => r.number);
const botComment = (body, login = 'praisebuild[bot]') => ({ author: login, isBot: true, body });

// ── SC1 别的关联写法(封闭清单)──
test('SC1 「关联 Issue / 需求：」一行里的编号排在最前,七种写法都认,只认同仓,不含本 PR 号', () => {
  const body = [
    '- 关联 Issue / 需求：子 issue #21，总 issue #20（D13）',
    '- 关联：Refs #31；Refs #32',
    '- 关联需求：#41',
    '- 关联需求：Refs #42',
    'Refs #51',
    'refs #52',
    '任务 #61',
    'issue #71, ISSUE #72',
    'Refs other/repo#99',
    'Refs #50',
  ].join('\n');
  assert.deepEqual(nums(links(body).alt), [21, 20, 31, 32, 41, 42, 51, 52, 61, 71, 72]);
});

test('SC1 清单外的写法不认;代码块和 HTML 注释里的不算;「任务 issue：」行、Closes 关联时选择结果与改动前相同', () => {
  assert.deepEqual(links('见 #5\n相关 #6\n- 关联 #7\ntissue #8\n#9').alt, []);
  assert.deepEqual(links('```\nRefs #5\n```\n<!-- Refs #6 -->').alt, []);
  // 「任务 issue：」行在:selectTaskIssue 只看它(旧行为),别的写法不改变选择
  assert.deepEqual(selectTaskIssue({ body: '任务 issue：o/r#12\nRefs #13', repo: R, pr: 50 }).candidates, [{ repo: R, number: 12 }]);
  assert.deepEqual(nums(links('Closes #3\nfixes o/x#4\nResolved: #5').closingText), [3, 4, 5]);
});

test('SC2 质检来源:正文「QA: #N」或标题「(QA #N)」;指向本 PR 自己的不算', () => {
  assert.equal(links('QA: #2134').qaOrigin, 2134);
  assert.equal(links('QA：#2134').qaOrigin, 2134);
  assert.equal(links('', { title: 'fix: 写入者标记可能碰撞 (QA #2133)' }).qaOrigin, 2133);
  assert.equal(links('', { title: 'fix(3d): 误报失败（QA #2035）' }).qaOrigin, 2035);
  assert.equal(links('QA: #50').qaOrigin, null);
  assert.equal(links('QA 报告 PR-2134 P2').qaOrigin, null);
});

test('SC4a 关联评论:只认配置的机器人账号、标记 PR 号等于本 PR 的那条(取最后一条)', () => {
  const mark = (pr, issue) => `任务 issue：o/r#${issue}\n\n${AUTO_LINK_MARKER(pr, issue)}`;
  assert.deepEqual(links('', { comments: [botComment(mark(50, 900)), botComment(mark(50, 901))] }).autoLink, { repo: R, number: 901 });
  assert.equal(links('', { comments: [{ author: 'praisebuild', isBot: false, body: mark(50, 900) }] }).autoLink, null, '同名普通用户不算');
  assert.equal(links('', { comments: [botComment(mark(50, 900), 'other-app[bot]')] }).autoLink, null, '别的机器人不算');
  assert.equal(links('', { comments: [botComment(mark(49, 900))] }).autoLink, null, '标记 PR 号不对不算');
  // gh/GraphQL 形状的作者对象也认
  assert.deepEqual(links('', { comments: [{ author: { login: 'praisebuild', __typename: 'Bot' }, body: mark(50, 902) }] }).autoLink, { repo: R, number: 902 });
});

// ── SC5 自动任务 issue 的认定 ──
test('SC5 自动任务 issue:机器人作者 + 首行标记 + 标题前缀三项都对上才算', () => {
  const ok = { title: '任务 issue · PR #50 feat: x', body: `${AUTO_ISSUE_MARKER(50)}\n> 子 issue`, author: 'praisebuild', authorType: 'Bot', prs: [50] };
  assert.equal(isAutoTaskIssue(ok), true);
  assert.equal(isAutoTaskIssue({ ...ok, author: 'praisebuild[bot]' }), true);
  assert.equal(isAutoTaskIssue({ ...ok, authorType: 'User' }), false, '同名普通用户开的不算');
  assert.equal(isAutoTaskIssue({ ...ok, authorType: undefined }), false, '读不到作者类型不算');
  assert.equal(isAutoTaskIssue({ ...ok, author: 'other' }), false);
  assert.equal(isAutoTaskIssue({ ...ok, prs: [51] }), false, '别的 PR 的自动 issue 不算');
  assert.equal(isAutoTaskIssue({ ...ok, title: '任务 issue · PR #500 x', body: `${AUTO_ISSUE_MARKER(50)}` }), false, '标题 PR 号多一位不算');
  assert.equal(isAutoTaskIssue({ ...ok, title: '[子] x' }), false);
  assert.equal(isAutoTaskIssue({ ...ok, body: `> 子 issue\n${AUTO_ISSUE_MARKER(50)}` }), false, '标记不在首行不算');
  assert.equal(isAutoTaskIssue({ ...ok, prs: [49, 50] }), true, '质检修复 PR 沿用来源 PR 的自动 issue');
});

// ── 读材料:假 gh ──
const CHILD = '> 子 issue\n\n## 目标\n\n做 x。\n\n## 范围（可改）\n\n- `src/x.ts`：改\n\n## 不做\n\n- 不改 y。\n\n## 依赖\n\n无\n\n## 验收标准\n\n- [ ] SC1 x 成立。验证：unit\n';
const node = (number, over = {}) => ({ number, title: `[子] 任务 ${number}`, url: `https://github.com/${R}/issues/${number}`, body: CHILD, createdAt: '2026-11-01T00:00:00Z',
  author: { login: 'PraiseZhu', __typename: 'User' }, userContentEdits: { nodes: [] }, comments: { nodes: [] }, timelineItems: { totalCount: 0, nodes: [] }, ...over });
// issues:GraphQL 形状的 issue 节点;prs:是 PR 的编号;pulls:质检来源 PR {title, body, comments};parents:子 issue 号 → 总 issue 号。
function fakeGh({ issues = {}, rest = {}, failIssue = [], prs = [], pulls = {}, failPull = [], parents = {}, closing = [] } = {}) {
  const calls = [];
  const notFound = (n) => ({ type: 'NOT_FOUND', message: `Could not resolve to an issue or pull request with the number of ${n}.` });
  const fn = (args, options = {}) => {
    if (args[1] === 'graphql') {
      const q = JSON.parse(options.input ?? '{}');
      const n = q.variables?.number;
      if (/closingIssuesReferences/.test(q.query)) {
        calls.push(['closing', n]);
        return { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: closing.map((c) => ({ number: c, title: issues[c]?.title ?? null, url: `https://github.com/${R}/issues/${c}` })) } } } } }) };
      }
      if (/p0:issueOrPullRequest/.test(q.query)) {
        const numbers = [0, 1, 2, 3].map((i) => q.variables[`n${i}`]);
        calls.push(['probe', numbers]);
        const repository = Object.fromEntries(numbers.map((m, i) => [`p${i}`, issues[m] ? { __typename: 'Issue', number: m, title: issues[m].title } : prs.includes(m) || m in pulls ? { __typename: 'PullRequest' } : null]));
        const errors = numbers.filter((m) => !issues[m] && !prs.includes(m) && !(m in pulls)).map(notFound);
        return { ok: !errors.length, stdout: JSON.stringify({ data: { repository }, ...(errors.length ? { errors } : {}) }) };
      }
      if (/on PullRequest\{number title body comments/.test(q.query)) {
        calls.push(['qa', n]);
        if (failPull.includes(n)) return { ok: false, stdout: '', stderr: 'HTTP 502' };
        const hit = pulls[n] ? { __typename: 'PullRequest', number: n, title: pulls[n].title ?? '', body: pulls[n].body ?? '', comments: { nodes: pulls[n].comments ?? [] } } : issues[n] ? { __typename: 'Issue' } : null;
        return { ok: Boolean(hit), stdout: JSON.stringify({ data: { repository: { issueOrPullRequest: hit } }, ...(hit ? {} : { errors: [notFound(n)] }) }) };
      }
      if (/timelineItems/.test(q.query)) {
        calls.push(['issue', n]);
        if (failIssue.includes(n)) return { ok: false, stdout: '', stderr: 'HTTP 502' };
        return { ok: true, stdout: JSON.stringify({ data: { repository: { issue: issues[n] ?? null } }, ...(issues[n] ? {} : { errors: [{ type: 'NOT_FOUND', message: `Could not resolve to an Issue with the number of ${n}.` }] }) }) };
      }
      if (/userContentEdits/.test(q.query)) { calls.push(['parent', n]); return { ok: true, stdout: JSON.stringify({ data: { repository: { issue: issues[n] ?? null } } }) }; }
      calls.push(['graphql-other', n]);
      return { ok: true, stdout: JSON.stringify({ data: { repository: { issue: null } } }) };
    }
    const path = args[1];
    calls.push(['rest', path]);
    if (path in rest) return rest[path] === null ? { ok: false, stdout: '', stderr: 'HTTP 502' } : { ok: true, stdout: JSON.stringify(rest[path]) };
    const parentOf = /issues\/(\d+)\/parent$/.exec(path);
    if (parentOf && parents[parentOf[1]]) return { ok: true, stdout: JSON.stringify({ number: parents[parentOf[1]], html_url: `https://github.com/${R}/issues/${parents[parentOf[1]]}` }) };
    if (parentOf) return { ok: false, stdout: JSON.stringify({ message: 'No parent issue found', status: '404' }), stderr: 'gh: No parent issue found (HTTP 404)' };
    return { ok: false, stdout: '', stderr: `unexpected ${path}` };
  };
  return { fn, calls };
}
const readWith = (over, gh) => readTaskIssue({ repo: R, pr: 50, prBody: '', prCreatedAt: '2026-11-05T00:00:00Z', baseRefName: 'main', headRefName: 'feat/x',
  files: ['src/x.ts'], maintainers: ['PraiseZhu'], mode: 'enforce', ghFn: gh.fn, ...over });

test('SC1 别的写法:指向的是 PR 或不存在时跳过、接着试下一个;读到的 issue 照常读,via 记 ref', () => {
  const gh = fakeGh({ issues: { 22: node(22) } });
  const m = readWith({ prBody: '- 关联 Issue / 需求：缓解 #21 的超时；Refs #22' }, gh);
  assert.equal(m.status, 'read');
  assert.equal(m.ref, `${R}#22`);
  assert.equal(m.via, 'ref');
  assert.deepEqual(m.excluded, [{ ref: `${R}#21`, reason: '不是 issue(PR 或不存在)' }]);
  assert.equal(m.issue.trust, 'plan');
  assert.deepEqual(gh.calls.filter((c) => c[0] === 'probe' || c[0] === 'issue').map((c) => c[0]), ['probe', 'issue'], '两个候选先批量认一次,只读认出的 #22');
  // 都不是 issue → 没关联(不是读不到)
  const none = readWith({ prBody: 'Refs #21' }, fakeGh());
  assert.deepEqual([none.status, none.via], ['unlinked', null]);
  // 真正的读取失败 → 读不到
  assert.equal(readWith({ prBody: 'Refs #22' }, fakeGh({ failIssue: [22] })).status, 'unreadable');
});

test('SC1 「任务 issue：」行指向 PR 时仍按读不到算(严格,与改动前一致),不往下找别的写法', () => {
  const m = readWith({ prBody: '任务 issue：o/r#21\nRefs #22' }, fakeGh({ issues: { 22: node(22) } }));
  assert.equal(m.status, 'unreadable');
});

test('SC2 质检修复 PR:读被质检 PR 的正文和评论,沿用它的任务 issue,via 记 qa-origin;来源读不到记缺口、按没关联处理', () => {
  const origin = { title: 'fix: 旧格式档案超限', body: '任务 issue：o/r#2130', comments: [] };
  const gh = fakeGh({ issues: { 2130: node(2130) }, pulls: { 2134: origin } });
  const m = readWith({ prBody: 'QA: #2134', prTitle: 'fix: 增量保存 TOO_LARGE (QA #2134)' }, gh);
  assert.deepEqual([m.status, m.ref, m.via], ['read', `${R}#2130`, 'qa-origin']);
  // 来源 PR 只有关联评论(自动 issue)
  const auto = node(3000, { title: '任务 issue · PR #2134 fix: 旧格式档案超限', body: `${AUTO_ISSUE_MARKER(2134)}\n${CHILD}`, author: { login: 'praisebuild', __typename: 'Bot' } });
  const gh2 = fakeGh({ issues: { 3000: auto }, pulls: { 2134: { ...origin, body: '', comments: [{ author: { login: 'praisebuild', __typename: 'Bot' }, body: AUTO_LINK_MARKER(2134, 3000) }] } } });
  const m2 = readWith({ prBody: 'QA: #2134' }, gh2);
  assert.deepEqual([m2.status, m2.ref, m2.via, m2.issue.trust, m2.issue.autoIssue], ['read', `${R}#3000`, 'qa-origin', 'plan', true], '来源 PR 的自动 issue 也按计划方算');
  // 来源读不到
  const m3 = readWith({ prBody: 'QA: #2134' }, fakeGh({ failPull: [2134] }));
  assert.equal(m3.status, 'unlinked');
  assert.ok(m3.gaps.some((g) => /质检来源 PR #2134:读不到/.test(g)), JSON.stringify(m3.gaps));
});

test('SC4a/SC5 关联评论指向自动 issue:via 记 auto,直接按计划方算并写明来源;被非维护者改过、标记不对、作者是同名普通用户都按作者陈述', () => {
  const autoNode = (over = {}) => node(900, { title: '任务 issue · PR #50 feat: x', body: `${AUTO_ISSUE_MARKER(50)}\n${CHILD}`, author: { login: 'praisebuild', __typename: 'Bot' }, ...over });
  const comments = [botComment(AUTO_LINK_MARKER(50, 900))];
  const m = readWith({ prComments: comments }, fakeGh({ issues: { 900: autoNode() } }));
  assert.deepEqual([m.status, m.via, m.issue.trust, m.issue.autoIssue, m.issue.trustNote], ['read', 'auto', 'plan', true, AUTO_ISSUE_TRUST_NOTE]);
  // 开 PR 后被非维护者(PR 作者)改过
  const edited = readWith({ prComments: comments }, fakeGh({ issues: { 900: autoNode({ userContentEdits: { totalCount: 1, nodes: [{ editedAt: '2026-11-06T00:00:00Z', editor: { login: 'aj0928' } }] } }) } }));
  assert.deepEqual([edited.issue.trust, edited.issue.trustNote], ['author', '开 PR 后非维护者改过']);
  // 机器人自己的编辑不算
  const botEdit = readWith({ prComments: comments }, fakeGh({ issues: { 900: autoNode({ userContentEdits: { totalCount: 1, nodes: [{ editedAt: '2026-11-06T00:00:00Z', editor: { login: 'praisebuild' } }] } }) } }));
  assert.equal(botEdit.issue.trust, 'plan');
  // 标记是别的 PR
  assert.equal(readWith({ prComments: comments }, fakeGh({ issues: { 900: autoNode({ body: `${AUTO_ISSUE_MARKER(49)}\n${CHILD}` }) } })).issue.trust, 'author');
  // 同名普通用户
  assert.equal(readWith({ prComments: comments }, fakeGh({ issues: { 900: autoNode({ author: { login: 'praisebuild', __typename: 'User' } }) } })).issue.trust, 'author');
  // 别人发的同样评论不算关联
  assert.equal(readWith({ prComments: [{ author: 'aj0928', isBot: false, body: AUTO_LINK_MARKER(50, 900) }] }, fakeGh({ issues: { 900: autoNode() } })).status, 'unlinked');
});

test('SC4a 顺序:「任务 issue：」行、别的写法都优先于关联评论', () => {
  const comments = [botComment(AUTO_LINK_MARKER(50, 900))];
  const gh = fakeGh({ issues: { 22: node(22), 12: node(12), 900: node(900) } });
  assert.equal(readWith({ prBody: '任务 issue：o/r#12', prComments: comments }, gh).ref, `${R}#12`);
  assert.equal(readWith({ prBody: 'Refs #22', prComments: comments }, gh).ref, `${R}#22`);
  assert.equal(readWith({ prBody: '', prComments: comments }, gh).ref, `${R}#900`);
});

test('SC1 「任务 issue：」行或 Closes 指向的都是维护者确认 issue:按没有这些行接着认别的写法、质检来源和关联评论;都没有才是未关联', () => {
  const confirm = (n) => node(n, { title: `维护者确认 · PR #50 是否改 x` });
  const viaRef = readWith({ prBody: '任务 issue：o/r#30\nRefs #22' }, fakeGh({ issues: { 30: confirm(30), 22: node(22) } }));
  assert.deepEqual([viaRef.status, viaRef.ref, viaRef.via], ['read', `${R}#22`, 'ref']);
  assert.deepEqual(viaRef.excluded, [{ ref: `${R}#30`, reason: '维护者确认 issue' }]);
  const viaAuto = readWith({ prBody: '任务 issue：o/r#30', prComments: [botComment(AUTO_LINK_MARKER(50, 900))] }, fakeGh({ issues: { 30: confirm(30), 900: node(900) } }));
  assert.deepEqual([viaAuto.status, viaAuto.ref, viaAuto.via], ['read', `${R}#900`, 'auto']);
  const viaClosing = readWith({ prBody: 'Refs #22' }, fakeGh({ issues: { 31: confirm(31), 22: node(22) }, closing: [31] }));
  assert.deepEqual([viaClosing.status, viaClosing.ref], ['read', `${R}#22`]);
  const none = readWith({ prBody: '任务 issue：o/r#30' }, fakeGh({ issues: { 30: confirm(30) } }));
  assert.deepEqual([none.status, none.via], ['unlinked', null]);
  // 关联评论指向的 issue 不存在(被删)→ 未关联,前置审查会补开
  assert.equal(readWith({ prComments: [botComment(AUTO_LINK_MARKER(50, 901))] }, fakeGh()).status, 'unlinked');
});

test('SC2a 3 个指向 PR 的写法 + 质检来源 PR(它的任务 issue 有总 issue):批量认 1 次,任务 issue 和总 issue 都读到,不超过 8 次、没有缺口', () => {
  const parent = node(2100, { title: '[总] 大任务', body: '## 子 issue\n\n- [ ] o/r#2130 子任务\n' });
  const gh = fakeGh({ issues: { 2130: node(2130), 2100: parent }, prs: [21, 23, 24], pulls: { 2134: { title: 'fix: 来源', body: '任务 issue：o/r#2130' } }, parents: { 2130: 2100 } });
  const m = readWith({ prBody: 'QA: #2134\n关联：#21\nRefs #23\nissue #24' }, gh);
  assert.deepEqual([m.status, m.ref, m.via, m.parent?.ref], ['read', `${R}#2130`, 'qa-origin', `${R}#2100`]);
  assert.deepEqual(m.gaps, []);
  assert.ok(m.requests <= 8, `用了 ${m.requests} 次`);
  assert.deepEqual(gh.calls.map((c) => c[0]), ['closing', 'probe', 'qa', 'issue', 'rest', 'parent']);
  // 来源 PR 也有多个候选:再批量认一次,仍读到总 issue
  const gh2 = fakeGh({ issues: { 2130: node(2130), 2100: parent }, prs: [21, 23, 24, 25], pulls: { 2134: { title: 'fix: 来源', body: 'Refs #25\nissue #2130' } }, parents: { 2130: 2100 } });
  const m2 = readWith({ prBody: 'QA: #2134\n关联：#21\nRefs #23\nissue #24' }, gh2);
  assert.deepEqual([m2.status, m2.ref, m2.parent?.ref, m2.gaps], ['read', `${R}#2130`, `${R}#2100`, []]);
  assert.deepEqual(gh2.calls.map((c) => c[0]), ['closing', 'probe', 'qa', 'probe', 'issue', 'rest', 'parent']);
});

test('SC2a 找候选的请求给任务 issue、依赖、总 issue 关系、总 issue 留出次数:用不了时记缺口、按读不到算,不把后面的读取挤掉', () => {
  const confirm = (n) => node(n, { title: `维护者确认 · PR #50 x` });
  // 预算 4:Closes 之后再批量认会占掉留给后面的次数 → 不认,按读不到算,缺口写明原因
  const gh = fakeGh({ issues: { 22: node(22) }, prs: [21] });
  const m = readWith({ prBody: 'Refs #21\nRefs #22', budget: { requests: 4, ms: 20_000 } }, gh);
  assert.equal(m.status, 'unreadable');
  assert.ok(m.gaps.some((g) => /4 次请求要留 3 次给后面的读取/.test(g)), JSON.stringify(m.gaps));
  assert.deepEqual(gh.calls.map((c) => c[0]), ['closing']);
  // 两行「任务 issue：」都是维护者确认 issue(2 次)+ 别的写法批量认(1 次)+ 选中的读(1 次)= 4 次,剩下的 3 次够读依赖之外的总 issue 关系和总 issue
  const gh2 = fakeGh({ issues: { 30: confirm(30), 31: confirm(31), 22: node(22), 2100: node(2100, { title: '[总] x' }) }, prs: [21], parents: { 22: 2100 } });
  const m2 = readWith({ prBody: '任务 issue：o/r#30\n任务 issue：o/r#31\nRefs #21\nRefs #22' }, gh2);
  assert.deepEqual([m2.status, m2.ref, m2.parent?.ref, m2.requests], ['read', `${R}#22`, `${R}#2100`, 6]);
});

test('locateOnly:找到任务 issue 就停,不读依赖、总 issue 关系和总 issue(前置审查用)', () => {
  const gh = fakeGh({ issues: { 22: node(22) }, parents: { 22: 2100 } });
  const m = readWith({ prBody: 'Refs #22', locateOnly: true }, gh);
  assert.deepEqual([m.status, m.ref, m.via, m.issue.ref, m.parent], ['read', `${R}#22`, 'ref', `${R}#22`, null]);
  assert.deepEqual(gh.calls.map((c) => c[0]), ['closing', 'issue']);
});

test('SC2 质检来源 PR 的「任务 issue：」行按严格规则认:指向 PR 就按来源没有任务 issue 算,不改认它的别的写法;只因维护者确认 issue 落空才接着认', () => {
  const pulls = (body) => ({ 2134: { title: 'fix: 来源', body } });
  const miss = readWith({ prBody: 'QA: #2134' }, fakeGh({ issues: { 51: node(51) }, prs: [50], pulls: pulls('任务 issue：o/r#50\nRefs #51') }));
  assert.deepEqual([miss.status, miss.ref], ['unlinked', null], '不选来源 PR 的 Refs #51');
  assert.ok(miss.excluded.some((e) => e.ref === `${R}#50` && /质检来源 PR #2134 的「任务 issue：」行或 Closes 指向的不是 issue/.test(e.reason)), JSON.stringify(miss.excluded));
  // 本 PR 自己有关联评论时,来源落空后照常认它
  const auto = readWith({ prBody: 'QA: #2134', prComments: [botComment(AUTO_LINK_MARKER(50, 900))] }, fakeGh({ issues: { 51: node(51), 900: node(900) }, prs: [50], pulls: pulls('任务 issue：o/r#50\nRefs #51') }));
  assert.deepEqual([auto.status, auto.ref, auto.via], ['read', `${R}#900`, 'auto']);
  // 来源的「任务 issue：」行只指向维护者确认 issue → 接着认来源的别的写法
  const confirmed = readWith({ prBody: 'QA: #2134' }, fakeGh({ issues: { 52: node(52, { title: '维护者确认 · PR #2134 x' }), 51: node(51) }, pulls: pulls('任务 issue：o/r#52\nRefs #51') }));
  assert.deepEqual([confirmed.status, confirmed.ref, confirmed.via], ['read', `${R}#51`, 'qa-origin']);
  // 来源的「任务 issue：」行指向 issue → 读它
  const hit = readWith({ prBody: 'QA: #2134' }, fakeGh({ issues: { 53: node(53), 51: node(51) }, pulls: pulls('任务 issue：o/r#53\nRefs #51') }));
  assert.deepEqual([hit.status, hit.ref, hit.via], ['read', `${R}#53`, 'qa-origin']);
});

test('SC4 前置审查只定位(locateOnly)与审查机对同一 PR 的结论一致,包括请求次数接近上限时', () => {
  const confirm = (n) => node(n, { title: '维护者确认 · PR #50 x' });
  const scenarios = [
    // 复审给的场景:两行「任务 issue：」和一个别的写法都是维护者确认 issue、一个别的写法是 PR,再从来源 PR 的两个候选里找
    { prBody: 'QA: #2134\n任务 issue：o/r#30\n任务 issue：o/r#31\nRefs #32\nRefs #33', gh: { issues: { 30: confirm(30), 31: confirm(31), 32: confirm(32), 60: node(60) }, prs: [33, 59], pulls: { 2134: { title: 'x', body: 'Refs #59\nissue #60' } } } },
    { prBody: 'QA: #2134\n关联：#21\nRefs #23\nissue #24', gh: { issues: { 2130: node(2130) }, prs: [21, 23, 24], pulls: { 2134: { title: 'x', body: '任务 issue：o/r#2130' } } } },
    { prBody: 'Refs #21\nRefs #22', gh: { issues: { 22: node(22) }, prs: [21] } },
    { prBody: '任务 issue：o/r#21', gh: { prs: [21] } },
    { prBody: '', prComments: [botComment(AUTO_LINK_MARKER(50, 901))], gh: {} },
  ];
  for (const { gh, ...over } of scenarios) {
    const server = readWith(over, fakeGh(gh));
    const mini = readWith({ ...over, locateOnly: true }, fakeGh(gh));
    const pick = (m) => [m.status === 'partial' ? 'read' : m.status, m.ref, m.via];
    assert.deepEqual(pick(mini), pick(server), over.prBody);
  }
});

// ── SC3 按模板生成 ──
const HEADINGS = ['## 目标', '## 范围', '## 不做', '## 依赖', '## 验收标准'];
// 与 check-pr-issue.sh 同一套检查:五个二级标题都在行首;验收标准有 SC<n> 编号项。
const passesIssueCheck = (body) => HEADINGS.every((h) => new RegExp(`^${h}`, 'm').test(body)) && /^\s*[-*]\s*(\[[ xX]\])?\s*(\*\*)?SC[0-9]+\b/m.test(body);

test('SC3 三份真实 PR:标题、首行标记、五段校验、改动文件、验收标准都对;生成的 issue 认作自动 issue', () => {
  for (const n of [2146, 2162, 2190]) {
    const p = fixture(n);
    const out = toAutoTaskIssue({ repo: 'xindong/mivo-canvas-plugin', pr: n, title: p.title, author: p.author, body: p.body, files: p.files });
    assert.equal(out.title, `任务 issue · PR #${n} ${p.title}`);
    assert.equal(out.body.split('\n')[0], AUTO_ISSUE_MARKER(n));
    assert.match(out.body.split('\n')[1], new RegExp(`^> 子 issue · 前置审查按 PR #${n}（作者 @${p.author}）自动整理，内容取自 PR 正文；维护者可以直接修改。`));
    assert.ok(passesIssueCheck(out.body), `#${n} 通不过五段校验`);
    const c = toChildMaterial(out.body);
    assert.ok(c.sections.目标.startsWith(p.title), `#${n} 目标以 PR 标题开头`);
    // 每个改动文件都落在范围里:审查机按同一份 issue 算越界文件,应为空(#2146 改了 52 个文件,逐个列出)
    assert.deepEqual(toDerived({ child: c, files: p.files, pr: n }).scopeOutside, [], `#${n} 有改动文件被算成越界`);
    assert.ok(c.scList.length >= 1 && c.scList.every((s) => ['unit', 'cindy-mac', 'static'].includes(s.layer)), `#${n} 验收标准 ${JSON.stringify(c.scList.map((s) => s.layer))}`);
    assert.ok(Buffer.byteLength(out.body) <= 60 * 1024);
    assert.equal(isAutoTaskIssue({ title: out.title, body: out.body, author: 'praisebuild', authorType: 'Bot', prs: [n], autoAuthor: DEFAULT_AUTO_ISSUE.author }), true);
  }
});

test('SC3 真实写法的取法:「命令/结果」一对一条;代码块里一行一条;「实际任务验证」三字段合成一条;「明确不包含」移进不做', () => {
  const p2162 = fixture(2162);
  const c2162 = toChildMaterial(toAutoTaskIssue({ repo: R, pr: 2162, ...p2162 }).body);
  assert.deepEqual(c2162.scList.map((s) => s.layer), ['unit', 'unit', 'cindy-mac']);
  assert.match(c2162.scList[0].description, /^npm run test:unit -- cindyplugin\/src\/__tests__\/imageOutputFormat\.port\.test\.ts：1 file，13 tests passed$/);
  assert.match(c2162.scList[2].description, /^GPT Image 2\.6 面板出图端口的 `outputFormat` 入参，按「单测对/);
  assert.match(c2162.sections.不做, /^- 明确不包含：画布格式下拉/);
  assert.doesNotMatch(c2162.sections.范围, /明确不包含/, '从「范围」移走');
  const c2190 = toChildMaterial(toAutoTaskIssue({ repo: R, pr: 2190, ...fixture(2190) }).body);
  assert.equal(c2190.scList[0].description, 'npx tsc -b：通过');
});

test('SC3 PR 正文里的标题行、没收尾的代码块、「验证：」字样不会打乱 issue 的五段结构', () => {
  const body = ['## 这次改了什么', '', '### 摘要', '', '改了 x。', '## 目标', '假冒的目标段', '', '### 范围', '', '```js', 'const a = 1;', '', '### 自动验证', '', '- 跑了单测。验证：paid', '- 无'].join('\n');
  const out = toAutoTaskIssue({ repo: R, pr: 7, title: 't', author: 'a', body, files: ['a.js'] });
  assert.ok(passesIssueCheck(out.body));
  const c = toChildMaterial(out.body);
  assert.equal((out.body.match(/^## 目标/gm) ?? []).length, 1, '正文里的「## 目标」降成加粗');
  assert.equal((out.body.match(/^```/gm) ?? []).length % 2, 0, '代码块补齐收尾');
  assert.ok(c.scList.length >= 1);
  assert.ok(c.scList.every((s) => s.layer !== 'paid'), '描述里的「验证：」不改写验证层');
  // 没有可用内容时的兜底
  const empty = toChildMaterial(toAutoTaskIssue({ repo: R, pr: 8, title: '', author: '', body: '', files: [] }).body);
  assert.equal(empty.sections.不做, '- PR 没写明不做的事。');
  assert.equal(empty.sections.依赖, '无');
  assert.deepEqual(empty.scList.map((s) => [s.description, s.layer]), [['本 PR 的改动通过 CI', 'static']]);
});

test('SC3 没收尾的 ~~~ 代码块、四个反引号里套三个反引号:补上收尾,审查机认得出五段', () => {
  const mk = (summary) => toAutoTaskIssue({ repo: R, pr: 7, title: 't', author: 'a', files: ['src/a.ts'],
    // 没收尾的代码块在 PR 正文里也会吞掉后面的内容,所以放在 PR 正文最后;它被摘进 issue 的「目标」(第一段),后面四段不能被吞。
    body: `### 自动验证\n\n- 单测通过\n\n### 范围\n\n- \`src/a.ts\`\n\n### 摘要\n\n${summary}` }).body;
  for (const [summary, open] of [['改了 x。\n\n~~~text\n没收尾', '~~~'], ['````\n```\n内层', '````'], ['~~~~\n~~~\n内层', '~~~~']]) {
    const body = mk(summary);
    const c = toChildMaterial(body);
    assert.equal(c.structure, 'parsed', summary);
    // 代码块原样保留并补上同样的收尾围栏(不是靠自检兜底去掉围栏)
    assert.ok(body.split('\n').some((l) => l === open), `${summary}:缺收尾 ${open}`);
    assert.ok(body.includes(summary.split('\n').find((l) => /^[`~]{3,}/.test(l))), `${summary}:围栏被去掉了`);
    assert.deepEqual(c.scList.map((s) => s.description), ['单测通过'], summary);
  }
});

test('SC3 正文超过 60 KB:各段按比例截短并写明,五段和验收标准都在(复审回放 61 KB 的写法)', () => {
  const cjk = (n) => '中'.repeat(n);
  const body = [`### 摘要\n\n${cjk(4000)}`, `### 范围\n\n${cjk(6000)}`, `### 不做\n\n${cjk(4000)}`,
    `### 自动验证\n\n${Array.from({ length: 40 }, (_, i) => `- 检查 ${i} ${cjk(300)}`).join('\n')}`].join('\n\n');
  const out = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body, files: ['src/a.ts'], });
  assert.ok(Buffer.byteLength(out.body) <= 60 * 1024, `${Buffer.byteLength(out.body)} 字节`);
  const c = toChildMaterial(out.body);
  assert.equal(c.structure, 'parsed');
  assert.ok(c.sections.不做.startsWith('中'), '「不做」段还在');
  assert.ok(c.scList.length >= 1);
  assert.match(out.body, /PR 正文较长，各段已按比例截短，完整内容见 PR #9。/);
});

test('SC3 「范围」下面的「范围外」小节只进「不做」,它列的路径不算可改范围', () => {
  const body = '### 摘要\n\n改 a。\n\n### 范围\n\n- `src/a.ts`\n\n#### 范围外\n\n- `src/b.ts` 不动\n\n### 自动验证\n\n- 单测通过';
  const out = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body, files: ['src/a.ts'] });
  const c = toChildMaterial(out.body);
  assert.doesNotMatch(c.sections.范围, /src\/b\.ts/);
  assert.equal((out.body.match(/src\/b\.ts/g) ?? []).length, 1);
  assert.match(c.sections.不做, /src\/b\.ts/);
  assert.deepEqual(toDerived({ child: c, files: ['src/a.ts', 'src/b.ts'], pr: 9 }).scopeOutside, ['src/b.ts']);
});

test('SC3 自检认不出结构:先去掉代码块围栏重排,仍认不出只留改动文件清单和一条 CI 验收', () => {
  const body = '### 摘要\n\n改了 x。\n\n```\ncode\n```\n\n### 自动验证\n\n- 单测通过';
  const safe = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body, files: ['src/a.ts'], parses: (text) => !text.includes('```') });
  assert.doesNotMatch(safe.body, /```/);
  assert.match(safe.body, /改了 x。/);
  const bare = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body, files: ['src/a.ts'], parses: (text) => !text.includes('改了') });
  const c = toChildMaterial(bare.body);
  assert.equal(c.structure, 'parsed');
  assert.match(bare.body, /PR 正文的内容没能按模板整理进来，以 PR #9 为准。/);
  assert.match(c.sections.范围, /`src\/a\.ts`：本 PR 改动/);
  assert.deepEqual(c.scList.map((s) => [s.description, s.layer]), [['本 PR 的改动通过 CI', 'static']]);
});

test('SC3 改动文件逐个列出;逐个列超过 40 KB 才按目录合并(先合较细的目录)并写明合并的目录里之后新加的文件也算在范围内', () => {
  const few = Array.from({ length: 50 }, (_, i) => `pkg${i % 5}/${'x'.repeat(440)}/sub${i % 10}/file-${i}.ts`);
  const listed = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body: '### 自动验证\n\n- 单测通过', files: few });
  assert.equal(listed.body.split('\n').filter((l) => /^- `.*`：本 PR 改动$/.test(l)).length, 50, '24 KB 放得下:逐个列');
  assert.doesNotMatch(listed.body, /按目录合并/);
  const many = Array.from({ length: 100 }, (_, i) => `pkg${i % 5}/${'x'.repeat(440)}/sub${i % 10}/file-${i}.ts`);
  const out = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body: '### 自动验证\n\n- 单测通过', files: many });
  const c = toChildMaterial(out.body);
  assert.equal(c.structure, 'parsed');
  assert.match(out.body, /共 100 个，逐个列超过 40 KB，按目录合并；合并的目录里，开 issue 之后新加的文件也算在范围内/);
  assert.match(out.body, /^- `pkg0\/x+\/sub0\/`：本 PR 改动（10 个文件）$/m, '先按较细的目录合并,不一下合到顶层');
  assert.doesNotMatch(out.body, /`\*\*/, '不写通配路径');
  assert.deepEqual(toDerived({ child: c, files: many, pr: 9 }).scopeOutside, []);
});

test('SC3 改动文件逐个列出:开 issue 后新加的文件(同目录或别的目录)都算超出范围,不写放宽范围的通配(复审回放:80 个长名顶层目录;60 个根目录文件)', () => {
  for (const files of [Array.from({ length: 80 }, (_, i) => `top${i}-${'y'.repeat(300)}/f.ts`), Array.from({ length: 60 }, (_, i) => `file-${i}.ts`)]) {
    const out = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body: '### 自动验证\n\n- 单测通过', files });
    const c = toChildMaterial(out.body);
    assert.equal(c.structure, 'parsed');
    assert.ok(Buffer.byteLength(out.body) <= 60 * 1024);
    assert.equal(out.body.split('\n').filter((l) => /^- `.*`：本 PR 改动/.test(l)).length, files.length, '逐个列全');
    assert.doesNotMatch(out.body, /`\*\*/, '不写通配路径');
    assert.deepEqual(toDerived({ child: c, files, pr: 9 }).scopeOutside, [], `${files.length} 个文件都在范围里`);
    const sameDir = files[0].includes('/') ? `${files[0].split('/')[0]}/unplanned-after-issue.ts` : 'unplanned-after-issue.ts';
    assert.deepEqual(toDerived({ child: c, files: [...files, 'unplanned/after-issue.ts', sameDir], pr: 9 }).scopeOutside, ['unplanned/after-issue.ts', sameDir].sort(), '开 issue 后新加的文件算超出范围');
  }
});

test('SC3 顶层清单接近 40 KB 时整份仍不超过 60 KB;超过 40 KB(issue 放不下)返回 null,不开自动 issue', () => {
  const big = `### 摘要\n\n${'中'.repeat(4000)}\n\n### 范围\n\n${'中'.repeat(6000)}\n\n### 自动验证\n\n${Array.from({ length: 40 }, (_, i) => `- 检查 ${i} ${'中'.repeat(300)}`).join('\n')}`;
  const near = Array.from({ length: 110 }, (_, i) => `top${i}-${'y'.repeat(300)}/f.ts`);
  const out = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body: big, files: near });
  assert.ok(Buffer.byteLength(out.body) <= 60 * 1024, `${Buffer.byteLength(out.body)} 字节`);
  const c = toChildMaterial(out.body);
  assert.equal(c.structure, 'parsed');
  assert.deepEqual(toDerived({ child: c, files: near, pr: 9 }).scopeOutside, []);
  const over = Array.from({ length: 150 }, (_, i) => `top${i}-${'y'.repeat(300)}/f.ts`);
  assert.equal(toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body: '### 自动验证\n\n- 单测通过', files: over }), null);
});

test('SC3 验收描述:1000 字以内原样保留;超过的以「…」结尾并在「原因」写明;超过 40 条的写明没列出几条', () => {
  const long = `检查 ${'长'.repeat(500)} MUST_KEEP_TAIL`;
  const kept = toChildMaterial(toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body: `### 自动验证\n\n- ${long}`, files: ['a.ts'] }).body);
  assert.match(kept.scList[0].description, /MUST_KEEP_TAIL$/, '500 字的验收描述不截');
  const huge = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body: `### 自动验证\n\n- 检查 ${'长'.repeat(1200)} TAIL`, files: ['a.ts'] }).body;
  const c = toChildMaterial(huge);
  assert.match(c.scList[0].description, /…$/);
  assert.match(huge, /有 1 条验收描述超过 1000 字，已截短（以「…」结尾），完整内容见 PR #9 正文。/);
  const many = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body: `### 自动验证\n\n${Array.from({ length: 45 }, (_, i) => `- 检查 ${i}`).join('\n')}`, files: ['a.ts'] }).body;
  assert.equal(toChildMaterial(many).scList.length, 40);
  assert.match(many, /另有 5 条验收项没列出，完整内容见 PR #9 正文。/);
});

test('SC3 超长 PR:120 个改动文件逐个列出,同目录之后新加的文件算超出范围;整份正文不超过 60 KB(复审回放:src/ 下新加文件)', () => {
  const files = Array.from({ length: 120 }, (_, i) => `src/m${i % 70}/file-${i}.ts`);
  const huge = `### 摘要\n\n${'很长的摘要。'.repeat(3000)}\n\n### 自动验证\n\n${Array.from({ length: 80 }, (_, i) => `- 检查 ${i} ${'x'.repeat(400)}`).join('\n')}`;
  const out = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body: huge, files });
  assert.ok(Buffer.byteLength(out.body) <= 60 * 1024);
  assert.equal(out.body.split('\n').filter((l) => /^- `src\/.*`：本 PR 改动$/.test(l)).length, 120);
  assert.ok(passesIssueCheck(out.body));
  const c = toChildMaterial(out.body);
  assert.deepEqual(toDerived({ child: c, files, pr: 9 }).scopeOutside, [], '每个文件都在范围里');
  assert.deepEqual(toDerived({ child: c, files: [...files, 'src/unplanned/after-issue.ts'], pr: 9 }).scopeOutside, ['src/unplanned/after-issue.ts']);
  assert.ok(c.scList.length <= 40);
});

// ── 开关 ──
test('开关:taskIssue.autoIssue 缺省 off;字段不合法用默认值并告警;mode 不合法按 off;仓库配置为 enforce', () => {
  assert.deepEqual(toAutoIssueConfig(undefined), { config: DEFAULT_AUTO_ISSUE, warning: null });
  assert.equal(toAutoIssueConfig({ mode: 'on' }).config.mode, 'off');
  assert.match(toAutoIssueConfig({ mode: 'on' }).warning, /mode 不合法,自动开任务 issue 按 off 处理/);
  assert.equal(toAutoIssueConfig({ mode: 'enforce', author: 'praisebuild' }).config.author, 'praisebuild[bot]', 'author 必须是 <name>[bot]');
  assert.deepEqual(toAutoIssueConfig({ mode: 'enforce', exemptHeadPrefixes: 'chore/' }).config.exemptHeadPrefixes, DEFAULT_AUTO_ISSUE.exemptHeadPrefixes);
  assert.equal(loadTaskIssueMode('x', () => '{"taskIssue":{"mode":"enforce"}}').autoIssue.mode, 'off');
  const repo = loadTaskIssueMode(new URL('../config/review-features.json', import.meta.url));
  assert.deepEqual([repo.autoIssue.mode, repo.autoIssue.author, repo.autoIssue.exemptHeadPrefixes], ['enforce', 'praisebuild[bot]', ['chore/changelog-']]);
});

// Mivo 的 Slack 通报(xindong/mivo-canvas-plugin#2205,PR #2206 的 AUTO_TASK_AUTHOR_RE)从第二行固定句取 PR 作者:
// 只收 GitHub 用户名字符,机器人带 [bot]。这里用同一条正则核对,对不上通报就写「作者未注明」。
test('SC3 第二行的作者写法能被 Mivo Slack 通报认出:真人原样;gh 的 app/<name> 写成 <name>[bot];认不出的写「作者未注明」、不带 @', () => {
  const MIVO_AUTHOR_RE = /前置审查按 PR #(\d+)（作者 @([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?)）/;
  const second = (author) => toAutoTaskIssue({ repo: R, pr: 2157, title: 't', author, body: '', files: [] }).body.split('\n')[1];
  for (const [author, login] of [['aj0928', 'aj0928'], ['app/praise-qa', 'praise-qa[bot]'], ['praise-qa[bot]', 'praise-qa[bot]']]) {
    const m = MIVO_AUTHOR_RE.exec(second(author));
    assert.deepEqual(m && [Number(m[1]), m[2]], [2157, login], author);
  }
  // 认不出的作者:Mivo 那边匹配不到 → 按「作者未注明」通报,不会 @ 一个叫 unknown 的真实用户
  for (const author of ['', 'bad name/x', '(unknown)', 'a--b c']) {
    assert.equal(MIVO_AUTHOR_RE.exec(second(author)), null, author);
    assert.match(second(author), /前置审查按 PR #2157（作者未注明）自动整理/);
  }
});
