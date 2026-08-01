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

// ── P1-3(三审修复):补齐 AWS ASIA/其它前缀、Slack App-Level Token、Stripe 风格
// sk_ 下划线分隔的密钥模式,均为审核方指出"内置 hard 模式漏项"。

test('P1-3:AWS 临时凭证 ASIA(STS,此前只认 AKIA 漏了这个)命中 hard/aws-access-key-id', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  // ASIAIOSFODNN7EXAMPLE —— 沿用 AWS 官方文档 AKIA 示例的命名习惯改写成 ASIA 前缀,
  // 一看即知是文档级占位符,不是真实凭证。
  scanSensitiveLine('aws_session_token_id = ASIAIOSFODNN7EXAMPLE', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.length, 1);
  assert.equal(sink.hard[0].kind, 'aws-access-key-id');
});

test('P1-3:AWS 角色凭证前缀 AROA 同样命中(顺手补齐的官方前缀族,不止 ASIA 一个样本)', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('role_key = AROAABCDEFGHIJ123456', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.length, 1);
  assert.equal(sink.hard[0].kind, 'aws-access-key-id');
});

test('P1-3:Slack App-Level Token(xapp-,与 xox 系列格式完全不同,此前漏了)命中 hard/slack-app-token', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  const fakeToken = `xapp-1-A01234567-1234567890123-${'a'.repeat(64)}`;
  scanSensitiveLine(`SLACK_APP_TOKEN=${fakeToken}`, { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.length, 1);
  assert.equal(sink.hard[0].kind, 'slack-app-token');
});

test('P1-3 回归:Slack xox 系列(bot/user token)不受新增 xapp- 规则影响,仍正常命中', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine(`token=xoxb-${'1'.repeat(20)}`, { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.length, 1);
  assert.equal(sink.hard[0].kind, 'slack-token');
});

test('P1-3:Stripe 风格下划线分隔密钥(sk_live_/sk_test_,此前 sk- 只认连字符漏了)命中 hard/sk-api-key', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine(`STRIPE_KEY=sk_live_${'x'.repeat(30)}`, { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.length, 1);
  assert.equal(sink.hard[0].kind, 'sk-api-key');
});

test('P1-3 回归:连字符分隔的 sk- 密钥(如 Anthropic sk-ant-...)不受下划线放宽影响,仍正常命中', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine(`ANTHROPIC_API_KEY=sk-ant-api03-${'x'.repeat(30)}`, { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.length, 1);
  assert.equal(sink.hard[0].kind, 'sk-api-key');
});

test('P1-3 负例:"sk_"出现在单词内部(非边界)不应误命中,防止放宽分隔符引入误报', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('const desk_summary_report_data_value = compute();', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.filter((h) => h.kind === 'sk-api-key').length, 0, '"desk_summary..." 里的 sk_ 不在词边界上,不应被误判成密钥');
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
