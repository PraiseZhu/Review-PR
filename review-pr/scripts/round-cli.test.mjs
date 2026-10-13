// Actual CLI contracts with a local git repo and a mocked gh subprocess boundary; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { candidateFingerprint, createCandidateList, makeReviewPlan } from './review-round.mjs';
import { computeMaintainerAuthorityDigest, MAINTAINER_AUTHORITY_VERSION } from './lib.mjs';

test('pre-check, frozen planning, and finalization coverage work through the CLIs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-round-test-'));
  try {
    const repoRoot = join(directory, 'repo');
    const stateRoot = join(directory, 'state');
    mkdirSync(repoRoot);
    const remote = join(directory, 'o', 'r.git').replaceAll('\\', '/');
    mkdirSync(dirname(remote), { recursive: true });
    for (const args of [['init', '--bare', '--quiet', remote], ['init', '--quiet'], ['remote', 'add', 'origin', remote]]) {
      const git = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
      assert.equal(git.status, 0, git.stderr);
    }
    writeFileSync(join(repoRoot, 'fixture.txt'), 'fixture\n');
    for (const args of [['add', 'fixture.txt'], ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], ['push', '-q', 'origin', 'HEAD:refs/pull/1/head']]) {
      const committed = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
      assert.equal(committed.status, 0, committed.stderr);
    }
    const fixtureHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).stdout.trim();
    const snapshotFile = join(directory, 'snapshot.json');
    writeFileSync(snapshotFile, '[]');
    // shell:false does not execute a gh.cmd shim on Windows. Intercept the Node
    // subprocess boundary instead, including run-log children spawned by finalize.
    const mock = join(directory, 'mock-gh.mjs');
    writeFileSync(mock, `import {readFileSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {basename} from 'node:path';
const original=childProcess.spawnSync;
childProcess.spawnSync=(command,args,options)=>{
  const response=(status,stdout,stderr='')=>({status,signal:null,stdout,stderr,output:[null,stdout,stderr]});
  // This suite never updates the installed skill repository, even when it is clean.
  if (command === 'git' && args[0] === 'pull') return response(0,'');
  if (command !== 'gh') return original(command,args,options);
  if (process.env.ROUND_MOCK_FAIL === '1') return response(1,JSON.stringify({errors:[{message:'fixture query failed'}]}),'fixture query failed');
  if (args[0] === 'pr') {
    const fixture=JSON.parse(readFileSync(process.env.ROUND_MOCK_CONTEXTS,'utf8'));
    if (args[1] === 'diff') return response(0,'diff --git a/fixture.txt b/fixture.txt');
    if (args[1] === 'view') {
      const fields=args[args.indexOf('--json')+1];
      if (fields === 'headRefOid') return response(0,JSON.stringify({headRefOid:fixture.contexts[args[2]].headAtDiff || fixture.contexts[args[2]].meta.headRefOid}));
      const key=args[args.indexOf('--repo')+1]+'#'+args[2];
      if (fields === 'state' && fixture.states[key]) return response(0,JSON.stringify({state:fixture.states[key]}));
    }
    throw new Error('unexpected mock gh pr call');
  }
  if (args[0] !== 'api' || args[1] !== 'graphql' || !JSON.parse(options.input).query.includes('pullRequests')) throw new Error('unexpected mock gh call');
  const raw=JSON.parse(readFileSync(process.env.ROUND_MOCK_SNAPSHOT,'utf8'));
  const nodes=raw.map(p=>({...p,headRepository:p.headRepository ? {nameWithOwner:p.headRepository} : null,headRefOid:p.head,baseRefOid:p.base,author:{login:'author'},reviewThreads:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[]},commits:{nodes:[{commit:{statusCheckRollup:{state:p.ci}}}]}}));
  return response(0,JSON.stringify({data:{repository:{pullRequests:{totalCount:nodes.length,pageInfo:{hasNextPage:false,endCursor:null},nodes}}}}));
};
const originalSpawn=childProcess.spawn;
childProcess.spawn=(command,args,options)=>{
  if (command === process.execPath && basename(args[0]) === 'context.mjs') {
    if (args.includes('--scan')) throw new Error('planner must request full contexts');
    return originalSpawn(command,[process.env.ROUND_MOCK_CONTEXT_SCRIPT,...args.slice(1)],options);
  }
  if (command === process.execPath && basename(args[0]) === 'notify-author-resolve.mjs' && process.env.ROUND_MOCK_NOTICE_SCRIPT) {
    return originalSpawn(command,[process.env.ROUND_MOCK_NOTICE_SCRIPT,...args.slice(1)],options);
  }
  if (command === 'gh') throw new Error('unexpected asynchronous gh call');
  return originalSpawn(command,args,options);
};
syncBuiltinESMExports();
`);
    const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mock).href}`].filter(Boolean).join(' '), REVIEW_PR_REPO_ROOT: repoRoot,
      REVIEW_PR_STATE_DIR: stateRoot, ROUND_MOCK_SNAPSHOT: snapshotFile, ROUND_MOCK_FAIL: '0' };
    const run = (script, args = [], overrides = {}) => spawnSync(process.execPath,
      [fileURLToPath(new URL(script, import.meta.url)), ...args], { cwd: repoRoot, env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true });
    const state = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {STATE_DIR} from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)}; process.stdout.write(STATE_DIR);`],
    { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
    assert.equal(state.status, 0, state.stderr);
    const actualState = state.stdout;
    const empty = run('pre-check.mjs', ['--repo-root', repoRoot]);
    assert.equal(empty.status, 2, empty.stderr);
    const emptyOut = JSON.parse(empty.stdout);
    assert.deepEqual(JSON.parse(readFileSync(emptyOut.candidateList, 'utf8')).candidates, []);
    const raw = [{ number: 1, title: 'fixture', url: 'https://github.com/o/r/pull/1', createdAt: new Date().toISOString(),
      head: fixtureHead, base: 'b'.repeat(40), baseRefName: 'main', headRefName: 'feature', headRepository: 'o/r', updatedAt: new Date().toISOString(),
      isDraft: false, ci: 'SUCCESS' }];
    writeFileSync(snapshotFile, JSON.stringify(raw));
    const ready = run('pre-check.mjs', ['--repo-root', repoRoot]);
    assert.equal(ready.status, 0, ready.stderr);
    const readyOut = JSON.parse(ready.stdout);
    assert.equal(readyOut.candidateCount, 1);
    assert.equal(JSON.parse(readFileSync(readyOut.candidateList, 'utf8')).candidates[0].head, raw[0].head);
    // Leftover pre-round scan files are ignored. Candidate selection only reads
    // round-state.json, and pre-check never writes that file without the lock.
    const leftoverFiles = {
      'last-scan.json': { version: 2, complete: true, allSkip: true, candidateCount: 1 },
      'last-scan-results.json': { ok: true, complete: true, scanAll: true, repo: { owner: 'o', repo: 'r' },
        results: [{ ok: true, pr: 1, auto: { action: 'skip-protected-path', isSkip: true } }] },
      'last-run.json': { mode: 'auto', repo: 'o/r', loggedAt: new Date().toISOString(),
        review: { eligibleCount: 1, entered: [], notEntered: [{ pr: 1, reason: 'protected path' }] },
        merge: { merged: [], notMerged: [{ pr: 1, reason: 'protected path' }] } },
      'review-state.json': { version: 1, prs: { 1: { pr: 1, head: raw[0].head, reviewedAt: new Date().toISOString() } } },
    };
    for (const [name, data] of Object.entries(leftoverFiles)) writeFileSync(join(actualState, name), JSON.stringify(data));
    const leftover = run('pre-check.mjs');
    assert.equal(leftover.status, 0, leftover.stdout + leftover.stderr);
    const leftoverOut = JSON.parse(leftover.stdout);
    assert.equal(leftoverOut.candidateCount, 1);
    assert.equal(leftoverOut.legacyMigration, undefined);
    assert.equal(JSON.parse(readFileSync(leftoverOut.candidateList, 'utf8')).legacyMigration, undefined);
    assert.equal(existsSync(join(actualState, 'round-state.json')), false);
    for (const [name, data] of Object.entries(leftoverFiles)) assert.deepEqual(JSON.parse(readFileSync(join(actualState, name), 'utf8')), data);
    const differentMode = run('pre-check.mjs', ['--review-only']);
    assert.equal(differentMode.status, 0, differentMode.stderr);
    assert.equal(JSON.parse(differentMode.stdout).candidateCount, 1);
    writeFileSync(join(actualState, 'review-state.json'), '{broken');
    writeFileSync(join(actualState, 'last-scan.json'), 'null');
    const corruptLeftover = run('pre-check.mjs');
    assert.equal(corruptLeftover.status, 0, corruptLeftover.stdout + corruptLeftover.stderr);
    assert.equal(JSON.parse(corruptLeftover.stdout).candidateCount, 1);
    for (const name of Object.keys(leftoverFiles)) rmSync(join(actualState, name));
    const failed = run('pre-check.mjs', [], { ROUND_MOCK_FAIL: '1' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /fixture query failed/);
    const token = 'fixture-lock-123456';
    writeFileSync(join(actualState, 'lock.json'), JSON.stringify({ token, startedAt: new Date().toISOString() }));
    const locked = run('pre-check.mjs');
    assert.equal(locked.status, 2);
    assert.equal(JSON.parse(locked.stdout).reason, 'lock-held');

    // Exercise durable own-PR bindings without creating any real session.
    const fingerprint = `${raw[0].head}|skip-gate`;
    const getFix = (fp = fingerprint, evidence = []) => {
      const output = run('fix-session-state.mjs', ['get', '1', '--fingerprint', fp, ...evidence]);
      assert.equal(output.status, 0, output.stdout + output.stderr);
      return JSON.parse(output.stdout);
    };
    assert.equal(getFix().sessionId, null);
    assert.equal(getFix().shouldDispatch, true);
    const saveFix = run('fix-session-state.mjs', ['set', '1', '--session', 'fixture-fix-session', '--fingerprint', fingerprint]);
    assert.equal(saveFix.status, 0, saveFix.stdout + saveFix.stderr);
    assert.equal(getFix().sessionId, 'fixture-fix-session');
    assert.equal(getFix().shouldDispatch, false);
    assert.equal(getFix(`${'c'.repeat(40)}|skip-gate`).shouldDispatch, true);
    assert.equal(getFix(`${raw[0].head}|review-failed`).shouldDispatch, true);
    assert.equal(getFix(`${raw[0].head}|skip-ci-failed`).shouldDispatch, true);
    assert.equal(getFix(`${raw[0].head}|skip-conflict|${raw[0].base}`).shouldDispatch, true);
    const invalidSave = run('fix-session-state.mjs', ['set', '1', '--fingerprint', 'new-blocker']);
    assert.equal(invalidSave.status, 1);
    assert.equal(getFix().shouldDispatch, false); // A failed save cannot advance the fingerprint.

    // A newly posted finding becomes an unresolved thread next round. Preserve
    // the original dispatch across that route change, but wake for new opinions.
    const threadsFile = join(directory, 'fix-thread-urls.json');
    const ownThread = 'https://github.com/o/r/pull/1#discussion_r101';
    const newThread = 'https://github.com/o/r/pull/1#discussion_r102';
    writeFileSync(threadsFile, JSON.stringify([ownThread]));
    const evidence = ['--threads-file', threadsFile];
    const saveFindings = run('fix-session-state.mjs', ['set', '1', '--session', 'fixture-fix-session',
      '--fingerprint', `${raw[0].head}|review-failed`, ...evidence]);
    assert.equal(saveFindings.status, 0, saveFindings.stderr);
    assert.equal(getFix(fingerprint, evidence).shouldDispatch, false);
    assert.equal(getFix(fingerprint, evidence).lastFingerprint, `${raw[0].head}|review-failed`);
    writeFileSync(threadsFile, JSON.stringify([ownThread, newThread]));
    assert.equal(getFix(fingerprint, evidence).shouldDispatch, true);
    const saveNewThread = run('fix-session-state.mjs', ['set', '1', '--session', 'fixture-fix-session',
      '--fingerprint', fingerprint, ...evidence]);
    assert.equal(saveNewThread.status, 0, saveNewThread.stderr);
    assert.equal(getFix(fingerprint, evidence).shouldDispatch, false);
    writeFileSync(threadsFile, JSON.stringify([newThread])); // Resolving one issue is not a new request.
    assert.equal(getFix(fingerprint, evidence).shouldDispatch, false);
    assert.equal(getFix(`${'c'.repeat(40)}|skip-gate`, evidence).shouldDispatch, true);
    assert.equal(run('fix-session-state.mjs', ['clear', '1']).status, 0);
    assert.equal(getFix().sessionId, null);
    assert.equal(getFix().shouldDispatch, true);

    const lockFile = join(actualState, 'lock.json');
    const beforeRefresh = readFileSync(lockFile, 'utf8');
    const wrongOwner = run('refresh-lock.mjs', ['--token', 'another-round-token']);
    assert.equal(wrongOwner.status, 0, wrongOwner.stderr);
    assert.equal(JSON.parse(wrongOwner.stdout).lost, true);
    assert.equal(readFileSync(lockFile, 'utf8'), beforeRefresh);
    const refresh = run('refresh-lock.mjs', ['--token', token]);
    assert.equal(refresh.status, 0, refresh.stderr);
    assert.equal(JSON.parse(refresh.stdout).refreshed, true);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).token, token);

    const manifest = createCandidateList({ repo: 'o/r', snapshot: raw });
    const plan = makeReviewPlan(manifest, [{ ok: true, pr: 1, meta: { state: 'OPEN', headRefOid: raw[0].head }, dependencies: [] }]);
    const roundDir = join(actualState, `round-${manifest.runId}`);
    mkdirSync(roundDir); mkdirSync(join(roundDir, 'results'));
    const planFile = join(roundDir, 'plan.json');
    writeFileSync(planFile, JSON.stringify({ ...plan, summaryChat: { chatId: 'fixture-chat' } }));
    const finishArgs = ['--plan', planFile, '--lock-token', token];
    const incomplete = run('finalize-review-round.mjs', finishArgs);
    assert.equal(incomplete.status, 1);
    assert.equal(existsSync(join(actualState, 'review-state.json')), false);
    const resultFile = join(roundDir, 'results', 'pr-1.json');
    const result = { runId: manifest.runId, mode: 'auto', pr: 1, head: raw[0].head, enteredReview: true,
      reviewed: true, reviewClean: false, merged: false, outcome: 'findings', reason: 'fixture P1 thread posted' };
    writeFileSync(resultFile, JSON.stringify({ ...result, mode: 'review-only' }));
    assert.equal(run('finalize-review-round.mjs', finishArgs).status, 1);
    writeFileSync(resultFile, JSON.stringify(result));
    // A reviewer result alone is not completion: actual worktree cleanup and
    // the bounded approval reconciliation pass are required before finalizing.
    assert.equal(run('finalize-review-round.mjs', finishArgs).status, 1);
    const queue = (action, extra = []) => {
      const out = run('review-queue.mjs', [action, ...finishArgs, ...extra]);
      assert.equal(out.status, 0, out.stdout + out.stderr); return JSON.parse(out.stdout);
    };
    queue('init', ['--concurrency', '1']);
    const claim = queue('claim');
    assert.equal(claim.claimed, true);
    assert.ok(existsSync(claim.task.worktree.path));
    queue('bind', ['--pr', '1', '--agent-id', 'fixture-review-agent']);
    assert.equal(run('finalize-review-round.mjs', finishArgs).status, 1);
    queue('complete', ['--pr', '1', '--agent-id', 'fixture-review-agent', '--agent-exited']);
    assert.equal(existsSync(claim.task.worktree.path), false);
    queue('reconcile');
    const finished = run('finalize-review-round.mjs', finishArgs);
    assert.equal(finished.status, 0, finished.stdout + finished.stderr);
    const finishedOut = JSON.parse(finished.stdout);
    assert.deepEqual(finishedOut.history, { ok: true, enabled: false, skipped: 'repo-not-allowlisted' });
    const summary = JSON.parse(readFileSync(join(roundDir, 'summary.json'), 'utf8'));
    assert.equal(summary.coverageComplete, true);
    assert.equal(summary.merge.notMergedGroups[0].key, 'findings');
    const cards = JSON.parse(readFileSync(join(roundDir, 'feishu-cards.json'), 'utf8'));
    assert.equal(cards.receive_id, 'fixture-chat');
    assert.equal(cards.pages.length, 1);
    assert.equal(JSON.parse(readFileSync(join(actualState, 'review-state.json'), 'utf8')).prs['1'].head, raw[0].head);
    const secondFinish = run('finalize-review-round.mjs', finishArgs);
    assert.equal(JSON.parse(secondFinish.stdout).alreadyFinalized, true);
    assert.equal(readFileSync(join(actualState, 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.equal(run('review-queue.mjs', ['close', ...finishArgs]).status, 1);
    writeFileSync(join(roundDir, 'notification.json'), JSON.stringify({ runId: manifest.runId,
      pages: [{ page: 1, status: 'sent', messageId: 'fixture-message-id', attemptedAt: new Date().toISOString() }] }));
    assert.equal(queue('close').closed, true);
    assert.equal(existsSync(join(roundDir, 'completed.json')), true);

    // Crash after queue reservation but before the worktree helper has written
    // ownership: a verified no-agent/no-directory recovery must release the slot.
    const crashRun = 'crash-before-worktree';
    const crashDir = join(actualState, `round-${crashRun}`);
    mkdirSync(crashDir); mkdirSync(join(crashDir, 'results'));
    const crashPlanFile = join(crashDir, 'plan.json');
    writeFileSync(crashPlanFile, JSON.stringify({ ...plan, runId: crashRun, roundDir: crashDir }));
    const crashArgs = ['--plan', crashPlanFile, '--lock-token', token];
    assert.equal(run('review-queue.mjs', ['init', ...crashArgs, '--concurrency', '1']).status, 0);
    const crashQueueFile = join(crashDir, 'queue.json');
    const crashQueue = JSON.parse(readFileSync(crashQueueFile, 'utf8'));
    Object.assign(crashQueue.tasks[0], { phase: 'preparing', attempts: 1 });
    writeFileSync(crashQueueFile, JSON.stringify(crashQueue));
    writeFileSync(join(crashDir, 'results', 'pr-1.json'), JSON.stringify({ ...result, runId: crashRun,
      enteredReview: false, reviewed: false, reviewClean: false, outcome: 'error', reason: 'interrupted before creation' }));
    const noTreeRecovery = run('review-queue.mjs', ['complete', ...crashArgs, '--pr', '1', '--agent-exited', '--no-agent-started']);
    assert.equal(noTreeRecovery.status, 0, noTreeRecovery.stdout + noTreeRecovery.stderr);
    assert.equal(JSON.parse(noTreeRecovery.stdout).allComplete, true);
    assert.equal(run('review-worktree.mjs', ['verify', ...crashArgs, '--pr', '1']).status, 0);

    // Exercise the actual planner while keeping only its context/GitHub boundaries mocked.
    const authority = { version: MAINTAINER_AUTHORITY_VERSION, repository: 'o/r', runToken: token,
      codeowners: { path: '.github/CODEOWNERS', org: 'o', teamSlug: 'maintainers', teamPrivacy: 'closed', repositoryPermission: 'push' },
      teamMembers: ['alice'], allowlistedMembers: [], members: ['alice'], teamMemberCount: 1, allowlistedMemberCount: 0, memberCount: 1 };
    writeFileSync(join(actualState, `maintainer-authority-${token}.json`), JSON.stringify({ ...authority, digest: computeMaintainerAuthorityDigest(authority) }));
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...raw[0], number: i + 1,
      head: (i + 1).toString(16).padStart(40, '0'), headRefName: `feature-${i + 1}`, url: `https://github.com/o/r/pull/${i + 1}` }));
    rows[1].baseRefName = 'feature-1';
    rows[5].baseRefName = 'release/1.x';
    const detail = Object.fromEntries(rows.map((p) => [p.number, { ok: true, pr: p.number,
      meta: { state: 'OPEN', headRefOid: p.head, baseRefOid: p.base, baseRefName: 'main', defaultBranch: 'main', body: 'Full PR description' },
      files: [{ path: 'fixture.txt', additions: 1, deletions: 0 }],
      history: { comments: [{ body: 'Full history retained' }], reviewThreads: [], commits: [] } }]));
    detail[1].meta.state = 'MERGED'; // Parent merged after the hook, while the planner was collecting.
    detail[3].meta.headRefOid = 'f'.repeat(40);
    detail[4] = { ok: false, pr: 4, error: 'fixture context failed' };
    detail[5].meta.body = 'Depends on x/y#99';
    detail[6].meta = { ...detail[6].meta, baseRefName: 'release/1.x', basePrLookup: { verified: true, reason: 'no-associated-pr' } };
    for (const pr of [7, 8, 9, 10]) {
      const merged = pr !== 8;
      detail[pr].meta = { ...detail[pr].meta, baseRefName: `parent-${pr}`, needsRetarget: merged,
        basePrLookup: { verified: true, reason: 'associated-pr' }, basePr: { number: 90 + pr, state: merged ? 'MERGED' : 'OPEN' } };
      detail[pr].notice = { ok: true, head: rows[pr - 1].head, baseRefName: `parent-${pr}`, defaultBranch: 'main',
        fingerprint: 'f'.repeat(64), posted: true, url: `https://github.com/o/r/pull/${pr}#issuecomment-1` };
    }
    detail[9].notice = { ok: false, error: 'fixture comment failed' };
    detail[10].notice = { ok: true, posted: false, reason: 'state-changed' };
    const contextsFile = join(directory, 'contexts.json');
    const contextCalls = join(directory, 'context-calls.jsonl');
    const contextScript = join(directory, 'emit-context.mjs');
    writeFileSync(contextsFile, JSON.stringify({ contexts: detail, states: { 'x/y#99': 'MERGED',
      'o/r#97': 'MERGED', 'o/r#98': 'OPEN', 'o/r#99': 'MERGED', 'o/r#100': 'MERGED' } }));
    const noticeScript = join(directory, 'emit-notice.mjs');
    const noticeCalls = join(directory, 'notice-calls.jsonl');
    writeFileSync(noticeScript, `import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(process.env.ROUND_MOCK_NOTICE_CALLS,JSON.stringify(args)+'\\n');
const result=JSON.parse(readFileSync(process.env.ROUND_MOCK_CONTEXTS,'utf8')).contexts[args[0]].notice;
process.stdout.write(JSON.stringify(result));
process.exitCode=result.ok?0:1;
`);
    writeFileSync(contextScript, `import {readFileSync,appendFileSync} from 'node:fs';
import {createContextEvidence,writeDiffFile} from ${JSON.stringify(new URL('./context-cache.mjs', import.meta.url).href)};
const pr=Number(process.argv[2]);
appendFileSync(process.env.ROUND_MOCK_CONTEXT_CALLS,JSON.stringify(pr)+'\\n');
const context=JSON.parse(readFileSync(process.env.ROUND_MOCK_CONTEXTS,'utf8')).contexts[pr];
if(context.ok){const diff='diff --git a/fixture.txt b/fixture.txt';const diffFile=process.argv[process.argv.indexOf('--diff-output')+1];writeDiffFile(diffFile,diff);context.evidence=createContextEvidence({repo:'o/r',pr,meta:context.meta,files:context.files,diff,diffFile});}
process.stdout.write(JSON.stringify(context));
`);
    const plannedManifest = createCandidateList({ repo: 'o/r', snapshot: rows });
    const plannedList = join(directory, 'planned-candidates.json');
    writeFileSync(plannedList, JSON.stringify(plannedManifest));
    const planArgs = ['--candidate-list', plannedList, '--mode', 'auto', '--lock-token', token];
    const planningEnv = { ROUND_MOCK_CONTEXTS: contextsFile, ROUND_MOCK_CONTEXT_SCRIPT: contextScript, ROUND_MOCK_CONTEXT_CALLS: contextCalls,
      ROUND_MOCK_NOTICE_SCRIPT: noticeScript, ROUND_MOCK_NOTICE_CALLS: noticeCalls };
    const planned = run('plan-review-round.mjs', planArgs, planningEnv);
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    const plannedOut = JSON.parse(planned.stdout);
    const frozen = JSON.parse(readFileSync(plannedOut.planFile, 'utf8'));
    assert.deepEqual(frozen.groups.map((g) => g.prs.length), [10, 2]);
    assert.deepEqual(frozen.skipped.map((p) => [p.pr, p.outcome]), [[1, 'state-changed'], [2, 'dependency'], [3, 'state-changed'], [4, 'error'],
      [7, 'retarget'], [8, 'dependency'], [9, 'retarget'], [10, 'state-changed']]);
    assert.equal(frozen.skipped.find((p) => p.pr === 7).targetBranchNotice.status, 'posted');
    assert.equal(frozen.skipped.find((p) => p.pr === 8).targetBranchNotice.status, 'posted');
    assert.equal(frozen.skipped.find((p) => p.pr === 9).targetBranchNotice.status, 'failed');
    assert.equal(frozen.skipped.find((p) => p.pr === 9).retry, true);
    const noticeArgs = readFileSync(noticeCalls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(noticeArgs.map((args) => Number(args[0])), [7, 8, 9, 10]);
    for (const args of noticeArgs) {
      assert.ok(args.includes('--target-branch'));
      assert.equal(args[args.indexOf('--lock-token') + 1], token);
      assert.equal(args[args.indexOf('--expected-base-ref') + 1], `parent-${args[0]}`);
      assert.equal(args[args.indexOf('--expected-head') + 1], rows[Number(args[0]) - 1].head);
    }
    const resumed = run('notify-round-targets.mjs', ['--plan', plannedOut.planFile, '--lock-token', token], planningEnv);
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.deepEqual(JSON.parse(resumed.stdout).results, []); // No repeated attempts, including failed notices.
    assert.equal(readFileSync(noticeCalls, 'utf8').trim().split('\n').length, 4);
    const legacy = JSON.parse(readFileSync(plannedOut.planFile, 'utf8'));
    const legacyItem = legacy.skipped.find((p) => p.pr === 7);
    delete legacyItem.defaultBranch;
    delete legacyItem.basePr;
    delete legacyItem.targetBranchNotice;
    writeFileSync(plannedOut.planFile, JSON.stringify(legacy));
    const fixtureData = JSON.parse(readFileSync(contextsFile, 'utf8'));
    Object.assign(fixtureData.contexts[7].notice, { posted: false, reason: 'already-commented' });
    writeFileSync(contextsFile, JSON.stringify(fixtureData));
    const migrated = run('notify-round-targets.mjs', ['--plan', plannedOut.planFile, '--lock-token', token], planningEnv);
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    const migratedItem = JSON.parse(readFileSync(plannedOut.planFile, 'utf8')).skipped.find((p) => p.pr === 7);
    assert.equal(migratedItem.defaultBranch, 'main');
    assert.equal(migratedItem.basePr.number, 97);
    assert.equal(migratedItem.targetBranchNotice.status, 'deduplicated');
    assert.deepEqual(readFileSync(contextCalls, 'utf8').trim().split('\n').map(JSON.parse).sort((a, b) => a - b), rows.map((p) => p.number));
    const savedDetail = JSON.parse(readFileSync(frozen.groups[0].prs[0].contextFile, 'utf8'));
    assert.equal(savedDetail.history.comments[0].body, 'Full history retained');
    assert.deepEqual(savedDetail.dependencies, [{ repo: 'x/y', number: 99, state: 'MERGED' }]);
    assert.match(readFileSync(frozen.groups[0].prs[0].diffFile, 'utf8'), /diff --git/);
    assert.equal(run('plan-review-round.mjs', planArgs, planningEnv).status, 1); // Never silently replace a frozen plan.
  } finally {
    // Verify the absolute target before recursive fixture cleanup on Windows.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('review-round-test-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

function gitFixture(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createTargetRepo(directory, owner = 'makecindy', name = 'cindy') {
  const repoRoot = join(directory, 'target');
  const remote = join(directory, 'remotes', owner, `${name}.git`).replaceAll('\\', '/');
  mkdirSync(repoRoot);
  mkdirSync(dirname(remote), { recursive: true });
  gitFixture(['init', '--bare', '--quiet', '--initial-branch=main', remote], directory);
  gitFixture(['init', '--quiet', '--initial-branch=main'], repoRoot);
  gitFixture(['config', 'user.name', 'Fixture'], repoRoot);
  gitFixture(['config', 'user.email', 'fixture@example.invalid'], repoRoot);
  gitFixture(['config', 'commit.gpgsign', 'false'], repoRoot);
  gitFixture(['remote', 'add', 'origin', remote], repoRoot);
  writeFileSync(join(repoRoot, 'fixture.txt'), 'fixture\n');
  gitFixture(['add', 'fixture.txt'], repoRoot);
  gitFixture(['commit', '--quiet', '-m', 'fixture'], repoRoot);
  gitFixture(['push', '--quiet', 'origin', 'HEAD:refs/pull/1/head'], repoRoot);
  return { repoRoot, remote, head: gitFixture(['rev-parse', 'HEAD'], repoRoot) };
}

function writeSnapshotMock(directory) {
  const mock = join(directory, 'snapshot-gh-mock.mjs');
  writeFileSync(mock, `import {readFileSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=childProcess.spawnSync;
childProcess.spawnSync=(command,args,options)=>{
  if(command!=='gh') return original(command,args,options);
  if(args[0]!=='api'||args[1]!=='graphql') throw new Error('unexpected gh call');
  const raw=JSON.parse(readFileSync(process.env.ROUND_MOCK_SNAPSHOT,'utf8'));
  const nodes=raw.map(p=>({...p,headRepository:p.headRepository?{nameWithOwner:p.headRepository}:null,
    headRefOid:p.head,baseRefOid:p.base,author:{login:'author'},
    reviewThreads:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[]},
    commits:{nodes:[{commit:{statusCheckRollup:{state:p.ci}}}]}}));
  const stdout=JSON.stringify({data:{repository:{pullRequests:{totalCount:nodes.length,
    pageInfo:{hasNextPage:false,endCursor:null},nodes}}}});
  return {status:0,signal:null,stdout,stderr:'',output:[null,stdout,'']};
};
syncBuiltinESMExports();\n`);
  return mock;
}

test('pre-check restores only a missing makecindy/cindy state and keeps local state authoritative', () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-history-restore-cli-'));
  try {
    const { repoRoot, head } = createTargetRepo(directory);
    const snapshotFile = join(directory, 'snapshot.json');
    const now = new Date().toISOString();
    const snapshot = [{ number: 1, title: 'fixture', url: 'https://github.com/makecindy/cindy/pull/1',
      createdAt: now, author: 'author', baseRefName: 'main', headRefName: 'feature',
      headRepository: 'makecindy/cindy', base: 'b'.repeat(40), head, updatedAt: now, isDraft: false,
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, unresolved: 0, ci: 'SUCCESS' }];
    writeFileSync(snapshotFile, JSON.stringify(snapshot));
    const skillRoot = join(directory, 'skills', 'review-pr');
    const historyFile = join(skillRoot, 'history', 'makecindy-cindy', 'round-state.json');
    mkdirSync(dirname(historyFile), { recursive: true });
    const historyState = { version: 1, mode: 'auto', prs: { 1: {
      fingerprint: candidateFingerprint(snapshot[0], snapshot), checkedAt: now,
      outcome: 'findings', reason: 'fixture finding', reviewClean: false, retry: false, retryAt: null,
      sessionId: 'must-not-restore', requestFile: '/tmp/must-not-restore.json',
    } } };
    writeFileSync(historyFile, JSON.stringify({ version: 1, repo: 'makecindy/cindy', mode: 'auto',
      runId: 'history-baseline', updatedAt: now, state: historyState }));
    const mock = writeSnapshotMock(directory);
    const baseEnv = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(mock).href}`].filter(Boolean).join(' '), REVIEW_PR_REPO_ROOT: repoRoot,
      REVIEW_PR_SKILL_ROOT: skillRoot, ROUND_MOCK_SNAPSHOT: snapshotFile };
    delete baseEnv.REVIEW_PR_PREFLIGHT_SKILL_SYNC;
    const invoke = (stateRoot) => spawnSync(process.execPath,
      [fileURLToPath(new URL('./pre-check.mjs', import.meta.url)), '--repo-root', repoRoot],
      { cwd: repoRoot, env: { ...baseEnv, REVIEW_PR_STATE_DIR: stateRoot }, encoding: 'utf8', windowsHide: true });

    const restored = invoke(join(directory, 'state-restored'));
    assert.equal(restored.status, 2, restored.stdout + restored.stderr);
    const restoredOut = JSON.parse(restored.stdout);
    assert.equal(restoredOut.candidateCount, 0);
    assert.equal(restoredOut.historyRestore.restored, true);
    assert.equal(restoredOut.historyRestore.source, 'git-history');
    assert.deepEqual(JSON.parse(readFileSync(restoredOut.candidateList, 'utf8')).historyRestore,
      restoredOut.historyRestore);
    const localStateFile = join(dirname(restoredOut.candidateList), 'round-state.json');
    const localText = readFileSync(localStateFile, 'utf8');
    assert.equal(localText.includes('must-not-restore'), false);
    assert.equal(localText.includes('/tmp/'), false);

    const localState = JSON.parse(localText);
    localState.prs['1'].fingerprint = 'local-authoritative-state';
    writeFileSync(localStateFile, JSON.stringify(localState));
    const local = invoke(join(directory, 'state-restored'));
    assert.equal(local.status, 0, local.stdout + local.stderr);
    const localOut = JSON.parse(local.stdout);
    assert.equal(localOut.candidateCount, 1);
    assert.equal(localOut.historyRestore.source, 'local');
    assert.equal(JSON.parse(readFileSync(localStateFile, 'utf8')).prs['1'].fingerprint,
      'local-authoritative-state');

    writeFileSync(historyFile, JSON.stringify({ version: 1, repo: 'other/repo', mode: 'auto',
      runId: 'wrong-repo', updatedAt: now, state: historyState }));
    const rejected = invoke(join(directory, 'state-rejected'));
    assert.equal(rejected.status, 0, rejected.stdout + rejected.stderr);
    const rejectedOut = JSON.parse(rejected.stdout);
    assert.equal(rejectedOut.candidateCount, 1);
    assert.match(rejectedOut.historyRestore.reason, /^history-invalid:/);
    assert.equal(existsSync(join(dirname(rejectedOut.candidateList), 'round-state.json')), false);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('allowlisted finalize publishes history before succeeding and safely retries the same runtime summary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-history-finalize-cli-'));
  try {
    const { repoRoot } = createTargetRepo(directory);
    const skillsRepo = join(directory, 'skills');
    const skillRoot = join(skillsRepo, 'review-pr');
    const skillsRemote = join(directory, 'skills.git');
    mkdirSync(skillRoot, { recursive: true });
    gitFixture(['init', '--quiet', '--initial-branch=main'], skillsRepo);
    gitFixture(['config', 'user.name', 'Fixture'], skillsRepo);
    gitFixture(['config', 'user.email', 'fixture@example.invalid'], skillsRepo);
    gitFixture(['config', 'commit.gpgsign', 'false'], skillsRepo);
    gitFixture(['init', '--bare', '--quiet', '--initial-branch=main', skillsRemote], directory);
    gitFixture(['remote', 'add', 'origin', skillsRemote], skillsRepo);
    writeFileSync(join(skillRoot, 'fixture.txt'), 'fixture\n');
    gitFixture(['add', '.'], skillsRepo);
    gitFixture(['commit', '--quiet', '-m', 'fixture'], skillsRepo);
    gitFixture(['push', '--quiet', '--set-upstream', 'origin', 'main'], skillsRepo);
    gitFixture(['remote', 'set-url', 'origin', join(directory, 'offline', 'skills.git')], skillsRepo);

    const env = { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot,
      REVIEW_PR_STATE_DIR: join(directory, 'state'), REVIEW_PR_SKILL_ROOT: skillRoot };
    const run = (script, args = []) => spawnSync(process.execPath,
      [fileURLToPath(new URL(script, import.meta.url)), ...args],
      { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const stateResult = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {STATE_DIR} from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)}; process.stdout.write(STATE_DIR);`],
    { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
    assert.equal(stateResult.status, 0, stateResult.stderr);
    const actualState = stateResult.stdout;
    const token = 'history-finalize-lock';
    writeFileSync(join(actualState, 'lock.json'), JSON.stringify({ token, startedAt: new Date().toISOString() }));
    const manifest = createCandidateList({ repo: 'makecindy/cindy', snapshot: [], runId: 'history-finalize-round' });
    const roundDir = join(actualState, `round-${manifest.runId}`);
    mkdirSync(join(roundDir, 'results'), { recursive: true });
    const planFile = join(roundDir, 'plan.json');
    const plan = { ...makeReviewPlan(manifest, []), roundDir, summaryChat: { chatId: 'fixture-chat' } };
    writeFileSync(planFile, JSON.stringify(plan));
    const finishArgs = ['--plan', planFile, '--lock-token', token];
    const queue = (action) => run('review-queue.mjs', [action, ...finishArgs, ...(action === 'init' ? ['--concurrency', '1'] : [])]);
    assert.equal(queue('init').status, 0);
    assert.equal(queue('reconcile').status, 0);

    const failed = run('finalize-review-round.mjs', finishArgs);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.equal(existsSync(join(roundDir, 'finalized.json')), false);
    assert.equal(existsSync(join(roundDir, 'summary.json')), true);
    assert.equal(existsSync(join(actualState, 'runs.jsonl')), false);
    const summaryBeforeRetry = readFileSync(join(roundDir, 'summary.json'), 'utf8');
    const historyBase = join(skillRoot, 'history', 'makecindy-cindy');
    assert.equal(readFileSync(join(historyBase, 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);

    writeFileSync(join(roundDir, 'summary.json'), '{broken-runtime-summary');
    const corruptRetry = run('finalize-review-round.mjs', finishArgs);
    assert.equal(corruptRetry.status, 1, corruptRetry.stdout + corruptRetry.stderr);
    assert.match(JSON.parse(corruptRetry.stdout).error, /Summary.*(损坏|解析)/);
    assert.equal(readFileSync(join(roundDir, 'summary.json'), 'utf8'), '{broken-runtime-summary');
    writeFileSync(join(roundDir, 'summary.json'), summaryBeforeRetry);

    gitFixture(['remote', 'set-url', 'origin', skillsRemote], skillsRepo);
    const retried = run('finalize-review-round.mjs', finishArgs);
    assert.equal(retried.status, 0, retried.stdout + retried.stderr);
    const retriedOut = JSON.parse(retried.stdout);
    assert.equal(retriedOut.history.ok, true);
    assert.equal(retriedOut.history.enabled, true);
    assert.equal(retriedOut.history.sync.pushed, true);
    assert.equal(readFileSync(join(roundDir, 'summary.json'), 'utf8'), summaryBeforeRetry);
    assert.equal(readFileSync(join(historyBase, 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.equal(readFileSync(join(actualState, 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.equal(existsSync(join(roundDir, 'finalized.json')), true);
    const firstLoggedAt = retriedOut.loggedAt;
    const cards = JSON.parse(readFileSync(join(roundDir, 'feishu-cards.json'), 'utf8'));
    assert.equal(cards.receive_id_type, 'chat_id');
    assert.equal(cards.receive_id, 'fixture-chat');
    assert.equal(cards.pages.length, 1);
    assert.match(gitFixture(['show', 'origin/main:review-pr/history/makecindy-cindy/runs.jsonl'], skillsRepo),
      /history-finalize-round/);

    unlinkSync(join(roundDir, 'finalized.json'));
    const crashRetry = run('finalize-review-round.mjs', finishArgs);
    assert.equal(crashRetry.status, 0, crashRetry.stdout + crashRetry.stderr);
    assert.equal(JSON.parse(crashRetry.stdout).loggedAt, firstLoggedAt);
    assert.equal(readFileSync(join(actualState, 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.equal(readFileSync(join(historyBase, 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
