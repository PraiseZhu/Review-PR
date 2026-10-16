import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventMeter, toStderrTail, runCodex, readCodexVersion, CODEX_IDLE_MS } from './codex.mjs';

const T0 = Date.parse('2026-10-14T10:00:00Z');
const at = (sec) => T0 + sec * 1000;

test('按完整 JSONL 事件计数计时:第 2、7 秒两个事件,开始到首个事件、末个事件到退出都算空白', () => {
  const meter = createEventMeter(T0);
  meter.feed('{"type":"thread.started"}\n', at(2));
  meter.feed('{"type":"turn.completed","usage":{"input_tokens":1200,"output_tokens":340}}\n', at(7));
  assert.deepEqual(meter.finish(at(9)), {
    firstEventSec: 2, lastEventSec: 7, eventCount: 2, maxGapSec: 5,
    usage: { input_tokens: 1200, output_tokens: 340 },
  });
});

test('没有任何输出:事件数 0,最大空白就是整次调用', () => {
  assert.deepEqual(createEventMeter(T0).finish(at(30)),
    { firstEventSec: null, lastEventSec: null, eventCount: 0, maxGapSec: 30, usage: null });
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
