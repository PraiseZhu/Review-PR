// findChecklistSection — issue #16: 勾选率检查必须读仓库配置的段落名,不能只认英文 self-review。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTEXT_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'context.mjs')).href;
const SKILL_RULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'pr-rules.json');

function callFind(body, names) {
  const code = `
import(${JSON.stringify(CONTEXT_URL)}).then(({ findChecklistSection }) => {
  process.stdout.write(JSON.stringify(findChecklistSection(${JSON.stringify(body)}, ${JSON.stringify(names)})));
}).catch((e) => { console.error(e); process.exit(1); });
`;
  const r = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, REVIEW_PR_RULES_FILE: SKILL_RULES },
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

const ZH_BODY = `## 变更说明

foo

## 提交前自检

- [ ] A
- [x] B
- [ ] C

## 备注
`;

test('默认 self-review: Self-review Checklist 勾选不足 → hasSection 且 ratio < 0.8', () => {
  const body = `## Self-review Checklist\n\n- [ ] A\n- [x] B\n- [ ] C\n`;
  const r = callFind(body, ['self-review']);
  assert.equal(r.hasSection, true);
  assert.equal(r.total, 3);
  assert.equal(r.done, 1);
  assert.ok(r.ratio < 0.8);
  assert.equal(r.matchedName, 'self-review');
});

test('配置中文标题: 提交前自检 3 勾 1 → hasSection=true', () => {
  const r = callFind(ZH_BODY, ['提交前自检']);
  assert.equal(r.hasSection, true);
  assert.equal(r.total, 3);
  assert.equal(r.done, 1);
  assert.equal(r.matchedName, '提交前自检');
});

test('中文段但配置仍是 self-review → hasSection=false(不靠硬编码中文)', () => {
  const r = callFind(ZH_BODY, ['self-review']);
  assert.equal(r.hasSection, false);
  assert.equal(r.total, 0);
});

test('缺省/空 names 回退 self-review,不扫 featureSections', () => {
  const r = callFind(ZH_BODY, []);
  assert.equal(r.hasSection, false);
  const en = callFind('## self-review\n\n- [x] a\n- [x] b\n- [ ] c\n', null);
  assert.equal(en.hasSection, true);
  assert.equal(en.total, 3);
  assert.equal(en.done, 2);
});

test('勾选 ≥80% 不算不足', () => {
  const r = callFind('## 提交前自检\n\n- [x] A\n- [x] B\n- [x] C\n', ['提交前自检']);
  assert.equal(r.total, 3);
  assert.equal(r.done, 3);
  assert.ok(r.ratio >= 0.8);
});

test('别处 TODO 不进分母', () => {
  const body = `## 变更说明\n\n- [ ] 后续拆 issue\n\n## self-review\n\n- [x] A\n- [ ] B\n`;
  const r = callFind(body, ['self-review']);
  assert.equal(r.total, 2);
  assert.equal(r.done, 1);
});
