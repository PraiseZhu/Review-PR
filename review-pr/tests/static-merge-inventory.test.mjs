// 静态 inventory(SC4.3,2026-08-04 #469 复盘):scripts/ 内除唯一合并出口 merge-pr.mjs
// 外,不得出现任何直接执行 `gh pr merge` 的调用——防"第二个合并出口"悄悄长出来,让
// merge wrapper 的 intent/result 审计被绕空。
//
// 诚实边界:本测试只能约束 skill 自己的脚本;agent 在 shell 里直接手敲 raw gh 不在
// 机器承诺内(SKILL.md 已如实声明)。SKILL.md 里的命令示例不在本测试范围(文档另有
// 「四条合并路径全部经 wrapper」的行文,由 review 把关)——这里只锁代码层。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..', 'scripts');
const ALLOWED = new Set(['merge-pr.mjs']);

test('scripts/ 内除 merge-pr.mjs 外零 `pr merge` 执行形态', () => {
  const offenders = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.mjs') || ALLOWED.has(e.name)) continue;
      const src = readFileSync(p, 'utf8');
      // 抓两类执行形态:gh(['pr','merge'...]) 与字符串命令 `gh pr merge`。
      // 注释里的提及(如"不要直接 gh pr merge")不该误伤——只匹配代码形态:
      //   ① 数组 argv:'pr'\s*,\s*'merge'
      //   ② 模板串/字符串里的可执行命令:gh pr merge(前面不是注释行开头)
      for (const [i, line] of src.split('\n').entries()) {
        const trimmed = line.trim();
        const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
        if (isComment) continue;
        if (/['"`]pr['"`]\s*,\s*['"`]merge['"`]/.test(line)) offenders.push(`${e.name}:${i + 1} ${trimmed.slice(0, 80)}`);
        else if (/\bgh pr merge\b/.test(line)) offenders.push(`${e.name}:${i + 1} ${trimmed.slice(0, 80)}`);
      }
    }
  };
  walk(SCRIPTS);
  assert.deepEqual(offenders, [], `发现 merge-pr.mjs 之外的合并执行形态(必须改走唯一出口):\n${offenders.join('\n')}`);
});
