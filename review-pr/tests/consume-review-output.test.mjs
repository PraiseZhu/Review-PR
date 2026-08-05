// SC-R1b 行为矩阵:consume-review-output.mjs 子进程实跑(真 temp git 出真 snapshot,
// 真 STATE_DIR),断到 receipt 终态——clean 唯一写者、撤销语义、retry/blocked、
// disposition 门、交互通道纪律、public CLI 禁 clean。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONSUME = join(__dirname, '..', 'scripts', 'consume-review-output.mjs');
const RECEIPT_CLI = join(__dirname, '..', 'scripts', 'write-review-receipt.mjs');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function setup() {
  const work = mkdtempSync(join(tmpdir(), 'consume-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], repo);
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  const base = git(['rev-parse', 'HEAD'], repo);
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 2;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'head'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);
  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const env = { ...process.env, REVIEW_PR_REPO_ROOT: repo, REVIEW_PR_STATE_DIR: stateDir };
  return { work, repo, base, head, stateDir, env };
}

const OUT = (over = {}) => ({
  schemaVersion: 'rro-1', findingFamilies: [], verificationGaps: [], verificationRuns: [],
  profileAnswers: [], findingDispositions: [], negativeEvidence: [], escapeAssessment: [],
  modelVerdictNote: '', ...over,
});
const FAM = (line = 10, sev = 'P1') => ({
  family_id: 'f1', invariant: '等待谓词必须真的等待', severity: sev,
  manifestations: [{ path: 'a.mjs', line, evidence: 'e', impact: 'i', fix: 'f', verification: 'v', severity: sev }],
  fixGuidance: 'g',
});

function run(f, output, extra = [], { preflightOk = true } = {}) {
  const outFile = join(f.work, `out-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(outFile, typeof output === 'string' ? output : JSON.stringify(output));
  const args = [CONSUME, '469', '--output', outFile, '--base', f.base, '--head', f.head, ...extra];
  if (preflightOk && !extra.includes('--preflight')) {
    // preflight 结果文件:complete 且绑定当前 snapshot(先探一次拿 snapshotHash)
    const probe = spawnSync('node', [join(__dirname, '..', 'scripts', 'lib.diff-snapshot.mjs')], { encoding: 'utf8' });
    void probe; // snapshotHash 由第一次 run 输出;这里直接构造:跑一次 dry 获取
  }
  const r = spawnSync('node', args, { cwd: f.repo, env: f.env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(json, `应输出 JSON: status=${r.status}\n${r.stdout.slice(0, 600)}\n${r.stderr.slice(0, 600)}`);
  return { r, json };
}

/** 生成绑定当前 snapshot 的 preflight 文件(先空跑一次拿 snapshotHash)。 */
function preflightFile(f, hits = []) {
  const { json } = run(f, OUT(), ['--mode', 'auto']);
  const pf = join(f.work, 'pf.json');
  writeFileSync(pf, JSON.stringify({ complete: true, snapshotHash: json.snapshotHash, hits }));
  return pf;
}

const readReceipt = (f) => {
  const files = readdirSync(f.stateDir, { recursive: true }).filter((p) => String(p).includes('review-receipt'));
  assert.equal(files.length, 1, `应恰一个回执文件,got ${files}`);
  return JSON.parse(readFileSync(join(f.stateDir, String(files[0])), 'utf8'));
};

test('① 无 preflight 文件 → preflightIncomplete → invalid(fail-closed);带 complete preflight → clean,回执五项绑定', () => {
  const f = setup();
  const { r, json } = run(f, OUT(), ['--mode', 'auto']);
  assert.equal(json.verdict, 'invalid');
  assert.match(json.reasons.join(';'), /preflight/);
  assert.equal(r.status, 2);
  const pf = preflightFile(f);
  const ok2 = run(f, OUT(), ['--mode', 'auto', '--preflight', pf]);
  assert.equal(ok2.json.verdict, 'clean', ok2.json.reasons?.join(';'));
  assert.equal(ok2.r.status, 0);
  const receipt = readReceipt(f);
  assert.equal(receipt.verdict, 'clean');
  for (const k of ['source', 'schemaVersion', 'outputHash', 'snapshotHash', 'ledgerHash']) assert.ok(receipt[k], `回执缺 ${k}`);
  assert.equal(receipt.snapshotHash, ok2.json.snapshotHash);
  assert.equal(receipt.ledgerHash, ok2.json.ledgerHash);
});

test('② findings → dirty 且撤销同 snapshot 旧 clean(last-write-wins);模型 note 写 APPROVED 不采信', () => {
  const f = setup();
  const pf = preflightFile(f);
  assert.equal(run(f, OUT(), ['--mode', 'auto', '--preflight', pf]).json.verdict, 'clean');
  const d = run(f, OUT({ findingFamilies: [FAM()], modelVerdictNote: 'APPROVED' }), ['--mode', 'auto', '--preflight', pf]);
  assert.equal(d.json.verdict, 'dirty');
  const receipt = readReceipt(f);
  assert.equal(receipt.verdict, 'dirty', '同 snapshot 旧 clean 必须被 non-clean 覆盖撤销');
});

test('③ retry:同 snapshot 连续 3 次非法 → blocked;非法轮不动 ledger', () => {
  const f = setup();
  const pf = preflightFile(f);
  run(f, OUT(), ['--mode', 'auto', '--preflight', pf]); // clean 轮:归零 attempts(helper 轮曾 +1)
  let last;
  for (let i = 1; i <= 3; i += 1) last = run(f, '{broken json', ['--mode', 'auto', '--preflight', pf]);
  assert.equal(last.json.verdict, 'invalid');
  assert.equal(last.json.attempts, 3);
  assert.equal(last.json.blocked, true, '初次+2 次重试打满 → blocked');
  assert.equal(last.json.effectiveOpenCount, 0, '非法输出不产生台账条目');
});

test('④ 核销门:席位 A 留 open → 席位 B 零 disposition 报 clean → missingDispositions → invalid;逐条 resolved(证据)后 → 但同 snapshot 禁自证', () => {
  const f = setup();
  const pf = preflightFile(f);
  const a = run(f, OUT({ findingFamilies: [FAM()] }), ['--mode', 'auto', '--preflight', pf]);
  assert.equal(a.json.verdict, 'dirty');
  assert.equal(a.json.effectiveOpenCount, 1);
  // 席位 B:空输出(相当于"我没看见问题")→ 注入 open 未 disposition → invalid
  const b = run(f, OUT(), ['--mode', 'auto', '--preflight', pf]);
  assert.equal(b.json.verdict, 'invalid');
  assert.match(b.json.reasons.join(';'), /disposition/);
  // 席位 B:resolved 但仍是 origin snapshot → ledger 验真失败 → invalid(代码没变,问题不会自己消失)
  const ids = b.json.injectedOpenIds;
  assert.equal(ids.length, 1);
  const c = run(f, OUT({ findingDispositions: [{ findingId: ids[0], disposition: 'resolved', evidence: 'x' }] }), ['--mode', 'auto', '--preflight', pf]);
  assert.equal(c.json.verdict, 'invalid');
  assert.match(c.json.reasons.join(';'), /禁自证/);
});

test('⑤ head 推进后 resolved+证据 → clean;open 继承跨 snapshot', () => {
  const f = setup();
  const pf = preflightFile(f);
  run(f, OUT({ findingFamilies: [FAM()] }), ['--mode', 'auto', '--preflight', pf]);
  const probe = run(f, OUT(), ['--mode', 'auto', '--preflight', pf]); // 下一轮开审前清单里才有 id
  const id = probe.json.injectedOpenIds[0] ?? (() => { throw new Error('no id'); })();
  // 推新 head(修复提交)
  writeFileSync(join(f.repo, 'a.mjs'), 'export const a = 3;\n');
  git(['add', '.'], f.repo);
  git(['commit', '-q', '-m', 'fix'], f.repo);
  f.head = git(['rev-parse', 'HEAD'], f.repo);
  const pf2 = preflightFile(f); // 新 snapshot 的 preflight
  const noDisp = run(f, OUT(), ['--mode', 'auto', '--preflight', pf2]);
  assert.equal(noDisp.json.verdict, 'invalid', 'open 必须继承到新 snapshot,仍要求 disposition');
  const done = run(f, OUT({ findingDispositions: [{ findingId: id, disposition: 'resolved', evidence: 'a.mjs 重写,见新 diff' }] }), ['--mode', 'auto', '--preflight', pf2]);
  assert.equal(done.json.verdict, 'clean', done.json.reasons?.join(';'));
});

test('⑥ accepted-risk:auto 模式 confirm → invalid;交互模式 → dirty(恒非 clean,不产 clean 回执)', () => {
  const f = setup();
  const pf = preflightFile(f);
  run(f, OUT({ findingFamilies: [FAM()] }), ['--mode', 'interactive', '--preflight', pf]);
  const id = run(f, OUT(), ['--mode', 'interactive', '--preflight', pf]).json.injectedOpenIds[0];
  assert.ok(id, 'probe 轮应注入 open id');
  const confirm = join(f.work, 'confirm.json');
  writeFileSync(confirm, JSON.stringify([{ findingId: id, action: 'accept-risk', reason: '已知风险,owner 拍板' }]));
  const autoTry = run(f, OUT({ findingDispositions: [] }), ['--mode', 'auto', '--preflight', pf, '--confirm', confirm]);
  assert.equal(autoTry.json.verdict, 'invalid', 'auto 无 accepted-risk 出口');
  const inter = run(f, OUT(), ['--mode', 'interactive', '--preflight', pf, '--confirm', confirm]);
  assert.equal(inter.json.verdict, 'dirty', 'accepted-risk 恒非 clean');
  assert.equal(inter.json.acceptedRiskCount, 1);
  assert.equal(readReceipt(f).verdict, 'dirty');
});

test('⑦ P0 finding 的 accepted-risk → 交互模式也拒(硬门不可豁免)', () => {
  const f = setup();
  const pf = preflightFile(f);
  run(f, OUT({ findingFamilies: [FAM(10, 'P0')] }), ['--mode', 'interactive', '--preflight', pf]);
  const id = run(f, OUT(), ['--mode', 'interactive', '--preflight', pf]).json.injectedOpenIds[0];
  assert.ok(id, 'probe 轮应注入 open id');
  const confirm = join(f.work, 'confirm.json');
  writeFileSync(confirm, JSON.stringify([{ findingId: id, action: 'accept-risk', reason: 'r' }]));
  const r = run(f, OUT(), ['--mode', 'interactive', '--preflight', pf, '--confirm', confirm]);
  assert.equal(r.json.verdict, 'invalid');
  assert.match(r.json.reasons.join(';'), /P0\/安全/);
});

test('⑧ public CLI 禁 clean;dirty 照常', () => {
  const f = setup();
  const deny = spawnSync('node', [RECEIPT_CLI, '469', '--verdict', 'clean', '--p0p1-count', '0', '--head', f.head], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.notEqual(deny.status, 0);
  assert.match(deny.stderr + deny.stdout, /clean/);
  const okDirty = spawnSync('node', [RECEIPT_CLI, '469', '--verdict', 'dirty', '--p0p1-count', '1', '--head', f.head], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(okDirty.status, 0, okDirty.stderr);
});

test('⑨ 台账损坏 → blocked,不写回执(fail-closed)', () => {
  const f = setup();
  const pf = preflightFile(f);
  // 先产生一次台账位置,再破坏
  run(f, OUT(), ['--mode', 'auto', '--preflight', pf]);
  const files = readdirSync(f.stateDir, { recursive: true }).filter((p) => String(p).includes('findings-469'));
  assert.equal(files.length, 1);
  writeFileSync(join(f.stateDir, String(files[0])), '{broken');
  const r = run(f, OUT(), ['--mode', 'auto', '--preflight', pf]);
  assert.equal(r.json.verdict, 'blocked');
  assert.equal(r.r.status, 2);
});
