import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventMeter, toStderrTail, runCodex, readCodexVersion, CODEX_IDLE_MS, renderCodexConfig, toFinalError, toKeyFailure } from './codex.mjs';

const T0 = Date.parse('2026-10-14T10:00:00Z');
const at = (sec) => T0 + sec * 1000;

test('按完整 JSONL 事件计数计时:第 2、7 秒两个事件,开始到首个事件、末个事件到退出都算空白', () => {
  const meter = createEventMeter(T0);
  meter.feed('{"type":"thread.started"}\n', at(2));
  meter.feed('{"type":"turn.completed","usage":{"input_tokens":1200,"output_tokens":340}}\n', at(7));
  assert.deepEqual(meter.finish(at(9)), {
    firstEventSec: 2, lastEventSec: 7, eventCount: 2, outputItems: 0, maxGapSec: 5,
    usage: { input_tokens: 1200, output_tokens: 340 },
  });
});

test('没有任何输出:事件数 0,最大空白就是整次调用', () => {
  assert.deepEqual(createEventMeter(T0).finish(at(30)),
    { firstEventSec: null, lastEventSec: null, eventCount: 0, outputItems: 0, maxGapSec: 30, usage: null });
});

test('末尾长时间静默:最后一个事件到退出的空白计入最大空白', () => {
  const meter = createEventMeter(T0);
  meter.feed('{"type":"turn.started"}\n', at(1));
  meter.feed('{"type":"item.completed"}\n', at(2));
  const stats = meter.finish(at(60));
  assert.equal(stats.maxGapSec, 58);
  assert.equal(stats.usage, null, '没有 turn.completed 就记 null');
});

test('一个事件分两块写入:换行到达时才算一个事件,时间取换行到达那一刻', () => {
  const meter = createEventMeter(T0);
  meter.feed('{"type":"turn.comp', at(3));
  meter.feed('leted","usage":{"output_tokens":7}}\n{"type":"x"}', at(4));
  meter.feed('\n', at(6));
  const stats = meter.finish(at(6.5));
  assert.equal(stats.eventCount, 2);
  assert.equal(stats.firstEventSec, 4);
  assert.equal(stats.lastEventSec, 6);
  assert.deepEqual(stats.usage, { output_tokens: 7 });
  assert.equal(stats.maxGapSec, 4);
});

test('退出时没有换行的最后一行也算事件;不是 JSON 的行不算', () => {
  const meter = createEventMeter(T0);
  meter.feed('warning: not json\n{"type":"error","message":"x"}', at(2));
  const stats = meter.finish(at(3));
  assert.equal(stats.eventCount, 1);
  assert.equal(stats.lastEventSec, 3);
});

test('stderrTail:先脱敏,再取最后 50 行,上限 8 KB', () => {
  const key = 'sk-test-FAKEKEY-0123456789abcdef';
  const stderr = Array.from({ length: 120 }, (_, i) => `line ${i} auth=${key} ghp_${'A'.repeat(36)}`).join('\n');
  const tail = toStderrTail(stderr, [key]);
  assert.ok(!tail.includes(key), '假令牌不能出现');
  assert.ok(!tail.includes(`ghp_${'A'.repeat(36)}`), '通用凭证格式也脱敏');
  const lines = tail.split('\n');
  assert.equal(lines.length, 50);
  assert.match(lines.at(-1), /^line 119 /);
  assert.match(lines[0], /^line 70 /);
  const huge = toStderrTail(`${'x'.repeat(20_000)}\nend`, []);
  assert.ok(Buffer.byteLength(huge, 'utf8') <= 8192);
  assert.match(huge, /end$/);
  assert.equal(toStderrTail('', []), '');
});

