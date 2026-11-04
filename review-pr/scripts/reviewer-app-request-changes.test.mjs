// [MIVO-PATCH reviewer-app] request-changes-reviewed-pr 在审查 App 身份下:能发 REQUEST_CHANGES / COMMENT,失败可诊断且不泄露令牌、不回落个人凭证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fetchMaintainerAuthority } from './lib.mjs';

const head = 'a'.repeat(40);
const APP = 'praisebuild[bot]';
const SENTINEL = 'ghs_SENTINEL_TOKEN_DO_NOT_LEAK';

function fixtureGh(args, options, fixture) {
  const head = 'a'.repeat(40);
  const ok = (value) => ({ status: 0, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const endpoint = args.find((arg) => typeof arg === 'string' && /^(?:repos|orgs)\//.test(arg));
  if (args[0] === 'pr' && args[1] === 'view') return ok({ state: 'OPEN', isDraft: false, author: { login: fixture.author }, headRefOid: fixture.headNow ?? head, baseRefName: 'main', updatedAt: '2026-11-04T00:00:00Z' });
  if (args[0] === 'api' && args[1] === 'user') throw new Error('不应调用 gh api user');
  if (args[0] === 'api' && args[1] === 'graphql') return ok({ data: { repository: { defaultBranchRef: { name: 'main' } } } });
  if (endpoint === 'repos/o/r/commits/main') return ok({ sha: 'b'.repeat(40) });
  if (endpoint === 'repos/o/r/collaborators/maintainer/permission') return ok({ permission: 'admin', role_name: 'admin' });
  if (endpoint === 'repos/o/r/pulls/1/reviews' && args.includes('GET')) return ok([[]]);
  if (endpoint === 'repos/o/r/pulls/1/reviews' && args.includes('POST')) {
    fixture.writes = [...(fixture.writes || []), { endpoint, token: options?.env?.GH_TOKEN ?? process.env.GH_TOKEN, body: JSON.parse(options?.input ?? '{}') }];
    if (fixture.postMode === 'forbidden') return { status: 1, signal: null, stdout: '', stderr: `HTTP 403: Resource not accessible by integration (token ${process.env.GH_TOKEN})` };
    return ok({ id: 77, html_url: 'https://github.com/o/r/pull/1#pullrequestreview-77' });
  }
  if (endpoint === 'repos/o/r/pulls/1/reviews/77/comments') return ok([[{ html_url: 'https://github.com/o/r/pull/1#discussion_r1' }]]);
  throw new Error(`unexpected fixture command: ${args.join(' ')}`);
}

function run(fixtureInput, { reviewerApps = [APP], aliases = '', extra = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'reviewer-app-rc-'));
  try {
    const repoRoot = join(directory, 'repo');
    mkdirSync(repoRoot);
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
      assert.equal(spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).status, 0);
    }
    const rulesFile = join(directory, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ maintainerSource: 'allowlist', maintainerAllowlist: ['maintainer'], reviewerApps }));
    const fixtureFile = join(directory, 'fixture.json');
    writeFileSync(fixtureFile, JSON.stringify(fixtureInput));
    const mockFile = join(directory, 'mock.mjs');
    writeFileSync(mockFile, `import { readFileSync, writeFileSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const fixtureGh = ${fixtureGh.toString()};
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command !== 'gh') return original(command, args, options);
  const fixture = JSON.parse(readFileSync(process.env.APPROVAL_FIXTURE, 'utf8'));
  try { return fixtureGh(args, options, fixture); } finally { writeFileSync(process.env.APPROVAL_FIXTURE, JSON.stringify(fixture)); }
};
syncBuiltinESMExports();
`);
    const authority = fetchMaintainerAuthority({ owner: 'o', repo: 'r', maintainerAllowlist: ['maintainer'], maintainerSource: 'allowlist',
      ghFn: (args, options) => { const result = fixtureGh(args, options, {}); return { ...result, ok: result.status === 0 }; } });
    const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFile).href}`].filter(Boolean).join(' '),
      REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_RULES_FILE: rulesFile, APPROVAL_FIXTURE: fixtureFile, REVIEW_PR_NO_CRED_FALLBACK: '1',
      REVIEW_PR_VIEWER_LOGIN: APP, REVIEW_PR_VIEWER_ALIASES: aliases, GH_TOKEN: SENTINEL, REVIEW_PR_STATE_DIR: join(directory, 'state') };
    const prep = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {stateFile} from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)}; import {writeFileSync} from 'node:fs'; writeFileSync(stateFile('lock.json'), JSON.stringify({token:'fixture-lock'}));`],
    { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(prep.status, 0, prep.stderr);
    const bodyFile = join(directory, 'body.md');
    writeFileSync(bodyFile, '发现 1 条 P1 问题,见 thread。');
    const commentsFile = join(directory, 'comments.json');
    writeFileSync(commentsFile, JSON.stringify([{ path: 'a.js', line: 3, side: 'RIGHT', body: '[P1] 示例问题', subject_type: 'line' }]));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('request-changes-reviewed-pr.mjs', import.meta.url)), '1',
      '--lock-token', 'fixture-lock', '--expected-head', head, '--expected-authority-digest', authority.digest,
      '--body-file', bodyFile, '--comments-file', commentsFile, ...extra], { cwd: repoRoot, env, encoding: 'utf8' });
    const text = child.stdout + child.stderr;
    assert.equal(text.includes(SENTINEL), false, '令牌不得出现在输出里');
    return { status: child.status, out: child.stdout ? JSON.parse(child.stdout) : null, writes: JSON.parse(readFileSync(fixtureFile, 'utf8')).writes ?? [] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('审查 App、非作者:提交 REQUEST_CHANGES 成功,写入用 App 令牌', () => {
  const result = run({ author: 'outsider' });
  assert.equal(result.status, 0, JSON.stringify(result.out));
  assert.equal(result.out.submitted, true);
  assert.equal(result.out.action, 'request-changes');
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].body.event, 'REQUEST_CHANGES');
  assert.equal(result.writes[0].body.commit_id, head);
  assert.equal(result.out.approvalPolicy.viewerIsReviewerApp, true);
});

