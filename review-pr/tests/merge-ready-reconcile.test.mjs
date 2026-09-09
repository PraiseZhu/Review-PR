import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { reconcileMergeReady, resolveMergeReadyConfig, READY_LABEL, MIVO_REPO } from '../scripts/merge-ready-reconcile.mjs';

const pr = { repo: MIVO_REPO, number: 7 };
const bindings = { source: 'consume-review-output', schemaVersion: 'rro-1', outputHash: 'o', snapshotHash: 's', ledgerHash: 'l', escapeSourceHash: 'e', knownHazardsHash: 'h', headRefOid: 'head' };
const gate = { stage2Clean: true, receiptGate: { stage2Clean: true, snapshotHash: 's' }, reviewReceipt: { verdict: 'clean', ...bindings }, baseRefOid: 'base', headRefOid: 'head', snapshotHash: 's', securityGate: { pass: true }, canMergeMechanical: true };
function api(labels = [], failReceipt = false, extra = {}) { const calls = []; const current = [...labels]; return { calls, readPullRequest: async () => ({ baseRefOid: 'base', headRefOid: 'head', isDraft: false, state: 'OPEN', labels: [...current], ...extra }), addLabel: async (x) => { current.push(x); calls.push(['add', x]); }, removeLabel: async (x) => { const i = current.indexOf(x); if (i >= 0) current.splice(i, 1); calls.push(['remove', x]); }, writeReceipt: async () => { calls.push(['receipt']); if (failReceipt) throw new Error('receipt down'); } }; }

test('default off, Mivo-only, label is not signoff', () => { assert.equal(resolveMergeReadyConfig({ rules: {} }).enabled, false); assert.equal(resolveMergeReadyConfig({ rules: { mergeReady: { enabled: true, repo: MIVO_REPO } } }).label, READY_LABEL); assert.throws(() => resolveMergeReadyConfig({ rules: { mergeReady: { enabled: true, label: 'signoff:hold' } } })); assert.throws(() => resolveMergeReadyConfig({ rules: { mergeReady: { enabled: true, label: 'awaiting-discussion' } } })); });
test('forged clean, snapshot=head, and stale bindings do not add', async () => {
  for (const change of [{ stage2Clean: false, receiptGate: { stage2Clean: false, snapshotHash: 's' } }, { reviewReceipt: { verdict: 'clean' } }, { snapshotHash: 'old', receiptGate: { stage2Clean: true, snapshotHash: 'old' } }]) {
    const a = api();
    const r = await reconcileMergeReady({ pr, config: { enabled: true, label: READY_LABEL }, gate: { ...gate, ...change }, api: a });
    assert.equal(r.action, 'unchanged');
    assert.deepEqual(a.calls, []);
  }
  const sameAsHead = api();
  const forged = await reconcileMergeReady({ pr, config: { enabled: true, label: READY_LABEL }, gate: { ...gate, snapshotHash: 'head', receiptGate: { stage2Clean: true, snapshotHash: 'head' }, reviewReceipt: { verdict: 'clean', ...bindings, snapshotHash: 'head' } }, api: sameAsHead });
  assert.equal(forged.action, 'unchanged');
  const a = api();
  const r = await reconcileMergeReady({ pr, config: { enabled: true, label: READY_LABEL }, gate: { ...gate, headRefOid: 'old' }, api: a });
  assert.equal(r.ok, false);
});
test('dry-run performs no writes and failed receipt compensates label', async () => { const d = api(); assert.equal((await reconcileMergeReady({ pr, config: { enabled: true, label: READY_LABEL }, gate, api: d, dryRun: true })).writes, 0); assert.deepEqual(d.calls, []); const a = api([], true); const r = await reconcileMergeReady({ pr, config: { enabled: true, label: READY_LABEL }, gate, api: a }); assert.equal(r.ok, false); assert.deepEqual(a.calls.map((x) => x[0]), ['add', 'receipt', 'remove']); });
test('dirty, draft, or mechanical failure removes an existing merge-ready label', async () => {
  for (const extra of [{ isDraft: true }, { state: 'CLOSED' }]) {
    const a = api([READY_LABEL], false, extra);
    const r = await reconcileMergeReady({ pr, config: { enabled: true, label: READY_LABEL }, gate, api: a });
    assert.equal(r.action, 'removed');
  }
  const dirty = api([READY_LABEL]);
  const r = await reconcileMergeReady({ pr, config: { enabled: true, label: READY_LABEL }, gate: { ...gate, canMergeMechanical: false }, api: dirty });
  assert.equal(r.action, 'removed');
});

function cliFixture(rules) {
  const root = mkdtempSync(join(tmpdir(), 'merge-ready-cli-'));
  const rulesFile = join(root, 'pr-rules.json'); writeFileSync(rulesFile, JSON.stringify(rules));
  const fakeGh = join(root, 'gh'); writeFileSync(fakeGh, '#!/bin/sh\nprintf "unexpected gh command: %s\\n" "$*" >&2\nexit 97\n'); chmodSync(fakeGh, 0o755);
  const fakeGit = join(root, 'git'); writeFileSync(fakeGit, '#!/bin/sh\nif [ "$1 $2 $3" = "remote get-url origin" ]; then echo https://github.com/xindong/mivo-canvas-plugin.git; exit 0; fi\nprintf "unexpected git command: %s\\n" "$*" >&2\nexit 98\n'); chmodSync(fakeGit, 0o755);
  return { root, rulesFile, fakeGh, fakeGit };
}
function runCli(args, fixture) {
  return spawnSync(process.execPath, ['scripts/merge-ready-reconcile.mjs', ...args], { cwd: join(dirname(new URL(import.meta.url).pathname), '..'), encoding: 'utf8', env: { ...process.env, REVIEW_PR_RULES_FILE: fixture.rulesFile, PATH: `${fixture.root}:${process.env.PATH}` } });
}

