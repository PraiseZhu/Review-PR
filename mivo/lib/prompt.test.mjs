import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReviewPrompt, loadReviewSpec, deferralSection, SEVERITY, toRuleMapPlan, matchesRulePath, buildSpecManifest, specDigestOf } from './prompt.mjs';
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

test('增量复审:范围和优先规则写在规范原文之前,不再要求对完整 diff 做最终复核', () => {
  const text = prompt('standard', { scope: { mode: 'incremental', reason: '增量(基于 h0,本轮审 1 个文件)', files: ['src/a.ts'], previousFindings: [] } });
  const rule = text.indexOf('优先规则');
  assert.ok(rule > 0 && rule < text.indexOf('## 审查规范'), '优先规则在规范原文之前');
  assert.match(text, /本轮的审查范围是:本轮变化的文件\(`src\/a\.ts`\)、上一轮提过的问题、以及这些改动直接影响到的共享状态、协议、持久化、错误和回滚路径/);
  const ruleText = text.slice(rule, text.indexOf('## 审查规范'));
  for (const phrase of ['完整 diff', '本 PR 改动', '最终逐项对照', '最终复核']) assert.ok(ruleText.includes(`「${phrase}」`), phrase);
  assert.doesNotMatch(text, /追查调用方的范围\*\*不缩小\*\*/);
  assert.doesNotMatch(text, /始终针对\*\*完整 diff\*\*/);
  assert.match(text.slice(text.indexOf('## 审查规范')), /本轮是增量复审/, '规范原文前再提醒一次');
  assert.doesNotMatch(prompt('standard'), /优先规则|本轮是增量复审/, '全量审查不受影响');
});

const RULE_MAP = readFileSync(join(SKILL_ROOT, 'review-pr', 'references', 'rule-map.md'), 'utf8');

test('rule-map 解析:所有 PR 必读的文件;按路径命中的规则文件;命令不算文件', () => {
  const plan = toRuleMapPlan(RULE_MAP);
  assert.deepEqual(plan.mustRead, ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', '.github/pull_request_template.md']);
  const hit = (file) => [...new Set(plan.rows.filter((r) => r.patterns.some((p) => matchesRulePath(p, file))).flatMap((r) => r.files))];
  assert.ok(hit('cindyplugin/src/panel.tsx').includes('cindyplugin/DESIGN.md'));
  assert.ok(hit('src/styles/theme.css').includes('cindyplugin/DESIGN.md'), '*.css 任意深度');
  assert.ok(hit('src/lib/persistQueue.ts').includes('docs/decisions/library-canvas-store.md'), 'src/lib/persist* 前缀');
  assert.ok(hit('server/routes/recipes.ts').includes('docs/recipes-authoring.md'));
  assert.deepEqual(hit('README.md'), []);
  assert.ok(plan.rows.flatMap((r) => r.files).every((f) => !/\s/.test(f)), '`npm run verify:i18n` 这类命令不算规则文件');
});

const MATERIAL = { 'AGENTS.md': 'agents v1', 'CLAUDE.md': 'claude v1', 'CONTRIBUTING.md': 'contributing v1',
  '.github/pull_request_template.md': 'template v1', 'cindyplugin/DESIGN.md': 'design v1', 'docs/design.md': 'design doc v1',
  'docs/recipes-authoring.md': 'recipes v1' };
const manifest = ({ files = ['cindyplugin/src/panel.tsx'], material = {}, config = '{"maintainerSource":"allowlist"}', tier = 'standard' } = {}) =>
  buildSpecManifest({ spec: loadReviewSpec(SKILL_ROOT), tier, files, readFile: (path) => ({ ...MATERIAL, ...material })[path] ?? null, config });

test('specDigest:只改实现代码不变;必读或命中的规则变了就变;未命中的规则变了不变', () => {
  const base = specDigestOf(manifest());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(specDigestOf(manifest()), base, '同样的材料同样的 digest');
  assert.equal(specDigestOf(manifest({ files: ['cindyplugin/src/panel.tsx', 'cindyplugin/src/settings.tsx'] })), base, '多改一个同区域的实现文件');
  assert.notEqual(specDigestOf(manifest({ material: { 'CLAUDE.md': 'claude v2' } })), base, 'rule-map 要求必读的 CLAUDE.md 变了');
  assert.notEqual(specDigestOf(manifest({ material: { 'cindyplugin/DESIGN.md': 'design v2' } })), base, '命中的 DESIGN.md 变了');
  assert.equal(specDigestOf(manifest({ material: { 'docs/recipes-authoring.md': 'recipes v2' } })), base, '没命中的配方规则变了');
  assert.notEqual(specDigestOf(manifest({ files: ['server/routes/recipes.ts'] })), base, '改到新区域,命中的规则集合变了');
  assert.notEqual(specDigestOf(manifest({ config: '{"maintainerSource":"codeowners"}' })), base, '生效配置变了');
  assert.notEqual(specDigestOf(manifest({ tier: 'heavy' })), base, '选档说明变了');
  const m = manifest();
  assert.deepEqual(Object.keys(m).sort(), ['config', 'mustRead', 'pathRules', 'schemaVersion', 'template', 'version']);
  assert.equal(m.mustRead['AGENTS.md'], 'agents v1');
  assert.equal(m.pathRules['docs/recipes-authoring.md'], undefined);
  assert.equal(manifest({ material: { 'CONTRIBUTING.md': null } }).mustRead['CONTRIBUTING.md'], null, '文件不存在如实记 null');
});
