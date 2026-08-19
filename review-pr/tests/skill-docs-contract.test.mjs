#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
const gates = readFileSync(join(ROOT, 'references/internal-gates.md'), 'utf8');

test('SKILL.md 与 internal-gates.md 写明讨论 issue / 当前 head 放行入口', () => {
  for (const [name, text] of [['SKILL.md', skill], ['internal-gates.md', gates]]) {
    assert.match(text, /讨论 issue/, `${name} 必须含「讨论 issue」`);
    assert.match(text, /当前 head/, `${name} 必须含「当前 head」`);
  }
});

test('安全门节不再把放行写成只认 Approve', () => {
  assert.match(gates, /安全\s*\/\s*规则门当前 head 的同意来源/);
  assert.match(gates, /isExplicitSignoffConsent|讨论 issue 白名单留言/);
  assert.doesNotMatch(
    gates,
    /安全门[\s\S]{0,400}只认\s*Approve/,
    '安全门节不得再写成只认 Approve',
  );
});
