// normalizeLoginList 单测 —— P2-3(2026-08-02):admins 等登录名清单配置的健壮性归一化。
// 三处消费点(context.mjs 的 ADMINS、pre-merge-check.mjs 的 ADMINS、
// findApproveMergeAuthorization 内部的 adminSet)都必须走这一份,不许各自重新实现,也
// 不许对非法配置形态抛 TypeError。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLoginList } from '../scripts/lib.mjs';

test('未配置(null/undefined)是正常默认,不算 invalid', () => {
  assert.deepEqual(normalizeLoginList(null), { logins: [], invalid: false });
  assert.deepEqual(normalizeLoginList(undefined), { logins: [], invalid: false });
});

test('正常字符串数组 → trim + 小写', () => {
  const r = normalizeLoginList(['PraiseZhu', ' kirozeng ', 'AJ0928']);
  assert.deepEqual(r.logins, ['praisezhu', 'kirozeng', 'aj0928']);
  assert.equal(r.invalid, false);
});

test('P2-3 核心:整体非数组(如误配成裸字符串)→ 不抛 TypeError,返回空名单 + invalid=true', () => {
  assert.doesNotThrow(() => normalizeLoginList('PraiseZhu'));
  const r = normalizeLoginList('PraiseZhu');
  assert.deepEqual(r.logins, []);
  assert.equal(r.invalid, true);
});

test('数组混入非字符串(数字/null/对象)→ 不抛 TypeError,过滤掉非法条目,invalid=true', () => {
  assert.doesNotThrow(() => normalizeLoginList(['PraiseZhu', 42, null, { x: 1 }, 'kirozeng']));
  const r = normalizeLoginList(['PraiseZhu', 42, null, { x: 1 }, 'kirozeng']);
  assert.deepEqual(r.logins, ['praisezhu', 'kirozeng']);
  assert.equal(r.invalid, true);
});

test('数组混入空字符串/纯空白字符串 → 过滤掉,invalid=true', () => {
  const r = normalizeLoginList(['PraiseZhu', '', '   ']);
  assert.deepEqual(r.logins, ['praisezhu']);
  assert.equal(r.invalid, true);
});

test('空数组 → logins 为空,invalid=false(数组本身合法,只是没有元素)', () => {
  assert.deepEqual(normalizeLoginList([]), { logins: [], invalid: false });
});

test('数字/对象整体误配 → 同样不抛,返回空名单 + invalid=true', () => {
  assert.doesNotThrow(() => normalizeLoginList(42));
  assert.doesNotThrow(() => normalizeLoginList({ admins: ['x'] }));
  assert.equal(normalizeLoginList(42).invalid, true);
  assert.equal(normalizeLoginList({ admins: ['x'] }).invalid, true);
});
