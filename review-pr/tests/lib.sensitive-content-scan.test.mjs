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

// P2-2(四审修复):三审误把 AROA/AIDA/AGPA/AIPA/ANPA/ANVA 当成"AWS 凭证前缀"一起
// 加了进来。审核方查证:这几个是 IAM 资源(角色/用户/用户组/实例配置/托管策略/托管
// 策略版本)的唯一 ID,不能用于签名调用,不是凭证,判 hard 是误报——hard hit 触发
// "打回+清 git 历史+轮换凭证",误伤代价重。真正能签名的只有 AKIA/ASIA/A3T。

test('P2-2:AWS IAM 角色资源 ID(AROA)不是凭证,不应 hard hit(三审误判为凭证,四审收窄移除)', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('role_id = AROAABCDEFGHIJ123456', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.filter((h) => h.kind === 'aws-access-key-id').length, 0, 'AROA 是 IAM 角色资源 ID,不能用于签名,不是凭证');
});

test('P2-2:AWS IAM 用户资源 ID(AIDA)不是凭证,不应 hard hit', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('user_id = AIDAABCDEFGHIJ123456', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.filter((h) => h.kind === 'aws-access-key-id').length, 0);
});

test('P2-2:AWS 托管策略资源 ID(ANPA)不是凭证,不应 hard hit', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('policy_id = ANPAABCDEFGHIJ123456', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.filter((h) => h.kind === 'aws-access-key-id').length, 0);
});

test('P2-2 回归:真正的 AWS 长期访问密钥(AKIA)与 STS 临时凭证(ASIA)仍正常 hard hit,收窄没有误伤真凭证', () => {
  const patterns = buildSensitivePatterns({});
  {
    const sink = { hard: [], soft: [] };
    scanSensitiveLine('key = AKIAIOSFODNN7EXAMPLE', { file: 'x.ts', line: 1 }, patterns, sink);
    assert.equal(sink.hard.length, 1);
    assert.equal(sink.hard[0].kind, 'aws-access-key-id');
  }
  {
    const sink = { hard: [], soft: [] };
    scanSensitiveLine('key = ASIAIOSFODNN7EXAMPLE', { file: 'x.ts', line: 1 }, patterns, sink);
    assert.equal(sink.hard.length, 1);
    assert.equal(sink.hard[0].kind, 'aws-access-key-id');
  }
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

test('P1-3:Stripe 风格下划线分隔密钥(sk_live_/sk_test_,此前 sk- 只认连字符漏了)命中 hard/stripe-api-key', () => {
  const patterns = buildSensitivePatterns({});
  {
    const sink = { hard: [], soft: [] };
    scanSensitiveLine(`STRIPE_KEY=sk_live_${'x'.repeat(30)}`, { file: 'x.ts', line: 1 }, patterns, sink);
    assert.equal(sink.hard.length, 1);
    assert.equal(sink.hard[0].kind, 'stripe-api-key');
  }
  {
    const sink = { hard: [], soft: [] };
    scanSensitiveLine(`STRIPE_KEY=sk_test_${'x'.repeat(30)}`, { file: 'x.ts', line: 1 }, patterns, sink);
    assert.equal(sink.hard.length, 1);
    assert.equal(sink.hard[0].kind, 'stripe-api-key');
  }
});

test('P1-3 回归:连字符分隔的 sk- 密钥(如 Anthropic sk-ant-...)不受下划线放宽影响,仍正常命中', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine(`ANTHROPIC_API_KEY=sk-ant-api03-${'x'.repeat(30)}`, { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.length, 1);
  assert.equal(sink.hard[0].kind, 'sk-api-key');
});

test('P2-2:普通变量名 sk_status_configuration_value 不应 hard hit(三审放宽 sk_ 分隔符引入的误报,四审收窄为只认 sk_live_/sk_test_)', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('const sk_status_configuration_value = loadConfig();', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(sink.hard.filter((h) => h.kind === 'stripe-api-key' || h.kind === 'sk-api-key').length, 0);
});

test('P1-3 负例:"sk_"出现在单词内部(非边界)且不含 live/test 前缀,不应误命中', () => {
  const patterns = buildSensitivePatterns({});
  const sink = { hard: [], soft: [] };
  scanSensitiveLine('const desk_summary_report_data_value = compute();', { file: 'x.ts', line: 1 }, patterns, sink);
  assert.equal(
    sink.hard.filter((h) => h.kind === 'sk-api-key' || h.kind === 'stripe-api-key').length,
    0,
    '"desk_summary..." 里的 sk_ 不在词边界上,也没有 live/test 前缀,不应被误判成密钥',
  );
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

test('FAKEKEY 字面量仍 hard hit:正则不豁免,测试桩靠 allowPaths 跳过文件', () => {
  const patterns = buildSensitivePatterns({
    allowPaths: ['^src/__tests__/', '^cindyplugin/src/__tests__/'],
  });
  {
    const sink = { hard: [], soft: [] };
    scanSensitiveLine('const k = "sk-FAKEKEY-abcdefghijklmnopqrst";', { file: 'cindyplugin/src/__tests__/debugLogRedact.test.ts', line: 1 }, patterns, sink);
    assert.equal(sink.hard.filter((h) => h.kind === 'sk-api-key').length, 1, '扫描行本身仍命中,避免 sk-FAKEKEY+真密钥被全局 lookahead 放行');
  }
  {
    const sink = { hard: [], soft: [] };
    scanSensitiveLine('const t = "xoxb-FAKEKEY-123456789";', { file: 'src/lib/persist.ts', line: 1 }, patterns, sink);
    assert.equal(sink.hard.filter((h) => h.kind === 'slack-token').length, 1);
  }
  assert.ok(patterns.allowRe.test('cindyplugin/src/__tests__/debugLogRedact.test.ts'));
  assert.ok(!patterns.allowRe.test('src/lib/persist.ts'));
});
