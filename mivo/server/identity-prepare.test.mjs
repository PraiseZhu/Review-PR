// identity-env 补丁:prepare.mjs 的 gh 登录检查在 integration 令牌(无 /user)下不误报,没设变量时与改动前一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREPARE = fileURLToPath(new URL('../../review-pr/scripts/prepare.mjs', import.meta.url));
const SHA = 'a'.repeat(40);

// auth status 一律失败(模拟 integration 令牌);repos/o/r 是否可读由 REPO_STATUS 控制
const HANDLER = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + '\\n');
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const fail = (m) => { process.stderr.write(m); process.exit(1); };
const endpoint = args.find((a) => a.startsWith('repos/')) ?? '';
if (args[0] === 'auth') {
  if (process.env.AUTH_STATUS === 'ok') { process.stdout.write('ok'); process.exit(0); }
  fail('You are not logged into any GitHub hosts');
}
if (endpoint === 'repos/o/r') {
  if (process.env.REPO_STATUS === 'forbidden') fail('HTTP 403: Resource not accessible by integration');
  out({ default_branch: 'main', full_name: 'o/r' });
}
if (endpoint === 'repos/o/r/commits/main') out({ sha: '${SHA}' });
if (endpoint === 'repos/o/r/collaborators/maintainer/permission') out({ permission: 'admin', role_name: 'admin' });
fail('Unexpected gh operation: ' + JSON.stringify(args));
`;

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'identity-prepare-'));
  try {
    const repo = join(dir, 'repo');
    const bin = join(dir, 'bin');
    mkdirSync(repo);
    mkdirSync(bin);
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    }
    const commit = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'init'],
      { cwd: repo, encoding: 'utf8' });
    assert.equal(commit.status, 0, commit.stderr);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\n${HANDLER}`);
    chmodSync(join(bin, 'gh'), 0o755);
    const rules = join(dir, 'rules.json');
    writeFileSync(rules, JSON.stringify({ maintainerSource: 'allowlist', maintainerAllowlist: ['maintainer'] }));
    const calls = join(dir, 'gh-calls.jsonl');
    let n = 0;
    const run = (extraEnv = {}) => {
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REVIEW_PR_REPO_ROOT: repo, REVIEW_PR_RULES_FILE: rules,
        REVIEW_PR_STATE_DIR: join(dir, `state-${n++}`), GH_CALLS: calls, ...extraEnv };
      for (const key of ['REVIEW_PR_VIEWER_LOGIN', 'REVIEW_PR_IDENTITY_TOKEN', 'REVIEW_PR_NO_CRED_FALLBACK']) {
        if (!(key in extraEnv)) delete env[key];
      }
      if (existsSync(calls)) rmSync(calls);
      const r = spawnSync(process.execPath, [PREPARE, '--skip-skill-pull'], { cwd: repo, env, encoding: 'utf8' });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* 留给断言看 stdout */ }
      const seen = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, calls: seen };
    };
    return fn(run);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const NOT_LOGGED_IN = 'gh 未登录，无法读取 CODEOWNERS 维护者 Team 与补充白名单';

test('没设 REVIEW_PR_VIEWER_LOGIN:gh auth status 失败照旧报「gh 未登录」', () => withFixture((run) => {
  const r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, NOT_LOGGED_IN);
  assert.ok(r.calls.some((a) => a[0] === 'auth' && a[1] === 'status'));
}));

test('没设 REVIEW_PR_VIEWER_LOGIN:gh auth status 成功照旧通过,输出没有 ghAuthVia', () => withFixture((run) => {
  const r = run({ AUTH_STATUS: 'ok' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.ghAuth, true);
  assert.ok(!('ghAuthVia' in r.json));
  assert.equal(r.json.maintainerAuthority.verified, true);
}));

test('设了 REVIEW_PR_VIEWER_LOGIN:不调 gh auth status,改读仓库,integration 令牌下不误报', () => withFixture((run) => {
  const r = run({ REVIEW_PR_VIEWER_LOGIN: 'maintainer' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.ghAuth, true);
  assert.equal(r.json.ghAuthVia, 'repo-read');
  assert.equal(r.json.maintainerAuthority.verified, true);
  assert.ok(!r.calls.some((a) => a[0] === 'auth'));
}));

test('设了 REVIEW_PR_VIEWER_LOGIN 但读不了仓库:报可诊断的错误', () => withFixture((run) => {
  const r = run({ REVIEW_PR_VIEWER_LOGIN: 'maintainer', REPO_STATUS: 'forbidden' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /GH_TOKEN 读不了仓库 o\/r/);
  assert.match(r.json.error, /Resource not accessible by integration/);
}));

test('REVIEW_PR_VIEWER_LOGIN 格式不对:prepare 直接报错', () => withFixture((run) => {
  const r = run({ REVIEW_PR_VIEWER_LOGIN: 'bad login!' });
  assert.equal(r.status, 1);
  assert.match(r.json.error, /REVIEW_PR_VIEWER_LOGIN/);
}));
