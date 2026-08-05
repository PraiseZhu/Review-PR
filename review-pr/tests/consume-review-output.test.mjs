// SC-R1b 行为矩阵:consume-review-output.mjs 子进程实跑(真 temp git 出真 snapshot、
// 真 build-review-task 产 task、真 review-preflight 产 preflight、真 STATE_DIR),
// 断到 receipt 终态——clean 唯一写者、撤销语义、retry/blocked、disposition 门、
// 交互通道纪律、覆盖/必答/负向证据对账、public CLI 禁 clean。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONSUME = join(__dirname, '..', 'scripts', 'consume-review-output.mjs');
const RECEIPT_CLI = join(__dirname, '..', 'scripts', 'write-review-receipt.mjs');
const BUILD = join(__dirname, '..', 'scripts', 'build-review-task.mjs');
const PREFLIGHT = join(__dirname, '..', 'scripts', 'review-preflight.mjs');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// head 默认只改一个普通源码文件:不进 test-infra profile,避免必答/负向证据放大用例噪音
// (那两维有专门用例覆盖)。
function setup() {
  const work = mkdtempSync(join(tmpdir(), 'consume-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], repo);
  writeFileSync(join(repo, 'src-a.mjs'), 'export const a = 1;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  const base = git(['rev-parse', 'HEAD'], repo);
  writeFileSync(join(repo, 'src-a.mjs'), 'export const a = 2;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'head'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);
  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const rulesFile = join(work, 'pr-rules.json');
  const baseRules = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'pr-rules.json'), 'utf8'));
  writeFileSync(rulesFile, JSON.stringify({ ...baseRules, admins: [], securityReviewPaths: [] }));
  const env = { ...process.env, REVIEW_PR_REPO_ROOT: repo, REVIEW_PR_STATE_DIR: stateDir, REVIEW_PR_RULES_FILE: rulesFile };
  return { work, repo, base, head, stateDir, rulesFile, env };
}

const OUT = (over = {}) => ({
  schemaVersion: 'rro-1', findingFamilies: [], verificationGaps: [], verificationRuns: [],
  profileAnswers: [], findingDispositions: [], negativeEvidence: [], escapeAssessment: [],
  segmentReceipts: [], modelVerdictNote: '', ...over,
});
const FAM = (sev = 'P1') => ({
  family_id: 'f1', invariant: '等待谓词必须真的等待', severity: sev,
  manifestations: [{ path: 'src-a.mjs', line: 1, evidence: 'e', impact: 'i', fix: 'f', verification: 'v', severity: sev }],
  fixGuidance: 'g',
});

/** 真实 build-review-task 产 task(SC-R1a:--task 现在必需)。 */
function taskFile(f) {
  const tf = join(f.work, `task-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync('node', [BUILD, '469', '--base', f.base, '--head', f.head, '--out-task', tf, '--out-prompt', `${tf}.md`], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, `build-review-task 应成功:${r.stdout}${r.stderr}`);
  return tf;
}

/** 真实 review-preflight 产 preflight。 */
function preflightFile(f) {
  const pf = join(f.work, `pf-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync('node', [PREFLIGHT, '--base', f.base, '--head', f.head, '--out', pf], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, `preflight 应 complete:${r.stdout}${r.stderr}`);
  return pf;
}

/** 按 task 自动补齐"合规答卷",让各用例只关心自己那一维。 */
function compliant(tf, over = {}) {
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  const runs = [];
  const negatives = (task.requiredNegativeEvidenceKeys ?? []).map((k, i) => {
    const runId = `r${i + 1}`;
    const command = `node --test ${k.path}`;
    runs.push({ runId, command, exitCode: 1, outputAnchor: 'expected failure' });
    return {
      fileId: k.fileId, hunkId: k.hunkId, kind: 'executed', snapshotHash: task.snapshotHash,
      command, negativeOracle: '反转断言应红', observedSignal: 'expected-failure-observed',
      outputAnchor: 'expected failure', verificationRunId: runId,
    };
  });
  const hunkOf = (fileId) => {
    for (const seg of task.segments ?? []) {
      for (const k of seg.assignedCoverageKeys) if (k.kind === 'hunk' && k.fileId === fileId) return k.hunkId;
    }
    return null;
  };
  return OUT({
    segmentReceipts: (task.segments ?? []).map((seg) => ({ segmentId: seg.segmentId, receivedOrder: seg.order, coverageKeys: seg.assignedCoverageKeys })),
    profileAnswers: (task.requiredProfileAnswers ?? []).map((r) => ({
      profileId: r.profileId, fileId: r.fileId, checkId: r.checkId, answer: 'checked-clean', hunkId: hunkOf(r.fileId),
    })),
    verificationRuns: runs,
    negativeEvidence: negatives,
    ...over,
  });
}

function run(f, output, extra = []) {
  const outFile = join(f.work, `out-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(outFile, typeof output === 'string' ? output : JSON.stringify(output));
  const args = [CONSUME, '469', '--output', outFile, '--base', f.base, '--head', f.head, ...extra];
  const r = spawnSync('node', args, { cwd: f.repo, env: f.env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(json, `应输出 JSON: status=${r.status}\n${r.stdout.slice(0, 700)}\n${r.stderr.slice(0, 700)}`);
  return { r, json };
}

/** 常规一轮:真 task + 真 preflight + 合规答卷(over 覆盖被测维度)。 */
function round(f, over = {}, { mode = 'auto', confirm = null, tf = null, pf = null } = {}) {
  const t = tf ?? taskFile(f);
  const p = pf ?? preflightFile(f);
  const extra = ['--mode', mode, '--preflight', p, '--task', t];
  if (confirm) extra.push('--confirm', confirm);
  return { ...run(f, compliant(t, over), extra), taskPath: t, preflightPath: p };
}

const readReceipt = (f) => {
  const files = readdirSync(f.stateDir, { recursive: true }).filter((p) => String(p).includes('review-receipt'));
  assert.equal(files.length, 1, `应恰一个回执文件,got ${files}`);
  return JSON.parse(readFileSync(join(f.stateDir, String(files[0])), 'utf8'));
};

test('① 合规一轮 → clean,回执带五项绑定;缺 --task → invalid(fail-closed)', () => {
  const f = setup();
  const ok = round(f);
  assert.equal(ok.json.verdict, 'clean', ok.json.reasons?.join(';'));
  assert.equal(ok.r.status, 0);
  const receipt = readReceipt(f);
  assert.equal(receipt.verdict, 'clean');
  for (const k of ['source', 'schemaVersion', 'outputHash', 'snapshotHash', 'ledgerHash']) assert.ok(receipt[k], `回执缺 ${k}`);
  assert.equal(receipt.snapshotHash, ok.json.snapshotHash);
  const noTask = run(f, compliant(ok.taskPath), ['--mode', 'auto', '--preflight', ok.preflightPath]);
  assert.equal(noTask.json.verdict, 'invalid');
  assert.match(noTask.json.reasons.join(';'), /--task/);
});

test('② 无 preflight → invalid;preflight 绑定别的 snapshot 也拒', () => {
  const f = setup();
  const tf = taskFile(f);
  const noPf = run(f, compliant(tf), ['--mode', 'auto', '--task', tf]);
  assert.equal(noPf.json.verdict, 'invalid');
  assert.match(noPf.json.reasons.join(';'), /preflight/);
  const stale = join(f.work, 'pf-stale.json');
  writeFileSync(stale, JSON.stringify({ complete: true, snapshotHash: 'snap1-other', hits: [], executedRules: [] }));
  assert.equal(run(f, compliant(tf), ['--mode', 'auto', '--task', tf, '--preflight', stale]).json.verdict, 'invalid');
});

test('③ task 与当前 snapshot 不符(head 推进后沿用旧 task)→ invalid', () => {
  const f = setup();
  const oldTask = taskFile(f);
  writeFileSync(join(f.repo, 'src-a.mjs'), 'export const a = 3;\n');
  git(['add', '.'], f.repo);
  git(['commit', '-q', '-m', 'newer'], f.repo);
  f.head = git(['rev-parse', 'HEAD'], f.repo);
  const r = run(f, compliant(oldTask), ['--mode', 'auto', '--task', oldTask, '--preflight', preflightFile(f)]);
  assert.equal(r.json.verdict, 'invalid');
  assert.match(r.json.reasons.join(';'), /task/);
});

test('④ findings → dirty 且撤销同 snapshot 旧 clean;模型 note 写 APPROVED 不采信', () => {
  const f = setup();
  assert.equal(round(f).json.verdict, 'clean');
  const d = round(f, { findingFamilies: [FAM()], modelVerdictNote: 'APPROVED' });
  assert.equal(d.json.verdict, 'dirty');
  assert.equal(readReceipt(f).verdict, 'dirty', '同 snapshot 旧 clean 必须被覆盖撤销');
});

test('⑤ retry:同 snapshot 连续 3 次非法 → blocked;非法轮不动 ledger', () => {
  const f = setup();
  const tf = taskFile(f);
  const pf = preflightFile(f);
  let last;
  for (let i = 1; i <= 3; i += 1) last = run(f, '{broken json', ['--mode', 'auto', '--task', tf, '--preflight', pf]);
  assert.equal(last.json.verdict, 'invalid');
  assert.equal(last.json.attempts, 3);
  assert.equal(last.json.blocked, true);
  assert.equal(last.json.effectiveOpenCount, 0, '非法输出不产生台账条目');
});

test('⑥ 核销门:席位 A 留 open → 席位 B 零 disposition → invalid;同 snapshot 自证 resolved → invalid', () => {
  const f = setup();
  const a = round(f, { findingFamilies: [FAM()] });
  assert.equal(a.json.verdict, 'dirty');
  assert.equal(a.json.effectiveOpenCount, 1);
  const b = round(f);
  assert.equal(b.json.verdict, 'invalid');
  assert.match(b.json.reasons.join(';'), /disposition/);
  const id = b.json.injectedOpenIds[0];
  assert.ok(id);
  const ev = { kind: 'diff-anchor', snapshotHash: b.json.snapshotHash, fileId: 'F1', hunkId: 'H1' };
  const c = round(f, { findingDispositions: [{ findingId: id, disposition: 'resolved', evidence: ev }] });
  assert.equal(c.json.verdict, 'invalid');
  assert.match(c.json.reasons.join(';'), /禁自证/);
});

test('⑦ head 推进后 resolved+结构化证据 → clean;open 继承跨 snapshot', () => {
  const f = setup();
  round(f, { findingFamilies: [FAM()] });
  const id = round(f).json.injectedOpenIds[0];
  assert.ok(id);
  writeFileSync(join(f.repo, 'src-a.mjs'), 'export const a = 9;\n');
  git(['add', '.'], f.repo);
  git(['commit', '-q', '-m', 'fix'], f.repo);
  f.head = git(['rev-parse', 'HEAD'], f.repo);
  assert.equal(round(f).json.verdict, 'invalid', 'open 必须继承到新 snapshot');
  const tf = taskFile(f);
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  const anchor = task.coverageKeys.find((k) => k.kind === 'hunk');
  const ev = { kind: 'diff-anchor', snapshotHash: task.snapshotHash, fileId: anchor.fileId, hunkId: anchor.hunkId };
  const done = round(f, { findingDispositions: [{ findingId: id, disposition: 'resolved', evidence: ev }] }, { tf });
  assert.equal(done.json.verdict, 'clean', done.json.reasons?.join(';'));
});

test('⑧ 复审反例:同一轮既重报又想 resolved → 拒(先修再核销)', () => {
  const f = setup();
  round(f, { findingFamilies: [FAM()] });
  const id = round(f).json.injectedOpenIds[0];
  writeFileSync(join(f.repo, 'src-a.mjs'), 'export const a = 7;\n');
  git(['add', '.'], f.repo);
  git(['commit', '-q', '-m', 'x'], f.repo);
  f.head = git(['rev-parse', 'HEAD'], f.repo);
  const tf = taskFile(f);
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  const anchor = task.coverageKeys.find((k) => k.kind === 'hunk');
  const ev = { kind: 'diff-anchor', snapshotHash: task.snapshotHash, fileId: anchor.fileId, hunkId: anchor.hunkId };
  const both = round(f, {
    findingFamilies: [FAM()],
    findingDispositions: [{ findingId: id, disposition: 'resolved', evidence: ev }],
  }, { tf });
  assert.equal(both.json.verdict, 'invalid');
  assert.match(both.json.reasons.join(';'), /不得在同一轮/);
});

test('⑨ accepted-risk:auto 模式拒;交互模式 → dirty(恒非 clean);P0 拒', () => {
  const f = setup();
  round(f, { findingFamilies: [FAM()] }, { mode: 'interactive' });
  const id = round(f, {}, { mode: 'interactive' }).json.injectedOpenIds[0];
  const confirm = join(f.work, 'confirm.json');
  writeFileSync(confirm, JSON.stringify([{ findingId: id, action: 'accept-risk', reason: '已知风险,owner 拍板' }]));
  assert.equal(round(f, {}, { mode: 'auto', confirm }).json.verdict, 'invalid', 'auto 无 accepted-risk 出口');
  const inter = round(f, {}, { mode: 'interactive', confirm });
  assert.equal(inter.json.verdict, 'dirty');
  assert.equal(inter.json.acceptedRiskCount, 1);
  assert.equal(readReceipt(f).verdict, 'dirty');

  const g = setup();
  round(g, { findingFamilies: [FAM('P0')] }, { mode: 'interactive' });
  const pid = round(g, {}, { mode: 'interactive' }).json.injectedOpenIds[0];
  const c2 = join(g.work, 'c2.json');
  writeFileSync(c2, JSON.stringify([{ findingId: pid, action: 'accept-risk', reason: 'r' }]));
  const p0 = round(g, {}, { mode: 'interactive', confirm: c2 });
  assert.equal(p0.json.verdict, 'invalid');
  assert.match(p0.json.reasons.join(';'), /P0\/安全/);
});

test('⑩ public CLI 禁 clean;dirty 照常', () => {
  const f = setup();
  const deny = spawnSync('node', [RECEIPT_CLI, '469', '--verdict', 'clean', '--p0p1-count', '0', '--head', f.head], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.notEqual(deny.status, 0);
  assert.match(deny.stderr + deny.stdout, /clean/);
  const okDirty = spawnSync('node', [RECEIPT_CLI, '469', '--verdict', 'dirty', '--p0p1-count', '1', '--head', f.head], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(okDirty.status, 0, okDirty.stderr);
});

test('⑪ 台账损坏 → blocked,不写回执(fail-closed)', () => {
  const f = setup();
  round(f);
  const files = readdirSync(f.stateDir, { recursive: true }).filter((p) => String(p).includes('findings-469'));
  assert.equal(files.length, 1);
  writeFileSync(join(f.stateDir, String(files[0])), '{broken');
  const r = round(f);
  assert.equal(r.json.verdict, 'blocked');
  assert.equal(r.r.status, 2);
});

test('⑫ 覆盖对账:漏段/段内集合不符/段内重复/投递序号不符 一律 invalid;精确相等 → clean', () => {
  const f = setup();
  const tf = taskFile(f);
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  const full = task.segments.map((s) => ({ segmentId: s.segmentId, receivedOrder: s.order, coverageKeys: s.assignedCoverageKeys }));
  assert.equal(round(f, { segmentReceipts: full }, { tf }).json.verdict, 'clean');
  for (const receipts of [
    [],
    [{ segmentId: full[0].segmentId, receivedOrder: full[0].receivedOrder, coverageKeys: [] }],
    [{ segmentId: full[0].segmentId, receivedOrder: full[0].receivedOrder, coverageKeys: [...full[0].coverageKeys, ...full[0].coverageKeys] }],
    full.map((s) => ({ ...s, receivedOrder: s.receivedOrder + 1 })), // 顺序不符(乱序/未按序投递)
  ]) {
    const bad = round(f, { segmentReceipts: receipts }, { tf });
    assert.equal(bad.json.verdict, 'invalid', JSON.stringify(receipts).slice(0, 120));
  }
});

test('⑬ 必答对账:checked-clean 引用编造 hunkId 不计作答 → invalid', () => {
  const f = setup();
  mkdirSync(join(f.repo, 'scripts', 'e2e'), { recursive: true });
  writeFileSync(join(f.repo, 'scripts/e2e/x.mjs'), 'export const q = 1;\n');
  git(['add', '-A'], f.repo);
  git(['commit', '-q', '-m', 'add e2e'], f.repo);
  f.head = git(['rev-parse', 'HEAD'], f.repo);
  const tf = taskFile(f);
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  assert.ok(task.requiredProfileAnswers.length > 0, 'e2e 路径必须产生必答项');
  const bad = compliant(tf, {
    profileAnswers: task.requiredProfileAnswers.map((r) => ({
      profileId: r.profileId, fileId: r.fileId, checkId: r.checkId, answer: 'checked-clean', hunkId: 'h1-fabricated',
    })),
  });
  const r = run(f, bad, ['--mode', 'auto', '--task', tf, '--preflight', preflightFile(f)]);
  assert.equal(r.json.verdict, 'invalid');
  assert.match(r.json.reasons.join(';'), /stale|必答/);
});

test('⑭ R6:required 负向证据只能由 executed 满足;N/A 与 run 声明不一致均拒', () => {
  const f = setup();
  mkdirSync(join(f.repo, 'scripts', 'e2e'), { recursive: true });
  writeFileSync(join(f.repo, 'scripts/e2e/w.mjs'), 'export async function w(page) {\n  await page.waitForFunction(() => 1);\n}\n');
  git(['add', '-A'], f.repo);
  git(['commit', '-q', '-m', 'add wait'], f.repo);
  f.head = git(['rev-parse', 'HEAD'], f.repo);
  const tf = taskFile(f);
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  assert.ok(task.requiredNegativeEvidenceKeys.length > 0, '等待原语改动必须产 required 负向 key');
  const pf = preflightFile(f);
  assert.equal(run(f, compliant(tf), ['--mode', 'auto', '--task', tf, '--preflight', pf]).json.verdict, 'clean');
  const k = task.requiredNegativeEvidenceKeys[0];
  const na = compliant(tf, {
    verificationRuns: [],
    negativeEvidence: [{ fileId: k.fileId, hunkId: k.hunkId, kind: 'not-applicable', reasonCode: 'doc-only', explanation: '只是注释' }],
  });
  const naRun = run(f, na, ['--mode', 'auto', '--task', tf, '--preflight', pf]);
  assert.equal(naRun.json.verdict, 'invalid');
  assert.match(naRun.json.reasons.join(';'), /negative-evidence/);
  const mismatch = compliant(tf, {
    verificationRuns: [{ runId: 'r1', command: '不同的命令', exitCode: 1, outputAnchor: 'expected failure' }],
    negativeEvidence: [{
      fileId: k.fileId, hunkId: k.hunkId, kind: 'executed', snapshotHash: task.snapshotHash,
      command: `node --test ${k.path}`, negativeOracle: 'o', observedSignal: 'expected-failure-observed',
      outputAnchor: 'expected failure', verificationRunId: 'r1',
    }],
  });
  assert.equal(run(f, mismatch, ['--mode', 'auto', '--task', tf, '--preflight', pf]).json.verdict, 'invalid');
});

test('⑮ preflight 命中 → 机器入账并 dirty(不经 LLM,审查输出零 finding 也拦)', () => {
  const f = setup();
  mkdirSync(join(f.repo, 'scripts', 'e2e'), { recursive: true });
  writeFileSync(join(f.repo, 'scripts/e2e/bad.mjs'), 'export async function w(page) {\n  await page.waitForFunction(async () => (await fetch("/x")).ok);\n}\n');
  git(['add', '-A'], f.repo);
  git(['commit', '-q', '-m', 'bad wait'], f.repo);
  f.head = git(['rev-parse', 'HEAD'], f.repo);
  const pfPath = join(f.work, 'pf-hit.json');
  spawnSync('node', [PREFLIGHT, '--base', f.base, '--head', f.head, '--out', pfPath], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  const pfJson = JSON.parse(readFileSync(pfPath, 'utf8'));
  assert.equal(pfJson.complete, true, JSON.stringify(pfJson).slice(0, 300));
  assert.equal(pfJson.hits.length, 1, 'preflight 应命中假等待');
  const tf = taskFile(f);
  const r = run(f, compliant(tf), ['--mode', 'auto', '--task', tf, '--preflight', pfPath]);
  assert.equal(r.json.verdict, 'dirty', '确定性命中直接机器打回');
  assert.equal(r.json.effectiveOpenCount, 1);
});

test('⑯ R7 生产触发链:候选进 prompt → escapeAssessment 必须逐条作答 → yes 项确定性写 pending inbox', () => {
  const f = setup();
  const bodyFile = join(f.work, 'body.md');
  writeFileSync(bodyFile, '本 PR 修复 #469 逃过审查的假等待问题;另外顺手依赖 #500 的改动。\n');
  const tf = join(f.work, 'task-esc.json');
  const pmt = join(f.work, 'prompt-esc.md');
  const b = spawnSync('node', [BUILD, '469', '--base', f.base, '--head', f.head, '--out-task', tf, '--out-prompt', pmt, '--pr-body-file', bodyFile], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  const prompt = readFileSync(pmt, 'utf8');
  assert.equal(task.escapeCandidates.length, 1, `只有带修复语义的引用才是候选:${JSON.stringify(task.escapeCandidates)}`);
  assert.equal(task.escapeCandidates[0].referencedPr, 469);
  assert.ok(prompt.includes('## 逃逸判定'), 'prompt 必须有逃逸判定段');
  assert.ok(prompt.includes(task.escapeCandidates[0].candidateId));
  const pf = preflightFile(f);
  const cid = task.escapeCandidates[0].candidateId;

  // 缺答 → invalid
  const miss = run(f, compliant(tf), ['--mode', 'auto', '--task', tf, '--preflight', pf]);
  assert.equal(miss.json.verdict, 'invalid');
  assert.match(miss.json.reasons.join(';'), /escapeAssessment/);
  // 答未知候选 → invalid
  const unknown = run(f, compliant(tf, { escapeAssessment: [{ candidateId: 'esc-bogus-1', verdict: 'no', basis: 'x' }] }), ['--mode', 'auto', '--task', tf, '--preflight', pf]);
  assert.equal(unknown.json.verdict, 'invalid');
  // 答 no → clean 且不登记
  const no = run(f, compliant(tf, { escapeAssessment: [{ candidateId: cid, verdict: 'no', basis: '只是引用,不是修它的漏审' }] }), ['--mode', 'auto', '--task', tf, '--preflight', pf]);
  assert.equal(no.json.verdict, 'clean', no.json.reasons?.join(';'));
  assert.deepEqual(no.json.registeredHazards, []);
  // 答 yes → clean 且**确定性登记**到 pending inbox
  const yes = run(f, compliant(tf, { escapeAssessment: [{ candidateId: cid, verdict: 'yes', basis: '本 PR 修的正是 #469 漏审的假等待模式' }] }), ['--mode', 'auto', '--task', tf, '--preflight', pf]);
  assert.equal(yes.json.verdict, 'clean', yes.json.reasons?.join(';'));
  assert.equal(yes.json.registeredHazards.length, 1, 'yes 必须落 pending inbox(生产会调用,不是"recorder 可手调")');
  const inboxFiles = readdirSync(f.stateDir, { recursive: true }).filter((p) => String(p).includes('escaped-hazards-inbox'));
  assert.equal(inboxFiles.length, 1, `应写出 inbox,got ${readdirSync(f.stateDir, { recursive: true })}`);
  const inbox = JSON.parse(readFileSync(join(f.stateDir, String(inboxFiles[0])), 'utf8'));
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].activationStatus, 'pending-fix-merge', '未合并前只能是 pending');
  assert.equal(inbox.items[0].originPr, 469);
  assert.equal(inbox.items[0].fixPr, 469); // 本测试的 PR 号
  assert.equal(inbox.items[0].fixHead, f.head);
  assert.ok(inbox.items[0].repo, 'hazard 必须绑定 repo');
  assert.ok(inbox.items[0].fingerprint);
});
