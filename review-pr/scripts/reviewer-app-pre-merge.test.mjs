// [MIVO-PATCH reviewer-app] pre-merge-check 对 Bot 作者的判断:三种写法归一,不当维护者、不获豁免;作者是人时不变。离线 mock gh。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fetchMaintainerAuthority } from './lib.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

function fixtureGh(args, options, fixture) {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const ok = (value) => ({ status: 0, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const endpoint = args.find((arg) => typeof arg === 'string' && /^(?:repos|orgs)\//.test(arg));
  if (args[0] === 'pr' && args[1] === 'view') return ok({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
    headRefOid: head, baseRefName: 'main', baseRefOid: base, labels: [], files: [] });
  if (args[0] === 'api' && args[1] === 'user') throw new Error('不应调用 gh api user');
  if (args[0] === 'api' && args[1] === 'graphql') {
    const query = JSON.parse(options?.input ?? '{}').query ?? '';
    if (/defaultBranchRef\{name\}/.test(query)) return ok({ data: { repository: { defaultBranchRef: { name: 'main' } } } });
    if (/viewer\s*\{/.test(query)) fixture.queriedViewer = true;
    if (/author\{ login __typename \}/.test(query)) {
      return ok({ data: { ...(/viewer\s*\{/.test(query) ? { viewer: { login: 'maintainer' } } : {}),
        repository: { pullRequest: { author: fixture.author, commits: { nodes: [{ commit: { committedDate: '2026-11-04T00:00:00Z' } }] } } } } });
    }
    if (/reviewThreads/.test(query)) return ok({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    return ok({ data: { repository: { pullRequest: {} } } });
  }
  if (endpoint === 'repos/o/r/commits/main') return ok({ sha: base });
  if (endpoint === 'repos/o/r/collaborators/maintainer/permission') return ok({ permission: 'admin', role_name: 'admin' });
  if (endpoint === 'repos/o/r/pulls/1/reviews') return ok([fixture.reviews ?? []]);
  return ok([[]]);
}

function runPreMerge(author, reviews = []) {
  const directory = mkdtempSync(join(tmpdir(), 'reviewer-app-premerge-'));
  try {
    const repoRoot = join(directory, 'repo');
    mkdirSync(repoRoot);
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
      assert.equal(spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).status, 0);
    }
    const rulesFile = join(directory, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ maintainerSource: 'allowlist', maintainerAllowlist: ['maintainer'], reviewerApps: ['praisebuild[bot]'] }));
    const fixtureFile = join(directory, 'fixture.json');
    writeFileSync(fixtureFile, JSON.stringify({ author, reviews }));
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
      REVIEW_PR_VIEWER_LOGIN: 'maintainer', REVIEW_PR_VIEWER_ALIASES: '', REVIEW_PR_STATE_DIR: join(directory, 'state') };
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('pre-merge-check.mjs', import.meta.url)), '1',
      '--expected-head', head, '--expected-base', base, '--expected-base-ref', 'main', '--expected-authority-digest', authority.digest],
    { cwd: repoRoot, env, encoding: 'utf8' });
    const out = JSON.parse(child.stdout);
    return { out, stderr: child.stderr, fixture: JSON.parse(readFileSync(fixtureFile, 'utf8')) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('Bot 作者三种写法(app/x 经 gh 裸 login 无类型不适用;GraphQL 带 __typename、login[bot]):作者归一、不是维护者、不获豁免', () => {
  const forms = [{ login: 'praisebuild', __typename: 'Bot' }, { login: 'praisebuild[bot]', __typename: 'Bot' }, { login: 'praisebuild[bot]' }];
  const policies = forms.map((author) => runPreMerge(author).out.approvalPolicy);
  for (const policy of policies) {
    assert.equal(policy.author, 'praisebuild[bot]');
    assert.equal(policy.authorIsMaintainer, false);
    assert.equal(policy.approvalRequired, true);
    assert.equal(policy.viewerIsMaintainer, true);
    assert.equal(policy.viewerIsAuthor, false);
  }
  assert.deepEqual(policies[0], policies[1]);
  assert.deepEqual(policies[1], policies[2]);
});

test('设了 REVIEW_PR_VIEWER_LOGIN 时 META 查询不带 viewer;作者是人时结果不变', () => {
  const human = runPreMerge({ login: 'outsider', __typename: 'User' });
  assert.equal(human.fixture.queriedViewer, undefined);
  assert.equal(human.out.approvalPolicy.author, 'outsider');
  assert.equal(human.out.approvalPolicy.authorIsMaintainer, false);
  const maintainer = runPreMerge({ login: 'maintainer', __typename: 'User' });
  assert.equal(maintainer.out.approvalPolicy.authorIsMaintainer, true);
  assert.equal(maintainer.out.approvalPolicy.approvalRequired, false);
});

test('无类型的裸 login 不会被猜成 Bot:同名普通用户 praisebuild 仍是普通作者', () => {
  const user = runPreMerge({ login: 'praisebuild' }).out.approvalPolicy;
  assert.equal(user.author, 'praisebuild');
  assert.equal(user.approvalRequired, true);
});

test('Bot 的 Approve 不进维护者确认:即使 login 在维护者名单里', () => {
  const approve = (type) => [{ id: 3, state: 'APPROVED', commit_id: head, user: { login: 'maintainer', type }, submitted_at: '2026-11-04T01:00:00Z' }];
  const bot = runPreMerge({ login: 'outsider', __typename: 'User' }, approve('Bot')).out;
  const human = runPreMerge({ login: 'outsider', __typename: 'User' }, approve('User')).out;
  const released = (out) => JSON.stringify(out).includes('"github-approve"');
  assert.equal(released(human), true, '真人维护者的 Approve 应被识别');
  assert.equal(released(bot), false, 'Bot 的 Approve 不得被识别为维护者确认');
});
