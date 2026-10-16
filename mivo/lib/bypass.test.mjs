import test from 'node:test';
import assert from 'node:assert/strict';
import { REMINDER_MARKER, hasBypassReason, hasReminderMarker, selectBypassSuites, toBypassReminders, toReminderBody } from './bypass.mjs';

// 真实评论原文(2026-10-17 从 xindong/mivo-canvas-plugin 的 #970、#972、#1018、#1024 取回):
// 前两条的写法是「绕过合并说明」,后两条是「紧急强合口子(bypass)」。两种写法都必须认作「已写原因」。
export const REAL_REASON_COMMENTS = {
  970: "**绕过合并说明**(Art Support 维护者 PraiseZhu 决定)\n\n- 为什么绕过:本 PR 只改 `.github/workflows/review-pr.yml`(受保护路径),作者是 PraiseZhu,服务器审查要等作者以外的维护者放行。按新审查机修正方案,这个改动必须和 Review-PR 新版本(模型预算按作业时间收缩、Mini 执行超过 170 分钟才取消)在同一个上线停点一起生效,所以由维护者决定绕过合并。\n- 跳过的条件:必需检查 `review-pr`(受保护路径要作者以外的维护者放行)。其它必需检查都已通过。\n- 已做的审查:GPT 单审(gpt-6.1-sol)没有 P0/P1;`review_pr_workflow.node-test.mjs` 12/12 通过,变异测试确认把 160 改回 110 或删掉新环境变量会被拦住。\n- 合并的提交:`e808709d0911502a628c2c790ea704cda969ad0f`。",
  972: "**绕过合并说明**（Art Support 维护者 PraiseZhu 决定）\n\n- 为什么绕过：本 PR 新增 `.github/workflows/review-watchdog.yml`（受保护路径），作者是 PraiseZhu，服务器审查要等作者以外的维护者放行；维护者已决定按新审查机修正方案用 Art Support 绕过合并。\n- 跳过的条件：必需检查 `review-pr`（受保护路径要作者以外的维护者放行）。其它必需检查都已通过，含平台证据门与当前 head 的 Windows 单测、冒烟。\n- 已做的审查：GPT 单审（gpt-6.1-sol）没有 P0/P1；记 1 条 P2：真实故障已提醒后，手动用 1～45 分钟的 `simulate_age_min` 演练会发出不带「演练」标记的「已恢复」，下一次正常运行会重新告警。`check.test.mjs` 13/13、`review_pr_workflow.node-test.mjs` 14/14 通过。\n- 合并的提交：`4efd9bf4e6af34ca2a655d1a2df437807f000e67`（在 GPT 审过的 `99d3b2c` 上合入最新 main，本 PR 自己的改动没有变）。\n",
  1018: "**维护者 PraiseZhu 决定对本 PR 使用紧急强合口子(bypass),说明如下。**\n\n- **跳过哪一项**:只跳过必需检查 `review-pr`。本 PR 改了 `.github/workflows/ci.yml` 和 `.github/workflows/plugin-health.yml`,属于受保护路径,自动审查机不审、不出这条检查,按 `CONTRIBUTING.md` 需要另一位维护者在当前 head 上 Approve 才会变绿。作者本人不能 Approve 自己的 PR。\n- **为什么不等**:这不是线上事故,是维护者 PraiseZhu 在本会话明确要求强合(2026-10-16)。\n- **其余门禁都已满足**(head `1d965474e0645242ba5d717bed4755ada1fe4059`):8 项必需检查里除 `review-pr` 外 7 项成功;Windows 4 个 unit 分片和 Windows plugin smoke 成功;未解决评审线程 0 条。\n- **补充的人工把关**:独立代码审查(review-pr skill,GPT)结论 PASS+NOTES,没有成立的 P0/P1;e2e 验证(真实 vitest、真实 job 数据干跑 plugin-health)结论 E2E PASS。记录的 P2/P3 不阻塞,不在本 PR 修。\n- **合并方式**:Squash,并用 `--match-head-commit` 锁定上述 head,head 变化则拒绝合并。\n\n背景:issue #1004(Plugin Nightly 因 depositBrain 用例超时翻红)。本 PR 不关闭该 issue,它按哨兵规则在 main 上 Plugin Nightly 实际重跑转绿后自动关闭。\n",
  // #1031(2026-10-17 01:23 绕过合入)上的「人工审批例外」说明:正文没有 绕过/强合/bypass/三审,末尾是 mivo-pr1031-approved-merge-exception 暗记
  1031: "本次按维护者在当前会话的明确授权（“合并”），对 #1031 执行一次人工审批例外。独立 GPT 单审和端到端验证已通过，没有 P0/P1；当前提交的构建、Linux/Windows 测试、CodeQL、Greptile 和增量安全扫描均通过，未解决评审线程为 0。\n\n本次仅跳过尚未产生的 review-pr 人工审批检查（受保护路径等待另一位维护者 Approve），以 squash 方式合并并绑定已验证的提交。合入后将 main/release 的 pr-size-gate 检查替换为 pr-ci-freshness，其余门禁保留。\n\n执行账号：PraiseZhu。已验证 head：f6c0dc383f63db4e73f75eea8a12f653446a7c09；base：aac55b01dcc855d5728fbe9ebfdb4ab5b655abea。\n<!-- mivo-pr1031-approved-merge-exception head=f6c0dc383f63db4e73f75eea8a12f653446a7c09 -->",
  1024: "**维护者 PraiseZhu 决定对本 PR 使用紧急强合口子(bypass),说明如下。**\n\n- **跳过哪一项**:只跳过必需检查 `review-pr`。本 PR 改了 `.github/workflows/plugin-health.yml`,属于受保护路径,自动审查机不审、不出这条检查;作者本人不能 Approve 自己的 PR。\n- **为什么不等**:不是线上事故,是维护者 PraiseZhu 在会话中明确要求「审查和 e2e 通过就合」(2026-10-16)。\n- **其余门禁都已满足**(head `90a67b3fea973cdd743bf6c54138d0829ddf8a73`):必需检查除 `review-pr` 外全部成功,无失败或进行中的检查;未解决评审线程 0 条;Greptile 5/5。\n- **补充的人工把关**:\n  - 独立代码审查(review-pr skill,GPT):PASS+NOTES,没有成立的 P0/P1。去掉新增白名单块后脚本与 base 字节一致;其余 5 个被监控 workflow 新旧版 1,620 组组合行为一致;误开单、误关单两个方向在 base 上可复现、在 head 上都被挡住。记录 1 条 P3(注释把已退役的 secret-scan dispatch 说成真实复跑),不修。\n  - e2e(GPT):E2E PASS。用真实历史 run 数据驱动新旧版脚本对照,覆盖 #1021 的 dispatch 失败、当年误关 #638/#682 的 dispatch 成功、每日 schedule 与其余 5 个 workflow;新增测试在 base 上按预期失败。\n- **已知取舍**:PR Hygiene 中只在手动派发时出现的真实瞬时故障不再开红灯单,持续故障由每日 schedule 覆盖。\n- **合并方式**:Squash,`--match-head-commit` 锁定上述 head。\n\n合并后 #1021 将按误报手动关闭(not planned)。\n",
};

