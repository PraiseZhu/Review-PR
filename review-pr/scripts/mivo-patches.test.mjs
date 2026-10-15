// mivo-patches.test.mjs — Mivo 补丁的回归(登记见仓库根 MIVO-PATCHES.md)。
// 只测补丁自己的纯函数与权限读取;上游行为由上游自带测试覆盖。
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  fetchMaintainerAuthority,
  computeMaintainerAuthorityDigest,
  validateMaintainerAuthoritySnapshot,
  evaluateMaintainerApprovalPolicy,
  evaluateMaintainerReview,
  evaluateSignoffBlocking,
  isSignoffExemptAuthor,
  isProductSignoffEnabled,
  isUiEvidenceRequired,
  isAdminPermission,
  uiEvidenceNeedsAdminLookup,
  declaresNoUiChange,
  filterIgnoredCiContexts,
  ciMergeStateIgnoring,
  botCheckActivity,
  evaluateBotSettle,
  evaluateCiStatus,
  parseSlackSyncComment,
  isExplicitSlackConsent,
  selectTrustedSlackReleases,
  onlyOwnRequiredChecksPending,
  isAutomatedViewerReview,
  latestSubstantiveReviews,
  selectStandingViewerHumanChangesRequest,
} from './lib.mjs';

const ok = (value) => ({ ok: true, stdout: JSON.stringify(value), stderr: '', status: 0 });
const bad = (message) => ({ ok: false, stdout: '', stderr: message, status: 1 });
const SHA = 'a'.repeat(40);

function allowlistGh({ permissions = {}, baseShas = [SHA, SHA] } = {}) {
  const calls = [];
  let commitReads = 0;
  const ghFn = (args) => {
    calls.push(args.join(' '));
    const endpoint = args.find((arg) => arg.startsWith('repos/'));
    if (endpoint === 'repos/xindong/mivo') return ok({ default_branch: 'main' });
    if (endpoint === 'repos/xindong/mivo/commits/main') return ok({ sha: baseShas[Math.min(commitReads++, baseShas.length - 1)] });
    const perm = endpoint?.match(/^repos\/xindong\/mivo\/collaborators\/([^/]+)\/permission$/);
    if (perm) {
      const role = permissions[perm[1]];
      return role ? ok({ permission: role === 'maintain' ? 'write' : role, role_name: role }) : bad('HTTP 404 Not Found');
    }
    return bad(`unexpected ${args.join(' ')}`);
  };
  return { ghFn, calls };
}

