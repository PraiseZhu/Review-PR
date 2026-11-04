// 审查身份集合(#176):纯函数表驱动 + 统一读取入口 + 11 个脚本不再直读 /user + bot 身份下 approve/merge 拒绝。
// 所有用例都用 fake gh,不触达真实 GitHub;lib.mjs 的状态目录指向临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'reviewer-identity-test-'));
process.env.REVIEW_PR_STATE_DIR = join(scratch, 'state');
delete process.env.REVIEW_PR_VIEWER_LOGIN;
delete process.env.REVIEW_PR_VIEWER_ALIASES;
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const {
  normalizeReviewActor, validateViewerLogin, parseViewerAliases, createReviewIdentity,
  isReviewIdentity, sameReviewActor, toReviewIdentity,
} = await import('./reviewer-identity.mjs');
const {
  readReviewIdentity, evaluateMaintainerApprovalPolicy, parseLastHoldMarker, isTrustedHoldMarkerAuthor, isAutomatedViewerReview,
  selectSelfFindingsAtHead, selectStandingViewerHumanChangesRequest, evaluateOwnReviewDismissal,
} = await import('./lib.mjs');
const { hasTrustedRebaseReminder, rebaseReminderFingerprint, rebaseReminderMarker } = await import('./rebase-reminder.mjs');
const { selectGateReviewsToDismiss } = await import('./review-markers.mjs');
const { notifyTargetBranch, targetBranchFingerprint, targetBranchMarker } = await import('./target-branch-reminder.mjs');

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const THREE = createReviewIdentity({
  viewerLogin: 'praisebuild[bot]', viewerAliases: ['PraiseZhu', 'praise-reviewer[bot]'],
});

// pure module
test('默认身份集合只含 viewer 自己,不内置任何名字 (SC1)', () => {
  const identity = createReviewIdentity({ viewerLogin: 'PraiseZhu' });
  assert.deepEqual(identity.logins, ['praisezhu']);
  assert.equal(identity.isBot, false);
  assert.equal(isReviewIdentity('praisebuild[bot]', identity), false);
  assert.equal(isReviewIdentity({ login: 'praisebuild', __typename: 'Bot' }, identity), false);
  assert.equal(isReviewIdentity('PRAISEZHU', identity), true);
});

test('没有 viewer 时,只有 aliases 不能凑出身份 (fail closed)', () => {
  const identity = createReviewIdentity({ viewerLogin: '', viewerAliases: ['PraiseZhu'] });
  assert.deepEqual(identity.logins, []);
  assert.equal(isReviewIdentity('PraiseZhu', identity), false);
});

const POSITIVE = [
  ['praisebuild[bot]', 'REST bot'],
  [{ login: 'praisebuild', __typename: 'Bot' }, 'GraphQL Bot'],
  [{ login: 'praisebuild', type: 'Bot' }, 'REST type=Bot 无后缀'],
  [{ login: 'PraiseBuild[BOT]' }, '大小写'],
  ['PraiseZhu', '旧留痕大小写'],
  ['  praisezhu ', '空白'],
  [{ login: 'PraiseZhu', __typename: 'User' }, 'GraphQL User'],
  ['praise-reviewer[bot]', 'REST 第二个 bot'],
  [{ login: 'Praise-Reviewer', __typename: 'Bot' }, 'GraphQL 第二个 bot'],
];
const NEGATIVE = [
  ['praisebuild', '同名 User 不是 Bot'],
  [{ login: 'praisebuild', __typename: 'User' }, 'GraphQL 同名 User'],
  ['praisebuild-evil[bot]', '名字相近'],
  ['praisezhu2', '名字相近'],
  ['praisezhu[bot]', '人名冒 bot 后缀'],
  ['praise-reviewer', '裸 User'],
  ['xpraisezhu', '前缀拼接'],
  ['', '空'], [null, 'null'], [undefined, 'undefined'], [{}, '空对象'], [42, '数字'],
];
for (const [actor, why] of POSITIVE) {
  test(`命中集合: ${why} ${JSON.stringify(actor)} (SC2)`, () => assert.equal(isReviewIdentity(actor, THREE), true));
}
for (const [actor, why] of NEGATIVE) {
  test(`不命中集合: ${why} ${JSON.stringify(actor)} (SC2)`, () => assert.equal(isReviewIdentity(actor, THREE), false));
}

