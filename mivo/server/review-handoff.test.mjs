// 作者交接(review.md)的服务器契约:假 codex / 假 gh。
// 覆盖:答卷 handoffCoverage 经 classify → publish → 结果包;收口取第二份答卷的 coverage(SC5);
// 证据按 head 的 git 对象核对,工作区伪造的文件不作数;报告只有一条服务端生成的「交接之外的发现：N 条」(SC6);
// 整轮沿用时 coverage / 统计原样带过去并标 reused。
// 06:00–07:00 维护窗口内跳过(codex() 的 checkHealth 没有测试旁路,不为测试新增生产旁路)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inBusinessWindow } from '../lib/health.mjs';
import { DEFAULT_FEATURES } from '../lib/verify.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const skip = !inBusinessWindow() && '06:00–07:00 维护窗口内服务器本来就不审';
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' };
const FAKE_KEY = 'sk-test-FAKEKEY-0123456789abcdef';
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');
const report = (marker, overall = 'pass —— 没有 P0/P1/P2。') => ['## Findings', marker, '## Rule coverage', 'AGENTS.md', '### 作者交接核对', '模型自己写的计数 交接之外的发现:99 条', '## Verification', '未执行', '## Overall', overall].join('\n');
const finding = (over = {}) => ({ severity: 'P1', title: '空指针', trigger: '未登录', behavior: '抛错', impact: '白屏', fix: '判空', verify: '补测',
  evidence: [{ path: 'src/a.ts', line: 2 }], origin: 'introduced', bugClass: 'null-deref', instances: [], supersedes: null,
  path: 'src/a.ts', line: 2, side: 'RIGHT', deferredTo: null, handoffRiskIds: [], ...over });
const cov = (id, verdict, path, line) => ({ id, verdict, evidence: [{ path, line }], note: `${id} 核对` });
const risk = (id, files) => ({ id, title: id, fields: { trigger: 't', failure: 'f', defense: 'd', disprove: 'p', tests: 't' }, contentHash: id.charCodeAt(1).toString(16).padStart(2, '0').repeat(32), files, locations: [], complete: true, ambiguous: false });
const STATE_OF = { oid: '', mode: '100644' };

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
const prompt = argv[argv.length - 1];
fs.appendFileSync(path.join(ctl, 'calls.log'), 'main ' + (prompt.includes('收口全量审查') ? 'final-full' : 'plain') + '\\n');
const answers = JSON.parse(fs.readFileSync(path.join(ctl, 'main-answers.json'), 'utf8'));
fs.writeFileSync(at('--output-last-message'), JSON.stringify(answers[Math.min(log.length, answers.length - 1)]));
fs.writeFileSync(path.join(ctl, 'last-prompt-' + log.length + '.md'), prompt);
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  chmodSync(bin, 0o755);
  return bin;
}

function setup({ scope, answers, risks = [risk('R1', ['src/r.ts']), risk('R2', ['src/q.ts'])], previousResult = null, phases = ['codex', 'publish'] }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-handoff-'));
  const ctl = mkdtempSync(join(tmpdir(), 'mivo-handoff-ctl-'));
  for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
  const repo = join(work, 'repo');
  const gitRun = (...args) => { const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  gitRun('init', '-q');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'keep\nadded\n');
  writeFileSync(join(repo, 'src', 'r.ts'), '1\n2\n3\n4\n5\n');
  writeFileSync(join(repo, 'src', 'q.ts'), 'q\n');
  gitRun('add', '.');
  gitRun('commit', '-q', '-m', 'head');
  const head = gitRun('rev-parse', 'HEAD');
  // 工作区伪造:head 里没有的文件(审查模型能写工作区),证据不能因此“存在”
  writeFileSync(join(repo, 'src', 'forged.ts'), 'a\nb\nc\n');
  const fileStates = Object.fromEntries(['src/r.ts', 'src/q.ts'].map((p) => [p, { oid: gitRun('rev-parse', `${head}:${p}`), mode: '100644' }]));
  mkdirSync(join(ctl, 'bin'));
  writeFileSync(join(ctl, 'bin', 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(ctl, 'gh.log'))}, JSON.stringify({ args }) + '\\n');
