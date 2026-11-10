// #133:审查机读任务子 issue 与所属总 issue(lib/task-issue.mjs)。夹具都是合成内容,只模仿真实 issue 的结构和大小。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadTaskIssueMode, parseTaskLines, selectTaskIssue, parentRefFromBody, toSections, toScList, toChildMaterial, toTrust,
  lastBodyEditAt, selectUndecided, toDecisions, toChildRows, toParentSections, matchesScope, toScopePatterns, toDerived, toShared,
  toGraphqlResult, readTaskIssue, toSizedMaterial, toTaskIssueSummary, collectTaskIssue, toCodeMask, CHILD_SECTIONS, LIMITS, BASE_NOTE,
} from './task-issue.mjs';

const CHILD = readFileSync(new URL('./fixtures/task-issue/child-v1.md', import.meta.url), 'utf8');
const MAINTAINERS = ['PraiseZhu', 'maint-b'];
const PR_AT = '2026-11-05T00:00:00Z';
const bytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
// 与 mivo/lib/common.mjs writeJson 落盘格式一致:2 空格缩进加换行。
const persisted = (v) => Buffer.byteLength(`${JSON.stringify(v, null, 2)}\n`, 'utf8');

// ── 假 gh:按请求内容分派,记录每次调用(REST issues/<号>/parent 记为 pointer) ──
const NO_PARENT = { fail: 'gh: No parent issue found (HTTP 404)', stdout: JSON.stringify({ message: 'No parent issue found', status: '404' }) };
function fakeGh(routes) {
  const calls = [];
  const fn = (args, options = {}) => {
    const body = JSON.parse(options.input ?? '{}');
    const kind = args[1] !== 'graphql' ? 'pointer' : /closingIssuesReferences/.test(body.query) ? 'closing' : /timelineItems/.test(body.query) ? 'issue'
      : /issueOrPullRequest/.test(body.query) ? 'deps' : 'parent';
    calls.push({ args, kind, variables: body.variables, timeoutMs: options.timeoutMs, allowFail: options.allowFail });
    const handler = routes[kind];
    if (!handler) return { ok: false, status: 1, stdout: '', stderr: `unexpected ${kind}` };
    const out = handler(body.variables);
    if (out?.fail) return { ok: false, status: 1, stdout: out.stdout ?? '', stderr: out.fail };
    return { ok: true, status: 0, stdout: JSON.stringify(out), stderr: '' };
  };
  return { fn, calls };
}
const issueNode = (over = {}) => ({ number: 12, title: '[子2/5] 导出选区', url: 'https://github.com/o/r/issues/12', body: CHILD, createdAt: '2026-11-01T00:00:00Z',
  author: { login: 'PraiseZhu' }, userContentEdits: { nodes: [] }, comments: { nodes: [] }, timelineItems: { totalCount: 0, nodes: [] }, ...over });
const parentBody = (rows = '') => [
  '> 总 issue', '', '## 目标', '', '导出能力分三步上线。', '', '## 范围', '', '- 做：下表子 issue。', '- 不做：', '  - 不做视频导出。', '  - 不改分享链接。', '',
  '## 背景与证据', '', '背景不读。', '', '## 并行 / 串行原则', '', '1. #11 先进 main，#12 再合。', '',
  '## 子 issue', '', '| 子 issue | 内容 | 并行组 |', '|---|---|---|', '| #11 | 整图导出 | A |', '| #12 | 导出选区 | B |', rows, '',
  '## 决策', '', '| 编号 | 日期 | 决策 | 类型 | 谁定 | 依据 |', '|---|---|---|---|---|---|',
  '| D1 | 2026-11-01 | 选区按 DPR 放大 | 产品 | 用户 | 用户原话 |', '| D2 | 2026-11-02 | 走批准执行 | 流程 | 用户 | 同 D1 |',
  '| D3 | 2026-11-03 | 选区按物理像素导出（取代 D1） | 技术 | 用户 | 实测 |', '', '待定：', '- | D9 | 不该被读 |', '',
  '## 变更记录', '', '| 日期 | 变化 |', '|---|---|', '| 2026-11-01 | 创建 |', '', '## 整体验收', '', '- [ ] SC1 三步都上线。验证：github-live',
].join('\n');
const parentNode = (over = {}) => ({ number: 100, title: '[总] 导出能力', url: 'https://github.com/o/r/issues/100', body: parentBody(), createdAt: '2026-10-30T00:00:00Z',
  author: { login: 'PraiseZhu' }, userContentEdits: { nodes: [] }, comments: { nodes: [] }, ...over });
const pointerTo = (number, repo = 'o/r') => () => ({ number, html_url: `https://github.com/${repo}/issues/${number}` });
const parentData = (over) => () => ({ data: { repository: { issue: parentNode(over) } } });
const depsData = (states) => ({ data: { repository: Object.fromEntries(states.map((s, i) => [`d${i}`, { __typename: 'Issue', number: i, state: s }])) } });
const read = (over = {}, routes = {}) => {
  const gh = fakeGh({ issue: () => ({ data: { repository: { issue: issueNode() } } }), deps: () => depsData(['CLOSED', 'OPEN']), pointer: pointerTo(100), parent: parentData(), ...routes });
  const material = readTaskIssue({ repo: 'o/r', pr: 7, prBody: '任务 issue：o/r#12', prCreatedAt: PR_AT, baseRefName: 'main', headRefName: 'feat/x',
    files: ['src/export/regionPng.ts'], maintainers: MAINTAINERS, ghFn: gh.fn, ...over });
  return { material, calls: gh.calls };
};

// ── 开关 ──
test('开关:缺省 off;不合法按 off 告警;名单字段不合法时用默认值并告警', () => {
  const load = (obj) => loadTaskIssueMode('x', () => (typeof obj === 'string' ? obj : JSON.stringify(obj)));
  assert.deepEqual([load({}).mode, load({}).warning], ['off', null]);
  assert.match(load('{').warning, /按 off 处理/);
  assert.match(load({ taskIssue: { mode: 'on' } }).warning, /taskIssue\.mode 不合法/);
  const ok = load({ taskIssue: { mode: 'observe', alwaysInScope: ['docs/**'] } });
  assert.deepEqual([ok.mode, ok.alwaysInScope, ok.automation, ok.warning], ['observe', ['docs/**'], ['praiseautomation', 'github-actions'], null]);
  const bad = load({ taskIssue: { mode: 'observe', stageHeadPrefixes: 'integration/' } });
  assert.deepEqual(bad.stageHeadPrefixes, ['integration/', 'sync/main-into-']);
  assert.match(bad.warning, /stageHeadPrefixes/);
  const repoConfig = loadTaskIssueMode(new URL('../config/review-features.json', import.meta.url));
  assert.equal(repoConfig.mode, 'observe', '本 PR 把 taskIssue.mode 设为 observe');
});