test('审查 App、作者在身份集合内:不带 --comment-only 拒绝(GitHub 不允许给自己提 CR),带则发 COMMENT', () => {
  const refused = run({ author: 'maintainer' }, { aliases: JSON.stringify(['maintainer']) });
  assert.equal(refused.writes.length, 0);
  assert.ok(refused.out.failedChecks, JSON.stringify(refused.out));
  const own = run({ author: APP });
  assert.equal(own.writes.length, 0);
  assert.match(own.out.failedChecks.join(';'), /自己的 PR/);
  const commented = run({ author: APP }, { extra: ['--comment-only'] });
  assert.equal(commented.status, 0, JSON.stringify(commented.out));
  assert.equal(commented.writes[0].body.event, 'COMMENT');
});

test('未配置 reviewerApps:bot 身份仍被拒绝,没有写入(回归)', () => {
  const result = run({ author: 'outsider' }, { reviewerApps: [] });
  assert.equal(result.status, 2);
  assert.equal(result.writes.length, 0);
  assert.match(result.out.reason, /不在最终维护者集合中/);
});

test('head 漂移:拒绝且信息含期望与实际 head,没有写入', () => {
  const result = run({ author: 'outsider', headNow: 'c'.repeat(40) });
  assert.equal(result.writes.length, 0);
  assert.match(result.out.reason, new RegExp(head));
  assert.match(result.out.reason, /c{40}/);
});

test('GitHub 403:失败信息含期望与实际(HTTP 403),不含令牌,不换凭证重试', () => {
  const result = run({ author: 'outsider', postMode: 'forbidden' });
  assert.notEqual(result.status, 0);
  assert.equal(result.out.ok, false);
  assert.match(result.out.error, /403/);
  assert.match(result.out.error, /期望 GitHub 返回 2xx,实际 HTTP 403/);
  assert.equal(result.writes.length, 1, '只尝试一次,不回落到别的凭证');
});
