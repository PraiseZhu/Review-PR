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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'pre-merge-check.mjs');
const FAKE_GH_DIR = join(__dirname, 'fixtures', 'fake-gh');

const HEAD = '3ae9ecdb745dc5827e36962c1630f037f4a986cc'; // #469 合并时的真实 head
const OLD_APPROVE_COMMIT = 'a32ae3ba81810d9934e1332fe426b5693f067ca1'; // APPROVED 绑定的旧 head

function setup({ approveCommit, ownAckRequired = false, approveMergeComment = null, approver = 'PraiseZhu', reviewDecision = 'APPROVED', includeLatestReviews = true, includePageInfo = true }) {
  const work = mkdtempSync(join(tmpdir(), 'premerge-469-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git']);
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
        comments: { nodes: approveMergeComment ? [{
          author: { login: 'PraiseZhu', __typename: 'User' },
          body: approveMergeComment,
          createdAt: '2026-08-04T11:00:00Z', updatedAt: '2026-08-04T11:00:00Z', url: 'c1',
        }] : [] },
        ...(includeLatestReviews ? {
          latestOpinionatedReviews: {
            ...(includePageInfo ? { pageInfo: { hasNextPage: false } } : {}),
            nodes: [{
              author: { login: approver, __typename: 'User' },
              state: 'APPROVED',
              commit: { oid: approveCommit },
            }],
          },
        } : {}),
      } },
    },
  }));
  writeFileSync(join(fixtures, 'pr-diff.txt'), 'diff --git a/a.txt b/a.txt\n+++ b/a.txt\n+hello\n');
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
  const env = {
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    FAKE_GH_FIXTURE_DIR: fixtures,
    REVIEW_PR_REPO_ROOT: repo,
    REVIEW_PR_STATE_DIR: stateDir,
    REVIEW_PR_RULES_FILE: rulesFile,
  };
  return { repo, env };
}

function runCheck(cfg) {
  const { repo, env } = setup(cfg);
  const r = spawnSync('node', [SCRIPT, '469'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  return { r, out };
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
  const { out } = runCheck({ approveCommit: HEAD });
  assert.equal(out.approvalBasis.basis, 'own-account');
  assert.equal(out.approvedShortcut.granted, true);
  assert.equal(out.structuralBypassBasis, 'approved');
  assert.equal(out.structuralBypassReady, true);
});

test('C · SC3.2:配置开 ownAccountApprovalRequiresAck → own-account@head 也不放行', () => {
  const { out } = runCheck({ approveCommit: HEAD, ownAckRequired: true });
  assert.equal(out.approvalBasis.basis, 'own-account');
  assert.equal(out.approvedShortcut.granted, false);
  assert.match(out.approvedShortcut.reason, /own-account-approval-needs-explicit-auth/);
  assert.equal(out.structuralBypassReady, false);
});

test('D · SC3.2 出路:head 绑定 /approve-merge <当前head> → 配置开也放行', () => {
  const { out } = runCheck({
    approveCommit: HEAD, ownAckRequired: true,
    approveMergeComment: `/approve-merge ${HEAD}`,
  });
  assert.equal(out.approvedShortcut.granted, true);
  assert.equal(out.structuralBypassReady, true);
});

test('D2 · 旧 SHA 的 /approve-merge 不解锁(head 绑定语义贯穿授权通道)', () => {
  const { out } = runCheck({
    approveCommit: HEAD, ownAckRequired: true,
    approveMergeComment: `/approve-merge ${OLD_APPROVE_COMMIT}`,
  });
  assert.equal(out.approvedShortcut.granted, false);
});

test('E · 独立 approve(非 viewer)@head + 配置开 → 不受 own-account 收紧影响', () => {
  const { out } = runCheck({ approveCommit: HEAD, ownAckRequired: true, approver: 'kirozeng' });
  assert.equal(out.approvalBasis.basis, 'independent');
  assert.equal(out.approvedShortcut.granted, true);
  assert.equal(out.structuralBypassReady, true);
});

test('F · 复审反例:independent approve@head 但 reviewDecision=REVIEW_REQUIRED(如仓库要求 2 个 approval/Code Owner 未满足)→ shortcut 拒,ready=false', () => {
  const { r, out } = runCheck({ approveCommit: HEAD, approver: 'kirozeng', reviewDecision: 'REVIEW_REQUIRED' });
  assert.equal(out.approvalBasis.basis, 'independent', 'basis 判定本身不变——被拒的是聚合裁决合取');
  assert.equal(out.approvedShortcut.granted, false);
  assert.match(out.approvedShortcut.reason, /github-review-decision-not-approved/);
  assert.equal(out.structuralBypassReady, false, '聚合裁决未 APPROVED 时绝不 admin bypass——单条 review 不能替代审批数/Code Owner 规则');
  assert.equal(r.status, 2);
});

test('H · 复审反例:latestOpinionatedReviews connection 整体缺失(查询形状漂移)→ 不得谎报分页完整,basis=none fail-closed', () => {
  const { r, out } = runCheck({ approveCommit: HEAD, includeLatestReviews: false });
  assert.equal(out.approvalBasis.basis, 'none');
  assert.equal(out.approvalBasis.dataComplete, false, 'connection 缺失必须按数据不完整处理(完整性是正向断言 hasNextPage===false,不是否定式)');
  assert.equal(out.approvedShortcut.granted, false);
  assert.equal(out.structuralBypassReady, false);
  assert.equal(r.status, 2, '退出契约同样要锁:不可合必须 exit 2');
});

test('H2 · 第 3 轮复审反例:connection 存在但 pageInfo 缺失 → 同样判不完整(上一版否定式判定在此 fail-open 得到 granted=true)', () => {
  const { r, out } = runCheck({ approveCommit: HEAD, approver: 'kirozeng', includePageInfo: false });
  assert.equal(out.approvalBasis.basis, 'none');
  assert.equal(out.approvalBasis.dataComplete, false);
  assert.equal(out.approvedShortcut.granted, false);
  assert.equal(out.structuralBypassReady, false);
  assert.equal(r.status, 2, '退出契约同样要锁:不可合必须 exit 2');
});

test('G · SC-A 迁移报告:裸 /approve-merge(旧格式)不授权,且必须显式进入 legacyBareApproveComments', () => {
  const { out } = runCheck({
    approveCommit: HEAD, ownAckRequired: true,
    approveMergeComment: '/approve-merge',
  });
  assert.equal(out.approvedShortcut.granted, false, '裸格式不构成 head 绑定授权');
  assert.equal(out.structuralBypassReady, false);
  assert.equal(out.legacyBareApproveComments.length, 1, '裸命令必须被显式报告(提醒重发 head 绑定格式),不能静默消失');
});
