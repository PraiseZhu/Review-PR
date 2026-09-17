import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL = dirname(dirname(fileURLToPath(import.meta.url)));
const LIB = pathToFileURL(join(SKILL, 'scripts/lib.mjs')).href;
const ESCAPE = pathToFileURL(join(SKILL, 'scripts/lib.escaped-hazards.mjs')).href;
const RECEIPT = join(SKILL, 'scripts/write-review-receipt.mjs');
const CONTEXT = join(SKILL, 'scripts/context.mjs');
const BUILD = join(SKILL, 'scripts/build-review-task.mjs');
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

// This fake executable is the only gh on PATH. Every request is logged, and an
// unexpected command fails loudly instead of ever reaching a real credential.
const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_COMPAT_LOG, JSON.stringify(args) + '\\n');
const mode = process.env.GH_COMPAT_MODE;
const head = process.env.GH_COMPAT_HEAD || '${HEAD}';
const base = process.env.GH_COMPAT_BASE || '${BASE}';
const issue = {number:7,title:'related issue',body:'issue evidence',url:'https://github.com/owner/repo/issues/7',repository:{nameWithOwner:'owner/repo'}};
const meta = {number:42,url:'https://github.com/owner/repo/pull/42',headRefOid:head,baseRefOid:base,body:'PR evidence',title:'fix: test',state:'OPEN',isDraft:false,labels:[],closingIssuesReferences:[issue],headRefName:'feature/test',baseRefName:'main',author:{login:'author'},isCrossRepository:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'REVIEW_REQUIRED',mergedAt:null,files:[{path:'sample.mjs',additions:1,deletions:1}],statusCheckRollup:[],reviews:[]};
if (args[0] === 'pr' && args[1] === 'view') {
  if (mode === 'auth') {console.error('HTTP 401: Bad credentials');process.exit(4);}
  if (mode === 'malformed') {process.stdout.write('{broken');process.exit(0);}
  const fields = args[args.indexOf('--json') + 1].split(',');
  const missing = fields.find(x => ['headRefOid','baseRefOid','closingIssuesReferences'].includes(x));
  if (mode !== 'modern' && missing) {console.error('Unknown JSON field: "' + missing + '"');process.exit(1);}
  process.stdout.write(JSON.stringify(Object.fromEntries(fields.map(field => [field,meta[field]]))));process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const query = fs.readFileSync(0,'utf8');
  if (query.includes('reviewThreads')) {
    const pageInfo = {hasNextPage:false,endCursor:null};
    process.stdout.write(JSON.stringify({data:{viewer:{login:'viewer'},repository:{pullRequest:{author:{login:'author'},reviewThreads:{nodes:[],pageInfo},comments:{nodes:[],pageInfo},timeline:{nodes:[]},readyEvents:{nodes:[]},latestOpinionatedReviews:{nodes:[],pageInfo}}}}}));process.exit(0);
  }
  if (query.includes('statusCheckRollup')) {
    process.stdout.write(JSON.stringify({data:{repository:{pullRequest:{commits:{nodes:[{commit:{statusCheckRollup:{contexts:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}]}}}}}));process.exit(0);
  }
  if (!query.trim().startsWith('query(') || !query.includes('headRefOid baseRefOid body updatedAt')) {console.error('unexpected GraphQL query');process.exit(92);}
  const pull = {number:mode === 'wrong-pr' ? 43 : 42,headRefOid:head,baseRefOid:base,body:'PR evidence',updatedAt:'2026-09-17T03:00:00Z'};
  if (query.includes('closingIssuesReferences')) pull.closingIssuesReferences = {nodes:[issue],totalCount:1,pageInfo:{hasNextPage:false,endCursor:null}};
  process.stdout.write(JSON.stringify({data:{repository:{nameWithOwner:'owner/repo',pullRequest:pull}}}));process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'diff') {process.stdout.write('diff --git a/sample.mjs b/sample.mjs\\n--- a/sample.mjs\\n+++ b/sample.mjs\\n+export const sample = 2;\\n');process.exit(0);}
if (args[0] === 'api' && args[1] === 'user') {process.stdout.write(JSON.stringify({login:'viewer'}));process.exit(0);}
if (args[0] === 'api' && args[1].includes('/actions/runs')) {process.stdout.write(JSON.stringify({workflow_runs:[]}));process.exit(0);}
if (args[0] === 'api' && args[1].includes('/rules/branches/')) {process.stdout.write('HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n[]');process.exit(0);}
console.error('unmocked gh request: ' + args.join(' '));process.exit(93);
`;

function fixture(t, mode = 'legacy') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gh-field-compat-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  const osTmp = join(root, 'os-tmp');
  const bin = join(root, 'bin');
  for (const dir of [repo, state, osTmp, bin]) mkdirSync(dir);
  for (const args of [['init', '-q', repo], ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git']]) {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const signing = spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf8' });
  assert.equal(signing.status, 0, signing.stderr);
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const log = join(root, 'gh.jsonl');
  const env = {
    ...process.env,
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    REVIEW_PR_REPO_ROOT: repo,
    REVIEW_PR_STATE_DIR: state,
    REVIEW_PR_LIB_READONLY: '0',
    GH_COMPAT_MODE: mode,
    GH_COMPAT_LOG: log,
    TMPDIR: osTmp,
    TMP: osTmp,
    TEMP: osTmp,
  };
  const run = (args) => {
    const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', timeout: 15000 });
    assert.doesNotMatch(result.stderr ?? '', /回退系统临时目录/, 'state must stay in the fixture owner directory');
    return result;
  };
  const evaluate = (code) => run(['--input-type=module', '-e', code]);
  // Check the actual resolved state path before exercising any writer.
  const probe = evaluate(`import {STATE_DIR} from ${JSON.stringify(LIB)}; console.log(STATE_DIR);`);
  assert.equal(probe.status, 0, probe.stderr);
  const resolvedState = probe.stdout.trim();
  assert.ok(resolvedState.startsWith(`${state}/`), resolvedState);
  assert.equal(existsSync(join(osTmp, 'review-pr')), false, 'no legacy fallback tree may be created');
  return { root, repo, env, run, evaluate, state: resolvedState, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('actual dirty receipt CLI works with old gh; modern gh still makes one request', (t) => {
  for (const mode of ['legacy', 'modern']) {
    const f = fixture(t, mode);
    const result = f.run([RECEIPT, '42', '--verdict', 'dirty', '--p0p1-count', '1']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.receipt.headRefOid, HEAD);
    assert.equal(payload.receipt.verdict, 'dirty');
    assert.equal(f.calls().length, mode === 'modern' ? 1 : 2);
    const written = JSON.parse(readFileSync(join(f.state, 'review-receipt-42.json'), 'utf8'));
    assert.equal(written.headRefOid, HEAD);
  }
});

test('receipt CLI retains clean prohibition and never fetches for explicit head', (t) => {
  const f = fixture(t);
  const denied = f.run([RECEIPT, '42', '--verdict', 'clean', '--p0p1-count', '0']);
  assert.notEqual(denied.status, 0);
  assert.match(`${denied.stdout}\n${denied.stderr}`, /clean/);
  assert.equal(f.calls().length, 0);
  const explicit = f.run([RECEIPT, '42', '--verdict', 'dirty', '--p0p1-count', '0', '--head', HEAD]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(f.calls().length, 0);
});

test('auth, malformed output and wrong fallback PR never write a receipt', (t) => {
  for (const mode of ['auth', 'malformed', 'wrong-pr']) {
    const f = fixture(t, mode);
    const result = f.run([RECEIPT, '42', '--verdict', 'dirty', '--p0p1-count', '0']);
    assert.notEqual(result.status, 0, mode);
    assert.equal(readdirSync(f.state).some((name) => name.startsWith('review-receipt-')), false);
    assert.equal(f.calls().length, mode === 'wrong-pr' ? 2 : 1);
  }
});

test('the raw gh reader used by readiness and ghJson metadata readers share compatibility', (t) => {
  const f = fixture(t);
  const result = f.evaluate(`
    import {gh,ghJson} from ${JSON.stringify(LIB)};
    const raw = JSON.parse(gh(['pr','view','42','--repo','owner/repo','--json','baseRefOid,headRefOid,labels,isDraft,state']).stdout);
    const meta = ghJson(['pr','view','42','--repo','owner/repo','--json','number,title,body,headRefOid']);
    console.log(JSON.stringify({raw,meta}));
  `);
  assert.equal(result.status, 0, result.stderr);
  const { raw, meta } = JSON.parse(result.stdout);
  assert.equal(raw.headRefOid, HEAD);
  assert.equal(raw.baseRefOid, BASE);
  assert.deepEqual(raw.labels, []);
  assert.equal(meta.body, 'PR evidence');
  assert.equal(meta.number, 42);
  assert.equal(f.calls().filter((args) => args[0] === 'api').length, 4);
});

test('builder and consumer escape-source resolver reads actual closing references with old gh', (t) => {
  const f = fixture(t);
  const result = f.evaluate(`
    import {readFileSync,existsSync} from 'node:fs';
    import {ghJson} from ${JSON.stringify(LIB)};
    import {resolveEscapeSources} from ${JSON.stringify(ESCAPE)};
    console.log(JSON.stringify(resolveEscapeSources({pr:42,repoSlug:'owner/repo',ghJson,readFileSync,existsSync})));
  `);
  assert.equal(result.status, 0, result.stderr);
  const source = JSON.parse(result.stdout);
  assert.deepEqual(source.errors, []);
  assert.equal(source.prBody, 'PR evidence');
  assert.deepEqual(source.issueTexts, ['related issue\nissue evidence']);
  assert.equal(source.kind, 'gh-live');
  assert.equal(f.calls().length, 2);
});

test('actual context --scan succeeds after legacy headRefOid field rejection', (t) => {
  const f = fixture(t);
  const result = f.run([CONTEXT, '42', '--scan']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.pr, 42);
  assert.ok(f.calls().some((args) => args[0] === 'pr' && args.includes('--json') && args.at(-1).includes('headRefOid')));
  assert.ok(f.calls().some((args) => args[0] === 'api' && args[1] === 'graphql' && args.includes('number=42')));
  assert.equal(f.calls().some((args) => ['edit','review','merge','comment','create','ready'].includes(args[1]) || args.includes('-X')), false);
});

test('actual build-review-task fetches closing references without file seam and closes on source failure', (t) => {
  const f = fixture(t);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', f.repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  writeFileSync(join(f.repo, 'sample.mjs'), 'export const sample = 1;\n');
  git('add', 'sample.mjs');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture base');
  f.env.GH_COMPAT_BASE = git('rev-parse', 'HEAD');
  writeFileSync(join(f.repo, 'sample.mjs'), 'export const sample = 2;\n');
  git('add', 'sample.mjs');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture head');
  f.env.GH_COMPAT_HEAD = git('rev-parse', 'HEAD');
  const taskPath = join(f.repo, 'task.json');
  const args = [BUILD, '42', '--base', f.env.GH_COMPAT_BASE, '--head', f.env.GH_COMPAT_HEAD, '--out-task', taskPath, '--out-prompt', join(f.repo, 'prompt.md')];
  const result = f.run(args);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const task = JSON.parse(readFileSync(taskPath, 'utf8'));
  assert.equal(task.snapshotComplete, true);
  assert.equal(task.escapeSourceKind, 'gh-live');
  assert.equal(task.escapeSourceIncomplete, false);
  assert.equal(task.relatedIssueCount, 1);
  const initial = f.calls().find((args) => args[0] === 'pr' && args[1] === 'view');
  assert.equal(initial.at(-1), 'body,closingIssuesReferences');
  f.env.GH_COMPAT_MODE = 'auth';
  const failed = f.run(args);
  assert.equal(failed.status, 0, `${failed.stdout}\n${failed.stderr}`);
  const incomplete = JSON.parse(readFileSync(taskPath, 'utf8'));
  assert.equal(incomplete.escapeSourceIncomplete, true);
  assert.ok(incomplete.escapeSourceErrors.some((error) => error.includes('HTTP 401')));
});
