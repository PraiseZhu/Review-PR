// 答卷 v2 的发布接线:thread 正文带 mivo-finding marker、报告单列「PR 之前就存在的问题」、报告头带版本短 hash、
// result.json 带 key / preexisting / convergence。gh 用 PATH 上的替身;repo/ 是真 git 仓,证据按 git 对象核对。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseFindingMarker } from '../lib/finding.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const SKILL_SHA = 'a'.repeat(40);
const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'changes-requested —— 1 条 P0/P1'].join('\n');
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');

function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function setup({ findings, state: extraState = {} }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-v2-'));
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

test('v2 发布:thread 正文带 marker;PR 之前就存在的 P1 单列不阻断;报告头带 skill/spec 短 hash;result 带 key/preexisting/convergence', () => {
  const { work, head } = setup({ findings: [
    finding(),
    finding({ title: '旧代码里的问题', origin: 'pre-existing', line: null, evidence: [{ path: 'src/a.ts', line: 1 }], bugClass: 'legacy' }),
  ] });
  try {
    const result = publish(work);
    // 发布脚本在没有远端的仓里会失败,outcome 是 error;这里只断言发布前已经算好、写下的东西。
    const comments = JSON.parse(readFileSync(join(work, 'comments.json'), 'utf8'));
    assert.equal(comments.length, 1, 'pre-existing 的 P1 不开 thread');
    assert.match(comments[0].body, /<!-- mivo-finding key=[0-9a-f]{12} round=1 head=[0-9a-f]{12} class=null-deref -->/);
    assert.equal(parseFindingMarker(comments[0].body).head, head.slice(0, 12));
    assert.deepEqual(Object.keys(comments[0]).includes('line'), true);
    const report = readFileSync(join(work, 'out', 'report.md'), 'utf8');
    assert.ok(report.includes('## PR 之前就存在的问题（不阻断本 PR）'));
    assert.ok(report.includes('旧代码里的问题'));
    assert.match(report, /· skill `aaaaaaa` · spec `spec-xy`/);
    assert.match(result.mivo.findings[0].key, /^[0-9a-f]{12}$/);
    assert.equal(result.mivo.findings.length, 1);
    assert.equal(result.mivo.preexisting.length, 1);
    assert.equal(result.mivo.preexisting[0].trigger, undefined, '结果包只存紧凑形状');
    assert.deepEqual(Object.keys(result.mivo.convergence).sort(), ['lateCount', 'repeatCount', 'rethink', 'roundIndex', 'rulingViolations', 'stuckKeys']);
    assert.equal(result.mivo.convergence.roundIndex, 1);
    assert.deepEqual(result.mivo.ruledKept, []);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('v2 发布:证据在 head 上找不到仍阻断并写 warning;文件级问题不带 line', () => {
  const { work } = setup({ findings: [finding({ evidence: [{ path: 'nope.ts', line: 1 }], line: null, title: '证据缺失' })] });
  try {
    const result = publish(work);
    const comments = JSON.parse(readFileSync(join(work, 'comments.json'), 'utf8'));
    assert.equal(comments.length, 1);
    assert.equal('line' in comments[0], false);
    assert.equal(comments[0].subject_type, 'file');
    assert.ok(result.warnings.some((w) => /证据不完整\(nope\.ts:1 在 head 上找不到\),照常阻断/.test(w)));
    assert.equal(result.mivo.findings[0].evidenceComplete, false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('v2 发布:带 key 的裁定把 P1 移出阻断,P0 仍阻断;同 key 的上一轮计数沿结果链', () => {
  const key = '444444444444';
  const { work } = setup({ findings: [finding({ supersedes: key, title: '被裁定的', line: 2 })],
    state: { rulings: { verified: [{ key, by: 'owner', severity: 'P1' }], rejected: [] },
      previousRound: { roundIndex: 2, findings: [{ key, seenRounds: 2, severity: 'P1' }], keys: [key] }, previous: { head: 'h0', runId: '41' } } });
  const p0 = setup({ findings: [finding({ supersedes: key, severity: 'P0' })],
    state: { rulings: { verified: [{ key, by: 'owner', severity: 'P1' }], rejected: [] }, previousRound: { roundIndex: 2, findings: [{ key, seenRounds: 2 }], keys: [key] }, previous: { head: 'h0', runId: '41' } } });
  try {
    const kept = publish(work);
    assert.equal(kept.reviewClean, true, '被裁定的 P1 不再阻断');
    assert.equal(kept.mivo.ruledKept[0].key, key);
    assert.equal(kept.mivo.convergence.roundIndex, 3);
    assert.equal(kept.mivo.convergence.rulingViolations, 1);
    assert.ok(readFileSync(join(work, 'out', 'report.md'), 'utf8').includes('## 维护者已裁定不改、审查机本轮仍报了（未阻断）'));
    const blocked = publish(p0.work);
    assert.equal(blocked.reviewClean, false, 'P0 永不移出阻断');
    assert.equal(blocked.mivo.findings[0].seenRounds, 3);
    assert.equal(blocked.mivo.convergence.rethink, true);
    assert.ok(readFileSync(join(p0.work, 'out', 'report.md'), 'utf8').includes('## 收敛提示'));
  } finally { rmSync(work, { recursive: true, force: true }); rmSync(p0.work, { recursive: true, force: true }); }
});
