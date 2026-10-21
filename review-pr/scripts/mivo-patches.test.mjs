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
  countDiffLines,
  ciMergeStateIgnoring,
  botCheckActivity,
  evaluateBotSettle,
  evaluateCiStatus,
  parseSlackSyncComment,
  isExplicitSlackConsent,
  selectTrustedSlackReleases,
  selectTrustedIssueCommentReleases,
  selectDiscussionIssueReleases,
  latestIssueRelease,
  evaluateProtectedPathRelease,
  buildSignoffIssueFooter,
  parseSignoffMode,
  parseLastHoldMarker,
  onlyOwnRequiredChecksPending,
  isAutomatedViewerReview,
  latestSubstantiveReviews,
  selectStandingViewerHumanChangesRequest,
} from './lib.mjs';
import { createPrWriteGuard } from './pr-write-guard.mjs';

// 自动放行新增的导出:动态取,缺失时只让对应用例失败,不让整个文件无法加载。
const { toNoticeCloseComment, toDiscussIssueCloseBody } = await import('./lib.mjs');
// code-scan-gate 新增的导出,同样动态取。
const { fetchCodeScanRules, toCodeScanCheckFacts } = await import('./lib.mjs');
const {
  filePatchHashesFromDiff, filePatchHashesFromPullFiles, sameFilePatchHashes, previousSettleFromLocalMerge,
} = await import('./lib.mjs');

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

// [MIVO-PATCH bot-settle-ready] 静默期上限从「转 Ready 的时间」和 head 提交时间里较晚的一个起算。
// 2026-10-17 #1081:先当 74 分钟 Draft,转 Ready 时距 head 提交已超 30 分钟上限,第一轮就按「超时」放行,Greptile 2 分钟后才到。
const READY_CFG = { reviewers: ['greptile-apps'], quietMinutes: 5, maxWaitMinutes: 30, checkNames: { 'greptile-apps': 'Greptile Review' } };
const { toReadyForReviewAt } = await import('./lib.mjs');

test('静默期:Draft 放了很久才转 Ready,超时从转 Ready 起算(#1081)', () => {
  const headCommittedDate = '2026-10-17T11:34:00Z';
  const nowIso = '2026-10-17T12:48:10Z';
  const before = evaluateBotSettle({ headCommittedDate, nowIso, activity: [], cfg: READY_CFG });
  assert.equal(before.settled, true, '对照:不传 readyForReviewAt 时是旧行为——74 分钟前的提交一转 Ready 就按超时放行');
  assert.equal(before.timedOut, true);
  const r = evaluateBotSettle({ headCommittedDate, readyForReviewAt: '2026-10-17T12:48:00Z', nowIso, activity: [], cfg: READY_CFG });
  assert.equal(r.settled, false);
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.pending, ['greptile-apps']);
  assert.ok(r.waitedMinutes < 1, `等待时长从转 Ready 起算:${r.waitedMinutes}`);
  assert.equal(r.waitStartedAt, '2026-10-17T12:48:00Z');
  assert.match(r.reason, /自转 Ready 起算/);
});

test('静默期:从转 Ready 起算满上限仍按超时放行,不会永久卡死', () => {
  const base = { headCommittedDate: '2026-10-17T11:34:00Z', readyForReviewAt: '2026-10-17T12:48:00Z', activity: [], cfg: READY_CFG };
  assert.equal(evaluateBotSettle({ ...base, nowIso: '2026-10-17T13:17:00Z' }).settled, false, '29 分钟还在等');
  const late = evaluateBotSettle({ ...base, nowIso: '2026-10-17T13:19:00Z' });
  assert.equal(late.settled, true);
  assert.equal(late.timedOut, true);
  assert.match(late.reason, /自转 Ready 起算/);
});

test('静默期:转 Ready 后 Greptile 表态,仍要再静默 quietMinutes 才放行', () => {
  const base = { headCommittedDate: '2026-10-17T11:34:00Z', readyForReviewAt: '2026-10-17T12:48:00Z', cfg: READY_CFG,
    activity: [{ author: 'greptile-apps', at: '2026-10-17T12:50:55Z' }] };
  const quiet = evaluateBotSettle({ ...base, nowIso: '2026-10-17T12:52:00Z' });
  assert.equal(quiet.settled, false, '刚表态,静默没满');
  assert.deepEqual(quiet.responded, ['greptile-apps']);
  assert.equal(evaluateBotSettle({ ...base, nowIso: '2026-10-17T12:56:30Z' }).settled, true);
});

test('静默期:Draft 期间机器人已对当前 head 表态的算数(它不会因为转 Ready 再审一遍),只是计时起点后移', () => {
  const r = evaluateBotSettle({ headCommittedDate: '2026-10-17T11:34:00Z', readyForReviewAt: '2026-10-17T12:48:00Z', nowIso: '2026-10-17T12:48:10Z',
    activity: [{ author: 'greptile-apps', at: '2026-10-17T11:40:00Z' }], cfg: READY_CFG });
  assert.equal(r.settled, true);
  assert.deepEqual(r.responded, ['greptile-apps']);
});

test('静默期:转 Ready 早于 head 提交(Ready 之后又推了新提交)、时间读不到或无法解析时,起点仍是 head 提交时间', () => {
  const base = { headCommittedDate: '2026-10-17T12:30:00Z', nowIso: '2026-10-17T13:05:00Z', activity: [], cfg: READY_CFG };
  for (const readyForReviewAt of ['2026-10-17T12:00:00Z', '', undefined, 'not-a-date']) {
    const r = evaluateBotSettle({ ...base, readyForReviewAt });
    assert.equal(r.timedOut, true, String(readyForReviewAt));
    assert.equal(r.waitStartedAt, '2026-10-17T12:30:00Z', String(readyForReviewAt));
    assert.doesNotMatch(r.reason, /自转 Ready 起算/);
  }
});

test('toReadyForReviewAt 取 REST 事件里最近一次 ready_for_review 的时间,没有就是空串', () => {
  const events = [{ event: 'labeled', created_at: '2026-10-17T12:46:00Z' }, { event: 'ready_for_review', created_at: '2026-10-17T12:45:17Z' }, { event: 'review_requested', created_at: '2026-10-17T12:45:20Z' }];
  assert.equal(toReadyForReviewAt(events), '2026-10-17T12:45:17Z');
  assert.equal(toReadyForReviewAt([{ event: 'ready_for_review', created_at: '2026-10-17T10:00:00Z' }, { event: 'convert_to_draft', created_at: '2026-10-17T11:00:00Z' },
    { event: 'ready_for_review', created_at: '2026-10-17T12:48:00Z' }]), '2026-10-17T12:48:00Z', '转回 Draft 再转 Ready:取最近一次');
  for (const bad of [null, undefined, {}, [], [{ event: 'labeled', created_at: '2026-10-17T12:46:00Z' }], [{ event: 'ready_for_review' }], [{ event: 'ready_for_review', created_at: 'x' }], [null]]) {
    assert.equal(toReadyForReviewAt(bad), '', JSON.stringify(bad));
  }
});

// 只有「按 head 提交算已超时」时转 Ready 时间才会改变结论,所以只在这时才读 REST 事件;常规路径零额外请求。
const { evaluateBotSettleSinceReady } = await import('./lib.mjs');
const SINCE_BASE = { headCommittedDate: '2026-10-17T11:34:00Z', nowIso: '2026-10-17T12:48:10Z', activity: [], cfg: READY_CFG };
const READY_EVENTS = [{ event: 'ready_for_review', created_at: '2026-10-17T12:45:17Z' }];

test('evaluateBotSettleSinceReady:按 head 提交已超时才读事件,并从转 Ready 重算(#1081)', () => {
  let reads = 0;
  const r = evaluateBotSettleSinceReady(SINCE_BASE, () => { reads += 1; return READY_EVENTS; });
  assert.equal(reads, 1);
  assert.equal(r.settled, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.readyLookup, 'found');
  assert.equal(r.waitStartedAt, '2026-10-17T12:45:17Z');
  assert.match(r.reason, /自转 Ready 起算/);
});

test('evaluateBotSettleSinceReady:没超时(还在等、已表态)不读事件,结果与 evaluateBotSettle 完全一致', () => {
  const never = () => { throw new Error('不应该读事件'); };
  const waiting = { ...SINCE_BASE, headCommittedDate: '2026-10-17T12:40:00Z' };
  assert.deepEqual(evaluateBotSettleSinceReady(waiting, never), evaluateBotSettle(waiting));
  const responded = { ...SINCE_BASE, activity: [{ author: 'greptile-apps', at: '2026-10-17T11:50:00Z' }] };
  assert.deepEqual(evaluateBotSettleSinceReady(responded, never), evaluateBotSettle(responded));
  assert.equal(evaluateBotSettleSinceReady({ ...SINCE_BASE, cfg: { ...READY_CFG, enabled: false } }, never).settled, true, '静默期关闭');
  assert.equal(evaluateBotSettleSinceReady({ ...SINCE_BASE, headCommittedDate: '' }, never).settled, true, 'head 时间读不到');
});

test('evaluateBotSettleSinceReady:事件读失败或没有转 Ready 事件,退回 head 提交起算(与改前一致),并标明原因', () => {
  const failed = evaluateBotSettleSinceReady(SINCE_BASE, () => { throw new Error('HTTP 502'); });
  assert.equal(failed.settled, true);
  assert.equal(failed.timedOut, true);
  assert.equal(failed.readyLookup, 'failed');
  const none = evaluateBotSettleSinceReady(SINCE_BASE, () => [{ event: 'labeled', created_at: '2026-10-17T12:00:00Z' }]);
  assert.equal(none.timedOut, true);
  assert.equal(none.readyLookup, 'none');
  assert.equal(none.waitStartedAt, '2026-10-17T11:34:00Z');
});

test('evaluateBotSettleSinceReady:转 Ready 后再等满上限仍按超时放行', () => {
  const r = evaluateBotSettleSinceReady({ ...SINCE_BASE, nowIso: '2026-10-17T13:16:00Z' }, () => READY_EVENTS);
  assert.equal(r.settled, true);
  assert.equal(r.timedOut, true);
  assert.equal(r.readyLookup, 'found');
});

// 先本地提交、很久以后才推送的新 head:提交时间远早于推送时间,从提交起算会把 30 分钟窗口吃掉大半。
// #1081 新 head 2d09368f2:提交 13:32:30Z,推送 13:54:32Z,窗口只剩约 8 分钟。推送时间用该 head 上最早的检查开始时间估
// (statusCheckRollup 已经拿到,零额外请求;实测 13:54:35Z,与推送只差 3 秒)。
const { toHeadPushedAt } = await import('./lib.mjs');

