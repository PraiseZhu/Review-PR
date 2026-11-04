// [MIVO-PATCH reviewer-app] 审查 App 的审批策略:App 只获得「可发审查」能力,不获得任何维护者才有的放行能力。
// 纯函数测试,不读 GitHub、不写任何东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateMaintainerApprovalPolicy,
  evaluateApprovalExemption,
  normalizeReviewerApps,
  loadRules,
} from './lib.mjs';
import { createReviewIdentity } from './reviewer-identity.mjs';

const authority = {
  teamMembers: [],
  allowlistedMembers: ['praisezhu', 'kirozeng'],
  members: ['praisezhu', 'kirozeng'],
  codeowners: { teamHandle: null },
  digest: `sha256:${'d'.repeat(64)}`,
};
const reviewerApps = ['praisebuild[bot]'];
const appIdentity = createReviewIdentity({ viewerLogin: 'praisebuild[bot]' });

test('没配 reviewerApps:policy 与改动前逐字段相同(App 不获得任何能力)', () => {
  for (const viewerLogin of ['praisezhu', 'praisebuild[bot]', 'outsider']) {
    for (const authorLogin of ['praisezhu', 'outsider', 'praisebuild[bot]']) {
      const withDefault = evaluateMaintainerApprovalPolicy({ authorLogin, viewerLogin, authority });
      const withEmpty = evaluateMaintainerApprovalPolicy({ authorLogin, viewerLogin, authority, reviewerApps: [] });
      assert.deepEqual(withEmpty, withDefault, `${viewerLogin}/${authorLogin}`);
      assert.equal(withDefault.viewerIsReviewerApp, false);
    }
  }
  const bot = evaluateMaintainerApprovalPolicy({ authorLogin: 'outsider', viewerLogin: 'praisebuild[bot]', authority });
  assert.equal(bot.viewerCanApprove, false);
  assert.equal(bot.viewerIsMaintainer, false);
});

test('viewer 是已配置的审查 App 且不是作者:能提交 Approve,但不是维护者', () => {
  for (const authorLogin of ['outsider', 'praisezhu']) {
    const policy = evaluateMaintainerApprovalPolicy({
      authorLogin, viewerLogin: 'praisebuild[bot]', authority, reviewerIdentity: appIdentity, reviewerApps,
    });
    assert.equal(policy.viewerIsReviewerApp, true, authorLogin);
    assert.equal(policy.viewerCanApprove, true, authorLogin);
    assert.equal(policy.viewerIsMaintainer, false, authorLogin);
    assert.equal(policy.viewerAuthoritySource, null, authorLogin);
  }
});

test('维护者资格、作者是否维护者、是否需要独立批准都不因 reviewerApps 改变', () => {
  const base = evaluateMaintainerApprovalPolicy({ authorLogin: 'outsider', viewerLogin: 'praisebuild[bot]', authority });
  const app = evaluateMaintainerApprovalPolicy({ authorLogin: 'outsider', viewerLogin: 'praisebuild[bot]', authority, reviewerApps });
  assert.equal(app.approvalRequired, base.approvalRequired);
  assert.equal(app.authorIsMaintainer, base.authorIsMaintainer);
  assert.equal(app.authorityDigest, base.authorityDigest);
  const human = evaluateMaintainerApprovalPolicy({ authorLogin: 'outsider', viewerLogin: 'praisezhu', authority, reviewerApps });
  assert.equal(human.viewerIsMaintainer, true);
  assert.equal(human.viewerCanApprove, true);
  assert.equal(human.viewerIsReviewerApp, false);
});

test('作者在审查身份集合内(含 viewerAliases)时 App 不能 Approve', () => {
  const sameAuthor = evaluateMaintainerApprovalPolicy({
    authorLogin: 'praisebuild[bot]', viewerLogin: 'praisebuild[bot]', authority, reviewerIdentity: appIdentity, reviewerApps });
  assert.equal(sameAuthor.viewerIsAuthor, true);
  assert.equal(sameAuthor.viewerCanApprove, false);
  const aliased = createReviewIdentity({ viewerLogin: 'praisebuild[bot]', viewerAliases: ['PraiseZhu'] });
  const viaAlias = evaluateMaintainerApprovalPolicy({
    authorLogin: 'PraiseZhu', viewerLogin: 'praisebuild[bot]', authority, reviewerIdentity: aliased, reviewerApps });
  assert.equal(viaAlias.viewerIsAuthor, true);
  assert.equal(viaAlias.viewerCanApprove, false);
  const noAlias = evaluateMaintainerApprovalPolicy({
    authorLogin: 'PraiseZhu', viewerLogin: 'praisebuild[bot]', authority, reviewerIdentity: appIdentity, reviewerApps });
  assert.equal(noAlias.viewerIsAuthor, false);
  assert.equal(noAlias.viewerCanApprove, true);
});

