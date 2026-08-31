#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTestOrFixturePath,
  pathExcludedBy,
  isUiPath,
  porcelainPath,
  isSkillReviewWorktreePath,
  porcelainHasUserDirty,
} from '../scripts/lib.gate-paths.mjs';

test('isTestOrFixturePath: *.test.ts / __tests__ / spec,不误伤业务文件', () => {
  assert.equal(isTestOrFixturePath('src/lib/assetService.test.ts'), true);
  assert.equal(isTestOrFixturePath('src/ui/Button.test.tsx'), true);
  assert.equal(isTestOrFixturePath('src/foo.spec.ts'), true);
  assert.equal(isTestOrFixturePath('src/__tests__/a.ts'), true);
  assert.equal(isTestOrFixturePath('src/__mocks__/x.ts'), true);
  assert.equal(isTestOrFixturePath('src/lib/assetService.ts'), false);
  assert.equal(isTestOrFixturePath('src/ui/Button.tsx'), false);
  assert.equal(isTestOrFixturePath('docs/testing.md'), false);
});

test('pathExcludedBy: 前缀仍按 startsWith;glob 走 matchPath', () => {
  const prefixes = ['src/lib/persist', 'public/changelog.json'];
  assert.equal(pathExcludedBy('src/lib/persist/foo.ts', prefixes), true);
  assert.equal(pathExcludedBy('src/lib/assetService.ts', prefixes), false);
  const globs = ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'];
  assert.equal(pathExcludedBy('src/lib/assetService.test.ts', globs), true);
  assert.equal(pathExcludedBy('src/lib/assetService.ts', globs), false);
  assert.equal(pathExcludedBy('src/__tests__/a.ts', globs), true);
});

test('isUiPath: 测试文件不算 UI;组件+测试同改时组件仍算 UI', () => {
  const rules = { uiPaths: ['src/'], uiExcludePaths: ['src/lib/persist'] };
  assert.equal(isUiPath('src/lib/assetService.test.ts', rules), false, '测试文件不得进产品门 UI 命中');
  assert.equal(isUiPath('src/ui/Button.tsx', rules), true);
  assert.equal(isUiPath('src/lib/persist/write.ts', rules), false);
  assert.equal(isUiPath('docs/readme.md', rules), false);
});

test('porcelain: skill 自建审查树不计用户脏;其它未跟踪仍脏', () => {
  assert.equal(porcelainPath('?? .worktrees/review-pr/'), '.worktrees/review-pr/');
  assert.equal(porcelainPath('?? .worktrees/review-pr/pr-281/'), '.worktrees/review-pr/pr-281/');
  assert.equal(isSkillReviewWorktreePath('.worktrees/review-pr/pr-281/'), true);
  assert.equal(isSkillReviewWorktreePath('.worktrees/debug-log/x'), false);
  assert.equal(porcelainHasUserDirty('?? .worktrees/review-pr/\n?? .worktrees/review-pr/pr-281/'), false);
  assert.equal(porcelainHasUserDirty('?? .worktrees/review-pr/\n M src/foo.ts'), true);
  assert.equal(porcelainHasUserDirty('?? notes.md'), true);
  assert.equal(porcelainHasUserDirty(''), false);
});
