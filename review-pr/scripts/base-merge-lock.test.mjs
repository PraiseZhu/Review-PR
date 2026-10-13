import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBaseMergeLock } from './base-merge-lock.mjs';
import { classifyMergeRejection } from './merge-write-state.mjs';

const parameters = { repo: 'o/r', baseRefName: 'main', pr: 1, head: 'a'.repeat(40), maxWaitMs: 0 };
test('same-base merge transactions exclude each other, while independent bases proceed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'base-merge-lock-test-'));
  try {
    const a = await acquireBaseMergeLock({ ...parameters, directory });
    assert.equal(a.acquired, true);
    const b = await acquireBaseMergeLock({ ...parameters, directory, pr: 2 });
    assert.equal(b.acquired, false);
    assert.equal(b.code, 'base-merge-lock-busy');
    const otherBase = await acquireBaseMergeLock({ ...parameters, directory, baseRefName: 'release/1.x', pr: 3 });
    assert.equal(otherBase.acquired, true);
    otherBase.release();
    assert.equal(a.release().released, true);
    const next = await acquireBaseMergeLock({ ...parameters, directory, pr: 2 });
    assert.equal(next.acquired, true);
    next.release();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a proven rejected mutation can be released or reclaimed after a crash while the PR remains OPEN', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'base-merge-rejected-test-'));
  try {
    const refusal = classifyMergeRejection({ ok: false, stderr: 'GraphQL: Required status check "ci" is failing. (mergePullRequest)' });
    const rejected = await acquireBaseMergeLock({ ...parameters, directory });
    rejected.markMerging();
    rejected.markRejected(refusal);
    assert.throws(() => rejected.assertOwned()); // A completed rejection cannot authorize another write.
    const next = await acquireBaseMergeLock({ ...parameters, directory, pr: 2,
      isAlive: (owner) => owner.token === rejected.token ? false : true,
      reconcileAbandoned: async () => { throw new Error('the durable refusal already proves no mutation occurred'); } });
    assert.equal(next.acquired, true);
    assert.equal(existsSync(rejected.file), false);
    next.markMerging();
    next.markRejected(refusal);
    assert.equal(next.release().released, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent contenders serialize the critical section without sharing or deleting each others ticket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'base-merge-concurrent-test-'));
  let active = 0;
  let peak = 0;
  try {
    await Promise.all([1, 2, 3].map(async (pr) => {
      const lock = await acquireBaseMergeLock({ ...parameters, directory, pr, maxWaitMs: 2000, pollMs: 2 });
      assert.equal(lock.acquired, true);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      --active;
      lock.release();
    }));
    assert.equal(peak, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a dead checker is reclaimable, but an uncertain merge must be reconciled before reclaiming', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'base-merge-recovery-test-'));
  try {
    const checker = await acquireBaseMergeLock({ ...parameters, directory });
    const reclaimed = await acquireBaseMergeLock({ ...parameters, directory, pr: 2,
      isAlive: (owner) => owner.token === checker.token ? false : true });
    assert.equal(reclaimed.acquired, true);
    assert.equal(existsSync(checker.file), false);
    assert.throws(() => checker.assertOwned());
    reclaimed.markMerging();
    assert.equal(reclaimed.release().pending, true);
    const isAlive = (owner) => owner.token === reclaimed.token ? false : true;
    const pending = await acquireBaseMergeLock({ ...parameters, directory, pr: 3, isAlive,
      reconcileAbandoned: async () => false });
    assert.equal(pending.acquired, false);
    assert.equal(pending.code, 'merge-reconciliation-pending');
    assert.equal(existsSync(reclaimed.file), true);
    const recovered = await acquireBaseMergeLock({ ...parameters, directory, pr: 3, isAlive,
      reconcileAbandoned: async (owner) => owner.pr === 2 });
    assert.equal(recovered.acquired, true);
    assert.equal(existsSync(reclaimed.file), false);
    recovered.markMerging();
    assert.equal(recovered.release({ confirmed: true }).released, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