// 真实子进程:假 codex 按提示词里的场景名输出,验证事件统计接到 runCodex 的结果里。
const FAKE_CODEX = `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const scenario = args.at(-1);
const answerFile = args[args.indexOf('--output-last-message') + 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (scenario === 'ok') {
  await sleep(150);
  process.stdout.write('{"type":"thread.started"}\\n');
  await sleep(250);
  process.stdout.write('{"type":"turn.comp');
  await sleep(150);
  process.stdout.write('leted","usage":{"input_tokens":10,"output_tokens":5}}\\n');
  writeFileSync(answerFile, JSON.stringify({ report: 'r', findings: [] }));
  await sleep(100);
  process.exit(0);
}
process.stdout.write('{"type":"turn.started"}\\n');
for (let i = 0; i < 80; i += 1) process.stderr.write('line ' + i + ' key=' + process.env.CODEX_API_KEY + '\\n');
process.exit(3);
`;

test('runCodex 把事件记录、用量和失败时脱敏的 stderrTail 带回结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mivo-codex-test-'));
  try {
    const script = join(dir, 'fake-codex.mjs');
    writeFileSync(script, FAKE_CODEX);
    const bin = join(dir, 'codex');
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    const workdir = join(dir, 'work');
    mkdirSync(workdir);
    const key = 'sk-test-FAKEKEY-0123456789abcdef';
    const credentials = JSON.stringify({ api_key: key, base_url: 'https://gateway.example.com/v1' });
    const call = (scenario, label) => runCodex({ codexBin: bin, workdir, prompt: scenario, schema: {}, model: 'm', effort: 'e',
      timeoutMs: 60_000, credentials, tmpRoot: join(dir, 'tmp'), label });

    const ok = await call('ok', 'ok');
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.eventCount, 2);
    assert.deepEqual(ok.usage, { input_tokens: 10, output_tokens: 5 });
    assert.ok(ok.firstEventSec > 0 && ok.firstEventSec < ok.lastEventSec, JSON.stringify(ok));
    assert.ok(ok.maxGapSec > 0);
    assert.equal(ok.stderrTail, undefined, '成功时不记 stderrTail');

    const failed = await call('fail', 'fail');
    assert.equal(failed.ok, false);
    assert.equal(failed.eventCount, 1);
    assert.equal(failed.usage, null);
    assert.ok(failed.stderrTail.includes('line 79'));
    assert.ok(!failed.stderrTail.includes('line 29 '), '只留最后 50 行');
    assert.ok(!failed.stderrTail.includes(key), '假令牌不能出现在 stderrTail');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('卡住判定比正常运行里最长的停顿宽:luna/max 正常跑完的停顿到过 666 秒', () => {
  assert.ok(CODEX_IDLE_MS >= 15 * 60_000, `idle ${CODEX_IDLE_MS}ms 太短`);
});

test('readCodexVersion:返回 --version 输出的第一行并去掉首尾空白,调用参数固定', () => {
  const calls = [];
  const exec = (bin, args, options) => { calls.push({ bin, args, options }); return '  codex-cli 0.162.1  \nsecond line\n'; };
  assert.equal(readCodexVersion('/tools/bin/codex', exec), 'codex-cli 0.162.1');
  assert.deepEqual(calls, [{ bin: '/tools/bin/codex', args: ['--version'], options: { encoding: 'utf8', timeout: 10_000 } }]);
});

test('readCodexVersion:命令报错返回 null,不抛错', () => {
  const exec = () => { throw Object.assign(new Error('spawn /nope ENOENT'), { code: 'ENOENT' }); };
  assert.equal(readCodexVersion('/nope', exec), null);
});

test('readCodexVersion:超时返回 null,不抛错', () => {
  const exec = () => { throw Object.assign(new Error('spawnSync /tools/bin/codex ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' }); };
  assert.equal(readCodexVersion('/tools/bin/codex', exec), null);
});

test('生成的 Codex 配置关掉项目说明文件,PR head 的 AGENTS.md 进不了主审和核对员的上下文', () => {
  const lines = renderCodexConfig('https://gateway.example.invalid/v1').split('\n');
  const top = lines.slice(0, lines.findIndex((l) => l.startsWith('[')));
  assert.ok(top.includes('project_doc_max_bytes = 0'), `顶层配置应含 project_doc_max_bytes = 0,实际: ${top.join(' | ')}`);
});

