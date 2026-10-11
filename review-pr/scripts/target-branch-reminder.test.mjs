import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyTargetBranch, targetBranchFingerprint, targetBranchMarker } from './target-branch-reminder.mjs';
import { createCandidateList, makeReviewPlan, collectRoundResults, nextRoundState } from './review-round.mjs';

const head = 'a'.repeat(40);
const input = { owner: 'o', repo: 'r', pr: 4351, expectedHead: head, expectedBaseRef: 'dash/token-speed-panel' };
function fixture({ parentState = 'MERGED', comments = [], metaChange, failPost = false } = {}) {
  let reads = 0;
  const writes = [];
  const parent = { number: 4271, state: parentState === 'OPEN' ? 'open' : 'closed',
    merged_at: parentState === 'MERGED' ? '2026-09-16T15:51:20Z' : null,
    head: { ref: input.expectedBaseRef, repo: { full_name: 'o/r' } } };
  const meta = { state: 'OPEN', isDraft: false, author: { login: 'author' }, headRefOid: head, baseRefName: input.expectedBaseRef };
  const api = {
    ghJson(args) {
      if (args[0] === 'pr') { reads++; return { ...meta, ...(metaChange?.(reads) ?? {}) }; }
      if (args[0] === 'repo') return { defaultBranchRef: { name: 'main' } };
      if (args[0] === 'api' && args[1] === 'user') return { login: 'Maintainer' };
      throw new Error('Unexpected GitHub read');
    },
    fetchRestPages(endpoint) {
      if (endpoint.includes('/pulls?')) return [parent];
      assert.equal(endpoint, 'repos/o/r/issues/4351/comments');
      return comments;
    },
    writeGh(args, options) {
      assert.deepEqual(args, ['pr', 'comment', '4351', '--repo', 'o/r', '--body-file', '-']);
      writes.push(options.input);
      if (failPost) return { ok: false, stderr: 'fixture offline' };
      comments.push({ user: { login: 'Maintainer' }, body: options.input, html_url: 'https://github.com/o/r/pull/4351#issuecomment-1' });
      return { ok: true, stdout: comments.at(-1).html_url };
    },
  };
  return { api, writes, comments, parent, meta };
}

test('merged parent asks for main and deduplicates across process restarts and ordinary pushes', () => {
  const f = fixture();
  const first = notifyTargetBranch(input, f.api);
  assert.equal(first.posted, true);
  assert.match(f.writes[0], /父 PR #4271 已合并/);
  assert.ok(f.writes[0].includes('base 改为 <code>main</code>'));
  assert.match(f.writes[0], /Files changed/);
  assert.match(f.writes[0], /CI/);
  const restarted = fixture({ comments: f.comments });
  assert.equal(notifyTargetBranch(input, restarted.api).reason, 'already-commented');
  restarted.meta.headRefOid = 'b'.repeat(40);
  assert.equal(notifyTargetBranch({ ...input, expectedHead: restarted.meta.headRefOid }, restarted.api).reason, 'already-commented');
  assert.equal(restarted.writes.length, 0);
});

test('open and closed parents have actionable notices; merging warrants one new retarget notice', () => {
  const f = fixture({ parentState: 'OPEN' });
  const waiting = notifyTargetBranch(input, f.api);
  assert.match(f.writes[0], /等待父 PR 合并/);
  f.parent.state = 'closed';
  f.parent.merged_at = '2026-09-16T15:51:20Z';
  const retarget = notifyTargetBranch(input, f.api);
  assert.equal(retarget.posted, true);
  assert.notEqual(retarget.fingerprint, waiting.fingerprint);
  assert.equal(notifyTargetBranch(input, f.api).reason, 'already-commented');
  assert.equal(f.writes.length, 2);
  const closed = fixture({ parentState: 'CLOSED' });
  notifyTargetBranch(input, closed.api);
  assert.match(closed.writes[0], /已关闭但未合并/);
});

test('untrusted markers cannot suppress a notice and failed posts remain retryable', () => {
  const f = fixture({ failPost: true });
  const preview = notifyTargetBranch({ ...input, dryRun: true }, f.api);
  f.comments.push({ user: { login: 'author' }, body: targetBranchMarker(preview.fingerprint) });
  const failed = notifyTargetBranch(input, f.api);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'comment-failed');
  const retry = fixture({ comments: f.comments });
  assert.equal(notifyTargetBranch(input, retry.api).posted, true);
});

test('retarget, head, draft and closed races prevent stale comments', () => {
  for (const patch of [{ headRefOid: 'b'.repeat(40) }, { baseRefName: 'main' }, { isDraft: true }, { state: 'CLOSED' }]) {
    for (const atRead of [1, 2]) {
      const f = fixture({ metaChange: (reads) => reads >= atRead ? patch : {} });
      assert.equal(notifyTargetBranch(input, f.api).reason, 'state-changed');
      assert.equal(f.writes.length, 0);
    }
  }
});

