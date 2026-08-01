// 阶段二独立审查回执单测 —— P1-5(2026-08-02)。admin-trust 分级合并路由
// (decideStructuralBypassRoute 的 review-pending-admin-bypass)只是"路由结论",不代表
// "这次真的审查过而且干净"。isReviewReceiptClean 是 pre-merge-check.mjs 消费的核验函数,
// 必须同时满足:有回执、回执 headRefOid 与当前 head 一致、verdict=clean。
//
// writeReviewReceipt/readReviewReceipt 走 stateFile() 落盘,用系统临时目录,不进 git——
// 每个测试用不同的 PR 号(9000 起报)避免互相污染,且不需要清理(临时目录本就是 ephemeral)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeReviewReceipt, readReviewReceipt, isReviewReceiptClean } from '../scripts/lib.mjs';

test('无回执 → isReviewReceiptClean 恒 false', () => {
  assert.equal(isReviewReceiptClean({ receipt: null, headRefOid: 'abc123' }), false);
  assert.equal(readReviewReceipt(900001), null);
});

test('写入 clean 回执后,针对同一 head 读出 → isReviewReceiptClean=true', () => {
  writeReviewReceipt({ pr: 900002, headRefOid: 'sha-aaa', verdict: 'clean', p0p1Count: 0 });
  const receipt = readReviewReceipt(900002);
  assert.equal(receipt.headRefOid, 'sha-aaa');
  assert.equal(receipt.verdict, 'clean');
  assert.equal(isReviewReceiptClean({ receipt, headRefOid: 'sha-aaa' }), true);
});

test('P1-5 核心:回执 headRefOid 与当前 head 不一致(审查通过后又推了新 commit)→ false,必须重新审查', () => {
  writeReviewReceipt({ pr: 900003, headRefOid: 'sha-old', verdict: 'clean', p0p1Count: 0 });
  const receipt = readReviewReceipt(900003);
  assert.equal(isReviewReceiptClean({ receipt, headRefOid: 'sha-new' }), false, '旧 head 的回执不能覆盖新 commit,fail-closed');
});

test('回执 verdict=dirty(审查跑完但没通过)→ isReviewReceiptClean=false', () => {
  writeReviewReceipt({ pr: 900004, headRefOid: 'sha-bbb', verdict: 'dirty', p0p1Count: 2 });
  const receipt = readReviewReceipt(900004);
  assert.equal(isReviewReceiptClean({ receipt, headRefOid: 'sha-bbb' }), false);
});

test('回执 p0p1Count>0 即使 verdict 字段被(错误地)写成 clean,也判 false(双重防呆)', () => {
  // 正常流程 writeReviewReceipt 会拒绝 verdict=clean+p0p1Count>0 的组合(见下一测试),
  // 这里直接构造对象验证 isReviewReceiptClean 自身的防呆,不依赖写入侧校验。
  const receipt = { headRefOid: 'sha-ccc', verdict: 'clean', p0p1Count: 3, writtenAt: '2026-08-02T00:00:00Z' };
  assert.equal(isReviewReceiptClean({ receipt, headRefOid: 'sha-ccc' }), false);
});

test('writeReviewReceipt 拒绝非法 verdict', () => {
  assert.throws(() => writeReviewReceipt({ pr: 900005, headRefOid: 'sha-ddd', verdict: 'maybe', p0p1Count: 0 }), /verdict/);
});

test('writeReviewReceipt 拒绝空 headRefOid', () => {
  assert.throws(() => writeReviewReceipt({ pr: 900006, headRefOid: '', verdict: 'clean', p0p1Count: 0 }), /headRefOid/);
});

test('同一 PR 重新审查后再写入回执 → 覆盖旧回执(不是累加),读出的是最新一条', () => {
  writeReviewReceipt({ pr: 900007, headRefOid: 'sha-v1', verdict: 'dirty', p0p1Count: 1 });
  writeReviewReceipt({ pr: 900007, headRefOid: 'sha-v2', verdict: 'clean', p0p1Count: 0 });
  const receipt = readReviewReceipt(900007);
  assert.equal(receipt.headRefOid, 'sha-v2');
  assert.equal(receipt.verdict, 'clean');
});
