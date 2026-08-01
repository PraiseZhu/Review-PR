// buildSensitivePatterns / scanSensitiveLine 单测 —— P1-1(2026-08-02)安全与隐私内容
// 扫描的纯函数部分(scanPrSensitiveContent 的 IO 外壳——发 `gh pr diff`——不在本文件
// 覆盖,由 integration.authorized-fast-merge.live.test.mjs 的端到端测试覆盖真实调用)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSensitivePatterns, scanSensitiveLine } from '../scripts/lib.mjs';

test('内置硬命中格式:GitHub token 命中 hard,不命中 soft', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('const token = "ghp_' + 'a'.repeat(36) + '";', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.length, 1);
  assert.equal(sink.hard[0].kind, 'github-token');
});

test('credential-assignment 软命中:占位符(process.env/example 等)豁免,不计入 soft', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('const apiKey = process.env.API_KEY;', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.soft.length, 0, 'process.env 占位符豁免,不该误报');
});

test('credential-assignment 软命中:真实赋值字面量(非占位符)命中 soft', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('const password = "hunter2-real-secret-value";', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.soft.length, 1);
  assert.equal(sink.soft[0].kind, 'credential-assignment');
});

test('email 软命中:安全示例域名(example.com/noreply 等)豁免', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('contact: test@example.com', { file: 'x.md', line: 1 }, patterns, sink);
  assert.equal(sink.soft.length, 0);
});

test('email 软命中:真实邮箱格式命中 soft', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('contact: zhangsan@somecompany.com', { file: 'x.md', line: 1 }, patterns, sink);
  assert.equal(sink.soft.length, 1);
  assert.equal(sink.soft[0].kind, 'email');
});

test('extraHardPatterns / extraSoftPatterns(项目自定义规则)按配置追加,不影响内置规则', () => {
  const patterns = buildSensitivePatterns({ extraHardPatterns: ['CUSTOM-SECRET-\\d{4}'], extraSoftPatterns: ['internal-id-\\d{6}'] });
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('CUSTOM-SECRET-1234 and internal-id-567890', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.length, 1);
  assert.equal(sink.hard[0].kind, 'custom-hard-1');
  assert.equal(sink.soft.length, 1);
  assert.equal(sink.soft[0].kind, 'custom-soft-1');
});

test('命中样本已脱敏:只留前 6 字符 + 长度,不还原原文', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  const secret = 'ghp_' + 'x'.repeat(40);
  scanSensitiveLine(`token=${secret}`, { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.length, 1);
  assert.ok(!sink.hard[0].sample.includes(secret), '脱敏后的 sample 不应包含完整原文');
  assert.match(sink.hard[0].sample, /…\(共 \d+ 字符\)/);
});
