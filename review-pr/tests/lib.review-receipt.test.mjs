// 阶段二独立审查回执单测 —— P1-5(2026-08-02)。admin-trust 分级合并路由
// (decideStructuralBypassRoute 的 review-pending-admin-bypass)只是"路由结论",不代表
// "这次真的审查过而且干净"。isReviewReceiptClean 是 pre-merge-check.mjs 消费的核验函数,
// 必须同时满足:有回执、回执 headRefOid 与当前 head 一致、verdict=clean。
//
// writeReviewReceipt/readReviewReceipt 走 stateFile() 落盘,用系统临时目录,不进 git——
// 每个测试用不同的 PR 号(9000 起报)避免互相污染,且不需要清理(临时目录本就是 ephemeral)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
// 必须排在 ../scripts/lib.mjs **之前**(私有 STATE_DIR;见该 helper 的时序说明):固定 PR
// 号 + 共享持久目录在并发全量跑里会互相覆盖(第 4 轮核验 R0)。
import './helpers.isolated-state-dir.mjs';
import { writeReviewReceipt, readReviewReceipt, isReviewReceiptClean } from '../scripts/lib.mjs';

// SC-R1b(2026-08-05):clean 回执必须携带五项绑定,isReviewReceiptClean 必须同时匹配
// 当前 snapshotHash/ledgerHash。本文件用固定的测试绑定;"不带绑定的旧签名调用必须
// fail-closed"有专门用例。
const B = { source: 'consume-review-output', schemaVersion: 'rro-1', outputHash: 'oh1-t', snapshotHash: 'snap1-t', ledgerHash: 'lh1-t', escapeSourceHash: 'esh1-t', knownHazardsHash: 'khh1-t' };
const cleanOk = (receipt, headRefOid) => isReviewReceiptClean({ receipt, headRefOid, snapshotHash: B.snapshotHash, ledgerHash: B.ledgerHash, escapeSourceHash: B.escapeSourceHash, knownHazardsHash: B.knownHazardsHash });

test('无回执 → isReviewReceiptClean 恒 false', () => {
  assert.equal(isReviewReceiptClean({ receipt: null, headRefOid: 'abc123' }), false);
  assert.equal(readReviewReceipt(900001), null);
});

test('写入 clean 回执后,针对同一 head 读出 → isReviewReceiptClean=true', () => {
  writeReviewReceipt({ pr: 900002, headRefOid: 'sha-aaa', verdict: 'clean', p0p1Count: 0, bindings: B });
  const receipt = readReviewReceipt(900002);
  assert.equal(receipt.headRefOid, 'sha-aaa');
  assert.equal(receipt.verdict, 'clean');
  assert.equal(cleanOk(receipt, 'sha-aaa'), true);
  // SC-R1b:snapshot/ledger 漂移或期望值缺失 → 不 clean(fail-closed)
  const w = (over) => isReviewReceiptClean({ receipt, headRefOid: 'sha-aaa', snapshotHash: B.snapshotHash, ledgerHash: B.ledgerHash, escapeSourceHash: B.escapeSourceHash, knownHazardsHash: B.knownHazardsHash, ...over });
  assert.equal(w({ snapshotHash: 'snap1-other' }), false, 'snapshot 漂移(如 base 前进 head 不变)必须失效');
  assert.equal(w({ ledgerHash: 'lh1-other' }), false, 'ledger 变化(如 clean 后新增 open)必须失效');
  // R7 第 4 轮核验:clean 后 PR body/issue/canonical hazard 内容变化 → stale;期望值缺失 → fail-closed
  assert.equal(w({ escapeSourceHash: 'esh1-other' }), false, '逃逸数据源内容漂移必须失效');
  assert.equal(w({ knownHazardsHash: 'khh1-other' }), false, 'canonical hazard 内容漂移必须失效');
  assert.equal(w({ escapeSourceHash: undefined }), false, '数据源取不到(期望值缺失)必须 fail-closed');
  assert.equal(w({ knownHazardsHash: null }), false, 'canonical 不可读(期望值缺失)必须 fail-closed');
  assert.equal(isReviewReceiptClean({ receipt, headRefOid: 'sha-aaa' }), false, '不带期望 hash 的旧签名调用必须 fail-closed');
});

test('P1-5 核心:回执 headRefOid 与当前 head 不一致(审查通过后又推了新 commit)→ false,必须重新审查', () => {
  writeReviewReceipt({ pr: 900003, headRefOid: 'sha-old', verdict: 'clean', p0p1Count: 0, bindings: B });
  const receipt = readReviewReceipt(900003);
  assert.equal(cleanOk(receipt, 'sha-new'), false, '旧 head 的回执不能覆盖新 commit,fail-closed');
});

test('回执 verdict=dirty(审查跑完但没通过)→ isReviewReceiptClean=false', () => {
  writeReviewReceipt({ pr: 900004, headRefOid: 'sha-bbb', verdict: 'dirty', p0p1Count: 2 });
  const receipt = readReviewReceipt(900004);
  assert.equal(cleanOk(receipt, 'sha-bbb'), false);
});

