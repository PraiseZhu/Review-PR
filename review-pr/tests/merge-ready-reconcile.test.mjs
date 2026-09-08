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

test('CLI default-off exits zero and never invokes even fake gh', () => { const f = cliFixture({}); const r = runCli(['7'], f); assert.equal(r.status, 0); assert.deepEqual(JSON.parse(r.stdout), { ok: true, action: 'disabled', writes: 0 }); assert.doesNotMatch(r.stderr, /unexpected gh command/); });
test('CLI enabled path uses real pre-merge entry and fails closed on missing consumer receipt', () => { const f = cliFixture({ mergeReady: { enabled: true, repo: MIVO_REPO } }); const r = runCli(['7', '--dry-run'], f); assert.notEqual(r.status, 0); assert.match(r.stderr, /unexpected gh command|Command failed|Error|gh/); assert.doesNotMatch(r.stdout, /"action":"added"/); });