test('normalizeReviewActor 给出 canonical key', () => {
  assert.deepEqual(normalizeReviewActor({ login: 'PraiseBuild', __typename: 'Bot' }),
    { login: 'praisebuild', isBot: true, key: 'praisebuild[bot]' });
  assert.deepEqual(normalizeReviewActor('PraiseBuild[bot]'), { login: 'praisebuild', isBot: true, key: 'praisebuild[bot]' });
  assert.deepEqual(normalizeReviewActor('PraiseZhu'), { login: 'praisezhu', isBot: false, key: 'praisezhu' });
  assert.equal(normalizeReviewActor(''), null);
  assert.equal(normalizeReviewActor(null), null);
});

test('validateViewerLogin: 合法返回原拼写,非法报字段名', () => {
  assert.equal(validateViewerLogin(' praisebuild[bot] ', 'viewerLogin'), 'praisebuild[bot]');
  assert.equal(validateViewerLogin('PraiseZhu', 'viewerLogin'), 'PraiseZhu');
  for (const bad of ['bad name', 'a'.repeat(40), '', 5, 'foo[bot]x', '-lead', '[bot]', null]) {
    assert.throws(() => validateViewerLogin(bad, 'viewerLogin'), /viewerLogin/, JSON.stringify(bad));
  }
});

test('parseViewerAliases: 未设为空数组;非法输入报字段名 (SC7)', () => {
  assert.deepEqual(parseViewerAliases(undefined), []);
  assert.deepEqual(parseViewerAliases('   '), []);
  assert.deepEqual(parseViewerAliases('[]'), []);
  assert.deepEqual(parseViewerAliases('["PraiseZhu","praise-reviewer[bot]"]'), ['PraiseZhu', 'praise-reviewer[bot]']);
  assert.deepEqual(parseViewerAliases(['A', 'a', 'b[bot]'], 'viewerAliases'), ['A', 'b[bot]'], '按 canonical 去重、保序');
  assert.throws(() => parseViewerAliases('not json'), /REVIEW_PR_VIEWER_ALIASES/);
  assert.throws(() => parseViewerAliases('{"a":1}'), /REVIEW_PR_VIEWER_ALIASES/);
  assert.throws(() => parseViewerAliases('"PraiseZhu"'), /REVIEW_PR_VIEWER_ALIASES/);
  assert.throws(() => parseViewerAliases('[1]'), /REVIEW_PR_VIEWER_ALIASES\[0\]/);
  assert.throws(() => parseViewerAliases(['ok', 'bad name'], 'viewerAliases'), /viewerAliases\[1\]/);
  assert.throws(() => parseViewerAliases('PraiseZhu', 'viewerAliases'), /viewerAliases/);
  assert.throws(() => parseViewerAliases({}, 'viewerAliases'), /viewerAliases/);
});

test('sameReviewActor 精确比较,不做 aliases 等价', () => {
  assert.equal(sameReviewActor('PraiseZhu', 'praisezhu'), true);
  assert.equal(sameReviewActor('praisebuild[bot]', { login: 'praisebuild', __typename: 'Bot' }), true);
  assert.equal(sameReviewActor('praisebuild[bot]', 'praise-reviewer[bot]'), false);
  assert.equal(sameReviewActor('praisebuild[bot]', 'praisebuild'), false);
  assert.equal(sameReviewActor('', ''), false);
  assert.equal(sameReviewActor(null, undefined), false);
});

