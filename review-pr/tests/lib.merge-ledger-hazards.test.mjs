// mergeLedgerJson 的 escapedHazards 合并(SC-R7 完成度核验):rebase 时不得丢掉任一侧新登记
// 的 hazard,且合并**不增条、不降级**(active 不回退 pending-fix-merge;landed 不回退 pending)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedgerJson } from '../scripts/lib.mjs';

// 合并后会走完整 schema 复验(第 2 轮核验),夹具必须是**合法** hazard
const HZ = (over) => ({
  hazardId: 'hz2-a', repo: 'o/r', fingerprint: 'hzf2-a', originPr: 1, fixPr: 2,
  fixHead: 'a'.repeat(40), originHead: 'b'.repeat(40), evidence: '依据',
  pattern: 'p', paths: ['a/**'], activationStatus: 'pending-fix-merge', promotionStatus: 'pending', ...over,
});
const doc = (hazards, entries = []) => JSON.stringify({ version: 1, entries, escapedHazards: hazards });

test('两侧各自新登记的 hazard 取并集(rebase 不丢条)', () => {
  const ours = doc([HZ({ hazardId: 'hz2-a' })]);
  const theirs = doc([HZ({ hazardId: 'hz2-b' })]);
  const merged = JSON.parse(mergeLedgerJson(ours, theirs));
  assert.deepEqual(merged.escapedHazards.map((h) => h.hazardId).sort(), ['hz2-a', 'hz2-b']);
});

test('同 (repo, hazardId):不增条,且状态取更高档(active/landed 不被回退)', () => {
  const TARGET = { kind: 'rule', ruleId: 'playwright-waitforfunction-async-predicate' };
  const active = doc([HZ({ activationStatus: 'active', promotionStatus: 'landed', promotionTarget: TARGET })]);
  const stale = doc([HZ({ activationStatus: 'pending-fix-merge', promotionStatus: 'pending' })]);
  for (const [a, b] of [[active, stale], [stale, active]]) {
    const merged = JSON.parse(mergeLedgerJson(a, b));
    assert.equal(merged.escapedHazards.length, 1, '不增条');
    assert.equal(merged.escapedHazards[0].activationStatus, 'active', '不降级(方向无关)');
    assert.equal(merged.escapedHazards[0].promotionStatus, 'landed');
  }
  // 第 2 轮核验的确切反例:一方 landed+target,另一方 pending 且**显式** promotionTarget:null
  // → 旧实现一个方向得 landed+null(状态升级却把 target 冲掉),反向得 landed+target。
  const explicitNull = doc([HZ({ activationStatus: 'pending-fix-merge', promotionStatus: 'pending', promotionTarget: null })]);
  const ab = JSON.parse(mergeLedgerJson(active, explicitNull));
  const ba = JSON.parse(mergeLedgerJson(explicitNull, active));
  assert.deepEqual(ab.escapedHazards, ba.escapedHazards, '两个方向必须完全一致');
  assert.deepEqual(ab.escapedHazards[0].promotionTarget, TARGET, 'landed 的 target 不得被显式 null 冲掉');
});

test('不同 repo 的同 hazardId 不合并成一条(repo 是身份的一部分)', () => {
  const merged = JSON.parse(mergeLedgerJson(doc([HZ({ repo: 'o/r1' })]), doc([HZ({ repo: 'o/r2' })])));
  assert.equal(merged.escapedHazards.length, 2);
});

test('缺 hazardId 的条目 → 整体返 null(交调用方 abort 转人工,不冒险)', () => {
  assert.equal(mergeLedgerJson(doc([{ repo: 'o/r' }]), doc([])), null);
});

test('两侧都没有 escapedHazards 段时不凭空造字段(兼容旧台账)', () => {
  const merged = JSON.parse(mergeLedgerJson(JSON.stringify({ version: 1, entries: [] }), JSON.stringify({ version: 1, entries: [] })));
  assert.equal('escapedHazards' in merged, false);
});