// ── 换备用 key 的判定(维护者 2026-10-18)───────────────────────────────────
// 2026-10-18 在 Pro 上用无效 key 对公司网关(LiteLLM)跑 codex-cli 0.146.0 得到的真实事件(key 片段已是网关自己打的码)。
const REAL_401 = [
  '{"type":"thread.started","thread_id":"t"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `openai/gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Authentication Error, Invalid proxy server token passed. Received API Key = sk-...0000, Key Hash (Token) =6218. Unable to find token in cache or `LiteLLM_VerificationTokenTable`, url: https://gw.example.com/v1/responses)"}',
  '{"type":"error","message":"unexpected status 401 Unauthorized: Authentication Error, Invalid proxy server token passed. Received API Key = sk-...0000, Key Hash (Token) =6218. Unable to find token in cache or `LiteLLM_VerificationTokenTable`, url: https://gw.example.com/v1/responses"}',
  '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Authentication Error, Invalid proxy server token passed. Received API Key = sk-...0000, Key Hash (Token) =6218. Unable to find token in cache or `LiteLLM_VerificationTokenTable`, url: https://gw.example.com/v1/responses"}}',
].join('\n');

test('真实 401:最终错误取 turn.failed;判为认证失败;开场的 error 条目不算模型输出', () => {
  assert.match(toFinalError(REAL_401), /^unexpected status 401 Unauthorized: Authentication Error/);
  assert.deepEqual(toKeyFailure(toFinalError(REAL_401)), { kind: 'auth', status: 401 });
  const meter = createEventMeter(T0);
  meter.feed(`${REAL_401}\n`, at(5));
  assert.equal(meter.finish(at(6)).outputItems, 0);
  const working = createEventMeter(T0);
  working.feed('{"type":"item.completed","item":{"type":"reasoning","text":"x"}}\n{"type":"item.started","item":{"type":"command_execution"}}\n', at(1));
  assert.equal(working.finish(at(2)).outputItems, 2);
});

test('key 本身的问题才换 key:额度/预算、无模型权限、限流;5xx、断网、参数错、模型不存在、空错误都不换', () => {
  const cases = [
    ['unexpected status 400 Bad Request: Budget has been exceeded! Current cost: 51.2, Max budget: 50.0', { kind: 'budget', status: 400 }],
    ['unexpected status 429 Too Many Requests: {"error":{"type":"budget_exceeded"}}', { kind: 'budget', status: 429 }],
    ['unexpected status 403 Forbidden: key not allowed to access model. This key can only access models=[a]', { kind: 'access', status: 403 }],
    ['unexpected status 429 Too Many Requests: LiteLLM Rate Limit Handler for rate limit type = key. Crossed TPM / RPM', { kind: 'rate-limit', status: 429 }],
    ['unexpected status 401 Unauthorized: Authentication Error - Expired Key', { kind: 'auth', status: 401 }],
  ];
  for (const [message, want] of cases) assert.deepEqual(toKeyFailure(message), want, message);
  for (const message of ['unexpected status 502 Bad Gateway: upstream error', 'unexpected status 500 Internal Server Error: rate limit exceeded upstream',
    'unexpected status 503 Service Unavailable: Authentication Error from upstream provider', 'stream disconnected before completion: error sending request',
    'unexpected status 400 Bad Request: Unsupported value: reasoning.effort', 'unexpected status 404 Not Found: model openai/gpt-x does not exist', '', null]) {
    assert.equal(toKeyFailure(message), null, String(message));
  }
  assert.equal(toFinalError('{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized)"}'), null, '只有重连提示时没有最终错误');
  assert.equal(toFinalError('not json\n{"type":"item.completed","item":{"type":"agent_message","text":"unexpected status 401"}}'), null, '模型文字里的 401 不算');
});

