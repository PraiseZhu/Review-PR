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
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    // 显式禁签名:继承全局 commit.gpgsign 时,并发跑 temp-git 用例会撞 gpg
    // 「Cannot allocate memory」而随机红(核验席实测 409/414)。测试仓不需要签名。
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
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
  const delivered0 = [];
  for (let i = 1; i <= task0.segments.length; i += 1) {
    const d = spawnSync('node', [DELIVER, '469', '--task', t0, '--base', f.base0, '--head', f.head, '--order', String(i)], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(d.status, 0, d.stdout + d.stderr);
    delivered0.push(JSON.parse(d.stdout));
  }
  const answer = {
    schemaVersion: 'rro-1', snapshotHash: task0.snapshotHash,
    findingFamilies: [], verificationGaps: [], verificationRuns: [],
    profileAnswers: [], findingDispositions: [], negativeEvidence: [], escapeAssessment: [],
    segmentReceipts: delivered0.map((s) => ({ segmentId: s.segmentId, receivedOrder: s.order, snapshotHash: task0.snapshotHash, coverageKeys: s.assignedCoverageKeys })),
    modelVerdictNote: '',
  };
  const outFile = join(f.work, 'out.json');
  writeFileSync(outFile, JSON.stringify(answer));
  const okRun = runJson([CONSUME, '469', '--output', outFile, '--base', f.base0, '--head', f.head, '--task', t0, '--preflight', pf0, '--mode', 'auto', '--pr-body-file', f.bodyFile], f);
  assert.equal(okRun.json.verdict, 'clean', `对照组必须 clean:${okRun.json.reasons?.join(';')}`);
  const drift = runJson([CONSUME, '469', '--output', outFile, '--base', f.base1, '--head', f.head, '--task', t0, '--preflight', pf0, '--mode', 'auto', '--pr-body-file', f.bodyFile], f);
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

test('R8 隔离 baseRefOid 这一维:base 分支前进到**不在 head 祖先链上**的提交(mergeBase 与 diff 都不变)时仍换身份', () => {
  // c0 ──► head(feature 分支,只加 c.mjs)
  //   └──► c2(main 上的无关提交)
  // 此时 mergeBase(c0, head) === mergeBase(c2, head) === c0,diff 完全一样;
  // **只有 baseRefOid 不同**。上一条用例里 base 前进会连带 mergeBase 变化,盖住了这一维
  // (实测:把 baseRefOid 从 hash 里删掉,那条用例照样绿)。
  const work = mkdtempSync(join(tmpdir(), 'drift-base-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'c0'], repo);
  const c0 = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', '-b', 'feature'], repo);
  writeFileSync(join(repo, 'c.mjs'), 'export const c = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'feature'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', 'main'], repo);
  writeFileSync(join(repo, 'unrelated.mjs'), 'export const u = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'unrelated on main'], repo);
  const c2 = git(['rev-parse', 'HEAD'], repo);

  const s0 = buildDiffSnapshot({ repoRoot: repo, baseRefOid: c0, headOid: head });
  const s1 = buildDiffSnapshot({ repoRoot: repo, baseRefOid: c2, headOid: head });
  assert.equal(s0.complete, true, s0.reason);
  assert.equal(s1.complete, true, s1.reason);
  assert.equal(s0.mergeBaseOid, s1.mergeBaseOid, '前提:mergeBase 必须一样');
  assert.equal(s0.diffDigest, s1.diffDigest, '前提:diff 必须一样');
  assert.notEqual(s0.baseRefOid, s1.baseRefOid, '前提:只有 baseRefOid 不同');
  assert.notEqual(s0.snapshotHash, s1.snapshotHash, 'base 分支移动即换身份——旧证据不得继续算当前有效');
});

test('R1a/R4 第 3 轮核验 BLOCKER:旧答卷不得跨 snapshot 重放(diff 与 coverage key 完全相同也不行)', () => {
  // 场景刻意构造成"最难拦"的一种:base 移到不在 head 祖先链上的提交 → mergeBase 与 diff
  // 完全不变、coverage key 逐字节相同,只有 snapshotHash 变了。此时重建 task/preflight/
  // delivery 之后把**旧答卷**原样重放,若答卷本身不绑 snapshot 就会再拿一次 clean(实测)。
  const work = mkdtempSync(join(tmpdir(), 'replay-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], repo);
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'c0'], repo);
  const c0 = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', '-b', 'feature'], repo);
  writeFileSync(join(repo, 'c.mjs'), 'export const c = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'feature'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', 'main'], repo);
  writeFileSync(join(repo, 'unrelated.mjs'), 'export const u = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'unrelated'], repo);
  const c2 = git(['rev-parse', 'HEAD'], repo);

  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const rulesFile = join(work, 'pr-rules.json');
  writeFileSync(rulesFile, JSON.stringify({ admins: [] }));
  const bodyFile = join(work, 'body.md');
  writeFileSync(bodyFile, '普通改动。\n');
  const f = { work, repo, base0: c0, base1: c2, head, stateDir, bodyFile,
    env: { ...process.env, REVIEW_PR_REPO_ROOT: repo, REVIEW_PR_STATE_DIR: stateDir, REVIEW_PR_RULES_FILE: rulesFile } };

  const s0 = buildDiffSnapshot({ repoRoot: repo, baseRefOid: c0, headOid: head });
  const s1 = buildDiffSnapshot({ repoRoot: repo, baseRefOid: c2, headOid: head });
  assert.equal(s0.diffDigest, s1.diffDigest, '前提:diff 完全相同');
  assert.notEqual(s0.snapshotHash, s1.snapshotHash, '前提:snapshot 身份不同');

  const cycle = (baseOid, tag) => {
    const t = join(work, `t-${tag}.json`);
    const pf = join(work, `pf-${tag}.json`);
    runJson([BUILD, '469', '--base', baseOid, '--head', head, '--out-task', t, '--out-prompt', `${t}.md`, '--pr-body-file', bodyFile], f);
    runJson([PREFLIGHT, '--base', baseOid, '--head', head, '--out', pf], f);
    const task = JSON.parse(readFileSync(t, 'utf8'));
    const delivered = [];
    for (let i = 1; i <= task.segments.length; i += 1) {
      const d = spawnSync('node', [DELIVER, '469', '--task', t, '--base', baseOid, '--head', head, '--order', String(i)], { cwd: repo, env: f.env, encoding: 'utf8' });
      assert.equal(d.status, 0, d.stdout + d.stderr);
      delivered.push(JSON.parse(d.stdout));
    }
    return { t, pf, task, delivered };
  };
  const answerFor = ({ task, delivered }) => ({
    schemaVersion: 'rro-1', snapshotHash: task.snapshotHash,
    findingFamilies: [], verificationGaps: [], verificationRuns: [],
    profileAnswers: [], findingDispositions: [], negativeEvidence: [], escapeAssessment: [],
    segmentReceipts: delivered.map((s) => ({ segmentId: s.segmentId, receivedOrder: s.order, snapshotHash: task.snapshotHash, coverageKeys: s.assignedCoverageKeys })),
    modelVerdictNote: '',
  });

  // ① 在 base0 上正常拿一次 clean
  const a = cycle(c0, 'a');
  const oldAnswer = answerFor(a);
  const oldFile = join(work, 'old-out.json');
  writeFileSync(oldFile, JSON.stringify(oldAnswer));
  const first = runJson([CONSUME, '469', '--output', oldFile, '--base', c0, '--head', head, '--task', a.t, '--preflight', a.pf, '--mode', 'auto', '--pr-body-file', f.bodyFile], f);
  assert.equal(first.json.verdict, 'clean', first.json.reasons?.join(';'));

  // ② base 移动后:task/preflight/delivery 全部重建(所以那三样都"新"),但答卷是旧的
  const b = cycle(c2, 'b');
  assert.equal(a.task.coverageCommitment, b.task.coverageCommitment, '前提:两轮的 coverage 内容承诺一致(逐字节相同的 diff)');
  const replay = runJson([CONSUME, '469', '--output', oldFile, '--base', c2, '--head', head, '--task', b.t, '--preflight', b.pf, '--mode', 'auto', '--pr-body-file', f.bodyFile], f);
  assert.equal(replay.json.verdict, 'invalid', `旧答卷跨 snapshot 重放必须被拒:${JSON.stringify(replay.json).slice(0, 400)}`);
  assert.match(replay.json.reasons.join(';'), /snapshotHash/);

  // ③ 对照:换成绑定新 snapshot 的答卷 → clean(证明不是"一律拒")
  const newFile = join(work, 'new-out.json');
  writeFileSync(newFile, JSON.stringify(answerFor(b)));
  const fresh = runJson([CONSUME, '469', '--output', newFile, '--base', c2, '--head', head, '--task', b.t, '--preflight', b.pf, '--mode', 'auto', '--pr-body-file', f.bodyFile], f);
  assert.equal(fresh.json.verdict, 'clean', fresh.json.reasons?.join(';'));
});
