// identity-env 补丁(REVIEW_PR_VIEWER_LOGIN / REVIEW_PR_IDENTITY_TOKEN / REVIEW_PR_NO_CRED_FALLBACK)的回归测试:
// 纯函数、注入 ghFn 的单元,以及真实 gh() 进程边界(PATH 上放假 gh,记录每次调用拿到的 GH_TOKEN)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = new URL('../../review-pr/scripts/lib.mjs', import.meta.url).href;
const { viewerLoginOverride, identityTokenOptions, probeGhAuth, probeBranchProtection } = await import(LIB);

const FAKE_INT = 'fixture-int';
const FAKE_ID = 'fixture-id';

// ── helpers ──
const PROTECTION_FIXTURE = {
  'repos/o/r/rules/branches/main': [{
    type: 'required_status_checks', ruleset_id: 9,
    parameters: { required_status_checks: [{ context: 'unit' }], strict_required_status_checks_policy: false },
  }],
  'repos/o/r/branches/main/protection': {},
  'repos/o/r/branches/main/protection/required_signatures': { enabled: false },
  'repos/o/r/rulesets/9': { current_user_can_bypass: 'always' },
};

function fakeGhFn(calls) {
  return (args, opts) => {
    calls.push({ endpoint: args[1], opts });
    const body = PROTECTION_FIXTURE[args[1]];
    return body === undefined ? { ok: false, stdout: '', stderr: 'HTTP 404: Not Found', status: 1 }
      : { ok: true, stdout: JSON.stringify(body), stderr: '', status: 0 };
  };
}

function baseEnv(extra = {}) {
  const env = { ...process.env, GH_TOKEN: FAKE_INT, GITHUB_TOKEN: FAKE_INT };
  delete env.REVIEW_PR_VIEWER_LOGIN;
  delete env.REVIEW_PR_IDENTITY_TOKEN;
  delete env.REVIEW_PR_NO_CRED_FALLBACK;
  return { ...env, ...extra };
}

// 临时 git 仓 + 假 gh:每次调用把 { args, seen } 追加到日志,按 handler 脚本返回
function processFixture(handlerSource) {
  const dir = mkdtempSync(join(tmpdir(), 'identity-env-'));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const log = join(dir, 'gh-calls.jsonl');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, seen: process.env.GH_TOKEN ?? null }) + '\\n');
