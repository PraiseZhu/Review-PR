// SC-R5 台账单测:effective-open 谓词、resolved freshness、preflight 规则版本核销、
// 交互通道纪律、损坏 fail-closed、ledgerHash 序无关。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveFindingId, derivePreflightFindingId, loadLedger, saveLedger, computeLedgerHash,
  isEffectiveOpen, summarize, applyReviewOutput, applyInteractiveConfirmation, ledgerPathFor,
} from '../scripts/lib.findings-ledger.mjs';

const SNAP1 = { snapshotHash: 'snap1-aaa' };
const SNAP2 = { snapshotHash: 'snap1-bbb' };
const FAM = () => ({
  family_id: 'f1', invariant: '等待谓词必须真的等待', severity: 'P1',
  manifestations: [{ path: 'e2e/a.mjs', line: 10, evidence: 'e', impact: 'i', fix: 'f', verification: 'v', severity: 'P1' }],
  fixGuidance: 'g',
});
const OUT = (over = {}) => ({ findingFamilies: [], findingDispositions: [], ...over });

test('findingId 派生稳定且与 family_id 无关(跨轮身份=invariantKey+path+line)', () => {
  const a = deriveFindingId({ invariant: ' 等待谓词必须真的等待 ', path: 'e2e/a.mjs', line: 10 });
  const b = deriveFindingId({ invariant: '等待谓词 必须真的等待', path: 'e2e/a.mjs', line: 10 });
  assert.equal(a, b, '归一化后同 invariant 同锚点 → 同 id');
  assert.notEqual(a, deriveFindingId({ invariant: '等待谓词必须真的等待', path: 'e2e/b.mjs', line: 10 }));
});

test('新 finding 入账 open;effective-open/accepted-risk 汇总;同轮重复入账幂等', () => {
  const r1 = applyReviewOutput({ entries: [], output: OUT({ findingFamilies: [FAM()] }), seat: 'auto', snapshot: SNAP1 });
  assert.equal(r1.errors.length, 0);
  assert.equal(r1.entries.length, 1);
  assert.equal(r1.entries[0].status, 'open');
  const r2 = applyReviewOutput({ entries: r1.entries, output: OUT({ findingFamilies: [FAM()] }), seat: 'auto', snapshot: SNAP2 });
  assert.equal(r2.entries.length, 1, '同 id 不重复入账');
  assert.deepEqual(summarize(r2.entries, SNAP2.snapshotHash), { effectiveOpenCount: 1, acceptedRiskCount: 0 });
});

test('resolved freshness:同 origin snapshot 自称 resolved → errors(整轮按 invalid 处理);新 snapshot + 证据 → 关闭', () => {
  const { entries } = applyReviewOutput({ entries: [], output: OUT({ findingFamilies: [FAM()] }), seat: 'auto', snapshot: SNAP1 });
  const id = entries[0].findingId;
  const same = applyReviewOutput({ entries, output: OUT({ findingDispositions: [{ findingId: id, disposition: 'resolved', evidence: 'x' }] }), seat: 'auto', snapshot: SNAP1 });
  assert.ok(same.errors.some((e) => /同 snapshot 禁自证已修/.test(e)));
  const fresh = applyReviewOutput({ entries, output: OUT({ findingDispositions: [{ findingId: id, disposition: 'resolved', evidence: 'diff 锚点' }] }), seat: 'auto', snapshot: SNAP2 });
  assert.equal(fresh.errors.length, 0);
  assert.equal(fresh.entries[0].status, 'resolved');
  assert.deepEqual(summarize(fresh.entries, SNAP2.snapshotHash), { effectiveOpenCount: 0, acceptedRiskCount: 0 });
});

test('invalidated 是主张不关门:effective-open 仍算;交互确认后才关闭;auto 通道拒确认', () => {
  const { entries } = applyReviewOutput({ entries: [], output: OUT({ findingFamilies: [FAM()] }), seat: 'auto', snapshot: SNAP1 });
  const id = entries[0].findingId;
  const inv = applyReviewOutput({ entries, output: OUT({ findingDispositions: [{ findingId: id, disposition: 'invalidated', basis: '误报:该行在 fixture 内' }] }), seat: 'auto', snapshot: SNAP2 });
  assert.equal(inv.errors.length, 0);
  assert.equal(inv.entries[0].status, 'invalidated');
  assert.equal(isEffectiveOpen(inv.entries[0], SNAP2.snapshotHash), true, '模型单方 invalidated 不关门');
  const denied = applyInteractiveConfirmation({ entries: inv.entries, confirmation: { findingId: id, action: 'confirm-invalidated', reason: 'r', snapshotHash: SNAP2.snapshotHash }, mode: 'auto' });
  assert.ok(denied.error, 'auto 模式无确认出口');
  const confirmed = applyInteractiveConfirmation({ entries: inv.entries, confirmation: { findingId: id, action: 'confirm-invalidated', reason: '复核过,fixture 目录', snapshotHash: SNAP2.snapshotHash }, mode: 'interactive' });
  assert.equal(confirmed.error, null);
  assert.equal(isEffectiveOpen(confirmed.entries[0], SNAP2.snapshotHash), false);
});

