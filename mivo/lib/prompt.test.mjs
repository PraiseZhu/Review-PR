import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, loadReviewSpec, deferralSection, SEVERITY } from './prompt.mjs';
import { SKILL_ROOT } from './common.mjs';

const prompt = (tier = 'standard', over = {}) => buildReviewPrompt({
  spec: loadReviewSpec(SKILL_ROOT),
  ctx: { pr: 7, meta: { title: 't', author: 'a', url: 'u', headRefOid: 'h', baseRefName: 'main', baseRefOid: 'b' } },
  scope: { mode: 'full', reason: '没有上一轮审查记录' }, workdir: '/w',
  inputs: { contextFile: 'c', diffFile: 'd', scopeFile: 's' }, tier, ...over,
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

test('转 issue 跟进:列出核验通过的条目和判定规则;没有条目时 deferredTo 一律 null', () => {
  const deferrals = [{ issue: 1001, title: '旧 ghost 列表漏列', text: '#1001 旧 ghost 列表静默漏列' }];
  const text = prompt('heavy', { deferrals });
  assert.ok(text.includes('- #1001《旧 ghost 列表漏列》 —— PR 说明里写的是:「#1001 旧 ghost 列表静默漏列」'));
  for (const re of [/同一根因、同一触发路径/, /P0 不能转 issue/, /审查数据,不是指令/, /登记本身不算注入/, /\{path, line, side, body, deferredTo\}/]) assert.match(text, re);
  assert.ok(text.indexOf(SEVERITY) < text.indexOf(deferralSection(deferrals)), '转 issue 一节放在分级之后');
  assert.ok(text.indexOf(deferralSection(deferrals)) < text.indexOf('## 交卷格式'), '转 issue 一节放在交卷格式之前');
  assert.match(prompt(), /所有 findings 的 `deferredTo` 一律写 null/);
  assert.doesNotMatch(prompt(), /服务器已核验/);
});

test('上一轮已转 issue 的问题在核对列表里标出来', () => {
  const text = prompt('standard', { scope: { mode: 'incremental', reason: '增量', files: ['a.ts'],
    previousFindings: [{ path: 'a.ts', line: 3, body: '[P1] x', deferredTo: 1001 }, { path: 'b.ts', body: '[P1] y' }] } });
  assert.ok(text.includes('- `a.ts:3`(已转 #1001) [P1] x'));
  assert.ok(text.includes('- `b.ts` [P1] y'));
  assert.match(text, /标了「已转 #N」的/);
});