test('toHeadPushedAt 取 head 上最早的检查开始时间(CheckRun 用 startedAt,StatusContext 用 createdAt),读不到就是空串', () => {
  const rollup = [
    { name: 'verify', startedAt: '2026-10-17T14:02:59Z', createdAt: null },
    { name: 'lint', startedAt: '2026-10-17T13:54:37Z', createdAt: null },
    { name: 'legacy-status', startedAt: null, createdAt: '2026-10-17T13:54:35Z' },
    { name: 'queued-not-started', startedAt: null, createdAt: null },
    { name: 'bad', startedAt: 'not-a-date', createdAt: null },
  ];
  assert.equal(toHeadPushedAt(rollup), '2026-10-17T13:54:35Z');
  for (const bad of [null, undefined, [], {}, [{}], [{ startedAt: 'x' }], [null]]) assert.equal(toHeadPushedAt(bad), '', JSON.stringify(bad));
});

test('静默期:提交很久以后才推送的新 head,超时从推送起算(#1081 新 head)', () => {
  const base = { headCommittedDate: '2026-10-17T13:32:30Z', headPushedAt: '2026-10-17T13:54:35Z', activity: [], cfg: READY_CFG };
  const early = evaluateBotSettle({ ...base, nowIso: '2026-10-17T14:03:30Z' });
  assert.equal(early.settled, false, '推送才 9 分钟,不能按「提交后 31 分钟」放行');
  assert.equal(early.timedOut, false);
  assert.equal(early.waitAnchor, 'push');
  assert.equal(early.waitStartedAt, '2026-10-17T13:54:35Z');
  assert.match(early.reason, /自推送起算/);
  const old = evaluateBotSettle({ ...base, headPushedAt: '', nowIso: '2026-10-17T14:03:30Z' });
  assert.equal(old.timedOut, true, '对照:不传推送时间时是旧行为,从提交起算');
  assert.equal(old.waitAnchor, 'commit');
  const late = evaluateBotSettle({ ...base, nowIso: '2026-10-17T14:25:36Z' });
  assert.equal(late.settled, true);
  assert.equal(late.timedOut, true, '从推送起算满上限仍按超时放行');
  assert.equal(late.waitAnchor, 'push');
});

test('静默期:起点取提交、推送、转 Ready 三者里最晚的一个;推送早于提交(时钟偏差)或无法解析时忽略', () => {
  const base = { headCommittedDate: '2026-10-17T13:00:00Z', activity: [], cfg: READY_CFG, nowIso: '2026-10-17T13:20:00Z' };
  assert.equal(evaluateBotSettle({ ...base, headPushedAt: '2026-10-17T13:10:00Z', readyForReviewAt: '2026-10-17T13:15:00Z' }).waitAnchor, 'ready');
  assert.equal(evaluateBotSettle({ ...base, headPushedAt: '2026-10-17T13:15:00Z', readyForReviewAt: '2026-10-17T13:10:00Z' }).waitAnchor, 'push');
  assert.equal(evaluateBotSettle({ ...base, headPushedAt: '2026-10-17T12:59:00Z' }).waitAnchor, 'commit');
  assert.equal(evaluateBotSettle({ ...base, headPushedAt: 'not-a-date', readyForReviewAt: 'x' }).waitAnchor, 'commit');
  assert.equal(evaluateBotSettle(base).waitStartedAt, '2026-10-17T13:00:00Z');
});

test('静默期:推送时间只推迟超时起点,不影响「是否已表态」和静默窗口', () => {
  const r = evaluateBotSettle({ headCommittedDate: '2026-10-17T13:32:30Z', headPushedAt: '2026-10-17T13:54:35Z', nowIso: '2026-10-17T14:03:30Z',
    activity: [{ author: 'greptile-apps', at: '2026-10-17T13:40:00Z' }], cfg: READY_CFG });
  assert.deepEqual(r.responded, ['greptile-apps'], '提交之后的表态仍算数');
  assert.equal(r.settled, true);
});

test('evaluateBotSettleSinceReady:推送时间由调用方随 input 给(零请求),转 Ready 仍只在超时时才读事件', () => {
  const input = { headCommittedDate: '2026-10-17T13:32:30Z', headPushedAt: '2026-10-17T13:54:35Z', nowIso: '2026-10-17T14:03:30Z', activity: [], cfg: READY_CFG };
  const never = () => { throw new Error('不应该读事件'); };
  assert.equal(evaluateBotSettleSinceReady(input, never).waitAnchor, 'push');
  // 推送起算也超时了,再读事件:转 Ready 更晚时以它为准
  const timedOut = { ...input, nowIso: '2026-10-17T14:30:00Z' };
  let reads = 0;
  const r = evaluateBotSettleSinceReady(timedOut, () => { reads += 1; return [{ event: 'ready_for_review', created_at: '2026-10-17T14:20:00Z' }]; });
  assert.equal(reads, 1);
  assert.equal(r.settled, false);
  assert.equal(r.waitAnchor, 'ready');
});

