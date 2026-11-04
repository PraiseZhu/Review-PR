// #176 独立审查发现的两类问题的回归测试(用 fake gh 跑真实的 signoff-hold / signoff-release):
//  1. 读不到审查身份(/user 403 等)时,没有「viewer 未核验」分支的写类脚本必须中止,不能拿空身份集合继续写。
//  2. bot 自己写的 hold 标记要被认出来:`gh pr view --json comments` 对 bot 只给裸 login(没有类型),
//     所以这两个脚本必须读带 user.type 的 REST 评论,否则 praisebuild[bot] 写的标记会被当成外人,下一轮重复开确认 issue。
// 所有用例都不触达真实 GitHub。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'signoff-identity-test-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const HEAD_SHA = 'a'.repeat(40);
const HOLD_ISSUE = 'https://github.com/o/r/issues/7';
const holdMarkerBody = `维护者确认讨论:${HOLD_ISSUE}\n\n<!-- review-pr:product-gate issue=${HOLD_ISSUE} -->`;
const payload = {
  issueTitle: '维护者确认 · PR #179 改身份判断',
  issueBody: '### 触发原因\n\nx\n\n### PR\nhttps://x\n\n### 确认方式\n\ny',
  commentBody: '本 PR 命中维护者确认门。讨论 issue:{{ISSUE_URL}}',
};

// fake gh:把每次调用写进日志;`api user` 可配成 403;`pr view` 返回 gh 的真实形状(评论作者只有 login);
// REST 评论端点返回带 user.type 的形状;其余命令返回空 JSON 并算成功(这样旧行为里的写操作会被记下来)。
function writeFakeGh(directory, { userFails, prView, restComments }) {
  const bin = join(directory, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(directory, 'gh-calls.jsonl');
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args[1] === 'user') {
  if (${JSON.stringify(Boolean(userFails))}) { process.stderr.write('HTTP 403: Resource not accessible by integration'); process.exit(1); }
  process.stdout.write('PraiseZhu\\n'); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') { process.stdout.write(${JSON.stringify(JSON.stringify(prView))}); process.exit(0); }
if (args[0] === 'api' && args.some((a) => /\\/issues\\/179\\/comments$/.test(a))) {
  process.stdout.write(${JSON.stringify(JSON.stringify([restComments]))}); process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') { process.stdout.write(JSON.stringify({ state: 'OPEN', body: '', url: 'https://github.com/o/r/issues/' + args[2] })); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'create') { process.stdout.write('https://github.com/o/r/issues/99\\n'); process.exit(0); }
process.stdout.write('{}');
process.exit(0);
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, log };
}

function runSignoff(script, scriptArgs, { env = {}, userFails = false, comments = [], lock = false, labels = [] } = {}) {
  const directory = mkdtempSync(join(scratch, 'run-'));
  const repoRoot = join(directory, 'repo');
  mkdirSync(repoRoot);
  for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
    assert.equal(spawnSync('git', args, { cwd: repoRoot }).status, 0);
  }
  // gh pr view --json comments 的真实形状:作者只有 login,bot 没有 [bot] 后缀也没有类型。
  const ghShapeComments = comments.map((c) => ({ body: c.body, createdAt: '2026-11-04T00:00:00Z', author: { login: c.user.login.replace(/\[bot\]$/, '') } }));
  const prView = { number: 179, state: 'OPEN', mergedAt: null, author: { login: 'someone' }, url: 'https://github.com/o/r/pull/179',
    comments: ghShapeComments, labels: labels.map((name) => ({ name })), headRefOid: HEAD_SHA };
  const restComments = comments.map((c) => ({ body: c.body, created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z', html_url: 'https://github.com/o/r/pull/179#c', user: c.user }));
  const fake = writeFakeGh(directory, { userFails, prView, restComments });
  const rulesFile = join(directory, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ maintainerAllowlist: [], signoffGate: { label: 'awaiting-discussion' } }));
  const payloadFile = join(directory, 'payload.json');
  writeFileSync(payloadFile, JSON.stringify(payload));
  const stateRoot = join(directory, 'state');
  if (lock) {
    // lib.mjs 的状态目录 = REVIEW_PR_STATE_DIR/<git common dir 的 sha256 前 20 位>
    const key = createHash('sha256').update(resolve(repoRoot, '.git')).digest('hex').slice(0, 20);
    mkdirSync(join(stateRoot, key), { recursive: true });
    writeFileSync(join(stateRoot, key, 'lock.json'), JSON.stringify({ token: 'fixture-lock' }));
  }
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(REVIEW_PR_|GH_|GITHUB_|HOLD_)/.test(key)));
  const child = spawnSync(process.execPath, [here(script), '179', ...scriptArgs.map((a) => (a === '@payload' ? payloadFile : a))], {
    cwd: repoRoot, encoding: 'utf8',
    env: { ...clean, PATH: `${fake.bin}:${process.env.PATH}`, REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_STATE_DIR: stateRoot,
      REVIEW_PR_RULES_FILE: rulesFile, REVIEW_PR_NO_CRED_FALLBACK: '1', ...env },
  });
  const calls = existsSync(fake.log) ? readFileSync(fake.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  let out = null;
  try { out = JSON.parse(child.stdout); } catch { /* 留给断言报错 */ }
  return { child, out, calls };
}

