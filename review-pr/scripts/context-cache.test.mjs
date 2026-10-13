import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createContextEvidence, loadCachedCode, sameCodeRevision, writeDiffFile } from './context-cache.mjs';
import { computeMaintainerAuthorityDigest, MAINTAINER_AUTHORITY_VERSION } from './lib.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const meta = { headRefOid: head, baseRefOid: base, baseRefName: 'main' };
const files = [{ path: 'fixture.txt', additions: 1, deletions: 0 }];
const diff = 'diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -0,0 +1 @@\n+hello\n';
const fixtureDirectory = () => mkdtempSync(join(tmpdir(), 'review-context-test-'));
function removeFixture(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('review-context-test-'));
  rmSync(directory, { recursive: true, force: true });
}

test('immutable context evidence is reusable but never returns mutable gates or history', () => {
  const directory = fixtureDirectory();
  try {
    const diffFile = join(directory, 'pr.diff');
    const contextFile = join(directory, 'context.json');
    writeDiffFile(diffFile, diff);
    const evidence = createContextEvidence({ repo: 'o/r', pr: 1, meta, files, diff, diffFile });
    const context = { ok: true, pr: 1, meta, files, evidence,
      gate: { gatePass: true }, history: { reviewThreads: [] }, approvalPolicy: { viewerCanApprove: true } };
    writeFileSync(contextFile, JSON.stringify(context));
    const cached = loadCachedCode(contextFile, { repo: 'o/r', pr: 1, meta });
    assert.equal(cached.reused, true);
    assert.equal(cached.diff, diff);
    assert.deepEqual(cached.files, files);
    assert.deepEqual(Object.keys(cached).sort(), ['diff', 'diffFile', 'files', 'reason', 'reused']);
    assert.ok(!readdirSync(directory).some((file) => file.endsWith('.tmp')));
    for (const changed of [
      { ...meta, headRefOid: 'c'.repeat(40) },
      { ...meta, baseRefOid: 'd'.repeat(40) },
      { ...meta, baseRefName: 'release' },
      { ...meta, baseRefOid: undefined },
    ]) {
      assert.equal(loadCachedCode(contextFile, { repo: 'o/r', pr: 1, meta: changed }).reused, false);
      assert.equal(sameCodeRevision(meta, changed), false);
    }
    assert.equal(loadCachedCode(contextFile, { repo: 'other/repo', pr: 1, meta }).reused, false);
    assert.equal(loadCachedCode(contextFile, { repo: 'o/r', pr: 2, meta }).reused, false);
    writeFileSync(diffFile, `${diff}+tampered\n`);
    assert.equal(loadCachedCode(contextFile, { repo: 'o/r', pr: 1, meta }).reason, 'diff-integrity-mismatch');
    writeDiffFile(diffFile, diff);
    context.files[0].additions++;
    writeFileSync(contextFile, JSON.stringify(context));
    assert.equal(loadCachedCode(contextFile, { repo: 'o/r', pr: 1, meta }).reason, 'files-integrity-mismatch');
    writeFileSync(contextFile, '{');
    assert.equal(loadCachedCode(contextFile, { repo: 'o/r', pr: 1, meta }).reason, 'context-unreadable');
  } finally { removeFixture(directory); }
});

