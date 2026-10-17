// identity-env 补丁:context.mjs 的审查账号(viewerLogin)来源与令牌分流,端到端(假 spawnSync + 假 GraphQL)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const { computeMaintainerAuthorityDigest, MAINTAINER_AUTHORITY_VERSION } = await import('../../review-pr/scripts/lib.mjs');
const CONTEXT = fileURLToPath(new URL('../../review-pr/scripts/context.mjs', import.meta.url));
const LIB_URL = new URL('../../review-pr/scripts/lib.mjs', import.meta.url).href;

const FAKE_INT = 'fixture-int';
const FAKE_ID = 'fixture-id';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const diff = 'diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -0,0 +1 @@\n+hello\n';
const PROTECTION = {
  'rules/branches/main': [{ type: 'required_status_checks', ruleset_id: 9,
    parameters: { required_status_checks: [{ context: 'unit' }], strict_required_status_checks_policy: false } }],
  'branches/main/protection': {},
  'branches/main/protection/required_signatures': { enabled: false },
  'rulesets/9': { current_user_can_bypass: 'always' },
};

function reviewFixture(login, state = 'CHANGES_REQUESTED') {
  return { id: 1, user: { login, type: 'User' }, state, commit_id: head, submitted_at: '2026-01-01T00:00:00Z', body: '> Mivo 自动审查 · fixture' };
}

