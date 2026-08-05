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
const DELIVER = join(__dirname, '..', 'scripts', 'deliver-review-segment.mjs');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    // 显式禁签名:继承全局 commit.gpgsign 时,并发跑 temp-git 用例会撞 gpg
    // 「Cannot allocate memory」而随机红(核验席实测 409/414)。测试仓不需要签名。
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
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

/** 真实 build-review-task 产 task(SC-R1a:--task 现在必需)。
 *  `--pr-body-file` 是 R7 数据源的离线 seam:不传的话构建器会现场 `gh pr view`(生产行为),
 *  单测不该依赖网络。默认给一份"无逃逸引用"的 body。 */
const BODY_OF = new Map(); // task 路径 → 它构建时用的 body seam(consumer 必须用同一份重算)
function taskFile(f, { body = '普通改动,无历史 PR 引用。' } = {}) {
  const tf = join(f.work, `task-${Math.random().toString(36).slice(2)}.json`);
  const bodyFile = `${tf}.body.md`;
  writeFileSync(bodyFile, body);
  BODY_OF.set(tf, bodyFile);
  const r = spawnSync('node', [BUILD, '469', '--base', f.base, '--head', f.head, '--out-task', tf, '--out-prompt', `${tf}.md`, '--pr-body-file', bodyFile], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, `build-review-task 应成功:${r.stdout}${r.stderr}`);
  return tf;
}

/** 投递结果缓存:task 文件路径 → 各段的 {segmentId, order, coverageKeys}。
 *  第 3 轮核验后 task.json 不再含 key 明细,**只能**从投递出口取——测试也走同一条路。 */
const DELIVERED = new Map();

/** SC-R4:逐段真投递(consumer 以投递台账为顺序基准,没投递过不予采信)。 */
function deliverAll(f, tf, { upTo = null, pr = '469' } = {}) {
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  const segs = task.segments ?? [];
  const limit = upTo ?? segs.length;
  const got = [];
  for (let i = 1; i <= limit; i += 1) {
    const r = spawnSync('node', [DELIVER, pr, '--task', tf, '--base', f.base, '--head', f.head, '--order', String(i)], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, `第 ${i} 段投递应成功:${r.stdout}${r.stderr}`);
    const j = JSON.parse(r.stdout);
    got.push({
      segmentId: j.segmentId, order: j.order, coverageKeys: j.assignedCoverageKeys,
      // 第 4 轮核验:必答项与负向 key 的明细已从 task 撤出,唯一出口是投递输出
      profileRequirements: j.profileRequirements ?? [], negativeRequirements: j.negativeRequirements ?? [],
    });
  }
  DELIVERED.set(tf, got);
  return got;
}
const deliveredOf = (tf) => DELIVERED.get(tf) ?? [];

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
  const delivered = deliveredOf(tf);
  const runs = [];
  // 第 4 轮核验:task 不再含 requiredNegativeEvidenceKeys / requiredProfileAnswers 明细,
  // 答卷素材只能来自投递输出——测试与生产走同一条路
  const negKeys = delivered.flatMap((seg) => seg.negativeRequirements ?? []);
  const profileReqs = delivered.flatMap((seg) => seg.profileRequirements ?? []);
  const negatives = negKeys.map((k, i) => {
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
    for (const seg of delivered) {
      for (const k of seg.coverageKeys) if (k.kind === 'hunk' && k.fileId === fileId) return k.hunkId;
    }
    return null;
  };
  return OUT({
    // 答卷必须绑定它所审的 snapshot(顶层 + 每段回执),第 3 轮核验 BLOCKER
    snapshotHash: task.snapshotHash,
    segmentReceipts: delivered.map((seg) => ({ segmentId: seg.segmentId, receivedOrder: seg.order, snapshotHash: task.snapshotHash, coverageKeys: seg.coverageKeys })),
    profileAnswers: profileReqs.map((r) => ({
      profileId: r.profileId, fileId: r.fileId, checkId: r.checkId, answer: 'checked-clean', hunkId: hunkOf(r.fileId),
    })),
    verificationRuns: runs,
    negativeEvidence: negatives,
    ...over,
  });
}