if (args.includes('--paginate')) { process.stdout.write('[[]]'); process.exit(0); }
if (args.includes('repos/o/r/pulls/7') && !args.includes('--method')) { process.stdout.write(JSON.stringify({ head: { sha: ${JSON.stringify(head)} }, labels: [], updated_at: 'x' })); process.exit(0); }
process.stdout.write(JSON.stringify({ id: 5 }));
`);
  chmodSync(join(ctl, 'bin', 'gh'), 0o755);
  writeFileSync(join(ctl, 'calls.log'), '');
  writeFileSync(join(ctl, 'main-answers.json'), JSON.stringify(answers ?? []));
  writeFileSync(join(ctl, 'features.json'), JSON.stringify({ verify: { ...DEFAULT_FEATURES.verify, mode: 'off' }, handoff: { mode: 'observe' } }));
  writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: { title: 't' } }));
  writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
  writeFileSync(join(work, 'input', 'scope.json'), JSON.stringify(scope));
  const review = { version: 1, status: 'parsed', source: { path: 'docs/pr/7/review.md', head, blob: null }, changeMap: [], risks: risks.map((r) => ({ ...r })),
    files: risks.flatMap((r) => r.files), fileStates, warnings: [] };
  if (previousResult) {
    mkdirSync(join(work, 'prev'));
    writeFileSync(join(work, 'prev', 'result.json'), JSON.stringify(previousResult));
    writeFileSync(join(work, 'prev', 'report.md'), '上一轮报告\n');
  }
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head, base: head, tier: 'standard', prevRunId: '', roundId: 'round-12345678',
    attempt: 1, mode: 'dry-run', action: 'review', skillSha: 'a'.repeat(40), runId: '42', runUrl: '' };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
    jobStart: { at: new Date(Date.now() - 30 * 60_000).toISOString(), from: 'job' }, lockToken: 't', authorityDigest: 'd',
    context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
      evidence: { head, base: head, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
    current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [], handoffReview: review },
    handoff: { featureMode: 'observe', facts: null, review },
    previous: scope.mode === 'full' ? null : { head: 'c'.repeat(40), runId: '41', lastFullReviewAt: '2026-10-10T12:00:00Z' },
    previousRound: scope.mode === 'full' ? undefined : { roundIndex: 2, findings: [], keys: [] },
    scope, checkRunId: 99, pendingGates: [], deferrals: { verified: [], rejected: [] } }));
  const env = { ...process.env, MIVO_REVIEW_WORK: work, MIVO_REVIEW_HEALTH_MARKER: join(work, 'no-marker'), MIVO_REVIEW_FEATURES_FILE: join(ctl, 'features.json'),
    LITELLM_CREDENTIALS_JSON: JSON.stringify({ api_key: FAKE_KEY, base_url: 'https://gw.example.com/v1' }), CODEX_BIN: writeFakeCodex(ctl),
    GH_TOKEN: 'x', CHECKS_TOKEN: 'y', PATH: `${join(ctl, 'bin')}${delimiter}${process.env.PATH}` };
  for (const phase of phases) {
    const r = spawnSync(process.execPath, [REVIEW, phase], { env, encoding: 'utf8', timeout: 240_000 });
    assert.equal(r.status, 0, `${phase}:${r.stderr}`);
  }
  const read = (base, file) => (existsSync(join(base, file)) ? readFileSync(join(base, file), 'utf8') : null);
  const out = { head, calls: read(ctl, 'calls.log').trim().split('\n').filter(Boolean), result: JSON.parse(read(work, 'out/result.json')),
    report: read(work, 'out/report.md'), prompts: [read(ctl, 'last-prompt-0.md'), read(ctl, 'last-prompt-1.md')], fileStates };
  rmSync(work, { recursive: true, force: true });
  rmSync(ctl, { recursive: true, force: true });
  return out;
}

const FULL = { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [],
  handoffFiles: ['src/r.ts', 'src/q.ts'], handoffPlan: [risk('R1', ['src/r.ts']), risk('R2', ['src/q.ts'])].map((r) => ({ id: r.id, contentHash: r.contentHash, files: r.files, action: 'recheck', reason: '全量', previousCoverage: null, previousCoverageMeta: null })) };
const INCREMENTAL = { mode: 'incremental', reason: '增量', files: ['src/a.ts', 'src/r.ts'], previousFindings: [], changedFiles: ['src/a.ts'],
  handoffFiles: ['src/r.ts', 'src/q.ts'], handoffPlan: [{ ...FULL.handoffPlan[0], action: 'recheck', reason: '涉及文件变了' }, { ...FULL.handoffPlan[1], action: 'recheck', reason: '涉及文件变了' }] };

test('SC5/SC6 直接全量:coverage 经分类进结果包;伪造文件作证据 → evidenceValid=false;报告只有服务端的一条计数', { skip }, () => {
  const answer = { report: report('FULL'), findings: [], handoffCoverage: [cov('R1', '成立', 'src/r.ts', 5), cov('R2', '成立', 'src/forged.ts', 2)] };
  const r = setup({ scope: FULL, answers: [answer] });
  assert.equal(r.calls.length, 1);
  assert.equal(r.result.outcome, 'approval', JSON.stringify(r.result));
  assert.deepEqual(r.result.mivo.handoffCoverage.map((c) => [c.id, c.verdict]), [['R1', '成立'], ['R2', '成立']]);
  assert.equal(r.result.mivo.handoffCoverageMeta.R1.evidenceValid, true);
  assert.equal(r.result.mivo.handoffCoverageMeta.R2.evidenceValid, false, '工作区伪造的文件不能当证据');
  assert.equal(r.result.mivo.handoffCoverageMeta.R1.sourceHead, r.head);
  assert.ok(r.result.warnings.some((w) => /R2 的证据没有通过检查/.test(w)));
  assert.deepEqual(r.result.mivo.handoffReview.risks.map((x) => x.id), ['R1', 'R2']);
  assert.equal(r.result.mivo.handoffStats.risks, 2);
  assert.equal(r.result.mivo.handoffStats.coverageVerified, 1);
  assert.equal(r.result.mivo.handoffStats.blocking, 0);
  assert.match(r.report, /### 作者交接核对/);
  assert.equal(r.report.match(/交接之外的发现[:：]/g).length, 1);
  assert.match(r.report, /交接之外的发现：0 条/);
  assert.ok(!r.report.includes('99 条'));
  assert.ok(r.prompts[0].includes('风险清单(每条 R 都在答卷 `handoffCoverage` 里交一项)'));
});

test('SC6 最终阻断集:交接之外的发现 = 没有 R 关联的阻断问题;旧答卷缺 handoffRiskIds 记不完整', { skip }, () => {
  const answer = { report: report('F', 'changes-requested —— 2 条 P0/P1/P2'), handoffCoverage: [cov('R1', '成立', 'src/r.ts', 5), cov('R2', '不成立', 'src/q.ts', 1)],
    findings: [finding({ title: '关联 R1', handoffRiskIds: ['R1'] }), finding({ title: '无关联', bugClass: 'other', handoffRiskIds: [] })] };
  const r = setup({ scope: FULL, answers: [answer] });
  assert.equal(r.result.outcome, 'findings', JSON.stringify(r.result));
  const stats = r.result.mivo.handoffStats;
  assert.deepEqual([stats.blocking, stats.associated, stats.outside, stats.complete], [2, 1, 1, true]);
  assert.match(r.report, /交接之外的发现：1 条/);
  assert.deepEqual(r.result.mivo.findings.map((f) => f.handoffRiskIds), [['R1'], []]);
  const legacy = setup({ scope: FULL, answers: [{ ...answer, findings: answer.findings.map(({ handoffRiskIds, ...rest }) => rest) }] });
  assert.equal(legacy.result.outcome, 'findings');
  assert.equal(legacy.result.mivo.handoffStats.complete, false);
  assert.equal(legacy.result.mivo.handoffStats.mappingUnknown, 2);
  assert.match(legacy.report, /关联记录不完整，不用于趋势比较/);
});

test('SC4/SC5 增量干净 → 同次运行收口:只采用收口那份的 coverage;收口任务书列出全部 R,不标沿用', { skip }, () => {
  const first = { report: report('INITIAL'), findings: [], handoffCoverage: [cov('R1', '不成立', 'src/r.ts', 1), cov('R2', '不成立', 'src/q.ts', 1)] };
  const second = { report: report('FINAL'), findings: [], handoffCoverage: [cov('R1', '成立', 'src/r.ts', 5), cov('R2', '未核实', 'src/q.ts', 1)] };
  const r = setup({ scope: INCREMENTAL, answers: [first, second] });
  assert.deepEqual(r.calls, ['main plain', 'main final-full']);
  assert.deepEqual(r.result.mivo.handoffCoverage.map((c) => c.verdict), ['成立', '未核实'], '第一份 coverage 不能顶替收口 coverage');
  assert.ok(r.prompts[1].includes('收口全量:下面的改动地图每一行和每一条 R 都要逐条给出结论'));
  assert.ok(r.prompts[1].includes('- R1「R1」') && r.prompts[1].includes('- R2「R2」'));
  assert.ok(!r.prompts[1].includes('沿用上一轮结论的 R'));
  assert.ok(r.prompts[0].includes('需要在当前版本重核的 R'));
});

test('SC5 整轮沿用:coverage / 统计原样带过去,统计标 reused', { skip }, () => {
  const stats = { version: 1, measuredHead: 'c'.repeat(40), measuredRunId: '41', reused: false, reviewAvailable: true, complete: true, risks: 1, coverageVerified: 1, coverageReused: 0, blocking: 0, associated: 0, outside: 0, mappingUnknown: 0 };
  const previousResult = { pr: 7, head: 'c'.repeat(40), mivo: { handoffReview: { version: 1, status: 'parsed', risks: [], fileStates: {} },
    handoffCoverage: [{ id: 'R1', verdict: '成立', evidence: [{ path: 'src/r.ts', line: 5 }], note: 'x' }], handoffCoverageMeta: { R1: { evidenceValid: true } }, handoffStats: stats, findings: [], deferred: [] } };
  const r = setup({ scope: { mode: 'reuse', reason: '规则改版，代码未变，沿用上次结论', files: [], previousFindings: [], basedOn: 'c'.repeat(40) }, previousResult, phases: ['publish'] });
  assert.equal(r.result.mivo.handoffCoverage[0].verdict, '成立');
  assert.deepEqual(r.result.mivo.handoffStats, { ...stats, reused: true });
  assert.equal(r.calls.length, 0, '没有模型调用');
});
