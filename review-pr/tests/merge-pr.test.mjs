// merge-pr.mjs(唯一合并出口)的行为测试(SC-C/SC4.1,2026-08-04 #469 复盘)。
// fake gh(tests/fixtures/fake-gh/gh)前置 PATH,子进程真实跑 CLI:
//   ① intent → gh pr merge(带 --match-head-commit)→ result 的顺序与字段;
//   ② merge 失败分支 result.ok=false 且 exit 2;
//   ③ 崩溃窗口(有 intent 无 result)由 --reconcile 只读核 PR 状态补齐;
//   ④ --dry-run 零 gh 写调用、零审计写入;
//   ⑤ 缺 --match-head / --basis / --strategy → 拒绝执行且不产生任何 gh 调用。
//
// wave0 delta(2026-08-08,裁决 4):merge-pr 强制现场 precheck 后,fixture 必须补完整
// pr-view/graphql/rules/receipt/ledger,而不是绕过 precheck——setup 建真 git 仓(真实
// base/head oid,DiffSnapshot 可建)、铺全 pre-merge-check.mjs 消费的 fixture 面、用与
// 生产同款的 writeReviewReceipt + 现场重算绑定值落完整回执。`--match-head` 一律用
// setup 返回的真实 head(判定 head 与回执 head 绑定同一 oid)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiffSnapshot } from '../scripts/lib.diff-snapshot.mjs';
import { computeLedgerHash } from '../scripts/lib.findings-ledger.mjs';
import { escapeSourceHash, knownHazardsHash, loadKnownHazards, hazardsForPaths } from '../scripts/lib.escaped-hazards.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'merge-pr.mjs');
const FAKE_GH_DIR = join(__dirname, 'fixtures', 'fake-gh');
// 回执哨兵:receiptHead='CURRENT' → 绑定本次 setup 建出的真实 head(判定 head 与回执同源)
const OLD_HEAD = 'a'.repeat(40); // 与真实 head 不同的旧 oid(⑪b:回执绑定旧 head)

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function setup({ mergeOk = true, receiptHead = null, commentNodes = null } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'merge-pr-test-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  // 真实 git 仓:base + head 两个 commit,让 precheck 的 DiffSnapshot 可建(裁决 4:
  // 旧 fixture 没有 commit,现场复核的 securityGate/receiptGate 会 fail-closed)。
  git(['init', '-q', '-b', 'main'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], repo);
  writeFileSync(join(repo, 'a.txt'), 'export const a = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  const BASE = git(['rev-parse', 'HEAD'], repo);
  writeFileSync(join(repo, 'a.txt'), 'export const a = 2;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'head'], repo);
  const HEAD = git(['rev-parse', 'HEAD'], repo);
  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const fixtures = join(work, 'fixtures');
  mkdirSync(fixtures);
  writeFileSync(join(fixtures, 'api-user.json'), JSON.stringify({ login: 'PraiseZhu' }));
  const rulesFile = join(work, 'pr-rules.json');
  writeFileSync(rulesFile, JSON.stringify({
    admins: ['PraiseZhu'],
    structuralBypassAllowlist: ['code_scanning', 'code_quality'],
    mergeAuthorization: { breakGlassApprovers: ['PraiseZhu'] },
  }));
  if (mergeOk) writeFileSync(join(fixtures, 'pr-merge.txt'), '✓ merged\n');
  // ── 完整 pr-view / graphql / rules fixture(pre-merge-check.mjs 现场复核消费)──
  // pr-view:mergeStateStatus=CLEAN(普通合并机械前提零 blocker)+ APPROVED@head +
  // 真实 base/head oid + files,让 standardMergeAvailable 可达。
  writeFileSync(join(fixtures, 'pr-view.json'), JSON.stringify({
    title: 'feat(canvas): 局部重绘交互升级', body: '正文', state: 'OPEN',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
    isDraft: false, headRefOid: HEAD, baseRefName: 'main', baseRefOid: BASE,
    files: [{ path: 'a.txt' }],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint + tsc + unit + logging', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'e2e kernel gate (new)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  }));
  // graphql-threads:author(viewer 之外的独立 APPROVED@head,支撑 basis=approved 的
  // 机械前提)+ break-glass 授权评论(commentNodes,authorized-fast-merge 场景;
  // 传函数 (head) => nodes 可在建仓拿到真实 head 后再构造评论正文)。
  writeFileSync(join(fixtures, 'graphql-threads.json'), JSON.stringify({
    data: {
      viewer: { login: 'PraiseZhu' },
      repository: { pullRequest: {
        author: { login: 'aj0928' },
        reviewThreads: { nodes: [] },
        comments: { nodes: typeof commentNodes === 'function' ? commentNodes(HEAD) : (commentNodes ?? []) },
        latestOpinionatedReviews: {
          pageInfo: { hasNextPage: false },
          nodes: [{ author: { login: 'kirozeng', __typename: 'User' }, state: 'APPROVED', commit: { oid: HEAD } }],
        },
      } },
    },
  }));
  writeFileSync(join(fixtures, 'actions-runs.json'), JSON.stringify({ workflow_runs: [] }));
  writeFileSync(join(fixtures, 'rules-branches.raw'),
    'HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n' +
    JSON.stringify([{ type: 'code_scanning', ruleset_id: 17823743 }, { type: 'code_quality', ruleset_id: 17823743 }]));
  writeFileSync(join(fixtures, 'ruleset.json'), JSON.stringify({ current_user_can_bypass: 'always' }));
  writeFileSync(join(fixtures, 'graphql-rollup.json'), JSON.stringify({
    data: { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: {
      nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
    } } } }] } } } },
  }));
  const log = join(work, 'gh-calls.jsonl');
  chmodSync(join(FAKE_GH_DIR, 'gh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    FAKE_GH_FIXTURE_DIR: fixtures,
    FAKE_GH_LOG: log,
    REVIEW_PR_REPO_ROOT: repo,
    REVIEW_PR_STATE_DIR: stateDir,
    REVIEW_PR_RULES_FILE: rulesFile,
  };
  // ── current-head clean 回执(裁决 4):简化回执(无七项绑定)会被 precheck 的
  // isReviewReceiptClean fail-closed 判 stale——用与生产同款的 writeReviewReceipt +
  // 现场重算绑定值(snapshot/ledger/逃逸数据源/canonical hazards)落完整回执。──
  if (receiptHead !== null) {
    const receiptFor = receiptHead === 'CURRENT' ? HEAD : receiptHead;
    // STATE_DIR = <stateRoot>/<repoStateKey>;repoStateKey = sha256(stateAnchor)[:20],
    // stateAnchor = realpath(git-common-dir) = repo/.git(与 lib.mjs 同款计算)
    const key = createHash('sha256').update(realpathSync(join(repo, '.git'))).digest('hex').slice(0, 20);
    const sub = join(stateDir, key);
    mkdirSync(sub, { recursive: true });
    const snap = buildDiffSnapshot({ repoRoot: repo, baseRefOid: BASE, headOid: HEAD, expectedPaths: ['a.txt'] });
    assert.equal(snap.complete, true, snap.reason);
    const code = `import { writeReviewReceipt } from ${JSON.stringify(new URL('../scripts/lib.mjs', import.meta.url).href)};
writeReviewReceipt(JSON.parse(process.env.RECEIPT_JSON));`;
    const receiptJson = JSON.stringify({
      pr: 469, headRefOid: receiptFor, verdict: 'clean', p0p1Count: 0,
      bindings: {
        source: 'consume-review-output', schemaVersion: 'rro-1', outputHash: 'oh1-x',
        snapshotHash: snap.snapshotHash,
        ledgerHash: computeLedgerHash([]),
        escapeSourceHash: escapeSourceHash({ prBody: '正文', issueTexts: [], candidates: [] }),
        knownHazardsHash: knownHazardsHash(hazardsForPaths(loadKnownHazards(), ['a.txt'], 'xindong/mivo-canvas')),
      },
    });
    const w = spawnSync('node', ['--input-type=module', '-e', code], {
      cwd: repo, env: { ...env, RECEIPT_JSON: receiptJson }, encoding: 'utf8',
    });
    assert.equal(w.status, 0, w.stderr);
  }
  return { work, repo, stateDir, fixtures, log, env, head: HEAD, base: BASE };
}