function makeServer(overrides = {}) {
  return {
    diff, threads: [], viewer: undefined, reviews: [], rollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    protection: PROTECTION,
    files: [{ path: 'fixture.txt', additions: 1, deletions: 0 }],
    meta: { headRefOid: head, baseRefOid: base, baseRefName: 'main', number: 1, title: 'docs: fixture', body: 'fixture', state: 'OPEN',
      author: { login: 'contributor' }, labels: [], isDraft: false, headRefName: 'feature',
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED', url: 'https://github.com/o/r/pull/1' },
    ...overrides,
  };
}

const MOCK = `import {readFileSync,appendFileSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=childProcess.spawnSync;
childProcess.spawnSync=(command,args,options)=>{
  const localFallback=command==='git'&&(args[0]==='fetch'||args[0]==='merge-base'||args.includes('--is-shallow-repository')||args.includes('--no-ext-diff'));
  if(command!=='gh'&&!localFallback)return original(command,args,options);
  const fixture=JSON.parse(readFileSync(process.env.CONTEXT_FIXTURE,'utf8'));
  let query='';
  if(args[0]==='api'&&args[1]==='graphql'){try{query=JSON.parse(options.input).query;}catch{}}
  appendFileSync(process.env.CONTEXT_CALLS,JSON.stringify({args:localFallback?['git',...args]:args,query,seen:options&&options.env?options.env.GH_TOKEN??null:null})+'\\n');
  const success=value=>({status:0,signal:null,stdout:typeof value==='string'?value:JSON.stringify(value),stderr:''});
  const failure=message=>({status:1,signal:null,stdout:'',stderr:message});
  if(localFallback){
    if(args[0]==='fetch')return success('');
    if(args[0]==='merge-base')return success(fixture.meta.baseRefOid);
    if(args.includes('--is-shallow-repository'))return success('false');
    return success(fixture.diff);
  }
  if(args[0]==='pr'&&args[1]==='diff')return success(fixture.diff);
  if(args[0]==='pr'&&args[1]==='view'){
    const fields=args[args.indexOf('--json')+1];
    if(fields==='state')return success({state:'OPEN'});
    if(fields==='statusCheckRollup')return success({statusCheckRollup:fixture.rollup});
    return success(fixture.meta);
  }
  if(args[0]==='api'&&args[1]==='graphql'){
    if(query.includes('reviewThreads('))return success({data:{repository:{pullRequest:{reviewThreads:{
      pageInfo:{hasNextPage:false,endCursor:null},nodes:fixture.threads}}}}});
    const data={repository:{defaultBranchRef:{name:'main'},pullRequest:{id:'PR_fixture'}}};
    if(query.includes('viewer')&&fixture.viewer)data.viewer={login:fixture.viewer};
    return success({data});
  }
  const endpoint=args.find(arg=>arg.startsWith('repos/'));
  if(args[0]==='api'&&endpoint){
    const rest=endpoint.replace('repos/o/r/','');
    if(fixture.protection[rest]!==undefined)return success(fixture.protection[rest]);
    if(endpoint.endsWith('/files'))return success([fixture.files.map(f=>({filename:f.path,...f}))]);
    if(endpoint.endsWith('/reviews'))return success([fixture.reviews]);
    if(endpoint.endsWith('/comments'))return success([[]]);
    if(endpoint.endsWith('/commits'))return success([[{sha:fixture.meta.headRefOid,commit:{committer:{date:'2026-01-01T00:00:00Z'},message:'fixture'}}]]);
    if(endpoint.includes('/actions/runs?'))return success({workflow_runs:[]});
    if(endpoint.includes('/compare/'))return success({behind_by:0,merge_base_commit:{commit:{committer:{date:'2026-01-01T00:00:00Z'}}}});
    if(endpoint.includes('/check-runs')||endpoint.includes('/status'))return success({check_runs:[],statuses:[],state:'success',total_count:0});
  }
  throw new Error('Unexpected gh operation: '+JSON.stringify(args));
};
syncBuiltinESMExports();
`;

function withFixture(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'identity-context-'));
  try {
    const repoRoot = join(directory, 'repo');
    mkdirSync(repoRoot);
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
      const output = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
      assert.equal(output.status, 0, output.stderr);
    }
    const fixture = join(directory, 'fixture.json');
    const callsFile = join(directory, 'calls.jsonl');
    const mockFile = join(directory, 'mock.mjs');
    writeFileSync(mockFile, MOCK);
    const env = { ...process.env, GH_TOKEN: FAKE_INT, GITHUB_TOKEN: FAKE_INT, REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_STATE_DIR: join(directory, 'state'),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFile).href}`].filter(Boolean).join(' '),
      CONTEXT_FIXTURE: fixture, CONTEXT_CALLS: callsFile };
    for (const key of ['REVIEW_PR_VIEWER_LOGIN', 'REVIEW_PR_IDENTITY_TOKEN', 'REVIEW_PR_NO_CRED_FALLBACK']) delete env[key];
    const state = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {STATE_DIR} from ${JSON.stringify(LIB_URL)};process.stdout.write(STATE_DIR);`], { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
    assert.equal(state.status, 0, state.stderr);
    const stateDir = state.stdout;
    const token = 'identity-fixture-lock';
    const authority = { version: MAINTAINER_AUTHORITY_VERSION, repository: 'o/r', runToken: token,
      base: { ref: 'main', sha: base }, fetchedAt: new Date().toISOString(),
      codeowners: { path: '.github/CODEOWNERS', org: 'o', teamSlug: 'maintainers', teamHandle: '@o/maintainers',
        teamPrivacy: 'closed', repositoryPermission: 'push' },
      teamMembers: ['maintainer'], allowlistedMembers: [], members: ['maintainer'], teamMemberCount: 1, allowlistedMemberCount: 0, memberCount: 1 };
    writeFileSync(join(stateDir, 'lock.json'), JSON.stringify({ token }));
    writeFileSync(join(stateDir, `maintainer-authority-${token}.json`), JSON.stringify({ ...authority, digest: computeMaintainerAuthorityDigest(authority) }));
    const run = (server, extraEnv = {}) => {
      writeFileSync(fixture, JSON.stringify(server));
      writeFileSync(callsFile, '');
      const r = spawnSync(process.execPath, [CONTEXT, '1', '--lock-token', token, '--diff-output', join(stateDir, 'pr.diff')],
        { cwd: repoRoot, env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true });
      const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* 留给断言看 stdout */ }
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, calls };
    };
    return fn(run);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const mainQuery = (calls) => calls.find((c) => c.args[1] === 'graphql' && c.query && !c.query.includes('reviewThreads('));