// #941 上作者的复审请求(节选):「缺测例外」是说某些实机项没测,不是在说明绕过;正文没有 绕过/强合/bypass/三审/审批例外。
const REAL_941_COMMENT = '@PraiseZhu 您在 review `5506920945` 提出的两条 P1,已按方案 A 处理,请在当前 head `c8ed8477ae5b806a24f32977aff12bd94cc289c9` 上复审。\n\n小 SVG 的 Greptile P2 已一并修复,两条 Greptile 讨论已回复证据并销案。当前 head 的 CI 全部通过,Windows 证据也绑定当前 head。主人已接受 `c8ed8477` 的缺测例外,范围与 e7a170a8 相同:真实 Cindy、硬件渲染、系统缩放、真实旧照片和旧档迁移都未实测。这不是实机通过,也不豁免审查。\n\n<!-- machine: review=5506920945 head=c8ed8477ae5b806a24f32977aff12bd94cc289c9 base=fa2ac737 -->';

const SINCE = '2026-10-17T02:00:00+08:00';
const suite = (sha, { actor = 'PraiseZhu', at = '2026-10-17T10:00:00+08:00', result = 'bypass', ref = 'refs/heads/main' } = {}) =>
  ({ id: Number.parseInt(sha, 16) || 1, actor_name: actor, after_sha: sha, before_sha: 'f'.repeat(40), pushed_at: at, result, ref, evaluation_result: null });
