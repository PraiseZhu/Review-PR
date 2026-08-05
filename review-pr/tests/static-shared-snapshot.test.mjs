// 静态 inventory(SC-R8 同源收口,2026-08-05):scripts/ 内除 lib.diff-snapshot.mjs
// (唯一 snapshot builder)与 lib.mjs 里那条**显式声明的兼容退路**外,不得再出现直接抓
// PR diff 的形态——防"第二份跨 head 快照"悄悄长回来,让 snapshotHash 绑定失效。
//
// 诚实边界:本测试只约束 skill 自己的脚本;agent 在 shell 里手敲 gh pr diff 不在机器
// 承诺内(SKILL 已声明)。lib.mjs 的退路本身被单独断言"必须由 snapshotPatch 参数短路",
// 不是无条件放行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..', 'scripts');
// lib.diff-snapshot 是唯一 builder;lib.mjs 保留一条显式兼容退路(见下方专门断言)
const ALLOWED = new Set(['lib.diff-snapshot.mjs', 'lib.mjs']);

test('scripts/ 内除唯一 snapshot builder 外零 `pr diff` 抓取形态', () => {
  const offenders = [];
  for (const e of readdirSync(SCRIPTS, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.mjs') || ALLOWED.has(e.name)) continue;
    const src = readFileSync(join(SCRIPTS, e.name), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (/['"`]pr['"`]\s*,\s*['"`]diff['"`]/.test(line) || /\bgh pr diff\b/.test(line)) {
        offenders.push(`${e.name}:${i + 1} ${t.slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `发现 snapshot builder 之外的 PR diff 抓取(必须改经 DiffSnapshot):\n${offenders.join('\n')}`);
});

test('lib.mjs 的兼容退路必须由 snapshotPatch 参数短路(不是无条件自己抓 diff)', () => {
  const src = readFileSync(join(SCRIPTS, 'lib.mjs'), 'utf8');
  const idx = src.indexOf("'diff'");
  assert.ok(idx > 0, 'lib.mjs 应仍保留那条被显式声明的兼容退路');
  const window = src.slice(Math.max(0, idx - 400), idx);
  assert.match(window, /typeof snapshotPatch === 'string'/, '退路前必须先判 snapshotPatch——传了快照就不得再抓 diff');
});

test('pre-merge-check 的安全扫描接线:必须传 snapshotPatch(同源)', () => {
  const src = readFileSync(join(SCRIPTS, 'pre-merge-check.mjs'), 'utf8');
  assert.match(src, /scanPrSensitiveContent\(\{[\s\S]{0,400}snapshotPatch:/, 'pre-merge-check 必须把 snapshot 的 rawPatch 交给安全扫描');
});