test('allowlist 来源不读 CODEOWNERS,成员即白名单,权限逐个核实', () => {
  const { ghFn, calls } = allowlistGh({ permissions: { praisezhu: 'admin', kirozeng: 'write', aj0928: 'maintain' } });
  const authority = fetchMaintainerAuthority({
    owner: 'xindong', repo: 'mivo', ghFn,
    maintainerSource: 'allowlist', maintainerAllowlist: ['PraiseZhu', 'kirozeng', 'aj0928'],
  });
  assert.deepEqual(authority.members, ['aj0928', 'kirozeng', 'praisezhu']);
  assert.deepEqual(authority.teamMembers, []);
  assert.equal(authority.source, 'allowlist');
  assert.deepEqual(authority.memberPermissions, { aj0928: 'maintain', kirozeng: 'push', praisezhu: 'admin' });
  assert.match(authority.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(calls.some((call) => /CODEOWNERS|teams\//.test(call)), false, '不应读取 CODEOWNERS 或 Team');
  const snapshot = validateMaintainerAuthoritySnapshot({ ...authority, runToken: 'token-12345678' },
    { owner: 'xindong', repo: 'mivo', lockToken: 'token-12345678', expectedDigest: authority.digest });
  assert.equal(snapshot.digest, authority.digest);
  const policy = evaluateMaintainerApprovalPolicy({ authorLogin: 'someone', viewerLogin: 'PraiseZhu', authority });
  assert.equal(policy.viewerIsMaintainer, true);
  assert.equal(policy.viewerAuthoritySource, 'maintainer-allowlist');
});

test('allowlist 成员没有 write 权限、白名单为空或默认分支变化时从严停止', () => {
  const readOnly = allowlistGh({ permissions: { praisezhu: 'admin', kirozeng: 'read' } });
  assert.throws(() => fetchMaintainerAuthority({ owner: 'xindong', repo: 'mivo', ghFn: readOnly.ghFn,
    maintainerSource: 'allowlist', maintainerAllowlist: ['PraiseZhu', 'kirozeng'] }), /kirozeng.*没有 write/);
  const missing = allowlistGh({ permissions: { praisezhu: 'admin' } });
  assert.throws(() => fetchMaintainerAuthority({ owner: 'xindong', repo: 'mivo', ghFn: missing.ghFn,
    maintainerSource: 'allowlist', maintainerAllowlist: ['PraiseZhu', 'ghost'] }), /ghost/);
  const empty = allowlistGh();
  assert.throws(() => fetchMaintainerAuthority({ owner: 'xindong', repo: 'mivo', ghFn: empty.ghFn,
    maintainerSource: 'allowlist', maintainerAllowlist: [] }), /为空/);
  const moving = allowlistGh({ permissions: { praisezhu: 'admin' }, baseShas: [SHA, 'b'.repeat(40)] });
  assert.throws(() => fetchMaintainerAuthority({ owner: 'xindong', repo: 'mivo', ghFn: moving.ghFn,
    maintainerSource: 'allowlist', maintainerAllowlist: ['PraiseZhu'] }), /发生变化/);
});

test('allowlist digest 绑定成员与权限,篡改任一项都会被识别', () => {
  const { ghFn } = allowlistGh({ permissions: { praisezhu: 'admin', kirozeng: 'write' } });
  const authority = fetchMaintainerAuthority({ owner: 'xindong', repo: 'mivo', ghFn,
    maintainerSource: 'allowlist', maintainerAllowlist: ['PraiseZhu', 'kirozeng'] });
  const tamperedMembers = { ...authority, members: ['kirozeng', 'mallory', 'praisezhu'] };
  assert.throws(() => computeMaintainerAuthorityDigest(tamperedMembers), /不完整/);
  const tamperedPermission = { ...authority, memberPermissions: { ...authority.memberPermissions, kirozeng: 'pull' } };
  assert.throws(() => computeMaintainerAuthorityDigest(tamperedPermission), /不完整/);
  const forged = { ...authority, teamMembers: ['mallory'], runToken: 'token-12345678' };
  assert.throws(() => validateMaintainerAuthoritySnapshot(forged,
    { owner: 'xindong', repo: 'mivo', lockToken: 'token-12345678' }));
});

test('豁免名单只免前置确认门,不给放行权', () => {
  const rules = { signoffGate: { exemptAuthors: ['PraiseZhu', 'zhongxingtian-ai'] } };
  assert.equal(isSignoffExemptAuthor('zhongxingtian-ai', rules), true);
  assert.equal(isSignoffExemptAuthor('ZHONGXINGTIAN-AI', rules), true);
  assert.equal(isSignoffExemptAuthor('outsider', rules), false);
  assert.equal(isSignoffExemptAuthor('', rules), false);
  assert.equal(evaluateSignoffBlocking({ enabled: true, authorIsMaintainer: true }), false);
  // 豁免作者自己的 Approve 不构成放行:evaluateMaintainerReview 只认维护者,且排除作者本人。
  const review = evaluateMaintainerReview({
    reviews: [{ author: { login: 'zhongxingtian-ai' }, state: 'APPROVED', submittedAt: '2026-10-11T01:00:00Z' }],
    maintainers: ['praisezhu'], authorLogin: 'someone', latestCommitDate: '2026-10-11T00:00:00Z',
  });
  assert.equal(review.released, null);
});

test('CI 忽略名单只去掉本流程自己的 check', () => {
  const contexts = [{ name: 'review-pr', conclusion: 'FAILURE' }, { name: 'verify', conclusion: 'SUCCESS' }];
  assert.deepEqual(filterIgnoredCiContexts(contexts, { ciIgnoreContexts: ['review-pr'] }).map((c) => c.name), ['verify']);
  assert.equal(filterIgnoredCiContexts(null, { ciIgnoreContexts: ['review-pr'] }), null);
  assert.equal(filterIgnoredCiContexts(contexts, {}), contexts);
  const retired = [{ name: 'seat1', workflowName: 'Code Review', conclusion: 'FAILURE' }, { name: 'verify', workflowName: 'CI', conclusion: 'SUCCESS' }];
  assert.deepEqual(filterIgnoredCiContexts(retired, { ciIgnoreWorkflows: { names: ['Code Review'] } }).map((c) => c.name), ['verify']);
});

test('UNSTABLE 只由被忽略的 check 造成时 CI 判通过,另有失败仍判失败', () => {
  const rules = { ciIgnoreBotChecks: ['Greptile Review'] };
  const greptileRed = [{ name: 'Greptile Review', conclusion: 'FAILURE' }, { name: 'verify', workflowName: 'CI', conclusion: 'SUCCESS' }];
  const state = ciMergeStateIgnoring('UNSTABLE', greptileRed, rules);
  assert.equal(evaluateCiStatus({ rollup: { failed: [], pending: [], awaiting: [] }, ciRuns: null, mergeStateStatus: state }).status, 'pass');
  const allGreen = [{ name: 'Greptile Review', conclusion: 'SUCCESS' }, { name: 'verify', conclusion: 'SUCCESS' }];
  assert.equal(ciMergeStateIgnoring('UNSTABLE', allGreen, rules), 'UNSTABLE', '被忽略的都通过,UNSTABLE 另有原因,保持从严');
  assert.equal(ciMergeStateIgnoring('UNSTABLE', null, rules), 'UNSTABLE');
  assert.equal(ciMergeStateIgnoring('BLOCKED', greptileRed, rules), 'BLOCKED');
  const bothRed = [...greptileRed.slice(0, 1), { name: 'verify', conclusion: 'FAILURE' }];
  assert.equal(evaluateCiStatus({ rollup: { failed: ['verify'], pending: [], awaiting: [] }, ciRuns: null,
    mergeStateStatus: ciMergeStateIgnoring('UNSTABLE', bothRed, rules) }).status, 'failed');
});

test('评审 bot 的信心阈值 check 不算作者 CI', () => {
  const contexts = [{ name: 'Greptile Review', conclusion: 'FAILURE' }, { name: 'verify', workflowName: 'CI', conclusion: 'FAILURE' }];
  assert.deepEqual(filterIgnoredCiContexts(contexts, { ciIgnoreBotChecks: ['Greptile Review'] }).map((c) => c.name), ['verify']);
  assert.deepEqual(filterIgnoredCiContexts(contexts, { ciIgnoreContexts: ['review-pr'], ciIgnoreBotChecks: ['Greptile Review'] }).map((c) => c.name), ['verify']);
});

const syncBody = (login, text, fp = 'C123:1760000000.000100') =>
  `来自 Slack #mivo-canvas · @${login}(显示名)\n\n${text}\n\n<!-- slack-inbound ${fp} -->`;
const botComment = (login, text, createdAt = '2026-10-11T02:00:00Z', poster = 'github-actions[bot]') =>
  ({ author: { login: poster }, body: syncBody(login, text), createdAt });

test('Slack 同步评论解析:署名取首行,标记必须存在', () => {
  assert.deepEqual(parseSlackSyncComment(syncBody('kirozeng', '同意放行')),
    { login: 'kirozeng', message: '同意放行', fingerprint: 'C123:1760000000.000100' });
  assert.equal(parseSlackSyncComment('来自 Slack #x · @kirozeng\n\n同意放行'), null);
  assert.equal(parseSlackSyncComment('随便说说\n来自 Slack #x · @kirozeng\n<!-- slack-inbound a:b -->'), null);
});

test('同意判定:必须有一整行同意短语,带否定词不算', () => {
  for (const text of ['同意放行', '同意放行。', '看过了\n同意放行！', '  同意放行  ']) {
    assert.equal(isExplicitSlackConsent(text), true, text);
  }
  for (const text of ['我同意放行吗', '先不要同意放行', '不同意放行', '同意放行，但是先别合', '同意', 'LGTM', '']) {
    assert.equal(isExplicitSlackConsent(text), false, text);
  }
});

test('Slack 放行:只认同步 bot 发出、署名是维护者且不是 PR 作者的明确同意', () => {
  const base = { syncBots: ['github-actions[bot]'], maintainers: ['praisezhu', 'kirozeng', 'aj0928'], authorLogin: 'aj0928' };
  const trusted = selectTrustedSlackReleases({ ...base, comments: [botComment('kirozeng', '同意放行')] });
  assert.equal(trusted.release?.by, 'kirozeng');
  assert.equal(trusted.release?.via, 'slack-release');

  const forgedPoster = selectTrustedSlackReleases({ ...base, comments: [botComment('kirozeng', '同意放行', undefined, 'mallory')] });
  assert.equal(forgedPoster.release, null);
  assert.equal(forgedPoster.rejected[0].reason, 'poster-not-sync-bot');

  const notMaintainer = selectTrustedSlackReleases({ ...base, comments: [botComment('zhongxingtian-ai', '同意放行')] });
  assert.equal(notMaintainer.release, null);
  assert.equal(notMaintainer.rejected[0].reason, 'signer-not-maintainer');

  const selfRelease = selectTrustedSlackReleases({ ...base, comments: [botComment('aj0928', '同意放行')] });
  assert.equal(selfRelease.release, null);
  assert.equal(selfRelease.rejected[0].reason, 'signer-is-author');

  const chatter = selectTrustedSlackReleases({ ...base, comments: [botComment('kirozeng', '再看看')] });
  assert.equal(chatter.release, null);
  assert.deepEqual(chatter.rejected, []);

  const latest = selectTrustedSlackReleases({ ...base, comments: [
    botComment('kirozeng', '同意放行', '2026-10-11T02:00:00Z'),
    botComment('praisezhu', '同意放行', '2026-10-11T03:00:00Z'),
  ] });
  assert.equal(latest.release.by, 'praisezhu');
});

test('Slack 放行接入维护者确认门后按标记口径持久有效', () => {
  const release = { by: 'kirozeng', at: '2026-10-11T02:00:00Z', via: 'slack-release' };
  const later = evaluateMaintainerReview({
    reviews: [], maintainers: ['kirozeng'], authorLogin: 'outsider',
    latestCommitDate: '2026-10-12T00:00:00Z', markerRelease: release,
  });
  assert.equal(later.released?.via, 'slack-release');
  assert.equal(evaluateSignoffBlocking({ enabled: true, released: later.released }), false);
  // 维护者在当前 head 上 Request Changes 时,球回到作者,Slack 放行不覆盖。
  const changes = evaluateMaintainerReview({
    reviews: [{ author: { login: 'praisezhu' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-12T01:00:00Z' }],
    maintainers: ['kirozeng', 'praisezhu'], authorLogin: 'outsider',
    latestCommitDate: '2026-10-12T00:00:00Z', markerRelease: release,
  });
  assert.equal(changes.waitingForAuthor, true);
  assert.equal(changes.released, null);
});

test('只差本流程自己的必需检查时不算结构性卡点,其余缺失从严', () => {
  const rules = { ciIgnoreContexts: ['review-pr'] };
  const probe = { requiredStatusChecks: [{ context: 'verify' }, { context: 'review-pr' }] };
  const passed = [{ name: 'verify', conclusion: 'SUCCESS' }];
  assert.equal(onlyOwnRequiredChecksPending({ probe, rollupContexts: passed, rules }), true);
  assert.equal(onlyOwnRequiredChecksPending({ probe, rollupContexts: [...passed, { name: 'review-pr', conclusion: 'FAILURE' }], rules }), true);
  assert.equal(onlyOwnRequiredChecksPending({ probe, rollupContexts: [], rules }), false, 'verify 也没上报');
  assert.equal(onlyOwnRequiredChecksPending({ probe, rollupContexts: [...passed, { name: 'review-pr', conclusion: 'SUCCESS' }], rules }), false, '全部满足就不是这种情况');
  assert.equal(onlyOwnRequiredChecksPending({ probe: null, rollupContexts: passed, rules }), false);
});

test('机器人在当前 head 上的 check 跑完算表态', () => {
  const cfg = { reviewers: ['greptile-apps'], quietMinutes: 5, maxWaitMinutes: 30, checkNames: { 'greptile-apps': 'Greptile Review' } };
  const rollup = [
    { name: 'Greptile Review', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-11T12:56:40Z' },
    { name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-11T12:56:00Z' },
  ];
  assert.deepEqual(botCheckActivity(rollup, cfg), [{ author: 'greptile-apps', at: '2026-10-11T12:56:40Z' }]);
  const settled = evaluateBotSettle({ headCommittedDate: '2026-10-11T12:54:39Z', nowIso: '2026-10-11T13:05:00Z', activity: botCheckActivity(rollup, cfg), cfg });
  assert.equal(settled.settled, true);
  assert.equal(settled.timedOut, false);
  const quiet = evaluateBotSettle({ headCommittedDate: '2026-10-11T12:54:39Z', nowIso: '2026-10-11T12:58:00Z', activity: botCheckActivity(rollup, cfg), cfg });
  assert.equal(quiet.settled, false, '跑完后仍要静默 5 分钟');
  const running = [{ name: 'Greptile Review', status: 'IN_PROGRESS', conclusion: null, completedAt: null }];
  assert.deepEqual(botCheckActivity(running, cfg), []);
  assert.deepEqual(botCheckActivity(rollup, { reviewers: ['greptile-apps'] }), [], '没配 checkNames 时与上游一致');
  assert.deepEqual(botCheckActivity(null, cfg), []);
});

test('改界面不进维护者确认门,按 requireUiEvidence 要求附界面证据', () => {
  assert.equal(isProductSignoffEnabled({ signoffGate: { product: { enabled: false } } }), false);
  assert.equal(isProductSignoffEnabled({ signoffGate: { product: {} } }), true); // 上游缺省:照常触发
  const nonExempt = { signoffGate: { product: { requireUiEvidence: 'non-exempt' } } };
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorExempt: false }, nonExempt), true);
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorExempt: true }, nonExempt), false);
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: false, authorExempt: false }, nonExempt), false);
  const all = { signoffGate: { product: { requireUiEvidence: 'all' } } };
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorExempt: true }, all), true);
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorExempt: false }, { signoffGate: {} }), false);
});