test('Mivo CLI requests the workflow without reading old-base writer policy or invoking gh', () => {
  for (const rules of [{}, { mergeReady: { enabled: true, repo: MIVO_REPO } }, { mergeReady: 'invalid-old-base' }]) {
    const f = cliFixture(rules);
    const r = runCli(['7'], f);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, action: 'reconcile-required', publisher: 'workflow', writes: 0,
      prs: [{ repo: MIVO_REPO, number: 7 }] });
    assert.doesNotMatch(r.stderr, /unexpected gh command/);
  }
});

const config = { enabled: true, label: READY_LABEL };
test('native clean gate publishes receipt and retains confirmed label', async () => {
  const a = api();
  const result = await reconcileMergeReady({ pr, config, gate, api: a });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'added');
  assert.deepEqual(a.calls.map(x => x[0]), ['add', 'receipt']);
});
test('missing gate base and discussion hold invalidate readiness', async () => {
  for (const [candidate, labels] of [[{ ...gate, baseRefOid: undefined }, [READY_LABEL]], [gate, [READY_LABEL, 'awaiting-discussion']]]) {
    const a = api(labels);
    const result = await reconcileMergeReady({ pr, config, gate: candidate, api: a });
    assert.notEqual(result.ready, true);
    assert.equal((await a.readPullRequest()).labels.includes(READY_LABEL), false);
    assert.equal(a.calls.some(x => x[0] === 'receipt'), false);
  }
});
test('pre-merge exception revokes an old label, but dry-run never writes', async () => {
  for (const dryRun of [false, true]) {
    const a = api([READY_LABEL]);
    const result = await reconcileMergeReady({ pr, config, api: a, dryRun, loadGate: async () => { throw new Error('premerge unavailable'); } });
    assert.equal(result.ok, false);
    assert.equal(result.invalidated, !dryRun);
    assert.deepEqual(a.calls.map(x => x[0]), dryRun ? [] : ['remove']);
  }
});
test('unknown head/base/draft/state never authorizes a label', async () => {
  for (const extra of [{ headRefOid: undefined }, { headRefOid: '' }, { baseRefOid: undefined }, { baseRefOid: '' }, { state: undefined }, { state: 'UNKNOWN' }, { isDraft: undefined }, { isDraft: null }]) {
    const a = api([READY_LABEL], false, extra);
    const result = await reconcileMergeReady({ pr, config, gate, api: a });
    assert.notEqual(result.ready, true);
    assert.equal((await a.readPullRequest()).labels.includes(READY_LABEL), false);
    assert.equal(a.calls.some(x => x[0] === 'receipt'), false);
  }
});
test('existing label is revoked on receipt failure even when no add occurred', async () => {
  const a = api([READY_LABEL], true);
  const result = await reconcileMergeReady({ pr, config, gate, api: a });
  assert.equal(result.invalidated, true);
  assert.deepEqual(a.calls.map(x => x[0]), ['receipt', 'remove']);
});
test('successful delete response without actual absence is unconfirmed', async () => {
  const a = api([READY_LABEL], true);
  a.removeLabel = async () => {};
  const result = await reconcileMergeReady({ pr, config, gate, api: a });
  assert.equal(result.action, 'invalidation-unconfirmed');
  assert.equal(result.invalidated, false);
});
test('failed delete or verification read is unconfirmed', async () => {
  for (const failure of ['delete', 'read']) {
    const a = api([READY_LABEL], true);
    if (failure === 'delete') a.removeLabel = async () => { throw new Error('permission denied'); };
    else {
      const read = a.readPullRequest;
      let count = 0;
      a.readPullRequest = async () => { if (++count >= 3) throw new Error('network down'); return read(); };
    }
    const result = await reconcileMergeReady({ pr, config, gate, api: a });
    assert.equal(result.action, 'invalidation-unconfirmed');
    assert.equal(result.invalidated, false);
  }
});
test('head/base and draft races revoke already-present labels', async () => {
  for (const change of [{ headRefOid: 'new' }, { baseRefOid: 'new' }, { isDraft: true }]) {
    const a = api([READY_LABEL]);
    const read = a.readPullRequest;
    let count = 0;
    a.readPullRequest = async () => ({ ...await read(), ...(++count >= 2 ? change : {}) });
    const result = await reconcileMergeReady({ pr, config, gate, api: a });
    assert.equal(result.ok, false);
    assert.equal(result.invalidated, true);
  }
});
test('publication race invalidates label after successful receipt write', async () => {
  const a = api([READY_LABEL]);
  const read = a.readPullRequest;
  let count = 0;
  a.readPullRequest = async () => ({ ...await read(), ...(++count >= 3 ? { headRefOid: 'next' } : {}) });
  const result = await reconcileMergeReady({ pr, config, gate, api: a });
  assert.equal(result.invalidated, true);
  assert.deepEqual(a.calls.map(x => x[0]), ['receipt', 'remove']);
});
