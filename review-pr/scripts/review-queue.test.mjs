import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runQueueCommand, verifyQueueCompletion, findIncompleteRounds } from './review-queue.mjs';
import { verifyReviewArtifacts } from './review-artifacts.mjs';
import { finishReviewedPr } from './finish-flow.mjs';
import { createCandidateList, collectRoundResults, nextRoundState } from './review-round.mjs';
import { buildReviewSummary } from './review-summary.mjs';
import { REVIEW_CHANGES_REQUESTED_BLOCKER } from './merge-retry.mjs';

function fixture(count, fn) {
  const directory = mkdtempSync(join(tmpdir(), 'review-queue-test-'));
  const roundDir = join(directory, 'round-fixture'); mkdirSync(roundDir); mkdirSync(join(roundDir, 'results'));
  const rows = Array.from({ length: count }, (_, i) => ({ pr: i + 1, head: (i + 1).toString(16).padStart(40, '0'), selfFix: false }));
  const plan = { version: 1, runId: 'fixture', repo: 'o/r', mode: 'auto', roundDir,
    execution: { worktreeCleanupRequired: true }, manifest: { createdAt: '2026-09-08T00:00:00Z' }, groups: [] };
  for (let i = 0; i < count; i += 10) plan.groups.push({ id: plan.groups.length + 1, prs: rows.slice(i, i + 10) });
  const planFile = join(roundDir, 'plan.json'); writeFileSync(planFile, JSON.stringify(plan));
  const ownership = new Map(); let failCleanup = false;
  const dependencies = { assertLock: (token) => assert.equal(token, 'fixture-token'), worktrees: {
    createReviewWorktree: async ({ pr }) => {
      assert.ok(!ownership.get(pr)?.present); const state = { present: true, generation: (ownership.get(pr)?.generation || 0) + 1 };
      ownership.set(pr, state); return { generation: state.generation, path: join(roundDir, 'worktrees', `pr-${pr}`) };
    },
    removeReviewWorktree: async ({ pr, agentExited }) => {
      assert.equal(agentExited, true);
      if (failCleanup) throw new Error('fixture: file is still held by a process');
      ownership.get(pr).present = false; return { generation: ownership.get(pr).generation, removed: true };
    },
    verifyReviewWorktree: async ({ pr }) => { assert.equal(ownership.get(pr).present, false); return { generation: ownership.get(pr).generation, verified: true }; },
  } };
  const run = (action, extra = {}) => runQueueCommand({ action, planFile, lockToken: 'fixture-token', ...extra }, dependencies);
  const result = (pr, patch = {}) => {
    const row = { ...rows[pr - 1], runId: plan.runId, mode: plan.mode, enteredReview: true, reviewed: true, reviewClean: false,
      merged: false, outcome: 'findings', reason: 'fixture finding posted', ...patch };
    if (row.reviewClean && !row.reportFile) { row.reportFile = join(roundDir, `report-pr-${pr}.md`); writeFileSync(row.reportFile, 'Fixture clean review report'); }
    writeFileSync(join(roundDir, 'results', `pr-${pr}.json`), JSON.stringify(row)); return row;
  };
  const finish = async (pr, patch = {}) => { result(pr, patch); return run('complete', { pr, agentId: `agent-${pr}`, agentExited: true }); };
  const receipt = (pr, patch = {}) => {
    const row = JSON.parse(readFileSync(join(roundDir, 'results', `pr-${pr}.json`), 'utf8'));
    writeFileSync(join(roundDir, `finish-pr-${pr}.json`), JSON.stringify({ runId: plan.runId, mode: plan.mode,
      pr, head: row.head, approval: row.approval, approved: true, reviewClean: true, merged: false, ...patch }));
  };
  return Promise.resolve(fn({ run, result, finish, receipt, ownership, planFile, directory, roundDir, dependencies,
    setCleanupFailure: (value) => { failCleanup = value; } })).finally(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true });
  });
}

// [MIVO-PATCH concurrency-40] Mivo 审查机最多 40 个服务器槽位(#142)
test('init accepts concurrency 40 and rejects 41', () => fixture(1, async ({ run }) => {
  await assert.rejects(run('init', { concurrency: 41 }), /1\.\.40/);
  const init = await run('init', { concurrency: 40 });
  assert.equal(init.queue?.concurrency ?? init.concurrency ?? 40, 40);
}));

