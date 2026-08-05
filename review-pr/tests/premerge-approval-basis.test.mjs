// #469 事故形态的全链路回归(SC1.3 / SC3.2 / SC3.3,2026-08-04):子进程真实跑
// scripts/pre-merge-check.mjs + fake gh(喂真实 GraphQL/REST 形状),不是只测纯函数——
// 上一版事故正是"每个纯函数都对,接线层把 reviewDecision 当无条件绿灯"。
//
// 场景矩阵(同一套 fixture,只改 latestReviews 的 commit.oid / 配置键 / 授权评论):
//   A  #469 原样:同账号 APPROVED@旧head + force-push 后 head 已变 + CI 绿 + 结构性 BLOCKED
//      → approvalBasis=stale,approved shortcut 拒,路由落 admin-trust(作者在 admins),
//        无回执 → structuralBypassReady=false。旧实现在这里给 true——这就是事故。
//   B  对照:approve commit == 当前 head(其余全同)→ own-account@head,配置未开 →
//        shortcut 放行,ready=true,basis=approved(现状兼容,#483 型正常路径不受伤)。
//   C  SC3.2:同 B 但配置开 ownAccountApprovalRequiresAck → shortcut 拒
//        (own-account-approval-needs-explicit-auth),ready=false。
//   D  SC3.2 出路:同 C 但 admins 成员发了 head 绑定 /approve-merge <当前head> → shortcut 放行。
//   E  独立 approve(非 viewer 账号)@head + 配置开 → 不受 own-account 收紧影响,ready=true。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'pre-merge-check.mjs');
const FAKE_GH_DIR = join(__dirname, 'fixtures', 'fake-gh');

