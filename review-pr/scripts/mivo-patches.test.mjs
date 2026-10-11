// mivo-patches.test.mjs — Mivo 补丁的回归(登记见仓库根 MIVO-PATCHES.md)。
// 只测补丁自己的纯函数与权限读取;上游行为由上游自带测试覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMaintainerAuthority,
  computeMaintainerAuthorityDigest,
  validateMaintainerAuthoritySnapshot,
  evaluateMaintainerApprovalPolicy,
  evaluateMaintainerReview,
  evaluateSignoffBlocking,
  isSignoffExemptAuthor,
  filterIgnoredCiContexts,
  parseSlackSyncComment,
  isExplicitSlackConsent,
  selectTrustedSlackReleases,
  onlyOwnRequiredChecksPending,
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
