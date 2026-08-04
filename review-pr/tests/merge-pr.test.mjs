// merge-pr.mjs(唯一合并出口)的行为测试(SC-C/SC4.1,2026-08-04 #469 复盘)。
// fake gh(tests/fixtures/fake-gh/gh)前置 PATH,子进程真实跑 CLI:
//   ① intent → gh pr merge(带 --match-head-commit)→ result 的顺序与字段;
//   ② merge 失败分支 result.ok=false 且 exit 2;
//   ③ 崩溃窗口(有 intent 无 result)由 --reconcile 只读核 PR 状态补齐;
//   ④ --dry-run 零 gh 写调用、零审计写入;
//   ⑤ 缺 --match-head / --basis / --strategy → 拒绝执行且不产生任何 gh 调用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'merge-pr.mjs');
const FAKE_GH_DIR = join(__dirname, 'fixtures', 'fake-gh');
const HEAD = 'e'.repeat(40);

function setup({ mergeOk = true } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'merge-pr-test-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git']);
  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const fixtures = join(work, 'fixtures');
  mkdirSync(fixtures);
  writeFileSync(join(fixtures, 'api-user.json'), JSON.stringify({ login: 'PraiseZhu' }));
  if (mergeOk) writeFileSync(join(fixtures, 'pr-merge.txt'), '✓ merged\n');
  const log = join(work, 'gh-calls.jsonl');
  chmodSync(join(FAKE_GH_DIR, 'gh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    FAKE_GH_FIXTURE_DIR: fixtures,
    FAKE_GH_LOG: log,
    REVIEW_PR_REPO_ROOT: repo,
    REVIEW_PR_STATE_DIR: stateDir,
  };
  return { work, repo, stateDir, fixtures, log, env };
}

const runMerge = (env, repo, extra = []) => spawnSync('node', [SCRIPT, '469', ...extra], { cwd: repo, env, encoding: 'utf8' });
const readAudit = (stateDir) => {
  // STATE_DIR = <root>/<repoStateKey>,merges.jsonl 在其下唯一子目录里
  const sub = readDirOnly(stateDir);
  const p = join(stateDir, sub, 'merges.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
import { readdirSync } from 'node:fs';
function readDirOnly(d) { const es = readdirSync(d); assert.equal(es.length, 1, `state root 应恰一个 repoStateKey 子目录,got ${es}`); return es[0]; }
const ghCalls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('① 成功路径:intent → merge(含 --match-head-commit)→ result,opId 一致', () => {
  const { repo, stateDir, log, env } = setup();
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'approved', '--admin', '--mode', 'auto']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const audit = readAudit(stateDir);
  assert.equal(audit.length, 2);
  assert.equal(audit[0].phase, 'intent');
  assert.equal(audit[1].phase, 'result');
  assert.equal(audit[0].opId, audit[1].opId);
  assert.equal(audit[0].basis, 'approved');
  assert.equal(audit[1].ok, true);
  const merges = ghCalls(log).filter((call) => call.args[0] === 'pr' && call.args[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.ok(merges[0].args.includes('--match-head-commit'), 'merge 必须带 --match-head-commit');
  assert.ok(merges[0].args.includes(HEAD));
  assert.ok(merges[0].args.includes('--admin'));
});

test('② merge 失败:result.ok=false + exit 2(intent/result 仍成对留痕)', () => {
  const { repo, stateDir, env } = setup({ mergeOk: false }); // 缺 pr-merge.txt fixture → fake gh exit 1
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'admin-trust', '--admin']);
  assert.equal(r.status, 2, r.stdout);
  const audit = readAudit(stateDir);
  assert.equal(audit.length, 2);
  assert.equal(audit[1].ok, false);
});

test('②b 顺序锁(复审修订):merge 被执行的那一刻,intent 必须已在审计文件里且 result 尚未写入——只看终态锁不住这条时序', () => {
  const { work, repo, stateDir, env } = setup();
  const snap = join(work, 'audit-at-merge.jsonl');
  const r = runMerge({ ...env, FAKE_GH_AUDIT_SNAPSHOT: snap }, repo,
    ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'approved']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const atMerge = readFileSync(snap, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(atMerge.length, 1, 'merge 时刻审计里应恰有一条记录(intent 已落盘,result 未写)');
  assert.equal(atMerge[0].phase, 'intent');
  assert.equal(readAudit(stateDir).length, 2, '终态仍是 intent+result 成对');
});

test('②c intent 写入失败 → 拒绝执行合并(exit 2)且零 gh 写调用(审计不可用时不合)', () => {
  const { repo, stateDir, log, env } = setup();
  // 先跑一次 dry-run 之外的方式拿到真实 STATE_DIR?不需要——把整个状态根做成只读,
  // lib 写探针失败会回退系统临时目录…那就锁不住了。改为:预创建 repoStateKey 目录下的
  // merges.jsonl 为**目录**,appendFileSync 必然 EISDIR 失败,且不影响 lib 的写探针。
  const r0 = runMerge(env, repo, ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'approved', '--dry-run']);
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  const keyDir = readdirSync(stateDir)[0];
  mkdirSync(join(stateDir, keyDir, 'merges.jsonl'), { recursive: true });
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'approved']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /intent 写入失败/);
  const merges = ghCalls(log).filter((c) => c.isWrite);
  assert.equal(merges.length, 0, 'intent 写不进去时不得执行任何 gh 写操作');
});

