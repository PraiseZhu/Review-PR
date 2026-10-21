// 放行前收口全量(#100)的服务器契约:假 codex / 假 gh,模拟两次模型调用。
// 覆盖:增量干净 → 同一次运行接收口(SC1)、收口查出 P0/P1/P2(SC2)、直接全量只一次调用(SC3)、修复轮免收口记录(SC4)、
// 预算不足标收口待补且不放行(SC5)、结果与被审 head 绑定(SC6)。
// 06:00–07:00 维护窗口内跳过集成部分(codex() 的 checkHealth 没有测试旁路,不为测试新增生产旁路)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inBusinessWindow } from '../lib/health.mjs';
import { DEFAULT_FEATURES } from '../lib/verify.mjs';
import { FALLBACK_RESERVE_MS, SETTLE_MS } from '../lib/models.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const MIN = 60_000;
const skip = !inBusinessWindow() && '06:00–07:00 维护窗口内服务器本来就不审';
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' };
const FAKE_KEY = 'sk-test-FAKEKEY-0123456789abcdef';
const report = (marker) => ['## Findings', marker, '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'pass —— 没有 P0/P1/P2。'].join('\n');
const CLEAN_1 = { report: report('INITIAL-ANSWER'), findings: [] };
const CLEAN_2 = { report: report('FINAL-FULL-ANSWER'), findings: [] };
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');
const finding = (over = {}) => ({ severity: 'P1', title: '空指针', trigger: '未登录', behavior: '抛错', impact: '白屏', fix: '判空', verify: '补测',
  evidence: [{ path: 'src/a.ts', line: 2 }], origin: 'introduced', bugClass: 'null-deref', instances: [], supersedes: null,
  path: 'src/a.ts', line: 2, side: 'RIGHT', deferredTo: null, ...over });
const withFinding = (over) => ({ report: report('FINAL-FULL-ANSWER').replace('pass —— 没有 P0/P1/P2。', 'changes-requested —— 1 条 P0/P1/P2'), findings: [finding(over)] });

const INCREMENTAL = { mode: 'incremental', reason: '增量(基于 h0,本轮审 1 个文件)', files: ['src/a.ts'], previousFindings: [], changedFiles: ['src/a.ts'] };
const FULL = { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] };
const EXEMPT = { ...INCREMENTAL, finalFullExemption: { sourceHead: 'c'.repeat(40), sourceRunId: '41', issueFiles: ['src/a.ts'], changedFiles: ['src/a.ts'] } };

// 假 codex:按调用次序消费 main-answers.json('fail' 表示 exit 1);每次调用写一行日志:主审 + 模型 + 任务书是不是收口全量。
function writeFakeCodex(ctl) {
  const bin = join(ctl, 'fake-codex');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('fake-codex 0.0.0'); process.exit(0); }
const at = (flag) => argv[argv.indexOf(flag) + 1];
const ctl = ${JSON.stringify(ctl)};
const log = fs.readFileSync(path.join(ctl, 'calls.log'), 'utf8').split('\\n').filter(Boolean);
const index = log.length;
const prompt = argv[argv.length - 1];
fs.appendFileSync(path.join(ctl, 'calls.log'), 'main ' + at('--model') + ' ' + (prompt.includes('收口全量审查') ? 'final-full' : 'plain') + '\\n');
const answers = JSON.parse(fs.readFileSync(path.join(ctl, 'main-answers.json'), 'utf8'));
const step = answers[Math.min(index, answers.length - 1)];
const advancePath = path.join(ctl, 'advance.json');
if (fs.existsSync(advancePath)) { // 时间推进:这次调用「耗时」多少分钟,写进假时钟文件,review.mjs 的 Date.now 预加载会读
  const minutes = JSON.parse(fs.readFileSync(advancePath, 'utf8'))[index] ?? 0;
  const clock = path.join(ctl, 'clock-offset-ms');
  fs.writeFileSync(clock, String((Number(fs.existsSync(clock) ? fs.readFileSync(clock, 'utf8') : 0) || 0) + minutes * 60000));
}
if (step === 'fail') { process.stderr.write('model exploded'); process.exit(1); }
fs.writeFileSync(at('--output-last-message'), JSON.stringify(step));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  chmodSync(bin, 0o755);
  return bin;
}

