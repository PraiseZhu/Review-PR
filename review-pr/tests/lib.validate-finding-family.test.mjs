// validateFindingFamily 单测 —— SKILL 第 4 节第 6 条「family 归族」输出契约的形状
// 校验(conv/output-contract,D2:机器只验形状,不判断是否真的同族)。纯函数,零依赖。
//
// 反向变异纪律:先写"预测红集"(MUTATIONS 数组,每条改坏一个字段、预测对应报错子串),
// 再逐条跑断言 —— 红集必须恰好命中预测的那一条错误,且改坏单个字段不应牵连出预测
// 之外的其它错误(除 severity/成员一致性这类天然联动的情况,已在对应用例单独说明)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFindingFamily } from '../scripts/lib.review-output-shape.mjs';

function validFamily() {
  return {
    family_id: 'f1',
    invariant: '同一状态只能有一个写入方',
    severity: 'P1',
    fixGuidance: '修复必须覆盖该不变量的全部路径，包括本报告未点名处',
    manifestations: [
      {
        path: 'src/a.ts',
        line: 10,
        evidence: '两处都写了 store.value',
        impact: '并发写入可能互相覆盖',
        fix: '收口到唯一 setter',
        verification: '跑并发写入回归测试',
        severity: 'P1',
      },
      {
        path: 'src/b.ts',
        line: 42,
        evidence: '同一状态在这里也被直接赋值',
        impact: '与 a.ts 的写入竞争',
        fix: '改为调用 a.ts 的 setter',
        verification: '跑并发写入回归测试',
        severity: 'P1',
      },
    ],
  };
}

