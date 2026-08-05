// mergeLedgerJson 的 escapedHazards 合并(SC-R7 完成度核验):rebase 时不得丢掉任一侧新登记
// 的 hazard,且合并**不增条、不降级**(active 不回退 pending-fix-merge;landed 不回退 pending)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedgerJson } from '../scripts/lib.mjs';

const HZ = (over) => ({
  hazardId: 'hz1-a', repo: 'o/r', fingerprint: 'hzf1-a', originPr: 1, fixPr: 2, fixHead: 'a'.repeat(40),
  pattern: 'p', paths: ['a/**'], activationStatus: 'pending-fix-merge', promotionStatus: 'pending', ...over,
});
const doc = (hazards, entries = []) => JSON.stringify({ version: 1, entries, escapedHazards: hazards });

test('两侧各自新登记的 hazard 取并集(rebase 不丢条)', () => {
  const ours = doc([HZ({ hazardId: 'hz1-a' })]);
  const theirs = doc([HZ({ hazardId: 'hz1-b' })]);
  const merged = JSON.parse(mergeLedgerJson(ours, theirs));
  assert.deepEqual(merged.escapedHazards.map((h) => h.hazardId).sort(), ['hz1-a', 'hz1-b']);
});

test('同 (repo, hazardId):不增条,且状态取更高档(active/landed 不被回退)', () => {
  const active = doc([HZ({ activationStatus: 'active', promotionStatus: 'landed', promotionTarget: { kind: 'rule', ruleId: 'x' } })]);
  const stale = doc([HZ({ activationStatus: 'pending-fix-merge', promotionStatus: 'pending' })]);
  for (const [a, b] of [[active, stale], [stale, active]]) {
    const merged = JSON.parse(mergeLedgerJson(a, b));
    assert.equal(merged.escapedHazards.length, 1, '不增条');
    assert.equal(merged.escapedHazards[0].activationStatus, 'active', '不降级(方向无关)');
    assert.equal(merged.escapedHazards[0].promotionStatus, 'landed');
  }
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