test('③ 崩溃窗口:孤儿 intent 由 --reconcile 按 PR 实际状态补 result(reconciled 标记)', () => {
  const { repo, stateDir, fixtures, env } = setup();
  // 手工造一条孤儿 intent(模拟 merge 成功后进程崩溃)
  const sub = join(stateDir, 'k');
  mkdirSync(sub, { recursive: true });
  // 直接跑一次 dry-run 让 STATE_DIR 结构由脚本自建?不——reconcile 场景直接铺文件:
  // STATE_DIR 由 lib 计算(<root>/<repoStateKey>),先跑一次成功合并拿到真实目录,再追加孤儿。
  const r0 = runMerge(env, repo, ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'approved']);
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  const keyDir = join(stateDir, readdirSync(stateDir).find((d) => existsSync(join(stateDir, d, 'merges.jsonl'))));
  appendOrphan(join(keyDir, 'merges.jsonl'));
  writeFileSync(join(fixtures, 'pr-view.json'), JSON.stringify({ state: 'MERGED', mergedAt: '2026-08-04T11:07:59Z' }));
  const r = spawnSync('node', [SCRIPT, '--reconcile'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const audit = readFileSync(join(keyDir, 'merges.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rec = audit.filter((a) => a.opId === 'orphan-op');
  assert.equal(rec.length, 2, '孤儿 intent 应被补上 result');
  assert.equal(rec[1].phase, 'result');
  assert.equal(rec[1].reconciled, true);
  assert.equal(rec[1].ok, true);
});
function appendOrphan(p) {
  const line = JSON.stringify({ phase: 'intent', opId: 'orphan-op', pr: 469, slug: 'xindong/mivo-canvas', ts: '2026-08-04T11:07:00Z', strategy: 'squash', matchHead: HEAD, basis: 'approved' });
  writeFileSync(p, readFileSync(p, 'utf8') + line + '\n');
}

test('④ --dry-run:零 gh 写调用、零审计记录,输出 wouldRun', () => {
  const { repo, stateDir, log, env } = setup();
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'approved', '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /dry-run/);
  assert.match(r.stdout, /wouldRun/);
  const writes = ghCalls(log).filter((call) => call.isWrite);
  assert.equal(writes.length, 0, 'dry-run 不得有任何 gh 写调用');
  assert.equal(readdirSync(stateDir).filter((d) => existsSync(join(stateDir, d, 'merges.jsonl'))).length, 0, 'dry-run 不写审计');
});

test('⑤ 缺必填参数 → 拒绝执行(exit 2)且零 gh 调用;不认短 SHA;不认已删 basis;admin basis 必须带 --admin', () => {
  for (const extra of [
    ['--match-head', HEAD, '--basis', 'approved'],                       // 缺 strategy
    ['--strategy', 'squash', '--basis', 'approved'],                      // 缺 match-head
    ['--strategy', 'squash', '--match-head', 'e9b68b7a', '--basis', 'approved'], // 短 SHA
    ['--strategy', 'squash', '--match-head', HEAD],                       // 缺 basis
    // 复审修订:5.5/5.6 是本地 merge+push,不经本 wrapper——不可达 basis 一律拒收
    ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'conflict-merged'],
    ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'merge-then-fix'],
    // 复审修订:admin 路径不带 --admin = 审计 basis 与真实命令不一致,拒收
    ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'admin-trust'],
    ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'authorized-fast-merge'],
    ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'self-merge'],
  ]) {
    const { repo, log, env } = setup();
    const r = runMerge(env, repo, extra);
    assert.equal(r.status, 2, `${extra.join(' ')} → ${r.stdout}`);
    assert.equal(ghCalls(log).length, 0, '拒绝执行前不得有任何 gh 调用');
  }
});

