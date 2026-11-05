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

// ── 核对员推翻/降级计数(从已发布的审查报告里数)────────────────────────────
import { parseVerifierSections } from './review-outcomes.mjs';

const VERIFIER_FIXTURE = fileURLToPath(new URL('./fixtures/verifier.json', import.meta.url));
const verifierPrs = JSON.parse(readFileSync(VERIFIER_FIXTURE, 'utf8')).prs;
const verifierAnalysis = analyze(verifierPrs, { reviewer: 'mivo-bot', repo: 'o/r' });

test('核对员两节:按节数列表项,到下一个标题为止;没有这两节的报告计 0', () => {
  const body = '## Findings\n无\n\n## 核对员认为不成立（不阻断本 PR）\n\n- `a.ts:1` · x\n- `a.ts:2` · y\n\n## 核对员降级（不阻断本 PR）\n\n- `c.ts` · z\n\n## Rule coverage\n- 不是核对员的条目\n';
  const parsed = parseVerifierSections(body);
  assert.equal(parsed.refuted, 2);
  assert.equal(parsed.downgraded, 1);
  assert.equal(parsed.lines.length, 3);
  assert.deepEqual(parseVerifierSections('## Findings\n无\n## Overall\npass'), { refuted: 0, downgraded: 0, lines: [] });
  assert.deepEqual(parseVerifierSections(null), { refuted: 0, downgraded: 0, lines: [] });
});

test('核对员推翻/降级:按 PR 和轮次统计,总数带分母', () => {
  assert.deepEqual(verifierAnalysis.verifier, { reports: 5, reportsWithOverruled: 3, prsWithOverruled: 2, refuted: 3, downgraded: 2 });
  const pr20 = verifierAnalysis.perPr.find((p) => p.pr === 20);
  assert.deepEqual(pr20.verifier, { refuted: 3, downgraded: 1, rounds: [
    { round: 1, refuted: 2, downgraded: 1 }, { round: 2, refuted: 1, downgraded: 0 }, { round: 3, refuted: 0, downgraded: 0 } ] });
  assert.deepEqual(verifierAnalysis.perPr.find((p) => p.pr === 21).verifier.rounds, [{ round: 1, refuted: 0, downgraded: 0 }]);
  assert.equal(verifierAnalysis.perPr.find((p) => p.pr === 22).verifier.downgraded, 1, '带横幅的 COMMENT 形态报告也算');
  assert.deepEqual(analyze(prs, { reviewer: 'mivo-bot', repo: 'o/r' }).verifier, { reports: 12, reportsWithOverruled: 0, prsWithOverruled: 0, refuted: 0, downgraded: 0 }, '旧夹具(没有这两节)计 0');
});

test('核对员计数默认只输出数字:不含 finding 正文;--include-text 才带原文行', () => {
  const base = (out) => ['--fixture', VERIFIER_FIXTURE, '--repo', 'o/r', '--since', '2026-10-10', '--until', '2026-10-12', '--reviewer', 'mivo-bot', '--out', out];
  const plain = runCli(base);
  assert.equal(plain.r.status, 0, plain.r.stderr);
  for (const name of ['outcomes.json', 'outcomes.md']) assert.ok(!plain.read(name).includes(SENTINEL), `${name} 不该含正文`);
  const json = JSON.parse(plain.read('outcomes.json'));
  assert.equal(json.analysis.verifier.refuted, 3);
  assert.equal(json.analysis.verifierLines, undefined);
  assert.match(plain.read('outcomes.md'), /推翻（refuted）：3 条；降级（downgraded）：2 条/);
  assert.match(plain.read('outcomes.md'), /有推翻\/降级的 PR：2\/3/);
  const withText = runCli((out) => [...base(out), '--include-text']);
  assert.equal(withText.r.status, 0, withText.r.stderr);
  const lines = JSON.parse(withText.read('outcomes.json')).analysis.verifierLines;
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => l.text.includes(SENTINEL)));
});

// ── 耗时、漏报、噪音(#189) ─────────────────────────────────────────────
import { percentile, durationStats, parseCorrectionMarker, taskIssueOf, missedStats, noiseOf } from './review-outcomes.mjs';

const NORTH_STAR = fileURLToPath(new URL('./fixtures/north-star.json', import.meta.url));
const northStar = JSON.parse(readFileSync(NORTH_STAR, 'utf8'));