const isUserRead = (args) => args[0] === 'api' && args[1] === 'user';
const holdArgs = ['--kind', 'product', '--payload-file', '@payload'];
const releaseArgs = ['--labels-only', '--lock-token', 'fixture-lock'];
const created = (calls) => calls.filter((args) => args[0] === 'issue' && args[1] === 'create');
const labelWrites = (calls) => calls.filter((args) => args[0] === 'api' && args.some((a) => /\/labels/.test(a)) && args.some((a) => ['DELETE', 'POST'].includes(a)));

// 1. 身份读不到必须中止
test('signoff-hold:读不到审查身份(/user 403,没配 REVIEW_PR_VIEWER_LOGIN)时中止,此后不再有任何 gh 调用', () => {
  const { child, calls } = runSignoff('signoff-hold.mjs', holdArgs, { userFails: true });
  assert.notEqual(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout + child.stderr, /REVIEW_IDENTITY_UNAVAILABLE/);
  const at = calls.findIndex(isUserRead);
  assert.ok(at >= 0, '应当尝试过读 /user');
  assert.deepEqual(calls.slice(at + 1), [], '读不到身份后不能再有任何 gh 调用(尤其是写)');
});

test('signoff-release --labels-only:读不到审查身份时中止,不摘任何标签', () => {
  const { child, calls } = runSignoff('signoff-release.mjs', releaseArgs, { userFails: true, lock: true, labels: ['awaiting-discussion'] });
  assert.notEqual(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout + child.stderr, /REVIEW_IDENTITY_UNAVAILABLE/);
  assert.deepEqual(labelWrites(calls), []);
  const at = calls.findIndex(isUserRead);
  assert.deepEqual(calls.slice(at + 1), []);
});

test('对照:同一夹具在身份已知时,signoff-release --labels-only 会走到摘标签(证明上一条不是空转)', () => {
  const { child, calls } = runSignoff('signoff-release.mjs', releaseArgs, { env: { REVIEW_PR_VIEWER_LOGIN: 'PraiseZhu' }, lock: true, labels: ['awaiting-discussion'] });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(labelWrites(calls).length >= 1, true, JSON.stringify(calls));
});

// 2. bot 自己写的 hold 标记要被认出来(gh pr view 的评论作者没有类型,必须走 REST)
const botEnv = { REVIEW_PR_VIEWER_LOGIN: 'praisebuild[bot]', REVIEW_PR_VIEWER_ALIASES: '["PraiseZhu"]' };
const botMarker = [{ body: holdMarkerBody, user: { login: 'praisebuild[bot]', type: 'Bot' } }];

test('signoff-hold:praisebuild[bot] 写的 hold 标记被认出,复用旧讨论 issue,不重复新开', () => {
  const { child, calls } = runSignoff('signoff-hold.mjs', holdArgs, { env: botEnv, comments: botMarker });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.deepEqual(created(calls), [], '已有 bot 写的标记,不应再开新 issue');
  assert.equal(calls.some((args) => args[0] === 'issue' && args[1] === 'view' && args[2] === '7'), true, '应当去查旧 issue #7 的状态');
});

test('signoff-release --labels-only --close-issue:按 praisebuild[bot] 写的 hold 标记找到讨论 issue', () => {
  const { child, out } = runSignoff('signoff-release.mjs', [...releaseArgs, '--close-issue'], { env: botEnv, comments: botMarker, lock: true, labels: ['awaiting-discussion'] });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(out.issueNumber, 7, JSON.stringify(out));
  assert.notEqual(out.issueCloseSkipped, 'no-issue-url');
});

test('同名普通用户 praisebuild(类型 User)写的 hold 标记不被信任:照常新开确认 issue', () => {
  const impostor = [{ body: holdMarkerBody, user: { login: 'praisebuild', type: 'User' } }];
  const { child, calls } = runSignoff('signoff-hold.mjs', holdArgs, { env: botEnv, comments: impostor });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(created(calls).length, 1, JSON.stringify(calls));
});