test('Mivo 生产配置:产品/UI 门关闭,admin 以外的作者缺界面证据要打回', () => {
  const rules = JSON.parse(readFileSync(new URL('../config/pr-rules.json', import.meta.url), 'utf8'));
  assert.equal(isProductSignoffEnabled(rules), false);
  assert.equal(rules.signoffGate.product.requireUiEvidence, 'non-admin');
  assert.equal(uiEvidenceNeedsAdminLookup(rules), true);
  assert.ok(rules.signoffGate.product.uiPaths.includes('src/'));
});

test('「效果展示」第一行写「不涉及」:配了 acceptNotApplicable 就不再要求界面证据', () => {
  const tpl = (content) => `## 这次改了什么\n\n### 效果展示\n\n<!--\n涉及页面或生成效果时，附截图、录屏或生成样例。\n不涉及则写「不涉及」。\n-->\n${content}\n\n## 怎么验证的\n`;
  assert.equal(declaresNoUiChange(tpl('不涉及')), true);
  assert.equal(declaresNoUiChange(tpl('不涉及（只改注释，界面没有变化）')), true);
  assert.equal(declaresNoUiChange(tpl('不涉及：只改日志')), true);
  assert.equal(declaresNoUiChange(tpl('')), false, '只有模板注释、没写内容');
  assert.equal(declaresNoUiChange(tpl('界面有变化,截图稍后补;不涉及动效')), false, '「不涉及」不在第一行开头');
  assert.equal(declaresNoUiChange(tpl('不涉及的部分略')), false, '「不涉及的」不是声明');
  assert.equal(declaresNoUiChange('## 这次改了什么\n\n不涉及\n'), false, '没有「效果展示」段');
  const rules = { signoffGate: { product: { requireUiEvidence: 'non-exempt', acceptNotApplicable: true } } };
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorExempt: false, declaredNotApplicable: true }, rules), false);
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorExempt: false, declaredNotApplicable: false }, rules), true);
  const strict = { signoffGate: { product: { requireUiEvidence: 'non-exempt' } } };
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorExempt: false, declaredNotApplicable: true }, strict), true);
  const prod = JSON.parse(readFileSync(new URL('../config/pr-rules.json', import.meta.url), 'utf8'));
  assert.equal(prod.signoffGate.product.acceptNotApplicable, true);
});