// 第 3 轮核验:pre-merge 的 DiffSnapshot 必须**真的能建起来**——旧 fixture 省略 baseRefOid、
// 依赖 `gh pr diff` 退路,却断言 structuralBypassReady=true,等于把"不完整快照上也能 bypass"
// 这条旁路锁成了绿。现在建真仓、给真 base/head oid,并按需构造不完整场景。
const OLD_APPROVE_COMMIT = 'a32ae3ba81810d9934e1332fe426b5693f067ca1'; // 与当前 head 不同的旧 oid
const CURRENT = 'current'; // approveCommit 哨兵:绑定本次真实 head
const CLEAN_FILE = 'export const a = 2;\n';

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function setup({ approveCommit, ownAckRequired = false, approveMergeComment = null, approver = 'PraiseZhu', reviewDecision = 'APPROVED', includeLatestReviews = true, includePageInfo = true, headFileContent = CLEAN_FILE, omitBaseRefOid = false }) {
  const work = mkdtempSync(join(tmpdir(), 'premerge-469-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], repo);
  writeFileSync(join(repo, 'a.txt'), 'export const a = 1;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  const BASE = git(['rev-parse', 'HEAD'], repo);
  writeFileSync(join(repo, 'a.txt'), headFileContent);
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'head'], repo);
  const HEAD = git(['rev-parse', 'HEAD'], repo);
  const approveOid = approveCommit === CURRENT ? HEAD : approveCommit;
  // 授权评论里的 {CURRENT} 占位替换成本次真实 head(oid 只有建仓后才知道)
  const approveComment = approveMergeComment ? approveMergeComment.replace('{CURRENT}', HEAD) : null;
  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const fixtures = join(work, 'fixtures');
  mkdirSync(fixtures);
  const rulesFile = join(work, 'pr-rules.json');
  writeFileSync(rulesFile, JSON.stringify({
    admins: ['PraiseZhu', 'kirozeng', 'aj0928'],
    structuralBypassAllowlist: ['code_scanning', 'code_quality'],
    ...(ownAckRequired ? { mergeAuthorization: { ownAccountApprovalRequiresAck: true } } : {}),
  }));
  writeFileSync(join(fixtures, 'pr-view.json'), JSON.stringify({
    title: 'feat(canvas): 局部重绘交互升级', body: '正文', state: 'OPEN',
    mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision,
    headRefOid: HEAD, baseRefName: 'main',
    ...(omitBaseRefOid ? {} : { baseRefOid: BASE }),
    files: [{ path: 'a.txt' }],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint + tsc + unit + logging', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'e2e kernel gate (new)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  }));
  writeFileSync(join(fixtures, 'graphql-threads.json'), JSON.stringify({
    data: {
      viewer: { login: 'PraiseZhu' },
      repository: { pullRequest: {
        author: { login: 'aj0928' },
        reviewThreads: { nodes: [] },
        comments: { nodes: approveComment ? [{
          author: { login: 'PraiseZhu', __typename: 'User' },
          body: approveComment,
          createdAt: '2026-08-04T11:00:00Z', updatedAt: '2026-08-04T11:00:00Z', url: 'c1',
        }] : [] },
        ...(includeLatestReviews ? {
          latestOpinionatedReviews: {
            ...(includePageInfo ? { pageInfo: { hasNextPage: false } } : {}),
            nodes: [{
              author: { login: approver, __typename: 'User' },
              state: 'APPROVED',
              commit: { oid: approveOid },
            }],
          },
        } : {}),
      } },
    },
  }));
  // `pr diff` 退路的 fixture **故意不提供**:合并阶段禁退路,任何一次退路调用都会失败,
  // 于是"是否还在走退路"变成可观测的(见下面对 pr diff 调用数的断言)。
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
  chmodSync(join(FAKE_GH_DIR, 'gh'), 0o755);
  const ghLog = join(work, 'gh-calls.jsonl');
  const env = {
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    FAKE_GH_FIXTURE_DIR: fixtures,
    FAKE_GH_LOG: ghLog,
    REVIEW_PR_REPO_ROOT: repo,
    REVIEW_PR_STATE_DIR: stateDir,
    REVIEW_PR_RULES_FILE: rulesFile,
  };
  return { repo, env, ghLog, head: HEAD, base: BASE };
}

function runCheck(cfg) {
  const { repo, env, ghLog, head, base } = setup(cfg);
  const r = spawnSync('node', [SCRIPT, '469'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  const calls = existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const prDiffCalls = calls.filter((c) => c.args?.[0] === 'pr' && c.args?.[1] === 'diff');
  return { r, out, head, base, prDiffCalls };
}

test('A · #469 原样重放:stale approve 不再构成 approved shortcut,ready=false(旧实现在此 fail-open)', () => {
  const { r, out } = runCheck({ approveCommit: OLD_APPROVE_COMMIT });
  assert.equal(out.approvalBasis.basis, 'stale');
  assert.equal(out.approvedShortcut.granted, false);
  assert.equal(out.structuralBypassBasis, 'admin-trust', '应落 admin-trust(独立审查+回执)路由,而不是 approved 直通');
  assert.equal(out.structuralBypassReady, false, '无当前 head 回执时绝不 ready——这正是 #469 被合走的洞');
  assert.equal(r.status, 2);
});

test('B · 对照组:approve 绑定当前 head(配置未开)→ own-account 放行,ready=true(现状路径不受伤)', () => {
  const { out } = runCheck({ approveCommit: CURRENT });
  assert.equal(out.approvalBasis.basis, 'own-account');
  assert.equal(out.approvedShortcut.granted, true);
  assert.equal(out.structuralBypassBasis, 'approved');
  assert.equal(out.structuralBypassReady, true);
});

test('C · SC3.2:配置开 ownAccountApprovalRequiresAck → own-account@head 也不放行', () => {
  const { out } = runCheck({ approveCommit: CURRENT, ownAckRequired: true });
  assert.equal(out.approvalBasis.basis, 'own-account');
  assert.equal(out.approvedShortcut.granted, false);
  assert.match(out.approvedShortcut.reason, /own-account-approval-needs-explicit-auth/);
  assert.equal(out.structuralBypassReady, false);
});

test('D · SC3.2 出路:head 绑定 /approve-merge <当前head> → 配置开也放行', () => {
  const { out } = runCheck({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: '/approve-merge {CURRENT}',
  });
  assert.equal(out.approvedShortcut.granted, true);
  assert.equal(out.structuralBypassReady, true);
});

test('D2 · 旧 SHA 的 /approve-merge 不解锁(head 绑定语义贯穿授权通道)', () => {
  const { out } = runCheck({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: `/approve-merge ${OLD_APPROVE_COMMIT}`,
  });
  assert.equal(out.approvedShortcut.granted, false);
});

test('E · 独立 approve(非 viewer)@head + 配置开 → 不受 own-account 收紧影响', () => {
  const { out } = runCheck({ approveCommit: CURRENT, ownAckRequired: true, approver: 'kirozeng' });
  assert.equal(out.approvalBasis.basis, 'independent');
  assert.equal(out.approvedShortcut.granted, true);
  assert.equal(out.structuralBypassReady, true);
});

test('F · 复审反例:independent approve@head 但 reviewDecision=REVIEW_REQUIRED(如仓库要求 2 个 approval/Code Owner 未满足)→ shortcut 拒,ready=false', () => {
  const { r, out } = runCheck({ approveCommit: CURRENT, approver: 'kirozeng', reviewDecision: 'REVIEW_REQUIRED' });
  assert.equal(out.approvalBasis.basis, 'independent', 'basis 判定本身不变——被拒的是聚合裁决合取');
  assert.equal(out.approvedShortcut.granted, false);
  assert.match(out.approvedShortcut.reason, /github-review-decision-not-approved/);
  assert.equal(out.structuralBypassReady, false, '聚合裁决未 APPROVED 时绝不 admin bypass——单条 review 不能替代审批数/Code Owner 规则');
  assert.equal(r.status, 2);
});

test('H · 复审反例:latestOpinionatedReviews connection 整体缺失(查询形状漂移)→ 不得谎报分页完整,basis=none fail-closed', () => {
  const { r, out } = runCheck({ approveCommit: CURRENT, includeLatestReviews: false });
  assert.equal(out.approvalBasis.basis, 'none');
  assert.equal(out.approvalBasis.dataComplete, false, 'connection 缺失必须按数据不完整处理(完整性是正向断言 hasNextPage===false,不是否定式)');
  assert.equal(out.approvedShortcut.granted, false);
  assert.equal(out.structuralBypassReady, false);
  assert.equal(r.status, 2, '退出契约同样要锁:不可合必须 exit 2');
});

test('H2 · 第 3 轮复审反例:connection 存在但 pageInfo 缺失 → 同样判不完整(上一版否定式判定在此 fail-open 得到 granted=true)', () => {
  const { r, out } = runCheck({ approveCommit: CURRENT, approver: 'kirozeng', includePageInfo: false });
  assert.equal(out.approvalBasis.basis, 'none');
  assert.equal(out.approvalBasis.dataComplete, false);
  assert.equal(out.approvedShortcut.granted, false);
  assert.equal(out.structuralBypassReady, false);
  assert.equal(r.status, 2, '退出契约同样要锁:不可合必须 exit 2');
});

test('G · SC-A 迁移报告:裸 /approve-merge(旧格式)不授权,且必须显式进入 legacyBareApproveComments', () => {
  const { out } = runCheck({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: '/approve-merge',
  });
  assert.equal(out.approvedShortcut.granted, false, '裸格式不构成 head 绑定授权');
  assert.equal(out.structuralBypassReady, false);
  assert.equal(out.legacyBareApproveComments.length, 1, '裸命令必须被显式报告(提醒重发 head 绑定格式),不能静默消失');
});

// ── SC-R1b 第 2 轮核验 BLOCKER:泄密硬门此前只被 authorized-fast-merge 一条路消费;
// 普通 canMerge / selfMerge / structural admin-bypass 的终判只叠 mechanical + stage2。
// 场景 B 是"一切正常 → ready=true"的对照组,在它之上只改 diff/扫描可用性。
test('F · 泄密硬命中:所有 merge 路由无条件拦(与 B 只差 head 提交的文件内容)', () => {
  const { r, out, prDiffCalls } = runCheck({ approveCommit: CURRENT, headFileContent: '-----BEGIN RSA PRIVATE KEY-----\n' });
  assert.equal(out.security.scanned, true, '前提:扫描必须真跑成(走 snapshot,不走退路)');
  assert.equal(out.security.hardHitCount > 0, true, '前提:扫描必须真命中');
  assert.equal(out.securityGate.pass, false);
  assert.equal(out.canMerge, false, '普通合并不得放行');
  assert.equal(out.selfMergeAvailable, false);
  assert.equal(out.structuralBypassReady, false, 'structural admin-bypass 同样不得放行');
  assert.match(out.blockers.join(';'), /硬命中/);
  assert.deepEqual(prDiffCalls, [], '合并阶段禁 `gh pr diff` 退路');
  assert.equal(r.status, 2);
});

test('F2 · 第 3 轮核验 BLOCKER:snapshot 不完整时禁退路且所有路由终拒(旧 fixture 正是靠退路把旁路锁成绿)', () => {
  const { r, out, prDiffCalls } = runCheck({ approveCommit: CURRENT, omitBaseRefOid: true });
  assert.equal(out.securityGate.snapshotComplete, false, '前提:快照确实不完整');
  assert.equal(out.securityGate.pass, false);
  assert.equal(out.canMerge, false);
  assert.equal(out.selfMergeAvailable, false);
  assert.equal(out.structuralBypassReady, false, '不完整快照上 structural approved 也不得 ready');
  assert.equal(out.authorizedFastMergeAvailable, false);
  assert.match(out.blockers.join(';'), /DiffSnapshot 不完整/);
  assert.deepEqual(prDiffCalls, [], '禁 `gh pr diff` 退路:合并阶段不允许拿一份不绑快照的 diff 顶替');
  assert.equal(r.status, 2);
});

test('B2 · 对照组:快照完整且无命中时,structural bypass 照常 ready(证明上面两条不是"一律拒")', () => {
  const { out, prDiffCalls } = runCheck({ approveCommit: CURRENT });
  assert.equal(out.securityGate.pass, true);
  assert.equal(out.securityGate.snapshotComplete, true);
  assert.equal(out.structuralBypassReady, true);
  assert.deepEqual(prDiffCalls, []);
});