test('toReviewIdentity: 字符串 -> singleton;身份对象原样;空 -> 空集合', () => {
  assert.deepEqual(toReviewIdentity('PraiseZhu').logins, ['praisezhu']);
  assert.equal(toReviewIdentity(THREE), THREE);
  assert.deepEqual(toReviewIdentity(undefined).logins, []);
  assert.deepEqual(toReviewIdentity('').logins, []);
});

test('createReviewIdentity 结果可 JSON 序列化后继续使用', () => {
  const copy = JSON.parse(JSON.stringify(THREE));
  assert.equal(isReviewIdentity('PraiseZhu', copy), true);
  assert.equal(copy.isBot, true);
  assert.equal(copy.viewerLogin, 'praisebuild[bot]');
});

test('纯模块不 import lib、不读环境、不碰文件系统', () => {
  const source = readFileSync(here('reviewer-identity.mjs'), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]\.\/lib\.mjs['"]/);
  assert.doesNotMatch(source, /process\.env|node:fs|node:child_process/);
});

// readReviewIdentity (lib I/O wrapper)
function countingGh(output = 'PraiseZhu\n') {
  const calls = [];
  const fn = (args, options) => { calls.push({ args, options }); return { ok: true, status: 0, stdout: output, stderr: '' }; };
  fn.calls = calls;
  return fn;
}

test('readReviewIdentity: 配了 override 与 aliases 时不发 /user (SC5)', () => {
  const ghFn = countingGh();
  const identity = readReviewIdentity({ ghFn, env: {
    REVIEW_PR_VIEWER_LOGIN: 'praisebuild[bot]', REVIEW_PR_VIEWER_ALIASES: '["PraiseZhu","praise-reviewer[bot]"]',
  } });
  assert.equal(ghFn.calls.length, 0);
  assert.equal(identity.viewerLogin, 'praisebuild[bot]');
  assert.equal(identity.isBot, true);
  assert.equal(isReviewIdentity('PraiseZhu', identity), true);
});

test('readReviewIdentity: 调用方已读到 viewer 时不再发 /user', () => {
  const ghFn = countingGh();
  const identity = readReviewIdentity({ ghFn, env: {}, fallbackViewer: { login: 'praisebuild', __typename: 'Bot' } });
  assert.equal(ghFn.calls.length, 0);
  assert.equal(identity.isBot, true);
  assert.deepEqual(identity.logins, ['praisebuild[bot]']);
});

test('readReviewIdentity: 没配身份才回落 gh api user,且集合只有自己 (SC1/SC5)', () => {
  const ghFn = countingGh('PraiseZhu\n');
  const identity = readReviewIdentity({ ghFn, env: {} });
  assert.equal(ghFn.calls.length, 1);
  assert.deepEqual(ghFn.calls[0].args, ['api', 'user', '--jq', '.login']);
  assert.equal(ghFn.calls[0].options?.noCredFallback, true);
  assert.deepEqual(identity.logins, ['praisezhu']);
  assert.equal(identity.isBot, false);
});

test('readReviewIdentity: 回落读到空或失败时抛稳定错误码,不静默放行', () => {
  assert.throws(() => readReviewIdentity({ ghFn: countingGh('\n'), env: {} }), /REVIEW_IDENTITY_UNAVAILABLE/);
  const failing = () => ({ ok: false, status: 1, stdout: '', stderr: 'HTTP 403' });
  assert.throws(() => readReviewIdentity({ ghFn: failing, env: {} }), /REVIEW_IDENTITY_UNAVAILABLE/);
});

test('readReviewIdentity: aliases 非法在发请求前就抛,不回落', () => {
  const ghFn = countingGh();
  assert.throws(() => readReviewIdentity({ ghFn, env: { REVIEW_PR_VIEWER_ALIASES: '{"x":1}' } }), /REVIEW_PR_VIEWER_ALIASES/);
  assert.throws(() => readReviewIdentity({ ghFn, env: { REVIEW_PR_VIEWER_LOGIN: 'bad name' } }), /REVIEW_PR_VIEWER_LOGIN/);
  assert.equal(ghFn.calls.length, 0);
});

// static scan
test('11 个脚本不再直接调用 gh api user (SC5)', () => {
  const files = [
    'approve-reviewed-pr.mjs', 'merge-reviewed-pr.mjs', 'request-changes-reviewed-pr.mjs', 'pr-write-guard.mjs',
    'dismiss-own-review.mjs', 'dismiss-stale-reviews.mjs', 'signoff-hold.mjs', 'signoff-release.mjs',
    'notify-author-resolve.mjs', 'target-branch-reminder.mjs', '../../mivo/lib/resolve-fixed-threads.mjs',
  ];
  for (const file of files) {
    const source = readFileSync(here(file), 'utf8');
    assert.doesNotMatch(source, /['"]api['"]\s*,\s*['"]user['"]/, `${file} 仍直接读 /user`);
  }
});

// CLI: bot identity forbidden
function makeFakeGh(directory, { viewer = '' } = {}) {
  const bin = join(directory, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(directory, 'gh-calls.jsonl');
  const script = join(bin, 'gh');
  writeFileSync(script, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args[1] === 'user') { process.stdout.write(${JSON.stringify(viewer)}); process.exit(0); }
process.stderr.write('fake gh: unexpected ' + args.join(' '));
process.exit(1);
`);
  chmodSync(script, 0o755);
  return { bin, log };
}

function runCli(script, { viewer, env = {} }) {
  const directory = mkdtempSync(join(scratch, 'cli-'));
  const repoRoot = join(directory, 'repo');
  mkdirSync(repoRoot);
  for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
    assert.equal(spawnSync('git', args, { cwd: repoRoot }).status, 0);
  }
  const fake = makeFakeGh(directory, { viewer });
  const clean = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(REVIEW_PR_|GH_|GITHUB_)/.test(key)));
  const stateDir = join(directory, 'state');
  const child = spawnSync(process.execPath, [here(script), '1', '--review-clean', '--lock-token', 'fixture-lock',
    '--expected-head', 'a'.repeat(40), '--expected-base', 'b'.repeat(40), '--expected-base-ref', 'main',
    '--expected-authority-digest', 'digest', '--method', 'squash'], {
    cwd: repoRoot, encoding: 'utf8',
    env: { ...clean, PATH: `${fake.bin}:${process.env.PATH}`, REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_STATE_DIR: stateDir,
      REVIEW_PR_NO_CRED_FALLBACK: '1', ...env },
  });
  const calls = existsSync(fake.log) ? readFileSync(fake.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const locks = existsSync(stateDir) ? readdirSync(stateDir, { recursive: true }).filter((name) => /lock/i.test(String(name))) : [];
  let out = null;
  try { out = JSON.parse(child.stdout); } catch { /* 留给断言报错 */ }
  return { child, out, calls, locks };
}

const noWrites = (calls) => calls.filter((args) => args.includes('POST') || args[0] === 'pr' && args[1] === 'merge');

for (const [name, setup] of [
  ['配置里的 bot', { env: { REVIEW_PR_VIEWER_LOGIN: 'praisebuild[bot]', REVIEW_PR_VIEWER_ALIASES: '["PraiseZhu"]' } }],
  ['/user 读到 REST bot 后缀', { viewer: 'praise-reviewer[bot]' }],
]) {
  test(`approve-reviewed-pr 在 bot 身份下拒绝执行 (${name}) (SC6)`, () => {
    const { child, out, calls } = runCli('approve-reviewed-pr.mjs', setup);
    assert.equal(child.status, 2, child.stdout + child.stderr);
    assert.equal(out.approved, false);
    assert.equal(out.approval.code, 'bot-identity-forbidden');
    assert.match(out.approval.reason, /bot/i);
    assert.deepEqual(noWrites(calls), []);
  });
  test(`merge-reviewed-pr 在 bot 身份下拒绝执行且不占锁 (${name}) (SC6)`, () => {
    const { child, out, calls, locks } = runCli('merge-reviewed-pr.mjs', setup);
    assert.equal(child.status, 2, child.stdout + child.stderr);
    assert.equal(out.merged, false);
    assert.equal(out.mergeAttempted, false);
    assert.equal(out.code, 'bot-identity-forbidden');
    assert.deepEqual(noWrites(calls), []);
    assert.deepEqual(locks, []);
  });
}

test('人类身份不会被 bot 拒绝挡住 (SC6 反例)', () => {
  for (const script of ['approve-reviewed-pr.mjs', 'merge-reviewed-pr.mjs']) {
    const { out, child } = runCli(script, { env: { REVIEW_PR_VIEWER_LOGIN: 'PraiseZhu' } });
    assert.notEqual(out?.code, 'bot-identity-forbidden', child.stdout);
    assert.notEqual(out?.approval?.code, 'bot-identity-forbidden', child.stdout);
  }
});

// 三身份参数化:同一份留痕由 PraiseZhu(旧)/ praisebuild[bot] / praise-reviewer[bot](GraphQL 或 REST 形态)写出,结论一致 (SC3/SC4)
const HEAD = 'a'.repeat(40);
const WRITERS = [
  ['PraiseZhu', { login: 'PraiseZhu', __typename: 'User' }, { login: 'PraiseZhu', type: 'User' }],
  ['praisebuild[bot]', { login: 'praisebuild', __typename: 'Bot' }, { login: 'praisebuild[bot]', type: 'Bot' }],
  ['praise-reviewer[bot]', { login: 'praise-reviewer', __typename: 'Bot' }, { login: 'praise-reviewer[bot]', type: 'Bot' }],
];
const OUTSIDERS = [
  { login: 'praisebuild-evil', __typename: 'Bot' }, { login: 'praisebuild', __typename: 'User' },
  { login: 'someone-else', __typename: 'User' }, { login: 'github-actions', __typename: 'Bot' },
];
const HOLD_BODY = '<!-- review-pr:product-gate kind=product issue=https://github.com/o/r/issues/9 -->';

for (const [name, graphql, rest] of WRITERS) {
  test(`hold marker: ${name} 写的被信任 (SC3)`, () => {
    for (const author of [graphql, rest]) {
      const hold = parseLastHoldMarker([{ body: HOLD_BODY, createdAt: '2026-11-04T00:00:00Z', author }], { viewerLogin: THREE });
      assert.equal(hold?.issueNumber, 9, JSON.stringify(author));
    }
    const fromRest = parseLastHoldMarker([{ body: HOLD_BODY, user: rest }], { viewerLogin: THREE });
    assert.equal(fromRest?.issueNumber, 9, 'REST comment 形状 user.login');
  });
  test(`维护者自批排除: PR 作者是 ${name} → viewerIsAuthor (SC4)`, () => {
    const authority = { members: ['kirozeng'], teamMembers: [], allowlistedMembers: [], digest: 'd' };
    const policy = evaluateMaintainerApprovalPolicy({ authorLogin: rest.login, viewerLogin: 'praisebuild[bot]', authority, reviewerIdentity: THREE });
    assert.equal(policy.viewerIsAuthor, true);
    assert.equal(policy.viewerIsMaintainer, false, '集合不赋予维护者资格');
    assert.equal(policy.viewerCanApprove, false);
  });
  test(`自己的 findings review / 旧 CR 判断: ${name} (SC4)`, () => {
    const review = { id: 1, state: 'COMMENTED', author: graphql, submittedAt: '2026-11-04T01:00:00Z', body: `x <!-- review-pr:findings head=${HEAD} digest=d -->` };
    assert.equal(selectSelfFindingsAtHead([review], { reviewerIdentity: THREE, authorLogin: rest.login, headSha: HEAD })?.id, 1);
    assert.equal(selectSelfFindingsAtHead([{ ...review, author: undefined, user: rest }], { reviewerIdentity: THREE, authorLogin: rest.login, headSha: HEAD })?.id, 1);
    const auto = { ...review, body: '> Mivo 自动审查 · x' };
    assert.equal(isAutomatedViewerReview(auto, THREE), true);
    const humanCr = { id: 2, state: 'CHANGES_REQUESTED', author: graphql, submittedAt: '2026-11-04T01:00:00Z', body: '改一下' };
    const standing = selectStandingViewerHumanChangesRequest([humanCr], THREE);
    assert.equal(Boolean(standing), name === 'PraiseZhu', 'bot 没有「维护者本人的人工 CR」含义');
  });
  test(`reminded 去重: ${name} 发过的提醒算已提醒 (SC4)`, () => {
    const fingerprint = rebaseReminderFingerprint('2026-10-01T00:00:00Z');
    const comment = { user: rest, body: `提醒\n${rebaseReminderMarker(fingerprint)}` };
    assert.equal(hasTrustedRebaseReminder([comment], { viewer: THREE, fingerprint, mergeBaseDate: '2026-10-01T00:00:00Z' }), true);
    assert.equal(hasTrustedRebaseReminder([comment], { viewer: 'someone', fingerprint, mergeBaseDate: '2026-10-01T00:00:00Z' }), false);
  });
  test(`dismiss 门禁打回: ${name} 留的打回算自己的 (SC4)`, () => {
    const marker = `<!-- review-pr:gate-review kind=format head=${'b'.repeat(40)} -->`;
    const review = { id: 5, state: 'CHANGES_REQUESTED', user: rest, commit_id: 'b'.repeat(40), body: marker };
    assert.equal(selectGateReviewsToDismiss([review], THREE, HEAD).length, 1);
    assert.equal(selectGateReviewsToDismiss([review], 'someone', HEAD).length, 0);
  });
}

for (const author of OUTSIDERS) {
  test(`集合外作者不被信任: ${JSON.stringify(author)} (SC3)`, () => {
    assert.equal(isTrustedHoldMarkerAuthor({ body: HOLD_BODY, author }, THREE), false);
    assert.equal(parseLastHoldMarker([{ body: HOLD_BODY, author }], { viewerLogin: THREE }), null);
    assert.equal(selectSelfFindingsAtHead([{ id: 1, author, body: `<!-- review-pr:findings head=${HEAD} -->` }],
      { reviewerIdentity: THREE, authorLogin: 'PraiseZhu', headSha: HEAD }), null);
  });
}

test('hold marker: 没带 viewerLogin 选项仍是旧的纯解析(不看作者);空身份 fail closed (SC3)', () => {
  assert.equal(parseLastHoldMarker([HOLD_BODY])?.issueNumber, 9);
  assert.equal(parseLastHoldMarker([{ body: HOLD_BODY, author: { login: 'PraiseZhu' } }], { viewerLogin: '' }), null);
  assert.equal(parseLastHoldMarker([{ body: HOLD_BODY, author: { login: 'PraiseZhu' } }], { viewerLogin: createReviewIdentity() }), null);
  // 旧调用方传字符串:行为同改前。
  assert.equal(parseLastHoldMarker([{ body: HOLD_BODY, author: { login: 'praisezhu' } }], { viewerLogin: 'PraiseZhu' })?.issueNumber, 9);
});

test('不分账号的覆盖: 另一个身份后发 Approve 盖不掉 PraiseZhu 仍有效的人工 CR (SC4)', () => {
  const reviews = [
    { id: 1, state: 'CHANGES_REQUESTED', author: { login: 'PraiseZhu' }, submittedAt: '2026-11-04T01:00:00Z', body: '人工打回' },
    { id: 2, state: 'APPROVED', author: { login: 'praisebuild', __typename: 'Bot' }, submittedAt: '2026-11-04T02:00:00Z', body: '' },
  ];
  assert.equal(selectStandingViewerHumanChangesRequest(reviews, THREE)?.id, 1);
});

test('evaluateOwnReviewDismissal: 集合内任一身份的 CR 都算自己的,别人的 CR 仍拦 (SC4)', () => {
  const base = { approvalExempt: true, reviewClean: true, state: 'OPEN', mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED',
    unresolvedCount: 0, threadsVerified: true, expectedHead: HEAD, actualHead: HEAD, reviewerIdentity: THREE, viewerLogin: 'praisebuild[bot]' };
  const own = [{ id: 11, state: 'CHANGES_REQUESTED', user: { login: 'PraiseZhu' }, submitted_at: '2026-11-04T01:00:00Z' }];
  assert.equal(evaluateOwnReviewDismissal({ ...base, reviews: own }).available, true);
  const mixed = [...own, { id: 12, state: 'CHANGES_REQUESTED', user: { login: 'kirozeng' }, submitted_at: '2026-11-04T01:30:00Z' }];
  assert.equal(evaluateOwnReviewDismissal({ ...base, reviews: mixed }).available, false);
});

test('target-branch 提醒去重: 三个身份写的提醒都算已提醒 (SC4)', () => {
  for (const [name, , rest] of WRITERS) {
    const head = 'c'.repeat(40);
    const parent = { number: 7, state: 'closed', merged_at: '2026-10-01T00:00:00Z', head: { ref: 'dev', repo: { full_name: 'o/r' } } };
    const fingerprint = targetBranchFingerprint({ baseRefName: 'dev', defaultBranch: 'main', basePr: { number: 7, state: 'MERGED', mergedAt: '2026-10-01T00:00:00Z' } });
    const comments = [{ user: rest, body: `x\n${targetBranchMarker(fingerprint)}`, html_url: 'u' }];
    const api = {
      readReviewIdentity: () => THREE,
      ghJson: (args) => args[0] === 'pr' ? { state: 'OPEN', isDraft: false, author: { login: 'a' }, headRefOid: head, baseRefName: 'dev' }
        : { defaultBranchRef: { name: 'main' } },
      fetchRestPages: (endpoint) => endpoint.includes('/pulls?') ? [parent] : comments,
      writeGh: () => { throw new Error(`${name}: 不应再发提醒`); },
    };
    const result = notifyTargetBranch({ owner: 'o', repo: 'r', pr: 1, expectedHead: head, expectedBaseRef: 'dev' }, api);
    assert.equal(result.reason, 'already-commented', name);
  }
});

test('pr-write-guard: 写前身份绑定精确比较,集合内换成另一个账号也拒绝 (SC4)', async () => {
  const { createPrWriteGuard } = await import('./pr-write-guard.mjs');
  const made = (viewerLogin, expectedViewer) => {
    const calls = [];
    const write = createPrWriteGuard({ owner: 'o', repo: 'r', pr: 1, lockToken: 't', expectedHead: HEAD, expectedAuthorityDigest: 'd', expectedViewer }, {
      assertActiveReviewLock: () => {},
      readReviewIdentity: () => createReviewIdentity({ viewerLogin, viewerAliases: ['PraiseZhu', 'praisebuild[bot]', 'praise-reviewer[bot]'] }),
      fetchMaintainerAuthority: () => ({ digest: 'd', members: [viewerLogin.toLowerCase()] }),
      ghJson: () => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, author: { login: 'author' }, updatedAt: 'x' }),
      gh: (args) => { calls.push(args); return { ok: true, stdout: '' }; },
      recordSelfWrite: () => {},
    });
    return { write, calls };
  };
  const same = made('PraiseZhu', 'praisezhu');
  same.write(['api', 'x']);
  assert.equal(same.calls.length, 1);
  const drifted = made('praisebuild[bot]', 'PraiseZhu');
  assert.throws(() => drifted.write(['api', 'x']), /viewer/);
  assert.equal(drifted.calls.length, 0);
});