test('unknown or unrelated base evidence never posts; review-only and dry-run remain explicit', () => {
  const unrelated = fixture();
  unrelated.parent.head.repo.full_name = 'fork/r';
  assert.equal(notifyTargetBranch(input, unrelated.api).reason, 'state-changed');
  assert.equal(unrelated.writes.length, 0);
  const broken = fixture();
  broken.api.fetchRestPages = () => { throw new Error('pagination failed'); };
  assert.throws(() => notifyTargetBranch(input, broken.api), /pagination failed/);
  assert.equal(broken.writes.length, 0);
  const f = fixture();
  const preview = notifyTargetBranch({ ...input, dryRun: true, reviewOnly: true }, f.api);
  assert.match(preview.body, /该模式不会主动合并/);
  assert.equal(preview.reason, 'dry-run');
  assert.equal(f.writes.length, 0);
});

function round({ outcome = 'retarget', baseRefName = input.expectedBaseRef } = {}) {
  const snapshot = [{ number: 4351, head, baseRefName, base: 'b'.repeat(40), createdAt: '2026-09-17T00:00:00Z' }];
  const manifest = createCandidateList({ repo: 'o/r', snapshot });
  const plan = makeReviewPlan(manifest, [{ ok: true, pr: 4351,
    meta: { state: 'OPEN', headRefOid: head, baseRefName, defaultBranch: 'main', needsRetarget: outcome === 'retarget',
      basePr: { number: 4271, state: outcome === 'retarget' ? 'MERGED' : 'OPEN' } },
    dependencies: [{ repo: 'o/r', number: 4271, state: outcome === 'retarget' ? 'MERGED' : 'OPEN' }] }]);
  return { snapshot, plan, item: plan.skipped[0] };
}

test('skipped stacked PRs cannot finalize without a notice; failure retries and old results wake once', () => {
  for (const outcome of ['retarget', 'dependency']) {
    const { snapshot, plan, item } = round({ outcome });
    assert.throws(() => collectRoundResults(plan, []), /目标分支作者提醒/);
    const receipt = notifyTargetBranch({ ...input, dryRun: true }, fixture().api);
    item.targetBranchNotice = { status: 'posted', head, baseRefName: receipt.baseRefName,
      defaultBranch: receipt.defaultBranch, fingerprint: receipt.fingerprint };
    const state = nextRoundState(plan, collectRoundResults(plan, []));
    assert.equal(createCandidateList({ repo: 'o/r', snapshot, state }).candidates.length, 0);
    delete state.prs[4351].targetBranchNotice;
    assert.equal(createCandidateList({ repo: 'o/r', snapshot, state }).candidates.length, 1);
    item.targetBranchNotice = { ...item.targetBranchNotice, status: 'failed', reason: 'fixture offline' };
    assert.throws(() => collectRoundResults(plan, []), /下轮重试/);
    item.retry = true;
    const retry = nextRoundState(plan, collectRoundResults(plan, []));
    assert.equal(createCandidateList({ repo: 'o/r', snapshot, state: retry }).candidates.length, 1);
  }
});

test('ordinary default-branch dependencies remain quiet after one legacy migration', () => {
  const { snapshot, plan } = round({ outcome: 'dependency', baseRefName: 'main' });
  const state = nextRoundState(plan, collectRoundResults(plan, []));
  assert.equal(state.prs[4351].targetBranchNotice.status, 'not-needed');
  assert.equal(createCandidateList({ repo: 'o/r', snapshot, state }).candidates.length, 0);
});

test('a long-lived non-default base with only an explicit dependency does not need a target notice', () => {
  const { snapshot, plan, item } = round({ outcome: 'dependency', baseRefName: 'release/1.x' });
  item.basePr = null;
  const state = nextRoundState(plan, collectRoundResults(plan, []));
  assert.equal(state.prs[4351].targetBranchNotice.status, 'not-needed');
  assert.equal(createCandidateList({ repo: 'o/r', snapshot, state }).candidates.length, 0);
});

test('target fingerprints require verified stacked evidence and distinguish base choices', () => {
  const evidence = { baseRefName: 'feature', defaultBranch: 'main', basePr: { number: 1, state: 'OPEN' } };
  assert.notEqual(targetBranchFingerprint(evidence), targetBranchFingerprint({ ...evidence, baseRefName: 'other' }));
  assert.throws(() => targetBranchFingerprint({ ...evidence, basePr: null }));
  assert.throws(() => targetBranchFingerprint({ ...evidence, baseRefName: 'main' }));
});
