// #221 后来发现的发布接线:prepare 写进 state.lateFindings 的未改动文件清单,publish 据此把新 P2 移出阻断、报告单列、结果包带 lateFindings。
// gh 用 PATH 上的替身;repo/ 是真 git 仓。发布脚本在没有远端的仓里会失败,这里只断言发布前已经算好、写下的东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const SKILL_SHA = 'a'.repeat(40);
const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'changes-requested —— 1 条 P0/P1/P2'].join('\n');
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');

function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function setup({ findings, state: extraState = {} }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-late-'));
  for (const dir of ['input', 'out', 'repo', 'bin']) mkdirSync(join(work, dir), { recursive: true });
  const repo = join(work, 'repo');
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'keep\nadded\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'head');
  const head = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'bin', 'gh'), '#!/usr/bin/env node\nif (process.argv.includes("--paginate")) { process.stdout.write("[[]]"); process.exit(0); }\nprocess.stdout.write(JSON.stringify({ id: 5 }));\n');
  chmodSync(join(work, 'bin', 'gh'), 0o755);
  writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
  writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head, base: head, tier: 'standard', prevRunId: '', roundId: 'round-12345678',
    attempt: 1, mode: 'live', action: 'review', skillSha: SKILL_SHA, runId: '42', runUrl: '' };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
    lockToken: 't', authorityDigest: 'd',
    context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
      evidence: { head, base: head, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
    current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
    scope: { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] }, checkRunId: 99, pendingGates: [],
    deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] }, ...extraState }));
  writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: REPORT, findings }));
  return { work, head };
}

const finding = (over = {}) => ({ severity: 'P1', title: '空指针', trigger: '未登录', behavior: '抛错', impact: '白屏', fix: '判空', verify: '补测',
  evidence: [{ path: 'src/a.ts', line: 2 }], origin: 'introduced', bugClass: 'null-deref', instances: [], supersedes: null,
  path: 'src/a.ts', line: 2, side: 'RIGHT', deferredTo: null, ...over });

function publish(work) {
  const env = { ...process.env, MIVO_REVIEW_WORK: work, GH_TOKEN: 'x', CHECKS_TOKEN: 'y', PATH: `${join(work, 'bin')}${delimiter}${process.env.PATH}` };
  spawnSync(process.execPath, [REVIEW, 'publish'], { env, encoding: 'utf8', timeout: 120_000 });
  return JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
}

const LATE_SECTION = '## 后来发现（不阻断本 PR）';
const enforce = (unchangedFiles) => ({ state: { lateFindings: { mode: 'enforce', unchangedFiles } } });

test('后来发现:enforce 且文件没改,新 P2 不阻断,报告单列,结论 pass,结果包带 lateFindings', () => {
  const { work } = setup({ findings: [finding({ severity: 'P2', title: '后来才看到的问题', bugClass: 'late' })], ...enforce(['src/a.ts']) });
  try {
    const result = publish(work);
    assert.equal(result.reviewClean, true);
    assert.deepEqual(result.mivo.findings, []);
    assert.equal(result.mivo.lateFindings.length, 1);
    assert.match(result.mivo.lateFindings[0].key, /^[0-9a-f]{12}$/);
    assert.equal(result.mivo.lateFindings[0].trigger, undefined, '结果包只存紧凑形状');
    assert.equal(existsSync(join(work, 'comments.json')) ? JSON.parse(readFileSync(join(work, 'comments.json'), 'utf8')).length : 0, 0, '后来发现不开 thread');
    const report = readFileSync(join(work, 'out', 'report.md'), 'utf8');
    assert.ok(report.includes(LATE_SECTION));
    assert.match(report, /- `src\/a\.ts:2` · \[P2\] 后来才看到的问题/);
    assert.match(report, /^pass —— 没有阻断的 P0\/P1\/P2。另有 1 条后来发现的 P2/m);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('后来发现:同样条件下的 P1 照常阻断;P2 与 P1 同轮时只有 P1 开 thread', () => {
  const { work } = setup({ findings: [finding(), finding({ severity: 'P2', title: '后来才看到的问题', bugClass: 'late' })], ...enforce(['src/a.ts']) });
  try {
    const result = publish(work);
    assert.equal(result.reviewClean, false);
    assert.equal(result.mivo.findings.length, 1);
    assert.equal(result.mivo.findings[0].severity, 'P1');
    assert.equal(result.mivo.lateFindings.length, 1);
    const comments = JSON.parse(readFileSync(join(work, 'comments.json'), 'utf8'));
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /^\[P1\]/);
    const report = readFileSync(join(work, 'out', 'report.md'), 'utf8');
    assert.match(report, /^changes-requested —— 1 条 P0\/P1\/P2.*另有 1 条后来发现的 P2/m);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('后来发现:文件改过(不在未改动清单)、第一轮(清单为 null)、开关 off 或旧 state 没有这个字段时,P2 照常阻断', () => {
  for (const extra of [enforce([]), enforce(null), { state: { lateFindings: { mode: 'off', unchangedFiles: null } } }, {}]) {
    const { work } = setup({ findings: [finding({ severity: 'P2', title: '局部缺陷', bugClass: 'partial' })], ...extra });
    try {
      const result = publish(work);
      assert.equal(result.reviewClean, false, JSON.stringify(extra));
      assert.equal(result.mivo.findings.length, 1);
      assert.deepEqual(result.mivo.lateFindings, []);
      const report = readFileSync(join(work, 'out', 'report.md'), 'utf8');
      assert.ok(!report.includes(LATE_SECTION));
      assert.match(report, /changes-requested —— 1 条 P0\/P1\/P2/);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
});