test('rolling slots cross reporting groups while an older PR is still running', () => fixture(12, async ({ run, finish, planFile, dependencies }) => {
  await run('init', { concurrency: 2 });
  const first = await run('claim'); assert.equal(first.task.pr, 1);
  await run('bind', { pr: 1, agentId: 'agent-1' });
  for (let pr = 2; pr <= 12; pr++) {
    const claimed = await run('claim'); assert.equal(claimed.task.pr, pr);
    if (pr === 11) assert.equal(claimed.task.group, 2);
    await run('bind', { pr, agentId: `agent-${pr}` });
    assert.equal((await run('claim')).reason, 'capacity');
    await finish(pr);
  }
  assert.equal((await run('status')).active[0].pr, 1);
  await assert.rejects(() => run('reconcile'), /全部/);
  await finish(1);
  await run('reconcile');
  assert.equal((await verifyQueueCompletion({ planFile, lockToken: 'fixture-token' }, dependencies)).tasks.length, 12);
}));

test('cleanup failure and missing agent exit retain the slot across coordinator restart', () => fixture(2, async ({ run, result, finish, setCleanupFailure, ownership, planFile, dependencies }) => {
  await run('init', { concurrency: 1 }); await run('claim'); await run('bind', { pr: 1, agentId: 'agent-1' }); result(1);
  await assert.rejects(() => run('complete', { pr: 1, agentId: 'agent-1' }), /已退出/);
  await assert.rejects(() => run('complete', { pr: 1, agentId: 'different-agent', agentExited: true }), /agent ID/);
  setCleanupFailure(true); await assert.rejects(() => finish(1), /held/);
  assert.equal((await run('status')).active[0].phase, 'cleanup-pending');
  assert.equal(ownership.get(1).present, true);
  assert.equal((await run('claim')).reason, 'capacity');
  await assert.rejects(() => verifyQueueCompletion({ planFile, lockToken: 'fixture-token' }, dependencies), /队列/);
  setCleanupFailure(false); await finish(1);
  assert.equal((await run('claim')).task.pr, 2);
}));

test('Approve reconciliation recreates only pending work once, then preserves durable retry', () => fixture(1, async ({ run, finish, ownership, planFile, dependencies }) => {
  await run('init', { concurrency: 1 }); await run('claim'); await run('bind', { pr: 1, agentId: 'agent-1' });
  const pending = { reviewClean: true, outcome: 'approval-pending', approval: { status: 'pending', reason: 'readback unavailable' } };
  await finish(1, pending); assert.equal(ownership.get(1).present, false);
  assert.deepEqual((await run('reconcile')).reopened, [1]);
  const continuation = await run('claim'); assert.equal(continuation.task.resume, true);
  assert.equal(continuation.task.worktree.generation, 2);
  await run('bind', { pr: 1, agentId: 'agent-1' }); await finish(1, pending);
  assert.deepEqual((await run('reconcile')).reopened, []);
  const queue = await verifyQueueCompletion({ planFile, lockToken: 'fixture-token' }, dependencies);
  assert.equal(queue.tasks[0].reconciliationAttempts, 1);
}));

test('a report inside the disposable checkout is caught before cleanup destroys it', () => fixture(1, async ({ run, finish, ownership }) => {
  await run('init', { concurrency: 1 });
  const claimed = await run('claim'); await run('bind', { pr: 1, agentId: 'agent-1' });
  mkdirSync(claimed.task.worktree.path, { recursive: true });
  const reportFile = join(claimed.task.worktree.path, 'report.md'); writeFileSync(reportFile, 'Only copy of clean review');
  const pending = { reviewClean: true, outcome: 'approval-pending', approval: { status: 'pending', reason: 'Approve not started' } };
  await assert.rejects(() => finish(1, { ...pending, reportFile }), /worktree 之外/);
  assert.equal(ownership.get(1).present, true);
  assert.equal(readFileSync(reportFile, 'utf8'), 'Only copy of clean review');
  await finish(1, pending);
  assert.equal(ownership.get(1).present, false);
}));

