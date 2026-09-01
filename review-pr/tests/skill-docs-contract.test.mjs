#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const skill = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
const gates = readFileSync(join(ROOT, 'references/internal-gates.md'), 'utf8');

/** 把换行续写（`\` 或下一行以 `--` 起）拼成一条 merge-pr 命令。 */
function collectMergePrCommands(text) {
  const lines = text.split('\n');
  const cmds = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('merge-pr.mjs')) continue;
    let cmd = lines[i];
    let j = i;
    while (j + 1 < lines.length) {
      const next = lines[j + 1].trim();
      if (cmd.trimEnd().endsWith('\\') || /^--/.test(next)) {
        cmd = `${cmd.replace(/\\$/, '')} ${next}`;
        j += 1;
        continue;
      }
      break;
    }
    cmds.push({ line: i + 1, cmd: cmd.replace(/`/g, '') });
    i = j;
  }
  return cmds;
}

function executableMergeExamples(text) {
  return collectMergePrCommands(text).filter(({ cmd }) =>
    !cmd.includes('--reconcile') && (cmd.includes('--basis') || cmd.includes('--strategy')));
}

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

test('merge-pr 命令示例必须钉 --mode interactive（源/dist/preview）', () => {
  const docs = [
    ['SKILL.md', join(ROOT, 'SKILL.md')],
    ['internal-gates.md', join(ROOT, 'references/internal-gates.md')],
    ['dist/SKILL.md', join(REPO, 'dist/SKILL.md')],
    ['dist/internal-gates.md', join(REPO, 'dist/references/internal-gates.md')],
    ['preview-dist/SKILL.md', join(REPO, 'preview-dist/SKILL.md')],
    ['preview-dist/internal-gates.md', join(REPO, 'preview-dist/references/internal-gates.md')],
  ];
  const missing = [];
  const unmode = [];
  for (const [name, path] of docs) {
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    for (const { line, cmd } of executableMergeExamples(text)) {
      if (!cmd.includes('--mode interactive') || cmd.includes('--mode auto')) {
        unmode.push(`${name}:${line} ${cmd.trim().slice(0, 160)}`);
      }
    }
  }
  assert.deepEqual(missing, [], `契约文档缺失:\n${missing.join('\n')}`);
  assert.deepEqual(unmode, [], `merge-pr 示例缺 --mode interactive（auto 会把缺省 mode 当可合）:\n${unmode.join('\n')}`);
});

test('SKILL / internal-gates 不得再把 break-glass 写成 auto 合并入口', () => {
  for (const [name, text] of [['SKILL.md', skill], ['internal-gates.md', gates]]) {
    assert.doesNotMatch(text, /正常自动合并/, `${name} 不得再写「正常自动合并」（auto 永不合）`);
  }
});
