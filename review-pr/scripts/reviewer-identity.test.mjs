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
const { readReviewIdentity } = await import('./lib.mjs');

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