test('⑥ viewer 身份查不到 → 拒绝执行(审计"谁在合"不允许为空,#469 教训)且零写调用、零审计', () => {
  const { repo, stateDir, log, env, fixtures } = setup();
  rmSync(join(fixtures, 'api-user.json')); // gh api user → fake gh exit 1
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'approved']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /身份/);
  assert.equal(ghCalls(log).filter((c) => c.isWrite).length, 0);
  assert.equal(readdirSync(stateDir).filter((d) => existsSync(join(stateDir, d, 'merges.jsonl'))).length, 0, '身份不明时连 intent 都不写');
});

test('⑦ reconcile:PR state 未知/响应空对象 → 保持 orphan 不封口(下轮重试);OPEN/CLOSED 正常补 ok:false', () => {
  const { repo, stateDir, fixtures, env } = setup();
  const r0 = runMerge(env, repo, ['--strategy', 'squash', '--match-head', HEAD, '--basis', 'approved']);
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  const keyDir = join(stateDir, readdirSync(stateDir).find((d) => existsSync(join(stateDir, d, 'merges.jsonl'))));
  const auditPath = join(keyDir, 'merges.jsonl');
  const orphan = (id) => JSON.stringify({ phase: 'intent', opId: id, pr: 469, slug: 'xindong/mivo-canvas', ts: '2026-08-04T11:07:00Z', strategy: 'squash', matchHead: HEAD, basis: 'approved' });
  writeFileSync(auditPath, readFileSync(auditPath, 'utf8') + orphan('op-unknown') + '\n');
  // 响应"成功但形状未知":空对象——旧实现会写 ok:false 把 orphan 永久封口
  writeFileSync(join(fixtures, 'pr-view.json'), JSON.stringify({}));
  const r1 = spawnSync('node', [SCRIPT, '--reconcile'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  let audit = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(audit.filter((a) => a.opId === 'op-unknown' && a.phase === 'result').length, 0, '未知 state 不得写 result 封口,必须留待下轮');
  // 换成已知 state=CLOSED → 正常补 ok:false
  writeFileSync(join(fixtures, 'pr-view.json'), JSON.stringify({ state: 'CLOSED', mergedAt: null }));
  const r2 = spawnSync('node', [SCRIPT, '--reconcile'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  audit = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rec = audit.filter((a) => a.opId === 'op-unknown' && a.phase === 'result');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].ok, false);
  assert.equal(rec[0].prState, 'CLOSED');
  assert.equal(rec[0].reconciled, true);
});
