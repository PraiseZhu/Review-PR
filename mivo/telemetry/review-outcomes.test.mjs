import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, analyze, roundsToPass, summarize, reportsOf, NOTE } from './review-outcomes.mjs';

const CLI = fileURLToPath(new URL('./review-outcomes.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/basic.json', import.meta.url));
const SENTINEL = 'SENTINEL-FINDING-TEXT';
const prs = JSON.parse(readFileSync(FIXTURE, 'utf8')).prs;
const analysis = analyze(prs, { reviewer: 'mivo-bot', repo: 'o/r' });

function runCli(args) {
  const empty = mkdtempSync(join(tmpdir(), 'mivo-telemetry-path-'));
  const out = mkdtempSync(join(tmpdir(), 'mivo-telemetry-out-'));
  try {
    const r = spawnSync(process.execPath, [CLI, ...args(out)], { encoding: 'utf8', env: { PATH: empty } }); // PATH 里没有 gh:fixture 模式绝不能调用它
    return { r, read: (name) => readFileSync(join(out, name), 'utf8') };
  } finally { rmSync(empty, { recursive: true, force: true }); }
}

test('参数:五个必填项缺一个退出 2 并写明缺哪个;格式不对也拒绝', () => {
  const ok = ['--repo', 'o/r', '--since', '2026-10-01', '--until', '2026-10-08', '--reviewer', 'mivo-bot', '--out', '/tmp/x'];
  assert.equal(parseArgs(ok).options.maxPrs, 200);
  for (const flag of ['--repo', '--since', '--until', '--reviewer', '--out']) {
    const i = ok.indexOf(flag);
    assert.match(parseArgs([...ok.slice(0, i), ...ok.slice(i + 2)]).error, new RegExp(`缺少参数 ${flag}`));
  }
  assert.match(parseArgs(ok.map((v) => (v === '2026-10-01' ? '10/01' : v))).error, /YYYY-MM-DD/);
  assert.match(parseArgs(ok.map((v) => (v === 'o/r' ? 'bad repo' : v))).error, /--repo 格式不对/);
  assert.match(parseArgs([...ok, '--max-prs', '0']).error, /--max-prs/);
});

test('作者反应分桶:合成夹具每个桶各一条(代理指标)', () => {
  assert.deepEqual(analysis.buckets, { 'ruled-keep': 1, deferred: 1, 're-raised': 1, rebutted: 1, 'fixed-proxy': 1, unknown: 2 });
  // 第 3 个 PR 的两条 thread:较早的一条被后一条同 key 的 thread 再报 → re-raised;后一条没有后续 → unknown
  const pr3 = analysis.perPr.find((p) => p.pr === 3);
  assert.equal(pr3.buckets['re-raised'], 1);
  assert.equal(pr3.buckets.unknown, 1);
  assert.equal(analysis.perPr.find((p) => p.pr === 6).buckets.unknown, 1);
});

test('rounds-to-pass 三项都带分母,一直没通过的记 null', () => {
  assert.deepEqual(analysis.roundsToPass, { onePass: { numerator: 1, denominator: 5 }, fivePlus: { numerator: 0, denominator: 5 },
    mean: { value: 1.8, denominator: 5 }, nullCount: 2 });
  assert.equal(roundsToPass(reportsOf(prs[2], 'mivo-bot')), null);
  assert.deepEqual(summarize([1, 5, 6, null]), { onePass: { numerator: 1, denominator: 3 }, fivePlus: { numerator: 2, denominator: 3 }, mean: { value: 4, denominator: 3 }, nullCount: 1 });
  assert.deepEqual(summarize([]).mean, { value: null, denominator: 0 });
});

test('回滚候选:原 PR、审查结论、档位', () => {
  assert.deepEqual(analysis.reverts, [{ revertPr: 8, originalPr: 1, originalInWindow: true, conclusion: 'pass', tier: 'standard' }]);
});

test('高频类型:v2 用 marker 的 class,v1 默认只用目录', () => {
  const classes = Object.fromEntries(analysis.topClasses.map((c) => [c.class, c.total]));
  assert.equal(classes.race, 2);
  assert.equal(classes['null-deref'], 1);
  assert.equal(classes.src, 3, 'v1 的 src/a.ts 等只按目录归类');
  assert.ok(analysis.topClasses.length <= 10);
});

test('no finding text by default:默认输出不含 finding 正文、首行和 PR 标题;--include-text 才带', () => {
  const base = (out) => ['--fixture', FIXTURE, '--repo', 'o/r', '--since', '2026-10-01', '--until', '2026-10-08', '--reviewer', 'mivo-bot', '--out', out];
  const plain = runCli(base);
  assert.equal(plain.r.status, 0, plain.r.stderr);
  for (const name of ['outcomes.json', 'outcomes.md']) assert.ok(!plain.read(name).includes(SENTINEL), `${name} 不该含正文`);
  const json = JSON.parse(plain.read('outcomes.json'));
  assert.equal(json.note, NOTE);
  assert.equal(json.analysis.threads, undefined);
  assert.match(plain.read('outcomes.md'), /代理指标/);
  const withText = runCli((out) => [...base(out), '--include-text']);
  assert.equal(withText.r.status, 0, withText.r.stderr);
  assert.ok(withText.read('outcomes.json').includes(SENTINEL));
  const missing = runCli((out) => base(out).slice(0, -2));
  assert.equal(missing.r.status, 2);
  assert.match(missing.r.stderr, /缺少参数 --out/);
});