${handlerSource}
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const env = (extra = {}) => baseEnv({ PATH: `${bin}:${process.env.PATH}`, REVIEW_PR_REPO_ROOT: repo, REVIEW_PR_STATE_DIR: join(dir, 'state'), ...extra });
  return { dir, repo, calls, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runModule(fx, code, env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import * as lib from ${JSON.stringify(LIB)};\n${code}`],
    { cwd: fx.repo, env, encoding: 'utf8' });
}

// ── viewerLoginOverride ──
test('viewerLoginOverride:未设、空、空白按没设处理;去空白;格式错误抛错', () => {
  assert.equal(viewerLoginOverride({}), '');
  assert.equal(viewerLoginOverride({ REVIEW_PR_VIEWER_LOGIN: '' }), '');
  assert.equal(viewerLoginOverride({ REVIEW_PR_VIEWER_LOGIN: '   ' }), '');
  assert.equal(viewerLoginOverride({ REVIEW_PR_VIEWER_LOGIN: ' PraiseZhu ' }), 'PraiseZhu');
  for (const bad of ['bad login!', '-x', 'a'.repeat(40)]) {
    assert.throws(() => viewerLoginOverride({ REVIEW_PR_VIEWER_LOGIN: bad }), /REVIEW_PR_VIEWER_LOGIN/, bad);
  }
});

// ── identityTokenOptions ──
test('identityTokenOptions:没设返回 {};设了替换 GH_TOKEN、关掉换凭证重试、不改入参', () => {
  assert.deepEqual(identityTokenOptions({}), {});
  assert.deepEqual(identityTokenOptions({ REVIEW_PR_IDENTITY_TOKEN: '  ' }), {});
  const env = { GH_TOKEN: FAKE_INT, GITHUB_TOKEN: FAKE_INT, REVIEW_PR_IDENTITY_TOKEN: FAKE_ID };
  const snapshot = { ...env };
  const opts = identityTokenOptions(env);
  assert.equal(opts.env.GH_TOKEN, FAKE_ID);
  assert.equal(opts.env.GITHUB_TOKEN, FAKE_INT);
  assert.equal(opts.noCredFallback, true);
  assert.deepEqual(env, snapshot);
});

// ── probeBranchProtection(注入 ghFn) ──
test('probeBranchProtection:设了身份令牌时只有 protection / required_signatures / rulesets 三类用它', () => {
  const calls = [];
  const env = { GH_TOKEN: FAKE_INT, REVIEW_PR_IDENTITY_TOKEN: FAKE_ID };
  const result = probeBranchProtection('o/r', 'main', { ghFn: fakeGhFn(calls), env });
  assert.equal(result.canBypass, 'always');
  const byEndpoint = Object.fromEntries(calls.map((c) => [c.endpoint, c.opts]));
  assert.deepEqual(byEndpoint['repos/o/r/rules/branches/main'], { allowFail: true });
  for (const endpoint of ['repos/o/r/branches/main/protection', 'repos/o/r/branches/main/protection/required_signatures', 'repos/o/r/rulesets/9']) {
    assert.equal(byEndpoint[endpoint].env.GH_TOKEN, FAKE_ID, endpoint);
    assert.equal(byEndpoint[endpoint].noCredFallback, true, endpoint);
  }
  assert.equal(calls.length, 4);
});

test('probeBranchProtection:没设身份令牌时每次调用的选项都与改动前相同', () => {
  const calls = [];
  const result = probeBranchProtection('o/r', 'main', { ghFn: fakeGhFn(calls), env: { GH_TOKEN: FAKE_INT } });
  assert.equal(result.canBypass, 'always');
  assert.equal(calls.length, 4);
  for (const c of calls) assert.deepEqual(c.opts, { allowFail: true }, c.endpoint);
});

// ── 真实 gh() 进程边界 ──
const PROTECTION_HANDLER = `
const fixtures = ${JSON.stringify(PROTECTION_FIXTURE)};
const body = fixtures[args[1]];
if (body === undefined) { process.stderr.write('HTTP 404: Not Found'); process.exit(1); }
process.stdout.write(JSON.stringify(body));
`;
const PROBE_CODE = `process.stdout.write(JSON.stringify(lib.probeBranchProtection('o/r', 'main').canBypass));`;

test('真实 gh 进程:设了身份令牌,rules 调用仍拿 GH_TOKEN,其余三类拿身份令牌', () => {
  const fx = processFixture(PROTECTION_HANDLER);
  try {
    const r = runModule(fx, PROBE_CODE, fx.env({ REVIEW_PR_IDENTITY_TOKEN: FAKE_ID }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '"always"');
    const seen = Object.fromEntries(fx.calls().map((c) => [c.args[1], c.seen]));
    assert.equal(seen['repos/o/r/rules/branches/main'], FAKE_INT);
    assert.equal(seen['repos/o/r/branches/main/protection'], FAKE_ID);
    assert.equal(seen['repos/o/r/branches/main/protection/required_signatures'], FAKE_ID);
    assert.equal(seen['repos/o/r/rulesets/9'], FAKE_ID);
  } finally { fx.cleanup(); }
});

test('真实 gh 进程:没设身份令牌,四类调用全用 GH_TOKEN', () => {
  const fx = processFixture(PROTECTION_HANDLER);
  try {
    const r = runModule(fx, PROBE_CODE, fx.env());
    assert.equal(r.status, 0, r.stderr);
    const calls = fx.calls();
    assert.equal(calls.length, 4);
    for (const c of calls) assert.equal(c.seen, FAKE_INT, c.args[1]);
  } finally { fx.cleanup(); }
});

// ── REVIEW_PR_NO_CRED_FALLBACK ──
const FORBIDDEN_HANDLER = `process.stderr.write('HTTP 403: Resource not accessible by integration'); process.exit(1);`;
const GH_CODE = `try { lib.gh(['api', 'repos/o/r/branches/main/protection']); } catch (e) { process.stdout.write(e.message); }`;

test('REVIEW_PR_NO_CRED_FALLBACK=1:遇 Resource not accessible by integration 不摘令牌重试,直接报错', () => {
  const fx = processFixture(FORBIDDEN_HANDLER);
  try {
    const r = runModule(fx, GH_CODE, fx.env({ REVIEW_PR_NO_CRED_FALLBACK: '1' }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fx.calls().length, 1);
    assert.match(r.stdout, /Resource not accessible by integration/);
    assert.doesNotMatch(r.stdout, /\[cred-fallback\]/);
  } finally { fx.cleanup(); }
});

test('没设 REVIEW_PR_NO_CRED_FALLBACK:仍摘令牌重试一次(默认行为不变)', () => {
  const fx = processFixture(FORBIDDEN_HANDLER);
  try {
    const r = runModule(fx, GH_CODE, fx.env());
    assert.equal(r.status, 0, r.stderr);
    const calls = fx.calls();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].seen, FAKE_INT);
    assert.equal(calls[1].seen, null);
    assert.match(r.stdout, /\[cred-fallback\]/);
  } finally { fx.cleanup(); }
});

test('身份令牌调用 403:不换凭证重试(即使没设 REVIEW_PR_NO_CRED_FALLBACK)', () => {
  // rules 调用成功,branches/*/protection(身份调用)403
  const fx = processFixture(`
if (args[1] === 'repos/o/r/rules/branches/main') { process.stdout.write('[]'); process.exit(0); }
process.stderr.write('HTTP 403: Resource not accessible by integration'); process.exit(1);`);
  try {
    const r = runModule(fx, `process.stdout.write(JSON.stringify(lib.probeBranchProtection('o/r', 'main')));`, fx.env({ REVIEW_PR_IDENTITY_TOKEN: FAKE_ID }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'null');
    const calls = fx.calls();
    assert.deepEqual(calls.map((c) => c.seen), [FAKE_INT, FAKE_ID]);
  } finally { fx.cleanup(); }
});

// ── probeGhAuth ──
test('probeGhAuth:没设 REVIEW_PR_VIEWER_LOGIN 只调 gh auth status', () => {
  const calls = [];
  const ghFn = (args, opts) => { calls.push({ args, opts }); return { ok: true, stdout: '', stderr: '' }; };
  assert.deepEqual(probeGhAuth({ owner: 'o', repo: 'r' }, { ghFn, env: {} }), { ok: true, via: 'auth-status' });
  assert.deepEqual(calls, [{ args: ['auth', 'status'], opts: { allowFail: true } }]);
});

test('probeGhAuth:设了 REVIEW_PR_VIEWER_LOGIN 改读仓库,不调 auth;full_name 大小写不敏感', () => {
  const env = { REVIEW_PR_VIEWER_LOGIN: 'PraiseZhu' };
  const calls = [];
  const okGh = (args) => { calls.push(args); return { ok: true, stdout: JSON.stringify({ full_name: 'O/R' }), stderr: '' }; };
  assert.deepEqual(probeGhAuth({ owner: 'o', repo: 'r' }, { ghFn: okGh, env }), { ok: true, via: 'repo-read' });
  assert.deepEqual(calls, [['api', '--method', 'GET', 'repos/o/r']]);

  const wrong = probeGhAuth({ owner: 'o', repo: 'r' }, { env, ghFn: () => ({ ok: true, stdout: JSON.stringify({ full_name: 'x/y' }), stderr: '' }) });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /full_name/);

  const failed = probeGhAuth({ owner: 'o', repo: 'r' }, { env, ghFn: () => ({ ok: false, stdout: '', stderr: 'HTTP 403: nope\nsecond line' }) });
  assert.deepEqual(failed, { ok: false, via: 'repo-read', error: 'HTTP 403: nope' });
});
