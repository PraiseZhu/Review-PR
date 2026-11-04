// [MIVO-PATCH reviewer-app] Approve CLI 在审查 App 身份下的行为。全部是 mock gh 的离线夹具,没有任何 GitHub 写入。
// 与 approval-cli.test.mjs 同一套 mock 做法:NODE_OPTIONS --import 劫持 child_process.spawnSync。
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
const APP = 'praisebuild[bot]';

function fixtureGh(args, options, fixture) {
  const ok = (value) => ({ status: 0, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const endpoint = args.find((arg) => typeof arg === 'string' && /^(?:repos|orgs)\//.test(arg));
  if (args[0] === 'pr' && args[1] === 'view') return ok(fixture.meta);
  if (args[0] === 'api' && args[1] === 'user') throw new Error('审查 App 身份下不应调用 gh api user');
  if (args[0] === 'api' && args[1] === 'graphql' && /defaultBranchRef\{name\}/.test(JSON.parse(options?.input ?? '{}').query ?? '')) {
    return ok({ data: { repository: { defaultBranchRef: { name: 'main' } } } });
  }
  if (endpoint === 'repos/o/r/commits/main') return ok({ sha: fixture.base });
  if (endpoint === 'repos/o/r/contents/.github/CODEOWNERS') return ok({ type: 'file', encoding: 'base64', sha: 'blob',
    content: Buffer.from('* @o/maintainers\n').toString('base64') });
  if (endpoint === 'orgs/o/teams/maintainers') return ok({ privacy: 'closed' });
  if (endpoint === 'orgs/o/teams/maintainers/repos/o/r') return ok({ permissions: { push: true } });
  if (endpoint === 'orgs/o/teams/maintainers/members') return ok([[{ login: 'maintainer' }]]);
  if (args[0] === 'api' && args[1] === 'graphql') return ok({ data: { repository: { pullRequest: {
    reviewThreads: { nodes: fixture.threads || [], pageInfo: { hasNextPage: false, endCursor: null } },
  } } } });
  if (endpoint === 'repos/o/r/pulls/1/reviews' && args.includes('GET')) {
    return ok([fixture.reviews.slice(0, 1), fixture.reviews.slice(1)]);
  }
  if (endpoint === 'repos/o/r/pulls/1/reviews' && args.includes('POST')) {
    fixture.posts++;
    fixture.postBodies = [...(fixture.postBodies || []), JSON.parse(options?.input ?? '{}')];
    fixture.reviews.push(fixture.newReview);
    return ok(fixture.newReview);
  }
  throw new Error(`unexpected fixture command: ${args.join(' ')}`);
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'reviewer-app-cli-'));
  const repoRoot = join(directory, 'repo');
  mkdirSync(repoRoot);
  for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
    const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  const fixtureFile = join(directory, 'fixture.json');
  const mockFile = join(directory, 'mock.mjs');
  writeFileSync(mockFile, `import { readFileSync, writeFileSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const fixtureGh = ${fixtureGh.toString()};
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command !== 'gh') return original(command, args, options);
  const fixture = JSON.parse(readFileSync(process.env.APPROVAL_FIXTURE, 'utf8'));
  const result = fixtureGh(args, options, fixture);
  writeFileSync(process.env.APPROVAL_FIXTURE, JSON.stringify(fixture));
  return result;
};
syncBuiltinESMExports();
`);
  const basic = (overrides = {}) => ({ head, base, posts: 0, reviews: [],
    meta: { state: 'OPEN', isDraft: false, author: { login: 'author' }, headRefOid: head, baseRefName: 'main', baseRefOid: base, reviewDecision: 'REVIEW_REQUIRED' },
    newReview: { id: 999, state: 'APPROVED', commit_id: head, user: { login: APP, type: 'Bot' },
      submitted_at: '2026-11-04T00:00:00Z', html_url: 'https://github.com/o/r/pull/1#pullrequestreview-999' },
    ...overrides });
  const authority = fetchMaintainerAuthority({ owner: 'o', repo: 'r', maintainerAllowlist: [], maintainerSource: 'codeowners',
    ghFn: (args, options) => { const result = fixtureGh(args, options, basic()); return { ...result, ok: result.status === 0 }; } });
  let index = 0;
  const scenario = ({ reviewerApps, aliases, viewer = APP, fixture }) => {
    const rulesFile = join(directory, `rules-${index}.json`);
    writeFileSync(rulesFile, JSON.stringify({ maintainerAllowlist: [], ...(reviewerApps ? { reviewerApps } : {}) }));
    const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFile).href}`].filter(Boolean).join(' '),
      REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_RULES_FILE: rulesFile, APPROVAL_FIXTURE: fixtureFile, REVIEW_PR_NO_CRED_FALLBACK: '1',
      REVIEW_PR_VIEWER_LOGIN: viewer, ...(aliases ? { REVIEW_PR_VIEWER_ALIASES: JSON.stringify(aliases) } : { REVIEW_PR_VIEWER_ALIASES: '' }),
      GH_TOKEN: 'ghs_SENTINEL_TOKEN_DO_NOT_LEAK', REVIEW_PR_STATE_DIR: join(directory, `state-${index++}`) };
    writeFileSync(fixtureFile, JSON.stringify(fixture));
    const prep = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {stateFile} from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)}; import {writeFileSync} from 'node:fs'; writeFileSync(stateFile('lock.json'), JSON.stringify({token:'fixture-lock'}));`],
    { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
    assert.equal(prep.status, 0, prep.stderr);
    const run = (extra = []) => {
      const child = spawnSync(process.execPath, [fileURLToPath(new URL('approve-reviewed-pr.mjs', import.meta.url)), '1',
        '--review-clean', '--lock-token', 'fixture-lock', '--expected-head', head, '--expected-base', base,
        '--expected-base-ref', 'main', '--expected-authority-digest', authority.digest, ...extra],
      { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
      assert.ok([0, 1, 2].includes(child.status), child.stdout + child.stderr);
      assert.equal((child.stdout + child.stderr).includes('ghs_SENTINEL_TOKEN_DO_NOT_LEAK'), false, '令牌不得出现在输出里');
      return { ...JSON.parse(child.stdout), exit: child.status };
    };
    return run;
  };
  const readFixture = () => JSON.parse(readFileSync(fixtureFile, 'utf8'));
  return { basic, scenario, readFixture, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('没配 reviewerApps:bot viewer 仍按旧行为被拒,没有任何 POST(回归)', () => {
  const t = setup();
  try {
    const result = t.scenario({ fixture: t.basic() })();
    assert.equal(result.exit, 2);
    assert.equal(result.approval.code, 'bot-identity-forbidden');
    assert.equal(t.readFixture().posts, 0);
  } finally { t.cleanup(); }
});

test('已配置的审查 App、非作者:提交 Approve 并取得真实回执;policy 里它不是维护者', () => {
  const t = setup();
  try {
    const result = t.scenario({ reviewerApps: [APP], fixture: t.basic() })();
    assert.equal(result.exit, 0, JSON.stringify(result));
    assert.equal(result.approval.status, 'verified');
    assert.equal(result.approval.reviewId, '999');
    assert.equal(result.approval.reviewer, APP);
    assert.equal(result.approvalPolicy.viewerIsReviewerApp, true);
    assert.equal(result.approvalPolicy.viewerIsMaintainer, false);
    assert.equal(result.approvalPolicy.viewerCanApprove, true);
    assert.equal(result.approvalPolicy.approvalRequired, true);
    const fixture = t.readFixture();
    assert.equal(fixture.posts, 1);
    assert.equal(fixture.postBodies[0].event, 'APPROVE');
    assert.equal(fixture.postBodies[0].commit_id, head);
    // 回执里没有任何维护者才有的放行字段。
    assert.equal(result.approval.source, undefined);
  } finally { t.cleanup(); }
});

test('作者是维护者(PraiseZhu 类)、没配别名:App 仍提交 Approve,不走 exempt', () => {
  const t = setup();
  try {
    const fixture = t.basic();
    fixture.meta.author = { login: 'maintainer' };
    const result = t.scenario({ reviewerApps: [APP], fixture })();
    assert.equal(result.exit, 0, JSON.stringify(result));
    assert.equal(result.approval.status, 'verified');
    assert.notEqual(result.approval.status, 'exempt');
    assert.equal(t.readFixture().posts, 1);
  } finally { t.cleanup(); }
});

test('作者在审查身份集合内(别名含作者):App 不提交 Approve,按维护者作者免批准处理(服务器据此发 COMMENT)', () => {
  const t = setup();
  try {
    const fixture = t.basic();
    fixture.meta.author = { login: 'maintainer' };
    const result = t.scenario({ reviewerApps: [APP], aliases: ['maintainer'], fixture })();
    assert.equal(result.exit, 0, JSON.stringify(result));
    assert.equal(result.approval.status, 'exempt');
    assert.equal(result.approved, false);
    assert.equal(result.approvalPolicy.viewerIsAuthor, true);
    assert.equal(result.approvalPolicy.viewerCanApprove, false);
    assert.equal(t.readFixture().posts, 0);
  } finally { t.cleanup(); }
});

test('作者就是审查 App 本身(app/<slug>、__typename Bot 两种写法):不能自批,POST 为 0', () => {
  for (const author of [{ login: 'app/praisebuild' }, { login: 'praisebuild', __typename: 'Bot' }, { login: APP }]) {
    const t = setup();
    try {
      const fixture = t.basic();
      fixture.meta.author = author;
      const result = t.scenario({ reviewerApps: [APP], fixture })();
      assert.equal(result.exit, 2, JSON.stringify(result));
      assert.equal(result.approval.code, 'independent-approval-required');
      assert.equal(t.readFixture().posts, 0);
    } finally { t.cleanup(); }
  }
});

test('App 身份下 head/base/thread/他人 CR 的漂移照旧拒绝,且不再报 viewer-not-maintainer', () => {
  const cases = [
    ['head-changed', (f) => { f.meta.headRefOid = 'c'.repeat(40); }],
    ['base-changed', (f) => { f.meta.baseRefOid = 'c'.repeat(40); }],
    ['threads-unresolved', (f) => { f.threads = [{ id: 'T1', isResolved: false, comments: { nodes: [] } }]; }],
    ['other-changes-requested', (f) => {
      f.reviews = [{ id: 7, state: 'CHANGES_REQUESTED', commit_id: head, user: { login: 'someone', type: 'User' }, submitted_at: '2026-11-03T00:00:00Z' }];
      f.meta.reviewDecision = 'CHANGES_REQUESTED';
    }],
  ];
  for (const [code, mutate] of cases) {
    const t = setup();
    try {
      const fixture = t.basic();
      mutate(fixture);
      const result = t.scenario({ reviewerApps: [APP], fixture })();
      assert.equal(result.exit, 2, `${code}: ${JSON.stringify(result)}`);
      const codes = result.failures.map((failure) => failure.code);
      assert.ok(codes.includes(code), `${code} 应在 ${codes.join(',')} 里`);
      assert.equal(codes.includes('viewer-not-maintainer'), false);
      assert.equal(t.readFixture().posts, 0, code);
    } finally { t.cleanup(); }
  }
});

test('同名普通用户 praisebuild 不是审查 App:仍按非维护者拒绝', () => {
  const t = setup();
  try {
    const result = t.scenario({ reviewerApps: [APP], viewer: 'praisebuild', fixture: t.basic() })();
    assert.equal(result.exit, 2);
    assert.ok(result.failures.some((failure) => failure.code === 'viewer-not-maintainer'));
    assert.equal(t.readFixture().posts, 0);
  } finally { t.cleanup(); }
});

test('身份别名同时含 PraiseZhu 类账号时,App 之外的人类维护者路径不受影响(回归)', () => {
  const t = setup();
  try {
    const fixture = t.basic();
    fixture.newReview.user = { login: 'maintainer', type: 'User' };
    fixture.meta.author = { login: 'author' };
    const result = t.scenario({ reviewerApps: [APP], viewer: 'maintainer', fixture })();
    assert.equal(result.exit, 0, JSON.stringify(result));
    assert.equal(result.approvalPolicy.viewerIsMaintainer, true);
    assert.equal(result.approvalPolicy.viewerIsReviewerApp, false);
  } finally { t.cleanup(); }
});
