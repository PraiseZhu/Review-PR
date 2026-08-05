// SC-R8 第 2 轮核验:四消费方"同源"的**行为级**验收(此前只有静态 grep "参数支持",
// 那证明不了 mismatch 时真的会拒)。这里用真 temp git 仓走子进程,验证同一份 snapshot 身份
// 漂移时 preflight / builder / consumer / 回执核验(= pre-merge 的 stage2 判据)全部反应。
//
// 关键点:snapshotHash 是四元(baseRefOid, mergeBaseOid, headOid, diffDigest)——**base 前进
// 而 head 一个字没改**同样换身份,旧证据必须整体作废。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiffSnapshot } from '../scripts/lib.diff-snapshot.mjs';
import { isReviewReceiptClean } from '../scripts/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD = join(__dirname, '..', 'scripts', 'build-review-task.mjs');
const PREFLIGHT = join(__dirname, '..', 'scripts', 'review-preflight.mjs');
const CONSUME = join(__dirname, '..', 'scripts', 'consume-review-output.mjs');
const DELIVER = join(__dirname, '..', 'scripts', 'deliver-review-segment.mjs');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function setup() {
  const work = mkdtempSync(join(tmpdir(), 'drift-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], repo);
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'c0'], repo);
  const base0 = git(['rev-parse', 'HEAD'], repo);
  writeFileSync(join(repo, 'b.mjs'), 'export const b = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'c1'], repo);
  const base1 = git(['rev-parse', 'HEAD'], repo); // base 前进(head 尚未产生)
  writeFileSync(join(repo, 'c.mjs'), 'export const c = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'c2'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);
  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const rulesFile = join(work, 'pr-rules.json');
  writeFileSync(rulesFile, JSON.stringify({ admins: [] }));
  const bodyFile = join(work, 'body.md');
  writeFileSync(bodyFile, '普通改动。\n');
  const env = { ...process.env, REVIEW_PR_REPO_ROOT: repo, REVIEW_PR_STATE_DIR: stateDir, REVIEW_PR_RULES_FILE: rulesFile };
  return { work, repo, base0, base1, head, stateDir, env, bodyFile };
}

const runJson = (argv, f) => {
  const r = spawnSync('node', argv, { cwd: f.repo, env: f.env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(json, `应输出 JSON:status=${r.status}\n${r.stdout.slice(0, 500)}\n${r.stderr.slice(0, 500)}`);
  return { r, json };
};

test('R8 前提:base 前进而 head 不变 → snapshotHash 必须换身份(四元锚点,不是裸 head)', () => {
  const f = setup();
  const s0 = buildDiffSnapshot({ repoRoot: f.repo, baseRefOid: f.base0, headOid: f.head });
  const s1 = buildDiffSnapshot({ repoRoot: f.repo, baseRefOid: f.base1, headOid: f.head });
  assert.equal(s0.complete, true, s0.reason);
  assert.equal(s1.complete, true, s1.reason);
  assert.equal(s0.headOid, s1.headOid, 'head 一个字没改');
  assert.notEqual(s0.snapshotHash, s1.snapshotHash, 'base 前进即换身份——否则旧证据会被当成当前有效');
});

test('R8 行为级:同一 snapshot 漂移时,preflight / builder / consumer / 回执核验四方全部反应', () => {
  const f = setup();
  const s0 = buildDiffSnapshot({ repoRoot: f.repo, baseRefOid: f.base0, headOid: f.head });
  const s1 = buildDiffSnapshot({ repoRoot: f.repo, baseRefOid: f.base1, headOid: f.head });

  // ① preflight:两次跑出的 snapshotHash 必须各自绑定自己的 base
  const pf0 = join(f.work, 'pf0.json');
  const pf1 = join(f.work, 'pf1.json');
  const p0 = runJson([PREFLIGHT, '--base', f.base0, '--head', f.head, '--out', pf0], f);
  const p1 = runJson([PREFLIGHT, '--base', f.base1, '--head', f.head, '--out', pf1], f);
  assert.equal(p0.json.snapshotHash, s0.snapshotHash);
  assert.equal(p1.json.snapshotHash, s1.snapshotHash);
  assert.notEqual(p0.json.snapshotHash, p1.json.snapshotHash);

  // ② builder:task 绑定构建时的 snapshot
  const t0 = join(f.work, 't0.json');
  const b0 = runJson([BUILD, '469', '--base', f.base0, '--head', f.head, '--out-task', t0, '--out-prompt', `${t0}.md`, '--pr-body-file', f.bodyFile], f);
  assert.equal(b0.json.snapshotHash, s0.snapshotHash);

  // ③ consumer:拿 base0 的 task + base0 的 preflight,在 base1 上消费 → invalid
  const task0 = JSON.parse(readFileSync(t0, 'utf8'));
  for (let i = 1; i <= task0.segments.length; i += 1) {
    const d = spawnSync('node', [DELIVER, '469', '--task', t0, '--base', f.base0, '--head', f.head, '--order', String(i)], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(d.status, 0, d.stdout + d.stderr);
  }
  const answer = {
    schemaVersion: 'rro-1', findingFamilies: [], verificationGaps: [], verificationRuns: [],
    profileAnswers: [], findingDispositions: [], negativeEvidence: [], escapeAssessment: [],
    segmentReceipts: task0.segments.map((s) => ({ segmentId: s.segmentId, receivedOrder: s.order, coverageKeys: s.assignedCoverageKeys })),
    modelVerdictNote: '',
  };
  const outFile = join(f.work, 'out.json');
  writeFileSync(outFile, JSON.stringify(answer));
  const okRun = runJson([CONSUME, '469', '--output', outFile, '--base', f.base0, '--head', f.head, '--task', t0, '--preflight', pf0, '--mode', 'auto'], f);
  assert.equal(okRun.json.verdict, 'clean', `对照组必须 clean:${okRun.json.reasons?.join(';')}`);
  const drift = runJson([CONSUME, '469', '--output', outFile, '--base', f.base1, '--head', f.head, '--task', t0, '--preflight', pf0, '--mode', 'auto'], f);
  assert.equal(drift.json.verdict, 'invalid', 'base 漂移后旧 task/preflight 不得再采信');
  assert.match(drift.json.reasons.join(';'), /snapshot/);

  // ④ 回执核验(pre-merge 的 stage2 判据同一函数):base0 的 clean 回执在 base1 下不再 clean
  const receipt = {
    verdict: 'clean', headRefOid: f.head, p0p1Count: 0,
    source: 'consume-review-output', schemaVersion: 'rro-1', outputHash: 'oh1-x',
    snapshotHash: s0.snapshotHash, ledgerHash: 'lh1-x',
  };
  assert.equal(isReviewReceiptClean({ receipt, headRefOid: f.head, snapshotHash: s0.snapshotHash, ledgerHash: 'lh1-x' }), true);
  assert.equal(isReviewReceiptClean({ receipt, headRefOid: f.head, snapshotHash: s1.snapshotHash, ledgerHash: 'lh1-x' }), false,
    'head 相同但 snapshot 身份变了 → 回执作废(旧实现只比 head,base 前进照样算清白)');
});

test('R8 --expected-paths:PR files 元数据与 patch 文件集不一致 → complete=false,一路 fail-closed', () => {
  const f = setup();
  const t = join(f.work, 't-exp.json');
  // 真实文件集是 c.mjs;谎报成 zzz.mjs → 互检必须失败
  const bad = runJson([BUILD, '469', '--base', f.base1, '--head', f.head, '--out-task', t, '--out-prompt', `${t}.md`, '--pr-body-file', f.bodyFile, '--expected-paths', 'zzz.mjs'], f);
  assert.equal(bad.json.snapshotComplete, false);
  const good = runJson([BUILD, '469', '--base', f.base1, '--head', f.head, '--out-task', t, '--out-prompt', `${t}.md`, '--pr-body-file', f.bodyFile, '--expected-paths', 'c.mjs'], f);
  assert.equal(good.json.snapshotComplete, true, JSON.stringify(good.json).slice(0, 300));
});
