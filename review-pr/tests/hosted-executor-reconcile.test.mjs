#!/usr/bin/env node
// 历史 ledger 不按新 executor 规则重开：既有 stage2 clean receipt 仍可 reconcile。
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileMergeReady, READY_LABEL, MIVO_REPO } from '../scripts/merge-ready-reconcile.mjs';
import { validateReviewOutput } from '../scripts/lib.review-consume.mjs';

const pr = { repo: MIVO_REPO, number: 7 };
const bindings = {
  source: 'consume-review-output', schemaVersion: 'rro-1', outputHash: 'o', snapshotHash: 's',
  ledgerHash: 'l', escapeSourceHash: 'e', knownHazardsHash: 'h', headRefOid: 'head',
};
const gate = {
  stage2Clean: true, receiptGate: { stage2Clean: true, snapshotHash: 's' },
  reviewReceipt: { verdict: 'clean', ...bindings },
  baseRefOid: 'base', headRefOid: 'head', snapshotHash: 's',
  securityGate: { pass: true }, canMergeMechanical: true,
};
function api(labels = []) {
  const calls = [];
  const current = [...labels];
  return {
    calls,
    readPullRequest: async () => ({ baseRefOid: 'base', headRefOid: 'head', isDraft: false, state: 'OPEN', labels: [...current] }),
    addLabel: async (x) => { current.push(x); calls.push(['add', x]); },
    removeLabel: async (x) => { const i = current.indexOf(x); if (i >= 0) current.splice(i, 1); calls.push(['remove', x]); },
    writeReceipt: async () => { calls.push(['receipt']); },
  };
}

test('旧 clean receipt 不含 executor 仍可 reconcile（不重开 ledger）', async () => {
  const a = api();
  const r = await reconcileMergeReady({ pr, config: { enabled: true, label: READY_LABEL }, gate, api: a });
  assert.equal(r.ok, true);
  assert.ok(['added', 'unchanged'].includes(r.action));
});

test('当前答卷缺 executor 的 verificationRuns 被新 pin 判非法（与历史 receipt 分离）', () => {
  const output = {
    schemaVersion: 'rro-1', snapshotHash: 's',
    findingFamilies: [], verificationGaps: [],
    verificationRuns: [{ runId: 'r1', command: 'node x', exitCode: 2, outputAnchor: 'x' }],
    profileAnswers: [], findingDispositions: [], negativeEvidence: [],
    escapeAssessment: [], segmentReceipts: [], modelVerdictNote: 'x',
  };
  const shape = validateReviewOutput(output, { snapshotHash: 's' });
  assert.equal(shape.ok, false);
  assert.ok(shape.errors.some((e) => e.includes('executor')));
});