const human = (login, text) => ({ user: { login, type: 'User' }, body: text });
const sha = (n) => String(n).padStart(40, '0');

test('4 个真实「已写原因」的 PR(#970、#972、#1018、#1024)都不提醒', () => {
  const suites = [970, 972, 1018, 1024].map((n) => suite(sha(n)));
  const prBySha = Object.fromEntries([970, 972, 1018, 1024].map((n) => [sha(n), n]));
  const commentsByPr = Object.fromEntries([970, 972, 1018, 1024].map((n) => [n, [human('PraiseZhu', REAL_REASON_COMMENTS[n])]]));
  const { remind, skipped } = toBypassReminders({ suites, prBySha, commentsByPr, since: SINCE });
  assert.deepEqual(remind, []);
  assert.deepEqual(skipped.map((s) => [s.pr, s.why]), [[970, 'has-reason'], [972, 'has-reason'], [1018, 'has-reason'], [1024, 'has-reason']]);
  for (const n of [970, 972, 1018, 1024]) assert.equal(hasBypassReason([human('PraiseZhu', REAL_REASON_COMMENTS[n])]), true, `#${n}`);
});

test('没有原因评论的绕过:提醒一次,@ 绕过的人,带发生时间和提交', () => {
  const { remind, skipped } = toBypassReminders({
    suites: [suite(sha(1), { actor: 'aj0928' })], prBySha: { [sha(1)]: 941 },
    commentsByPr: { 941: [human('someone', '看起来没问题'), human('PraiseZhu', 'LGTM')] }, since: SINCE,
  });
  assert.deepEqual(remind, [{ pr: 941, actor: 'aj0928', sha: sha(1), at: '2026-10-17T10:00:00+08:00' }]);
  assert.deepEqual(skipped, []);
  const text = toReminderBody({ actor: 'aj0928' });
  assert.ok(text.startsWith('@aj0928 '));
  assert.ok(text.includes('绕过必需检查合入'));
  assert.ok(text.endsWith(REMINDER_MARKER));
});

test('PR 上完全没有评论:提醒', () => {
  const { remind } = toBypassReminders({ suites: [suite(sha(2))], prBySha: { [sha(2)]: 7 }, commentsByPr: {}, since: SINCE });
  assert.equal(remind.length, 1);
});

test('只有 bot 评论,或带 <!-- mivo- 暗记的机器评论含关键词:不算原因,照样提醒', () => {
  const comments = [
    { user: { login: 'github-actions[bot]', type: 'Bot' }, body: '本 PR 绕过了必需检查 bypass 强合 三审' },
    { user: { login: 'someone-bot', type: 'Bot' }, body: '三审通过' },
    human('PraiseZhu', `强合 bypass\n\n<!-- mivo-review:report head=${'a'.repeat(40)} -->`),
    human('PraiseZhu', `三审通过\n\n<!-- review-pr:findings head=${'a'.repeat(40)} digest=b -->`),
  ];
  assert.equal(hasBypassReason(comments), false);
  assert.equal(hasBypassReason([human('PraiseZhu', toReminderBody({ actor: 'PraiseZhu' }))]), false, '提醒自己带暗记,不会被当成原因');
  const { remind } = toBypassReminders({ suites: [suite(sha(3))], prBySha: { [sha(3)]: 8 }, commentsByPr: { 8: comments }, since: SINCE });
  assert.equal(remind.length, 1);
  // 关键词大小写不敏感;只要有一条人写的原因评论就不提醒
  assert.equal(hasBypassReason([...comments, human('kirozeng', 'Bypass 原因:CI 机器故障')]), true);
});

test('PR 上已经有本提醒自己的暗记评论:按已提醒处理(状态文件丢了、或发评论的结果不确定时也不会再发第二条)', () => {
  const comments = [{ user: { login: 'PraiseZhu', type: 'User' }, body: toReminderBody({ actor: 'PraiseZhu' }) }];
  const { remind, skipped } = toBypassReminders({ suites: [suite(sha(30))], prBySha: { [sha(30)]: 60 }, commentsByPr: { 60: comments }, since: SINCE });
  assert.deepEqual(remind, []);
  assert.deepEqual(skipped, [{ pr: 60, sha: sha(30), why: 'reminded' }]);
  assert.equal(hasReminderMarker(comments), true);
  assert.equal(hasReminderMarker([human('x', '普通评论 <!-- mivo-review:report head=a -->')]), false, '别的 mivo- 暗记不算');
});