function setup({ scope, answers = [CLEAN_1], startedAgoMin = 30, mode = 'dry-run', stateExtra = {}, runCodex = true, currentHead = null, advanceMin = null, extraEnv = {} }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-final-full-'));
  const ctl = mkdtempSync(join(tmpdir(), 'mivo-final-full-ctl-'));
  for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
  const gitRun = (...args) => { const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: join(work, 'repo'), encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  gitRun('init', '-q');
  mkdirSync(join(work, 'repo', 'src'));
  writeFileSync(join(work, 'repo', 'src', 'a.ts'), 'keep\nadded\n');
  gitRun('add', '.');
  gitRun('commit', '-q', '-m', 'head');
  const head = gitRun('rev-parse', 'HEAD');
  mkdirSync(join(ctl, 'bin'));
  writeFileSync(join(ctl, 'bin', 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(ctl, 'gh.log'))}, JSON.stringify({ args, input }) + '\\n');
if (args.includes('--paginate')) { process.stdout.write('[[]]'); process.exit(0); }
if (args.includes('repos/o/r/pulls/7') && !args.includes('--method')) { process.stdout.write(JSON.stringify({ head: { sha: ${JSON.stringify(currentHead ?? head)} }, labels: [], updated_at: 'x' })); process.exit(0); }
process.stdout.write(JSON.stringify({ id: 5 }));
`);
  chmodSync(join(ctl, 'bin', 'gh'), 0o755);
  writeFileSync(join(ctl, 'calls.log'), '');
  if (advanceMin) {
    writeFileSync(join(ctl, 'advance.json'), JSON.stringify(advanceMin));
    // 只给 review.mjs 本进程装假时钟(子进程不装):Date.now 加上 clock-offset-ms 文件里的毫秒数
    writeFileSync(join(ctl, 'clock.cjs'), `if (/review\\.mjs$/.test(process.argv[1] || '')) {
  const fs = require('node:fs'); const real = Date.now.bind(Date); const file = ${JSON.stringify(join(ctl, 'clock-offset-ms'))};
  Date.now = () => real() + (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) || 0 : 0);
}
`);
  }
  writeFileSync(join(ctl, 'main-answers.json'), JSON.stringify(answers));
  writeFileSync(join(ctl, 'features.json'), JSON.stringify({ verify: { ...DEFAULT_FEATURES.verify, mode: 'off' } }));
  writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: { title: 't' } }));
  writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
  writeFileSync(join(work, 'input', 'scope.json'), JSON.stringify(scope));
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head, base: head, tier: 'standard', prevRunId: '', roundId: 'round-12345678',
    attempt: 1, mode, action: 'review', skillSha: 'a'.repeat(40), runId: '42', runUrl: '' };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
    jobStart: { at: new Date(Date.now() - startedAgoMin * MIN).toISOString(), from: 'job' }, lockToken: 't', authorityDigest: 'd',
    context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
      evidence: { head, base: head, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
    current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
    previous: scope.mode === 'full' ? null : { head: 'c'.repeat(40), runId: '41', lastFullReviewAt: '2026-10-10T12:00:00Z' },
    previousRound: scope.mode === 'full' ? undefined : { roundIndex: 2, findings: [], keys: [] },
    scope, checkRunId: 99, pendingGates: [], deferrals: { verified: [], rejected: [] }, ...stateExtra }));
  const env = { ...process.env, MIVO_REVIEW_WORK: work, MIVO_REVIEW_HEALTH_MARKER: join(work, 'no-marker'), MIVO_REVIEW_FEATURES_FILE: join(ctl, 'features.json'),
    LITELLM_CREDENTIALS_JSON: JSON.stringify({ api_key: FAKE_KEY, base_url: 'https://gw.example.com/v1' }), CODEX_BIN: writeFakeCodex(ctl),
    ...(advanceMin ? { NODE_OPTIONS: `--require=${join(ctl, 'clock.cjs')}` } : {}), ...extraEnv,
    GH_TOKEN: 'x', CHECKS_TOKEN: 'y', PATH: `${join(ctl, 'bin')}${delimiter}${process.env.PATH}` };
  const phases = runCodex ? ['codex', 'publish'] : ['publish'];
  for (const phase of phases) {
    const r = spawnSync(process.execPath, [REVIEW, phase], { env, encoding: 'utf8', timeout: 240_000 });
    assert.equal(r.status, 0, `${phase}:${r.stderr}`);
  }
  const read = (base, file) => (existsSync(join(base, file)) ? readFileSync(join(base, file), 'utf8') : null);
  const out = { head, work, calls: read(ctl, 'calls.log').trim().split('\n').filter(Boolean), result: JSON.parse(read(work, 'out/result.json')),
    state: JSON.parse(read(work, 'state.json')), report: read(work, 'out/report.md'), answerOnDisk: read(work, 'answer.json'),
    gh: (read(ctl, 'gh.log') ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
  rmSync(work, { recursive: true, force: true });
  rmSync(ctl, { recursive: true, force: true });
  return out;
}

test('预算常量:收口准入 = 45 分钟主审 + 20 分钟备用预留 + 两段收尾余量 = 67 分钟', () => {
  assert.equal(45 * MIN + FALLBACK_RESERVE_MS + 2 * SETTLE_MS, 67 * MIN);
});

test('SC1 增量判干净 → 同一次运行接收口全量;只发布收口那份答卷;结果包带 finalFull', { skip }, () => {
  const r = setup({ scope: INCREMENTAL, answers: [CLEAN_1, CLEAN_2], startedAgoMin: 30 });
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0] + ' ' + c.split(' ')[2]), ['main plain', 'main final-full'], '两次主审:初段增量 + 收口全量');
  assert.ok(r.answerOnDisk.includes('FINAL-FULL-ANSWER') && !r.answerOnDisk.includes('INITIAL-ANSWER'), '只采用收口那份答卷');
  assert.equal(r.result.outcome, 'approval', JSON.stringify(r.result));
  assert.deepEqual(r.result.mivo.finalFull, { head: r.head, runId: '42', outcome: 'clean' });
  assert.equal(r.result.mivo.finalFullContext.kind, 'same-run');
  assert.equal(r.result.mivo.scope.mode, 'incremental', '结果包的 scope 仍是进场范围,能看出「增量后收口」');
  assert.match(r.report, /收口全量:本轮增量判干净后,同一次运行接着对完整 diff 做了放行前收口全量/);
  assert.match(r.report, /审查范围:全量\(放行前收口全量/);
  assert.deepEqual(r.state.codex.passes.map((p) => p.pass), ['initial', 'final-full']);
  assert.deepEqual(r.state.codex.attempts.map((a) => a.pass), ['initial', 'final-full']);
  // 总预算只有一份:第二段主模型上限不会超过「总预算 − 备用预留 − 收尾余量」。
  assert.ok(r.state.codex.attempts[1].timeoutMs <= r.state.codex.budget.budgetMs - FALLBACK_RESERVE_MS - 2 * SETTLE_MS);
  assert.equal(r.state.effectiveScope.purpose, 'final-full');
});

for (const severity of ['P0', 'P1', 'P2']) {
  test(`SC2 收口查出 ${severity} → 不放行,按现有格式记问题;不回退用增量的干净答卷`, { skip }, () => {
    const r = setup({ scope: INCREMENTAL, answers: [CLEAN_1, withFinding({ severity, title: `${severity} 问题` })] });
    assert.equal(r.calls.length, 2);
    assert.equal(r.result.outcome, 'findings', JSON.stringify(r.result));
    assert.equal(r.result.reviewClean, false);
    assert.equal(r.result.mivo.findings.length, 1);
    assert.equal(r.result.mivo.findings[0].severity, severity);
    assert.deepEqual(r.result.mivo.finalFull, { head: r.head, runId: '42', outcome: 'findings' });
    assert.deepEqual(r.result.mivo.finalFullContext.findingFiles, ['src/a.ts'], '问题所在文件进记录,下一轮修复轮免收口据此判断');
    assert.match(r.report, /changes-requested —— 1 条 P0\/P1\/P2/);
  });
}

test('SC1 增量里就有问题 → 不进收口(只一次调用),按现有流程打回,没有 finalFull', { skip }, () => {
  const r = setup({ scope: INCREMENTAL, answers: [withFinding({})] });
  assert.equal(r.calls.length, 1);
  assert.equal(r.result.outcome, 'findings');
  assert.equal(r.result.mivo.finalFull, undefined);
});

test('SC3 直接全量只一次调用;记 finalFull(direct-full),不再接收口', { skip }, () => {
  const r = setup({ scope: FULL, answers: [CLEAN_1, CLEAN_2] });
  assert.equal(r.calls.length, 1);
  assert.equal(r.result.outcome, 'approval');
  assert.deepEqual(r.result.mivo.finalFull, { head: r.head, runId: '42', outcome: 'clean' });
  assert.equal(r.result.mivo.finalFullContext.kind, 'direct-full');
  assert.equal(r.state.effectiveScope, undefined);
});

test('SC4 修复轮免收口:增量干净即放行(一次调用),记 skipped-fix-round 及依据,不伪造全量', { skip }, () => {
  const r = setup({ scope: EXEMPT, answers: [CLEAN_1, CLEAN_2] });
  assert.equal(r.calls.length, 1, '没有第二次模型调用');
  assert.equal(r.result.outcome, 'approval', JSON.stringify(r.result));
  assert.deepEqual(r.result.mivo.finalFull, { head: r.head, runId: '42', outcome: 'skipped-fix-round',
    basedOn: { head: 'c'.repeat(40), runId: '41' }, files: ['src/a.ts'], issueFiles: ['src/a.ts'] });
  assert.equal(r.result.mivo.finalFullContext, undefined);
  assert.match(r.report, /本轮是修复轮,改动只落在上次收口问题所在文件,未再收口/);
});

test('SC4 免收口的增量若查出问题,照常打回,不留免收口记录', { skip }, () => {
  const r = setup({ scope: EXEMPT, answers: [withFinding({})] });
  assert.equal(r.result.outcome, 'findings');
  assert.equal(r.result.mivo.finalFull, undefined);
});

test('SC5 剩余预算不足收口:不 Approve,标收口待补(error+retry),不写答卷、不发 review、check 保持进行中', { skip }, () => {
  const r = setup({ scope: INCREMENTAL, answers: [CLEAN_1, CLEAN_2], startedAgoMin: 40, mode: 'live' });
  assert.equal(r.calls.length, 1, '只跑了增量,没有收口调用');
  assert.equal(r.answerOnDisk, null, '增量的干净答卷不落盘,不可能被拿去放行');
  assert.equal(r.result.outcome, 'error');
  assert.equal(r.result.retry, true);
  assert.equal(r.result.reviewClean, false);
  assert.equal(r.result.mivo.reportComplete, false);
  assert.match(r.result.reason, /收口待补/);
  assert.deepEqual(r.result.mivo.finalFull, { head: r.head, runId: '42', outcome: 'pending-budget' });
  assert.equal(r.result.mivo.finalFullContext.kind, 'same-run');
  assert.deepEqual(r.result.mivo.finalFullContext.previousRound, { roundIndex: 2, findings: [], keys: [] }, '真实前轮保存下来,补跑时恢复');
  assert.ok(r.result.mivo.finalFullBudget.remainingMs < 67 * MIN && r.result.mivo.finalFullBudget.requiredMs === 67 * MIN);
  assert.match(r.report, /## Overall\n\npending —— 收口待补，尚未放行。/);
  assert.doesNotMatch(r.report, /pass —— /);
  assert.ok(!r.gh.some((c) => /APPROVE|REQUEST_CHANGES/.test(c.input) || c.args.includes('labels[]=review:merge-ready')), '没有 Approve / Request Changes / 挂标签');
  assert.ok(!r.gh.some((c) => c.args.some((a) => /pulls\/7\/reviews/.test(a)) && c.args.includes('POST')), '不发任何 review 或评论');
  const check = JSON.parse(r.gh.find((c) => c.args.includes('repos/o/r/check-runs/99')).input);
  assert.equal(check.status, 'in_progress');
  assert.equal(check.conclusion, undefined);
  assert.equal(check.head_sha, r.head, 'check 写在被审的 head 上');
});

test('SC5 收口开始后失败:不回落用增量的干净答卷;记 finalFull=error,Mini 在同一 head 上直接全量', { skip }, () => {
  const r = setup({ scope: INCREMENTAL, answers: [CLEAN_1, 'fail', 'fail'] });
  assert.equal(r.calls.length, 3, '初段一次 + 收口主模型失败后换备用也失败');
  assert.equal(r.answerOnDisk, null);
  assert.equal(r.result.outcome, 'error');
  assert.equal(r.result.retry, true);
  assert.notEqual(r.result.reviewClean, true);
  assert.deepEqual(r.result.mivo.finalFull, { head: r.head, runId: '42', outcome: 'error' });
  assert.equal(r.result.mivo.finalFullContext.kind, 'same-run');
  assert.ok(r.result.mivo.finalFullContext.previousRound);
  assert.equal(r.result.approval, undefined);
});

test('SC6 收口待补时 PR head 已变:结果 state-changed,不碰新 head 的标签,check 仍写在被审 head 上', { skip }, () => {
  const r = setup({ scope: INCREMENTAL, startedAgoMin: 40, mode: 'live', currentHead: 'f'.repeat(40) });
  assert.equal(r.result.outcome, 'state-changed');
  assert.equal(r.result.retry, true);
  assert.ok(!r.gh.some((c) => c.args.some((a) => /issues\/7\/labels/.test(a))), '不对新 head 摘标签');
  const check = JSON.parse(r.gh.find((c) => c.args.includes('repos/o/r/check-runs/99')).input);
  assert.equal(check.head_sha, r.head);
  assert.equal(r.result.head, r.head);
});

test('SC6 同 head 待补:merge-ready 标签照常摘掉(防旧结论残留)', { skip }, () => {
  const r = setup({ scope: INCREMENTAL, startedAgoMin: 40, mode: 'live' });
  assert.equal(r.result.outcome, 'error');
  assert.ok(r.gh.some((c) => c.args.includes('DELETE') && c.args.some((a) => /issues\/7\/labels/.test(a))));
});

test('放行门:publish 单独读到增量干净答卷但没有收口记录 → 不 Approve', { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), 'mivo-final-full-gate-'));
  try {
    for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
    writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
    writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
    const sha = 'a'.repeat(40);
    const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: sha, base: sha, tier: 'standard', prevRunId: '41', roundId: 'round-12345678',
      attempt: 1, mode: 'dry-run', action: 'review', skillSha: sha, runId: '42', runUrl: '' };
    writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
      context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
        evidence: { head: sha, base: sha, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
      current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
      previous: { head: 'h0', runId: '41' }, scope: INCREMENTAL, deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] } }));
    writeFileSync(join(work, 'answer.json'), JSON.stringify(CLEAN_1));
    const run = spawnSync(process.execPath, [REVIEW, 'publish'], { env: { ...process.env, MIVO_REVIEW_WORK: work, GH_TOKEN: '', CHECKS_TOKEN: '' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
    assert.equal(result.outcome, 'error');
    assert.equal(result.retry, true);
    assert.notEqual(result.outcome, 'approval');
    assert.equal(result.mivo.finalFull.outcome, 'pending-budget');
    assert.match(result.reason, /缺少本 head 的收口全量记录/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('沿用(reuse)不重跑收口:来源的收口记录原样带过去', () => {
  const work = mkdtempSync(join(tmpdir(), 'mivo-final-full-reuse-'));
  try {
    for (const dir of ['input', 'out', 'repo', 'prev']) mkdirSync(join(work, dir), { recursive: true });
    writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
    writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
    const sha = 'a'.repeat(40);
    const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: sha, base: sha, tier: 'standard', prevRunId: '41', roundId: 'round-12345678',
      attempt: 1, mode: 'dry-run', action: 'review', skillSha: sha, runId: '42', runUrl: '' };
    const scope = { mode: 'reuse', reason: '同一版本已审过,沿用上次结论', files: [], previousFindings: [], basedOn: sha };
    writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
      context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'u', evidence: { head: sha, base: sha, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
      current: { specDigest: 'spec-xyz', filePatchHashes: {}, totalDiffLines: 1, triggerKinds: [] }, previous: { head: sha, runId: '41' }, scope, deferrals: { verified: [], rejected: [] } }));
    const finalFull = { head: sha, runId: '41', outcome: 'clean' };
    writeFileSync(join(work, 'prev', 'result.json'), JSON.stringify({ mivo: { findings: [], deferred: [], finalFull, finalFullContext: { kind: 'same-run', findingFiles: [], previousRound: null }, lastFullReviewAt: '2026-10-10T12:00:00Z' } }));
    writeFileSync(join(work, 'prev', 'report.md'), report('OLD'));
    const run = spawnSync(process.execPath, [REVIEW, 'publish'], { env: { ...process.env, MIVO_REVIEW_WORK: work, GH_TOKEN: '', CHECKS_TOKEN: '' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
    assert.equal(result.outcome, 'approval', JSON.stringify(result));
    assert.deepEqual(result.mivo.finalFull, finalFull);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// F1:收口主模型超时/失败后的备用,按共享时钟的余额拿时间,不能再被「主模型上限」的预留重复扣掉(曾得到 timeoutMs=0)。
// 时间推进:总预算 120 分钟 → 增量「耗时」50 → 收口主模型「耗时」47 后失败 → 此时余额约 23 分钟,备用应拿到约 21 分钟。
test('F1 收口主模型耗时后失败:备用拿到按余额算的正数 timeout(不是 0),且收口答卷被采用', { skip }, () => {
  const r = setup({ scope: INCREMENTAL, answers: [CLEAN_1, 'fail', CLEAN_2], startedAgoMin: 0, advanceMin: [50, 47, 0],
    extraEnv: { MIVO_REVIEW_JOB_TIMEOUT_MIN: '130' } });
  assert.ok(Math.abs(r.state.codex.budget.budgetMs - 120 * MIN) < 5_000, `总预算约 120 分钟:${r.state.codex.budget.budgetMs}`);
  assert.equal(r.calls.length, 3, '初段 + 收口主模型 + 收口备用');
  const [initial, primary, fallback] = r.state.codex.attempts;
  assert.deepEqual([initial.pass, primary.pass, fallback.pass], ['initial', 'final-full', 'final-full']);
  assert.ok(primary.timeoutMs <= 48 * MIN && primary.timeoutMs > 40 * MIN, `收口主模型上限按余额收紧:${primary.timeoutMs}`);
  assert.ok(fallback.timeoutMs >= 15 * MIN && fallback.timeoutMs <= 22 * MIN, `备用拿到按余额算的时间(约 21 分钟),实际 ${fallback.timeoutMs}`);
  assert.equal(r.result.outcome, 'approval', JSON.stringify(r.result));
  assert.deepEqual(r.result.mivo.finalFull, { head: r.head, runId: '42', outcome: 'clean' });
});
