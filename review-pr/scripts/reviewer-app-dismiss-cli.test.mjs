// [MIVO-PATCH reviewer-app] dismiss-own-review / dismiss-stale-reviews 在审查 App 身份下的 CLI 行为。离线 mock gh,无 GitHub 写入。
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
  if (args[0] === 'pr' && args[1] === 'view') return ok({ state: 'OPEN', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED', author: { login: fixture.author }, headRefOid: fixture.headNow ?? head });
  if (args[0] === 'api' && args[1] === 'user') throw new Error('不应调用 gh api user');
  if (args[0] === 'api' && args[1] === 'graphql') {
    const query = JSON.parse(options?.input ?? '{}').query ?? '';
    if (/defaultBranchRef\{name\}/.test(query)) return ok({ data: { repository: { defaultBranchRef: { name: 'main' } } } });
    return ok({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  }
  if (endpoint === 'repos/o/r/commits/main') return ok({ sha: 'b'.repeat(40) });
  if (endpoint === 'repos/o/r/collaborators/maintainer/permission') return ok({ permission: 'admin', role_name: 'admin' });
  if (endpoint === 'repos/o/r/pulls/1/reviews' && args.includes('GET')) {
    fixture.reviewGets = (fixture.reviewGets || 0) + 1;
    const gone = fixture.dismissBeforePut && fixture.reviewGets >= 2;
    return ok([gone ? fixture.reviews.map((r) => r.id === 11 ? { ...r, state: 'DISMISSED' } : r) : fixture.reviews]);
  }
  if (endpoint === 'repos/o/r/pulls/1/reviews/11/dismissals') {
    fixture.puts = [...(fixture.puts || []), { endpoint, noCredFallback: options?.noCredFallback === true }];
    if (fixture.putMode === 'forbidden') return { status: 1, signal: null, stdout: '', stderr: `HTTP 403: Resource not accessible by integration (${process.env.GH_TOKEN})` };
    if (fixture.putMode === 'already') return { status: 1, signal: null, stdout: '', stderr: 'HTTP 422 Unprocessable Entity' };
    fixture.reviews = fixture.reviews.map((r) => r.id === 11 ? { ...r, state: 'DISMISSED' } : r);
    return ok({ id: 11, state: 'DISMISSED' });
  }
  if (endpoint === 'repos/o/r/pulls/1/reviews/11' && args.includes('GET')) {
    return ok(fixture.readDismissed ? { id: 11, state: 'DISMISSED' } : fixture.reviews.find((r) => r.id === 11));
  }
  throw new Error(`unexpected fixture command: ${args.join(' ')}`);
}

function run(script, fixtureInput, { reviewerApps = [APP], extra = [], viewer = APP } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'reviewer-app-dismiss-'));
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
      REVIEW_PR_VIEWER_LOGIN: viewer, REVIEW_PR_VIEWER_ALIASES: '', GH_TOKEN: SENTINEL, REVIEW_PR_STATE_DIR: join(directory, 'state') };
    const prep = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {stateFile} from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)}; import {writeFileSync} from 'node:fs'; writeFileSync(stateFile('lock.json'), JSON.stringify({token:'fixture-lock'}));`],
    { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(prep.status, 0, prep.stderr);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), '1', '--lock-token', 'fixture-lock',
      '--expected-head', head, '--expected-authority-digest', authority.digest, ...extra], { cwd: repoRoot, env, encoding: 'utf8' });
    const text = child.stdout + child.stderr;
    assert.equal(text.includes(SENTINEL), false, '令牌不得出现在输出里');
    return { status: child.status, out: child.stdout ? JSON.parse(child.stdout) : null, fixture: JSON.parse(readFileSync(fixtureFile, 'utf8')) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const appCr = (extra = {}) => ({ id: 11, state: 'CHANGES_REQUESTED', commit_id: head, user: { login: APP, type: 'Bot' }, submitted_at: '2026-11-03T00:00:00Z', body: '代码审查发现问题', ...extra });

test('dismiss-own-review:App 自己的 CR,作者是非维护者,重审通过后用 App 令牌 PUT dismissals 清掉', () => {
  const r = run('dismiss-own-review.mjs', { author: 'outsider', reviews: [appCr()] }, { extra: ['--review-clean'] });
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.equal(r.out.dismissed, true);
  assert.deepEqual(r.out.dismissed === true && r.out.dismissedCount, 1);
  assert.equal(r.fixture.puts.length, 1);
  assert.equal(r.fixture.puts[0].noCredFallback, true);
});

test('dismiss-own-review:403 → 非 0 退出、ok=false、错误含期望与实际、不含令牌、只试一次', () => {
  const r = run('dismiss-own-review.mjs', { author: 'outsider', reviews: [appCr()], putMode: 'forbidden' }, { extra: ['--review-clean'] });
  assert.equal(r.status, 2);
  assert.equal(r.out.ok, false);
  assert.equal(r.out.dismissed, false);
  assert.match(r.out.errors[0].error, /期望 HTTP 2xx 或 review 已是 DISMISSED,实际 HTTP 403/);
  assert.equal(r.fixture.puts.length, 1);
});

test('dismiss-own-review:422 后回读已是 DISMISSED → 幂等成功', () => {
  const reviews = [appCr()];
  const r = run('dismiss-own-review.mjs', { author: 'outsider', reviews, putMode: 'already' }, { extra: ['--review-clean'] });
  // 422 时回读到的仍是 CHANGES_REQUESTED(夹具里没改状态)→ 失败;下面一条把回读状态设成 DISMISSED。
  assert.equal(r.status, 2);
  const done = run('dismiss-own-review.mjs', { author: 'outsider', reviews: [appCr()], putMode: 'already', readDismissed: true }, { extra: ['--review-clean'] });
  assert.equal(done.status, 0, JSON.stringify(done.out));
  assert.deepEqual(done.out.alreadyDismissed, [11]);
});

test('dismiss-own-review:review 在写前已被别人撤销(完整重读为 DISMISSED)→ 不 PUT,记 alreadyDismissed', () => {
  const r = run('dismiss-own-review.mjs', { author: 'outsider', reviews: [appCr()], dismissBeforePut: true }, { extra: ['--review-clean'] });
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.deepEqual(r.out.alreadyDismissed, [11]);
  assert.equal((r.fixture.puts ?? []).length, 0);
});

test('dismiss-own-review:别名里的人工 CR / 他人 CR / 缺 --review-clean / head 漂移 → 不写', () => {
  const other = { id: 12, state: 'CHANGES_REQUESTED', commit_id: head, user: { login: 'someone', type: 'User' }, submitted_at: '2026-11-03T05:00:00Z' };
  for (const [fixture, extra] of [
    [{ author: 'outsider', reviews: [appCr(), other] }, ['--review-clean']],
    [{ author: 'outsider', reviews: [appCr()] }, []],
    [{ author: 'outsider', reviews: [appCr()], headNow: 'c'.repeat(40) }, ['--review-clean']],
  ]) {
    const r = run('dismiss-own-review.mjs', fixture, { extra });
    assert.equal(r.status, 2, JSON.stringify(r.out));
    assert.equal((r.fixture.puts ?? []).length, 0);
  }
});

test('未配置 reviewerApps:非维护者作者仍不能被 bot 清 CR(回归)', () => {
  const r = run('dismiss-own-review.mjs', { author: 'outsider', reviews: [appCr()] }, { reviewerApps: [], extra: ['--review-clean'] });
  assert.equal(r.status, 2);
  assert.equal((r.fixture.puts ?? []).length, 0);
});

const gateCr = () => appCr({ body: '<!-- review-pr:format-gate head=' + 'd'.repeat(40) + ' -->\n格式门未过' });

test('dismiss-stale-reviews:App 的旧门禁 CR 清理成功;403 时 ok=false 且非 0 退出(不假装清理完成)', () => {
  const okRun = run('dismiss-stale-reviews.mjs', { author: 'outsider', reviews: [gateCr()] }, { extra: ['--gate-clean'] });
  assert.equal(okRun.status, 0, JSON.stringify(okRun.out));
  const bad = run('dismiss-stale-reviews.mjs', { author: 'outsider', reviews: [gateCr()], putMode: 'forbidden' }, { extra: ['--gate-clean'] });
  assert.notEqual(bad.status, 0);
  assert.equal(bad.out.ok, false);
  assert.match(bad.out.errors[0].error, /实际 HTTP 403/);
});