test('关键词四选一都算原因:绕过、强合、bypass、三审', () => {
  for (const word of ['绕过', '强合', 'BYPASS', '三审']) assert.equal(hasBypassReason([human('x', `原因 ${word} 已说明`)]), true, word);
  assert.equal(hasBypassReason([human('x', '这是普通评论')]), false);
  assert.equal(hasBypassReason(undefined), false);
});

test('合入时间早于上线时间:不提醒,也不进 skipped(静默忽略)', () => {
  const { remind, skipped } = toBypassReminders({
    suites: [suite(sha(4), { at: '2026-10-17T01:59:59+08:00' })], prBySha: { [sha(4)]: 927 }, commentsByPr: {}, since: SINCE,
  });
  assert.deepEqual([remind, skipped], [[], []]);
  // 上线时刻当刻算上线以后
  assert.equal(toBypassReminders({ suites: [suite(sha(4), { at: SINCE })], prBySha: { [sha(4)]: 927 }, since: SINCE }).remind.length, 1);
});

test('不是 main、不是 bypass、since 读不懂:全部忽略', () => {
  const suites = [suite(sha(5), { ref: 'refs/heads/feature' }), suite(sha(6), { result: 'pass' }), suite(sha(7), { result: 'fail' })];
  const prBySha = { [sha(5)]: 1, [sha(6)]: 2, [sha(7)]: 3 };
  assert.deepEqual(toBypassReminders({ suites, prBySha, since: SINCE }), { remind: [], skipped: [] });
  assert.deepEqual(selectBypassSuites({ suites: [suite(sha(8))], since: 'bad' }), []);
  assert.deepEqual(selectBypassSuites({ suites: undefined, since: SINCE }), []);
});

test('找不到对应 PR:跳过并写明 no-pr', () => {
  const { remind, skipped } = toBypassReminders({ suites: [suite(sha(9))], prBySha: {}, since: SINCE });
  assert.deepEqual(remind, []);
  assert.deepEqual(skipped, [{ pr: null, sha: sha(9), why: 'no-pr' }]);
});

test('已提醒过的 PR 不再提醒;同一个 PR 的两条记录只算一次', () => {
  const { remind, skipped } = toBypassReminders({
    suites: [suite(sha(10)), suite(sha(11)), suite(sha(12), { at: '2026-10-17T11:00:00+08:00' })],
    prBySha: { [sha(10)]: 50, [sha(11)]: 50, [sha(12)]: 51 }, reminded: { 51: { at: 'x', commentUrl: 'y' } }, since: SINCE,
  });
  assert.deepEqual(remind.map((r) => r.pr), [50]);
  assert.deepEqual(skipped.map((s) => [s.pr, s.why]), [[50, 'duplicate'], [51, 'reminded']]);
});

test('单轮最多 5 条,余下的下一轮;最多条数可调', () => {
  const suites = Array.from({ length: 8 }, (_, i) => suite(sha(100 + i), { at: `2026-10-17T10:0${i}:00+08:00` }));
  const prBySha = Object.fromEntries(suites.map((s, i) => [s.after_sha, 200 + i]));
  const first = toBypassReminders({ suites, prBySha, since: SINCE });
  assert.deepEqual(first.remind.map((r) => r.pr), [200, 201, 202, 203, 204]);
  assert.deepEqual(first.skipped.map((s) => s.why), ['over-limit', 'over-limit', 'over-limit']);
  assert.equal(toBypassReminders({ suites, prBySha, since: SINCE, maxPerRun: 2 }).remind.length, 2);
  const reminded = Object.fromEntries(first.remind.map((r) => [r.pr, { at: 'x' }]));
  assert.deepEqual(toBypassReminders({ suites, prBySha, reminded, since: SINCE }).remind.map((r) => r.pr), [205, 206, 207]);
});

