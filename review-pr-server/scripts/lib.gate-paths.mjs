#!/usr/bin/env node
// lib.gate-paths.mjs — 产品/架构门路径判定 + 审查树残留 porcelain 过滤。
//
// uiExcludePaths 历史上只做前缀 startsWith,配 `**/*.test.ts` 永远匹配不到。
// 本文件是唯一匹配实现:无 glob 字符走前缀,有 `*`/`?` 走 lib.review-profiles.matchPath。
import { matchPath } from './lib.review-profiles.mjs';

const TEST_DIR_RE = /(?:^|\/)(?:__tests__|__mocks__|testdata|test-fixtures)\//;
const TEST_FILE_RE = /\.(?:test|spec)\.[^/]+$/;
const GLOB_RE = /[*?]/;
const SKILL_REVIEW_WT_RE = /(?:^|\/)\.worktrees\/review-pr(?:\/|$)/;

export function isTestOrFixturePath(path) {
  if (typeof path !== 'string' || !path) return false;
  const lower = path.toLowerCase();
  return TEST_DIR_RE.test(lower) || TEST_FILE_RE.test(lower);
}

export function pathExcludedBy(path, patterns) {
  if (typeof path !== 'string' || !path) return false;
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some((pat) => {
    if (typeof pat !== 'string' || !pat) return false;
    if (GLOB_RE.test(pat)) return matchPath(pat, path);
    return path.startsWith(pat);
  });
}

export function isUiPath(path, { uiPaths = [], uiExcludePaths = [] } = {}) {
  if (typeof path !== 'string' || !path) return false;
  // 测试/夹具默认不算 UI:owner 2026-08-31 验收是「纯测试 PR 不再进产品门」。
  // 这是 skill 侧默认,不靠各仓 uiExcludePaths 配齐;glob 排除仍给仓级加码。
  if (isTestOrFixturePath(path)) return false;
  if (pathExcludedBy(path, uiExcludePaths)) return false;
  return (uiPaths ?? []).some((prefix) => typeof prefix === 'string' && path.startsWith(prefix));
}

/** git status --porcelain 一行里的路径(XY + 空格之后;rename 取箭头右侧)。 */
export function porcelainPath(line) {
  if (typeof line !== 'string' || line.length < 4) return '';
  let rest = line.slice(3);
  const arrow = rest.lastIndexOf(' -> ');
  if (arrow >= 0) rest = rest.slice(arrow + 4);
  rest = rest.trim();
  if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
    rest = rest.slice(1, -1).replace(/\\"/g, '"');
  }
  return rest;
}

export function isSkillReviewWorktreePath(path) {
  return typeof path === 'string' && SKILL_REVIEW_WT_RE.test(path);
}

/** 去掉 skill 自建 `.worktrees/review-pr/` 未跟踪目录后,是否还有用户脏文件。 */
export function porcelainHasUserDirty(porcelain) {
  const text = String(porcelain ?? '').trim();
  if (!text) return false;
  return text.split('\n').some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return !isSkillReviewWorktreePath(porcelainPath(trimmed));
  });
}