test('runCodex:假 CLI 报真实 401 时带回 keyFailure,产物里两把 key 都被抹掉', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mivo-codex-key-'));
  try {
    const KEY_A = 'sk-primary-AAAAAAAAAAAA';
    const KEY_B = 'sk-backup-BBBBBBBBBBBB';
    const bin = join(root, 'codex');
    writeFileSync(bin, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(`${REAL_401}\n`)});
process.stderr.write('using ' + process.env.CODEX_API_KEY + ' and ${KEY_B}\\n');
process.exit(1);
`, { mode: 0o755 });
    mkdirSync(join(root, 'work'));
    const r = await runCodex({ codexBin: bin, workdir: join(root, 'work'), prompt: 'p', schema: {}, model: 'openai/m', effort: 'low', timeoutMs: 60_000,
      credentials: { apiKey: KEY_A, baseUrl: 'https://gw.example.com/v1' }, redactKeys: [KEY_B], tmpRoot: root, label: 'k' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.keyFailure, { kind: 'auth', status: 401 });
    assert.equal(r.outputStarted, false);
    assert.doesNotMatch(r.stderrTail, /AAAAAAAA|BBBBBBBB/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// #143:额度类(quota,Mini 据此暂停派发)只认最终错误判出的认证、预算、权限问题;限流和 5xx、超时都不算
async function runFake(body, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mivo-codex-quota-'));
  try {
    const bin = join(root, 'codex');
    writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    mkdirSync(join(root, 'work'));
    return await runCodex({ codexBin: bin, workdir: join(root, 'work'), prompt: 'p', schema: {}, model: 'openai/m', effort: 'low', timeoutMs: 60_000,
      credentials: { apiKey: 'sk-primary-AAAAAAAAAAAA', baseUrl: 'https://gw.example.com/v1' }, tmpRoot: root, label: 'q', ...extra });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const line = (event) => `console.log(${JSON.stringify(JSON.stringify(event))});`;
const RATE = 'unexpected status 429 Too Many Requests: LiteLLM Rate Limit Handler for rate limit type = key. Crossed TPM / RPM. Please retry after 7 seconds';

test('runCodex(#143):429 限流是 rate-limit、不是额度类,带回最终错误给重试读 Retry-After', async () => {
  const r = await runFake(`${line({ type: 'turn.failed', error: { message: RATE } })}\nprocess.exit(1);`);
  assert.deepEqual(r.keyFailure, { kind: 'rate-limit', status: 429 });
  assert.equal(r.quota, false);
  assert.match(r.finalError, /retry after 7 seconds/);
});

test('runCodex(#143):正文带 budget 的 429 是额度类', async () => {
  const r = await runFake(`${line({ type: 'turn.failed', error: { message: 'unexpected status 429 Too Many Requests: {"error":{"type":"budget_exceeded"}}' } })}\nprocess.exit(1);`);
  assert.deepEqual(r.keyFailure, { kind: 'budget', status: 429 });
  assert.equal(r.quota, true);
});

test('SC6 runCodex(#143):5xx 退出,即使 stderr 和重连事件里出现 429、rate limit,也不算额度类', async () => {
  const r = await runFake([
    line({ type: 'error', message: `Reconnecting... 1/5 (${RATE})` }),
    line({ type: 'turn.failed', error: { message: 'unexpected status 502 Bad Gateway: upstream rate limit exceeded' } }),
    "process.stderr.write('429 Too Many Requests rate limit insufficient_quota\\n');",
    'process.exit(1);'].join('\n'));
  assert.equal(r.keyFailure, null);
  assert.equal(r.quota, false);
});

test('SC6 runCodex(#143):先有 429 重连、最后超时退出的调用不算额度类', async () => {
  const r = await runFake([
    line({ type: 'error', message: `Reconnecting... 1/5 (${RATE})` }),
    "process.stderr.write('429 Too Many Requests\\n');",
    'setTimeout(() => {}, 120_000);'].join('\n'), { timeoutMs: 1000 });
  assert.equal(r.timedOut, true);
  assert.equal(r.keyFailure, null);
  assert.equal(r.quota, false);
});
