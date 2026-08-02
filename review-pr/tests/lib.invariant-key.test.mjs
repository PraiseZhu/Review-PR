// invariantKey 单测 —— SKILL 5.0 跨轮识别"同 family 复发"的一级(确定性)判定用
// **权威** join key(2026-08-02 定案,取代早前误用的 invariantSlug)。纯函数,
// 唯一实现见 lib.review-output-shape.mjs 文件头部说明(per-PR convergence state
// 与本 skill 必须共用这一份归一化 + hash,不得各自重实现)。
//
// 本文件的核心任务是锁住 gpt 实跑复现的那个阻断:invariantSlug 因为截断到 64
// 字符,两条"前 64 字符相同、尾部完全不同"的 invariant 会被误判成同一个 key
// (真实后果:两个不同的问题被机器判定成"同一个 family 复发",newFamilyCount
// 从 1 错成 0,漏掉一个真问题)。invariantKey 用完整文本的 SHA-256、不截断,
// 这类碰撞不应该再发生——本文件的第一条测试就是直接把这个场景搬过来断言"不
// 再误判"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invariantKey } from '../scripts/lib.review-output-shape.mjs';

test('gpt 阻断复现场景:前 64 字符相同、尾部完全不同的两条 invariant 必须算出不同的 key(不再误判复发)', () => {
  const base = 'a'.repeat(64);
  const k1 = invariantKey(`${base}前半相同后面不同一二三四五六七八九十`);
  const k2 = invariantKey(`${base}前半相同后面不同壹贰叄肆伍陆柒捌玖拾`);
  assert.notEqual(k1, k2, '完整 hash 不截断,尾部不同就必须产出不同 key——这正是本轮要修的阻断');
});

test('确定性:同一输入调用两次得到完全相同的 key', () => {
  const input = '同一状态只能有一个写入方';
  assert.equal(invariantKey(input), invariantKey(input));
});

test('大小写差异 → 同 key(与 invariantSlug 共用同一套归一化,避免大小写造成假阴性)', () => {
  assert.equal(invariantKey('Foo Bar Invariant'), invariantKey('foo bar invariant'));
});

test('内部空白差异(多空格/tab/换行/中英文混排空格位置)→ 同 key', () => {
  assert.equal(invariantKey('foo   bar   baz'), invariantKey('foobarbaz'));
  assert.equal(invariantKey('foo\tbar\nbaz'), invariantKey('foobarbaz'));
  assert.equal(
    invariantKey('the state 只能 有一个 writer'),
    invariantKey('thestate只能有一个writer'),
  );
});

test('任意长度都不截断:超长文本(远超 64 字符)不同尾部依然产出不同 key', () => {
  const veryLong = 'x'.repeat(1000);
  assert.notEqual(invariantKey(`${veryLong}结尾A`), invariantKey(`${veryLong}结尾B`));
});

test('输出形状:带算法版本前缀 ik1-,后跟 64 个十六进制字符(SHA-256)', () => {
  const key = invariantKey('随便一个不变量');
  assert.match(key, /^ik1-[0-9a-f]{64}$/);
});

test('非字符串/空白输入 → throw TypeError,不是返回空字符串(与 invariantSlug 同款校验,同一个共享实现)', () => {
  for (const bad of [undefined, null, 42, {}, [], true, '', '   ', '\t\n']) {
    assert.throws(() => invariantKey(bad), TypeError);
  }
});

test('输出长度固定为 4(前缀)+64(hex),不随输入长度变化——证明没有偷偷复用 invariantSlug 的截断路径', () => {
  const short = invariantKey('短');
  const long = invariantKey('a'.repeat(64) + '前半相同后面不同一二三四五六七八九十');
  assert.equal(short.length, 68);
  assert.equal(long.length, 68);
});