const runMerge = (env, repo, extra = []) => spawnSync('node', [SCRIPT, '469', ...extra], { cwd: repo, env, encoding: 'utf8' });
const readAudit = (stateDir) => {
  // STATE_DIR = <root>/<repoStateKey>,merges.jsonl 在其下唯一子目录里
  const sub = readDirOnly(stateDir);
  const p = join(stateDir, sub, 'merges.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
function readDirOnly(d) { const es = readdirSync(d); assert.equal(es.length, 1, `state root 应恰一个 repoStateKey 子目录,got ${es}`); return es[0]; }
const ghCalls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** break-glass 有效评论(GraphQL 形状,人工 + 当前 head SHA)——precheck 经
 * graphql-threads.json 的 comments.nodes 读取,不再是 REST issue.json。 */
const glassCommentNode = (head) => ({
  author: { login: 'PraiseZhu', __typename: 'User' },
  body: `/approve-merge ${head}`,
  createdAt: '2026-08-08T00:00:00Z', updatedAt: '2026-08-08T00:00:00Z', url: 'c1',
});

test('① 成功路径:intent → merge(含 --match-head-commit)→ result,opId 一致', () => {
  const { repo, stateDir, log, env, head } = setup({ receiptHead: 'CURRENT' });
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--admin', '--mode', 'auto']);
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
  assert.ok(merges[0].args.includes(head));
  assert.ok(merges[0].args.includes('--admin'));
});

test('② merge 失败:result.ok=false + exit 2(intent/result 仍成对留痕)', () => {
  // basis=approved(CLEAN fixture 下 standardMergeAvailable 放行 precheck)→ merge 真被
  // 尝试;缺 pr-merge.txt fixture → fake gh exit 1 → result.ok=false + exit 2,审计成对。
  const { repo, stateDir, env, head } = setup({ mergeOk: false, receiptHead: 'CURRENT' });
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--admin']);
  assert.equal(r.status, 2, r.stdout);
  const audit = readAudit(stateDir);
  assert.equal(audit.length, 2);
  assert.equal(audit[1].ok, false);
});

test('②b 顺序锁(复审修订):merge 被执行的那一刻,intent 必须已在审计文件里且 result 尚未写入——只看终态锁不住这条时序', () => {
  const { work, repo, stateDir, env, head } = setup({ receiptHead: 'CURRENT' });
  const snap = join(work, 'audit-at-merge.jsonl');
  const r = runMerge({ ...env, FAKE_GH_AUDIT_SNAPSHOT: snap }, repo,
    ['--strategy', 'squash', '--match-head', head, '--basis', 'approved']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const atMerge = readFileSync(snap, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(atMerge.length, 1, 'merge 时刻审计里应恰有一条记录(intent 已落盘,result 未写)');
  assert.equal(atMerge[0].phase, 'intent');
  assert.equal(readAudit(stateDir).length, 2, '终态仍是 intent+result 成对');
});

test('②c intent 写入失败 → 拒绝执行合并(exit 2)且零 gh 写调用(审计不可用时不合)', () => {
  const { repo, stateDir, log, env, head } = setup({ receiptHead: 'CURRENT' });
  // 先跑一次 dry-run 之外的方式拿到真实 STATE_DIR?不需要——把整个状态根做成只读,
  // lib 写探针失败会回退系统临时目录…那就锁不住了。改为:预创建 repoStateKey 目录下的
  // merges.jsonl 为**目录**,appendFileSync 必然 EISDIR 失败,且不影响 lib 的写探针。
  const r0 = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--dry-run']);
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  const keyDir = readdirSync(stateDir)[0];
  mkdirSync(join(stateDir, keyDir, 'merges.jsonl'), { recursive: true });
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /intent 写入失败/);
  const merges = ghCalls(log).filter((c) => c.isWrite);
  assert.equal(merges.length, 0, 'intent 写不进去时不得执行任何 gh 写操作');
});

test('③ 崩溃窗口:孤儿 intent 由 --reconcile 按 PR 实际状态补 result(reconciled 标记)', () => {
  const { repo, stateDir, fixtures, env, head } = setup({ receiptHead: 'CURRENT' });
  // 手工造一条孤儿 intent(模拟 merge 成功后进程崩溃)
  const sub = join(stateDir, 'k');
  mkdirSync(sub, { recursive: true });
  // 直接跑一次 dry-run 让 STATE_DIR 结构由脚本自建?不——reconcile 场景直接铺文件:
  // STATE_DIR 由 lib 计算(<root>/<repoStateKey>),先跑一次成功合并拿到真实目录,再追加孤儿。
  const r0 = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved']);
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  const keyDir = join(stateDir, readdirSync(stateDir).find((d) => existsSync(join(stateDir, d, 'merges.jsonl'))));
  appendOrphan(join(keyDir, 'merges.jsonl'), head);
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
function appendOrphan(p, head) {
  const line = JSON.stringify({ phase: 'intent', opId: 'orphan-op', pr: 469, slug: 'xindong/mivo-canvas', ts: '2026-08-04T11:07:00Z', strategy: 'squash', matchHead: head, basis: 'approved' });
  writeFileSync(p, readFileSync(p, 'utf8') + line + '\n');
}

test('④ --dry-run:零 gh 写调用、零审计记录,输出 wouldRun', () => {
  const { repo, stateDir, log, env, head } = setup({ receiptHead: 'CURRENT' });
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /dry-run/);
  assert.match(r.stdout, /wouldRun/);
  const writes = ghCalls(log).filter((call) => call.isWrite);
  assert.equal(writes.length, 0, 'dry-run 不得有任何 gh 写调用');
  assert.equal(readdirSync(stateDir).filter((d) => existsSync(join(stateDir, d, 'merges.jsonl'))).length, 0, 'dry-run 不写审计');
});

test('⑤ 缺必填参数 → 拒绝执行(exit 2)且零 gh 调用;不认短 SHA;不认已删 basis;admin basis 必须带 --admin', () => {
  for (const extra of [
    ['--match-head', OLD_HEAD, '--basis', 'approved'],                       // 缺 strategy
    ['--strategy', 'squash', '--basis', 'approved'],                          // 缺 match-head
    ['--strategy', 'squash', '--match-head', 'e9b68b7a', '--basis', 'approved'], // 短 SHA
    ['--strategy', 'squash', '--match-head', OLD_HEAD],                        // 缺 basis
    // 复审修订:5.5/5.6 是本地 merge+push,不经本 wrapper——不可达 basis 一律拒收
    ['--strategy', 'squash', '--match-head', OLD_HEAD, '--basis', 'conflict-merged'],
    ['--strategy', 'squash', '--match-head', OLD_HEAD, '--basis', 'merge-then-fix'],
    // 复审修订:admin 路径不带 --admin = 审计 basis 与真实命令不一致,拒收
    ['--strategy', 'squash', '--match-head', OLD_HEAD, '--basis', 'admin-trust'],
    ['--strategy', 'squash', '--match-head', OLD_HEAD, '--basis', 'authorized-fast-merge'],
    ['--strategy', 'squash', '--match-head', OLD_HEAD, '--basis', 'self-merge'],
  ]) {
    const { repo, log, env } = setup({ receiptHead: 'CURRENT' });
    const r = runMerge(env, repo, extra);
    assert.equal(r.status, 2, `${extra.join(' ')} → ${r.stdout}`);
    assert.equal(ghCalls(log).length, 0, '拒绝执行前不得有任何 gh 调用');
  }
});

test('⑥ viewer 身份查不到 → 拒绝执行(审计"谁在合"不允许为空,#469 教训)且零写调用、零审计', () => {
  const { repo, stateDir, log, env, fixtures, head } = setup({ receiptHead: 'CURRENT' });
  rmSync(join(fixtures, 'api-user.json')); // gh api user → fake gh exit 1
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /身份/);
  assert.equal(ghCalls(log).filter((c) => c.isWrite).length, 0);
  assert.equal(readdirSync(stateDir).filter((d) => existsSync(join(stateDir, d, 'merges.jsonl'))).length, 0, '身份不明时连 intent 都不写');
});

test('⑦ reconcile:PR state 未知/响应空对象 → 保持 orphan 不封口(下轮重试);OPEN/CLOSED 正常补 ok:false', () => {
  const { repo, stateDir, fixtures, env, head } = setup({ receiptHead: 'CURRENT' });
  const r0 = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved']);
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  const keyDir = join(stateDir, readdirSync(stateDir).find((d) => existsSync(join(stateDir, d, 'merges.jsonl'))));
  const auditPath = join(keyDir, 'merges.jsonl');
  const orphan = (id) => JSON.stringify({ phase: 'intent', opId: id, pr: 469, slug: 'xindong/mivo-canvas', ts: '2026-08-04T11:07:00Z', strategy: 'squash', matchHead: head, basis: 'approved' });
  writeFileSync(auditPath, readFileSync(auditPath, 'utf8') + orphan('op-unknown') + '\n');
  // 响应"成功但形状未知":空对象——旧实现会写 ok:false 把 orphan 永久封口
  writeFileSync(join(fixtures, 'pr-view.json'), JSON.stringify({}));
  const r1 = spawnSync('node', [SCRIPT, '--reconcile'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  let audit = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(audit.filter((a) => a.opId === 'op-unknown' && a.phase === 'result').length, 0, '未知 state 不得写 result 封口,必须留待下轮');
  // 换成已知 state=OPEN → 正常补 ok:false(merge 没发生,留痕后不再当孤儿)
  writeFileSync(join(fixtures, 'pr-view.json'), JSON.stringify({ state: 'OPEN', mergedAt: null }));
  const r2 = spawnSync('node', [SCRIPT, '--reconcile'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  audit = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rec = audit.filter((a) => a.opId === 'op-unknown' && a.phase === 'result');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].ok, false);
  assert.equal(rec[0].prState, 'OPEN');
  assert.equal(rec[0].reconciled, true);
  // 再补一条 CLOSED 孤儿:三态白名单的另一枝也要有独立断言(复审 P2:标题承诺过就必须锁)
  writeFileSync(auditPath, readFileSync(auditPath, 'utf8') + orphan('op-closed') + '\n');
  writeFileSync(join(fixtures, 'pr-view.json'), JSON.stringify({ state: 'CLOSED', mergedAt: null }));
  const r3 = spawnSync('node', [SCRIPT, '--reconcile'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  audit = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const recClosed = audit.filter((a) => a.opId === 'op-closed' && a.phase === 'result');
  assert.equal(recClosed.length, 1);
  assert.equal(recClosed[0].ok, false);
  assert.equal(recClosed[0].prState, 'CLOSED');
});

test('⑧ R7 生产触发链(第 2 轮核验):合并成功后必须真的调用 hazard 激活——pending 条目被处理且核验没过时留在 inbox', () => {
  const { repo, stateDir, env, head } = setup({ receiptHead: 'CURRENT' });
  // pending hazard 夹具(fix PR = 469,与本次合并同号);第一次合并后才知道 repoStateKey 子目录名
  const inboxItem = {
    hazardId: 'hz2-prod', fingerprint: 'hzf2-prod', repo: 'xindong/mivo-canvas',
    originPr: 400, originHead: 'b'.repeat(40), fixPr: 469, fixHead: head,
    pattern: 'p', evidence: '依据', paths: ['a/**'],
    activationStatus: 'pending-fix-merge', promotionStatus: 'pending', promotionTarget: null,
  };
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--admin', '--mode', 'auto']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.hazardActivation, '合并出口必须带出 hazard 激活结果(证明生产触发链真的接线了,不是只有 SKILL 里的手工命令)');
  assert.equal(typeof out.hazardActivation.action ?? 'activate', 'string');
  // 真放一条 pending 再合一次:激活会跑,但 fake gh 查不到 origin PR → 核验不过 → 留 inbox
  const stateSub = readDirOnly(stateDir);
  writeFileSync(join(stateDir, stateSub, 'escaped-hazards-inbox.json'), JSON.stringify({ version: 1, items: [inboxItem] }));
  const r2 = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--admin', '--mode', 'auto']);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const out2 = JSON.parse(r2.stdout);
  assert.equal(out2.hazardActivation.action, 'activate');
  assert.deepEqual(out2.hazardActivation.activated, [], 'fake gh 查不到 PR 状态 → 不得激活');
  const box = JSON.parse(readFileSync(join(stateDir, stateSub, 'escaped-hazards-inbox.json'), 'utf8'));
  assert.equal(box.items.length, 1, '核验没过的条目必须留在 inbox 下轮重放');
  assert.ok(box.items[0].lastActivationCheck, '必须记下这轮为什么没激活(证明激活逻辑真跑过了)');
});

test('⑨ R7 第 3 轮核验:PATH 里的 node 不可用时激活仍要跑(用 process.execPath,不是裸 "node")', () => {
  const { work, repo, stateDir, env, head } = setup({ receiptHead: 'CURRENT' });
  // PATH 最前面放一个 node shim:除了 fake gh 自己(它的 shebang 就是 node)之外,一律
  // 拒绝服务——于是"被测脚本用裸 `node` 起子进程"这条路会 127 失败,用 process.execPath
  // 的实现不受影响。等价于 mini 的非交互 PATH 里没有真 node 的生产场景。
  const shim = join(work, 'shim');
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, 'node'), [
    '#!/bin/sh',
    'case "$1" in',
    '  */fake-gh/gh) exec ' + process.execPath + ' "$@" ;;',
    '  *) echo "bare node is blocked in this test" >&2; exit 127 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(shim, 'node'), 0o755);
  const noNodeEnv = { ...env, PATH: `${shim}:${env.PATH}` };
  // 外层用 process.execPath 起(否则连被测脚本都起不来);被测进程的 PATH 里没有 node
  const r = spawnSync(process.execPath, [SCRIPT, '469', '--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--admin', '--mode', 'auto'], { cwd: repo, env: noNodeEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.hazardActivation, 'PATH 无 node 时也必须拿到激活结果');
  assert.equal(out.hazardActivation.error, undefined, `激活不应报错:${JSON.stringify(out.hazardActivation)}`);
  assert.equal(out.hazardActivation.action, 'activate');
  assert.ok(existsSync(stateDir));
});

// ── automated-review-gate wave0 delta(2026-08-08):执行侧现场复核 basis ──
// 新语义:merge-pr.mjs(唯一合并出口)执行前必须自行现场复核 basis 凭证——
// approved/admin-trust/self-merge 三条正常自动合路径要求 current-head clean 回执;
// authorized-fast-merge 是唯一无回执可放的人工例外,但必须现场验证 break-glass 授权
// (breakGlassApprovers 成员的人工 /approve-merge <当前 head>)。

test('⑩ 现场复核:--basis approved 无回执 → 拒绝执行(exit 2)且零 gh 写调用', () => {
  const { repo, stateDir, log, env, head } = setup(); // 无 receipt
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--admin', '--mode', 'auto']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /回执|现场复核|precheck|review-receipt/i, '拒绝原因必须指向执行侧复核');
  const writes = ghCalls(log).filter((c) => c.isWrite);
  assert.equal(writes.length, 0, '复核不过不得执行任何 gh 写操作');
  assert.equal(readdirSync(stateDir).filter((d) => existsSync(join(stateDir, d, 'merges.jsonl'))).length, 0, '复核不过连 intent 都不写');
});

test('⑩b 现场复核:--basis admin-trust 无回执 → 拒绝执行且零 gh 写调用', () => {
  const { repo, stateDir, log, env, head } = setup();
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'admin-trust', '--admin']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const writes = ghCalls(log).filter((c) => c.isWrite);
  assert.equal(writes.length, 0, 'admin-trust 无回执不得执行');
});

test('⑩c 现场复核:--basis self-merge 无回执 → 拒绝执行且零 gh 写调用', () => {
  const { repo, stateDir, log, env, head } = setup();
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'self-merge', '--admin']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const writes = ghCalls(log).filter((c) => c.isWrite);
  assert.equal(writes.length, 0, 'self-merge 无回执不得执行');
});

test('⑪ 现场复核:--basis approved + current-head clean 回执 → 放行(三条正常路径的唯一凭证)', () => {
  const { repo, stateDir, log, env, head } = setup({ receiptHead: 'CURRENT' });
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--admin']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const audit = readAudit(stateDir);
  assert.equal(audit.length, 2);
  assert.equal(audit[0].basis, 'approved');
  assert.equal(audit[1].ok, true);
  const merges = ghCalls(log).filter((call) => call.args[0] === 'pr' && call.args[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.ok(merges[0].args.includes(head), '执行侧必须带调用方传入的 head,不得替换');
});

test('⑪b 现场复核:回执绑定旧 head(≠ 当前 headRefOid)→ 拒绝执行', () => {
  const { repo, stateDir, log, env, head } = setup({ receiptHead: OLD_HEAD });
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--admin']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const writes = ghCalls(log).filter((c) => c.isWrite);
  assert.equal(writes.length, 0, '回执绑定旧 head → 不得执行(判定 head 与回执 head 必须一致)');
});

test('⑫ 现场复核:--basis authorized-fast-merge + 无 break-glass 授权评论 → 拒绝执行', () => {
  const { repo, stateDir, log, env, head } = setup({ commentNodes: [] }); // PR 无任何评论
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'authorized-fast-merge', '--admin', '--mode', 'auto']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /授权|approve-merge|break-glass/i, '拒绝原因必须指向 break-glass 复核');
  const writes = ghCalls(log).filter((c) => c.isWrite);
  assert.equal(writes.length, 0, '无有效授权不得执行合并');
});

test('⑫b 现场复核:--basis authorized-fast-merge + 有效 break-glass 评论(人工+当前 head)→ 放行,审计 basis 如实', () => {
  // 评论正文里的 head SHA 只有建仓后才知道 → commentNodes 传函数 (head) => nodes
  const { repo, stateDir, log, env, head } = setup({ commentNodes: (h) => [glassCommentNode(h)] });
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'authorized-fast-merge', '--admin', '--mode', 'auto']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const audit = readAudit(stateDir);
  assert.equal(audit[0].basis, 'authorized-fast-merge', '审计必须记录 break-glass 通道的 basis');
  assert.equal(audit[0].matchHead, head);
  assert.equal(audit[1].ok, true);
  const merges = ghCalls(log).filter((call) => call.args[0] === 'pr' && call.args[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.ok(merges[0].args.includes('--admin'), 'break-glass 是 admin bypass 路径,必须带 --admin');
});

test('⑫c 直接调用契约:--delete-branch 进 gh 命令且写进审计 argv(有回执时)', () => {
  const { repo, stateDir, log, env, head } = setup({ receiptHead: 'CURRENT' });
  const r = runMerge(env, repo, ['--strategy', 'squash', '--match-head', head, '--basis', 'approved', '--delete-branch']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const merges = ghCalls(log).filter((call) => call.args[0] === 'pr' && call.args[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.ok(merges[0].args.includes('--delete-branch'));
  const audit = readAudit(stateDir);
  assert.ok(JSON.stringify(audit[0].argv).includes('--delete-branch'), '审计 argv 必须反映真实命令');
});