test('规则集记录按合入先后处理(接口返回新的在前,最旧的先提醒)', () => {
  const newer = suite(sha(20), { at: '2026-10-17T12:00:00+08:00' });
  const older = suite(sha(21), { at: '2026-10-17T09:00:00+08:00' });
  const { remind } = toBypassReminders({ suites: [newer, older], prBySha: { [sha(20)]: 2, [sha(21)]: 1 }, since: SINCE });
  assert.deepEqual(remind.map((r) => r.pr), [1, 2]);
});

test('#1031 的「人工审批例外」评论(正文有「例外」,暗记是人手写的 mivo-pr1031-approved-merge-exception)认作已写原因', () => {
  const comment = human('PraiseZhu', REAL_REASON_COMMENTS[1031]);
  assert.equal(hasBypassReason([comment]), true);
  const { remind, skipped } = toBypassReminders({ suites: [suite(sha(40))], prBySha: { [sha(40)]: 1031 }, commentsByPr: { 1031: [comment] }, since: SINCE });
  assert.deepEqual(remind, []);
  assert.deepEqual(skipped.map((x) => x.why), ['has-reason']);
});

test('关键词是「审批例外」,不是单独的「例外」;只有暗记、没有任何关键词的评论不算原因', () => {
  assert.equal(hasBypassReason([human('PraiseZhu', '本次按维护者授权做一次人工审批例外')]), true);
  assert.equal(hasBypassReason([human('PraiseZhu', '审批例外已记录')]), true);
  assert.equal(hasBypassReason([human('PraiseZhu', '<!-- mivo-pr77-approved-merge-exception head=abc -->')]), false);
  // 单独的「例外」太宽:「缺测例外」「例外情况」之类的日常写法不是绕过原因
  assert.equal(hasBypassReason([human('x', '这个分支是例外情况,不用管')]), false);
});

test('#941 上「缺测例外」评论(2026-10-17 取回节选):不算写了原因,绕过合入照样提醒', () => {
  const comment = human('aj0928', REAL_941_COMMENT);
  assert.equal(hasBypassReason([comment]), false);
  const { remind, skipped } = toBypassReminders({ suites: [suite(sha(60), { actor: 'aj0928' })], prBySha: { [sha(60)]: 941 }, commentsByPr: { 941: [comment] }, since: SINCE });
  assert.deepEqual(remind.map((r) => r.pr), [941]);
  assert.deepEqual(skipped, []);
});

test('审查账号(PraiseZhu)发的带 <!-- review-pr: 暗记的流程评论,正文含「绕过」也不算原因,照样提醒', () => {
  const flow = [
    human('PraiseZhu', '本 PR 绕过了必需检查,已转人工审核。\n\n<!-- review-pr:product-gate pr=77 issue=https://github.com/o/r/issues/9 -->'),
    human('PraiseZhu', `维护者确认已放行,绕过 hold 继续。\n\n<!-- review-pr:signoff-mode=protected -->`),
  ];
  assert.equal(hasBypassReason(flow), false);
  const { remind } = toBypassReminders({ suites: [suite(sha(50))], prBySha: { [sha(50)]: 77 }, commentsByPr: { 77: flow }, since: SINCE });
  assert.deepEqual(remind.map((r) => r.pr), [77]);
});

test('issue 评估评论(<!-- mivo-issue-assessment)也是机器评论:含关键词不算原因', () => {
  const assessment = human('PraiseZhu', '评估:不需要绕过检查,强合风险低。\n<!-- mivo-issue-assessment:v1 repo=o/r issue=5 -->');
  assert.equal(hasBypassReason([assessment]), false);
});

test('只排除机器自己的三种暗记(mivo-review:、review-pr:、mivo-bypass-reminder);人手写的其它 mivo- 暗记不排除', () => {
  assert.equal(hasBypassReason([human('PraiseZhu', '强合 <!-- mivo-review:advisory head=a -->')]), false);
  assert.equal(hasBypassReason([human('PraiseZhu', `强合 <!-- review-pr:findings head=${'a'.repeat(40)} digest=b -->`)]), false);
  assert.equal(hasBypassReason([human('PraiseZhu', `三审 ${REMINDER_MARKER}`)]), false);
  assert.equal(hasBypassReason([human('PraiseZhu', '强合,原因见上 <!-- mivo-custom-note -->')]), true);
  // 作者是 bot 时,带关键词也不算
  assert.equal(hasBypassReason([{ user: { login: 'github-actions[bot]', type: 'Bot' }, body: '例外 强合' }]), false);
});