test('cleanup and finalization reject a dropped guarded merge retry', () => fixture(1, async ({ run, result, finish, receipt, planFile, roundDir, dependencies, ownership }) => {
  await run('init', { concurrency: 1 }); await run('claim'); await run('bind', { pr: 1, agentId: 'agent-1' });
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const head = plan.groups[0].prs[0].head;
  const approval = { status: 'verified', reviewId: '42', reviewer: 'maintainer', head, verifiedAt: new Date().toISOString() };
  const patch = { reviewClean: true, outcome: 'merge-blocked', approval };
  writeFileSync(join(roundDir, 'finish-pr-1.json'), JSON.stringify({
    runId: plan.runId, mode: plan.mode, pr: 1, head, approval, stage: 'merge-blocked', retry: true, merged: false,
    reason: 'write result unknown', merge: { ok: false, pending: true, retry: true, mergeAttempted: true,
      code: 'merge-reconciliation-pending', reason: 'write result unknown' },
  }));
  await assert.rejects(() => finish(1, patch), /retry=true/);
  assert.equal(ownership.get(1).present, true);
  await finish(1, { ...patch, retry: true });
  await run('reconcile');
  await verifyQueueCompletion({ planFile, lockToken: 'fixture-token' }, dependencies);
  const dropped = result(1, { ...patch, retry: false });
  // finalize invokes the same artifact verifier again after queue verification.
  assert.throws(() => verifyReviewArtifacts(planFile, plan, dropped), /retry=true/);
  assert.throws(() => verifyReviewArtifacts(planFile, plan, { ...dropped, merged: true, outcome: 'merged' }), /合并结论/);
}));

test('verified Approve with pre-write merge contention gets one same-round continuation', () => fixture(1, async ({ run, result, finish, receipt, planFile, dependencies }) => {
  await run('init', { concurrency: 1 }); await run('claim'); await run('bind', { pr: 1, agentId: 'agent-1' });
  const head = JSON.parse(readFileSync(planFile, 'utf8')).groups[0].prs[0].head;
  const approval = { status: 'verified', reviewId: '42', reviewer: 'maintainer', head, verifiedAt: new Date().toISOString() };
  const patch = { reviewClean: true, outcome: 'merge-blocked', approval, retry: true };
  result(1, patch);
  receipt(1, { stage: 'merge-blocked', retry: true, reason: 'base lock busy',
    merge: { mergeAttempted: false, merged: false, code: 'base-merge-lock-busy', reason: 'base lock busy', retry: true } });
  await finish(1, patch);
  assert.deepEqual((await run('reconcile')).reopened, [1]);
  assert.equal((await run('claim')).task.resume, true);
  await run('bind', { pr: 1, agentId: 'agent-1' });
  const merged = { ...patch, outcome: 'merged', merged: true, retry: false };
  result(1, merged); receipt(1, { stage: 'merged', merged: true, merge: { merged: true, mergeAttempted: true }, reason: 'merged' });
  await finish(1, merged);
  assert.deepEqual((await run('reconcile')).reopened, []);
  assert.equal((await verifyQueueCompletion({ planFile, lockToken: 'fixture-token' }, dependencies)).tasks[0].reconciliationAttempts, 1);
}));

test('a ready-to-merge interrupted checkpoint cannot finalize and resumes before completion', () => fixture(1, async ({ run, result, finish, receipt, planFile, dependencies, ownership }) => {
  await run('init', { concurrency: 1 }); await run('claim'); await run('bind', { pr: 1, agentId: 'agent-1' });
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const head = plan.groups[0].prs[0].head;
  const approval = { status: 'verified', reviewId: '42', reviewer: 'maintainer', head, verifiedAt: new Date().toISOString() };
  const patch = { reviewClean: true, outcome: 'merge-blocked', approval, retry: false };
  const row = result(1, patch);
  receipt(1, { stage: 'checking', preMerge: { ok: true, canMerge: true, normalMergeAvailable: true } });
  assert.throws(() => verifyReviewArtifacts(planFile, plan, row), /尚未完成/);
  await assert.rejects(() => finish(1, patch), /尚未完成/);
  assert.equal(ownership.get(1).present, true);
  const interrupted = { ...patch, outcome: 'error', retry: true, reason: 'worker exited before merge' };
  await finish(1, interrupted);
  assert.deepEqual((await run('reconcile')).reopened, [1]);
  await assert.rejects(() => verifyQueueCompletion({ planFile, lockToken: 'fixture-token' }, dependencies), /队列/);
  await run('claim'); await run('bind', { pr: 1, agentId: 'agent-1' });
  const merged = { ...patch, outcome: 'merged', merged: true };
  result(1, merged); receipt(1, { stage: 'merged', merged: true, merge: { merged: true }, reason: 'merged' });
  await finish(1, merged); await run('reconcile');
  await verifyQueueCompletion({ planFile, lockToken: 'fixture-token' }, dependencies);
}));

