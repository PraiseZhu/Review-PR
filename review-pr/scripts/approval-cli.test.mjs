// Exercise actual guarded CLI recovery with mocked subprocesses. No GitHub writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fetchMaintainerAuthority } from './lib.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
function fixtureGh(args, options, fixture) {
  const ok = (value) => ({ status: 0, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const endpoint = args.find((arg) => typeof arg === 'string' && /^(?:repos|orgs)\//.test(arg));
  if (args[0] === 'pr' && args[1] === 'view') {
    fixture.prViews = (fixture.prViews || 0) + 1;
    if (fixture.baseChangeOnView === fixture.prViews) fixture.meta.baseRefOid = 'c'.repeat(40);
    if (fixture.baseRefChangeOnView === fixture.prViews) fixture.meta.baseRefName = 'release/1.x';
    return ok(fixture.meta);
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    fixture.merges = (fixture.merges || 0) + 1;
    if (fixture.mergeMode === 'rejected') return { status: 1, signal: null, stdout: '',
      stderr: 'GraphQL: Required status check "ci" has failed. (mergePullRequest)' };
    if (fixture.mergeMode === 'timeout') return { status: 1, signal: null, stdout: '', stderr: 'request timed out' };
    fixture.meta.state = 'MERGED';
    fixture.meta.mergedAt = '2026-09-08T00:00:00Z';
    return ok('');
  }
  if (args[0] === 'api' && args[1] === 'user') return ok(fixture.viewer);
  if (endpoint === 'repos/o/r') return ok({ default_branch: 'main' });
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
    if (!args.includes('--paginate') || !args.includes('--slurp')) throw new Error('reviews must be fully paginated');
    return fixture.readFailure ? { status: 1, signal: null, stdout: '', stderr: 'fixture unavailable' }
      : ok([fixture.reviews.slice(0, 1), fixture.reviews.slice(1)]);
  }
  if (endpoint === 'repos/o/r/pulls/1/reviews' && args.includes('POST')) {
    fixture.posts++;
    if (fixture.landed) fixture.reviews.push(fixture.newReview);
    if (fixture.landed && fixture.settleReviewAfterPost) fixture.meta.reviewDecision = 'APPROVED';
    if (fixture.postMode === 'timeout') return { status: 1, signal: null, stdout: '', stderr: 'request timed out' };
    if (fixture.postMode === 'rejected') return { status: 1, signal: null, stdout: '', stderr: 'HTTP 422 Unprocessable Entity' };
    if (fixture.postMode === 'limited') return { status: 1, signal: null, stdout: '', stderr: 'HTTP 403 secondary rate limit' };
    return ok(fixture.postMode === 'missing-receipt' ? {} : fixture.newReview);
  }
  throw new Error(`unexpected fixture command: ${args.join(' ')}`);
}

test('Approve CLI persists receipts, reconciles uncertain writes without duplicate POSTs, and respects live gates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'approval-cli-test-'));
  try {
    const repoRoot = join(directory, 'repo');
    mkdirSync(repoRoot);
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
      const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
    const rulesFile = join(directory, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ maintainerAllowlist: [] }));
    const fixtureFile = join(directory, 'fixture.json');
    const mockFile = join(directory, 'mock.mjs');
    writeFileSync(mockFile, `import { readFileSync, writeFileSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
const fixtureGh = ${fixtureGh.toString()};
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command === process.execPath && basename(args[0]) === 'pre-merge-check.mjs') {
    const fixture = JSON.parse(readFileSync(process.env.APPROVAL_FIXTURE, 'utf8'));
    fixture.preChecks = [...(fixture.preChecks || []), args];
    const patch = fixture.preMergeSequence?.shift() ?? fixture.preMerge;
    writeFileSync(process.env.APPROVAL_FIXTURE, JSON.stringify(fixture));
    return { status: 0, signal: null, stdout: JSON.stringify({ ok: true, canMerge: true, normalMergeAvailable: true,
      approvalPolicy: { approvalRequired: true, viewer: 'maintainer', author: 'author' },
      ...patch }), stderr: '' };
  }
  if (command === process.execPath && basename(args[0]) === 'signoff-release.mjs') {
    return { status: 0, signal: null, stdout: JSON.stringify({ ok: true, labels: { errors: [] } }), stderr: '' };
  }
  if (command !== 'gh') return original(command, args, options);
  const fixture = JSON.parse(readFileSync(process.env.APPROVAL_FIXTURE, 'utf8'));
  const result = fixtureGh(args, options, fixture);
  writeFileSync(process.env.APPROVAL_FIXTURE, JSON.stringify(fixture));
  return result;
};
syncBuiltinESMExports();
`);
    const basic = () => ({ head, base, viewer: 'maintainer', posts: 0, landed: true, postMode: 'success', reviews: [],
      meta: { state: 'OPEN', isDraft: false, author: { login: 'author' }, headRefOid: head, baseRefName: 'main', baseRefOid: base, reviewDecision: 'REVIEW_REQUIRED' },
      newReview: { id: 999, state: 'APPROVED', commit_id: head, user: { login: 'maintainer' },
        submitted_at: '2026-09-08T00:00:00Z', html_url: 'https://github.com/o/r/pull/1#pullrequestreview-999' } });
    const authority = fetchMaintainerAuthority({ owner: 'o', repo: 'r', maintainerAllowlist: [],
      ghFn: (args, options) => { const result = fixtureGh(args, options, basic()); return { ...result, ok: result.status === 0 }; } });
    const envBase = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFile).href}`].filter(Boolean).join(' '),
      REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_RULES_FILE: rulesFile, APPROVAL_FIXTURE: fixtureFile, REVIEW_PR_NO_CRED_FALLBACK: '1' };
    let index = 0;
    const scenario = (fixture) => {
      const env = { ...envBase, REVIEW_PR_STATE_DIR: join(directory, `state-${index++}`) };
      writeFileSync(fixtureFile, JSON.stringify(fixture));
      const setup = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import {stateFile} from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)}; import {writeFileSync} from 'node:fs'; writeFileSync(stateFile('lock.json'), JSON.stringify({token:'fixture-lock'})); process.stdout.write(stateFile(''));`],
      { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
      assert.equal(setup.status, 0, setup.stderr);
      const run = (extra = [], script = 'approve-reviewed-pr.mjs') => {
        const child = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), '1',
          '--review-clean', '--lock-token', 'fixture-lock', '--expected-head', head, '--expected-base', base,
          '--expected-base-ref', 'main',
          '--expected-authority-digest', authority.digest, ...extra], { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
        assert.ok([0, 1, 2].includes(child.status), child.stdout + child.stderr);
        return JSON.parse(child.stdout);
      };
      run.stateDirectory = setup.stdout;
      run.merge = () => run(['--method', 'squash'], 'merge-reviewed-pr.mjs');
      run.finish = () => run(['--mode', 'auto', '--method', 'squash'], 'finish-reviewed-pr.mjs');
      return run;
    };
    const readFixture = () => JSON.parse(readFileSync(fixtureFile, 'utf8'));

    let run = scenario(basic());
    let result = run();
    assert.equal(result.approval.status, 'verified');
    assert.equal(result.approval.reviewId, '999');
    assert.equal(readFixture().posts, 1);

    run = scenario({ ...basic(), postMode: 'timeout', landed: false });
    assert.equal(run().approval.status, 'pending');
    const journalFile = join(run.stateDirectory, readdirSync(run.stateDirectory).find((name) => /^approval-1-/.test(name)));
    let journal = JSON.parse(readFileSync(journalFile, 'utf8'));
    journal.attemptedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    writeFileSync(journalFile, JSON.stringify(journal));
    assert.equal(run().approval.status, 'pending');
    assert.equal(readFixture().posts, 2); // One delayed, re-guarded repost closes the pre-POST crash gap.
    journal = JSON.parse(readFileSync(journalFile, 'utf8'));
    journal.attemptedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    writeFileSync(journalFile, JSON.stringify(journal));
    assert.equal(run().approval.code, 'approval-manual-reconciliation-required');
    assert.equal(readFixture().posts, 2);

    run = scenario({ ...basic(), postMode: 'limited', landed: false });
    assert.equal(run().approval.code, 'approval-rate-limited');
    const unlimited = readFixture(); unlimited.postMode = 'success'; unlimited.landed = true;
    writeFileSync(fixtureFile, JSON.stringify(unlimited));
    assert.equal(run().approval.status, 'verified');
    assert.equal(readFixture().posts, 2); // An explicit rate-limit rejection is safe to retry.

    run = scenario({ ...basic(), readFailure: true });
    assert.equal(run().approval.status, 'pending');
    assert.equal(readFixture().posts, 0);
    const readable = readFixture(); readable.readFailure = false;
    writeFileSync(fixtureFile, JSON.stringify(readable));
    assert.equal(run().approval.status, 'verified');
    assert.equal(readFixture().posts, 1);
    assert.equal(run().alreadyApproved, true);
    assert.equal(readFixture().posts, 1);

    run = scenario({ ...basic(), postMode: 'timeout' });
    result = run();
    assert.equal(result.approval.status, 'verified');
    assert.equal(result.reconciled, true);
    assert.equal(readFixture().posts, 1);

    run = scenario({ ...basic(), postMode: 'missing-receipt', landed: false });
    assert.equal(run().approval.status, 'pending');
    assert.equal(run().approval.status, 'pending');
    assert.equal(readFixture().posts, 1); // Recovery cannot blindly repeat the write.
    const delayed = readFixture(); delayed.reviews.push(delayed.newReview);
    writeFileSync(fixtureFile, JSON.stringify(delayed));
    assert.equal(run().approval.status, 'verified');
    assert.equal(readFixture().posts, 1);

    run = scenario({ ...basic(), meta: { ...basic().meta, author: { login: 'maintainer' } } });
    result = run();
    assert.equal(result.approval.status, 'exempt');
    assert.equal(result.approved, false);
    assert.equal(result.approvalSatisfied, true);
    assert.match(result.approval.reason, /2026-10-21/);
    assert.equal(result.approval.author, 'maintainer');
    assert.equal(readFixture().posts, 0);
    for (const update of [
      { meta: { ...basic().meta, baseRefOid: 'c'.repeat(40) } },
      { threads: [{ id: 't1', isResolved: false }] },
      { reviews: [{ id: 11, user: { login: 'other' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-08T00:00:00Z' }] },
    ]) {
      run = scenario({ ...basic(), ...update });
      assert.equal(run().approval.status, 'blocked');
      assert.equal(readFixture().posts, 0);
    }

    // [MIVO-PATCH approval-failures] 拦截项逐项带 code:作者就是审查账号时,调用方要分得清
    // 「只差另一位维护者 Approve」和「除此之外还有别的没过」,不能只看第一个 code。
    const authorViewer = { ...basic(), meta: { ...basic().meta, author: { login: 'maintainer' } } };
    run = scenario(authorViewer);
    result = run();
    assert.equal(result.approval.status, 'exempt');
    assert.equal(result.approved, false);
    assert.equal(result.approvalSatisfied, true);
    assert.equal(readFixture().posts, 0);
    run = scenario({ ...authorViewer, threads: [{ id: 't1', isResolved: false }] });
    result = run();
    assert.equal(result.approval.status, 'blocked');
    assert.equal(result.approval.code, 'threads-unresolved');
    assert.deepEqual(result.failures.map((item) => item.code), ['threads-unresolved']);
    assert.equal(result.failures.at(-1).reason, '仍有 conversation 未 resolve');
    assert.equal(readFixture().posts, 0);

    const unknownMergeCheck = { ok: true, state: 'OPEN', canMerge: false, normalMergeAvailable: false,
      mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', mergeableUnknown: true,
      headVerified: true, baseVerified: true, authorityVerified: true, threadsVerified: true, unresolvedThreads: [],
      ci: { status: 'pass' }, botSettleVerified: true, botSettle: { settled: true },
      staleRebaseChecked: true, staleRebase: { blocking: false }, pendingSignoffLabels: [], protectedFiles: [],
      reviewDecision: 'APPROVED', blockers: [], blockClass: 'none' };
    const mergeReady = () => {
      const fixture = basic();
      fixture.reviews = [fixture.newReview];
      fixture.meta = { ...fixture.meta, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        commits: [{ committedDate: '2026-09-07T00:00:00Z' }] };
      return fixture;
    };
    run = scenario(mergeReady());
    assert.equal(run.merge().merged, true);
    assert.equal(readFixture().merges, 1);

    // Run the actual finish CLI through a delayed aggregate CR and through an
    // inner pre-write UNKNOWN. Both must finish in this invocation, one write.
    const oldOwnReview = { id: 123, user: { login: 'maintainer' }, state: 'CHANGES_REQUESTED',
      commit_id: 'c'.repeat(40), submitted_at: '2026-09-07T00:00:00Z',
      body: `缺界面证据\n\n<!-- review-pr:gate-review kind=format head=${head} -->` };
    const ownLag = { ...unknownMergeCheck, actualHead: head, mergeable: 'MERGEABLE', mergeableUnknown: false,
      mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED', blockClass: 'review-changes-requested',
      blockers: ['mergeStateStatus=BLOCKED(reviewDecision=CHANGES_REQUESTED,仍有 reviewer 要求修改)'],
      reviewSnapshot: { verified: true, latest: [{ reviewId: '999', reviewer: 'maintainer', state: 'APPROVED', head }] } };
    run = scenario({ ...basic(), reviews: [oldOwnReview], settleReviewAfterPost: true,
      meta: { ...basic().meta, reviewDecision: 'CHANGES_REQUESTED' }, preMergeSequence: [ownLag, {}] });
    result = run.finish();
    assert.equal(result.merged, true);
    assert.equal(readFixture().posts, 1);
    assert.equal(readFixture().merges, 1);
    assert.equal(result.checks, 2);

    run = scenario({ ...mergeReady(), preMergeSequence: [{}, unknownMergeCheck, {}, {}] });
    result = run.finish();
    assert.equal(result.merged, true);
    assert.equal(result.mergeAttempts, 2);
    assert.equal(readFixture().merges, 1);
    assert.equal(readFixture().preChecks.length, 4);
    assert.ok(readFixture().preChecks.every((args) => args.includes('--expected-base') && args.includes(base) && args.includes('--expected-base-ref')));
    for (const name of readdirSync(run.stateDirectory).filter((name) => name.startsWith('merge-base-'))) {
      assert.deepEqual(readdirSync(join(run.stateDirectory, name)), []); // Confirmed transaction releases its ticket.
    }
    run = scenario({ ...mergeReady(), baseChangeOnView: 2 });
    result = run.merge();
    assert.equal(result.merged, false);
    assert.equal(result.code, 'base-changed');
    assert.equal(readFixture().merges || 0, 0);
    for (const name of readdirSync(run.stateDirectory).filter((name) => name.startsWith('merge-base-'))) {
      assert.deepEqual(readdirSync(join(run.stateDirectory, name)), []); // A blocked check also releases its ticket.
    }

    // The old task targeted main. Retargeting to an equal-SHA branch must fail
    // before Approve, and again if retargeting happens later before guarded merge.
    run = scenario({ ...basic(), baseRefChangeOnView: 1 });
    result = run.finish();
    assert.equal(result.stage, 'approval-blocked');
    assert.equal(result.approval.code, 'base-changed');
    assert.equal(readFixture().posts, 0);
    assert.equal(readFixture().meta.baseRefOid, base);
    run = scenario({ ...mergeReady(), baseRefChangeOnView: 3 });
    result = run.finish();
    assert.equal(result.stage, 'merge-blocked');
    assert.equal(result.expectedBaseRef, 'main');
    assert.equal(result.merge.code, 'base-or-head-changed');
    assert.equal(readFixture().merges || 0, 0);

    // A definite rejection leaves the PR OPEN but must release the base. Once
    // CI recovers, a later independent invocation may merge it normally.
    run = scenario({ ...mergeReady(), mergeMode: 'rejected' });
    result = run.merge();
    assert.equal(result.merged, false);
    assert.equal(result.pending, undefined);
    assert.equal(result.mergeAttempt.status, 'rejected');
    assert.equal(result.mergeLock.released, true);
    for (const name of readdirSync(run.stateDirectory).filter((name) => name.startsWith('merge-base-'))) {
      assert.deepEqual(readdirSync(join(run.stateDirectory, name)), []);
    }
    const recoveredCi = readFixture(); recoveredCi.mergeMode = 'success';
    writeFileSync(fixtureFile, JSON.stringify(recoveredCi));
    assert.equal(run.merge().merged, true);
    assert.equal(readFixture().merges, 2);

    // A transient GitHub calculation must not be cached as a permanent merge blocker.
    run = scenario({ ...mergeReady(), preMerge: unknownMergeCheck });
    result = run.merge();
    assert.equal(result.retry, true);
    assert.equal(result.mergeAttempted, false);
    assert.equal(result.merged, false);
    assert.equal(readFixture().merges || 0, 0);
    assert.equal(result.mergeLock.released, true); // No mutation was attempted; a future guarded attempt is safe.
    const settled = readFixture(); delete settled.preMerge;
    writeFileSync(fixtureFile, JSON.stringify(settled));
    assert.equal(run.merge().merged, true);
    assert.equal(readFixture().merges, 1);

    run = scenario({ ...mergeReady(), preMerge: { ...unknownMergeCheck, ci: { status: 'failed' },
      blockClass: 'ci-failed', blockers: ['CI failed'] } });
    result = run.merge();
    assert.equal(result.retry, false);
    assert.equal(result.merged, false);
    assert.equal(readFixture().merges || 0, 0);

    // An unproven network failure remains pending and cannot release the base
    // merely because a read still reports OPEN.
    run = scenario({ ...mergeReady(), mergeMode: 'timeout' });
    result = run.merge();
    assert.equal(result.mergeAttempted, true);
    assert.equal(result.pending, true);
    assert.equal(result.mergeLock.released, false);
    assert.equal(run.merge().code, 'merge-reconciliation-pending');
    assert.equal(readFixture().merges, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
