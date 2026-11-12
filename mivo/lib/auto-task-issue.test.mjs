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
function fakeGh({ issues = {}, rest = {}, failIssue = [] } = {}) {
  const calls = [];
  const fn = (args, options = {}) => {
    if (args[1] === 'graphql') {
      const q = JSON.parse(options.input ?? '{}');
      const n = q.variables?.number;
      if (/closingIssuesReferences/.test(q.query)) { calls.push(['closing', n]); return { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } } }) }; }
      if (/timelineItems/.test(q.query)) {
        calls.push(['issue', n]);
        if (failIssue.includes(n)) return { ok: false, stdout: '', stderr: 'HTTP 502' };
        return { ok: true, stdout: JSON.stringify({ data: { repository: { issue: issues[n] ?? null } }, ...(issues[n] ? {} : { errors: [{ type: 'NOT_FOUND', message: `Could not resolve to an Issue with the number of ${n}.` }] }) }) };
      }
      calls.push(['graphql-other', n]);
      return { ok: true, stdout: JSON.stringify({ data: { repository: { issue: null } } }) };
    }
    const path = args[1];
    calls.push(['rest', path]);
    if (path in rest) return rest[path] === null ? { ok: false, stdout: '', stderr: 'HTTP 502' } : { ok: true, stdout: JSON.stringify(rest[path]) };
    if (/\/parent$/.test(path)) return { ok: false, stdout: JSON.stringify({ message: 'No parent issue found', status: '404' }), stderr: 'gh: No parent issue found (HTTP 404)' };
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
  const origin = { number: 2134, title: 'fix: 旧格式档案超限', body: '任务 issue：o/r#2130', pull_request: {} };
  const gh = fakeGh({ issues: { 2130: node(2130) }, rest: { [`repos/o/r/issues/2134`]: origin, [`repos/o/r/issues/2134/comments?per_page=100`]: [] } });
  const m = readWith({ prBody: 'QA: #2134', prTitle: 'fix: 增量保存 TOO_LARGE (QA #2134)' }, gh);
  assert.deepEqual([m.status, m.ref, m.via], ['read', `${R}#2130`, 'qa-origin']);
  // 来源 PR 只有关联评论(自动 issue)
  const auto = node(3000, { title: '任务 issue · PR #2134 fix: 旧格式档案超限', body: `${AUTO_ISSUE_MARKER(2134)}\n${CHILD}`, author: { login: 'praisebuild', __typename: 'Bot' } });
  const gh2 = fakeGh({ issues: { 3000: auto }, rest: { [`repos/o/r/issues/2134`]: { ...origin, body: '' }, [`repos/o/r/issues/2134/comments?per_page=100`]: [{ user: { login: 'praisebuild[bot]', type: 'Bot' }, body: AUTO_LINK_MARKER(2134, 3000) }] } });
  const m2 = readWith({ prBody: 'QA: #2134' }, gh2);
  assert.deepEqual([m2.status, m2.ref, m2.via, m2.issue.trust, m2.issue.autoIssue], ['read', `${R}#3000`, 'qa-origin', 'plan', true], '来源 PR 的自动 issue 也按计划方算');
  // 来源读不到
  const m3 = readWith({ prBody: 'QA: #2134' }, fakeGh({ rest: { [`repos/o/r/issues/2134`]: null } }));
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
    // 每个改动文件都落在范围里:审查机按同一份 issue 算越界文件,应为空(#2146 改了 52 个文件,按目录合并)
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

test('SC3 超长 PR:改动文件超过 50 个时按目录合并,一个都不漏;整份正文不超过 60 KB', () => {
  const files = Array.from({ length: 120 }, (_, i) => `src/m${i % 70}/file-${i}.ts`);
  const huge = `### 摘要\n\n${'很长的摘要。'.repeat(3000)}\n\n### 自动验证\n\n${Array.from({ length: 80 }, (_, i) => `- 检查 ${i} ${'x'.repeat(400)}`).join('\n')}`;
  const out = toAutoTaskIssue({ repo: R, pr: 9, title: 't', author: 'a', body: huge, files });
  assert.ok(Buffer.byteLength(out.body) <= 60 * 1024);
  assert.match(out.body, /共 120 个，按目录合并/);
  assert.ok((out.body.match(/：本 PR 改动/g) ?? []).length <= 50);
  assert.ok(passesIssueCheck(out.body));
  assert.deepEqual(toDerived({ child: toChildMaterial(out.body), files, pr: 9 }).scopeOutside, [], '合并后每个文件仍在范围里');
  assert.ok(toChildMaterial(out.body).scList.length <= 40);
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
