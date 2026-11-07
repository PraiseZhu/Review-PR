// [MIVO-PATCH bot-author-alias] botAuthorAliases:名单里的 bot 开的 PR 与它所代表维护者本人开的 PR 作者权限相同
// (PraiseZhu/Review-PR#223)。只作用于 PR 作者;放行人、审查人判断不看别名。纯函数与依赖注入测试,不读 GitHub。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  evaluateMaintainerApprovalPolicy,
  evaluateApprovalExemption,
  normalizeBotAuthorAliases,
  createReviewIdentity,
} from './lib.mjs';
import { createPrWriteGuard } from './pr-write-guard.mjs';

const digest = `sha256:${'d'.repeat(64)}`;
const authority = { teamMembers: [], allowlistedMembers: ['praisezhu', 'kirozeng'], members: ['praisezhu', 'kirozeng'],
  codeowners: { teamHandle: null }, digest };
const aliases = { 'praise-qa[bot]': 'PraiseZhu' };
// gh pr view、REST、GraphQL 对同一个 App 作者的三种写法。
const APP_AUTHORS = ['app/praise-qa', 'praise-qa[bot]', { login: 'praise-qa', __typename: 'Bot' }];

test('SC1 normalizeBotAuthorAliases:两种 bot 写法归一,缺省为空表,_comment 跳过', () => {
  for (const value of [{ 'praise-qa[bot]': 'PraiseZhu' }, { 'app/praise-qa': 'PraiseZhu' }, { _comment: 'x', 'Praise-QA[bot]': ' praisezhu ' }]) {
    assert.deepEqual([...normalizeBotAuthorAliases(value)], [['praise-qa[bot]', 'praisezhu']], JSON.stringify(value));
  }
  assert.deepEqual([...normalizeBotAuthorAliases(undefined)], []);
  assert.deepEqual([...normalizeBotAuthorAliases({})], []);
  // 已归一的对象再传一次结果不变(loadRules 存的是对象,调用方原样传回)。
  const once = Object.fromEntries(normalizeBotAuthorAliases(aliases));
  assert.deepEqual(Object.fromEntries(normalizeBotAuthorAliases(once)), once);
});

test('SC1 normalizeBotAuthorAliases:配置异常抛错,错误写出字段与出错的键', () => {
  const cases = [
    [null, /botAuthorAliases 必须是对象.*实际 null/],
    [['praise-qa[bot]'], /botAuthorAliases 必须是对象.*实际 array/],
    ['praise-qa[bot]', /botAuthorAliases 必须是对象.*实际 string/],
    [{ 'praise-qa': 'PraiseZhu' }, /键 "praise-qa" 必须是 GitHub App 的 bot 登录名/],
    [{ 'praise-qa[bot]': '' }, /botAuthorAliases\["praise-qa\[bot\]"\] 不是合法的 GitHub 登录名/],
    [{ 'praise-qa[bot]': 'other[bot]' }, /botAuthorAliases\["praise-qa\[bot\]"\] 必须是真人维护者登录名/],
    [{ 'praise-qa[bot]': 'app/other' }, /botAuthorAliases\["praise-qa\[bot\]"\] 不是合法的 GitHub 登录名/],
    [{ 'praise-qa[bot]': 7 }, /botAuthorAliases\["praise-qa\[bot\]"\] 不是合法的 GitHub 登录名/],
    [{ 'praise-qa[bot]': 'PraiseZhu', 'app/praise-qa': 'kirozeng' }, /同时指向 praisezhu 和 kirozeng/],
  ];
  for (const [value, pattern] of cases) assert.throws(() => normalizeBotAuthorAliases(value), pattern, JSON.stringify(value));
});

test('SC2 传入别名时,App 开的 PR 与 PraiseZhu 本人作者同权;三种写法结果相同', () => {
  const own = evaluateMaintainerApprovalPolicy({ authorLogin: 'PraiseZhu', authority, botAuthorAliases: aliases });
  for (const authorLogin of APP_AUTHORS) {
    const policy = evaluateMaintainerApprovalPolicy({ authorLogin, authority, botAuthorAliases: aliases });
    assert.equal(policy.authorIsMaintainer, true, JSON.stringify(authorLogin));
    assert.equal(policy.approvalRequired, own.approvalRequired);
    assert.equal(policy.authorAuthoritySource, own.authorAuthoritySource);
    assert.equal(policy.authorActsAs, 'praisezhu');
    assert.equal(policy.author, 'praise-qa[bot]', 'bot 的身份不变,只有作者身份继承');
    const exemption = evaluateApprovalExemption({ authorLogin, authority, botAuthorAliases: aliases });
    assert.equal(exemption.exempt, true);
    assert.equal(exemption.authorActsAs, 'praisezhu');
    assert.match(exemption.reason, /praise-qa\[bot\] 按 botAuthorAliases 代表维护者 praisezhu/);
  }
});

test('SC2 不传别名、别名目标不是维护者、同名真人、其他 bot:作者都不是维护者', () => {
  const cases = [
    ...APP_AUTHORS.map((authorLogin) => ({ authorLogin, authority })),
    { authorLogin: 'app/praise-qa', authority, botAuthorAliases: { 'praise-qa[bot]': 'outsider' } },
    { authorLogin: 'app/praise-qa', authority: { ...authority, members: ['kirozeng'], allowlistedMembers: ['kirozeng'] }, botAuthorAliases: aliases },
    { authorLogin: 'praise-qa', authority, botAuthorAliases: aliases },
    { authorLogin: { login: 'praise-qa', __typename: 'User' }, authority, botAuthorAliases: aliases },
    { authorLogin: 'app/other-app', authority, botAuthorAliases: aliases },
  ];
  for (const options of cases) {
    const policy = evaluateMaintainerApprovalPolicy(options);
    assert.equal(policy.authorIsMaintainer, false, JSON.stringify(options));
    assert.equal(policy.approvalRequired, true);
    assert.equal(policy.authorActsAs, undefined);
    assert.equal(evaluateApprovalExemption(options).exempt, false);
  }
});