test('未配置的 bot、同名普通用户、带类型的 viewer 都按配置精确判断', () => {
  const other = evaluateMaintainerApprovalPolicy({ authorLogin: 'outsider', viewerLogin: 'other-app[bot]', authority, reviewerApps });
  assert.equal(other.viewerIsReviewerApp, false);
  assert.equal(other.viewerCanApprove, false);
  // 裸 praisebuild 是普通用户,不是 Bot(praisebuild):不能借同名取得 App 能力。
  const user = evaluateMaintainerApprovalPolicy({ authorLogin: 'outsider', viewerLogin: 'praisebuild', authority, reviewerApps });
  assert.equal(user.viewerIsReviewerApp, false);
  assert.equal(user.viewerCanApprove, false);
  const typed = evaluateMaintainerApprovalPolicy({
    authorLogin: 'outsider', viewerLogin: { login: 'praisebuild', __typename: 'Bot' }, authority, reviewerApps });
  assert.equal(typed.viewerIsReviewerApp, true);
  assert.equal(typed.viewer, 'praisebuild[bot]');
});

test('bot 作者:三种写法归一为同一作者,不会被当成维护者或获得豁免', () => {
  const forms = ['app/praisebuild', { login: 'praisebuild', __typename: 'Bot' }, 'praisebuild[bot]'];
  const policies = forms.map((authorLogin) => evaluateMaintainerApprovalPolicy({ authorLogin, viewerLogin: 'praisezhu', authority, reviewerApps }));
  for (const policy of policies) {
    assert.equal(policy.author, 'praisebuild[bot]');
    assert.equal(policy.authorIsMaintainer, false);
    assert.equal(policy.approvalRequired, true);
  }
  const exemptions = forms.map((authorLogin) => evaluateApprovalExemption({ authorLogin, authority }));
  for (const exemption of exemptions) {
    assert.equal(exemption.exempt, false);
    assert.equal(exemption.author, 'praisebuild[bot]');
  }
  // 授权名单里恰好有同名裸 slug 时,Bot 作者也不能借它获得维护者身份。
  const collide = { ...authority, members: [...authority.members, 'praisebuild'], allowlistedMembers: [...authority.allowlistedMembers, 'praisebuild'] };
  assert.equal(evaluateApprovalExemption({ authorLogin: 'praisebuild[bot]', authority: collide }).exempt, false);
  assert.equal(evaluateApprovalExemption({ authorLogin: 'app/praisebuild', authority: collide }).exempt, false);
  // 作者是人时行为不变。
  assert.equal(evaluateApprovalExemption({ authorLogin: 'PraiseZhu', authority }).exempt, true);
  assert.equal(evaluateApprovalExemption({ authorLogin: 'outsider', authority }).exempt, false);
});

test('normalizeReviewerApps:缺省为空;只接受带 [bot] 的合法登录名数组;错误信息含字段和实际值', () => {
  assert.deepEqual(normalizeReviewerApps(undefined), []);
  assert.deepEqual(normalizeReviewerApps(['PraiseBuild[bot]', 'praisebuild[bot]']), ['praisebuild[bot]']);
  for (const [value, pattern] of [
    [null, /reviewerApps.*数组.*null/],
    ['praisebuild[bot]', /reviewerApps.*数组.*string/],
    [['praisezhu'], /reviewerApps\[0\].*\[bot\].*praisezhu/],
    [['app/praisebuild'], /reviewerApps\[0\]/],
    [['ok[bot]', 'bad name[bot]'], /reviewerApps\[1\]/],
  ]) assert.throws(() => normalizeReviewerApps(value), pattern);
});

test('loadRules:没写 reviewerApps 得 [];写了就规范化;非法值阻断', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reviewer-app-rules-'));
  const previous = process.env.REVIEW_PR_RULES_FILE;
  try {
    const file = join(directory, 'rules.json');
    process.env.REVIEW_PR_RULES_FILE = file;
    writeFileSync(file, JSON.stringify({ maintainerAllowlist: [] }));
    assert.deepEqual(loadRules().reviewerApps, []);
    writeFileSync(file, JSON.stringify({ maintainerAllowlist: [], reviewerApps: ['PraiseBuild[bot]'] }));
    assert.deepEqual(loadRules().reviewerApps, ['praisebuild[bot]']);
    writeFileSync(file, JSON.stringify({ maintainerAllowlist: [], reviewerApps: ['PraiseZhu'] }));
    assert.throws(() => loadRules(), /reviewerApps\[0\]/);
    // reviewerApps 不是维护者:加进去不改变 maintainerAllowlist。
    writeFileSync(file, JSON.stringify({ maintainerAllowlist: ['PraiseZhu'], reviewerApps: ['praisebuild[bot]'] }));
    assert.deepEqual(loadRules().maintainerAllowlist, ['praisezhu']);
  } finally {
    if (previous === undefined) delete process.env.REVIEW_PR_RULES_FILE; else process.env.REVIEW_PR_RULES_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