test('REVIEW_PR_VIEWER_LOGIN:viewerLogin 取该值,GraphQL 不再要 viewer,即使 viewer 是 bot', () => withFixture((run) => {
  const r = run(makeServer({ viewer: 'github-actions[bot]' }), { REVIEW_PR_VIEWER_LOGIN: 'maintainer' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.approvalPolicy.viewer, 'maintainer');
  assert.equal(r.json.approvalPolicy.viewerIsAuthor, false);
  assert.ok(!mainQuery(r.calls).query.includes('viewer'));
}));

test('REVIEW_PR_VIEWER_LOGIN:GraphQL 完全没有 viewer 也能出 context', () => withFixture((run) => {
  const r = run(makeServer(), { REVIEW_PR_VIEWER_LOGIN: 'maintainer' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.approvalPolicy.viewer, 'maintainer');
}));

test('REVIEW_PR_VIEWER_LOGIN:viewerIsAuthor 不分大小写', () => withFixture((run) => {
  const server = makeServer();
  server.meta.author = { login: 'Maintainer' };
  const r = run(server, { REVIEW_PR_VIEWER_LOGIN: 'maintainer' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.approvalPolicy.viewerIsAuthor, true);
}));

test('REVIEW_PR_VIEWER_LOGIN:审查机自己的 CHANGES_REQUESTED 判为 self-resolvable(大小写不同也算同一账号)', () => withFixture((run) => {
  const server = makeServer({ reviews: [reviewFixture('Maintainer')] });
  const withOverride = run(server, { REVIEW_PR_VIEWER_LOGIN: 'maintainer' });
  assert.equal(withOverride.status, 0, withOverride.stdout + withOverride.stderr);
  assert.equal(withOverride.json.gate.blockClass, 'self-resolvable');
  // 对照:没设变量、GraphQL viewer 是别人时,同一份夹具不是自解死锁,证明夹具能区分
  const without = run({ ...server, viewer: 'other' });
  assert.equal(without.status, 0, without.stdout + without.stderr);
  assert.equal(without.json.approvalPolicy.viewer, 'other');
  assert.notEqual(without.json.gate.blockClass, 'self-resolvable');
}));

test('没设 REVIEW_PR_VIEWER_LOGIN:仍发带 viewer 的查询,viewer 取 GraphQL;缺 viewer 照旧报错', () => withFixture((run) => {
  const ok = run(makeServer({ viewer: 'other' }));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.json.approvalPolicy.viewer, 'other');
  assert.ok(mainQuery(ok.calls).query.includes('viewer'));
  const missing = run(makeServer());
  assert.equal(missing.status, 1);
  assert.match(missing.json.error, /PR 或 viewer 元数据未完整读取/);
}));

test('REVIEW_PR_VIEWER_LOGIN 格式不对:发请求前报错', () => withFixture((run) => {
  const r = run(makeServer({ viewer: 'other' }), { REVIEW_PR_VIEWER_LOGIN: 'bad login!' });
  assert.equal(r.status, 1);
  assert.match(r.json.error, /REVIEW_PR_VIEWER_LOGIN/);
  assert.equal(r.calls.length, 0);
}));

test('REVIEW_PR_IDENTITY_TOKEN:分支保护三类调用用身份令牌,其余调用不带自定义令牌', () => withFixture((run) => {
  const server = makeServer({ viewer: 'other', reviewDecision: 'APPROVED' });
  server.meta.reviewDecision = 'APPROVED';
  const r = run(server, { REVIEW_PR_IDENTITY_TOKEN: FAKE_ID });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const identityEndpoints = new Set(['branches/main/protection', 'branches/main/protection/required_signatures', 'rulesets/9']);
  const seenIdentity = new Set();
  for (const c of r.calls) {
    const endpoint = c.args.find((a) => typeof a === 'string' && a.startsWith('repos/o/r/'))?.replace('repos/o/r/', '');
    if (identityEndpoints.has(endpoint)) { assert.equal(c.seen, FAKE_ID, endpoint); seenIdentity.add(endpoint); }
    else assert.equal(c.seen, null, JSON.stringify(c.args));
  }
  assert.deepEqual([...seenIdentity].sort(), [...identityEndpoints].sort());
}));