test('actual context refresh saves one diff, refreshes mutable threads, and invalidates changed revisions', () => {
  const directory = fixtureDirectory();
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
    writeFileSync(mockFile, `import {readFileSync,appendFileSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=childProcess.spawnSync;
let metadataReads=0;
childProcess.spawnSync=(command,args,options)=>{
  const localFallback=command==='git'&&(args[0]==='fetch'||args[0]==='merge-base'||args.includes('--is-shallow-repository')||args.includes('--no-ext-diff'));
  if(command!=='gh'&&!localFallback)return original(command,args,options);
  appendFileSync(process.env.CONTEXT_CALLS,JSON.stringify(localFallback?['git',...args]:args)+'\\n');
  const fixture=JSON.parse(readFileSync(process.env.CONTEXT_FIXTURE,'utf8'));
  const success=value=>({status:0,signal:null,stdout:typeof value==='string'?value:JSON.stringify(value),stderr:''});
  const failure=message=>({status:1,signal:null,stdout:'',stderr:message});
  if(localFallback){
    if(fixture.gitError)return failure(fixture.gitError);
    if(args[0]==='fetch')return success('');
    if(args[0]==='merge-base')return success(fixture.meta.baseRefOid);
    if(args.includes('--is-shallow-repository'))return success('false');
    return success(fixture.diff);
  }
  if(args[0]==='pr'&&args[1]==='diff')return fixture.diffError?failure(fixture.diffError):success(fixture.diff);
  if(args[0]==='pr'&&args[1]==='view'){
    const fields=args[args.indexOf('--json')+1];
    if(fields==='state')return success({state:'MERGED'});
    if(fields==='statusCheckRollup')return success({statusCheckRollup:[]});
    metadataReads++;
    const meta=metadataReads>1&&fixture.revisionAfter?fixture.revisionAfter:fixture.meta;
    return success(meta);
  }
  if(args[0]==='api'&&args[1]==='graphql'){
    const query=JSON.parse(options.input).query;
    if(query.includes('reviewThreads('))return success({data:{repository:{pullRequest:{reviewThreads:{
      pageInfo:{hasNextPage:false,endCursor:null},nodes:fixture.threads}}}}});
    return success({data:{viewer:{login:'alice'},repository:{defaultBranchRef:{name:'main'},pullRequest:{id:'PR_fixture'}}}});
  }
  const endpoint=args.find(arg=>arg.startsWith('repos/'));
  if(args[0]==='api'&&endpoint){
    if(endpoint.endsWith('/files'))return success([fixture.files.map(f=>({filename:f.path,...f}))]);
    if(endpoint.endsWith('/reviews')||endpoint.endsWith('/comments'))return success([[]]);
    if(endpoint.endsWith('/commits'))return success([[{sha:fixture.meta.headRefOid,commit:{committer:{date:'2026-01-01T00:00:00Z'},message:'fixture'}}]]);
    if(endpoint.includes('/actions/runs?'))return success({workflow_runs:[]});
    if(endpoint.includes('/compare/'))return success({behind_by:0,merge_base_commit:{commit:{committer:{date:'2026-01-01T00:00:00Z'}}}});
  }
  throw new Error('Unexpected gh operation: '+JSON.stringify(args));
};
syncBuiltinESMExports();
`);
    const env = { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_STATE_DIR: join(directory, 'state'),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFile).href}`].filter(Boolean).join(' '),
      CONTEXT_FIXTURE: fixture, CONTEXT_CALLS: callsFile };
    const state = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {STATE_DIR} from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)};process.stdout.write(STATE_DIR);`],
    { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
    assert.equal(state.status, 0, state.stderr);
    const stateDir = state.stdout;
    const token = 'context-fixture-lock';
    const authority = { version: MAINTAINER_AUTHORITY_VERSION, repository: 'o/r', runToken: token,
      base: { ref: 'main', sha: base }, fetchedAt: new Date().toISOString(),
      codeowners: { path: '.github/CODEOWNERS', org: 'o', teamSlug: 'maintainers', teamHandle: '@o/maintainers',
        teamPrivacy: 'closed', repositoryPermission: 'push' },
      teamMembers: ['alice'], allowlistedMembers: [], members: ['alice'], teamMemberCount: 1, allowlistedMemberCount: 0, memberCount: 1 };
    writeFileSync(join(stateDir, 'lock.json'), JSON.stringify({ token }));
    writeFileSync(join(stateDir, `maintainer-authority-${token}.json`), JSON.stringify({ ...authority, digest: computeMaintainerAuthorityDigest(authority) }));
    const server = { diff, files, threads: [], meta: { ...meta, number: 1, title: 'docs: fixture', body: 'fixture', state: 'OPEN',
      author: { login: 'contributor' }, labels: [], isDraft: false, headRefName: 'feature',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED', url: 'https://github.com/o/r/pull/1' } };
    const contextFile = join(stateDir, 'context.json');
    const diffFile = join(stateDir, 'pr.diff');
    const readCalls = () => readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const runContext = (extra = []) => {
      writeFileSync(fixture, JSON.stringify(server));
      writeFileSync(callsFile, '');
      return spawnSync(process.execPath, [fileURLToPath(new URL('./context.mjs', import.meta.url)), '1', '--lock-token', token,
        '--diff-output', diffFile, ...extra], { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
    };
    const first = runContext();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const context = JSON.parse(first.stdout);
    assert.equal(context.cache.reusedDiff, false);
    assert.equal(context.meta.baseRefOid, base);
    assert.equal(context.gate.unresolvedThreads.length, 0);
    assert.equal(readFileSync(diffFile, 'utf8'), diff);
    assert.equal(readCalls().filter(args => args[0] === 'pr' && args[1] === 'diff').length, 1);
    writeFileSync(contextFile, first.stdout);
    server.threads = [{ id: 'PRRT_live', isResolved: false, isOutdated: false, path: 'fixture.txt', line: 1,
      comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'PRRC_live', author: { login: 'bot[bot]', __typename: 'Bot' },
        body: 'A new unresolved issue', createdAt: '2026-01-02T00:00:00Z', url: 'https://github.com/o/r/pull/1#discussion_r1' }] } }];
    const fresh = runContext(['--cached-context', contextFile]);
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    const refreshed = JSON.parse(fresh.stdout);
    assert.equal(refreshed.cache.reusedDiff, true);
    assert.equal(refreshed.evidence.diffHash, context.evidence.diffHash);
    assert.equal(refreshed.gate.unresolvedThreads.length, 1);
    assert.equal(refreshed.gate.gatePass, false);
    assert.equal(readCalls().filter(args => args[0] === 'pr' && args[1] === 'diff').length, 0);
    assert.equal(readCalls().filter(args => args.some(arg => arg.endsWith('/files'))).length, 0);
    assert.ok(readCalls().some(args => args.some(arg => arg.endsWith('/reviews'))));
    server.meta.baseRefOid = 'c'.repeat(40);
    server.diff = `${diff}+base changed\n`;
    const moved = runContext(['--cached-context', contextFile]);
    assert.equal(moved.status, 0, moved.stdout + moved.stderr);
    const changed = JSON.parse(moved.stdout);
    assert.equal(changed.cache.reusedDiff, false);
    assert.equal(changed.cache.reason, 'revision-changed');
    assert.notEqual(changed.evidence.diffHash, context.evidence.diffHash);
    assert.equal(changed.evidence.base, server.meta.baseRefOid);
    assert.equal(readCalls().filter(args => args[0] === 'pr' && args[1] === 'diff').length, 1);
    server.revisionAfter = { ...server.meta, headRefOid: 'd'.repeat(40) };
    const priorDiff = readFileSync(diffFile, 'utf8');
    const raced = runContext(['--cached-context', contextFile]);
    assert.equal(raced.status, 1);
    assert.match(JSON.parse(raced.stdout).error, /head\/base/);
    assert.equal(readFileSync(diffFile, 'utf8'), priorDiff);
    delete server.revisionAfter;
    server.diffError = 'HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)';
    server.diff = diff + '+safe line\n'.repeat(20_010) + '+-----BEGIN PRIVATE KEY-----\n';
    const fallback = runContext();
    assert.equal(fallback.status, 0, fallback.stdout + fallback.stderr);
    const localContext = JSON.parse(fallback.stdout);
    assert.equal(readFileSync(diffFile, 'utf8'), server.diff);
    assert.equal(localContext.security.scanned, true);
    assert.equal(localContext.security.pass, false);
    assert.ok(localContext.security.hardHits.some((hit) => hit.kind === 'private-key' && hit.line > 20_000));
    assert.ok(readCalls().some((args) => args[0] === 'git' && args[1] === 'fetch'));
    writeFileSync(contextFile, fallback.stdout);
    const cachedFallback = runContext(['--cached-context', contextFile]);
    assert.equal(cachedFallback.status, 0, cachedFallback.stdout + cachedFallback.stderr);
    assert.equal(JSON.parse(cachedFallback.stdout).cache.reusedDiff, true);
    assert.equal(JSON.parse(cachedFallback.stdout).security.pass, false);
    assert.equal(readCalls().filter((args) => args[0] === 'git' || args[0] === 'pr' && args[1] === 'diff').length, 0);
    server.revisionAfter = { ...server.meta, headRefOid: 'e'.repeat(40) };
    const fallbackRace = runContext();
    assert.equal(fallbackRace.status, 1);
    assert.match(JSON.parse(fallbackRace.stdout).error, /head\/base/);
    assert.equal(readFileSync(diffFile, 'utf8'), server.diff);
    delete server.revisionAfter;
    server.gitError = 'fetch access denied';
    const failedFallback = runContext();
    assert.equal(failedFallback.status, 1);
    const fallbackError = JSON.parse(failedFallback.stdout).error;
    assert.match(fallbackError, /HTTP 406/);
    assert.match(fallbackError, /fetch access denied/);
    assert.equal(readFileSync(diffFile, 'utf8'), server.diff);
    server.diffError = 'HTTP 403: forbidden';
    const forbidden = runContext();
    assert.equal(forbidden.status, 1);
    assert.match(JSON.parse(forbidden.stdout).error, /HTTP 403/);
    assert.equal(readCalls().filter((args) => args[0] === 'git').length, 0);
    const dep = spawnSync(process.execPath, [fileURLToPath(new URL('./gh-read.mjs', import.meta.url)), 'o/r', '99'],
      { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
    assert.equal(dep.status, 0, dep.stdout + dep.stderr);
    assert.deepEqual(JSON.parse(dep.stdout), { ok: true, state: 'MERGED' });
    assert.equal(existsSync(join(repoRoot, 'pr.diff')), false);
  } finally { removeFixture(directory); }
});
