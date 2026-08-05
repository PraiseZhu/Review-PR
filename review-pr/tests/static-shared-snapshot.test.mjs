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

test('SC-R1b 静态 inventory:scripts/ 内除 consume-review-output.mjs 外零 clean 回执写入形态', () => {
  // 诚实边界:只约束 skill 自己的脚本;agent 手写状态文件不在机器承诺内(SKILL 已声明)。
  // lib.mjs 是 writeReviewReceipt 的定义处(它自己校验五项绑定),不算调用方。
  const ALLOWED_CLEAN = new Set(['consume-review-output.mjs', 'lib.mjs']);
  const offenders = [];
  for (const e of readdirSync(SCRIPTS, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.mjs') || ALLOWED_CLEAN.has(e.name)) continue;
    const src = readFileSync(join(SCRIPTS, e.name), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      // 形态①:writeReviewReceipt(... verdict: 'clean' ...) 同行;形态②:--verdict clean 命令串
      if (/writeReviewReceipt\(/.test(line) && /'clean'/.test(line)) offenders.push(`${e.name}:${i + 1}`);
      if (/--verdict\s+clean/.test(line) && !/禁|拒|不再接受|不得/.test(line)) offenders.push(`${e.name}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], `除 consumer 外不得写 clean 回执:\n${offenders.join('\n')}`);
});

test('SC-R1b:pre-merge 的 stage2 门必须无条件计算并被 canMerge/selfMerge 消费', () => {
  const src = readFileSync(join(SCRIPTS, 'pre-merge-check.mjs'), 'utf8');
  assert.match(src, /const receiptGate = \{/, 'receiptGate 必须无条件构建');
  assert.match(src, /const canMerge = canMergeMechanical && receiptGate\.stage2Clean;/, '普通合并必须叠加 stage2 门');
  assert.match(src, /viewerLogin && prAuthor && receiptGate\.stage2Clean/, 'self-merge 必须叠加 stage2 门');
});

test('SC-R8:生产调用必须传 expectedPaths(元数据/patch 互检在生产可达)', () => {
  const pm = readFileSync(join(SCRIPTS, 'pre-merge-check.mjs'), 'utf8');
  assert.match(pm, /expectedPaths: Array\.isArray\(m\.files\)/, 'pre-merge 必须用 PR files 元数据做互检');
  assert.match(pm, /'--json', '[^']*files[^']*'/, 'pr view 必须查 files');
  for (const f of ['build-review-task.mjs', 'review-preflight.mjs']) {
    assert.match(readFileSync(join(SCRIPTS, f), 'utf8'), /--expected-paths/, `${f} 必须支持 --expected-paths`);
  }
});