// ── SC1、SC2 链接 ──
test('SC1:任务 issue 行的三种写法都认;HTML 注释和代码块里的不算', () => {
  assert.deepEqual(parseTaskLines('任务 issue：#12', 'o/r'), [{ repo: 'o/r', number: 12 }]);
  assert.deepEqual(parseTaskLines('任务 issue: other/repo#3', 'o/r'), [{ repo: 'other/repo', number: 3 }]);
  assert.deepEqual(parseTaskLines('任务 issue：https://github.com/o/r/issues/45', 'o/r'), [{ repo: 'o/r', number: 45 }]);
  assert.deepEqual(parseTaskLines('<!-- 任务 issue：#1 -->\n```\n任务 issue：#2\n```', 'o/r'), []);
});

test('SC1:没有任务 issue 行时回退 Closes 关联;都没有时 ref 为空、记「未关联」', () => {
  const viaCloses = read({ prBody: 'Closes #12' }, { closing: () => ({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 12, title: '导出选区', url: 'https://github.com/o/r/issues/12' }] } } } } }) });
  assert.equal(viaCloses.material.ref, 'o/r#12');
  assert.equal(viaCloses.material.via, 'closes');
  assert.equal(toTaskIssueSummary(viaCloses.material).ref, 'o/r#12');
  const none = read({ prBody: '没有链接' }, { closing: () => ({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } } }) });
  assert.deepEqual([none.material.ref, none.material.status, none.material.note], [null, 'unlinked', '未关联']);
  assert.deepEqual(none.calls.map((c) => c.kind), ['closing'], '没关联就不再读 issue');
  const withLine = read();
  assert.ok(!withLine.calls.some((c) => c.kind === 'closing'), '有任务 issue 行时不读 Closes');
});