test('审查账号自动提交的 review 不算维护者确认,维护者本人手动的照常算', () => {
  const viewer = 'PraiseZhu';
  const review = (login, state, body, at) => ({ user: { login }, author: { login }, state, body, submittedAt: at });
  const gateRc = review(viewer, 'CHANGES_REQUESTED', '缺界面证据\n\n<!-- review-pr:gate-review kind=format head=' + SHA + ' -->', '2026-10-12T03:00:00Z');
  const autoApprove = review(viewer, 'APPROVED', '> Mivo 自动审查 · [PR](https://example) · head `aaaaaaaaaaaa`\n\n## Overall\n\npass', '2026-10-11T03:00:00Z');
  const findingsRc = review(viewer, 'CHANGES_REQUESTED', '> Mivo 自动审查 · ...\n\n<!-- review-pr:findings head=' + SHA + ' digest=x -->', '2026-10-12T03:00:00Z');
  assert.equal(isAutomatedViewerReview(gateRc, viewer), true);
  assert.equal(isAutomatedViewerReview(autoApprove, 'praisezhu'), true, 'login 大小写不敏感');
  assert.equal(isAutomatedViewerReview(findingsRc, viewer), true);
  assert.equal(isAutomatedViewerReview(review(viewer, 'APPROVED', '看过了,可以合', '2026-10-12T04:00:00Z'), viewer), false, '维护者本人手动 Approve');
  assert.equal(isAutomatedViewerReview(review('kirozeng', 'APPROVED', '<!-- review-pr:gate-review kind=format -->', '2026-10-12T04:00:00Z'), viewer), false, '别人的 review 不因带标记被排除');
  assert.equal(isAutomatedViewerReview(gateRc, ''), false, '不知道审查账号时不排除');

  const maintainers = ['kirozeng', 'praisezhu'];
  const evaluate = (reviews) => evaluateMaintainerReview({
    reviews: reviews.filter((r) => !isAutomatedViewerReview(r, viewer)),
    maintainers, authorLogin: 'lubinyu-lab', latestCommitDate: '2026-10-12T02:00:00Z',
  });
  // F1:自动 Approve 在旧 head 上,之后作者推了大改动、新触发确认门 → 不能被它放行。
  assert.equal(evaluate([autoApprove]).released, null);
  assert.ok(evaluateMaintainerReview({ reviews: [autoApprove], maintainers, authorLogin: 'lubinyu-lab', latestCommitDate: '2026-10-12T02:00:00Z' }).released,
    '不排除时(上游口径)自动 Approve 会被当成维护者放行');
  // F2:维护者已放行,审查账号因缺界面证据自动打回,作者只改描述 → 确认门仍算放行,不判「等作者改」。
  const kiroApprove = review('kirozeng', 'APPROVED', 'ok', '2026-10-11T05:00:00Z');
  const f2 = evaluate([kiroApprove, gateRc]);
  assert.equal(f2.waitingForAuthor, false);
  assert.equal(f2.released?.by, 'kirozeng');
  // 维护者本人在当前 head 上手动 Request Changes,仍然交给作者。
  const manualRc = review(viewer, 'CHANGES_REQUESTED', '这里的交互不对,先改', '2026-10-12T04:00:00Z');
  assert.equal(evaluate([kiroApprove, manualRc]).waitingForAuthor, true);
  // 接线:context.mjs 用排除后的 review 评确认门。
  const context = readFileSync(new URL('./context.mjs', import.meta.url), 'utf8');
  assert.match(context, /evaluateMaintainerReview\(\{\n\s+reviews: signoffReviews,/);
  assert.match(context, /const signoffReviews = prReviews\.filter\(\(r\) => !isAutomatedViewerReview\(r, viewerLower\)\);/);
});

const viewerReview = (id, state, body, at, extra = {}) => ({
  id,
  user: { login: extra.login ?? 'PraiseZhu' },
  author: { login: extra.login ?? 'PraiseZhu' },
  state,
  body,
  submitted_at: at,
  submittedAt: at,
});
const HUMAN_CR_BODY = '交互式审查:2 条 P1,先改再合';
const AUTO_CR_HEADER = '> Mivo 自动审查 · [PR](https://github.com/xindong/mivo-canvas-plugin/pull/941) · head `aaaaaaaaaaaa`\n\n## Overall\n';
const AUTO_GATE_BODY = '缺界面证据\n\n<!-- review-pr:gate-review kind=format head=' + SHA + ' -->';
const HUMAN_CR_BLOCKER = '审查账号上有维护者本人的 Request Changes，需本人 Approve 或 dismiss 后再审';
// #941:人工 Approve(空正文) → 人工 CR 5506920945(无标记) → 审查机 CR 5512930585(报告头)
const reviews941 = [
  viewerReview(1, 'APPROVED', '', '2026-10-13T16:31:00Z'),
  viewerReview(5506920945, 'CHANGES_REQUESTED', HUMAN_CR_BODY, '2026-10-13T16:40:00Z'),
  viewerReview(5512930585, 'CHANGES_REQUESTED', AUTO_CR_HEADER, '2026-10-14T04:05:00Z'),
];

test('同一账号上人工 Request Changes 仍有效:审查机后发的 CR 盖不掉,context 不自解、approve 拒绝', () => {
  const viewer = 'PraiseZhu';
  assert.deepEqual(latestSubstantiveReviews(reviews941).map((r) => r.id), [5512930585],
    '按登录名截最新一条时,人工 CR 已经看不见了');
  const standing = selectStandingViewerHumanChangesRequest(reviews941, viewer);
  assert.equal(standing?.id, 5506920945);
  assert.equal(standing?.state, 'CHANGES_REQUESTED');
  const gqlShape = reviews941.map(({ user, submitted_at, ...rest }) => rest);
  assert.equal(selectStandingViewerHumanChangesRequest(gqlShape, 'praisezhu')?.id, 5506920945,
    '兼容 context 的 author.login / submittedAt 形状,login 大小写不敏感');

  const laterHumanApprove = [...reviews941, viewerReview(9, 'APPROVED', '看过了,可以合', '2026-10-14T05:00:00Z')];
  assert.equal(selectStandingViewerHumanChangesRequest(laterHumanApprove, viewer), null, '人工 CR 之后人工 Approve:不再有效');

  const dismissed = [
    viewerReview(5506920945, 'DISMISSED', HUMAN_CR_BODY, '2026-10-13T16:40:00Z'),
    viewerReview(5512930585, 'CHANGES_REQUESTED', AUTO_CR_HEADER, '2026-10-14T04:05:00Z'),
  ];
  assert.equal(selectStandingViewerHumanChangesRequest(dismissed, viewer), null, '人工 CR 被 dismiss:不再有效');

  const onlyGate = [viewerReview(5512305370, 'CHANGES_REQUESTED', AUTO_GATE_BODY, '2026-10-14T01:00:00Z')];
  const onlyHeader = [viewerReview(5512720382, 'CHANGES_REQUESTED', AUTO_CR_HEADER, '2026-10-14T02:00:00Z')];
  assert.equal(selectStandingViewerHumanChangesRequest(onlyGate, viewer), null, '只有带 <!-- review-pr: 的审查机 CR:可自解');
  assert.equal(selectStandingViewerHumanChangesRequest(onlyHeader, viewer), null, '只有带报告头的审查机 CR:可自解');
  assert.equal(selectStandingViewerHumanChangesRequest(reviews941, ''), null, '不知道审查账号时不判');
  assert.equal(selectStandingViewerHumanChangesRequest(reviews941, 'kirozeng'), null, '别人的人工 CR 不算审查账号自己的');
  const missingBody = [viewerReview(123, 'CHANGES_REQUESTED', undefined, '2026-10-14T03:00:00Z')];
  delete missingBody[0].body;
  assert.equal(selectStandingViewerHumanChangesRequest(missingBody, viewer)?.id, 123,
    '缺 body 无法证明有没有审查机标记,仍算有效人工 CR');
  const missingBodyApproveAfterHuman = [
    viewerReview(5506920945, 'CHANGES_REQUESTED', HUMAN_CR_BODY, '2026-10-13T16:40:00Z'),
    viewerReview(125, 'APPROVED', undefined, '2026-10-14T05:00:00Z'),
  ];
  delete missingBodyApproveAfterHuman[1].body;
  assert.equal(selectStandingViewerHumanChangesRequest(missingBodyApproveAfterHuman, viewer), null,
    '缺 body 的 viewer APPROVED 排在人工 CR 之后时,人工 CR 不再有效');
  assert.equal(selectStandingViewerHumanChangesRequest([viewerReview(124, 'CHANGES_REQUESTED', '', '2026-10-14T03:00:00Z')], viewer)?.id, 124,
    '空正文仍是人工 CR');

  const context = readFileSync(new URL('./context.mjs', import.meta.url), 'utf8');
  assert.match(context, /selectStandingViewerHumanChangesRequest\(prReviews, viewerLogin\)/);
  assert.match(context, /!standingHumanChangesRequest/);
  assert.match(context, new RegExp(HUMAN_CR_BLOCKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const approve = readFileSync(new URL('./approve-reviewed-pr.mjs', import.meta.url), 'utf8');
  assert.match(approve, /selectStandingViewerHumanChangesRequest\(/);
  assert.match(approve, /reject\('other-changes-requested'/);
  assert.match(approve, new RegExp(HUMAN_CR_BLOCKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('只带 review-pr:findings 暗记的打回算人工打回;有报告头或别的流程标记才算审查机自己的', () => {
  const viewer = 'PraiseZhu';
  const findingsOnly = viewerReview(503, 'CHANGES_REQUESTED', `交互式审查:2 条 P1\n\n<!-- review-pr:findings head=${SHA} digest=y -->`, '2026-10-14T00:40:00Z');
  const serverFindings = viewerReview(501, 'CHANGES_REQUESTED', `${AUTO_CR_HEADER}\n<!-- review-pr:findings head=${SHA} digest=x -->`, '2026-10-14T04:05:00Z');
  const gateWithFindings = viewerReview(502, 'CHANGES_REQUESTED', `${AUTO_GATE_BODY}\n\n<!-- review-pr:findings head=${SHA} digest=z -->`, '2026-10-14T01:00:00Z');
  const reportComment = viewerReview(504, 'COMMENTED', `${AUTO_CR_HEADER}\n<!-- mivo-review:report head=${SHA} -->`, '2026-10-14T02:00:00Z');
  assert.equal(isAutomatedViewerReview(findingsOnly, viewer), false, '交互式带行内评论的打回是维护者本人的');
  assert.equal(isAutomatedViewerReview(serverFindings, viewer), true, '服务器打回有报告头');
  assert.equal(isAutomatedViewerReview(gateWithFindings, viewer), true, '门禁打回有 gate-review 标记');
  assert.equal(isAutomatedViewerReview(reportComment, viewer), true);
  assert.equal(selectStandingViewerHumanChangesRequest([findingsOnly, serverFindings], viewer)?.id, 503,
    '审查机后发的打回盖不掉交互式人工打回');
});

// approve-reviewed-pr.mjs 的真实 CLI:gh 换成夹具,不碰 GitHub。夹具与 approval-cli.test.mjs 同一套接口。
function ownCrFixtureGh(args, options, fixture) {
  const ok = (value) => ({ status: 0, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const endpoint = args.find((arg) => typeof arg === 'string' && /^(?:repos|orgs)\//.test(arg));
  if (args[0] === 'pr' && args[1] === 'view') return ok(fixture.meta);
  if (args[0] === 'api' && args[1] === 'user') return ok(fixture.viewer);
  if (endpoint === 'repos/o/r') return ok({ default_branch: 'main' });
  if (endpoint === 'repos/o/r/commits/main') return ok({ sha: fixture.base });
  if (endpoint === 'repos/o/r/contents/.github/CODEOWNERS') return ok({ type: 'file', encoding: 'base64', sha: 'blob',
    content: Buffer.from('* @o/maintainers\n').toString('base64') });
  if (endpoint === 'orgs/o/teams/maintainers') return ok({ privacy: 'closed' });
  if (endpoint === 'orgs/o/teams/maintainers/repos/o/r') return ok({ permissions: { push: true } });
  if (endpoint === 'orgs/o/teams/maintainers/members') return ok([[{ login: 'maintainer' }, { login: 'other' }]]);
  if (args[0] === 'api' && args[1] === 'graphql') return ok({ data: { repository: { pullRequest: {
    reviewThreads: { nodes: fixture.threads || [], pageInfo: { hasNextPage: false, endCursor: null } },
  } } } });
  if (endpoint === 'repos/o/r/pulls/1/reviews' && args.includes('GET')) return ok([fixture.reviews]);
  if (endpoint === 'repos/o/r/pulls/1/reviews' && args.includes('POST')) {
    fixture.posts++;
    fixture.reviews.push(fixture.newReview);
    return ok(fixture.newReview);
  }
  throw new Error(`unexpected fixture command: ${args.join(' ')}`);
}

test('审查机 Approve 只能盖掉审查机自己的打回;--allow-override-own-cr 只放行指定的那一条人工打回', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mivo-own-cr-'));
  try {
    const head = 'a'.repeat(40);
    const base = 'b'.repeat(40);
    const repoRoot = join(directory, 'repo');
    mkdirSync(repoRoot);
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
      const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
    const rulesFile = join(directory, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ maintainerAllowlist: [] }));
    const fixtureFile = join(directory, 'fixture.json');
    const mockFile = join(directory, 'mock.mjs');
    writeFileSync(mockFile, `import { readFileSync, writeFileSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const ownCrFixtureGh = ${ownCrFixtureGh.toString()};
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command !== 'gh') return original(command, args, options);
  const fixture = JSON.parse(readFileSync(process.env.OWN_CR_FIXTURE, 'utf8'));
  const result = ownCrFixtureGh(args, options, fixture);
  writeFileSync(process.env.OWN_CR_FIXTURE, JSON.stringify(fixture));
  return result;
};
syncBuiltinESMExports();
`);
    const own = (id, body) => ({ id, user: { login: 'maintainer' }, state: 'CHANGES_REQUESTED', commit_id: 'c'.repeat(40),
      submitted_at: '2026-10-14T00:40:00Z', body });
    const SERVER_CR = own(501, `> Mivo 自动审查 · [PR](https://example) · head \`cccccccccccc\`\n\n## Overall\n\n<!-- review-pr:findings head=${'c'.repeat(40)} digest=x -->`);
    const HANDWRITTEN_CR = own(502, '这里的交互不对,先改');
    const INTERACTIVE_CR = own(503, `交互式审查:2 条 P1\n\n<!-- review-pr:findings head=${'c'.repeat(40)} digest=y -->`);
    const basic = (reviews) => ({ head, base, viewer: 'maintainer', posts: 0, reviews,
      meta: { state: 'OPEN', isDraft: false, author: { login: 'author' }, headRefOid: head, baseRefName: 'main', baseRefOid: base, reviewDecision: 'CHANGES_REQUESTED' },
      newReview: { id: 999, state: 'APPROVED', commit_id: head, user: { login: 'maintainer' },
        submitted_at: '2026-10-14T06:00:00Z', html_url: 'https://github.com/o/r/pull/1#pullrequestreview-999' } });
    const authority = fetchMaintainerAuthority({ owner: 'o', repo: 'r', maintainerAllowlist: [], maintainerSource: null,
      ghFn: (args, options) => { const result = ownCrFixtureGh(args, options, basic([])); return { ...result, ok: result.status === 0 }; } });
    const envBase = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFile).href}`].filter(Boolean).join(' '),
      REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_RULES_FILE: rulesFile, OWN_CR_FIXTURE: fixtureFile, REVIEW_PR_NO_CRED_FALLBACK: '1' };
    let index = 0;
    const scenario = (fixture) => {
      const env = { ...envBase, REVIEW_PR_STATE_DIR: join(directory, `state-${index++}`) };
      writeFileSync(fixtureFile, JSON.stringify(fixture));
      const setup = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import {stateFile} from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)}; import {writeFileSync} from 'node:fs'; writeFileSync(stateFile('lock.json'), JSON.stringify({token:'fixture-lock'}));`],
      { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
      assert.equal(setup.status, 0, setup.stderr);
      return (extra = []) => {
        const child = spawnSync(process.execPath, [fileURLToPath(new URL('./approve-reviewed-pr.mjs', import.meta.url)), '1',
          '--review-clean', '--lock-token', 'fixture-lock', '--expected-head', head, '--expected-base', base,
          '--expected-base-ref', 'main', '--expected-authority-digest', authority.digest, ...extra],
        { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
        assert.ok([0, 1, 2].includes(child.status), child.stdout + child.stderr);
        return JSON.parse(child.stdout);
      };
    };
    const posts = () => JSON.parse(readFileSync(fixtureFile, 'utf8')).posts;

    // ① 服务器打回(报告头):审查机重审通过后可以用 Approve 覆盖。
    let result = scenario(basic([SERVER_CR]))();
    assert.equal(result.approval.status, 'verified', JSON.stringify(result));
    assert.equal(posts(), 1);
    assert.equal(result.overrodeOwnHumanCr, undefined);
    // ② 维护者手写的打回:不能覆盖。
    result = scenario(basic([HANDWRITTEN_CR]))();
    assert.equal(result.approval.code, 'other-changes-requested');
    assert.equal(posts(), 0);
    // ③ 交互式 review-pr 带行内评论的打回(只有 findings 暗记):不能覆盖。
    result = scenario(basic([INTERACTIVE_CR]))();
    assert.equal(result.approval.code, 'other-changes-requested', JSON.stringify(result));
    assert.equal(posts(), 0);
    // ④ 操作者当面同意后带上那条打回的 id 才能覆盖;换别的 id 不行。
    let run = scenario(basic([INTERACTIVE_CR]));
    result = run(['--allow-override-own-cr', '999999']);
    assert.equal(result.approval.code, 'other-changes-requested');
    assert.equal(posts(), 0);
    result = run(['--allow-override-own-cr', '503']);
    assert.equal(result.approval.status, 'verified', JSON.stringify(result));
    assert.equal(result.overrodeOwnHumanCr, '503');
    assert.equal(posts(), 1);
    // 带参数时其它检查照旧:head、base、权限、thread、别人的打回。
    for (const [label, patch] of [
      ['head 变了', (f) => { f.meta.headRefOid = 'd'.repeat(40); }],
      ['base 变了', (f) => { f.meta.baseRefOid = 'e'.repeat(40); }],
      ['viewer 不是维护者', (f) => { f.viewer = 'stranger'; }],
      ['还有未解决 thread', (f) => { f.threads = [{ id: 't1', isResolved: false }]; }],
      ['别人的打回', (f) => { f.reviews.push({ id: 11, user: { login: 'other' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-14T01:00:00Z', body: '先别合' }); }],
    ]) {
      const fixture = basic([INTERACTIVE_CR]);
      patch(fixture);
      result = scenario(fixture)(['--allow-override-own-cr', '503']);
      assert.equal(result.approval.status, 'blocked', `${label}:${JSON.stringify(result)}`);
      assert.equal(result.overrodeOwnHumanCr, undefined, label);
      assert.equal(posts(), 0, label);
    }
    // 参数值不是 review id:拒绝,不当成「没传」。
    result = scenario(basic([INTERACTIVE_CR]))(['--allow-override-own-cr', '--dry-run']);
    assert.equal(result.approval.status, 'blocked');
    assert.equal(posts(), 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('无人值守的前置审查与服务器审查永远不传 --allow-override-own-cr', () => {
  const root = new URL('../../', import.meta.url);
  for (const file of ['mivo/prereview/round.mjs', 'mivo/server/review.mjs']) {
    assert.doesNotMatch(readFileSync(new URL(file, root), 'utf8'), /allow-override-own-cr/, file);
  }
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /--allow-override-own-cr <[^>]*id>/);
  assert.match(skill, /要用 Approve 覆盖你之前的打回吗/);
});

// 维护者 2026-10-15:截图只对 admin 以外的作者要求;admin 不需要。按仓库权限判,不看维护者名单或 exemptAuthors。
test('requireUiEvidence=non-admin:admin 免证据,其他人(含 exemptAuthors、维护者)要;权限读不到按要证据', () => {
  const rules = { signoffGate: { product: { requireUiEvidence: 'non-admin', acceptNotApplicable: true } } };
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorIsAdmin: true, authorExempt: false }, rules), false);
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorIsAdmin: false, authorExempt: true }, rules), true, 'exemptAuthors 不再免证据');
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorExempt: false }, rules), true, '没读到权限按要证据');
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: true, authorIsAdmin: false, declaredNotApplicable: true }, rules), false, '「不涉及」照样算过');
  assert.equal(isUiEvidenceRequired({ uiEvidenceMissing: false, authorIsAdmin: false }, rules), false);
  assert.equal(uiEvidenceNeedsAdminLookup({ signoffGate: { product: { requireUiEvidence: 'non-exempt' } } }), false);
  assert.equal(isAdminPermission({ permission: 'admin', role_name: 'admin' }), true);
  assert.equal(isAdminPermission({ permission: 'write', role_name: 'maintain' }), false);
  assert.equal(isAdminPermission({ permission: 'write', role_name: 'write', user: { permissions: { admin: true } } }), true);
  assert.equal(isAdminPermission(null), false);
});
