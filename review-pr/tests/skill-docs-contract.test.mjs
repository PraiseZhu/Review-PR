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

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const sourcePhase3 = readFileSync(join(ROOT, 'references/phase3-landing.md'), 'utf8');
const sourceAutoBatch = readFileSync(join(ROOT, 'references/auto-batch.md'), 'utf8');

const DOC_TREES = [
  ['source', ROOT],
  ['dist', join(REPO, 'dist')],
  ['preview-dist', join(REPO, 'preview-dist')],
];

function collectDocs() {
  const docs = [];
  for (const [tree, dir] of DOC_TREES) {
    for (const rel of [
      'SKILL.md',
      'references/internal-gates.md',
      'references/phase3-landing.md',
      'references/auto-batch.md',
      'references/phase1-gates.md',
    ]) {
      const path = join(dir, rel);
      if (existsSync(path)) docs.push([`${tree}/${rel}`, path, readFileSync(path, 'utf8')]);
    }
  }
  return docs;
}

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

test('merge-pr 命令示例必须钉 --mode interactive（源/dist/preview，含外置流程文档）', () => {
  const docs = collectDocs();
  const missingRequired = [];
  for (const [tree, dir] of DOC_TREES) {
    for (const rel of ['SKILL.md', 'references/internal-gates.md', 'references/phase3-landing.md']) {
      if (!existsSync(join(dir, rel))) missingRequired.push(`${tree}/${rel}`);
    }
  }
  const unmode = [];
  for (const [name, , text] of docs) {
    for (const { line, cmd } of executableMergeExamples(text)) {
      if (!cmd.includes('--mode interactive') || cmd.includes('--mode auto')) {
        unmode.push(`${name}:${line} ${cmd.trim().slice(0, 160)}`);
      }
    }
  }
  assert.deepEqual(missingRequired, [], `契约文档缺失:\n${missingRequired.join('\n')}`);
  assert.deepEqual(unmode, [], `merge-pr 示例缺 --mode interactive（auto 会把缺省 mode 当可合）:\n${unmode.join('\n')}`);
});

test('SKILL / internal-gates 不得再把 break-glass 写成 auto 合并入口', () => {
  for (const [name, text] of [['SKILL.md', skill], ['internal-gates.md', gates]]) {
    assert.doesNotMatch(text, /正常自动合并/, `${name} 不得再写「正常自动合并」（auto 永不合）`);
  }
});

test('SKILL 与外置流程文档 5.4 不得再教 agent 开跟进会话', () => {
  const texts = [
    ['SKILL.md', skill],
    ['phase3-landing.md', sourcePhase3],
    ['auto-batch.md', sourceAutoBatch],
    ['dist/SKILL.md', readIfExists(join(REPO, 'dist/SKILL.md'))],
    ['dist/phase3-landing.md', readIfExists(join(REPO, 'dist/references/phase3-landing.md'))],
    ['preview-dist/SKILL.md', readIfExists(join(REPO, 'preview-dist/SKILL.md'))],
    ['preview-dist/phase3-landing.md', readIfExists(join(REPO, 'preview-dist/references/phase3-landing.md'))],
  ];
  for (const [name, text] of texts) {
    assert.ok(text, `${name} 必须存在`);
    if (name.endsWith('SKILL.md') || name.endsWith('phase3-landing.md')) {
      assert.match(text, /### 5\.4 自动跟进修复（fix-handoff）：已停用，禁止开跟进会话/, `${name} 必须保留 5.4 停用标题`);
    }
    assert.doesNotMatch(text, /你负责跟进修复/, `${name} 不得含「你负责跟进修复」`);
    assert.doesNotMatch(text, /use_worktree: true/, `${name} 不得含 use_worktree: true`);
    assert.doesNotMatch(text, /要开跟进会话自动修吗/, `${name} 不得含跟进会话询问`);
    assert.doesNotMatch(text, /走 5\.4 跟进会话修 PR 分支/, `${name} 不得教跟进会话修分支`);
    assert.doesNotMatch(text, /投递 5\.4\n\s*跟进会话/, `${name} 不得投递跟进会话`);
    assert.doesNotMatch(text, /5\.4（自修）/, `${name} 不得写 5.4（自修）`);
  }
});

test('收尾与自进化安全约束必须留在 SKILL 入口（外置不得删掉）', () => {
  assert.match(skill, /确认 `git status --short`，不自动修复用户已有脏改动/);
  assert.match(skill, /合并成功且用户明确要求同步时，才对默认分支执行 fast-forward-only 更新/);
  assert.match(skill, /不把审查报告、GitHub token、用户数据或临时快照落入仓库/);
  assert.match(skill, /发现已有残留 worktree 或锁\n无法确认归属时不要强删/);
  assert.match(skill, /返回 `isNew=false`（同指纹已存在）时脚本只自增计数/);
  assert.match(skill, /台账正文不写 token、凭证、内部绝对路径或敏感命中原文/);
  assert.match(skill, /任一失败即恢复原文件、降级为提案/);
  assert.match(skill, /只提交本次维护文件，不裹挟既有改动/);
});

test('references/ 内不得再写 SKILL 根相对路径 references/…（会落到 references/references/）', () => {
  const files = [
    join(ROOT, 'references/phase1-gates.md'),
    join(ROOT, 'references/phase3-landing.md'),
    join(ROOT, 'references/phase2-review.md'),
    join(ROOT, 'references/auto-batch.md'),
    join(ROOT, 'references/runtime-and-sync.md'),
    join(ROOT, 'references/voice-templates.md'),
  ];
  const bad = [];
  for (const path of files) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (/\]\(references\//.test(line)) bad.push(`${path}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, [], `外置文档坏链:\n${bad.join('\n')}`);
});

test('SKILL.md 入口不超过 500 行（官方 progressive disclosure）', () => {
  const lines = skill.split('\n').length;
  assert.ok(
    lines <= 500,
    `SKILL.md 有 ${lines} 行，超过 500 行上限；细节应外置 references/，不要把流程正文写回入口`,
  );
});
