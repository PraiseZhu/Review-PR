// [MIVO-PATCH gate-bases] 门禁分支识别(Mivo 专有纯函数)。
// 目标分支名按短分支名(baseRefName)匹配:区分大小写、不剥 refs/heads 前缀、* 不跨 /。
import { readFileSync } from 'node:fs';

export const DEFAULT_CHECK_NAME = 'review-pr';
export const GATE_CHECK_NAME = 'review-pr (integration)';

const PATTERN_CHARS = /^[A-Za-z0-9._\-/*?]+$/;

export function toGateBases(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`gateBases 不合法：期望字符串数组，实际 ${typeof value}`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || !item) {
      throw new Error(`gateBases 不合法：期望非空字符串，实际 ${typeof item === 'string' ? '空字符串' : typeof item}`);
    }
    if (!PATTERN_CHARS.test(item) || item.includes('**')) {
      throw new Error(`gateBases 不合法：只允许 [A-Za-z0-9._-/*?] 且不含 **，实际 ${JSON.stringify(item.slice(0, 80))}`);
    }
  }
  return [...value];
}

export function matchesBasePattern(pattern, name) {
  if (typeof pattern !== 'string' || typeof name !== 'string' || !pattern) return false;
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(name);
}

export function isGateBase(baseRefName, gateBases = []) {
  if (typeof baseRefName !== 'string' || !baseRefName) return false;
  return (gateBases ?? []).some((pattern) => matchesBasePattern(pattern, baseRefName));
}

export function isReleaseBase(name) {
  return typeof name === 'string' && /^release\/\d+\.\d+$/.test(name);
}

export function classifyBase({ baseRefName, defaultBranch, gateBases = [] } = {}) {
  if (defaultBranch && baseRefName === defaultBranch) return 'default';
  if (isGateBase(baseRefName, gateBases)) return 'gate';
  if (isReleaseBase(baseRefName)) return 'release';
  return 'other';
}

export function checkNameFor(baseRefName, gateBases = []) {
  return isGateBase(baseRefName, gateBases) ? GATE_CHECK_NAME : DEFAULT_CHECK_NAME;
}

export function loadGateBases(rulesFile) {
  const parsed = JSON.parse(readFileSync(rulesFile, 'utf8'));
  return toGateBases(parsed?.gateBases);
}
