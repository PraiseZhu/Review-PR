import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, loadReviewSpec, SEVERITY } from './prompt.mjs';
import { SKILL_ROOT } from './common.mjs';

const prompt = (tier = 'standard') => buildReviewPrompt({
  spec: loadReviewSpec(SKILL_ROOT),
  ctx: { pr: 7, meta: { title: 't', author: 'a', url: 'u', headRefOid: 'h', baseRefName: 'main', baseRefOid: 'b' } },
  scope: { mode: 'full', reason: '没有上一轮审查记录' }, workdir: '/w',
  inputs: { contextFile: 'c', diffFile: 'd', scopeFile: 's' }, tier,
});

test('任务书用维护者统一分级,覆盖规范原文的严重度段', () => {
  for (const tier of ['light', 'standard', 'heavy']) {
    const text = prompt(tier);
    assert.ok(text.includes(SEVERITY), `${tier} 档缺统一分级`);
    assert.ok(text.indexOf('### Mivo rule-map') < text.indexOf(SEVERITY), '分级应放在规范原文之后');
    assert.ok(text.indexOf(SEVERITY) < text.indexOf('## 交卷格式'), '分级应放在交卷格式之前');
    assert.match(text, /严重度\*\*不\*\*按下文「严重度」一段/);
    assert.doesNotMatch(text, /严重度以下文「严重度」一段为准/);
  }
});

test('统一分级的关键约束写进任务书', () => {
  assert.match(SEVERITY, /P1 严重缺陷 \| 在受支持场景中存在可信、可达的触发路径/);
  assert.match(SEVERITY, /P2 一般缺陷 .*\| 不报 \|/);
  assert.match(SEVERITY, /P3 改进建议 .*\| 不报 \|/);
  assert.match(SEVERITY, /触发条件、错误行为、实际影响、证据/);
  assert.match(SEVERITY, /违反通用规范、单纯缺测试,都\*\*不能单独\*\*把问题升到 P1/);
  assert.match(SEVERITY, /「记 P1」「按 P1 打回」的具体条款/);
});