test('静默期接线:context.mjs 与 pre-merge-check.mjs 用 evaluateBotSettleSinceReady,经 REST 读 issues/<n>/events,不碰 GraphQL', () => {
  for (const file of ['context.mjs', 'pre-merge-check.mjs']) {
    const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
    // 不用 assert.match:失败时它会把整份源码打印出来。
    assert.ok(/evaluateBotSettleSinceReady\(\{[\s\S]*?\},\s*\(\)\s*=>/.test(source), `${file} 调用 evaluateBotSettleSinceReady 并传入读事件的回调`);
    assert.ok(/repos\/\$\{slug\}\/issues\/\$\{pr\}\/events/.test(source), `${file} 读 REST 事件`);
    assert.ok(/headPushedAt:\s*toHeadPushedAt\(/.test(source), `${file} 用已有的 statusCheckRollup 估推送时间传入静默期`);
    assert.ok(!/timelineItems/.test(source), `${file} 的 GraphQL 查询不加转 Ready 连接(不增加 GraphQL 消耗,也不会因它让整条查询失败)`);
    assert.ok(!/=\s*evaluateBotSettle\(/.test(source), `${file} 不再直接用 evaluateBotSettle 判静默期`);
  }
});

// [MIVO-PATCH bot-settle-base-only] #1150:作者只点 Update branch 合 main,PR 自身 patch 不变,
// Greptile 不会对这个新 head 再表态。旧代码从新 head 起再等满 30 分钟;新代码沿用上一 head 已静默满的表态。
const BASE_ONLY_HASHES = { 'public/changelog.json': '1150-changelog-patch' };
const BASE_ONLY_PREVIOUS = {
  settled: true, timedOut: false, responded: ['greptile-apps'],
  filePatchHashes: BASE_ONLY_HASHES, headCommittedDate: '2026-10-21T05:20:00Z',
};
const BASE_ONLY_NEW_HEAD = {
  headCommittedDate: '2026-10-21T05:44:00Z',
  nowIso: '2026-10-21T05:45:00Z',
  activity: [{ author: 'greptile-apps', at: '2026-10-21T05:25:00Z' }],
  cfg: READY_CFG,
  filePatchHashes: BASE_ONLY_HASHES,
  previousSettle: BASE_ONLY_PREVIOUS,
};

test('静默期:只合 main 且 PR 自身 patch 不变时,沿用上一 head 已静默满的表态(#1150)', () => {
  const oldCode = evaluateBotSettle({
    headCommittedDate: BASE_ONLY_NEW_HEAD.headCommittedDate,
    nowIso: BASE_ONLY_NEW_HEAD.nowIso,
    activity: BASE_ONLY_NEW_HEAD.activity,
    cfg: READY_CFG,
  });
  assert.equal(oldCode.settled, false, '对照:旧代码从新 head 起重新等,Greptile 表态早于新提交不算');
  assert.deepEqual(oldCode.pending, ['greptile-apps']);
  const r = evaluateBotSettle(BASE_ONLY_NEW_HEAD);
  assert.equal(r.settled, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.reused, true);
  assert.deepEqual(r.responded, ['greptile-apps']);
  assert.match(r.reason, /沿用|patch 不变|base 前移/);
  const never = () => { throw new Error('不应该读事件'); };
  assert.deepEqual(evaluateBotSettleSinceReady(BASE_ONLY_NEW_HEAD, never), r);
});

test('静默期:沿用只继承曾表态,快照后若最新 bot 活动未静默满 quietMinutes 则不能放行', () => {
  const r = evaluateBotSettle({
    ...BASE_ONLY_NEW_HEAD,
    activity: [
      { author: 'greptile-apps', at: '2026-10-21T05:25:00Z' },
      { author: 'greptile-apps', at: '2026-10-21T05:43:00Z' },
    ],
  });
  assert.equal(r.settled, false, '快照后又有新活动: 旧口径只看新 head 之后有没有活动,未满 5 分钟静默也会沿用');
  assert.equal(r.reused, undefined);
  assert.equal(r.quietSinceMinutes < 5, true);
});

test('静默期:新 head 改了 PR 自身文件时,即使上一 head 已静默满也重新等', () => {
  const r = evaluateBotSettle({
    ...BASE_ONLY_NEW_HEAD,
    filePatchHashes: { 'public/changelog.json': '1150-changelog-changed' },
  });
  assert.equal(r.settled, false);
  assert.equal(r.reused, undefined);
  assert.deepEqual(r.pending, ['greptile-apps']);
});

test('静默期:上一 head 上 Greptile 没表态(超时放行)时,即使 patch 不变也按原规则等', () => {
  const r = evaluateBotSettle({
    ...BASE_ONLY_NEW_HEAD,
    previousSettle: {
      settled: true, timedOut: true, responded: [], pending: ['greptile-apps'],
      filePatchHashes: BASE_ONLY_HASHES, headCommittedDate: '2026-10-21T05:20:00Z',
    },
  });
  assert.equal(r.settled, false, '上一 head 是超时放行,不能当成已表态沿用');
  assert.deepEqual(r.pending, ['greptile-apps']);
});

test('静默期:patch 哈希或上一 head 表态读不到时退回原规则(等),不放宽', () => {
  const never = () => { throw new Error('不应该读事件'); };
  for (const extra of [
    {},
    { filePatchHashes: BASE_ONLY_HASHES },
    { previousSettle: BASE_ONLY_PREVIOUS },
    { filePatchHashes: {}, previousSettle: BASE_ONLY_PREVIOUS },
    { filePatchHashes: BASE_ONLY_HASHES, previousSettle: { ...BASE_ONLY_PREVIOUS, filePatchHashes: {} } },
  ]) {
    const input = {
      headCommittedDate: BASE_ONLY_NEW_HEAD.headCommittedDate,
      nowIso: BASE_ONLY_NEW_HEAD.nowIso,
      activity: BASE_ONLY_NEW_HEAD.activity,
      cfg: READY_CFG,
      ...extra,
    };
    const r = evaluateBotSettle(input);
    assert.equal(r.settled, false, JSON.stringify(extra));
    assert.deepEqual(evaluateBotSettleSinceReady(input, never), r);
  }
});

test('filePatchHashesFromDiff:只计 +/- 行,行号漂移不算变;缺 patch 的 /files 返回空', () => {
  const left = filePatchHashesFromDiff('diff --git a/public/changelog.json b/public/changelog.json\n--- a/public/changelog.json\n+++ b/public/changelog.json\n@@ -1,3 +1,4 @@\n {\n+  "x": 1\n }\n');
  const drifted = filePatchHashesFromDiff('diff --git a/public/changelog.json b/public/changelog.json\n--- a/public/changelog.json\n+++ b/public/changelog.json\n@@ -10,3 +10,4 @@\n {\n+  "x": 1\n }\n');
  const changed = filePatchHashesFromDiff('diff --git a/public/changelog.json b/public/changelog.json\n--- a/public/changelog.json\n+++ b/public/changelog.json\n@@ -1,3 +1,4 @@\n {\n+  "x": 2\n }\n');
  assert.equal(sameFilePatchHashes(left, drifted), true);
  assert.equal(sameFilePatchHashes(left, changed), false);
  assert.deepEqual(filePatchHashesFromPullFiles([{ filename: 'public/changelog.json', patch: '+  "x": 1\n' }])['public/changelog.json'],
    filePatchHashesFromDiff('diff --git a/public/changelog.json b/public/changelog.json\n+++ b/public/changelog.json\n+  "x": 1\n')['public/changelog.json']);
  assert.deepEqual(filePatchHashesFromPullFiles([{ filename: 'public/changelog.json' }]), {});
  assert.equal(sameFilePatchHashes({}, {}), false);
});

test('filePatchHashesFromDiff:删除文件与改成空文件的增删行都是 -{} 时不能判成同一指纹', () => {
  const deleted = filePatchHashesFromDiff(
    'diff --git a/config.json b/config.json\ndeleted file mode 100644\n--- a/config.json\n+++ /dev/null\n@@ -1 +0,0 @@\n-{}\n',
  );
  const emptied = filePatchHashesFromDiff(
    'diff --git a/config.json b/config.json\n--- a/config.json\n+++ b/config.json\n@@ -1 +0,0 @@\n-{}\n',
  );
  assert.equal(
    sameFilePatchHashes(deleted, emptied),
    false,
    '删除 vs 空文件: 旧口径只哈希 +/- 行,两种都是 -{} 会错误沿用',
  );
});

test('previousSettleFromLocalMerge:当前 HEAD 是两 parent 合 main 且 patch 不变时,按上一 head 重算静默期', () => {
  const prevHead = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const baseSha = 'c'.repeat(40);
  const diff = 'diff --git a/public/changelog.json b/public/changelog.json\n+++ b/public/changelog.json\n+  "x": 1\n';
  const currentHashes = filePatchHashesFromDiff(diff);
  const gitFn = (args) => {
    const joined = args.join(' ');
    if (joined.startsWith('log -1 --format=%H%n%P HEAD')) return { ok: true, stdout: `${headSha}\n${prevHead} ${'d'.repeat(40)}\n` };
    if (joined.includes(`${baseSha}...${prevHead}`)) return { ok: true, stdout: diff };
    if (joined.startsWith(`log -1 --format=%cI ${prevHead}`)) return { ok: true, stdout: '2026-10-21T05:20:00Z\n' };
    return { ok: false, stdout: '', stderr: joined };
  };
  const r = previousSettleFromLocalMerge({
    headSha, baseSha, currentHashes, gitFn, nowIso: '2026-10-21T05:45:00Z',
    activity: [{ author: 'greptile-apps', at: '2026-10-21T05:25:00Z' }], cfg: READY_CFG,
  });
  assert.equal(r.settled, true);
  assert.equal(r.timedOut, false);
  assert.equal(sameFilePatchHashes(r.filePatchHashes, currentHashes), true);
  assert.equal(previousSettleFromLocalMerge({
    headSha, baseSha, currentHashes, gitFn: () => ({ ok: false, stdout: '' }), nowIso: '2026-10-21T05:45:00Z',
    activity: [], cfg: READY_CFG,
  }), null);
});

test('previousSettleFromLocalMerge:现有 activity 没有上一 head 的 check 时,REST 读上一 SHA 的 check-runs 再重算', () => {
  const prevHead = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const baseSha = 'c'.repeat(40);
  const diff = 'diff --git a/public/changelog.json b/public/changelog.json\n+++ b/public/changelog.json\n+  "x": 1\n';
  const currentHashes = filePatchHashesFromDiff(diff);
  const gitFn = (args) => {
    const joined = args.join(' ');
    if (joined.startsWith('log -1 --format=%H%n%P HEAD')) return { ok: true, stdout: `${headSha}\n${prevHead} ${'d'.repeat(40)}\n` };
    if (joined.includes(`${baseSha}...${prevHead}`)) return { ok: true, stdout: diff };
    if (joined.startsWith(`log -1 --format=%cI ${prevHead}`)) return { ok: true, stdout: '2026-10-21T05:20:00Z\n' };
    return { ok: false, stdout: '', stderr: joined };
  };
  let fetched = 0;
  const fetchCheckRuns = (slug, sha) => {
    fetched += 1;
    assert.equal(slug, 'xindong/mivo-canvas-plugin');
    assert.equal(sha, prevHead);
    return [{ name: 'Greptile Review', status: 'COMPLETED', completedAt: '2026-10-21T05:25:00Z' }];
  };
  const missing = previousSettleFromLocalMerge({
    headSha, baseSha, currentHashes, gitFn, nowIso: '2026-10-21T05:45:00Z',
    activity: [], cfg: READY_CFG,
  });
  assert.equal(missing, null, '对照:不读上一 SHA check 时,干净合 main 的 activity 认不出 Greptile 已表态');
  const r = previousSettleFromLocalMerge({
    headSha, baseSha, currentHashes, gitFn, nowIso: '2026-10-21T05:45:00Z',
    activity: [], cfg: READY_CFG, slug: 'xindong/mivo-canvas-plugin', fetchCheckRuns,
  });
  assert.equal(fetched, 1);
  assert.equal(r.settled, true);
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.responded, ['greptile-apps']);
  const failed = previousSettleFromLocalMerge({
    headSha, baseSha, currentHashes, gitFn, nowIso: '2026-10-21T05:45:00Z',
    activity: [], cfg: READY_CFG, slug: 'xindong/mivo-canvas-plugin', fetchCheckRuns: () => null,
  });
  assert.equal(failed, null, '上一 SHA check 读不到退回原规则,不放宽');
});

test('previousSettleFromLocalMerge: git %cI 带正负时区时与 API UTC 按瞬时比较,不按字符串', () => {
  const prevHead = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const baseSha = 'c'.repeat(40);
  const diff = 'diff --git a/public/changelog.json b/public/changelog.json\n+++ b/public/changelog.json\n+  "x": 1\n';
  const currentHashes = filePatchHashesFromDiff(diff);
  const gitFn = (committedDate) => (args) => {
    const joined = args.join(' ');
    if (joined.startsWith('log -1 --format=%H%n%P HEAD')) return { ok: true, stdout: `${headSha}\n${prevHead} ${'d'.repeat(40)}\n` };
    if (joined.includes(`${baseSha}...${prevHead}`)) return { ok: true, stdout: diff };
    if (joined.startsWith(`log -1 --format=%cI ${prevHead}`)) return { ok: true, stdout: `${committedDate}\n` };
    return { ok: false, stdout: '', stderr: joined };
  };
  const plus = previousSettleFromLocalMerge({
    headSha, baseSha, currentHashes, gitFn: gitFn('2026-10-21T13:20:00+08:00'),
    nowIso: '2026-10-21T05:45:00Z',
    activity: [{ author: 'greptile-apps', at: '2026-10-21T05:25:00Z' }], cfg: READY_CFG,
  });
  assert.equal(plus?.settled, true, '+08:00(=05:20Z) 之后 05:25Z 的表态应算已表态; 字符串比较会把 05:25Z 当成早于 13:20+08:00');
  assert.equal(plus?.timedOut, false);
  const minus = previousSettleFromLocalMerge({
    headSha, baseSha, currentHashes, gitFn: gitFn('2026-10-21T01:20:00-04:00'),
    nowIso: '2026-10-21T05:45:00Z',
    activity: [{ author: 'greptile-apps', at: '2026-10-21T05:15:00Z' }], cfg: READY_CFG,
  });
  assert.equal(minus, null, '-04:00(=05:20Z) 之前 05:15Z 的表态不能算; 字符串比较会把 05:15Z 当成晚于 01:20-04:00');
});

test('静默期接线:context 与 pre-merge-check 把已有 diff/files 的 patch 哈希和上一 head 表态传给静默期,不另打 GraphQL', () => {
  for (const file of ['context.mjs', 'pre-merge-check.mjs']) {
    const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
    assert.ok(/\bfilePatchHashes,/.test(source), `${file} 把 patch 哈希传给静默期`);
    assert.ok(/\bpreviousSettle,/.test(source), `${file} 把上一 head 已满足的静默期结果传给静默期`);
    assert.ok(!/timelineItems/.test(source), `${file} 不增加 GraphQL`);
  }
  const context = readFileSync(fileURLToPath(new URL('./context.mjs', import.meta.url)), 'utf8');
  assert.ok(/filePatchHashesFromDiff\(/.test(context), 'context 用本轮已扫的 diff 算哈希,不另拉');
  const preMerge = readFileSync(fileURLToPath(new URL('./pre-merge-check.mjs', import.meta.url)), 'utf8');
  assert.ok(/filePatchHashesFromPullFiles\(/.test(preMerge), 'pre-merge-check 用已有 REST /files 的 patch 算哈希');
  const filesCall = preMerge.search(/pulls\/\$\{pr\}\/files/);
  const settleCall = preMerge.search(/const botSettle = evaluateBotSettleSinceReady/);
  assert.ok(filesCall >= 0 && settleCall > filesCall, 'pre-merge-check 先读 /files 再判静默期,不另打 GraphQL');
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

// ── 维护者确认新规则(2026-10-16):issue 评论放行 / issue 绑定 / 受保护路径放行 / 模式标记 ──
const MAINTAINERS = ['praisezhu', 'kirozeng', 'aj0928', 'zhongxingtian-ai'];
const issueComment = (login, body, createdAt = '2026-10-16T02:00:00Z', extra = {}) =>
  ({ id: `IC_${login}_${createdAt}`, author: { login }, body, createdAt, ...extra });

test('issue 评论放行:维护者非作者整行同意才算;作者本人、非维护者、非整行、流程评论、折叠评论都不算', () => {
  const base = { maintainers: MAINTAINERS, authorLogin: 'zhongxingtian-ai' };
  const trusted = selectTrustedIssueCommentReleases({ ...base, comments: [issueComment('kirozeng', '同意放行')] });
  assert.equal(trusted.release?.by, 'kirozeng');
  assert.equal(trusted.release?.via, 'issue-comment');
  assert.ok(trusted.release?.fingerprint);

  const none = (comments) => selectTrustedIssueCommentReleases({ ...base, comments });
  // PR 作者本人(即使是维护者)
  const selfRelease = none([issueComment('zhongxingtian-ai', '同意放行')]);
  assert.equal(selfRelease.release, null);
  assert.equal(selfRelease.rejected[0].reason, 'commenter-is-author');
  // 非维护者
  assert.equal(none([issueComment('mallory', '同意放行')]).release, null);
  // 非整行写法 / 否定
  for (const text of ['同意放行,xxx', '同意放行，先别合', '不同意放行', '我同意放行吗', 'LGTM']) {
    assert.equal(none([issueComment('kirozeng', text)]).release, null, text);
  }
  // 审查账号(也是维护者)自动发的流程评论
  for (const text of ['同意放行\n<!-- review-pr:signoff-notice-close -->', '同意放行\n<!-- mivo-review:x -->', '同意放行\n<!-- slack-inbound C1:1 -->']) {
    assert.equal(none([issueComment('praisezhu', text)]).release, null, text);
  }
  // 被折叠
  assert.equal(none([issueComment('kirozeng', '同意放行', undefined, { isMinimized: true })]).release, null);
  // 多条取最晚
  const latest = none([
    issueComment('kirozeng', '同意放行', '2026-10-16T01:00:00Z'),
    issueComment('aj0928', '同意放行', '2026-10-16T03:00:00Z'),
  ]);
  assert.equal(latest.release.by, 'aj0928');
});

const issueFooter = (pr, mode = 'normal') => buildSignoffIssueFooter({ pr, author: 'zhongxingtian-ai', topic: '受保护路径改动(.github / CODEOWNERS)', mode });
const confirmIssue = (pr, { mode = 'normal', title = `维护者确认 · PR #${pr} 改 workflow`, comments = [] } = {}) =>
  ({ title, body: `### 触发原因\n\n**protected**\n\n### PR\nhttps://x\n\n### 确认方式\n\n- ...${issueFooter(pr, mode)}`, comments });
const syncRelease = (login) => botComment(login, '同意放行');
const releaseOpts = { syncBots: ['github-actions[bot]'], maintainers: MAINTAINERS, authorLogin: 'zhongxingtian-ai', slackEnabled: true, commentEnabled: true };

test('确认 issue 必须属于本 PR:标题和 footer 的 PR 号都要对得上,notice 模式不算放行', () => {
  const comments = [syncRelease('kirozeng'), issueComment('aj0928', '同意放行', '2026-10-16T05:00:00Z')];
  const ok = selectDiscussionIssueReleases({ ...releaseOpts, pr: 971, issue: confirmIssue(971, { comments }) });
  assert.equal(ok.releaseUntrusted, null);
  assert.equal(ok.mode, 'normal');
  assert.equal(ok.slackRelease?.by, 'kirozeng');
  assert.equal(ok.issueCommentRelease?.by, 'aj0928');

  // 伪造标记指向别的 PR 已放行的 issue(#994):标题 PR 号不对
  const foreign = selectDiscussionIssueReleases({ ...releaseOpts, pr: 971, issue: confirmIssue(994, { comments }) });
  assert.equal(foreign.releaseUntrusted, 'issue-not-bound');
  assert.equal(foreign.slackRelease, null);
  assert.equal(foreign.issueCommentRelease, null);
  // 标题对、footer 的「关联 PR」不对
  const mixed = { ...confirmIssue(971, { comments }), body: confirmIssue(994).body };
  assert.equal(selectDiscussionIssueReleases({ ...releaseOpts, pr: 971, issue: mixed }).releaseUntrusted, 'issue-not-bound');
  // footer 缺失
  assert.equal(selectDiscussionIssueReleases({ ...releaseOpts, pr: 971, issue: { title: '维护者确认 · PR #971 x', body: '没有 footer', comments } }).releaseUntrusted, 'issue-not-bound');
  // PR 号前缀:#97 不能匹配 #971
  assert.equal(selectDiscussionIssueReleases({ ...releaseOpts, pr: 97, issue: confirmIssue(971, { comments }) }).releaseUntrusted, 'issue-not-bound');
  assert.equal(selectDiscussionIssueReleases({ ...releaseOpts, pr: 971, issue: confirmIssue(971, { title: '维护者确认 · PR #9712 x', comments }) }).releaseUntrusted, 'issue-not-bound');
  // 旧格式标题仍然可绑定
  assert.equal(selectDiscussionIssueReleases({ ...releaseOpts, pr: 404, issue: confirmIssue(404, { title: '维护者确认 · PR #404 · 某某', comments }) }).releaseUntrusted, null);
  // notice 模式
  const notice = selectDiscussionIssueReleases({ ...releaseOpts, pr: 971, issue: confirmIssue(971, { mode: 'notice', comments }) });
  assert.equal(notice.mode, 'notice');
  assert.equal(notice.releaseUntrusted, 'notice-issue');
  assert.equal(notice.slackRelease, null);
  assert.equal(notice.issueCommentRelease, null);
  // 开关
  const off = selectDiscussionIssueReleases({ ...releaseOpts, commentEnabled: false, slackEnabled: false, pr: 971, issue: confirmIssue(971, { comments }) });
  assert.equal(off.slackRelease, null);
  assert.equal(off.issueCommentRelease, null);
});

test('latestIssueRelease 取更晚的一条', () => {
  assert.equal(latestIssueRelease(null, null), null);
  assert.equal(latestIssueRelease({ by: 'a', at: '2026-10-16T01:00:00Z' }, null).by, 'a');
  assert.equal(latestIssueRelease({ by: 'a', at: '2026-10-16T01:00:00Z' }, { by: 'b', at: '2026-10-16T02:00:00Z' }).by, 'b');
});

const protectedReview = (login, state, at, extra = {}) => ({ author: { login }, state, submittedAt: at, ...extra });
const protectedBase = { protectedFiles: ['.github/workflows/ci.yml'], maintainers: MAINTAINERS, authorLogin: 'zhongxingtian-ai', latestCommitDate: '2026-10-16T10:00:00Z' };

test('受保护路径放行:未撤销的维护者 Approve(不绑 head)或 issue 放行;审查机自动 Approve、DISMISSED、当前 head 的 CR 都不放行', () => {
  assert.equal(evaluateProtectedPathRelease({ ...protectedBase, protectedFiles: [] }), null);
  // 没人表态
  assert.equal(evaluateProtectedPathRelease(protectedBase).released, null);
  // 旧 head(早于最新 commit)上的 Approve 仍然放行
  const old = evaluateProtectedPathRelease({ ...protectedBase, reviews: [protectedReview('kirozeng', 'APPROVED', '2026-10-15T01:00:00Z')] });
  assert.equal(old.released?.by, 'kirozeng');
  assert.equal(old.released?.via, 'github-approve');
  assert.ok(old.released?.fingerprint);
  assert.deepEqual(old.files, ['.github/workflows/ci.yml']);
  // 作者本人 Approve 不算
  assert.equal(evaluateProtectedPathRelease({ ...protectedBase, reviews: [protectedReview('zhongxingtian-ai', 'APPROVED', '2026-10-15T01:00:00Z')] }).released, null);
  // 非维护者 Approve 不算
  assert.equal(evaluateProtectedPathRelease({ ...protectedBase, reviews: [protectedReview('mallory', 'APPROVED', '2026-10-15T01:00:00Z')] }).released, null);
  // DISMISSED 视为撤销
  const dismissed = evaluateProtectedPathRelease({ ...protectedBase, reviews: [
    protectedReview('kirozeng', 'APPROVED', '2026-10-15T01:00:00Z'),
    protectedReview('kirozeng', 'DISMISSED', '2026-10-15T02:00:00Z'),
  ] });
  assert.equal(dismissed.released, null);
  // 当前 head 上的 Request Changes:等作者,不放行(即使有 issue 放行)
  const changes = evaluateProtectedPathRelease({ ...protectedBase,
    reviews: [protectedReview('kirozeng', 'CHANGES_REQUESTED', '2026-10-16T11:00:00Z')],
    issueRelease: { by: 'aj0928', at: '2026-10-16T09:00:00Z', via: 'issue-comment', fingerprint: 'x' } });
  assert.equal(changes.waitingForAuthor, true);
  assert.equal(changes.released, null);
  // 只有 issue 放行
  const viaIssue = evaluateProtectedPathRelease({ ...protectedBase, issueRelease: { by: 'aj0928', at: '2026-10-16T09:00:00Z', via: 'issue-comment', fingerprint: 'IC_1' } });
  assert.equal(viaIssue.released?.via, 'issue-comment');
  assert.equal(viaIssue.released?.fingerprint, 'IC_1');
  // 审查机自动 Approve:context 先用 isAutomatedViewerReview 过滤,过滤后没有放行
  const auto = viewerReview(1, 'APPROVED', AUTO_CR_HEADER, '2026-10-15T01:00:00Z');
  const signoffReviews = [auto].filter((r) => !isAutomatedViewerReview(r, 'praisezhu'));
  assert.equal(evaluateProtectedPathRelease({ ...protectedBase, reviews: signoffReviews }).released, null);
});

const holdMarkerBody = (n) => `borrow\n<!-- review-pr:product-gate kind=arch issue=https://github.com/o/r/issues/${n} -->`;
const holdComment = (login, n, extra = {}) => ({
  body: holdMarkerBody(n), createdAt: '2026-10-17T01:00:00Z', author: { login }, ...extra,
});

test('P1: hold 标记只认审查账号;非审查账号或 github-actions bot 指向已放行 issue 也不采信', () => {
  const attacker = holdComment('mallory', 88);
  const viewer = holdComment('PraiseZhu', 99, { createdAt: '2026-10-17T02:00:00Z' });
  const ghaRest = holdComment('github-actions[bot]', 77);
  const ghaGql = holdComment('github-actions', 66, { author: { login: 'github-actions', __typename: 'Bot' } });
  assert.equal(parseLastHoldMarker([attacker], { viewerLogin: 'PraiseZhu' }), null, '攻击者标记不采信');
  assert.equal(parseLastHoldMarker([ghaRest], { viewerLogin: 'PraiseZhu' }), null, 'REST github-actions[bot] 不采信');
  assert.equal(parseLastHoldMarker([ghaGql], { viewerLogin: 'PraiseZhu' }), null, 'GraphQL github-actions Bot 不采信');
  assert.equal(parseLastHoldMarker([ghaRest], { viewerLogin: 'github-actions[bot]' }), null, '即使 viewer 是该 bot 也不采信');
  assert.equal(parseLastHoldMarker([viewer], { viewerLogin: 'PraiseZhu' })?.issueNumber, 99);
  // 攻击者后发的标记不能盖住审查账号的标记
  assert.equal(parseLastHoldMarker([viewer, attacker], { viewerLogin: 'PraiseZhu' })?.issueNumber, 99);
  assert.equal(parseLastHoldMarker([attacker, viewer], { viewerLogin: 'PraiseZhu' })?.issueNumber, 99);
  assert.equal(parseLastHoldMarker([attacker], { viewerLogin: '' }), null, '读不到 viewer 时 fail-closed');
});

test('P1: 放行评论必须晚于本 PR 创建时间;同一 PR 推新提交后早先放行仍有效', () => {
  const prCreatedAt = '2026-10-16T12:00:00Z';
  const earlyIssue = issueComment('kirozeng', '同意放行', '2026-10-16T11:59:59Z');
  const equalIssue = issueComment('aj0928', '同意放行', prCreatedAt);
  const lateIssue = issueComment('kirozeng', '同意放行', '2026-10-16T12:00:01Z');
  const earlySlack = botComment('kirozeng', '同意放行', '2026-10-16T11:00:00Z');
  const lateSlack = botComment('aj0928', '同意放行', '2026-10-16T13:00:00Z');

  const before = selectDiscussionIssueReleases({
    ...releaseOpts, pr: 971, prCreatedAt, issue: confirmIssue(971, { comments: [earlyIssue, equalIssue, earlySlack] }),
  });
  assert.equal(before.releaseUntrusted, null, '标题 footer 绑定仍过');
  assert.equal(before.issueCommentRelease, null);
  assert.equal(before.slackRelease, null);
  assert.ok(before.issueCommentReleaseRejected.every((row) => row.reason === 'before-pr-created'));
  assert.equal(before.issueCommentReleaseRejected.length, 2, '早于和等于 PR 创建时间的 issue 放行都拒绝');
  assert.ok(before.slackReleaseRejected.some((row) => row.reason === 'before-pr-created'));

  const after = selectDiscussionIssueReleases({
    ...releaseOpts, pr: 971, prCreatedAt, issue: confirmIssue(971, { comments: [lateIssue, lateSlack] }),
  });
  assert.equal(after.issueCommentRelease?.by, 'kirozeng');
  assert.equal(after.slackRelease?.by, 'aj0928');

  const afterPush = evaluateProtectedPathRelease({
    ...protectedBase,
    latestCommitDate: '2026-10-18T00:00:00Z',
    issueRelease: latestIssueRelease(after.slackRelease, after.issueCommentRelease),
  });
  assert.ok(afterPush.released, '推新提交后早先放行仍有效');
  assert.equal(afterPush.released.via, 'slack-release');
});

test('P1: 受保护路径走借用旧放行攻击时 released 为空', () => {
  const prCreatedAt = '2026-10-17T00:00:00Z';
  // 旧 issue 已被改成新 PR 的标题/footer,上面有早于本 PR 的「同意放行」
  const stolen = confirmIssue(971, { comments: [issueComment('kirozeng', '同意放行', '2026-10-10T00:00:00Z'), botComment('aj0928', '同意放行', '2026-10-11T00:00:00Z')] });
  const stolenRel = selectDiscussionIssueReleases({ ...releaseOpts, pr: 971, prCreatedAt, issue: stolen });
  const attack = evaluateProtectedPathRelease({
    ...protectedBase,
    issueRelease: latestIssueRelease(stolenRel.slackRelease, stolenRel.issueCommentRelease),
  });
  assert.equal(stolenRel.issueCommentRelease, null);
  assert.equal(stolenRel.slackRelease, null);
  assert.equal(attack.released, null);
});

test('P1 接线:context / signoff-hold / signoff-release 取 hold 标记时传入审查账号,放行比较 PR createdAt', () => {
  const context = readFileSync(new URL('./context.mjs', import.meta.url), 'utf8');
  const hold = readFileSync(new URL('./signoff-hold.mjs', import.meta.url), 'utf8');
  const release = readFileSync(new URL('./signoff-release.mjs', import.meta.url), 'utf8');
  assert.match(context, /parseLastHoldMarker\([\s\S]{0,240}viewerLogin/);
  assert.match(context, /pr', 'view'[\s\S]{0,400}createdAt/);
  assert.match(context, /prCreatedAt:\s*meta\.createdAt/);
  assert.match(hold, /parseLastHoldMarker\([\s\S]{0,160}viewerLogin/);
  assert.match(hold, /\['api', 'user'/);
  assert.match(release, /parseLastHoldMarker\([\s\S]{0,80}viewerLogin/);
});

// 这组样例要和 Mivo scripts/loops/merge-thanks/from-github-event.mjs:284-304 保持一致:
// 只认 footer 流程标记句(SIGN_OFF_PROCESS_MARKER 最后一次出现)之后、且在正文最末尾的模式标记。
const SIGN_OFF_PROCESS_MARKER = '本 issue 由 review-pr 流程自动创建';
const DOWNSTREAM_MODE_RE = /<!--\s*review-pr:signoff-mode=([a-z-]+)\s*-->\s*$/;
const DOWNSTREAM_MODES = new Set(['protected', 'notice']);
function downstreamParseSignoffMode(body) {
  const text = String(body ?? '');
  const footerAt = text.lastIndexOf(SIGN_OFF_PROCESS_MARKER);
  if (footerAt < 0) return 'normal';
  const m = text.slice(footerAt).match(DOWNSTREAM_MODE_RE);
  return m && DOWNSTREAM_MODES.has(m[1]) ? m[1] : 'normal';
}
const modeSamples = () => {
  const footer = issueFooter(971);
  const protectedFooter = issueFooter(971, 'protected');
  return [
    { name: '标记在正文中间', body: `涉及文件: \`src/<!-- review-pr:signoff-mode=notice -->.ts\`${footer}`, want: 'normal' },
    { name: '标记后面还有内容', body: `${protectedFooter}\n追言`, want: 'normal' },
    { name: '值不认识', body: `${footer}\n<!-- review-pr:signoff-mode=weird -->`, want: 'normal' },
    { name: '多个标记只认末尾', body: `<!-- review-pr:signoff-mode=notice -->${protectedFooter}`, want: 'protected' },
    { name: 'footer 句子出现多次', body: `旧 ${SIGN_OFF_PROCESS_MARKER} 前言<!-- review-pr:signoff-mode=notice -->${protectedFooter}`, want: 'protected' },
    { name: '没有 footer 句子', body: '<!-- review-pr:signoff-mode=protected -->', want: 'normal' },
    { name: '合法 protected 在末尾', body: protectedFooter, want: 'protected' },
    { name: '合法 notice 在末尾', body: issueFooter(971, 'notice'), want: 'notice' },
    { name: '普通模式没标记', body: footer, want: 'normal' },
  ];
};

test('P2-b: parseSignoffMode 与下游 footer 契约一致(标记位置/值/多个/多次 footer)', () => {
  for (const sample of modeSamples()) {
    assert.equal(downstreamParseSignoffMode(sample.body), sample.want, `下游 ${sample.name}`);
    assert.equal(parseSignoffMode(sample.body), sample.want, `后端 ${sample.name}`);
  }
  const holdSrc = readFileSync(new URL('./signoff-hold.mjs', import.meta.url), 'utf8');
  assert.match(holdSrc, /buildSignoffIssueFooter\(\{ pr, author, topic, mode: signoffMode \}\)/);
  const generated = `### 触发原因\n\nx${issueFooter(971, 'protected')}`;
  assert.equal(downstreamParseSignoffMode(generated), 'protected', 'signoff-hold 生成的正文必须被下游认成 protected');
});

test('确认 issue footer:三种模式的句式不变,只在末尾追加模式标记;Mivo parseSignoffIssue 仍能解析', () => {
  // 以下三条正则抄自 Mivo scripts/loops/merge-thanks/from-github-event.mjs 的 parseSignoffIssue(Mivo 仓 signoff-issue-skeleton.test.mjs 锁定)。
  const parseSignoffIssue = (issue) => {
    const title = String(issue.title ?? '');
    const body = String(issue.body ?? '');
    const prMatch = title.match(/^维护者确认\s*·\s*PR\s*#(\d+)/);
    const authorMatch = body.match(/关联\s*PR:#\d+\s*\(作者\s*@([A-Za-z0-9-]+)\)/);
    const topicMatch = body.match(/涉及的?(.+?)[，,]维护者确认后/);
    return {
      prNumber: prMatch ? Number(prMatch[1]) : null,
      authorLogin: authorMatch?.[1] ?? null,
      topic: topicMatch ? topicMatch[1].replace(/^的/, '').trim() : null,
      isTrustedSignoff: !!prMatch && !!authorMatch && !!topicMatch && body.includes('本 issue 由 review-pr 流程自动创建'),
    };
  };
  const plain = issueFooter(971);
  assert.equal(parseSignoffMode(plain), 'normal');
  assert.doesNotMatch(plain, /signoff-mode/);
  assert.equal(parseSignoffMode(issueFooter(971, 'protected')), 'protected');
  assert.equal(parseSignoffMode(issueFooter(971, 'notice')), 'notice');
  // 模式标记在 footer 末尾,基础句式一字不差
  for (const mode of ['protected', 'notice']) {
    assert.ok(issueFooter(971, mode).startsWith(plain));
    assert.ok(issueFooter(971, mode).endsWith(`<!-- review-pr:signoff-mode=${mode} -->`));
  }
  for (const mode of ['normal', 'protected', 'notice']) {
    const parsed = parseSignoffIssue(confirmIssue(971, { mode }));
    assert.deepEqual(parsed, { prNumber: 971, authorLogin: 'zhongxingtian-ai', topic: '受保护路径改动(.github / CODEOWNERS)', isTrustedSignoff: true }, mode);
  }
});

test('pr-write-guard:hold 对豁免作者仍拒绝;通知 issue 只给免确认门作者;受保护路径确认 issue 任何作者都能开', () => {
  const run = (purpose, author) => {
    const calls = [];
    const guard = createPrWriteGuard(
      { owner: 'o', repo: 'r', pr: 971, lockToken: 'lock', expectedHead: SHA, expectedAuthorityDigest: 'digest', purpose },
      {
        assertActiveReviewLock: () => {},
        fetchMaintainerAuthority: () => ({ digest: 'digest' }),
        evaluateMaintainerApprovalPolicy: ({ authorLogin }) => ({ viewerIsMaintainer: true, authorIsMaintainer: MAINTAINERS.includes(String(authorLogin).toLowerCase()) && authorLogin !== 'zhongxingtian-ai' }),
        isSignoffExemptAuthor: (login) => ['zhongxingtian-ai'].includes(String(login).toLowerCase()),
        gh: (args, options) => { calls.push(args); return args[0] === 'api' ? { ok: true, stdout: 'praisezhu\n' } : { ok: true, stdout: '' }; },
        ghJson: () => ({ state: 'OPEN', isDraft: false, headRefOid: SHA, author: { login: author } }),
      },
    );
    return { guard, calls };
  };
  // hold:豁免作者(zhongxingtian-ai)与维护者作者(kirozeng)仍拒绝
  assert.throws(() => run('hold', 'zhongxingtian-ai').guard(['issue', 'create']), /豁免名单作者免前置确认门/);
  assert.throws(() => run('hold', 'kirozeng').guard(['issue', 'create']), /维护者作者免前置确认门/);
  // 通知:豁免作者 / 维护者作者放行,普通作者拒绝
  for (const author of ['zhongxingtian-ai', 'kirozeng']) {
    const { guard, calls } = run('signoff-notice', author);
    guard(['issue', 'create']);
    assert.deepEqual(calls.at(-1), ['issue', 'create']);
  }
  assert.throws(() => run('signoff-notice', 'outsider').guard(['issue', 'create']), /非豁免作者不发通知 issue/);
  // 受保护路径确认 issue:任何作者
  for (const author of ['zhongxingtian-ai', 'kirozeng', 'outsider']) run('protected-hold', author).guard(['issue', 'create']);
});

test('接线:context 用 signoffReviews 与统一的 issueRelease 评放行并输出 protectedPath;读 issue 的 title/body', () => {
  const context = readFileSync(new URL('./context.mjs', import.meta.url), 'utf8');
  assert.match(context, /evaluateProtectedPathRelease\(\{\n\s+protectedFiles, reviews: signoffReviews, maintainers: MAINTAINERS_RAW, latestCommitDate, issueRelease, authorLogin,/);
  assert.match(context, /const markerRelease = releaseMarks\.get\(kind\) \?\? issueRelease \?\? null;/);
  assert.match(context, /const issueRelease = latestIssueRelease\(slackRelease, issueCommentRelease\);/);
  assert.equal(context.match(/\n\s+protectedPath,\n/g)?.length, 2, 'scan 与完整输出都带 protectedPath');
  assert.match(context, /'state,comments,updatedAt,title,body'/);
  assert.match(context, /commentEnabled: SG\.issueCommentRelease\?\.enabled === true/);
  const rules = JSON.parse(readFileSync(new URL('../config/pr-rules.json', import.meta.url), 'utf8'));
  assert.equal(rules.signoffGate.issueCommentRelease.enabled, true, '默认开启,现网无需另改仓库变量');
});

// ── signoff-hold notice / protected 模式:用 gh 替身离线跑真实脚本 ──
function holdFixtureGh(args, options, fixture) {
  const done = (stdout = '') => ({ status: 0, stdout, stderr: '', signal: null, pid: 1, output: [null, stdout, ''] });
  fixture.calls.push({ args, input: options?.input ?? null });
  if (args[0] === 'api' && args[1] === 'user') return done(`${fixture.viewer ?? 'PraiseZhu'}\n`);
  if (args[0] === 'pr' && args[1] === 'view') return done(JSON.stringify(fixture.pr));
  if (args[0] === 'issue' && args[1] === 'view') {
    const issue = fixture.issues[args[2]];
    return issue ? done(JSON.stringify(issue)) : { status: 1, stdout: '', stderr: 'not found', signal: null, pid: 1, output: [null, '', 'not found'] };
  }
  if (args[0] === 'issue' && args[1] === 'create') {
    const number = 900 + fixture.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create').length;
    fixture.issues[String(number)] = { state: 'OPEN', body: options?.input ?? '' };
    return done(`https://github.com/o/r/issues/${number}\n`);
  }
  if (args[0] === 'issue' && args[1] === 'close') {
    fixture.issues[args[2]].state = 'CLOSED';
    return done('');
  }
  return done('');
}

test('signoff-hold notice 模式:开通知 issue(带 notice 标记)→ PR 评论带去重标记 → 立即关闭;不挂标签;已通知过不重复;protected 模式不复用通知 issue', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mivo-hold-notice-'));
  try {
    const repoRoot = join(directory, 'repo');
    mkdirSync(repoRoot);
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
      assert.equal(spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).status, 0);
    }
    const rulesFile = join(directory, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ maintainerAllowlist: [], signoffGate: { label: 'awaiting-discussion' } }));
    const fixtureFile = join(directory, 'fixture.json');
    const mockFile = join(directory, 'mock.mjs');
    writeFileSync(mockFile, `import { readFileSync, writeFileSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const holdFixtureGh = ${holdFixtureGh.toString()};
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command !== 'gh') return original(command, args, options);
  const fixture = JSON.parse(readFileSync(process.env.HOLD_FIXTURE, 'utf8'));
  const result = holdFixtureGh(args, options, fixture);
  writeFileSync(process.env.HOLD_FIXTURE, JSON.stringify(fixture));
  return result;
};
syncBuiltinESMExports();
`);
    const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFile).href}`].filter(Boolean).join(' '),
      REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_RULES_FILE: rulesFile, HOLD_FIXTURE: fixtureFile, REVIEW_PR_NO_CRED_FALLBACK: '1',
      REVIEW_PR_STATE_DIR: join(directory, 'state') };
    const payload = { issueTitle: '维护者确认 · PR #971 改 workflow', issueBody: '### 触发原因\n\nx\n\n### PR\nhttps://x\n\n### 确认方式\n\ny',
      commentBody: '本 PR 命中维护者确认门。讨论 issue:{{ISSUE_URL}}' };
    const fresh = (comments = [], issues = {}) => {
      writeFileSync(fixtureFile, JSON.stringify({ calls: [], issues, pr: { number: 971, state: 'OPEN', mergedAt: null, author: { login: 'zhongxingtian-ai' },
        url: 'https://github.com/o/r/pull/971', comments, labels: [], headRefOid: SHA } }));
    };
    const hold = (extra) => {
      const child = spawnSync(process.execPath, [fileURLToPath(new URL('./signoff-hold.mjs', import.meta.url)), '971', '--payload-file', '-', ...extra],
        { cwd: repoRoot, env, encoding: 'utf8', input: JSON.stringify(payload) });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      return JSON.parse(child.stdout);
    };
    const calls = () => JSON.parse(readFileSync(fixtureFile, 'utf8')).calls;
    const writes = () => calls().filter((c) => ['create', 'comment', 'close', 'edit'].includes(c.args[1]) || c.args[0] === 'api' && c.args.includes('POST'));

    // ① 首次:创建 → 评论 → 关闭;footer 带 notice 标记;没有标签写入
    fresh();
    let out = hold(['--signoff-mode', 'notice', '--kind', 'security']);
    assert.equal(out.notice, true);
    assert.equal(out.issueCreated, true);
    assert.equal(out.issueClosed, true, JSON.stringify(out));
    assert.equal(out.commented, true);
    const create = calls().find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.match(create.args[create.args.indexOf('--title') + 1], /^维护者确认 · PR #971 /);
    assert.match(create.input, /### 触发原因/);
    assert.match(create.input, /### 确认方式/);
    assert.match(create.input, /关联 PR:#971\(作者 @zhongxingtian-ai\);本 issue 由 review-pr 流程自动创建,用于先讨论该 PR 涉及的安全敏感改动,维护者确认后 PR 会恢复推进。/);
    assert.match(create.input, /<!-- review-pr:signoff-mode=notice -->$/);
    const prComment = calls().find((c) => c.args[0] === 'pr' && c.args[1] === 'comment');
    assert.match(prComment.input, /issues\/901/);
    assert.match(prComment.input, /<!-- review-pr:product-gate kind=arch issue=https:\/\/github\.com\/o\/r\/issues\/901 -->/);
    assert.ok(calls().some((c) => c.args[0] === 'issue' && c.args[1] === 'close' && c.args[2] === '901'));
    assert.ok(!calls().some((c) => c.args[0] === 'pr' && c.args[1] === 'edit' || c.args.includes('--add-label') || c.args[0] === 'label'), '通知模式不碰标签');
    const closeComment = calls().find((c) => c.args[0] === 'issue' && c.args[1] === 'comment');
    assert.match(closeComment.input, /review-pr:signoff-notice-close/);

    // ② 已有标记:不重复通知
    fresh([{ author: { login: 'PraiseZhu' }, body: '通知\n\n<!-- review-pr:product-gate kind=arch issue=https://github.com/o/r/issues/901 -->', createdAt: '2026-10-16T01:00:00Z' }],
      { 901: { state: 'CLOSED', body: `x${issueFooter(971, 'notice')}` } });
    out = hold(['--signoff-mode', 'notice']);
    assert.equal(out.alreadyNotified, true);
    assert.equal(writes().length, 0);
    // 上次关闭失败留下的开放通知 issue 顺手补关
    fresh([{ author: { login: 'PraiseZhu' }, body: '通知\n\n<!-- review-pr:product-gate kind=arch issue=https://github.com/o/r/issues/901 -->', createdAt: '2026-10-16T01:00:00Z' }],
      { 901: { state: 'OPEN', body: `x${issueFooter(971, 'notice')}` } });
    out = hold(['--signoff-mode', 'notice']);
    assert.equal(out.issueClosed, true);

    // ③ dry-run 不写
    fresh();
    out = hold(['--signoff-mode', 'notice', '--dry-run']);
    assert.equal(out.wouldCreateIssue, true);
    assert.equal(writes().length, 0);

    // ④ 缺文案
    fresh();
    const bare = spawnSync(process.execPath, [fileURLToPath(new URL('./signoff-hold.mjs', import.meta.url)), '971', '--signoff-mode', 'notice'],
      { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(JSON.parse(bare.stdout).reason, 'missing-payload');
    assert.equal(writes().length, 0);

    // ⑤ protected 模式:旧 issue 是通知(即使还开着)就不复用,另开确认 issue,footer 带 protected 标记且挂标签
    fresh([{ author: { login: 'PraiseZhu' }, body: '通知\n\n<!-- review-pr:product-gate kind=arch issue=https://github.com/o/r/issues/901 -->', createdAt: '2026-10-16T01:00:00Z' }],
      { 901: { state: 'OPEN', body: `x${issueFooter(971, 'notice')}` } });
    out = hold(['--signoff-mode', 'protected', '--kind', 'protected']);
    assert.equal(out.issueCreated, true, JSON.stringify(out));
    assert.equal(out.issueReuse, 'prior-notice');
    const createdProtected = calls().find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.match(createdProtected.input, /涉及的受保护路径改动\(\.github \/ CODEOWNERS\),维护者确认后/);
    assert.match(createdProtected.input, /<!-- review-pr:signoff-mode=protected -->$/);
    assert.ok(!calls().some((c) => c.args[0] === 'issue' && c.args[1] === 'close' && c.args[2] === '902'), 'protected 确认 issue 不在这里关');
    // 普通确认门(没有 --signoff-mode)的 footer 没有模式标记
    fresh();
    hold(['--kind', 'security']);
    const normalCreate = calls().find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.doesNotMatch(normalCreate.input, /signoff-mode/);
    // 非法模式
    const bad = spawnSync(process.execPath, [fileURLToPath(new URL('./signoff-hold.mjs', import.meta.url)), '971', '--signoff-mode', 'weird'],
      { cwd: repoRoot, env, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('P1: signoff-hold 不采信非审查账号写的 hold 标记,不复用攻击者指定的旧 issue', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mivo-hold-p1-'));
  try {
    const repoRoot = join(directory, 'repo');
    mkdirSync(repoRoot);
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
      assert.equal(spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).status, 0);
    }
    const rulesFile = join(directory, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ maintainerAllowlist: [], signoffGate: { label: 'awaiting-discussion' } }));
    const fixtureFile = join(directory, 'fixture.json');
    const mockFile = join(directory, 'mock.mjs');
    writeFileSync(mockFile, `import { readFileSync, writeFileSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const holdFixtureGh = ${holdFixtureGh.toString()};
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command !== 'gh') return original(command, args, options);
  const fixture = JSON.parse(readFileSync(process.env.HOLD_FIXTURE, 'utf8'));
  const result = holdFixtureGh(args, options, fixture);
  writeFileSync(process.env.HOLD_FIXTURE, JSON.stringify(fixture));
  return result;
};
syncBuiltinESMExports();
`);
    const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFile).href}`].filter(Boolean).join(' '),
      REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_RULES_FILE: rulesFile, HOLD_FIXTURE: fixtureFile, REVIEW_PR_NO_CRED_FALLBACK: '1',
      REVIEW_PR_STATE_DIR: join(directory, 'state') };
    const payload = { issueTitle: '维护者确认 · PR #971 改 workflow', issueBody: '### 触发原因\n\nx\n\n### PR\nhttps://x\n\n### 确认方式\n\ny',
      commentBody: '本 PR 命中维护者确认门。讨论 issue:{{ISSUE_URL}}' };
    const stolenBody = `旧放行${issueFooter(88, 'protected')}`;
    writeFileSync(fixtureFile, JSON.stringify({ calls: [], viewer: 'PraiseZhu', issues: { 88: { state: 'OPEN', body: stolenBody } },
      pr: { number: 971, state: 'OPEN', mergedAt: null, author: { login: 'mallory' }, url: 'https://github.com/o/r/pull/971',
        comments: [{ author: { login: 'mallory' }, body: holdMarkerBody(88), createdAt: '2026-10-17T01:00:00Z' }],
        labels: [], headRefOid: SHA } }));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./signoff-hold.mjs', import.meta.url)), '971', '--signoff-mode', 'protected', '--kind', 'protected', '--payload-file', '-'],
      { cwd: repoRoot, env, encoding: 'utf8', input: JSON.stringify(payload) });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const out = JSON.parse(child.stdout);
    const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
    const created = fixture.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    assert.equal(out.issueCreated, true, JSON.stringify(out));
    assert.notEqual(out.issueUrl, 'https://github.com/o/r/issues/88');
    assert.equal(created.length, 1, '必须新开 issue,不能复用攻击者指定的旧 issue');
    assert.match(created[0].input, /<!-- review-pr:signoff-mode=protected -->$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('P2-a: 普通确认 issue 转受保护模式时不复用,新开 protected issue 并关掉旧 issue', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mivo-hold-p2a-'));
  try {
    const repoRoot = join(directory, 'repo');
    mkdirSync(repoRoot);
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
      assert.equal(spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).status, 0);
    }
    const rulesFile = join(directory, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ maintainerAllowlist: [], signoffGate: { label: 'awaiting-discussion' } }));
    const fixtureFile = join(directory, 'fixture.json');
    const mockFile = join(directory, 'mock.mjs');
    writeFileSync(mockFile, `import { readFileSync, writeFileSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const holdFixtureGh = ${holdFixtureGh.toString()};
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command !== 'gh') return original(command, args, options);
  const fixture = JSON.parse(readFileSync(process.env.HOLD_FIXTURE, 'utf8'));
  const result = holdFixtureGh(args, options, fixture);
  writeFileSync(process.env.HOLD_FIXTURE, JSON.stringify(fixture));
  return result;
};
syncBuiltinESMExports();
`);
    const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFile).href}`].filter(Boolean).join(' '),
      REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_RULES_FILE: rulesFile, HOLD_FIXTURE: fixtureFile, REVIEW_PR_NO_CRED_FALLBACK: '1',
      REVIEW_PR_STATE_DIR: join(directory, 'state') };
    const payload = { issueTitle: '维护者确认 · PR #971 改 workflow', issueBody: '### 触发原因\n\nx\n\n### PR\nhttps://x\n\n### 确认方式\n\ny',
      commentBody: '本 PR 命中维护者确认门。讨论 issue:{{ISSUE_URL}}' };
    writeFileSync(fixtureFile, JSON.stringify({ calls: [], viewer: 'PraiseZhu', issues: { 901: { state: 'OPEN', body: `x${issueFooter(971)}` } },
      pr: { number: 971, state: 'OPEN', mergedAt: null, author: { login: 'outsider' }, url: 'https://github.com/o/r/pull/971',
        comments: [{ author: { login: 'PraiseZhu' }, body: '通知\n\n<!-- review-pr:product-gate kind=arch issue=https://github.com/o/r/issues/901 -->', createdAt: '2026-10-16T01:00:00Z' }],
        labels: ['awaiting-discussion'], headRefOid: SHA } }));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./signoff-hold.mjs', import.meta.url)), '971', '--signoff-mode', 'protected', '--kind', 'protected', '--payload-file', '-'],
      { cwd: repoRoot, env, encoding: 'utf8', input: JSON.stringify(payload) });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const out = JSON.parse(child.stdout);
    const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
    const created = fixture.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    const closed = fixture.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'close' && c.args[2] === '901');
    const closeComment = fixture.calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'comment' && c.args[2] === '901');
    assert.equal(out.issueCreated, true, JSON.stringify(out));
    assert.equal(out.issueReuse, 'prior-not-protected', JSON.stringify(out));
    assert.equal(created.length, 1, '不能复用普通确认 issue');
    assert.match(created[0].input, /<!-- review-pr:signoff-mode=protected -->$/);
    assert.equal(closed.length, 1, '旧普通确认 issue 必须关掉');
    assert.match(closeComment?.input ?? '', /issues\/90[0-9]/);
    assert.match(closeComment?.input ?? '', /review-pr:signoff-protected-supersede/);
    assert.equal(fixture.issues['901'].state, 'CLOSED');
    // 旧普通 issue 上的同意放行不能当受保护路径放行:新 issue 还没有放行评论
    const newBody = created[0].input;
    assert.equal(parseSignoffMode(newBody), 'protected');
    const newRel = selectDiscussionIssueReleases({ ...releaseOpts, pr: 971, issue: { title: payload.issueTitle, body: newBody, comments: [] } });
    assert.equal(newRel.issueCommentRelease, null);
    assert.equal(evaluateProtectedPathRelease({ ...protectedBase, issueRelease: null }).released, null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// 2026-10-17 维护者拍板:作者是维护者(approvalPolicy.authorIsMaintainer 或 exemptAuthors,即 context 的 authorSignoffExempt)
// 改受保护路径时放行直接成立;放行权名单(maintainerAllowlist)不因此扩大。
test('受保护路径放行:作者是维护者/豁免名单时直接放行(via=author-maintainer);放行权不变', () => {
  const exemptBase = { ...protectedBase, authorExempt: true };
  const auto = evaluateProtectedPathRelease(exemptBase);
  assert.equal(auto.released?.by, 'zhongxingtian-ai');
  assert.equal(auto.released?.via, 'author-maintainer');
  assert.equal(auto.released?.at, null);
  assert.equal(auto.released?.fingerprint, 'author-maintainer:zhongxingtian-ai');
  assert.equal(auto.waitingForAuthor, false);
  assert.deepEqual(auto.files, ['.github/workflows/ci.yml']);
  // 没有受保护文件:仍然 null
  assert.equal(evaluateProtectedPathRelease({ ...exemptBase, protectedFiles: [] }), null);
  // 别的维护者在当前 head 上 Request Changes:交作者,不自动放行
  const changes = evaluateProtectedPathRelease({ ...exemptBase, reviews: [protectedReview('kirozeng', 'CHANGES_REQUESTED', '2026-10-16T11:00:00Z')] });
  assert.equal(changes.waitingForAuthor, true);
  assert.equal(changes.released, null);
  // 非豁免作者:无 authorExempt 时一切照旧(作者本人 Approve 不算、没人表态不放行)
  assert.equal(evaluateProtectedPathRelease({ ...protectedBase, authorExempt: false }).released, null);
  assert.equal(evaluateProtectedPathRelease({ ...protectedBase, reviews: [protectedReview('zhongxingtian-ai', 'APPROVED', '2026-10-15T01:00:00Z')] }).released, null);
  // 豁免作者不是放行人:放行名单(maintainerAllowlist 三人)之外的 zhongxingtian-ai 给别人 PR 的 Approve 不算
  const releasers = ['praisezhu', 'kirozeng', 'aj0928'];
  const other = evaluateProtectedPathRelease({ ...protectedBase, maintainers: releasers, authorLogin: 'outsider', reviews: [protectedReview('zhongxingtian-ai', 'APPROVED', '2026-10-15T01:00:00Z')] });
  assert.equal(other.released, null);
  assert.equal(evaluateProtectedPathRelease({ ...protectedBase, maintainers: releasers, authorLogin: 'outsider', reviews: [protectedReview('kirozeng', 'APPROVED', '2026-10-15T01:00:00Z')] }).released?.by, 'kirozeng');
});

test('放行权名单固定:exemptAuthors 含 zhongxingtian-ai,但 maintainerAllowlist 不含,且 exemptAuthors 是 allowlist 的超集', () => {
  const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../config/pr-rules.json', import.meta.url)), 'utf8'));
  const allow = rules.maintainerAllowlist.map((x) => x.toLowerCase());
  const exempt = rules.signoffGate.exemptAuthors.map((x) => x.toLowerCase());
  assert.deepEqual(allow.slice().sort(), ['aj0928', 'kirozeng', 'praisezhu']);
  assert.ok(exempt.includes('zhongxingtian-ai'));
  assert.ok(!allow.includes('zhongxingtian-ai'));
  for (const login of allow) assert.ok(exempt.includes(login), `${login} 在 exemptAuthors`);
});

test('通知 issue 关闭文案:受保护路径写准「作者是维护者、自动放行」,其余沿用原文', () => {
  const protectedText = toNoticeCloseComment('protected');
  assert.match(protectedText, /作者是维护者，受保护路径改动按规则自动放行/);
  assert.match(protectedText, /不需要回复/);
  assert.match(protectedText, /<!-- review-pr:signoff-notice-close -->/);
  assert.equal(toNoticeCloseComment('product'), '本 issue 只是通知:作者在豁免名单内,维护者确认门不拦,PR 照常进入自动审查。流程已自动关闭本 issue,不需要回复。\n\n<!-- review-pr:signoff-notice-close -->');
  assert.equal(toNoticeCloseComment(), toNoticeCloseComment('product'));
});

test('关闭讨论 issue 的说明:默认沿用原文,调用方给了文案就用调用方的', () => {
  const url = 'https://github.com/o/r/pull/2001';
  assert.equal(toDiscussIssueCloseBody({ pr: 2001, url }), `维护者确认已通过,讨论结束,PR 恢复正常推进。关联 PR:#2001(${url})。本 issue 由 review-pr 流程自动关闭。`);
  assert.equal(toDiscussIssueCloseBody({ pr: 2001, url, closeCommentBody: '作者为维护者，按新规则自动放行。' }), '作者为维护者，按新规则自动放行。');
  assert.equal(toDiscussIssueCloseBody({ pr: 2001, url, closeCommentBody: '   ' }), toDiscussIssueCloseBody({ pr: 2001, url }));
});

// ── code-scan-gate(2026-10-18,#1025):挂 review:merge-ready 之前核代码扫描 / 代码质量门 ──
test('code-scan-gate:fetchCodeScanRules 只取 code_scanning / code_quality 两类规则,base 分支名做 URL 编码,读不到给原因', () => {
  const calls = [];
  const rules = [{ type: 'deletion' }, { type: 'code_scanning', ruleset_id: 9, parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] } }, { type: 'code_quality', parameters: { severity: 'warnings' } }, { type: 'pull_request', parameters: {} }];
  const ghFn = (args) => { calls.push(args[1]); return ok(rules); };
  assert.deepEqual(fetchCodeScanRules('xindong/mivo-canvas-plugin', 'feat/x', { ghFn }), {
    rules: [{ type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] } }, { type: 'code_quality', parameters: { severity: 'warnings' } }], error: null });
  assert.deepEqual(calls, ['repos/xindong/mivo-canvas-plugin/rules/branches/feat%2Fx?per_page=100']);
  assert.deepEqual(fetchCodeScanRules('o/r', 'main', { ghFn: () => ok([{ type: 'deletion' }]) }), { rules: [], error: null });
  assert.match(fetchCodeScanRules('o/r', 'main', { ghFn: () => bad('HTTP 404: Not Found') }).error, /404/);
  assert.equal(fetchCodeScanRules('o/r', 'main', { ghFn: () => bad('HTTP 404: Not Found') }).rules, null);
  assert.equal(fetchCodeScanRules('o/r', 'main', { ghFn: () => ok({ message: 'x' }) }).rules, null);
  assert.equal(fetchCodeScanRules('o/r', 'main', { ghFn: () => ({ ok: true, stdout: 'not json', stderr: '' }) }).rules, null);
  assert.equal(fetchCodeScanRules('o/r', '', { ghFn: () => ok([]) }).rules, null);
});