function run(f, output, extra = [], { pr = '469', env = {} } = {}) {
  const outFile = join(f.work, `out-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(outFile, typeof output === 'string' ? output : JSON.stringify(output));
  // consumer 也要**独立重算**逃逸候选(R7 第 3 轮核验),离线测试必须喂同一份 body seam
  const ti = extra.indexOf('--task');
  const bodySeam = ti >= 0 && BODY_OF.has(extra[ti + 1]) ? ['--pr-body-file', BODY_OF.get(extra[ti + 1])] : [];
  const args = [CONSUME, pr, '--output', outFile, '--base', f.base, '--head', f.head, ...extra, ...bodySeam];
  const r = spawnSync('node', args, { cwd: f.repo, env: { ...f.env, ...env }, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(json, `应输出 JSON: status=${r.status}\n${r.stdout.slice(0, 700)}\n${r.stderr.slice(0, 700)}`);
  return { r, json };
}

/** 常规一轮:真 task + 真 preflight + 合规答卷(over 覆盖被测维度)。 */
function round(f, over = {}, { mode = 'auto', confirm = null, tf = null, pf = null, deliver = true } = {}) {
  const t = tf ?? taskFile(f);
  const p = pf ?? preflightFile(f);
  if (deliver) deliverAll(f, t);
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
  deliverAll(f, tf); // SC-R4:直接调 run 的用例也必须真投递
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
  deliverAll(f, tf); // SC-R4:直接调 run 的用例也必须真投递
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
  const anchor = deliveredOf(b.taskPath).flatMap((x) => x.coverageKeys).find((k) => k.kind === 'hunk');
  const ev = { kind: 'diff-anchor', snapshotHash: b.json.snapshotHash, fileId: anchor.fileId, hunkId: anchor.hunkId };
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
  const anchor = deliverAll(f, tf).flatMap((x) => x.coverageKeys).find((k) => k.kind === 'hunk');
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
  const anchor = deliverAll(f, tf).flatMap((x) => x.coverageKeys).find((k) => k.kind === 'hunk');
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
  deliverAll(f, tf);
  const full = deliveredOf(tf).map((s) => ({ segmentId: s.segmentId, receivedOrder: s.order, snapshotHash: task.snapshotHash, coverageKeys: s.coverageKeys }));
  assert.equal(round(f, { segmentReceipts: full }, { tf }).json.verdict, 'clean');
  for (const receipts of [
    [],
    [{ ...full[0], coverageKeys: [] }],
    [{ ...full[0], coverageKeys: [...full[0].coverageKeys, ...full[0].coverageKeys] }],
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
  deliverAll(f, tf); // SC-R4:直接调 run 的用例也必须真投递
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  assert.ok(task.requiredProfileAnswerCount > 0, 'e2e 路径必须产生必答项');
  const profileReqs = deliveredOf(tf).flatMap((seg) => seg.profileRequirements ?? []);
  assert.equal(profileReqs.length, task.requiredProfileAnswerCount, '必答项明细只在投递输出里');
  const bad = compliant(tf, {
    profileAnswers: profileReqs.map((r) => ({
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
  deliverAll(f, tf); // SC-R4:直接调 run 的用例也必须真投递
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  assert.ok(task.requiredNegativeEvidenceKeyCount > 0, '等待原语改动必须产 required 负向 key');
  const negKeys = deliveredOf(tf).flatMap((seg) => seg.negativeRequirements ?? []);
  assert.equal(negKeys.length, task.requiredNegativeEvidenceKeyCount, '明细只在投递输出里,且总数与 task 计数一致');
  const pf = preflightFile(f);
  assert.equal(run(f, compliant(tf), ['--mode', 'auto', '--task', tf, '--preflight', pf]).json.verdict, 'clean');
  const k = negKeys[0];
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
  deliverAll(f, tf); // SC-R4:直接调 run 的用例也必须真投递
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
  BODY_OF.set(tf, bodyFile); // consumer 侧重算要用同一份 body seam
  const b = spawnSync('node', [BUILD, '483', '--base', f.base, '--head', f.head, '--out-task', tf, '--out-prompt', pmt, '--pr-body-file', bodyFile], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  const prompt = readFileSync(pmt, 'utf8');
  assert.equal(task.escapeCandidates.length, 1, `只有带修复语义的引用才是候选:${JSON.stringify(task.escapeCandidates)}`);
  assert.equal(task.escapeCandidates[0].referencedPr, 469);
  assert.ok(prompt.includes('## 逃逸判定'), 'prompt 必须有逃逸判定段');
  assert.ok(prompt.includes(task.escapeCandidates[0].candidateId));
  const pf = preflightFile(f);
  deliverAll(f, tf, { pr: '483' }); // SC-R4:直接调 run 的用例也必须真投递
  const cid = task.escapeCandidates[0].candidateId;
  const ORIGIN_HEAD = 'a'.repeat(40);
  // REVIEW_PR_ORIGIN_HEAD_MAP 是测试 seam(生产现场 gh 取),让本用例离线可复跑
  const seam = { REVIEW_PR_ORIGIN_HEAD_MAP: JSON.stringify({ 469: ORIGIN_HEAD }) };
  const P = { pr: '483', env: seam };

  // 缺答 → invalid
  const miss = run(f, compliant(tf), ['--mode', 'auto', '--task', tf, '--preflight', pf], P);
  assert.equal(miss.json.verdict, 'invalid');
  assert.match(miss.json.reasons.join(';'), /escapeAssessment/);
  // 答未知候选 → invalid
  const unknown = run(f, compliant(tf, { escapeAssessment: [{ candidateId: 'esc-bogus-1', verdict: 'no', basis: 'x' }] }), ['--mode', 'auto', '--task', tf, '--preflight', pf], P);
  assert.equal(unknown.json.verdict, 'invalid');
  // 答 no → clean 且不登记
  const no = run(f, compliant(tf, { escapeAssessment: [{ candidateId: cid, verdict: 'no', basis: '只是引用,不是修它的漏审' }] }), ['--mode', 'auto', '--task', tf, '--preflight', pf], P);
  assert.equal(no.json.verdict, 'clean', no.json.reasons?.join(';'));
  assert.deepEqual(no.json.registeredHazards, []);
  // 答 yes → clean 且**确定性登记**到 pending inbox
  const YES = compliant(tf, { escapeAssessment: [{ candidateId: cid, verdict: 'yes', basis: '本 PR 修的正是 #469 漏审的假等待模式' }] });
  // originHead 拿不到完整 40 位 SHA 时必须登记失败 → invalid(此前硬编码 null,origin OID 门被旁路)
  const badOrigin = run(f, YES, ['--mode', 'auto', '--task', tf, '--preflight', pf], { pr: '483', env: { REVIEW_PR_ORIGIN_HEAD_MAP: JSON.stringify({ 469: 'not-a-sha' }) } });
  assert.equal(badOrigin.json.verdict, 'invalid');
  assert.match(badOrigin.json.reasons.join(';'), /登记/);
  assert.deepEqual(badOrigin.json.registeredHazards, []);
  const yes = run(f, YES, ['--mode', 'auto', '--task', tf, '--preflight', pf], P);
  assert.equal(yes.json.verdict, 'clean', yes.json.reasons?.join(';'));
  assert.equal(yes.json.registeredHazards.length, 1, 'yes 必须落 pending inbox(生产会调用,不是"recorder 可手调")');
  const inboxFiles = readdirSync(f.stateDir, { recursive: true }).filter((p) => String(p).includes('escaped-hazards-inbox'));
  assert.equal(inboxFiles.length, 1, `应写出 inbox,got ${readdirSync(f.stateDir, { recursive: true })}`);
  const inbox = JSON.parse(readFileSync(join(f.stateDir, String(inboxFiles[0])), 'utf8'));
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].activationStatus, 'pending-fix-merge', '未合并前只能是 pending');
  assert.equal(inbox.items[0].originPr, 469);
  assert.equal(inbox.items[0].fixPr, 483, 'E2E 必须是 origin #469 → fix #483(同号自证证明不了 origin/fix 现场核验)');
  assert.equal(inbox.items[0].originHead, ORIGIN_HEAD, 'originHead 必须是现场取到的完整 40 位 SHA');
  assert.equal(inbox.items[0].fixHead, f.head);
  assert.ok(inbox.items[0].repo, 'hazard 必须绑定 repo');
  assert.ok(inbox.items[0].fingerprint);
});

test('⑰ R1a 第 2 轮核验 BLOCKER:task 不是权威——保留真 snapshotHash 但清空四组集合 → invalid', () => {
  const f = setup();
  // 造一个"必然有 required 必答 + required 负向证据"的改动,让被清空的集合非空
  mkdirSync(join(f.repo, 'scripts', 'e2e'), { recursive: true });
  writeFileSync(join(f.repo, 'scripts', 'e2e', 'wait.mjs'), 'export const w = async (page) => { await page.waitForFunction(() => document.readyState === "complete"); };\n');
  git(['add', '.'], f.repo);
  git(['commit', '-q', '-m', 'add e2e'], f.repo);
  f.head = git(['rev-parse', 'HEAD'], f.repo);
  const tf = taskFile(f);
  deliverAll(f, tf);
  const pf = preflightFile(f);
  const good = JSON.parse(readFileSync(tf, 'utf8'));
  assert.equal(good.coverageKeys, undefined, 'task 不得携带 coverage key 明细(只能经投递出口取)');
  assert.ok(good.coverageKeyCount > 0 && good.requiredProfileAnswerCount > 0 && good.requiredNegativeEvidenceKeyCount > 0, '前提:三组集合都非空');
  assert.equal(good.requiredProfileAnswers, undefined, 'task 不得携带必答项明细(fileId 随分段投递)');
  assert.equal(good.requiredNegativeEvidenceKeys, undefined, 'task 不得携带负向 key 明细(fileId/hunkId 就是 coverage hunk key)');
  const answer = compliant(tf); // 按真 task 作答(合规)
  assert.equal(run(f, answer, ['--mode', 'auto', '--task', tf, '--preflight', pf]).json.verdict, 'clean', '对照:未篡改时 clean');

  // 篡改:snapshotHash 照真值留着,只把四组集合清空(核验席实测此前仍 exit 0 + clean)
  const tampered = join(f.work, 'task-tampered.json');
  writeFileSync(tampered, JSON.stringify({
    ...good, coverageKeyCount: 0, coverageCommitment: 'cc1-forged', segments: [],
    requiredProfileAnswerCount: 0, profileAnswersCommitment: 'pc1-forged',
    requiredNegativeEvidenceKeyCount: 0, negativeEvidenceCommitment: 'nec1-forged',
  }));
  const r = run(f, OUT({ snapshotHash: good.snapshotHash }), ['--mode', 'auto', '--task', tampered, '--preflight', pf]);
  assert.equal(r.json.verdict, 'invalid', r.json.reasons?.join(';'));
  const joined = r.json.reasons.join(';');
  for (const k of ['coverageCommitment', 'coverageKeyCount', 'profileAnswersCommitment', 'negativeEvidenceCommitment', 'segments']) {
    assert.match(joined, new RegExp(k), `必须逐组报出与重算值不一致:缺 ${k}`);
  }
  // 反过来:task 里若**塞回** key 明细,同样判非法(那条通道必须关死)
  const leaked = join(f.work, 'task-leaked.json');
  writeFileSync(leaked, JSON.stringify({ ...good, coverageKeys: [{ kind: 'file', fileId: 'F1' }] }));
  assert.match(run(f, answer, ['--mode', 'auto', '--task', leaked, '--preflight', pf]).json.reasons.join(';'), /不得携带 coverageKeys/);
  // 第 4 轮核验:另两组明细塞回 task 同样必须被拒(fileId/hunkId 就是回执素材)
  const leakedNeg = join(f.work, 'task-leaked-neg.json');
  writeFileSync(leakedNeg, JSON.stringify({ ...good, requiredNegativeEvidenceKeys: [] }));
  assert.match(run(f, answer, ['--mode', 'auto', '--task', leakedNeg, '--preflight', pf]).json.reasons.join(';'), /不得携带 requiredNegativeEvidenceKeys/);
  const leakedProf = join(f.work, 'task-leaked-prof.json');
  writeFileSync(leakedProf, JSON.stringify({ ...good, requiredProfileAnswers: [] }));
  assert.match(run(f, answer, ['--mode', 'auto', '--task', leakedProf, '--preflight', pf]).json.reasons.join(';'), /不得携带 requiredProfileAnswers/);
  // 单独篡改 profileSetHash 也要被抓
  const psh = join(f.work, 'task-psh.json');
  writeFileSync(psh, JSON.stringify({ ...good, profileSetHash: 'ps1-forged' }));
  assert.match(run(f, answer, ['--mode', 'auto', '--task', psh, '--preflight', pf]).json.reasons.join(';'), /profileSetHash/);
});

test('⑱ R1a 第 2 轮核验 BLOCKER:已有同 snapshot clean 时,缺/坏 task 必须把回执改成 non-clean(不得沿用清白)', () => {
  const f = setup();
  const ok = round(f);
  assert.equal(ok.json.verdict, 'clean');
  assert.equal(readReceipt(f).verdict, 'clean');
  // 缺 --task
  const noTask = run(f, compliant(ok.taskPath), ['--mode', 'auto', '--preflight', ok.preflightPath]);
  assert.equal(noTask.json.verdict, 'invalid');
  assert.equal(readReceipt(f).verdict, 'dirty', '缺 task 这一轮必须撤销旧 clean');
  assert.equal(noTask.json.attempts, 1, '输入级失败也要记 retry(否则可以无限次试)');
  // 坏 task(不可解析)
  round(f); // 先恢复 clean
  assert.equal(readReceipt(f).verdict, 'clean');
  const broken = join(f.work, 'task-broken.json');
  writeFileSync(broken, '{not json');
  const badTask = run(f, compliant(ok.taskPath), ['--mode', 'auto', '--task', broken, '--preflight', ok.preflightPath]);
  assert.equal(badTask.json.verdict, 'invalid');
  assert.equal(readReceipt(f).verdict, 'dirty', '坏 task 同样必须撤销旧 clean');
});

test('⑲ R4 第 2 轮核验 BLOCKER:分段必须真投递——零投递/缺段/乱序都不得 clean', () => {
  const f = setup();
  const tf = taskFile(f);
  const pf = preflightFile(f);
  // 零投递:回执形状再正确也不采信。先用另一份"预演"投递拿到 key 形状,再清掉台账。
  const segCountPlan = JSON.parse(readFileSync(tf, 'utf8')).segments.length;
  const answerNoDelivery = compliant(tf); // DELIVERED 尚为空 → receipts 为空数组
  const none = run(f, answerNoDelivery, ['--mode', 'auto', '--task', tf, '--preflight', pf]);
  assert.equal(none.json.verdict, 'invalid');
  assert.match(none.json.deliveryReasons.join(';'), /没有任何分段投递记录/);
  assert.match(none.json.reasons.join(';'), /投递/);
  // 乱序投递被投递出口直接拒(不留记录)
  const segCount = segCountPlan;
  const outOfOrder = spawnSync('node', [DELIVER, '469', '--task', tf, '--base', f.base, '--head', f.head, '--order', String(segCount + 1)], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(outOfOrder.status, 2);
  assert.match(JSON.parse(outOfOrder.stdout).refused, /不在本轮分片里|顺序投递/);
  // 正常逐段投递 → clean;payload 里才有 key 清单(prompt.md 不再包含)
  const delivered = deliverAll(f, tf);
  const fj = delivered[0];
  assert.ok(fj.coverageKeys.length > 0, 'payload 必须给出本段 key 清单');
  assert.ok(!readFileSync(`${tf}.md`, 'utf8').includes('hunk:'), 'prompt.md 不得包含 key 清单(否则不投递也能补形状正确的回执)');
  assert.equal(readFileSync(tf, 'utf8').includes('assignedCoverageKeys'), false, 'task.json 也不得包含 key 明细(自己跑 builder 读文件同样绕不过投递)');
  assert.equal(run(f, compliant(tf), ['--mode', 'auto', '--task', tf, '--preflight', pf]).json.verdict, 'clean', '投齐后应 clean');
  // 回执声称一个没投递过的 order → invalid
  const forged = compliant(tf, { segmentReceipts: [{ segmentId: 'seg-99', receivedOrder: 9, coverageKeys: [] }] });
  assert.equal(run(f, forged, ['--mode', 'auto', '--task', tf, '--preflight', pf]).json.verdict, 'invalid');
});

test('⑳ R1a 第 3 轮核验 BLOCKER:非法 --mode / 坏 preflight / 坏 confirm / wrong-type 字段,一律撤销旧 clean 且记 retry', () => {
  const f = setup();
  const ok = round(f);
  assert.equal(ok.json.verdict, 'clean');
  const good = compliant(ok.taskPath);
  const base = ['--task', ok.taskPath, '--preflight', ok.preflightPath];

  const cases = [
    ['非法 --mode', () => run(f, good, ['--mode', 'bogus', ...base])],
    ['坏 preflight JSON', () => {
      const bad = join(f.work, `pf-broken-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(bad, '{broken');
      return run(f, good, ['--mode', 'auto', '--task', ok.taskPath, '--preflight', bad]);
    }],
    ['坏 confirm JSON', () => {
      const bad = join(f.work, `cf-broken-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(bad, '{broken');
      return run(f, good, ['--mode', 'interactive', ...base, '--confirm', bad]);
    }],
    ['confirm 不是数组', () => {
      const bad = join(f.work, `cf-obj-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(bad, '{"a":1}');
      return run(f, good, ['--mode', 'interactive', ...base, '--confirm', bad]);
    }],
    ['segmentReceipts 是对象(wrong-type)', () => run(f, { ...good, segmentReceipts: {} }, ['--mode', 'auto', ...base])],
    ['profileAnswers 是字符串(wrong-type)', () => run(f, { ...good, profileAnswers: 'nope' }, ['--mode', 'auto', ...base])],
  ];
  // 追加:目标仓 pr-rules.json 坏掉(生产可达)→ loadRules 抛 → 必须由最外层兜底撤销旧 clean
  cases.push(['目标仓 pr-rules.json 坏掉', () => {
    const brokenRules = join(f.work, `rules-broken-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(brokenRules, '{broken');
    return run(f, good, ['--mode', 'auto', ...base], { env: { REVIEW_PR_RULES_FILE: brokenRules } });
  }]);
  for (const [label, exec] of cases) {
    // 先把回执恢复成 clean,确保每个用例都是"旧 clean 存在"的起点
    assert.equal(round(f).json.verdict, 'clean', `${label}:前置恢复 clean 失败`);
    assert.equal(readReceipt(f).verdict, 'clean');
    const r = exec();
    assert.ok(['invalid', 'blocked'].includes(r.json.verdict), `${label}:应判 invalid,得到 ${r.json.verdict}`);
    assert.notEqual(r.r.status, 0, `${label}:不得以 0 退出`);
    assert.equal(readReceipt(f).verdict, 'dirty', `${label}:必须撤销同 snapshot 的旧 clean`);
    assert.ok(r.json.attempts >= 1, `${label}:必须记 retry(否则可以无限次试)`);
    if (label.includes('wrong-type')) {
      // 形状错必须走 schema 层给出**可定位**的原因,而不是掉进兜底 catch 报"未预期异常"
      assert.match(r.json.reasons.join(';'), /缺失或非数组|形状非法/, `${label}:应给 schema 级原因`);
      assert.doesNotMatch(r.json.reasons.join(';'), /未预期异常/, `${label}:不该掉进兜底 catch`);
    }
    if (label.includes('pr-rules.json 坏掉')) {
      assert.match(r.json.reasons.join(';'), /未预期异常/, '这条正是兜底 catch 的可达路径');
    }
  }
});

test('㉑ R4 第 3 轮核验 BLOCKER:真多段——下一段的 key 在上一段完成前不可见;缺段不得 clean', () => {
  const f = setup();
  // 让分片真的 >1 段:sizeBudget=1 + 两个改动文件
  const baseRules = JSON.parse(readFileSync(f.rulesFile, 'utf8'));
  writeFileSync(f.rulesFile, JSON.stringify({ ...baseRules, reviewSegments: { sizeBudget: 1 } }));
  writeFileSync(join(f.repo, 'src-b.mjs'), 'export const b = 1;\n');
  git(['add', '-A'], f.repo);
  git(['commit', '-q', '-m', 'two files'], f.repo);
  f.head = git(['rev-parse', 'HEAD'], f.repo);

  const tf = taskFile(f);
  const pf = preflightFile(f);
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  assert.ok(task.segments.length >= 2, `前提:必须真的拆成多段,got ${task.segments.length}`);
  assert.equal(task.coverageKeys, undefined);
  assert.ok(task.segments.every((s) => s.assignedCoverageKeys === undefined && s.commitment && s.keyCount >= 1),
    'task 只给每段的计数与内容承诺,不给 key');

  // 只投第 1 段:第 2 段的 key 在任何**已公开产物**里都查不到
  const one = spawnSync('node', [DELIVER, '469', '--task', tf, '--base', f.base, '--head', f.head, '--order', '1'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(one.status, 0, one.stdout + one.stderr);
  const seg1 = JSON.parse(one.stdout);
  assert.equal(seg1.remaining, task.segments.length - 1, '必须报出还剩几段(段间继续状态)');
  assert.equal(seg1.assignedCoverageKeys.length, 1);
  // 跳段:第 3 段(或超出)一律拒;第 2 段之前不得先投第 3 段
  const skip = spawnSync('node', [DELIVER, '469', '--task', tf, '--base', f.base, '--head', f.head, '--order', String(task.segments.length + 1)], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(skip.status, 2);

  // 只带第 1 段回执 → 缺段,不得 clean
  const partial = OUT({
    snapshotHash: task.snapshotHash,
    segmentReceipts: [{ segmentId: seg1.segmentId, receivedOrder: seg1.order, snapshotHash: task.snapshotHash, coverageKeys: seg1.assignedCoverageKeys }],
  });
  const missing = run(f, partial, ['--mode', 'auto', '--task', tf, '--preflight', pf]);
  assert.equal(missing.json.verdict, 'invalid');
  assert.match(missing.json.deliveryReasons.join(';'), /未投递/);

  // 投完剩余段 → clean;并确认第 2 段的 key 只出现在它自己的投递输出里
  const two = spawnSync('node', [DELIVER, '469', '--task', tf, '--base', f.base, '--head', f.head, '--order', '2'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(two.status, 0, two.stdout + two.stderr);
  const seg2 = JSON.parse(two.stdout);
  const seg2Key = seg2.assignedCoverageKeys.map((k) => (k.kind === 'hunk' ? `hunk:${k.fileId}:${k.hunkId}` : `file:${k.fileId}`))[0];
  assert.ok(seg2Key);
  assert.equal(readFileSync(tf, 'utf8').includes(seg2Key), false, 'task.json 里查不到第 2 段的 key');
  assert.equal(readFileSync(`${tf}.md`, 'utf8').includes(seg2Key), false, 'prompt.md 里查不到第 2 段的 key');
  assert.equal(one.stdout.includes(seg2Key), false, '第 1 段的投递输出里也查不到第 2 段的 key');

  const all = OUT({
    snapshotHash: task.snapshotHash,
    segmentReceipts: [seg1, seg2].map((s) => ({ segmentId: s.segmentId, receivedOrder: s.order, snapshotHash: task.snapshotHash, coverageKeys: s.assignedCoverageKeys })),
  });
  const done = run(f, all, ['--mode', 'auto', '--task', tf, '--preflight', pf]);
  assert.equal(done.json.verdict, 'clean', done.json.reasons?.join(';'));
  assert.equal(done.json.authoritative.deliveredSegments, task.segments.length);
});

test('㉒ R7 第 3 轮核验 BLOCKER:candidates / repo / known hazards 也必须独立重算——清空 task 的候选换不来 clean', () => {
  const f = setup();
  const body = '本 PR 修复 #469 逃过审查的假等待问题。\n';
  const tf = taskFile(f, { body });
  deliverAll(f, tf);
  const pf = preflightFile(f);
  const task = JSON.parse(readFileSync(tf, 'utf8'));
  assert.equal(task.escapeCandidates.length, 1, '前提:body 里带修复语义引用 → 1 条候选');
  const cid = task.escapeCandidates[0].candidateId;

  // 对照:逐条作答 no → clean
  const okAnswer = compliant(tf, { escapeAssessment: [{ candidateId: cid, verdict: 'no', basis: '只是引用' }] });
  assert.equal(run(f, okAnswer, ['--mode', 'auto', '--task', tf, '--preflight', pf]).json.verdict, 'clean');

  // 篡改:保留真 snapshotHash 与其余字段,只把候选清空 + 声明数据源完整,答卷给空 escapeAssessment
  const tampered = join(f.work, 'task-no-cand.json');
  writeFileSync(tampered, JSON.stringify({ ...task, escapeCandidates: [], escapeSourceIncomplete: false }));
  BODY_OF.set(tampered, BODY_OF.get(tf));
  const r = run(f, compliant(tf), ['--mode', 'auto', '--task', tampered, '--preflight', pf]);
  assert.equal(r.json.verdict, 'invalid', `修前实测 exit 0 + clean + 零 pending:${JSON.stringify(r.json).slice(0, 300)}`);
  assert.match(r.json.reasons.join(';'), /escapeCandidates 与现场重算不一致/);
  assert.deepEqual(r.json.registeredHazards, []);

  // 篡改 repo / hazardsIncomplete 同样被抓
  const badRepo = join(f.work, 'task-bad-repo.json');
  writeFileSync(badRepo, JSON.stringify({ ...task, repo: 'someone/else' }));
  BODY_OF.set(badRepo, BODY_OF.get(tf));
  assert.match(run(f, compliant(tf), ['--mode', 'auto', '--task', badRepo, '--preflight', pf]).json.reasons.join(';'), /task\.repo 与现场解析不符/);
  const badHz = join(f.work, 'task-bad-hz.json');
  writeFileSync(badHz, JSON.stringify({ ...task, hazardsIncomplete: true }));
  BODY_OF.set(badHz, BODY_OF.get(tf));
  assert.match(run(f, compliant(tf), ['--mode', 'auto', '--task', badHz, '--preflight', pf]).json.reasons.join(';'), /hazardsIncomplete/);
});