test('SC2:多于 1 个只取第一个并告警;转 issue 跟进的 issue、维护者确认 issue 不算', () => {
  const two = selectTaskIssue({ body: '任务 issue：#12\n任务 issue：#13', repo: 'o/r', pr: 7 });
  assert.deepEqual(two.candidates.map((c) => c.number), [12, 13]);
  assert.match(two.warnings[0], /关联了多个任务 issue.*只取 o\/r#12/);
  const deferred = selectTaskIssue({ body: 'Closes #20\n\n## 转 issue 跟进的审查问题\n\n- #20 慢查询下个 PR 修', repo: 'o/r', pr: 7,
    closing: [{ number: 20, title: '慢查询' }, { number: 21, title: `维护者确认 · PR #7` }] });
  assert.deepEqual(deferred.candidates, []);
  assert.deepEqual(deferred.excluded.map((e) => e.reason), ['在「转 issue 跟进的审查问题」一节', '维护者确认 issue']);
  // 任务 issue 行指向的 issue 读回来才知道标题;维护者确认 issue 跳过,不当任务 issue。
  const confirm = read({ prBody: '任务 issue：#12' }, { issue: () => ({ data: { repository: { issue: issueNode({ title: '维护者确认 · PR #7 改了规则' }) } } }) });
  assert.deepEqual([confirm.material.ref, confirm.material.status], [null, 'unlinked']);
  assert.equal(confirm.material.excluded[0].reason, '维护者确认 issue');
});

// ── SC3、SC11 段落与截断 ──
test('SC3:五段和每条 SC 的编号、描述、验证层、测试点都解析正确;模板注释里的不算', () => {
  const child = toChildMaterial(CHILD);
  assert.equal(child.structure, 'parsed');
  assert.deepEqual(Object.keys(child.sections), CHILD_SECTIONS);
  assert.match(child.sections.范围, /regionPng/);
  assert.doesNotMatch(child.sections.范围, /check-pr|SC99/, 'HTML 注释去掉');
  assert.deepEqual(child.scList.map((s) => [s.sc, s.layer, s.checked]), [['SC1', 'unit', false], ['SC2', 'browser-fixture', true], ['SC3', 'cindy-mac', false], ['SC4', null, false], ['SC5', 'static', false]]);
  assert.equal(child.scList[0].description, '选中区域后导出的 PNG 尺寸等于选区乘以 DPR');
  assert.equal(child.scList[0].testPoint, '`regionPng` 尺寸函数');
  assert.equal(child.raw, null);
});

test('SC3:结构认不出时保留原文并标「结构未识别」', () => {
  const body = '## 目标\n\n做点事\n\n## 验收\n\n- 做完';
  const child = toChildMaterial(body);
  assert.equal(child.structure, 'unrecognized');
  assert.deepEqual(child.missingSections, ['范围', '不做', '依赖', '验收标准']);
  assert.equal(child.raw, body);
  assert.equal(child.sections, null);
});

test('SC11:正文超过 16 KB 时只保留五个必需段,标「已截断」', () => {
  const big = CHILD.replace('## 参考', `## 参考\n\n${'参考资料很长。'.repeat(1200)}`).replace('## 不做', `## 不做\n\n${'不做的事。'.repeat(800)}`);
  assert.ok(bytes(big) > LIMITS.childBytes);
  const child = toChildMaterial(big);
  assert.equal(child.truncated, true);
  assert.ok(bytes(Object.values(child.sections).join('')) <= LIMITS.childBytes);
  assert.match(child.sections.不做, /已截断/);
  assert.equal(child.scList.length, 5, '验收标准完整');
  const { material } = read({}, { issue: () => ({ data: { repository: { issue: issueNode({ body: big }) } } }) });
  assert.ok(material.truncated.some((t) => /只保留五个必需段/.test(t)));
});

// ── SC4 可信度 ──
test('SC4:维护者改过的仍是计划方并记下改动者;非维护者改过的降为作者陈述;自动化账号不计', () => {
  const edit = (editor, at) => ({ editor, at });
  const byMaintainer = toTrust({ author: 'PraiseZhu', edits: [edit('PraiseZhu', '2026-11-06T00:00:00Z')], prCreatedAt: PR_AT, maintainers: MAINTAINERS });
  assert.deepEqual([byMaintainer.trust, byMaintainer.trustLabel, byMaintainer.trustNote], ['plan', '计划方验收标准', null]);
  assert.deepEqual(byMaintainer.editedAfterPr, [{ editor: 'PraiseZhu', at: '2026-11-06T00:00:00Z', maintainer: true }]);
  const byOutsider = toTrust({ author: 'PraiseZhu', edits: [edit('contributor', '2026-11-06T00:00:00Z')], prCreatedAt: PR_AT, maintainers: MAINTAINERS });
  assert.deepEqual([byOutsider.trust, byOutsider.trustNote], ['author', '开 PR 后非维护者改过']);
  const byBot = toTrust({ author: 'PraiseZhu', edits: [edit('praiseautomation', '2026-11-06T00:00:00Z'), edit('github-actions[bot]', '2026-11-07T00:00:00Z')], prCreatedAt: PR_AT, maintainers: MAINTAINERS });
  assert.deepEqual([byBot.trust, byBot.editedAfterPr], ['plan', []]);
  const beforePr = toTrust({ author: 'PraiseZhu', edits: [edit('contributor', '2026-11-04T00:00:00Z')], prCreatedAt: PR_AT, maintainers: MAINTAINERS });
  assert.equal(beforePr.trust, 'plan', '开 PR 之前的编辑不影响');
  assert.equal(toTrust({ author: 'praiseautomation', prCreatedAt: PR_AT, maintainers: MAINTAINERS }).trust, 'plan', '验收机开的修正 issue 算计划方');
  assert.deepEqual([toTrust({ author: 'contributor', prCreatedAt: PR_AT, maintainers: MAINTAINERS }).trust, toTrust({ author: 'contributor', prCreatedAt: PR_AT, maintainers: MAINTAINERS }).trustNote], ['author', 'issue 作者不是维护者']);
});

// ── SC9 共用识别 ──
test('SC9:同仓另有 PR 写同一任务 issue 行时 shared 为 true 并列出 PR 号;只有本 PR 时为 false', () => {
  const pr = (number, body, repo = 'o/r') => ({ source: { __typename: 'PullRequest', number, body, url: `https://github.com/${repo}/pull/${number}` } });
  const timeline = { totalCount: 5, nodes: [pr(7, '任务 issue：#12'), pr(31, '任务 issue：o/r#12'), pr(9, '任务 issue：#12'), pr(40, '只是提到 #12'), pr(50, '任务 issue：#12', 'x/y')] };
  assert.deepEqual(toShared({ timeline, prRepo: 'o/r', pr: 7, issueRef: { repo: 'o/r', number: 12 } }), { shared: true, prs: [9, 31], incomplete: false });
  assert.deepEqual(toShared({ timeline: { totalCount: 1, nodes: [pr(7, '任务 issue：#12')] }, prRepo: 'o/r', pr: 7, issueRef: { repo: 'o/r', number: 12 } }),
    { shared: false, prs: [], incomplete: false });
  assert.equal(toShared({ timeline: { totalCount: 40, nodes: [pr(9, '任务 issue：#12')] }, prRepo: 'o/r', pr: 7, issueRef: { repo: 'o/r', number: 12 } }).incomplete, true,
    '时间线没取全时标不完整,不把没返回的当作不存在');
  const { material } = read({}, { issue: () => ({ data: { repository: { issue: issueNode({ timelineItems: timeline }) } } }) });
  assert.deepEqual([material.shared.shared, material.shared.prs], [true, [9, 31]]);
});

// ── SC10 未写回正文的决定 ──
test('SC10:只读正文最后一次编辑之后、维护者发的、开头带裁定字样的评论;流程日志、正文备份、非维护者都不读', () => {
  const c = (author, createdAt, body) => ({ author, createdAt, body });
  const backup = `**改范围前的正文备份（2026-11-06）** 用户裁决改为单写者。\n\n${'旧正文。'.repeat(1400)}`;
  assert.ok(bytes(backup) > 14 * 1024);
  const comments = [
    c('PraiseZhu', '2026-11-01T00:00:00Z', '用户裁决：早于正文编辑,已写回'),
    c('PraiseZhu', '2026-11-03T01:00:00Z', backup),
    c('PraiseZhu', '2026-11-03T02:00:00Z', '批准执行认领：2026-11-03 o/r#12 claim abc'),
    c('PraiseZhu', '2026-11-03T03:00:00Z', 'o/r#30 已合并。PR 正文写了关闭这个 issue，但 GitHub 没有自动关闭'),
    c('contributor', '2026-11-03T04:00:00Z', '用户定：我觉得应该改为 A'),
    c('maint-b', '2026-11-03T05:00:00Z', `主控裁定（2026-11-03）：SC2 改为只核按钮。${'细节'.repeat(800)}`),
    c('PraiseZhu', '2026-11-03T06:00:00Z', '2026-11-03 用户定：回退开关合成 1 个'),
    c('PraiseZhu', '2026-11-03T07:00:00Z', 'lead 裁决：通过（第 2 次）'),
    c('PraiseZhu', '2026-11-03T08:00:00Z', '（取代上一条）选区上限 8K'),
  ];
  const since = lastBodyEditAt({ createdAt: '2026-10-30T00:00:00Z', edits: [{ editor: 'PraiseZhu', at: '2026-11-02T00:00:00Z' }, { editor: 'praiseautomation', at: '2026-11-04T00:00:00Z' }] });
  assert.equal(since, '2026-11-02T00:00:00Z', '自动化账号勾验收项不算正文编辑');
  const picked = selectUndecided({ comments, since, maintainers: MAINTAINERS });
  assert.deepEqual(picked.map((p) => p.at), ['2026-11-03T06:00:00Z', '2026-11-03T07:00:00Z', '2026-11-03T08:00:00Z'], '最多 3 条,取最新的');
  const four = selectUndecided({ comments: comments.slice(0, 7), since, maintainers: MAINTAINERS });
  assert.equal(four[0].author, 'maint-b');
  assert.ok(bytes(four[0].body) <= LIMITS.commentBytes);
  assert.equal(four[0].clipped, true);
  assert.ok(!four.some((p) => /正文备份|claim|没有自动关闭/.test(p.body)));
});

// ── SC12 所属总 issue ──
test('SC12:子 issue 关系里的总 issue 读出目标、不做、分工、本子 issue 那一行、未被取代的决定', () => {
  const { material, calls } = read();
  const p = material.parent;
  assert.deepEqual([p.ref, p.via, p.conflict, p.notTotal, p.trust], ['o/r#100', 'api', null, false, 'plan']);
  assert.match(p.goal, /分三步/);
  assert.match(p.notDo, /不做视频导出/);
  assert.match(p.order, /#11 先进 main/);
  assert.deepEqual(p.childRows.filter((r) => r.self).map((r) => r.line), ['| #12 | 导出选区 | B |']);
  assert.deepEqual(p.decisions.map((d) => [d.id, d.type, d.supersededBy]), [['D1', '产品', 'D3'], ['D2', '流程', null], ['D3', '技术', null]]);
  assert.equal(p.decisions[2].by, '用户');
  assert.ok(!JSON.stringify(p).includes('背景不读'), '背景不读');
  assert.ok(!p.decisions.some((d) => d.id === 'D9'), '「待定」之后的行不算决定');
  assert.match(p.overall, /三步都上线/);
  assert.deepEqual(calls.find((c) => c.kind === 'pointer').args, ['api', 'repos/o/r/issues/12/parent'], '总 issue 关系走 REST,不用 GraphQL 的 Issue.parent');
  assert.deepEqual(calls.find((c) => c.kind === 'parent').variables, { owner: 'o', name: 'r', number: 100 });
});

test('SC12:只在正文写总 issue 时按正文读;两种来源矛盾记冲突;父 issue 不是 [总] 时照读并标出', () => {
  const viaBody = read({}, { pointer: () => NO_PARENT });
  assert.deepEqual([viaBody.material.parent.ref, viaBody.material.parent.via], ['o/r#100', 'body']);
  assert.deepEqual(viaBody.calls.find((c) => c.kind === 'parent').variables, { owner: 'o', name: 'r', number: 100 });
  assert.ok(!viaBody.material.warnings.some((w) => /404|No parent/.test(w)), '没有子 issue 关系(404)不算读取失败');
  const conflict = read({}, { pointer: pointerTo(200), parent: parentData({ number: 200, title: '[子1/3] 不是总 issue' }) });
  assert.deepEqual(conflict.material.parent.conflict, { api: 'o/r#200', body: 'o/r#100' });
  assert.equal(conflict.material.parent.notTotal, true);
  assert.ok(conflict.material.warnings.some((w) => /父 issue 冲突/.test(w)));
  assert.ok(conflict.material.warnings.some((w) => /不是总 issue/.test(w)));
  assert.deepEqual(parentRefFromBody(`${'x'.repeat(3000)}\n总 issue o/r#1`, 'o/r'), null, '只看开头 2 KB');
});

test('SC12:旧式决策表保留原行标未结构化;22 KB 正文、47 条评论的总 issue 材料不超过 64 KB', () => {
  const old = toDecisions('| 日期 | 决策 | 谁定 |\n|---|---|---|\n| 2026-10-01 | 先做导出 | 用户 |');
  assert.deepEqual([old.decisions.length, old.unstructured], [0, ['| 2026-10-01 | 先做导出 | 用户 |']]);
  const rows = Array.from({ length: 30 }, (_, i) => `| #${200 + i} | 兄弟子 issue ${i} ${'说明'.repeat(60)} | C |`).join('\n');
  const body = parentBody(rows) + `\n\n## 上线后验证\n\n${'验证。'.repeat(2400)}`;
  assert.ok(bytes(body) > 22 * 1024);
  const comments = { nodes: Array.from({ length: 47 }, (_, i) => ({ author: { login: 'PraiseZhu' }, createdAt: `2026-11-0${1 + (i % 8)}T0${i % 10}:00:00Z`, body: `用户定：第 ${i} 条 ${'理由'.repeat(400)}` })) };
  const { material } = read({}, { parent: parentData({ body, comments }) });
  assert.ok(bytes(material) <= LIMITS.fileBytes);
  assert.equal(material.parent.undecided.length, LIMITS.comments);
  assert.ok(!JSON.stringify(material.parent).includes('验证。验证。'), '上线后验证不读');
  assert.equal(toChildRows(toSections(body, ['子 issue'])['子 issue'], { repo: 'o/r', number: 12 }, 'o/r').filter((r) => r.self).length, 1);
});

// ── SC13 目标分支与依赖 ──
test('SC13:记录 base 分支和依赖开关状态,写明 issue 关闭不代表代码已在 base;不查合并去向和发布', () => {
  const { material, calls } = read({ baseRefName: 'integration/export' });
  assert.deepEqual([material.baseRef, material.baseNote], ['integration/export', BASE_NOTE]);
  assert.deepEqual(material.deps.items, [{ ref: 'o/r#10', type: 'Issue', state: 'CLOSED' }, { ref: 'o/r#11', type: 'Issue', state: 'OPEN' }]);
  assert.equal(material.deps.incomplete, true, '跨仓依赖 other/repo#5 不读');
  assert.ok(material.gaps.some((g) => /跨仓/.test(g)));
  assert.deepEqual(calls.map((c) => c.kind), ['issue', 'deps', 'pointer', 'parent'], '只读任务 issue、依赖、总 issue 关系和总 issue,不查合并去向与发布');
  assert.deepEqual(calls[1].variables, { owner: 'o', name: 'r', n0: 10, n1: 11, n2: 10, n3: 10, n4: 10, n5: 10, n6: 10, n7: 10, n8: 10, n9: 10 });
});

// ── SC15 代码判定项 ──
test('SC15:范围路径匹配:**/ 可以是零层目录,* 不跨目录,目录前缀', () => {
  assert.ok(matchesScope('src/a/__tests__/x.test.ts', 'src/**/__tests__/*.test.ts'));
  assert.ok(matchesScope('src/__tests__/x.test.ts', 'src/**/__tests__/*.test.ts'), '**/ 零层');
  assert.ok(!matchesScope('src/__tests__/deep/x.test.ts', 'src/**/__tests__/*.test.ts'), '* 不跨目录');
  assert.ok(matchesScope('src/export/panel/a.tsx', 'src/export/panel/'));
  assert.ok(matchesScope('src/export/panel/a.tsx', 'src/export/panel'));
  assert.ok(!matchesScope('src/export/panelx.tsx', 'src/export/panel'));
  assert.ok(matchesScope('src/i18n/locales/en/export.json', 'src/i18n/locales/*/export.json'));
  assert.deepEqual(toScopePatterns('- `AGENTS.md`、`docs/a.md`：改\n- `taskIssue.mode`(`off`)'), ['docs/a.md', 'AGENTS.md', 'taskIssue.mode']);
});

test('SC15:超出范围的文件、黑盒 SC、还开着的依赖由代码算;交接文件、范围内源文件的测试、根目录文件不算超出', () => {
  const child = toChildMaterial(CHILD);
  const files = ['src/export/regionPng.ts', 'src/export/regionPng.test.ts', 'src/export/__tests__/regionPng.test.ts', 'src/export/panel/Button.tsx',
    'docs/pr/7/review.md', 'docs/pr/7/after.png', 'CHANGELOG.md', 'src/store/other.ts', 'src/store/other.test.ts'];
  const derived = toDerived({ child, files, deps: { items: [{ ref: 'o/r#10', state: 'CLOSED' }, { ref: 'o/r#11', state: 'OPEN' }] } });
  assert.deepEqual(derived.scopeOutside, ['src/store/other.test.ts', 'src/store/other.ts']);
  assert.deepEqual(derived.blackboxSc, ['SC3']);
  assert.deepEqual(derived.depsOpen, ['o/r#11']);
  assert.equal(derived.scopeNote, null);
  const stage = toDerived({ child, files, headRefName: 'sync/main-into-export' });
  assert.equal(stage.scopeOutside, null);
  assert.match(stage.scopeNote, /阶段合并 PR/);
  assert.match(toDerived({ child, files, headRefName: 'integration/export' }).scopeNote, /阶段合并 PR/);
  const noPaths = toDerived({ child: toChildMaterial(CHILD.replace(/`[^`]*`/g, '路径')), files });
  assert.deepEqual([noPaths.scopeOutside, noPaths.scopeNote], [null, '范围未列路径']);
  assert.equal(toDerived({ child: toChildMaterial('没有结构'), files }).scopeNote, '结构未识别,没算超出范围的文件');
});

// ── SC14 预算与体积 ──
test('SC14:超过 20 秒不再请求,返回部分材料并写明缺口', () => {
  let clock = 0;
  const gh = fakeGh({ issue: () => { clock += 21_000; return { data: { repository: { issue: issueNode() } } }; }, deps: () => depsData(['OPEN']) });
  const material = readTaskIssue({ repo: 'o/r', pr: 7, prBody: '任务 issue：#12', prCreatedAt: PR_AT, files: [], maintainers: MAINTAINERS, ghFn: gh.fn, now: () => clock });
  assert.equal(material.status, 'partial');
  assert.deepEqual(gh.calls.map((c) => c.kind), ['issue']);
  assert.ok(material.gaps.some((g) => /依赖状态:20 秒预算只剩 0 毫秒,没读/.test(g)));
  assert.ok(material.gaps.some((g) => /总 issue o\/r#100:20 秒预算只剩 0 毫秒,没读/.test(g)));
  assert.ok(material.deps.items.every((d) => d.state === null), '没读到的依赖状态是 null,不当作关闭');
  assert.ok(gh.calls[0].timeoutMs <= 10_000 && gh.calls[0].allowFail === true);
});

test('SC14:请求次数用满就停;64 KB 超限按固定顺序删减并记进 truncated', () => {
  const gh = fakeGh({ issue: () => ({ data: { repository: { issue: issueNode() } } }) });
  const capped = readTaskIssue({ repo: 'o/r', pr: 7, prBody: '任务 issue：#12', files: [], maintainers: MAINTAINERS, ghFn: gh.fn, budget: { requests: 1, ms: 20_000 } });
  assert.equal(gh.calls.length, 1);
  assert.equal(capped.status, 'partial');
  assert.ok(capped.gaps.some((g) => /已用满 1 次请求/.test(g)));

  const undecided = (n, at) => Array.from({ length: n }, (_, i) => ({ author: 'PraiseZhu', at: `${at}${i}`, body: 'x'.repeat(900) }));
  const material = { truncated: [], issue: { undecided: undecided(3, '2026-11-01T00:00:0') }, parent: {
    undecided: undecided(3, '2026-11-02T00:00:0'), childRows: Array.from({ length: 30 }, (_, i) => ({ line: 'r'.repeat(200), self: i === 25 })),
    decisions: [{ id: 'D1', type: '流程', supersededBy: null, decision: 'p'.repeat(800) }, { id: 'D2', type: '产品', supersededBy: 'D3', decision: 's'.repeat(800) },
      { id: 'D3', type: '产品', supersededBy: null, decision: 'k'.repeat(800) }], overall: 'o'.repeat(800) } };
  // 上限取「做完前三步」时的落盘大小:第二步之后仍超、第三步之后正好不超,所以只走前三步。
  const afterThree = structuredClone(material);
  afterThree.issue.undecided = [];
  afterThree.parent.undecided = [];
  afterThree.parent.childRows = afterThree.parent.childRows.filter((r, i) => i < 20 || r.self);
  afterThree.parent.decisions = afterThree.parent.decisions.slice(1);
  afterThree.truncated = ['最旧的未写回正文的决定(删 6 次)', '第 20 个以后的兄弟子 issue(删 1 次)', '流程类决定(删 1 次)'];
  const limit = persisted(afterThree);
  const before = persisted(material);
  const sized = toSizedMaterial(material, limit);
  assert.deepEqual(sized.truncated.map((t) => t.replace(/\(.*\)$/, '')), ['最旧的未写回正文的决定', '第 20 个以后的兄弟子 issue', '流程类决定']);
  assert.equal(sized.issue.undecided.length + sized.parent.undecided.length, 0);
  assert.equal(sized.parent.childRows.length, 21, '保留前 20 行和本子 issue 那一行');
  assert.ok(sized.parent.childRows.some((r) => r.self));
  assert.deepEqual(sized.parent.decisions.map((d) => d.id), ['D2', 'D3'], '已取代的决定在流程类之后才删');
  assert.ok(persisted(sized) <= limit && limit < before, `删减后 ${persisted(sized)} 字节,上限 ${limit},删减前 ${before}`);
});

// ── PR #235 合并前单审(Astra)的反例:F1–F10 ──
const mini = ({ scope = '- `src/a.ts`', deps = '无', sc = '- [ ] SC1 功能可用。验证：unit', extra = '' } = {}) =>
  `## 目标\n交付\n## 范围\n${scope}\n## 不做\n无\n## 依赖\n${deps}\n## 验收标准\n${sc}\n${extra}`;
const NO_PARENT_ROUTES = { pointer: () => NO_PARENT };

test('F1:验收标准很长的合法 issue,材料按落盘格式也不超过 64 KB', () => {
  const sc = Array.from({ length: 95 }, (_, i) => `- [ ] SC${i + 1} ${'a'.repeat(600)}。验证：unit`).join('\n');
  const body = mini({ sc });
  assert.ok(body.length < 65536, 'GitHub 允许的正文长度');
  const { material } = read({}, { ...NO_PARENT_ROUTES, issue: () => ({ data: { repository: { issue: issueNode({ body }) } } }) });
  assert.ok(persisted(material) <= LIMITS.fileBytes, `落盘 ${persisted(material)} 字节`);
  assert.ok(material.truncated.some((t) => /验收标准超过 12 KB/.test(t)));
  assert.equal(material.issue.scList[0].sc, 'SC1');
  const huge = toSizedMaterial({ truncated: [], issue: { ref: 'o/r#12', sections: { 目标: 'x'.repeat(70_000) }, scList: [{ sc: 'SC1', layer: 'unit', description: 'd'.repeat(5000) }] },
    derived: { scopeOutside: Array.from({ length: 3000 }, (_, i) => `src/f${i}.ts`), scopePatterns: [] } });
  assert.ok(persisted(huge) <= LIMITS.fileBytes, '子 issue 材料本身超限时也压到上限以内');
  assert.ok(huge.truncated.some((t) => /子 issue/.test(t)));
});

test('F2:每次请求的超时不超过剩余时间,剩余不足 1 秒就不发;读失败记缺口', () => {
  let clock = 0;
  const seen = [];
  const gh = fakeGh({
    issue: () => { clock += 9900; return { data: { repository: { issue: issueNode({ body: mini({ deps: '#99' }) }) } } }; },
    deps: () => { clock += 9900; return depsData(['OPEN']); },
    pointer: () => NO_PARENT,
  });
  const fn = (args, options) => { seen.push({ left: 20_000 - clock, timeoutMs: options.timeoutMs }); return gh.fn(args, options); };
  const material = readTaskIssue({ repo: 'o/r', pr: 7, prBody: '任务 issue：#12', prCreatedAt: PR_AT, files: [], maintainers: MAINTAINERS, ghFn: fn, now: () => clock });
  assert.deepEqual(gh.calls.map((c) => c.kind), ['issue', 'deps'], '只剩 200 毫秒时不再查总 issue 关系');
  assert.ok(seen.every((c) => c.timeoutMs <= c.left), JSON.stringify(seen));
  assert.equal(material.status, 'partial');
  assert.ok(material.gaps.some((g) => /总 issue 关系:20 秒预算只剩 200 毫秒,没读/.test(g)));
  const failed = read({}, { ...NO_PARENT_ROUTES, deps: () => ({ fail: 'HTTP 502' }) });
  assert.equal(failed.material.status, 'partial');
  assert.ok(failed.material.gaps.some((g) => /依赖状态:读取失败/.test(g)));
});

test('F3:正文超过 16 KB 时,范围路径仍按完整「范围」段算', () => {
  const body = mini({ scope: `- \`src/a.ts\`\n${'范围解释。'.repeat(400)}\n- \`src/allowed-late.ts\``, extra: `## 参考\n${'参考。'.repeat(2000)}` });
  assert.ok(bytes(body) > LIMITS.childBytes);
  const { material } = read({ files: ['src/allowed-late.ts'] }, { ...NO_PARENT_ROUTES, issue: () => ({ data: { repository: { issue: issueNode({ body }) } } }) });
  assert.match(material.issue.sections.范围, /已截断/, '输出的范围段仍按上限截断');
  assert.deepEqual(material.derived.scopeOutside, []);
});

test('F4:依赖写成 GitHub 网址也读状态', () => {
  const { material } = read({}, { ...NO_PARENT_ROUTES, issue: () => ({ data: { repository: { issue: issueNode({ body: mini({ deps: '先合 [前置任务](https://github.com/o/r/issues/99)。' }) }) } } }),
    deps: () => depsData(['OPEN']) });
  assert.deepEqual(material.derived.depsOpen, ['o/r#99']);
});

test('F5:已关闭未合并的旧 PR 不算共用;开着和已合并的算', () => {
  const pr = (number, state) => ({ source: { __typename: 'PullRequest', number, body: '任务 issue：#12', url: `https://github.com/o/r/pull/${number}`, state } });
  const shared = toShared({ timeline: { totalCount: 3, nodes: [pr(8, 'CLOSED'), pr(9, 'MERGED'), pr(10, 'OPEN')] }, prRepo: 'o/r', pr: 7, issueRef: { repo: 'o/r', number: 12 } });
  assert.deepEqual(shared.prs, [9, 10]);
});

test('F6:子 issue 表超过 40 行时,本子 issue 那一行仍保留', () => {
  const table = `| 子 issue | 内容 |\n|---|---|\n${Array.from({ length: 45 }, (_, i) => `| #${i + 1} | 任务 ${i + 1} |`).join('\n')}`;
  const rows = toChildRows(table, { repo: 'o/r', number: 43 }, 'o/r');
  assert.equal(rows.length, 41);
  assert.deepEqual(rows.filter((r) => r.self).map((r) => r.line), ['| #43 | 任务 43 |']);
});

test('F7:验收 / 派发 / 归档日志正文里提到裁定字样也不算决定', () => {
  const c = (createdAt, body) => ({ author: 'PraiseZhu', createdAt, body });
  const picked = selectUndecided({ since: '2026-11-05T00:00:00Z', maintainers: MAINTAINERS, comments: [
    c('2026-11-06T01:00:00Z', '验收记录：按用户定的 SC1-SC3 验证通过，issue 归档。'),
    c('2026-11-06T02:00:00Z', '批准执行派发记录：依据主控裁定，已派给执行会话。'),
    c('2026-11-06T03:00:00Z', '归档记录：维护者确认已合并，本会话归档。'),
    c('2026-11-06T04:00:00Z', '**用户裁决（2026-11-06）：选区上限改为 8K。**'),
  ] });
  assert.deepEqual(picked.map((p) => p.at), ['2026-11-06T04:00:00Z']);
});

test('F8:编辑记录没取全且缺的可能在开 PR 之后,降为作者陈述并写明缺口', () => {
  const edits = [{ editedAt: '2026-11-06T00:00:00Z', editor: { login: 'outsider' } },
    ...Array.from({ length: 50 }, (_, i) => ({ editedAt: new Date(Date.UTC(2026, 10, 7, 0, i)).toISOString(), editor: { login: 'praiseautomation' } }))];
  const node = issueNode({ userContentEdits: { totalCount: 51, nodes: edits.slice(-50) } });
  const { material } = read({}, { ...NO_PARENT_ROUTES, issue: () => ({ data: { repository: { issue: node } } }) });
  assert.deepEqual([material.issue.trust, material.issue.trustNote], ['author', '编辑记录没取全,开 PR 后的编辑无法全部核对']);
  assert.ok(material.gaps.some((g) => /子 issue 编辑记录超过 50 条,开 PR 后的编辑没取全/.test(g)));
  const olderMissing = toTrust({ author: 'PraiseZhu', editsComplete: false, edits: [{ editor: 'PraiseZhu', at: '2026-11-01T00:00:00Z' }], prCreatedAt: PR_AT, maintainers: MAINTAINERS });
  assert.equal(olderMissing.trust, 'plan', '取到的最早一条已在开 PR 之前,缺的只会更早,不影响');
  const older = read({}, { ...NO_PARENT_ROUTES, issue: () => ({ data: { repository: { issue: issueNode({ userContentEdits: { totalCount: 80,
    nodes: [{ editedAt: '2026-11-02T00:00:00Z', editor: { login: 'PraiseZhu' } }] } }) } } }) });
  assert.deepEqual([older.material.issue.trust, older.material.gaps.filter((g) => /编辑记录/.test(g))], ['plan', []], '缺的编辑都在开 PR 之前时不记缺口');
  const noTotal = read({}, { ...NO_PARENT_ROUTES, issue: () => ({ data: { repository: { issue: issueNode({ userContentEdits: { nodes: edits.slice(-50) } }) } } }) });
  assert.equal(noTotal.material.issue.trust, 'author', '没返回总数、条数用满 50 条时也当作可能没取全');
});

test('F9:代码块里的示例 SC 不算验收标准', () => {
  const child = toChildMaterial(mini({ sc: '- [ ] SC1 真正验收项。验证：unit\n\n示例：\n~~~markdown\n- [ ] SC99 示例项。验证：paid\n~~~' }));
  assert.deepEqual(child.scList.map((s) => s.sc), ['SC1']);
});

test('F10:跨仓的「转 issue 跟进」项也不当任务 issue', () => {
  const picked = selectTaskIssue({ body: 'Closes other/r#20\n\n## 转 issue 跟进的审查问题\n\n- other/r#20 留待后续修复', repo: 'o/r', pr: 7,
    closing: [{ repo: 'other/r', number: 20, title: '后续问题' }] });
  assert.deepEqual(picked.candidates, []);
  assert.equal(picked.excluded[0].reason, '在「转 issue 跟进的审查问题」一节');
});

// ── PR #235 复审(Astra)的边界反例 ──
test('R2-F1:改动文件路径很长时材料也不超过 64 KB;所有删减用完仍超就只留链接、摘要和计数', () => {
  const files = Array.from({ length: 60 }, (_, i) => `src/${Array.from({ length: 15 }, () => 'a'.repeat(100)).join('/')}/f${i}.ts`);
  const { material } = read({ files }, { ...NO_PARENT_ROUTES, issue: () => ({ data: { repository: { issue: issueNode({ body: mini() }) } } }) });
  assert.ok(persisted(material) <= LIMITS.fileBytes, `落盘 ${persisted(material)} 字节`);
  assert.equal(material.derived.scopeOutsideTotal, 60, '保留超出范围的文件总数');
  const noisy = { version: 1, truncated: [], warnings: Array.from({ length: 2000 }, (_, i) => `警告 ${i} ${'w'.repeat(200)}`), gaps: [], issue: null, parent: null, derived: null };
  const sized = toSizedMaterial(noisy);
  assert.ok(persisted(sized) <= LIMITS.fileBytes, `落盘 ${persisted(sized)} 字节`);
  assert.match(sized.truncated.at(-1), /只留链接、可信度、摘要和计数/);
});

test('R2-F7:日期带括号或加粗的裁定也认', () => {
  const c = (i, body) => ({ author: 'PraiseZhu', createdAt: `2026-11-10T00:00:0${i}Z`, body });
  const picked = selectUndecided({ since: '2026-11-05T00:00:00Z', maintainers: MAINTAINERS, comments: [
    c(0, '（2026-11-10）用户裁决：SC2 改为 8K。'), c(1, '(2026-11-10) 用户定：SC2 改为 8K。'), c(2, '**2026-11-10** 用户定：SC2 改为 8K。'),
  ] });
  assert.equal(picked.length, 3);
});

test('R2-F9:外层四个反引号里的三反引号块不提前关闭,示例 SC 仍不算', () => {
  const tick = '`';
  const sc = ['- [ ] SC1 实际验收。验证：unit', '示例：', `${tick.repeat(4)}markdown`, `${tick.repeat(3)}typescript`, '- [ ] SC99 示例。验证：paid', tick.repeat(3), tick.repeat(4),
    '- [ ] SC2 块后的验收。验证：unit'].join('\n');
  assert.deepEqual(toChildMaterial(mini({ sc })).scList.map((x) => x.sc), ['SC1', 'SC2']);
  const tilde = ['- [ ] SC1 a。验证：unit', '~~~', '```', '- [ ] SC98 b。验证：unit', '~~~', '- [ ] SC3 c。验证：unit'].join('\n');
  assert.deepEqual(toChildMaterial(mini({ sc: tilde })).scList.map((x) => x.sc), ['SC1', 'SC3'], '~~~ 块只能用 ~~~ 关');
});

test('R3-F1:列表里缩进的代码块示例也不算(任务 issue 行和 SC 都是)', () => {
  const tick = '`'.repeat(3);
  const example = ['- 文档示例：', '', `    ${tick}markdown`, '    任务 issue：#999', `    ${tick}`, '', '任务 issue：#12'].join('\n');
  assert.deepEqual(parseTaskLines(example, 'o/r'), [{ repo: 'o/r', number: 12 }]);
  const sc = ['- [ ] SC1 真正验收。验证：unit', '', '- 文档示例：', '', `    ${tick}markdown`, '    - [ ] SC99 示例。验证：paid', `    ${tick}`, '- [ ] SC2 之后的验收。验证：unit'].join('\n');
  assert.deepEqual(toChildMaterial(mini({ sc })).scList.map((x) => x.sc), ['SC1', 'SC2']);
});

test('R4-F1:普通缩进代码块里的 ``` 字面量不吞掉后面的任务 issue 行和标题', () => {
  const tick = '`'.repeat(3);
  assert.deepEqual(parseTaskLines(['围栏符号示例：', '', `    ${tick}`, '', '任务 issue：#12'].join('\n'), 'o/r'), [{ repo: 'o/r', number: 12 }]);
  const body = ['## 目标', '实现代码围栏预览。', '', `    ${tick}`, '', '## 范围', '- `src/a.ts`', '## 不做', '无', '## 依赖', '无', '## 验收标准', '- [ ] SC1 预览正常。验证：unit'].join('\n');
  const child = toChildMaterial(body);
  assert.deepEqual([child.structure, child.scList.map((x) => x.sc)], ['parsed', ['SC1']]);
});

test('代码行判定与 CommonMark(markdown-it)逐行一致:四轮复审反例、容器写法与 60 段贴近真实写法的随机文本', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/task-issue/commonmark-code-lines.json', import.meta.url), 'utf8'));
  assert.ok(fixture.docs.length >= 70);
  for (const doc of fixture.docs) {
    const mine = toCodeMask(doc.lines);
    const diff = doc.lines.map((line, i) => (line.trim() && mine[i] !== doc.code[i] ? `L${i + 1} 期望${doc.code[i] ? '代码' : '正文'} |${line}` : null)).filter(Boolean);
    assert.deepEqual(diff, [], doc.name);
  }
});

test('R5-F1:验收段第一行是缩进代码块时,示例 SC 仍不算(切段落不去掉行首缩进)', () => {
  const sc = ['', '    - [ ] SC99 示例。验证：paid', '', '- [ ] SC1 实际验收。验证：unit'].join('\n');
  const child = toChildMaterial(mini({ sc }));
  assert.deepEqual(child.scList.map((x) => x.sc), ['SC1']);
  assert.deepEqual(toDerived({ child, files: [] }).blackboxSc, []);
  assert.match(child.sections.验收标准, /^ {4}- \[ \] SC99/, '段首缩进保留');
});

test('子 issue 解析出的验收标准与 CommonMark 判定一致(代码块外的 SC 行):R5-F1、引用续行与 40 份按模板生成的正文', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/task-issue/commonmark-sc-lists.json', import.meta.url), 'utf8'));
  assert.ok(fixture.docs.length >= 40);
  for (const doc of fixture.docs) assert.deepEqual(toChildMaterial(doc.body).scList.map((x) => x.sc), doc.expected, doc.name);
});

// ── SC5 失败只记 warning ──
test('SC5:issue 不存在、没权限或 gh 出错时只记 warning,不抛错', () => {
  const forbidden = collectTaskIssue({ repo: 'o/r', pr: 7, prBody: '任务 issue：#12', files: [], ghFn: fakeGh({ issue: () => ({ fail: 'HTTP 403: Resource not accessible by integration' }) }).fn });
  assert.deepEqual([forbidden.material.status, forbidden.material.note, forbidden.summary.ref], ['unreadable', '任务 issue 读不到', null]);
  assert.ok(forbidden.material.warnings.some((w) => /403/.test(w)));
  const missing = collectTaskIssue({ repo: 'o/r', pr: 7, prBody: '任务 issue：#12', files: [],
    ghFn: fakeGh({ issue: () => ({ fail: 'exit 1', stdout: JSON.stringify({ data: { repository: { issue: null } }, errors: [{ message: 'Could not resolve to an Issue with the number of 12.' }] }) }) }).fn });
  assert.equal(missing.material.status, 'unreadable');
  assert.ok(missing.material.warnings.some((w) => /Could not resolve/.test(w)));
  const thrown = collectTaskIssue({ repo: 'o/r', pr: 7, prBody: '任务 issue：#12', files: [], baseRefName: 'main', ghFn: () => { throw new Error('spawn gh ENOENT'); } });
  assert.deepEqual([thrown.summary.status, thrown.summary.baseRef], ['unreadable', 'main']);
  assert.match(thrown.material.warnings[0], /ENOENT/);
});

test('SC5:GraphQL 部分字段报错时用能读到的部分', () => {
  const partial = toGraphqlResult({ ok: false, status: 1, stdout: JSON.stringify({ data: { repository: { issue: { number: 1 } } }, errors: [{ message: 'parent: forbidden' }] }) });
  assert.deepEqual(partial.data, { repository: { issue: { number: 1 } } });
  assert.match(partial.error, /部分字段读不到:parent: forbidden/);
  assert.match(toGraphqlResult({ ok: false, status: 1, stdout: '', stderr: 'HTTP 502' }).error, /502/);
});

// ── SC6 codex 阶段没有令牌 ──
test('SC6:模块只经注入的 ghFn 读 GitHub,不碰环境变量、不起子进程;review.mjs 只在 prepare 里调用', () => {
  const source = readFileSync(new URL('./task-issue.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|child_process|spawn|execFile/);
  const review = readFileSync(new URL('../server/review.mjs', import.meta.url), 'utf8');
  const prepare = review.slice(review.indexOf('async function prepare()'), review.indexOf('\nfunction ', review.indexOf('async function prepare()')));
  assert.equal((review.match(/collectTaskIssue\(/g) ?? []).length, 1);
  assert.match(prepare, /collectTaskIssue\(/, '只在 prepare 阶段(有令牌)读');
  const codexStart = review.indexOf('async function codex()');
  assert.ok(codexStart > 0);
  assert.doesNotMatch(review.slice(codexStart, review.indexOf('\nasync function ', codexStart + 10)), /collectTaskIssue|readTaskIssue/);
});

test('结果包摘要只带链接、摘要、可信度和 SC 编号,不带正文', () => {
  const { material } = read();
  const summary = toTaskIssueSummary(material);
  assert.deepEqual(Object.keys(summary), ['ref', 'digest', 'trust', 'scList', 'parent', 'baseRef', 'status', 'truncated']);
  assert.deepEqual(summary.parent, { ref: 'o/r#100', via: 'api', trust: 'plan', digest: material.parent.digest });
  assert.equal(summary.scList[2].layer, 'cindy-mac');
  assert.ok(!JSON.stringify(summary).includes('导出选区'));
});
