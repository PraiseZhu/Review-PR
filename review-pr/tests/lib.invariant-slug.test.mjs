// invariantSlug 单测 —— SKILL 5.0 跨轮识别"同 family 复发"的一级(确定性)判定用
// join key(conv/output-contract)。纯函数,零依赖,唯一实现见
// lib.review-output-shape.mjs 文件头部说明(per-PR convergence state 与本 skill
// 必须共用这一份归一化,不得各自重实现)。
//
// 覆盖:确定性(同输入同输出)、大小写归一、内部空白归一(含中英文混排/多空格/
// 换行)、截断边界(恰好 64 / 超过 64,含已知的截断碰撞)、非法输入必须 throw(不是
// 返回空字符串,静默返回空串会让两个不相关的 family 在 join key 上误撞)。这些
// 测试的作用是:将来有人改动归一化规则(去掉某一步、改截断长度、把 throw 改成
// fallback)会立刻在这里红,而不是等到线上静默漏判一次复发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invariantSlug } from '../scripts/lib.review-output-shape.mjs';

test('确定性:同一输入调用两次得到完全相同的 slug', () => {
  const input = '同一状态只能有一个写入方';
  assert.equal(invariantSlug(input), invariantSlug(input));
});

test('大小写差异 → 同 slug(避免大小写造成假阴性)', () => {
  assert.equal(invariantSlug('Foo Bar Invariant'), invariantSlug('foo bar invariant'));
});

test('内部多个空格差异 → 同 slug', () => {
  assert.equal(invariantSlug('foo   bar   baz'), invariantSlug('foobarbaz'));
});

test('内部 tab/换行差异 → 同 slug(不止折叠单空格,是整段去掉)', () => {
  assert.equal(invariantSlug('foo\tbar\nbaz'), invariantSlug('foobarbaz'));
});

test('中英文混排的空格位置差异 → 同 slug(混排复述时空格位置最不稳定)', () => {
  assert.equal(
    invariantSlug('the state 只能 有一个 writer'),
    invariantSlug('thestate只能有一个writer'),
  );
});

test('恰好 64 字符:不截断,原样保留(边界不多切一个字符)', () => {
  const s64 = 'a'.repeat(64);
  const slug = invariantSlug(s64);
  assert.equal(slug.length, 64);
  assert.equal(slug, s64);
});

test('超过 64 字符:截断到前 64 个字符', () => {
  const s70 = 'a'.repeat(70);
  const slug = invariantSlug(s70);
  assert.equal(slug.length, 64);
  assert.equal(slug, 'a'.repeat(64));
});

test('超过 64 字符且仅尾部(65+)不同 → 已知的截断碰撞,不是 bug(见文件头注释)', () => {
  const base = 'a'.repeat(64);
  const s1 = invariantSlug(`${base}前半相同后面不同一`);
  const s2 = invariantSlug(`${base}前半相同后面不同二`);
  assert.equal(s1, s2);
  assert.equal(s1, base);
});

test('非字符串输入(undefined/null/number/object/array/boolean)→ throw TypeError,不是返回空字符串', () => {
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.throws(() => invariantSlug(bad), TypeError);
  }
});

test('空字符串输入 → throw TypeError,不是返回空字符串', () => {
  assert.throws(() => invariantSlug(''), TypeError);
});

test('纯空白字符串(空格/tab/换行/混合)→ throw TypeError,不是返回空字符串', () => {
  for (const bad of ['   ', '\t\t', '\n\n', ' \t\n ']) {
    assert.throws(() => invariantSlug(bad), TypeError);
  }
});
