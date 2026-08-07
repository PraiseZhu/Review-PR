// context.mjs --scan 的接线行为测试(第 3 轮复审 P1-4,2026-08-05):fake gh 子进程真实跑
// 单 PR --scan,锁两处只有 context 才有的输出接线——helper 单测与 pre-merge 子进程测试
// 都证明不了它们:
//   ① authorizedFastMerge.legacyBareComments:裸 /approve-merge(旧格式)必须显式进入
//      context 输出(auto 候选分流走的是 context,不接线=breaking migration 静默);
//   ② skip-structural-block 的 auto.reason 必须携带 approvedShortcut.reason(stale 等
//      真实原因),不得谎报成"缺 reviewDecision=APPROVED"——#469 形态(stale approve)
//      下错误的补救指引会误导 owner。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'context.mjs');
const FAKE_GH_DIR = join(__dirname, 'fixtures', 'fake-gh');

const HEAD = '3ae9ecdb745dc5827e36962c1630f037f4a986cc';
const OLD = 'a32ae3ba81810d9934e1332fe426b5693f067ca1';

const BODY = [
  '### 这次改了什么', '重写了扫描分类的判定,细节见 diff,覆盖三条路径与回退分支。',
  '### 怎么验证的', '本地跑了单元测试与 e2e smoke,均通过;另做了一次手工回归。',
  '### 风险', '改动集中在扫描分类,失败模式是多扫一轮,无数据破坏面。',
].join('\n');

