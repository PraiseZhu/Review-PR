import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isReviewHistoryEnabled,
  publishReviewHistory,
  restoreReviewHistoryState,
} from './review-history.mjs';
import { atomicWriteText } from './runtime-io.mjs';

const summary = (patch = {}) => ({
  version: 1,
  runId: 'run-one',
  mode: 'auto',
  generatedAt: '2026-09-09T00:00:00.000Z',
  repo: 'makecindy/cindy',
  coverageComplete: true,
  validationErrors: [],
  metrics: { currentPrCount: 4, candidateCount: 3, enteredCount: 2, mergedCount: 1, enteredNotMergedCount: 1 },
  review: {
    eligibleCount: 4, enteredCount: 2, notEnteredCount: 2, coverageComplete: true,
    entered: [{ pr: 1, title: 'merged', url: 'https://github.com/makecindy/cindy/pull/1',
      requestFile: '/tmp/review-request.json', arbitraryRuntimePath: '/private/tmp/context.json' },
      { pr: 2, title: 'not merged', url: 'https://github.com/makecindy/cindy/pull/2' }],
    notEntered: [{ pr: 3, reason: 'blocked', fixHandoff: { status: 'dispatched', sessionId: 'secret-session',
      reason: 'follow-up', requestFile: '/tmp/fix-request.json', sourceFile: '/tmp/fix-evidence.json' } }, { pr: 4 }],
    unchangedCount: 0, draftCount: 0,
  },
  merge: {
    mergedCount: 1, notMergedCount: 3,
    merged: [{ pr: 1, title: 'merged', url: 'https://github.com/makecindy/cindy/pull/1', reportFile: '/tmp/report.md' }],
    notMerged: [{ pr: 2 }, { pr: 3, fixHandoff: { status: 'dispatched', sessionId: 'secret-session',
      reason: 'follow-up', requestFile: '/tmp/fix-request.json' } }, { pr: 4 }],
    notMergedGroups: [],
  },
  policyViolations: [], errors: [], notes: [
    '#1911: liveContextFile=/var/folders/example/review-pr/pr-1911-live.json',
    'agentId=secret-inline-agent sessionId=secret-inline-session messageId=secret-inline-message',
  ],
  runtimeMetadata: { agentId: 'secret-agent', messageId: 'secret-message', path: '/tmp/runtime' },
  ...patch,
});

const state = (mode = 'auto') => ({
  version: 1,
  mode,
  prs: { 1: { fingerprint: 'fingerprint-one', dependencyPrs: [2], checkedAt: '2026-09-09T00:00:00.000Z',
    outcome: 'merged', reason: 'merged', reviewClean: true,
    approval: { status: 'verified', reviewId: '42', reviewer: 'maintainer',
      head: '0123456789012345678901234567890123456789', verifiedAt: '2026-09-09T00:00:00.000Z',
      url: 'https://github.com/makecindy/cindy/pull/1#pullrequestreview-42' },
    fixHandoff: { status: 'dispatched', fingerprint: 'head|cause', reason: 'follow-up',
      sessionId: 'secret-session', requestFile: '/tmp/fix-request.json' },
    retry: false, retryAt: null,
    requestFile: '/tmp/review-request.json', agentId: 'secret-agent' },
    2: { fingerprint: 'fingerprint-two', outcome: 'error',
      reason: 'reportFile=/private/tmp/reviewer.md lockToken=secret-inline-token' } },
});