test('回执 p0p1Count>0 即使 verdict 字段被(错误地)写成 clean,也判 false(双重防呆)', () => {
  // 正常流程 writeReviewReceipt 会拒绝 verdict=clean+p0p1Count>0 的组合(见下一测试),
  // 这里直接构造对象验证 isReviewReceiptClean 自身的防呆,不依赖写入侧校验。
  const receipt = { headRefOid: 'sha-ccc', verdict: 'clean', p0p1Count: 3, writtenAt: '2026-08-02T00:00:00Z', ...B };
  assert.equal(cleanOk(receipt, 'sha-ccc'), false);
});

test('writeReviewReceipt 拒绝非法 verdict', () => {
  assert.throws(() => writeReviewReceipt({ pr: 900005, headRefOid: 'sha-ddd', verdict: 'maybe', p0p1Count: 0 }), /verdict/);
});

test('writeReviewReceipt 拒绝空 headRefOid', () => {
  assert.throws(() => writeReviewReceipt({ pr: 900006, headRefOid: '', verdict: 'clean', p0p1Count: 0, bindings: B }), /headRefOid/);
});

test('同一 PR 重新审查后再写入回执 → 覆盖旧回执(不是累加),读出的是最新一条', () => {
  writeReviewReceipt({ pr: 900007, headRefOid: 'sha-v1', verdict: 'dirty', p0p1Count: 1 });
  writeReviewReceipt({ pr: 900007, headRefOid: 'sha-v2', verdict: 'clean', p0p1Count: 0, bindings: B });
  const receipt = readReviewReceipt(900007);
  assert.equal(receipt.headRefOid, 'sha-v2');
  assert.equal(receipt.verdict, 'clean');
});

// ── P2-2(三审修复):p0p1Count 严格校验 —— 此前 isReviewReceiptClean 用
// `(p0p1Count ?? 0) > 0` 判脏,字段缺失(undefined)与负数都会被误判成"没有 P0/P1"从
// 而误判 clean。改用 `Number.isInteger(...) && === 0`,只有明确写着 0 的才算干净。

test('P2-2:p0p1Count 字段缺失(畸形回执)→ isReviewReceiptClean 判不干净,不是误判 clean', () => {
  const receipt = { headRefOid: 'sha-missing', verdict: 'clean', writtenAt: '2026-08-02T00:00:00Z', ...B };
  assert.equal(
    cleanOk(receipt, 'sha-missing'),
    false,
    '旧写法 (undefined ?? 0) > 0 为假,会误判 clean;字段缺失必须 fail-closed 判脏',
  );
});

test('P2-2:p0p1Count 为负数(畸形回执)→ isReviewReceiptClean 判不干净,不是误判 clean', () => {
  const receipt = { headRefOid: 'sha-negative', verdict: 'clean', p0p1Count: -1, writtenAt: '2026-08-02T00:00:00Z', ...B };
  assert.equal(
    cleanOk(receipt, 'sha-negative'),
    false,
    '旧写法 (-1 ?? 0) > 0 为假,会误判 clean;负数必须 fail-closed 判脏',
  );
});

test('P2-2:p0p1Count 为非整数(如 0.5)→ isReviewReceiptClean 判不干净', () => {
  const receipt = { headRefOid: 'sha-float', verdict: 'clean', p0p1Count: 0.5, writtenAt: '2026-08-02T00:00:00Z', ...B };
  assert.equal(cleanOk(receipt, 'sha-float'), false);
});

test('P2-2:writeReviewReceipt 拒绝缺失 p0p1Count(写入侧自己校验,不只指望 CLI)', () => {
  assert.throws(
    () => writeReviewReceipt({ pr: 900008, headRefOid: 'sha-eee', verdict: 'clean', bindings: B }),
    /p0p1Count/,
  );
});

test('P2-2:writeReviewReceipt 拒绝负数 p0p1Count', () => {
  assert.throws(
    () => writeReviewReceipt({ pr: 900009, headRefOid: 'sha-fff', verdict: 'dirty', p0p1Count: -1 }),
    /p0p1Count/,
  );
});

test('P2-2:writeReviewReceipt 拒绝非整数 p0p1Count', () => {
  assert.throws(
    () => writeReviewReceipt({ pr: 900010, headRefOid: 'sha-ggg', verdict: 'dirty', p0p1Count: 1.5 }),
    /p0p1Count/,
  );
});

// ── SC-R1b 新契约 ──

test('SC-R1b:clean 回执缺任一绑定字段 → writeReviewReceipt 拒绝(consumer 事实上唯一 clean writer)', () => {
  for (const k of ['source', 'schemaVersion', 'outputHash', 'snapshotHash', 'ledgerHash', 'escapeSourceHash', 'knownHazardsHash']) {
    const bad = { ...B }; delete bad[k];
    assert.throws(
      () => writeReviewReceipt({ pr: 900011, headRefOid: 'sha-b', verdict: 'clean', p0p1Count: 0, bindings: bad }),
      new RegExp(k),
    );
  }
  assert.throws(() => writeReviewReceipt({ pr: 900011, headRefOid: 'sha-b', verdict: 'clean', p0p1Count: 0 }), /绑定/);
});

test('SC-R1b:dirty 不强制绑定(撤销/打回场景),照常可写', () => {
  const r = writeReviewReceipt({ pr: 900012, headRefOid: 'sha-d', verdict: 'dirty', p0p1Count: 1 });
  assert.equal(r.verdict, 'dirty');
});