// wave0 追加(2026-08-08):授权路由接线测试的评论节点旋钮——默认保持旧裸格式场景
// (作者 PraiseZhu 在 admins 名单),传 commentNodes 可换任何评论形态。
const DEFAULT_COMMENT_NODES = [{
  author: { login: 'PraiseZhu', __typename: 'User' },
  body: '/approve-merge', // 旧裸格式:不授权,必须进 legacyBareComments
  createdAt: '2026-08-04T11:00:00Z', updatedAt: '2026-08-04T11:00:00Z', url: 'c1',
}];
function setup({ commentNodes = DEFAULT_COMMENT_NODES, adminsExtra = [], mergeAuth = null, approveOid = OLD, reviewAuthor = 'PraiseZhu', authorLogin = 'aj0928' } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'context-scan-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git']);
  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const fixtures = join(work, 'fixtures');
  mkdirSync(fixtures);
  const rulesFile = join(work, 'pr-rules.json');
  // context.mjs 模块加载期就消费 titleTypes 等完整契约键——基于 skill 默认配置叠加本测试
  // 需要的键,而不是手写残缺 rules。
  const baseRules = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'pr-rules.json'), 'utf8'));
  writeFileSync(rulesFile, JSON.stringify({
    ...baseRules,
    admins: ['PraiseZhu', ...adminsExtra], // 作者 aj0928 不在名单 → 结构性 BLOCKED 落 skip-structural-block 分支
    structuralBypassAllowlist: ['code_scanning', 'code_quality'],
    securityReviewPaths: [], // 关掉,避免误命中干扰本测试的结构性分支
    ...(mergeAuth ? { mergeAuthorization: mergeAuth } : {}),
  }));
  writeFileSync(join(fixtures, 'pr-view.json'), JSON.stringify({
    number: 469, title: 'fix: 扫描分类判定越界修复', body: BODY, state: 'OPEN',
    headRefName: 'feat/x', headRefOid: HEAD, isCrossRepository: false, baseRefName: 'main',
    author: { login: authorLogin }, url: 'https://github.com/xindong/mivo-canvas/pull/469',
    mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED',
    isDraft: false, mergedAt: null, labels: [], files: [{ path: 'src/foo.ts', additions: 3, deletions: 1 }],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint + tsc + unit + logging', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  }));
  writeFileSync(join(fixtures, 'graphql-threads.json'), JSON.stringify({
    data: {
      viewer: { login: 'PraiseZhu' },
      repository: { pullRequest: {
        author: { login: authorLogin },
        reviewThreads: { nodes: [] },
        comments: { nodes: commentNodes },
        timeline: { nodes: [{ commit: { committedDate: '2026-08-04T10:00:00Z', messageHeadline: 'x', oid: HEAD } }] },
        readyEvents: { nodes: [] },
        latestOpinionatedReviews: {
          pageInfo: { hasNextPage: false },
          // 默认 viewer(PraiseZhu)的 APPROVED 绑定旧 head → basis=stale(#469 形态)
          nodes: [{ author: { login: reviewAuthor, __typename: 'User' }, state: 'APPROVED', commit: { oid: approveOid } }],
        },
      } },
    },
  }));
  writeFileSync(join(fixtures, 'pr-diff.txt'), 'diff --git a/src/foo.ts b/src/foo.ts\n+++ b/src/foo.ts\n+hello\n');
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

test('context --scan 接线:裸 /approve-merge 进 legacyBareComments;skip-structural-block 的 auto.reason 如实携带 stale 原因', () => {
  const { repo, env } = setup({ mergeAuth: GLASS_CONFIG });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  // ① legacyBare 接线(删掉 context.mjs 的 legacyBareComments 一行即红)
  assert.equal(out.authorizedFastMerge.legacyBareComments.length, 1, '裸命令必须显式进入 context 输出,提醒按 head 绑定格式重发');
  assert.equal(out.authorizedFastMerge.requested, false, '裸格式不构成授权');
  // ② stale 口径接线:approvedShortcut 拒绝原因必须原样进 auto.reason,不得谎报"缺 reviewDecision"
  assert.equal(out.approvalBasis.basis, 'stale');
  assert.equal(out.approvedShortcut.granted, false);
  assert.equal(out.auto.action, 'skip-structural-block');
  assert.match(out.auto.reason, /approved shortcut 不成立/);
  assert.match(out.auto.reason, /stale/, '#469 形态下补救指引必须指向"approve 绑定旧 head",不是"缺 APPROVED"');
  // ③ 机器 note 同口径(第 4 轮复审 P2):structuralBypassPending 的说明不得把原因唯一写成
  //    "缺 APPROVED"——stale/own-account 待授权时 reviewDecision 可能已是 APPROVED。
  assert.match(out.note, /approved shortcut 不成立/);
  assert.doesNotMatch(out.note, /名单但缺 APPROVED/, 'note 不得沿用"缺 APPROVED"作唯一原因口径');
});

test('静态词条锁(第 5 轮复审):context.mjs 源码内禁止"既无 APPROVED 也非 admins"旧口径——full note 与注释同样覆盖', () => {
  // full 模式的机器 note 没有 fake-gh fixture 覆盖(gh 调用面太宽);这里验的是固定说明
  // 词条,静态断言正合适:#469 形态下 reviewDecision 可以已是 APPROVED(stale approve),
  // "既无 APPROVED"是谎报,补救指向必须走 approvedShortcut.reason。
  const src = readFileSync(join(__dirname, '..', 'scripts', 'context.mjs'), 'utf8');
  assert.ok(!src.includes('既无 APPROVED'), 'context.mjs 残留"既无 APPROVED"旧口径(应写"approved shortcut 不成立且作者不在 admins 名单")');
});

// ── automated-review-gate wave0 追加(2026-08-08):SC-3 授权路由接线 ──
// 意图:人工 break-glass 是唯一例外——只有「admins 成员人工 + 未编辑 + 独占一行 +
// 当前 head SHA」会被 context 路由到 authorized-fast-merge;bot 评论与旧 SHA 一律不得。

// wave0 delta(2026-08-08):授权名单与 admins 解耦后,有效人工命令需 breakGlassApprovers
// 显式配置——未配置即紧急通道关闭(fail-closed)。以下既有路由用例补上配置保持为行为
// 对照;新增用例在旧代码上红。
const GLASS_CONFIG = { breakGlassApprovers: ['PraiseZhu'] };

test('SC-3 路由:breakGlassApprovers 成员人工 + 当前 head SHA → requested=true,auto.action=authorized-fast-merge', () => {
  const { repo, env } = setup({ commentNodes: [{
    author: { login: 'PraiseZhu', __typename: 'User' },
    body: `/approve-merge ${HEAD}`,
    createdAt: '2026-08-04T11:00:00Z', updatedAt: '2026-08-04T11:00:00Z', url: 'c1',
  }], mergeAuth: GLASS_CONFIG });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  assert.equal(out.authorizedFastMerge.requested, true, '有效授权必须被识别为 requested');
  assert.equal(out.authorizedFastMerge.eligible, true, `机械前提应满足(required 空集+扫描干净):${JSON.stringify(out.authorizedFastMerge)}`);
  assert.equal(out.authorizedFastMerge.staleComments.length, 0);
  assert.equal(out.auto.action, 'authorized-fast-merge', 'auto 分流必须路由到紧急通道');
  assert.equal(out.auto.isSkip, false);
});

test('SC-3 路由反向:bot 评论发 /approve-merge <当前 head> → 不路由(自动化不能授权)', () => {
  const { repo, env } = setup({ commentNodes: [{
    author: { login: 'PraiseZhu', __typename: 'Bot' },
    body: `/approve-merge ${HEAD}`,
    createdAt: '2026-08-04T11:00:00Z', updatedAt: '2026-08-04T11:00:00Z', url: 'c1',
  }], mergeAuth: GLASS_CONFIG });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}`);
  assert.equal(out.authorizedFastMerge.requested, false, 'bot 评论不得成为授权来源');
  assert.equal(out.authorizedFastMerge.eligible, false);
  assert.notEqual(out.auto.action, 'authorized-fast-merge');
  assert.equal(out.authorizedFastMerge.admin, null);
});

test('SC-3 路由反向:旧 SHA(非当前 head)→ stale 提示进输出,不路由', () => {
  const { repo, env } = setup({ commentNodes: [{
    author: { login: 'PraiseZhu', __typename: 'User' },
    body: `/approve-merge ${OLD}`,
    createdAt: '2026-08-04T11:00:00Z', updatedAt: '2026-08-04T11:00:00Z', url: 'c1',
  }], mergeAuth: GLASS_CONFIG });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}`);
  assert.equal(out.authorizedFastMerge.requested, false, '旧 SHA 不构成授权');
  assert.equal(out.authorizedFastMerge.staleComments.length, 1, '旧 SHA 授权必须显式进 stale 提示(提醒对新 head 重发)');
  assert.notEqual(out.auto.action, 'authorized-fast-merge');
});

test('SC-3 路由兼容期两组(裁决 1):breakGlassApprovers 缺失 → 回退 admins 可用+warning;显式 [] → 关闭', () => {
  // 缺失回退:mergeAuth 未配置 → resolveMergeAuthorizationPolicy 回退到 admins(含
  // PraiseZhu)作为 /approve-merge 发令名单并产出 warning——名单成员人工 + 当前 head 的
  // 命令仍构成授权(兼容期语义,不再"未配置恒不授权")
  const { repo, env } = setup({ commentNodes: [{
    author: { login: 'PraiseZhu', __typename: 'User' },
    body: `/approve-merge ${HEAD}`,
    createdAt: '2026-08-04T11:00:00Z', updatedAt: '2026-08-04T11:00:00Z', url: 'c1',
  }] });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}`);
  assert.equal(out.authorizedFastMerge.requested, true, '缺失 breakGlassApprovers → 回退 admins,名单成员人工命令仍授权(兼容期)');
  assert.match((out.configWarnings ?? []).join(';'), /breakGlassApprovers 未配置.*回退到 admins/, '兼容回退必须产出显式 warning(裁决 1),不能静默');
  // 显式 [] → 紧急通道关闭:任何人工命令都不路由
  const { repo: repo2, env: env2 } = setup({ commentNodes: [{
    author: { login: 'PraiseZhu', __typename: 'User' },
    body: `/approve-merge ${HEAD}`,
    createdAt: '2026-08-04T11:00:00Z', updatedAt: '2026-08-04T11:00:00Z', url: 'c1',
  }], mergeAuth: { breakGlassApprovers: [] } });
  const r2 = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo2, env: env2, encoding: 'utf8' });
  let out2 = null;
  try { out2 = JSON.parse(r2.stdout); } catch { /* fallthrough */ }
  assert.ok(out2, `输出应为 JSON,got status=${r2.status}`);
  assert.equal(out2.authorizedFastMerge.requested, false, '显式 [] → 关闭紧急通道,人工命令不授权');
  assert.equal(out2.authorizedFastMerge.eligible, false);
  assert.notEqual(out2.auto.action, 'authorized-fast-merge');
});

test('SC-3 路由反向:breakGlassApprovers 不含发令者(admins 含)→ 不路由(名单解耦,旧代码红)', () => {
  // admins 含 PraiseZhu;breakGlassApprovers 只含 kirozeng → 新语义不授权
  const { repo, env } = setup({ commentNodes: [{
    author: { login: 'PraiseZhu', __typename: 'User' },
    body: `/approve-merge ${HEAD}`,
    createdAt: '2026-08-04T11:00:00Z', updatedAt: '2026-08-04T11:00:00Z', url: 'c1',
  }], mergeAuth: { breakGlassApprovers: ['kirozeng'] } });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}`);
  assert.equal(out.authorizedFastMerge.requested, false, 'admins 含发令者但 breakGlass 不含 → 不得授权');
  assert.equal(out.authorizedFastMerge.eligible, false);
  assert.notEqual(out.auto.action, 'authorized-fast-merge');
});