test('accepted-risk:交互通道进入;current snapshot 计入 acceptedRiskCount(恒阻 clean);snapshot 漂移恢复 effective-open;P0 拒', () => {
  const { entries } = applyReviewOutput({ entries: [], output: OUT({ findingFamilies: [FAM()] }), seat: 'interactive', snapshot: SNAP1 });
  const id = entries[0].findingId;
  const acc = applyInteractiveConfirmation({ entries, confirmation: { findingId: id, action: 'accept-risk', reason: '演示仓,已知风险', snapshotHash: SNAP1.snapshotHash }, mode: 'interactive' });
  assert.equal(acc.error, null);
  assert.deepEqual(summarize(acc.entries, SNAP1.snapshotHash), { effectiveOpenCount: 0, acceptedRiskCount: 1 });
  assert.deepEqual(summarize(acc.entries, SNAP2.snapshotHash), { effectiveOpenCount: 1, acceptedRiskCount: 0 }, 'head/base 漂移 → stale accepted-risk 恢复阻断');
  const p0 = [{ ...entries[0], findingId: 'fid1-x', severity: 'P0' }];
  const deny = applyInteractiveConfirmation({ entries: p0, confirmation: { findingId: 'fid1-x', action: 'accept-risk', reason: 'r', snapshotHash: SNAP1.snapshotHash }, mode: 'interactive' });
  assert.match(deny.error, /P0\/安全/);
});

test('preflight 项:人工/模型 resolved 拒;同规则同版本新 snapshot 不命中 → 自动核销;版本变 → 保持 open', () => {
  const hit = { ruleId: 'playwright-async-predicate', ruleVersion: 'v1', path: 'e2e/a.mjs', line: 5 };
  const r1 = applyReviewOutput({ entries: [], output: OUT(), seat: 'auto', snapshot: SNAP1, preflightHits: [hit] });
  const id = derivePreflightFindingId(hit);
  assert.equal(r1.entries[0].findingId, id);
  const manual = applyReviewOutput({ entries: r1.entries, output: OUT({ findingDispositions: [{ findingId: id, disposition: 'resolved', evidence: 'x' }] }), seat: 'auto', snapshot: SNAP2 });
  assert.ok(manual.errors.some((e) => /不接受人工\/模型 resolved/.test(e)));
  // 版本变:不自动核销
  const vchg = applyReviewOutput({ entries: r1.entries, output: OUT(), seat: 'auto', snapshot: SNAP2, preflightHits: [{ ...hit, path: 'other.mjs', ruleVersion: 'v2' }] });
  assert.equal(vchg.entries.find((e) => e.findingId === id).status, 'open', '规则版本变化不冒充代码已修');
  // 同版本重跑不命中:自动核销
  const clean = applyReviewOutput({ entries: r1.entries, output: OUT(), seat: 'auto', snapshot: SNAP2, preflightHits: [{ ...hit, path: 'other.mjs' }] });
  assert.equal(clean.entries.find((e) => e.findingId === id).status, 'resolved');
});

test('load/save:文件缺失=空账;损坏 → ok:false(fail-closed);ledgerHash 与写入顺序无关', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = ledgerPathFor(dir, 469);
  const a = { findingId: 'fid1-a', status: 'open' };
  const b = { findingId: 'fid1-b', status: 'open' };
  assert.equal(loadLedger(file).ok, true);
  const h1 = saveLedger(file, [a, b]);
  const l = loadLedger(file);
  assert.equal(l.ok, true);
  assert.equal(l.ledgerHash, h1);
  assert.equal(computeLedgerHash([b, a]), h1, '序无关');
  writeFileSync(file, '{broken');
  assert.equal(loadLedger(file).ok, false);
});