test('SC2 别名不给 bot 审查或放行能力:bot 作为 viewer 不是维护者、不能 Approve', () => {
  for (const viewerLogin of APP_AUTHORS) {
    const policy = evaluateMaintainerApprovalPolicy({ authorLogin: 'kirozeng', viewerLogin, authority, botAuthorAliases: aliases });
    assert.equal(policy.viewerIsMaintainer, false, JSON.stringify(viewerLogin));
    assert.equal(policy.viewerCanApprove, false);
  }
  // 维护者给 App 的 PR 当 viewer:与 App 不是同一身份,不算自批。
  const reviewer = evaluateMaintainerApprovalPolicy({ authorLogin: 'app/praise-qa', viewerLogin: 'kirozeng', authority, botAuthorAliases: aliases,
    reviewerIdentity: createReviewIdentity({ viewerLogin: 'kirozeng' }) });
  assert.equal(reviewer.viewerIsAuthor, false);
});

test('SC3 只有判断 PR 作者的调用传别名;signoff-release 判放行人不传', () => {
  const read = (name) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
  // 从调用名取到配对的右括号为止(参数里有嵌套调用,不能用非贪婪正则截)。
  const calls = (src) => [...src.matchAll(/evaluate(?:MaintainerApprovalPolicy|ApprovalExemption)\(/g)].map((m) => {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      if (src[i] === ')' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`调用没有闭合:${src.slice(m.index, m.index + 60)}`);
  });
  const expected = { 'context.mjs': 1, 'pre-merge-check.mjs': 2, 'merge-reviewed-pr.mjs': 1, 'approve-reviewed-pr.mjs': 2,
    'pr-write-guard.mjs': 1, 'dismiss-own-review.mjs': 2 };
  for (const [name, count] of Object.entries(expected)) {
    const found = calls(read(name));
    assert.equal(found.length, count, `${name} 调用数`);
    for (const call of found) assert.match(call, /botAuthorAliases/, `${name}: ${call.slice(0, 80)}`);
  }
  const release = calls(read('signoff-release.mjs'));
  assert.equal(release.length, 2, 'signoff-release 判放行人的两处调用');
  for (const call of release) assert.doesNotMatch(call, /botAuthorAliases/);
});

function guardFor({ purpose, botAuthorAliases }) {
  const calls = [];
  const head = 'a'.repeat(40);
  const guard = createPrWriteGuard({ owner: 'o', repo: 'r', pr: 1, lockToken: 'lock', expectedHead: head, expectedAuthorityDigest: digest,
    expectedViewer: 'kirozeng', purpose, reviewerApps: [], botAuthorAliases }, {
    assertActiveReviewLock: () => {},
    readReviewIdentity: () => createReviewIdentity({ viewerLogin: 'kirozeng' }),
    fetchMaintainerAuthority: () => authority,
    ghJson: () => ({ state: 'OPEN', isDraft: false, headRefOid: head, author: { login: 'app/praise-qa', is_bot: true }, updatedAt: '2026-11-08T00:00:00Z' }),
    gh: (args) => { calls.push(args); return { ok: true, stdout: '{}', stderr: '' }; },
    recordSelfWrite: () => {},
    isSignoffExemptAuthor: () => false,
  });
  return { guard, calls };
}
const ISSUE = ['api', '--method', 'POST', 'repos/o/r/issues', '--input', '-'];

test('SC4 pr-write-guard:App 开的 PR 与维护者作者相同,拒绝 hold、允许 signoff-notice;没配别名时相反', () => {
  const hold = guardFor({ purpose: 'hold', botAuthorAliases: aliases });
  assert.throws(() => hold.guard(ISSUE, { input: '{}' }), /维护者作者免前置确认门，拒绝 hold/);
  assert.equal(hold.calls.length, 0);
  const notice = guardFor({ purpose: 'signoff-notice', botAuthorAliases: aliases });
  notice.guard(ISSUE, { input: '{}' });
  assert.equal(notice.calls.length, 1);

  const plainHold = guardFor({ purpose: 'hold', botAuthorAliases: {} });
  plainHold.guard(ISSUE, { input: '{}' });
  assert.equal(plainHold.calls.length, 1);
  const plainNotice = guardFor({ purpose: 'signoff-notice', botAuthorAliases: {} });
  assert.throws(() => plainNotice.guard(ISSUE, { input: '{}' }), /非豁免作者不发通知 issue/);
});

// 直接读 Mivo 的配置文件:CI 第一步用上游夹具配置(REVIEW_PR_RULES_FILE)跑本目录测试,loadRules 读不到 Mivo 的取值。
test('SC5 Mivo 配置:praise-qa[bot] 代表 PraiseZhu,且 PraiseZhu 在维护者补充白名单里', () => {
  const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../config/pr-rules.json', import.meta.url)), 'utf8'));
  assert.deepEqual(Object.fromEntries(normalizeBotAuthorAliases(rules.botAuthorAliases)), { 'praise-qa[bot]': 'praisezhu' });
  assert.ok(rules.maintainerAllowlist.map((login) => login.toLowerCase()).includes('praisezhu'));
});