test('耗时:只算成功的运行,nearest-rank 的 p50/p90 与手算一致', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([3, 1, 2], 0.5), 2);
  // 成功的 5 次:10、20、30、40、100 分钟;p50 = 第 ceil(2.5)=3 个 = 30,p90 = 第 ceil(4.5)=5 个 = 100;失败的 540 分钟不算
  assert.deepEqual(durationStats(northStar.runs), { count: 5, p50: 30, p90: 100 });
  assert.deepEqual(durationStats([{ startedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:12:20Z', conclusion: 'success' }]), { count: 1, p50: 12.3, p90: 12.3 });
  assert.deepEqual(durationStats([]), { count: 0, p50: null, p90: null });
});

test('修正标记与任务 issue 行:解析出总 issue、项与 SC;同仓写法用默认仓', () => {
  assert.deepEqual(parseCorrectionMarker(northStar.corrections[0].body), { parent: 'o/r#100', itemRepo: 'o/r', itemIssue: 101, sc: 2 });
  assert.equal(parseCorrectionMarker('普通 issue'), null);
  assert.deepEqual(taskIssueOf('任务 issue：o/r#101', 'o/r'), { repo: 'o/r', issue: 101 });
  assert.deepEqual(taskIssueOf('任务 issue：#102', 'o/r'), { repo: 'o/r', issue: 102 });
  assert.equal(taskIssueOf('没有这一行', 'o/r'), null);
});

test('漏报:提过同一 SC 记已提前发现;没提记漏报;反查不到 PR 或 PR 在修正之后才合并记 unmatched;别的仓不算', () => {
  const out = missedStats(northStar.corrections, northStar.prs, { reviewer: 'mivo-bot', repo: 'o/r' });
  assert.equal(out.corrections, 4, '别的仓的修正 issue 不算');
  assert.equal(out.caught, 1, '#201:PR 11 的 finding 提到 SC2');
  assert.equal(out.missed, 1, '#202:PR 12 只提到 SC10,不算 SC1');
  assert.equal(out.unmatched, 2, '#203 没有对应 PR;#205 的 PR 在修正 issue 之后才合并');
  assert.deepEqual(out.items.find((i) => i.correction === 201), { correction: 201, item: 'o/r#101', sc: 2, prs: [11], result: 'caught' });
  // 对照:同一条 #202,首帖改成提到 SC1 后记为已提前发现(区分只靠「首帖是否提到同一 SC」)
  const loose = missedStats([northStar.corrections[1]], northStar.prs.map((p) => ({ ...p, threads: p.threads.map((t) => ({ ...t, comments: [{ ...t.comments[0], body: '[P2] x — SC1' }] })) })), { reviewer: 'mivo-bot', repo: 'o/r' });
  assert.equal(loose.caught, 1);
});

test('漏报:合并之后才发的 finding 不算已提前发现', () => {
  const late = northStar.prs.map((p) => (p.number === 11 ? { ...p, threads: p.threads.map((t) => ({ ...t, comments: [{ ...t.comments[0], createdAt: '2026-10-04T00:00:00Z' }] })) } : p));
  const out = missedStats([northStar.corrections[0]], late, { reviewer: 'mivo-bot', repo: 'o/r' });
  assert.equal(out.caught, 0, '#201:PR 11 合并于 10-03,提到 SC2 的 finding 发于 10-04');
  assert.equal(out.missed, 1);
});

test('噪音 = ruled-keep + rebutted', () => {
  assert.equal(noiseOf({ 'ruled-keep': 2, rebutted: 3, deferred: 9 }), 5);
  assert.equal(noiseOf(analysis.buckets), analysis.buckets['ruled-keep'] + analysis.buckets.rebutted);
});

test('CLI:夹具带 runs 与 corrections 时输出耗时、漏报、噪音;不含 finding 正文与 PR 标题;--workflow 格式校验', () => {
  const base = (out) => ['--fixture', NORTH_STAR, '--repo', 'o/r', '--since', '2026-10-01', '--until', '2026-10-08', '--reviewer', 'mivo-bot', '--out', out];
  const run = runCli(base);
  assert.equal(run.r.status, 0, run.r.stderr);
  const json = JSON.parse(run.read('outcomes.json'));
  assert.deepEqual(json.durations, { count: 5, p50: 30, p90: 100 });
  assert.equal(json.missed.caught, 1);
  assert.equal(json.missed.missed, 1);
  assert.deepEqual(json.truncated, { nested: 0, runs: false, corrections: false });
  assert.equal(json.noise, noiseOf(json.analysis.buckets));
  const md = run.read('outcomes.md');
  assert.match(md, /## 审查耗时/);
  assert.match(md, /p50 30 分钟,p90 100 分钟/);
  assert.match(md, /## 漏报\(北极星,代理指标\)/);
  assert.match(md, /噪音\(代理指标\) = ruled-keep \+ rebutted = \d+/);
  for (const name of ['outcomes.json', 'outcomes.md']) {
    assert.ok(!run.read(name).includes('没达成 #101 SC2 的提示要求'), `${name} 不该含 finding 正文`);
    assert.ok(!run.read(name).includes('"t11"'), `${name} 不该含 PR 标题`);
  }
  assert.match(parseArgs(['--repo', 'o/r', '--since', '2026-10-01', '--until', '2026-10-08', '--reviewer', 'b', '--out', '/x', '--workflow', '../evil']).error, /--workflow 要写成 workflow 文件名/);
  const old = runCli((out) => ['--fixture', FIXTURE, ...base(out).slice(2)]);
  assert.equal(old.r.status, 0, old.r.stderr);
  const oldJson = JSON.parse(old.read('outcomes.json'));
  assert.equal(oldJson.durations, null, '旧夹具没有 runs:不输出耗时');
  assert.equal(oldJson.missed, null, '旧夹具没有 corrections:不输出漏报');
});
