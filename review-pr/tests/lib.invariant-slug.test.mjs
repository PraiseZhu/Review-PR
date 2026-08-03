// invariantSlug 单测 —— **仅供人类阅读**的确定性归一化(写在 review 评论正文里给人
// 看的那段文本),**不是**跨轮身份判定用的 join key、也不是 thread marker 的内容
// (2026-08-02 对抗审二次修正:marker 已改用 invariantKey,见文末漂移断言)(2026-08-02
// gpt 阻断修正:早前误当身份用,截断碰撞导致误判复发,已纠正——权威 join key 是
// `invariantKey`,见 lib.invariant-key.test.mjs)。纯函数,唯一实现见
// lib.review-output-shape.mjs 文件头部说明。
//
// 覆盖:确定性(同输入同输出)、大小写归一、内部空白归一(含中英文混排/多空格/
// 换行)、截断边界(恰好 64 / 超过 64)、非法输入必须 throw(不是返回空字符串)。
// 这些测试的作用是:将来有人改动归一化规则(去掉某一步、改截断长度、把 throw 改成
// fallback)会立刻在这里红。**不再**断言"截断碰撞是可接受的"——那条断言是在
// invariantSlug 还被当身份用的语境下写的,已被 gpt 实跑证伪并删除(见下方
// convergence-state.test.mjs 的等价场景改成断言"不再误判复发")。展示层碰撞
// (两个不同 family 显示同一段文本)本身无害,不需要专门断言它"可接受"——它
// 只是这个函数会截断这一事实的自然推论,已经被"截断边界"两条测试覆盖到。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// 文档漂移断言(2026-08-02 对抗审 finding 1):thread marker 是**机器读取**用来定位
// thread 的,所以它必须是 invariantKey(不截断);写 slug 会让两条前 64 字相同的
// invariant 算出同一个 marker,把 family B 的更新追加进 family A 的 thread。
// 这条缺陷上一轮之所以存活,正是因为「代码改对了、文档留着旧契约」——marker 规则
// 只活在 SKILL.md 里(生产代码既不产出也不解析它),没有断言就会再漂一次。
test('文档漂移:SKILL.md 的 thread marker 规范必须用 invariantKey,不得回退成 slug', () => {
  const skillPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md');
  const skill = readFileSync(skillPath, 'utf8');
  assert.ok(
    skill.includes('`<!-- family-anchor: <invariantKey> -->`'),
    'SKILL.md 必须把 marker 规范写成 `<!-- family-anchor: <invariantKey> -->`',
  );
  assert.ok(
    !skill.includes('family-anchor: <slug>'),
    'SKILL.md 不得再出现 `family-anchor: <slug>`——那会把截断碰撞请回 thread 定位',
  );
  assert.ok(
    /legacy 的 slug marker 一律不匹配/.test(skill),
    'SKILL.md 必须明写 legacy slug marker 不做 fallback 匹配(兼容旧 marker 等于把碰撞请回来)',
  );
});