test('code-scan-gate:toCodeScanCheckFacts 只留代码扫描门要看的字段,读不到原样给 null', () => {
  const runs = [{ name: 'CodeQL', integrationId: 57789, appSlug: 'github-advanced-security', title: '1 configuration not found', startedAt: 'a', completedAt: 'b', status: 'completed', conclusion: 'neutral' }, { name: 'x' }];
  assert.deepEqual(toCodeScanCheckFacts(runs), [
    { name: 'CodeQL', appSlug: 'github-advanced-security', status: 'completed', conclusion: 'neutral', title: '1 configuration not found', completedAt: 'b' },
    { name: 'x', appSlug: null, status: null, conclusion: null, title: null, completedAt: null }]);
  assert.equal(toCodeScanCheckFacts(null), null);
});

test('code-scan-gate 接线:pre-merge-check.mjs 读规则、复用已读的 check run,输出 codeScanning;不新增 GraphQL', () => {
  const source = readFileSync(fileURLToPath(new URL('./pre-merge-check.mjs', import.meta.url)), 'utf8');
  assert.ok(/fetchCodeScanRules\(slug,\s*m\.baseRefName\)/.test(source), '按 PR 的 base 分支读规则');
  assert.ok(/codeScanning:\s*\{[\s\S]*?rules:\s*codeScanRules\.rules[\s\S]*?rulesError:\s*codeScanRules\.error[\s\S]*?checks:\s*toCodeScanCheckFacts\(checkRunsWithApps\)/.test(source), '回执带规则与已读的 check run');
  assert.equal((source.match(/fetchCheckRunsWithApps\(/g) ?? []).length, 1, 'check run 只读一次:代码扫描门复用必需检查核对已读的那份');
  assert.equal((source.match(/ghGraphql\(/g) ?? []).length, 1, '不新增 GraphQL 调用');
});

// [MIVO-PATCH app-readable-snapshot]
function snapshotFixture(prs) {
  const queries = [];
  const ghGraphqlFn = (query) => {
    queries.push(query);
    return { data: { repository: { pullRequests: {
      totalCount: prs.length, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: prs.map((pr, i) => ({ number: i + 1, headRefOid: String(i + 1).repeat(40), updatedAt: '2026-10-19T00:00:00Z',
        headRefName: pr.headRefName ?? 'feature', baseRefName: 'main', ...pr.node,
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })),
    } } } };
  };
  return { ghGraphqlFn, queries };
}

test('app-readable-snapshot:不读 fork 名时查询只要 isCrossRepository,同仓记本仓、fork 记 null', async () => {
  const { fetchOpenPrSnapshot } = await import('./lib.mjs');
  const f = snapshotFixture([{ node: { isCrossRepository: false } }, { node: { isCrossRepository: true } }]);
  const snapshot = fetchOpenPrSnapshot({ owner: 'o', repo: 'r', ghGraphqlFn: f.ghGraphqlFn, readsForkName: false });
  assert.equal(f.queries.length, 1);
  assert.doesNotMatch(f.queries[0], /headRepository|nameWithOwner/);
  assert.match(f.queries[0], /\bisCrossRepository\b/);
  assert.deepEqual(snapshot.map((p) => p.headRepository), ['o/r', null]);
});

test('app-readable-snapshot:缺 isCrossRepository 时快照从严报错', async () => {
  const { fetchOpenPrSnapshot } = await import('./lib.mjs');
  const f = snapshotFixture([{ node: {} }]);
  assert.throws(() => fetchOpenPrSnapshot({ owner: 'o', repo: 'r', ghGraphqlFn: f.ghGraphqlFn, readsForkName: false }), /快照字段未完整读取/);
});

test('app-readable-snapshot:REVIEW_PR_SNAPSHOT_FORK_NAME=0 才关;不设时照旧读 nameWithOwner', async () => {
  const { fetchOpenPrSnapshot } = await import('./lib.mjs');
  const saved = process.env.REVIEW_PR_SNAPSHOT_FORK_NAME;
  try {
    delete process.env.REVIEW_PR_SNAPSHOT_FORK_NAME;
    const upstream = snapshotFixture([{ node: { headRepository: { nameWithOwner: 'contributor/fork' } } }]);
    assert.deepEqual(fetchOpenPrSnapshot({ owner: 'o', repo: 'r', ghGraphqlFn: upstream.ghGraphqlFn }).map((p) => p.headRepository), ['contributor/fork']);
    assert.match(upstream.queries[0], /headRepository\s*\{\s*nameWithOwner\s*\}/);
    process.env.REVIEW_PR_SNAPSHOT_FORK_NAME = '0';
    const mini = snapshotFixture([{ node: { isCrossRepository: false } }]);
    fetchOpenPrSnapshot({ owner: 'o', repo: 'r', ghGraphqlFn: mini.ghGraphqlFn });
    assert.doesNotMatch(mini.queries[0], /headRepository/);
  } finally {
    if (saved === undefined) delete process.env.REVIEW_PR_SNAPSHOT_FORK_NAME;
    else process.env.REVIEW_PR_SNAPSHOT_FORK_NAME = saved;
  }
});

test('app-readable-snapshot:叠放依赖(stackedBaseDependencies)两种快照判定一致', async () => {
  const { fetchOpenPrSnapshot } = await import('./lib.mjs');
  const { stackedBaseDependencies } = await import('./review-dependencies.mjs');
  const prs = [
    { headRefName: 'parent', node: { isCrossRepository: false, headRepository: { nameWithOwner: 'o/r' } } },
    { headRefName: 'parent', node: { isCrossRepository: true, headRepository: { nameWithOwner: 'someone/r' } } },
    { headRefName: 'parent', node: { isCrossRepository: true, headRepository: null } },
  ];
  const pick = (readsForkName) => stackedBaseDependencies({ repo: 'O/R', pr: 99, baseRefName: 'parent', defaultBranch: 'main',
    snapshot: fetchOpenPrSnapshot({ owner: 'o', repo: 'r', ghGraphqlFn: snapshotFixture(prs).ghGraphqlFn, readsForkName }) })
    .map((p) => p.number);
  assert.deepEqual(pick(false), [1]);
  assert.deepEqual(pick(false), pick(true));
});

test('handoff-lines: 改动行数不算本 PR 自己的交接文件,别的 PR 的交接照常计数', () => {
  const files = [
    { path: 'src/a.ts', additions: 3, deletions: 1 },
    { path: 'docs/pr/12/review.md', additions: 90, deletions: 0 },
    { path: 'docs/pr/12/qa.md', additions: 80, deletions: 0 },
    { path: 'docs/pr/120/qa.md', additions: 5, deletions: 0 },
  ];
  assert.equal(countDiffLines(files, 12), 9);
  assert.equal(countDiffLines(files, '12'), 9);
  assert.equal(countDiffLines([], 12), 0);
});

test('handoff-gate-kind: Mivo 判门发出的每种打回 kind 都能生成并识别 gate review 标记', async () => {
  const { gateReviewMarker, selectGateReviewsToDismiss } = await import('./review-markers.mjs');
  const gatesSrc = readFileSync(new URL('../../mivo/lib/gates.mjs', import.meta.url), 'utf8');
  const kinds = [...new Set([...gatesSrc.matchAll(/gateKind: '([a-z]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(kinds, ['format', 'handoff', 'security']);
  const head = 'a'.repeat(40);
  const old = 'b'.repeat(40);
  for (const kind of kinds) {
    const reviews = [{ id: 1, state: 'CHANGES_REQUESTED', user: { login: 'bot' }, commit_id: old, body: `x\n\n${gateReviewMarker(kind, old)}` }];
    assert.deepEqual(selectGateReviewsToDismiss(reviews, 'bot', head).map((r) => r.id), [1], kind);
  }
  assert.throws(() => gateReviewMarker('other', head), /gate kind/);
});

test('p2-blocking: 三个新增上游文件已登记,口径不再写 P2 不报', () => {
  const root = new URL('../../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('tools/lizi-sync.json', root), 'utf8'));
  for (const file of [
    'review-pr-auto/references/pr-worker.md',
    'review-pr/references/fix-handoff.md',
    'review-pr/scripts/dismiss-own-review.mjs',
  ]) {
    assert.ok(manifest.patched.includes(file), file);
    const text = readFileSync(new URL(file, root), 'utf8');
    assert.match(text, /\[MIVO-PATCH p2-blocking\]/);
  }
  const skill = readFileSync(new URL('review-pr/SKILL.md', root), 'utf8');
  const worker = readFileSync(new URL('review-pr-auto/references/pr-worker.md', root), 'utf8');
  const ruleMap = readFileSync(new URL('review-pr/references/rule-map.md', root), 'utf8');
  assert.doesNotMatch(skill, /P2 = 风格与可选优化/);
  assert.doesNotMatch(worker, /只报告本 PR 可证实的 P0\/P1，不以 P2/);
  assert.doesNotMatch(ruleMap, /若只有 P2，结论必须是通过/);
  assert.match(skill, /\[P0\|P1\|P2\]/);
  assert.match(skill, /\[MIVO-PATCH p2-blocking\]/);
  assert.match(ruleMap, /\[MIVO-PATCH p2-blocking\]/);
  assert.match(worker, /P0\/P1\/P2/);
});