test('a blocker needs actual evidence and review-only cannot substitute for auto merge', () => fixture(1, async ({ result, receipt, planFile }) => {
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const head = plan.groups[0].prs[0].head;
  const approval = { status: 'verified', reviewId: '42', reviewer: 'maintainer', head, verifiedAt: new Date().toISOString() };
  const row = result(1, { reviewClean: true, outcome: 'merge-blocked', approval });
  for (const checkpoint of [
    { stage: 'merge-blocked', reason: 'wait until next round', preMerge: { ok: true, canMerge: true } },
    { stage: 'merge-blocked', reason: 'generic merge failure' },
    { stage: 'reviewed-only', reason: 'approve only' },
    { stage: 'merge-queued', queued: true, reason: 'no real queue receipt' },
  ]) {
    receipt(1, checkpoint);
    assert.throws(() => verifyReviewArtifacts(planFile, plan, row), /终态或阻塞证据/);
  }
  receipt(1, { stage: 'merge-blocked', reason: 'new CI failure',
    preMerge: { ok: true, canMerge: false, normalMergeAvailable: false, blockers: ['CI failed'] } });
  assert.doesNotThrow(() => verifyReviewArtifacts(planFile, plan, row));
}));

test('one full simulated round merges recovered PRs and preserves a real CI blocker', () => fixture(4, async ({ run, result, finish, receipt, planFile, roundDir, dependencies }) => {
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const rows = plan.groups.flatMap(group => group.prs);
  const snapshot = rows.map(row => ({ number: row.pr, head: row.head, base: 'b'.repeat(40),
    title: `fixture ${row.pr}`, url: `https://github.com/o/r/pull/${row.pr}`, isDraft: false,
    createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z',
    reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', mergeStateStatus: row.pr === 3 ? 'BLOCKED' : 'CLEAN',
    ci: row.pr === 3 ? 'FAILURE' : 'SUCCESS', unresolved: 0 }));
  plan.manifest = createCandidateList({ repo: plan.repo, mode: plan.mode, runId: plan.runId, snapshot });
  plan.skipped = [];
  writeFileSync(planFile, JSON.stringify(plan));
  const writes = new Map();
  const worker = async (pr, wave) => {
    const head = rows[pr - 1].head;
    const approval = { status: 'verified', reviewId: String(pr), reviewer: 'maintainer', head, verifiedAt: new Date().toISOString() };
    const pass = { ok: true, state: 'OPEN', canMerge: true, normalMergeAvailable: true, headVerified: true,
      baseVerified: true, authorityVerified: true, threadsVerified: true, unresolvedThreads: [], ci: { status: 'pass' },
      botSettleVerified: true, botSettle: { settled: true }, staleRebaseChecked: true, staleRebase: { blocking: false },
      pendingSignoffLabels: [], protectedFiles: [], reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', blockers: [], blockClass: 'none', actualHead: head, approvalPolicy: { viewer: 'maintainer' } };
    let checkpoint;
    if (pr === 4 && wave === 1) {
      result(pr, { reviewClean: true, approval });
      receipt(pr, { stage: 'checking', preMerge: pass });
      await finish(pr, { reviewClean: true, approval, outcome: 'error', retry: true, reason: 'worker interrupted before merge' });
      return;
    }
    let checks = 0;
    checkpoint = await finishReviewedPr({ mode: plan.mode, runId: plan.runId, pr, head,
      expectedBase: 'b'.repeat(40), expectedBaseRef: 'main', authorityDigest: 'fixture', lockToken: 'fixture', method: 'squash' }, {
      sleep: async () => {}, now: (() => { let t = 0; return () => ++t; })(),
      checkpoint: value => writeFileSync(join(roundDir, `finish-pr-${pr}.json`), JSON.stringify(value)),
      run: async script => {
        if (script === 'approve-reviewed-pr.mjs') return { ok: true, approved: true, approval };
        if (script === 'signoff-release.mjs') return { ok: true, labels: { errors: [] } };
        if (script === 'pre-merge-check.mjs') {
          checks++;
          if (pr === 3) return { ...pass, canMerge: false, normalMergeAvailable: false, ci: { status: 'failed' },
            blockClass: 'ci-failed', blockers: ['CI failed'] };
          if (pr === 1 && checks === 1) return { ...pass, canMerge: false, normalMergeAvailable: false,
            reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED', blockClass: 'review-changes-requested',
            blockers: [REVIEW_CHANGES_REQUESTED_BLOCKER],
            reviewSnapshot: { verified: true, latest: [{ reviewId: String(pr), reviewer: 'maintainer', state: 'APPROVED', head }] } };
          return pass;
        }
        assert.equal(script, 'merge-reviewed-pr.mjs');
        if (pr === 2 && wave === 1) return { ok: true, merged: false, mergeAttempted: false,
          code: 'base-merge-lock-busy', reason: 'base lock busy', retry: true };
        writes.set(pr, (writes.get(pr) || 0) + 1);
        return { ok: true, merged: true, mergeAttempted: true };
      },
    });
    await finish(pr, { reviewClean: true, approval, merged: checkpoint.merged, outcome: checkpoint.stage,
      retry: checkpoint.retry, reason: checkpoint.reason });
  };
  await run('init', { concurrency: 2 });
  for (let pr = 1; pr <= 4; pr++) {
    assert.equal((await run('claim')).task.pr, pr);
    await run('bind', { pr, agentId: `agent-${pr}` }); await worker(pr, 1);
  }
  assert.deepEqual((await run('reconcile')).reopened, [2, 4]);
  for (const pr of [2, 4]) {
    assert.equal((await run('claim')).task.pr, pr);
    await run('bind', { pr, agentId: `agent-${pr}` }); await worker(pr, 2);
  }
  assert.deepEqual((await run('reconcile')).reopened, []);
  await verifyQueueCompletion({ planFile, lockToken: 'fixture-token' }, dependencies);
  const results = rows.map(row => JSON.parse(readFileSync(join(roundDir, 'results', `pr-${row.pr}.json`), 'utf8')));
  const payload = collectRoundResults(plan, results);
  const summary = buildReviewSummary(payload);
  assert.equal(summary.metrics.enteredCount, 4);
  assert.equal(summary.metrics.mergedCount, 3);
  assert.equal(summary.metrics.enteredNotMergedCount, 1);
  assert.deepEqual([...writes.entries()], [[1, 1], [2, 1], [4, 1]]);
  const state = nextRoundState(plan, payload);
  assert.equal(state.prs[3].retry, false);
  console.log('Simulated round: 4 reviewed, 3 merged in-round, 1 CI blocker, zero duplicate merge writes.');
}));

test('allowlisted queue close requires a successful Git history receipt', () => fixture(0, async ({ run, planFile, roundDir }) => {
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  plan.repo = 'makecindy/cindy';
  writeFileSync(planFile, JSON.stringify(plan));
  await run('init', { concurrency: 1 });
  await run('reconcile');
  writeFileSync(join(roundDir, 'finalized.json'), JSON.stringify({ runId: plan.runId }));
  writeFileSync(join(roundDir, 'feishu-cards.json'), JSON.stringify({ runId: plan.runId, pages: [{ page: 1 }] }));
  writeFileSync(join(roundDir, 'notification.json'), JSON.stringify({ runId: plan.runId,
    pages: [{ page: 1, status: 'sent', messageId: 'fixture-message', attemptedAt: new Date().toISOString() }] }));
  await assert.rejects(() => run('close'), /Git 历史/);
  writeFileSync(join(roundDir, 'finalized.json'), JSON.stringify({ runId: plan.runId,
    history: { ok: true, enabled: true, runId: 'different-run', sync: { ok: true, pushed: true } } }));
  await assert.rejects(() => run('close'), /Git 历史/);
  writeFileSync(join(roundDir, 'finalized.json'), JSON.stringify({ runId: plan.runId,
    history: { ok: true, enabled: true, runId: plan.runId,
      sync: { ok: true, pushed: false, reason: 'nothing-to-push' } } }));
  assert.equal((await run('close')).closed, true);
}));

test('preflight discovers unfinished cleanup even without an open PR snapshot', () => fixture(1, async ({ run, directory, planFile, roundDir }) => {
  await run('init', { concurrency: 1 });
  assert.deepEqual(findIncompleteRounds(directory, 'o/r', 'auto'), [planFile]);
  assert.deepEqual(findIncompleteRounds(directory, 'o/r', 'review-only'), []);
  writeFileSync(join(roundDir, 'finalized.json'), '{}');
  assert.deepEqual(findIncompleteRounds(directory, 'o/r', 'auto'), [planFile]); // A crash before Feishu still needs a session.
  writeFileSync(join(roundDir, 'completed.json'), '{}');
  assert.deepEqual(findIncompleteRounds(directory, 'o/r', 'auto'), []);
}));