// ── Mivo 强制策略(requireAutomatedReviewForAutoMerge)路由:GitHub APPROVED 不能直接 bypass ──

test('L1 · Mivo 强制策略:requireAutomatedReviewForAutoMerge=true + 作者在 admins + APPROVED@head + CI 绿 + 无回执/无人工命令 → action=review(旧代码红)', () => {
  // 新语义(裁决 3):配置强制自动审查后,即便 GitHub APPROVED + 绑定当前 head + 作者在
  // admins,没有 current-head clean 回执也绝不直接 bypass——必须先路由 review(独立审查)。
  // approvedShortcut 仍是 GitHub approval 事实(granted=true 如实),约束落在路由层:
  // 结构性 BLOCKED 下 route=review-pending-approved-bypass → auto.action=review。
  // 旧代码:approvedShortcut 成立 → route=bypass-structural-block → action=bypass-structural-block → 红
  const { repo, env } = setup({
    commentNodes: [],
    adminsExtra: ['aj0928'], // 作者在 admins
    approveOid: HEAD, // review 绑定当前 head
    reviewAuthor: 'kirozeng', // 独立 approve(非 viewer)
    mergeAuth: { requireAutomatedReviewForAutoMerge: true },
  });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  assert.equal(out.approvalBasis.basis, 'independent', '前提:approve 绑定当前 head');
  assert.equal(out.approvedShortcut.granted, true, 'shortcut 是 GitHub approval 事实,强制策略不翻转它(裁决 3)');
  assert.equal(out.auto.action, 'review', 'GitHub APPROVED 也不能直接 bypass,必须路由 review(旧代码 bypass-structural-block → 红)');
  assert.equal(out.auto.isSkip, false);
});

test('L1b · 对照组:requireAutomatedReviewForAutoMerge 未配置 + 作者在 admins + APPROVED@head → bypass-structural-block(现状兼容)', () => {
  const { repo, env } = setup({
    commentNodes: [],
    adminsExtra: ['aj0928'],
    approveOid: HEAD,
    reviewAuthor: 'kirozeng',
  });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}`);
  assert.equal(out.approvedShortcut.granted, true, '未配置强制审查 → shortcut 照常成立');
  assert.equal(out.auto.action, 'bypass-structural-block', '未配置时保持现状路由');
});