test('基线:合法 family(2 条 manifestations)通过,errors 为空数组', () => {
  const r = validateFindingFamily(validFamily());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('单条 manifestation 也合法(第 1 轮就建族,不等复发)', () => {
  const f = validFamily();
  f.manifestations = [f.manifestations[0]];
  const r = validateFindingFamily(f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('family 本体不是对象(null/数组/字符串)→ 单条"不是对象"错误,不继续深入校验字段', () => {
  for (const bad of [null, [], 'x', 42]) {
    const r = validateFindingFamily(bad);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['family 不是对象']);
  }
});

// ── 预测红集:每条只改坏 validFamily() 的一个字段,预测该字段对应的报错子串 ──
const MUTATIONS = [
  {
    name: 'family_id 缺失',
    mutate: (f) => { delete f.family_id; },
    expectSubstr: 'family_id 缺失或非法',
  },
  {
    name: 'family_id 是空字符串',
    mutate: (f) => { f.family_id = '   '; },
    expectSubstr: 'family_id 缺失或非法',
  },
  {
    name: 'invariant 缺失',
    mutate: (f) => { delete f.invariant; },
    expectSubstr: 'invariant 缺失或非法',
  },
  {
    name: 'fixGuidance 缺失(未写"修复必须覆盖全部路径"那句)',
    mutate: (f) => { delete f.fixGuidance; },
    expectSubstr: 'fixGuidance 缺失或非法',
  },
  {
    name: 'severity 不是 P0/P1(误用 dash 的 blocker 术语,违反 D1)',
    mutate: (f) => { f.severity = 'blocker'; },
    expectSubstr: 'severity 缺失或非法',
  },
  {
    name: 'severity 缺失',
    mutate: (f) => { delete f.severity; },
    expectSubstr: 'severity 缺失或非法',
  },
  {
    name: 'manifestations 为空数组(单条也不建族 = 违反第 4 节第 6 条)',
    mutate: (f) => { f.manifestations = []; },
    expectSubstr: 'manifestations 缺失或为空',
  },
  {
    name: 'manifestations 缺失',
    mutate: (f) => { delete f.manifestations; },
    expectSubstr: 'manifestations 缺失或为空',
  },
  {
    name: 'manifestations[0].path 缺失(丢了定位信息，违反 D3 折叠不丢保护)',
    mutate: (f) => { delete f.manifestations[0].path; },
    expectSubstr: 'manifestations[0].path 缺失或非法',
  },
  {
    name: 'manifestations[0].line 是 0(非正整数)',
    mutate: (f) => { f.manifestations[0].line = 0; },
    expectSubstr: 'manifestations[0].line 缺失或非法',
  },
  {
    name: 'manifestations[0].line 是字符串',
    mutate: (f) => { f.manifestations[0].line = '10'; },
    expectSubstr: 'manifestations[0].line 缺失或非法',
  },
  {
    name: 'manifestations[1].evidence 缺失',
    mutate: (f) => { delete f.manifestations[1].evidence; },
    expectSubstr: 'manifestations[1].evidence 缺失或非法',
  },
  {
    name: 'manifestations[1].impact 缺失',
    mutate: (f) => { delete f.manifestations[1].impact; },
    expectSubstr: 'manifestations[1].impact 缺失或非法',
  },
  {
    name: 'manifestations[0].fix 缺失',
    mutate: (f) => { delete f.manifestations[0].fix; },
    expectSubstr: 'manifestations[0].fix 缺失或非法',
  },
  {
    name: 'manifestations[0].verification 缺失',
    mutate: (f) => { delete f.manifestations[0].verification; },
    expectSubstr: 'manifestations[0].verification 缺失或非法',
  },
  {
    name: 'manifestations[1].severity 非法',
    mutate: (f) => { f.manifestations[1].severity = 'major'; },
    expectSubstr: 'manifestations[1].severity 缺失或非法',
  },
  {
    name: 'manifestations[0] 不是对象',
    mutate: (f) => { f.manifestations[0] = 'oops'; },
    expectSubstr: 'manifestations[0] 不是对象',
  },
];

test('反向变异:预测红集里每条改坏都恰好命中预测的那条错误(红集 = 预测集)', () => {
  for (const { name, mutate, expectSubstr } of MUTATIONS) {
    const f = validFamily();
    mutate(f);
    const r = validateFindingFamily(f);
    assert.equal(r.ok, false, `[${name}] 期望 ok=false`);
    const hit = r.errors.some((e) => e.includes(expectSubstr));
    assert.ok(hit, `[${name}] 期望 errors 命中子串「${expectSubstr}」,实际 errors=${JSON.stringify(r.errors)}`);
  }
});

test('绿集对照:预测红集之外,合法基线本身不产生任何一条红集里的错误子串(证明红集不是凑出来的)', () => {
  const r = validateFindingFamily(validFamily());
  for (const { expectSubstr } of MUTATIONS) {
    assert.ok(!r.errors.some((e) => e.includes(expectSubstr)), `基线不应命中「${expectSubstr}」`);
  }
});

test('severity 与成员最高不一致:family 写 P1 但存在 P0 成员 → 报不一致,且不掩盖该成员自身合法', () => {
  const f = validFamily();
  f.manifestations[0].severity = 'P0';
  // family.severity 仍是 P1,但成员最高是 P0 → 不一致
  const r = validateFindingFamily(f);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('severity 与成员最高 severity 不一致')));
  assert.ok(r.errors.some((e) => e.includes('family.severity=P1')));
  assert.ok(r.errors.some((e) => e.includes('成员最高=P0')));
});

test('severity 与成员最高一致(family=P0,某成员=P0)→ 不报不一致错误', () => {
  const f = validFamily();
  f.severity = 'P0';
  f.manifestations[0].severity = 'P0';
  // manifestations[1] 仍是 P1,最高应为 P0,与 family.severity 一致
  const r = validateFindingFamily(f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('某条 manifestation.severity 本身非法时,不重复报"与成员最高不一致"(避免噪音掩盖真正的错误)', () => {
  const f = validFamily();
  f.manifestations[0].severity = 'major'; // 本身就不合法
  const r = validateFindingFamily(f);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('manifestations[0].severity 缺失或非法')));
  assert.ok(!r.errors.some((e) => e.includes('与成员最高 severity 不一致')));
});

test('多字段同时改坏时一次性收集全部错误,不因遇到第一条就短路', () => {
  const f = validFamily();
  delete f.family_id;
  delete f.manifestations[0].path;
  delete f.manifestations[1].fix;
  const r = validateFindingFamily(f);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
});
