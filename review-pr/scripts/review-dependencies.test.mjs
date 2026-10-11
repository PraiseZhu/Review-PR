import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitDependencies, stackedBaseDependencies, classifyBasePrLookup, collectDependencyRefs } from './review-dependencies.mjs';
import { fetchOpenPrSnapshot } from './lib.mjs';

const candidate = { number: 20, baseRefName: 'main' };
const meta = { defaultBranch: 'main', baseRefName: 'main', body: '' };
const pull = (number, overrides = {}) => ({ number, state: 'open', merged_at: null,
  html_url: `https://github.com/o/r/pull/${number}`, head: { ref: 'feature', repo: { full_name: 'o/r' } }, ...overrides });

test('explicit dependencies consume positive reference lists, not neighboring issue references', () => {
  assert.deepEqual(explicitDependencies('Fixes #1\nRelated to #2\nDepends on #3, o/r#4\n依赖：https://github.com/x/y/pull/9', 'o/r'),
    ['o/r#3', 'o/r#4', 'x/y#9']);
  assert.deepEqual(explicitDependencies('Depends on #12; fixes #34\nDepends on #12, fixes #35\nDepends on #12 and closes #36', 'o/r'), ['o/r#12']);
  assert.deepEqual(explicitDependencies('Blocked by PR #1, and #2\n依赖 PR #3 和 #4\n基于 [前置 PR](https://github.com/O/R/pull/5) ；关闭 #6', 'o/r'),
    ['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4', 'o/r#5']);
  assert.deepEqual(explicitDependencies('Depends on <https://github.com/o/r/pull/7#issuecomment-1>, x/y#8', 'o/r'), ['o/r#7', 'x/y#8']);
});

test('removed dependencies and documentation examples do not block the round', () => {
  const body = [
    'No longer depends on #1', 'This is not blocked by #2', '不再依赖 #3', '无需依赖 #4', '不是基于 #5',
    '`Depends on #6` is the template syntax.', '```markdown', 'Depends on #7', '```',
    '<!-- Depends on #8 -->', 'No longer depends on #9; now depends on #10',
  ].join('\n');
  assert.deepEqual(explicitDependencies(body, 'o/r'), ['o/r#10']);
});

test('stacked branches require the same repository and a non-default base', () => {
  const snapshot = [
    { number: 1, headRefName: 'main', headRepository: 'contributor/fork' },
    { number: 2, headRefName: 'feature', headRepository: 'contributor/fork' },
    { number: 3, headRefName: 'feature', headRepository: 'O/R' },
    { number: 4, headRefName: 'feature', headRepository: null },
  ];
  assert.deepEqual(stackedBaseDependencies({ repo: 'o/r', pr: 20, baseRefName: 'main', defaultBranch: 'main', snapshot }), []);
  assert.deepEqual(stackedBaseDependencies({ repo: 'o/r', pr: 20, baseRefName: 'feature', defaultBranch: 'main', snapshot }).map((p) => p.number), [3]);
  assert.deepEqual(collectDependencyRefs({ repo: 'o/r', candidate, snapshot, meta }), []);
  // Explicit prerequisites still count even when both PRs target the default base.
  assert.deepEqual(collectDependencyRefs({ repo: 'o/r', candidate, snapshot, meta: { ...meta, body: 'Depends on #1' } }), ['o/r#1']);
});

test('a verified release base without an associated PR remains reviewable, failed lookups do not', () => {
  const releaseCandidate = { ...candidate, baseRefName: 'release/1.x' };
  const lookup = classifyBasePrLookup({ repo: 'o/r', pr: 20, baseRefName: 'release/1.x', defaultBranch: 'main', pulls: [] });
  assert.deepEqual(lookup, { verified: true, reason: 'no-associated-pr', basePr: null, needsRetarget: false });
  const releaseMeta = { ...meta, baseRefName: releaseCandidate.baseRefName, basePrLookup: lookup };
  assert.deepEqual(collectDependencyRefs({ repo: 'o/r', candidate: releaseCandidate, snapshot: [], meta: releaseMeta }), []);
  assert.throws(() => collectDependencyRefs({ repo: 'o/r', candidate: releaseCandidate, snapshot: [],
    meta: { ...releaseMeta, basePrLookup: { verified: false, error: 'fixture denied' } } }), /fixture denied/);
  assert.throws(() => classifyBasePrLookup({ repo: 'o/r', pr: 20, baseRefName: 'release/1.x', defaultBranch: 'main', pulls: null }), /完整列表/);
});

test('qualified base lookup ignores fork names and preserves open, merged and closed prerequisites', () => {
  const options = { repo: 'o/r', pr: 20, baseRefName: 'feature', defaultBranch: 'main' };
  const foreign = pull(18, { head: { ref: 'feature', repo: { full_name: 'contributor/fork' } } });
  const deleted = pull(19, { head: { ref: 'feature', repo: null } });
  assert.equal(classifyBasePrLookup({ ...options, pulls: [foreign, deleted] }).basePr, null);
  const merged = pull(2, { state: 'closed', merged_at: '2026-09-08T00:00:00Z' });
  const open = pull(5);
  const reused = classifyBasePrLookup({ ...options, pulls: [foreign, merged, open] });
  assert.equal(reused.basePr.number, 5);
  assert.equal(reused.needsRetarget, false);
  assert.equal(classifyBasePrLookup({ ...options, pulls: [merged] }).needsRetarget, true);
  assert.equal(classifyBasePrLookup({ ...options, pulls: [pull(6, { state: 'closed' })] }).basePr.state, 'CLOSED');
  assert.throws(() => classifyBasePrLookup({ ...options, pulls: [pull(7, { head: { ref: 'feature' } })] }), /仓库归属/);
  assert.throws(() => classifyBasePrLookup({ ...options, pulls: [pull(8, { head: { ref: 'feature', repo: {} } })] }), /仓库归属/);
});

test('snapshot-open stacked parents stay dependencies after merge and retarget during collection', () => {
  const snapshot = [{ number: 1, headRefName: 'feature', headRepository: 'o/r' }];
  const stacked = { ...candidate, baseRefName: 'feature' };
  // The current context is already retargeted to main, but this round began stacked.
  assert.deepEqual(collectDependencyRefs({ repo: 'o/r', candidate: stacked, snapshot, meta }), ['o/r#1']);
  const lookup = classifyBasePrLookup({ repo: 'o/r', pr: 20, baseRefName: 'feature', defaultBranch: 'main',
    pulls: [pull(1, { state: 'closed', merged_at: '2026-09-08T00:00:00Z' })] });
  assert.deepEqual(collectDependencyRefs({ repo: 'o/r', candidate: stacked, snapshot,
    meta: { ...meta, baseRefName: 'feature', basePr: lookup.basePr, basePrLookup: lookup } }), ['o/r#1']);
});

test('the lightweight GitHub snapshot retains source repository identity', () => {
  const identities = ['o/r', 'contributor/fork', null];
  let calls = 0;
  const snapshot = fetchOpenPrSnapshot({ owner: 'o', repo: 'r', ghGraphqlFn(query) {
    calls++;
    assert.match(query, /headRepository\s*\{\s*nameWithOwner\s*\}/);
    return { data: { repository: { pullRequests: {
      totalCount: identities.length, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: identities.map((identity, i) => ({ number: i + 1, headRefOid: String(i + 1).repeat(40),
        updatedAt: '2026-09-08T00:00:00Z', headRefName: 'feature', baseRefName: 'main',
        headRepository: identity ? { nameWithOwner: identity } : null,
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })),
    } } } };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(snapshot.map((p) => p.headRepository), identities);
});
