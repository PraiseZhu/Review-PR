// test-file-location-guard.test.mjs — 守卫:禁止 tests/ 之外存在 *.test.mjs
//
// 背景(2026-08-10):signoff-policy.test.mjs 曾以自断言脚本形态放在 scripts/,
// 不在 `node --test tests/*.test.mjs` 的 glob 覆盖内——四个函数(isUiTestPath /
// decideIssueReuse / shouldCloseDiscussionIssue / classifyGateHits)的唯一测试
// 从标准跑法里漏掉,七轮审查与四份终审都没发现,最后从一条测试计数差里掉出来。
// 本守卫让这类缺陷不可能复发:任何 tests/ 之外的 *.test.mjs 都使全量转红。
//
// 路径从 import.meta.url 解析(不用 process.cwd()——本仓有 cwd 敏感存量缺陷,
// 从仓根跑会有 computeTitleFacts 失败),扫描全仓排除 dist/ preview-dist/ node_modules。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // review-pr/tests/
const REPO_ROOT = join(HERE, '..'); // review-pr/

function collectTestFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.DS_Store') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      collectTestFiles(p, out);
    } else if (name.endsWith('.test.mjs')) {
      out.push(p);
    }
  }
  return out;
}

test('tests/ 之外不存在 *.test.mjs(守卫全仓扫描)', () => {
  const all = collectTestFiles(REPO_ROOT);
  const violations = all.filter((p) => {
    const rel = relative(REPO_ROOT, p).split(sep);
    // 排除 dist/ 与 preview-dist/(构建产物镜像,不参与测试加载)
    // 与 tests/ 自身(标准跑法 node --test tests/*.test.mjs 覆盖的正是这里)
    return !(rel[0] === 'dist' || rel[0] === 'preview-dist' || rel[0] === 'tests');
  });
  assert.equal(
    violations.length,
    0,
    `tests/ 目录之外发现 *.test.mjs(标准跑法 node --test tests/*.test.mjs 覆盖不到):\n${violations.map((p) => `  ${relative(REPO_ROOT, p)}`).join('\n')}`,
  );
});