const safeState = (mode = 'auto') => ({
  version: 1,
  mode,
  prs: { 1: { fingerprint: 'fingerprint-one', dependencyPrs: [2], checkedAt: '2026-09-09T00:00:00.000Z',
    outcome: 'merged', reason: 'merged', reviewClean: true,
    approval: { status: 'verified', reviewId: '42', reviewer: 'maintainer',
      head: '0123456789012345678901234567890123456789', verifiedAt: '2026-09-09T00:00:00.000Z',
      url: 'https://github.com/makecindy/cindy/pull/1#pullrequestreview-42' },
    fixHandoff: { status: 'dispatched', fingerprint: 'head|cause', reason: 'follow-up' },
    retry: false, retryAt: null },
    2: { fingerprint: 'fingerprint-two', outcome: 'error',
      reason: 'reportFile=[redacted] lockToken=[redacted]' } },
});

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'review-history-test-'));
  const skillRoot = join(root, 'review-pr');
  mkdirSync(skillRoot, { recursive: true });
  try { return fn({ root, skillRoot }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('durable atomic text writer replaces content with private permissions', () => fixture(({ root }) => {
  const file = join(root, 'nested', 'runs.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'old\n', { mode: 0o644 });
  atomicWriteText(file, 'new\n');
  assert.equal(readFileSync(file, 'utf8'), 'new\n');
  // Windows reports ACL-backed files as 0666; POSIX mode bits are not its access control.
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
}));

test('history is enabled only for makecindy/cindy', () => fixture(({ skillRoot }) => {
  assert.equal(isReviewHistoryEnabled('makecindy/cindy'), true);
  assert.equal(isReviewHistoryEnabled('MakeCindy/Cindy'), false);
  let syncCalls = 0;
  const result = publishReviewHistory({ repo: 'o/r', summary: summary({ repo: 'o/r' }), roundState: state(), skillRoot,
    sync: () => { syncCalls += 1; return { ok: true }; } });
  assert.deepEqual(result, { ok: true, enabled: false, skipped: 'repo-not-allowlisted' });
  assert.equal(existsSync(join(skillRoot, 'history')), false);
  assert.equal(syncCalls, 0);
}));

test('publishes one safe run, compact index, and repo-bound state envelope', () => fixture(({ skillRoot, root }) => {
  const calls = [];
  const result = publishReviewHistory({ repo: 'makecindy/cindy', summary: summary(), roundState: state(), skillRoot,
    sync: (options) => { calls.push(options); return { ok: true, committed: true, pushed: true, commit: 'abc1234' }; } });
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.runId, 'run-one');
  const base = join(skillRoot, 'history', 'makecindy-cindy');
  const stored = JSON.parse(readFileSync(join(base, 'runs', 'run-one', 'summary.json'), 'utf8'));
  assert.equal(stored.runId, 'run-one');
  const serialized = JSON.stringify(stored);
  for (const forbidden of ['secret-session', 'secret-agent', 'secret-message', 'secret-inline-agent',
    'secret-inline-session', 'secret-inline-message', 'secret-inline-token', '/tmp/', '/private/tmp/',
    '/var/folders/', 'runtimeMetadata', 'requestFile', 'arbitraryRuntimePath', 'reportFile']) {
    assert.equal(serialized.includes(forbidden), false, `history excludes ${forbidden}`);
  }
  assert.deepEqual(stored.notes, [
    '#1911: liveContextFile=[redacted]',
    'agentId=[redacted] sessionId=[redacted] messageId=[redacted]',
  ]);
  assert.deepEqual(stored.review.notEntered[0].fixHandoff, { status: 'dispatched', reason: 'follow-up' });
  const index = readFileSync(join(base, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(index, [{
    runId: 'run-one', generatedAt: '2026-09-09T00:00:00.000Z', mode: 'auto',
    currentPrCount: 4, candidateCount: 3, enteredCount: 2, mergedCount: 1, enteredNotMergedCount: 1,
    summary: 'runs/run-one/summary.json',
  }]);
  const envelope = JSON.parse(readFileSync(join(base, 'round-state.json'), 'utf8'));
  assert.equal(envelope.repo, 'makecindy/cindy');
  assert.equal(envelope.runId, 'run-one');
  assert.deepEqual(envelope.state, safeState());
  for (const file of [join(base, 'runs', 'run-one', 'summary.json'), join(base, 'runs.jsonl')]) {
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(calls, [{
    skillRoot,
    paths: ['history/makecindy-cindy'],
    message: 'review: archive makecindy/cindy round run-one',
  }]);
  const local = join(root, 'external', 'round-state.json');
  assert.equal(restoreReviewHistoryState({
    repo: 'makecindy/cindy', mode: 'auto', localStateFile: local, skillRoot,
  }).restored, true);
  assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')), safeState());
}));

test('identical publication is idempotent and conflicting run content is rejected', () => fixture(({ skillRoot }) => {
  let calls = 0;
  const sync = () => { calls += 1; return calls === 1
    ? { ok: true, committed: true, pushed: true }
    : { ok: true, committed: false, pushed: false, reason: 'nothing-to-push' }; };
  assert.equal(publishReviewHistory({ repo: 'makecindy/cindy', summary: summary(), roundState: state(), skillRoot, sync }).ok, true);
  assert.equal(publishReviewHistory({ repo: 'makecindy/cindy', summary: summary(), roundState: state(), skillRoot, sync }).ok, true);
  const index = readFileSync(join(skillRoot, 'history', 'makecindy-cindy', 'runs.jsonl'), 'utf8').trim().split('\n');
  assert.equal(index.length, 1);
  assert.throws(() => publishReviewHistory({ repo: 'makecindy/cindy', summary: summary({ notes: ['different'] }), roundState: state(), skillRoot, sync }), /run-one.*冲突/);
  const changedState = state();
  changedState.prs['1'].fingerprint = 'different-fingerprint';
  assert.throws(() => publishReviewHistory({ repo: 'makecindy/cindy', summary: summary(),
    roundState: changedState, skillRoot, sync }), /run-one.*round-state.*冲突/);
  assert.equal(readFileSync(join(skillRoot, 'history', 'makecindy-cindy', 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
}));

test('an impossible Git publication is rejected before history files change', () => fixture(({ skillRoot }) => {
  let syncCalls = 0;
  const result = publishReviewHistory({ repo: 'makecindy/cindy', summary: summary(), roundState: state(), skillRoot,
    preflight: () => ({ ok: false, step: 'preflight', error: 'not on default branch' }),
    sync: () => { syncCalls += 1; return { ok: true, pushed: true }; } });
  assert.equal(result.ok, false);
  assert.equal(result.preflight.error, 'not on default branch');
  assert.equal(syncCalls, 0);
  assert.equal(existsSync(join(skillRoot, 'history')), false);
}));

test('sync failures are returned as publication failures', () => fixture(({ skillRoot }) => {
  const result = publishReviewHistory({ repo: 'makecindy/cindy', summary: summary(), roundState: state(), skillRoot,
    sync: () => ({ ok: false, committed: true, pushed: false, step: 'push', error: 'offline' }) });
  assert.equal(result.ok, false);
  assert.equal(result.sync.step, 'push');
}));

test('same run retries publication after a push failure without duplicating history', () => fixture(({ skillRoot }) => {
  let calls = 0;
  const sync = () => {
    calls += 1;
    return calls === 1
      ? { ok: false, committed: true, pushed: false, step: 'push', error: 'offline' }
      : { ok: true, committed: false, pushed: true, commit: 'abc1234' };
  };
  const first = publishReviewHistory({ repo: 'makecindy/cindy', summary: summary(), roundState: state(), skillRoot, sync });
  assert.equal(first.ok, false);
  const second = publishReviewHistory({ repo: 'makecindy/cindy', summary: summary(), roundState: state(), skillRoot, sync });
  assert.equal(second.ok, true);
  assert.equal(calls, 2);
  const index = readFileSync(join(skillRoot, 'history', 'makecindy-cindy', 'runs.jsonl'), 'utf8').trim().split('\n');
  assert.equal(index.length, 1);
}));

test('restores only missing local state from a valid repo and mode envelope', () => fixture(({ skillRoot, root }) => {
  const history = join(skillRoot, 'history', 'makecindy-cindy', 'round-state.json');
  mkdirSync(dirname(history), { recursive: true });
  writeFileSync(history, JSON.stringify({ version: 1, repo: 'makecindy/cindy', mode: 'auto', runId: 'run-one',
    updatedAt: '2026-09-09T00:00:00.000Z', state: state() }));
  const local = join(root, 'external', 'round-state.json');
  const restored = restoreReviewHistoryState({ repo: 'makecindy/cindy', mode: 'auto', localStateFile: local, skillRoot });
  assert.equal(restored.restored, true);
  assert.equal(restored.source, 'git-history');
  assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')), safeState());
  const restoredText = readFileSync(local, 'utf8');
  for (const forbidden of ['secret-session', 'secret-agent', '/tmp/', 'requestFile', 'agentId']) {
    assert.equal(restoredText.includes(forbidden), false, `recovery excludes ${forbidden}`);
  }

  writeFileSync(local, JSON.stringify({ ...state(), prs: {} }));
  assert.deepEqual(restoreReviewHistoryState({ repo: 'makecindy/cindy', mode: 'auto', localStateFile: local, skillRoot }),
    { restored: false, source: 'local' });
}));

test('merge retry classification survives publication and restore, and rejects invalid versions', () => fixture(({ skillRoot, root }) => {
  const saved = state();
  Object.assign(saved.prs[1], { outcome: 'merge-blocked', reason: 'GitHub UNKNOWN', retry: true, mergeRetryVersion: 1 });
  const published = publishReviewHistory({ repo: 'makecindy/cindy', summary: summary(), roundState: saved, skillRoot,
    sync: () => ({ ok: true, pushed: true }) });
  assert.equal(published.ok, true);
  const local = join(root, 'external', 'round-state.json');
  assert.equal(restoreReviewHistoryState({ repo: 'makecindy/cindy', mode: 'auto', localStateFile: local, skillRoot }).restored, true);
  const restored = JSON.parse(readFileSync(local, 'utf8')).prs[1];
  assert.equal(restored.retry, true);
  assert.equal(restored.mergeRetryVersion, 1);
  for (const version of ['1', 0, -1, 1.5, {}, null]) {
    saved.prs[1].mergeRetryVersion = version;
    assert.throws(() => publishReviewHistory({ repo: 'makecindy/cindy', summary: summary({ runId: 'run-two' }),
      roundState: saved, skillRoot, sync: () => ({ ok: true, pushed: true }) }), /结构无效/);
  }
}));

test('target-branch notice receipts survive safe Git publication and restore', () => fixture(({ root, skillRoot }) => {
  const saved = state();
  const notice = { status: 'posted', head: 'a'.repeat(40), baseRefName: 'feature', defaultBranch: 'main', fingerprint: 'b'.repeat(64) };
  saved.prs[2].targetBranchNotice = { ...notice, token: 'must-not-publish', contextFile: '/tmp/context.json' };
  const published = publishReviewHistory({ repo: 'makecindy/cindy', summary: summary(), roundState: saved, skillRoot,
    sync: () => ({ ok: true, pushed: true }) });
  assert.equal(published.ok, true);
  const local = join(root, 'restored-state.json');
  const restored = restoreReviewHistoryState({ repo: 'makecindy/cindy', mode: 'auto', localStateFile: local, skillRoot });
  assert.equal(restored.restored, true);
  assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')).prs[2].targetBranchNotice, notice);
  assert.equal(readFileSync(local, 'utf8').includes('must-not-publish'), false);
}));

test('invalid, mismatched, and disallowed recovery safely fall back', () => fixture(({ skillRoot, root }) => {
  const history = join(skillRoot, 'history', 'makecindy-cindy', 'round-state.json');
  mkdirSync(dirname(history), { recursive: true });
  const local = join(root, 'external', 'round-state.json');
  const attempt = (body, patch = {}) => {
    writeFileSync(history, typeof body === 'string' ? body : JSON.stringify(body));
    const result = restoreReviewHistoryState({ repo: 'makecindy/cindy', mode: 'auto', localStateFile: local, skillRoot, ...patch });
    assert.equal(result.restored, false);
    assert.equal(existsSync(local), false);
  };
  attempt('{broken');
  attempt({ version: 1, repo: 'o/r', mode: 'auto', runId: 'run-one', state: state() });
  attempt({ version: 1, repo: 'makecindy/cindy', mode: 'review-only', runId: 'run-one', state: state('review-only') });
  attempt({ version: 1, repo: 'makecindy/cindy', mode: 'auto', runId: 'run-one', state: { version: 1, mode: 'auto', prs: { 1: { fingerprint: 42 } } } });
  const disallowed = restoreReviewHistoryState({ repo: 'o/r', mode: 'auto', localStateFile: local, skillRoot });
  assert.deepEqual(disallowed, { restored: false, source: 'none', reason: 'repo-not-allowlisted' });
}));

test('candidate diagnostics and fingerprint fields survive safe publication', () => fixture(({ root, skillRoot }) => {
  const candidateDiagnostics = {
    version: 1, candidateCount: 1, unchangedCount: 2, draftCount: 0, fingerprintChangedCount: 1,
    forcedRecheckCount: 0, baselineMissingCount: 0, baselinePartialCount: 0,
    unattributedFingerprintMismatchCount: 0, reasonCounts: { 'fingerprint-changed': 1 },
    changedFieldCounts: { ci: 1, updatedAt: 1 }, rows: [{
      pr: 1, reasonCodes: ['fingerprint-changed'], baseline: 'available', changedFields: ['ci', 'updatedAt'],
      previousFingerprint: 'a'.repeat(64), fingerprint: 'b'.repeat(64),
      before: { ci: 'SUCCESS', updatedAt: '2026-09-09T00:00:00.000Z' },
      after: { ci: 'FAILURE', updatedAt: '2026-09-09T00:01:00.000Z' },
    }],
  };
  const saved = state();
  saved.prs[1].fingerprintFields = {
    head: '1'.repeat(40), base: '2'.repeat(40), reviewDecision: 'REVIEW_REQUIRED', unresolved: 0,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ci: 'SUCCESS',
    updatedAt: '2026-09-09T00:00:00.000Z', dependencies: [[2, '3'.repeat(40)]],
  };
  const published = publishReviewHistory({ repo: 'makecindy/cindy', summary: summary({ candidateDiagnostics }),
    roundState: saved, skillRoot, sync: () => ({ ok: true, pushed: true }) });
  assert.equal(published.ok, true);
  const base = join(skillRoot, 'history', 'makecindy-cindy');
  const stored = JSON.parse(readFileSync(join(base, 'runs', 'run-one', 'summary.json'), 'utf8'));
  assert.deepEqual(stored.candidateDiagnostics, candidateDiagnostics);
  const envelope = JSON.parse(readFileSync(join(base, 'round-state.json'), 'utf8'));
  assert.deepEqual(envelope.state.prs[1].fingerprintFields, saved.prs[1].fingerprintFields);
  const local = join(root, 'restored-fingerprint-state.json');
  assert.equal(restoreReviewHistoryState({ repo: 'makecindy/cindy', mode: 'auto', localStateFile: local, skillRoot }).restored, true);
  assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')).prs[1].fingerprintFields, saved.prs[1].fingerprintFields);
}));

test('candidate diagnostics reject duplicate PRs and unknown changed fields', () => fixture(({ skillRoot }) => {
  const diagnostics = {
    version: 1, candidateCount: 1, unchangedCount: 0, draftCount: 0, fingerprintChangedCount: 1,
    forcedRecheckCount: 0, baselineMissingCount: 0, baselinePartialCount: 0,
    unattributedFingerprintMismatchCount: 0, reasonCounts: {}, changedFieldCounts: {},
    rows: [{ pr: 1, reasonCodes: [], baseline: 'available', changedFields: ['not-a-field'] }],
  };
  assert.throws(() => publishReviewHistory({ repo: 'makecindy/cindy', summary: summary({ candidateDiagnostics: diagnostics }),
    roundState: state(), skillRoot, sync: () => ({ ok: true, pushed: true }) }), /changedFields/);
}));
