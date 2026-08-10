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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
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
function setup({ commentNodes = DEFAULT_COMMENT_NODES, adminsExtra = [], mergeAuth = null, stripMergeAuthorization = false, approveOid = OLD, reviewAuthor = 'PraiseZhu', authorLogin = 'aj0928', securityReviewPaths = [], reviewThreadNodes = [], prListNodes = [] } = {}) {
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
  // stripMergeAuthorization=true 模拟「目标仓自己的 pr-rules.json 完全没配 mergeAuthorization」
  // (旧仓形态)——skill 默认配置自 2026-08-08 起已显式配了 mergeAuthorization.breakGlassApprovers=[],
  // 不剥掉这个键,「缺失回退」场景就永远测不到(显式 [] 与缺失是两种语义,裁决 1 两组都要覆盖)。
  if (stripMergeAuthorization) delete baseRules.mergeAuthorization;
  writeFileSync(rulesFile, JSON.stringify({
    ...baseRules,
    admins: ['PraiseZhu', ...adminsExtra], // 作者 aj0928 不在名单 → 结构性 BLOCKED 落 skip-structural-block 分支
    structuralBypassAllowlist: ['code_scanning', 'code_quality'],
    // 默认关掉,避免误命中干扰结构性分支测试;SC-1 用例显式传入以命中 security-gate。
    securityReviewPaths,
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
        reviewThreads: { nodes: reviewThreadNodes },
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
  // R5(2026-08-10):--scan-all 候选来自 `gh pr list`(context.mjs),默认空列表 = 既有
  // 21 条用例零影响(fixture 不写就不存在);嵌套超时测试传入候选以驱动真实 --scan-all。
  if (prListNodes.length > 0) {
    writeFileSync(join(fixtures, 'pr-list.json'), JSON.stringify(prListNodes));
  }
  chmodSync(join(FAKE_GH_DIR, 'gh'), 0o755);
  // F1(2026-08-09,round3):fake gh 每次调用都追加一行到 $FAKE_GH_LOG(JSONL,含 argv)。
  // context.mjs 与 signoff-hold.mjs 子进程都继承该 env,日志里因此同时有父进程与子进程的
  // gh 调用——「真的 spawn 了子进程」的判别手段见 SC-1 用例。
  const ghLog = join(work, 'fake-gh.log');
  const env = {
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    FAKE_GH_FIXTURE_DIR: fixtures,
    FAKE_GH_LOG: ghLog,
    REVIEW_PR_REPO_ROOT: repo,
    REVIEW_PR_STATE_DIR: stateDir,
    REVIEW_PR_RULES_FILE: rulesFile,
  };
  return { repo, env, ghLog };
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

// ── SC-2 生产形状锁定(2026-08-10 重新落地)──
// 这条测试锁的是 context.mjs reviewThreads 导出契约的「负形状」,是 #13「删除
// assessThreadEvidence 而非接线」决策在生产(生产者)侧唯一的机器保障。那个决策的
// 判据:旧函数消费 body/authorType,而生产契约刻意不提供这两个字段——缺映射 = fail-closed
// 假阴性,补映射 = 两行普通埋点即 canResolve:true 的 fail-open 假阳性(已实测),故删除
// 而非补映射。若未来有人往 return 对象加 body/authorType,或把 lastComment 截断,
// 本测试必红——「契约里没有这两个字段」这一事实本身必须有个报警器,否则删除决策会在
// 无感知下被悄悄推翻。
// 历史:本测试最初是 #13 执行席的草稿(用 --scan 模式,而 --scan 精简输出按设计不含
// reviewThreads 全文,断言会红在错误位置,从未跑过);4e6a889 因编排误判被误删一次;
// 本版自 4daede9 修订捞回:改用 full 模式(node context.mjs <PR> 不带 --scan),
// 断言与映射真实输出对齐。isResolved:true 避免影响 unresolvedThreads 门计数。
const PROD_SHAPE_THREAD_NODES = [
  { id: 'PRRT_prod', isResolved: true, isOutdated: false, path: 'src/foo.ts',
    comments: { nodes: [
      { body: '这里调用了 `handleSubmit` 但缺少防抖。', author: { login: 'greptile-apps', __typename: 'Bot' }, id: 'c_prod_1' },
      { body: '补充:请用 `debounce` 包裹,连点会重复提交。'.repeat(40), author: { login: 'greptile-apps', __typename: 'Bot' }, id: 'c_prod_2' },
    ] } },
];

test('SC-2 生产形状锁定:reviewThreads 导出含 id/isResolved/isOutdated/path/author/isBot/count/lastComment,无 body/authorType,lastComment 全文透出', () => {
  // reviewThreads 全文只在 full 模式输出(--scan 精简模式按设计不含,见 context.mjs 头注)
  const { repo, env } = setup({ reviewThreadNodes: PROD_SHAPE_THREAD_NODES });
  const r = spawnSync('node', [SCRIPT, '469'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}`);
  const th = out.history?.reviewThreads?.[0];
  assert.ok(th, `reviewThreads[0] 应存在(fixture 注入生产形状节点): ${JSON.stringify(out.history?.reviewThreads)}`);
  // 生产契约字段(PR #13 R3 对照实验:旧 assessThreadEvidence 消费的 body/authorType 不在其中)
  assert.equal(th.id, 'PRRT_prod');
  assert.equal(th.isResolved, true);
  assert.equal(th.isOutdated, false);
  assert.equal(th.path, 'src/foo.ts');
  assert.equal(th.author, 'greptile-apps');
  assert.equal(th.isBot, true, 'Bot __typename 必须被识别');
  assert.equal(th.count, 2);
  // lastComment = 最后一条评论全文,不截断(SC-2:claim 文本不许截断)
  assert.equal(th.lastComment, '补充:请用 `debounce` 包裹,连点会重复提交。'.repeat(40));
  assert.equal('body' in th, false, '生产契约不得出现 body 字段(消费侧理想形状,曾造成假阴性)');
  assert.equal('authorType' in th, false, '生产契约不得出现 authorType 字段(消费侧理想形状)');
});

// F4(2026-08-09,round3):上一轮的「静态词条锁」(断言源码不含"既无 APPROVED"字面量)已删除
// ——换等价措辞(如"没有任何 APPROVED 审查且作者不在 admins")或拼接文本即可绿,锁的是文档
// 措辞不是审批行为。审批行为本身已由本文件其余用例以行为断言覆盖:auto.reason 必须携带
// approvedShortcut.reason(L1 用例)、note 不得沿用"缺 APPROVED"作唯一原因口径(第一个用例),
// 以及 SC-3 反例/正例对 approve 绑定 commit oid 的实际判定。

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
  // 缺失回退:目标仓 pr-rules.json 完全没配 mergeAuthorization(stripMergeAuthorization)
  // → resolveMergeAuthorizationPolicy 回退到 admins(含 PraiseZhu)作为 /approve-merge
  // 发令名单并产出 warning——名单成员人工 + 当前 head 的命令仍构成授权(兼容期语义,
  // 不再"未配置恒不授权")
  const { repo, env } = setup({ commentNodes: [{
    author: { login: 'PraiseZhu', __typename: 'User' },
    body: `/approve-merge ${HEAD}`,
    createdAt: '2026-08-04T11:00:00Z', updatedAt: '2026-08-04T11:00:00Z', url: 'c1',
  }], stripMergeAuthorization: true });
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

// ── C1 容器级接线(审 C1,2026-08-08):mergeAuthorization 非 plain object ──
// REVIEW_PR_RULES_FILE 指向 mergeAuthorization:"oops" 的配置,context --scan 必须
// 结构化输出 configWarnings(容器 warning 进报告),业务侧 fail-closed
// (breakGlass=[] → 紧急通道关闭),绝不脚本异常 exit1 + stack trace(旧实现
// `'require...' in "oops"` 在 context.mjs 模块加载期抛 TypeError 直接崩)。
test('C1 接线:mergeAuthorization:"oops" → context --scan 不崩,configWarnings 点名容器 object + 业务 fail-closed(旧代码 exit1 红)', () => {
  const { repo, env } = setup({ mergeAuth: 'oops' });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为结构化 JSON(不得脚本异常/stack trace),got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  assert.ok(Array.isArray(out.configWarnings), 'configWarnings 必须结构化输出进报告');
  assert.ok(out.configWarnings.some((w) => /mergeAuthorization 配置形态不合法/.test(w) && /object/.test(w)),
    `容器 warning 必须进 configWarnings: ${JSON.stringify(out.configWarnings)}`);
  // 业务 fail-closed:容器非法 → require 按 true、breakGlass=[] → 人工命令不路由紧急通道
  assert.equal(out.authorizedFastMerge.requested, false, 'breakGlass=[] → 紧急通道关闭(fail-closed,不回退 admins)');
  assert.notEqual(out.auto.action, 'authorized-fast-merge', '不得路由到 authorized-fast-merge');
});

// ── SC-1(2026-08-09):三门 hold 的真实可执行调用点 ──
// 意图:security-gate/rules-gate/arch-gate 此前只在 context.mjs 里"算出结论"就停,唯一
// 完整的调用形式停留在 SKILL.md 的 Markdown 示例——命中候选照样失联。本轮改为命中三门
// 之一时,context.mjs 真的 spawn 一次 signoff-hold.mjs --dry-run(脚本调脚本,不是注释/
// 文档示例)。以下用例锁住"真被调用"这件事本身可观测,不是靠读源码断言。

test('SC-1 接线:命中 securityReviewPaths → signoff-hold.mjs --dry-run 真被 spawn(脚本调脚本,非注释/文档示例)', () => {
  const { repo, env, ghLog } = setup({ securityReviewPaths: ['src/foo\\.ts'] });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  assert.equal(out.auto.action, 'security-gate', '命中 securityReviewPaths 且未放行 → 必须路由 security-gate');
  assert.ok(out.signoff?.holdInvocation, 'holdInvocation 字段必须存在');
  assert.equal(out.signoff.holdInvocation.kind, 'security', 'hold 调用的 kind 必须与命中门一致');
  assert.equal(out.signoff.holdInvocation.invoked, true, '命中三门之一时必须真的 spawn signoff-hold.mjs,不是空转');
  assert.equal(out.signoff.holdInvocation.dryRun, true);
  // 以下字段只有真的 spawn 了 signoff-hold.mjs 子进程、子进程真的跑完 --dry-run 分支才会
  // 出现——伪造/跳过调用点拿不到这些值,这是"真被调用"而非"声称被调用"的直接证据。
  assert.equal(out.signoff.holdInvocation.ok, true, 'signoff-hold.mjs 子进程必须真正执行并返回 ok:true');
  assert.equal(out.signoff.holdInvocation.pr, 469, '子进程读到的 PR 号必须与调用参数一致,证明真的解析了 CLI 参数而非硬编码/mock');
  assert.equal(out.signoff.holdInvocation.author, 'aj0928', '子进程必须真的读取了 fixture 里的 pr-view.json(author 字段),不是空转返回固定值');
  // 第二轮复审 m3 复盘:把 spawnScriptJson(SIGNOFF_HOLD_PATH, ...) 换成携带全部被断言
  // 字段的完整字面量仍能骗过以上所有字段断言(pr/author/missingPayload/renoticeSkipped/
  // labels.dryRun 都是"父进程在 fixture 已知时也能算出的值")——「真的 spawn 了子进程」
  // 这件事此前没有被任何断言锁住。以下字段是第二层弱证据(子进程真的执行了内部业务分支
  // 才会出现),保留:
  assert.equal(out.signoff.holdInvocation.missingPayload, true, '子进程必须真的算出 decideIssueReuse({priorIssueUrl:null}).needNewIssue=true 且未传 --payload-file 时 payloadComplete=false;字面量 bypass 没有这个字段');
  assert.equal(out.signoff.holdInvocation.renoticeSkipped, 'never-held', '子进程必须真的跑完 doRenotice() 的 priorIssueUrl==null 分支判定;字面量 bypass 没有这个字段');
  assert.equal(out.signoff.holdInvocation.labels?.dryRun, true, '子进程必须真的调用 syncSignoffLabel({want:true, current:[]})(fixture 无标签 → want!==has → dry-run 分支);字面量 bypass 没有这个字段');
  // F1(2026-08-09,round3):真正锁住「真的 spawn 了子进程」的是**外部副作用**断言——
  // fake gh 把每次调用记进 $FAKE_GH_LOG(JSONL,见 setup)。signoff-hold.mjs 子进程在
  // --dry-run 探测路径上唯一的 gh 调用是 `gh pr view`,且它的 --json 字段清单
  // (number,state,mergedAt,author,url,comments,labels,headRefOid)与父进程 context.mjs
  // 的 pr view 调用(--json 大清单 / --json reviews)不同——日志里出现该签名 = 只有真的
  // spawn 了子进程才会产生这条记录。
  // 判据边界(如实声明):本断言锁的是「一次移除 spawn 的重构会让测试转红」——把调用换成
  // 完整字面量 / 内联计算(典型重构形态)会红;而「伪造 gh 日志」需要 context.mjs 自己去
  // 追加日志文件,那已经不是重构而是刻意造假,超出本判据的能力承诺。
  const logLines = readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const childView = logLines.find((e) => e.args[0] === 'pr' && e.args[1] === 'view'
    && e.args.includes('--json')
    && e.args[e.args.indexOf('--json') + 1] === 'number,state,mergedAt,author,url,comments,labels,headRefOid');
  assert.ok(childView,
    `FAKE_GH_LOG 必须包含 signoff-hold.mjs 子进程的 gh pr view 调用(--json 含 comments,父进程 context.mjs 从不经 pr view 取 comments)。实际调用:\n${
      logLines.map((l) => JSON.stringify(l.args)).join('\n')}`);
});

test('SC-1 反向:未命中三门(auto.action 落 skip-structural-block)→ holdInvocation.invoked=false,不空转 spawn', () => {
  const { repo, env } = setup(); // 默认场景不配置 securityReviewPaths,走 skip-structural-block
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}`);
  assert.equal(out.auto.action, 'skip-structural-block');
  assert.equal(out.signoff.holdInvocation.invoked, false, '未命中三门时不应发起 hold 调用');
  assert.equal(out.signoff.holdInvocation.kind, null);
});

// ── F3(2026-08-09,round3):探测失败必须改变已消费的路由字段 ──
// 此前失败只追加 configWarnings,没有任何强制消费方读它、也不阻断、也不重试,正式 hold 仍
// 照 auto.action / suggestedHolds 继续——「连 hold 机制能不能调用都验证不了却继续放行」
// 是 fail-open,且 #12 本身就是接线 PR,这条必须在本 PR 关闭。改后行为:失败重试一次,重试
// 耗尽仍失败 → auto.action 升级为 signoff-hold-unavailable(人工介入类值,编排侧不存在把它
// 当 security-gate/rules-gate/arch-gate 静默继续的分支)。signoff-hold.mjs 的探测路径相对
// context.mjs 解析(new URL('./signoff-hold.mjs', import.meta.url)),要构造「模块不存在 /
// 输出非 JSON / 非零退出」三种失败形态,测试在临时目录重建一份最小脚本集(缺什么造什么),
// 不碰真实工作树。依赖链:context.mjs → lib.mjs → lib.escaped-hazards.mjs →
// lib.review-profiles.mjs + lib.preflight-rules.mjs(后两者只 import node 内置模块)。
const SCRIPTS_DIR = join(__dirname, '..', 'scripts');
function copyScriptsTo(work) {
  const dir = join(work, 'scripts');
  mkdirSync(dir);
  for (const f of ['context.mjs', 'lib.mjs', 'lib.escaped-hazards.mjs', 'lib.review-profiles.mjs', 'lib.preflight-rules.mjs']) {
    copyFileSync(join(SCRIPTS_DIR, f), join(dir, f));
  }
  return dir;
}

test('F3 接线:signoff-hold.mjs 模块不存在 → 探测(重试后)失败升级 auto.action=signoff-hold-unavailable(变异:移除联动即红)', () => {
  const { repo, env } = setup({ securityReviewPaths: ['src/foo\\.ts'] }); // 命中 security-gate
  const work = mkdtempSync(join(tmpdir(), 'ctx-f3-missing-'));
  const dir = copyScriptsTo(work); // 故意不复制 signoff-hold.mjs = 模块不存在(ENOENT)
  const r = spawnSync('node', [join(dir, 'context.mjs'), '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 500)}\nstderr=${r.stderr.slice(0, 500)}`);
  assert.equal(out.auto.action, 'signoff-hold-unavailable', 'hold 脚本缺失 → 路由必须升级为人工介入值,不得继续按 security-gate 静默路由');
  assert.equal(out.auto.isSkip, false, '升级不是跳过:必须显式停在人工介入');
  assert.equal(out.signoff.holdInvocation.invoked, false, '探测未成功 → invoked 必须如实 false');
  assert.equal(out.signoff.holdInvocation.ok, false);
  assert.equal(out.signoff.holdInvocation.kind, 'security', 'kind 仍是命中的门,方便排查');
  assert.match((out.configWarnings ?? []).join(';'), /signoff-hold-unavailable/, '升级事实必须写进 configWarnings(供排查)');
});

test('F3 接线:signoff-hold.mjs 输出非 JSON → 探测(重试后)失败升级 auto.action=signoff-hold-unavailable', () => {
  const { repo, env } = setup({ securityReviewPaths: ['src/foo\\.ts'] });
  const work = mkdtempSync(join(tmpdir(), 'ctx-f3-nonjson-'));
  const dir = copyScriptsTo(work);
  writeFileSync(join(dir, 'signoff-hold.mjs'), '#!/usr/bin/env node\nprocess.stdout.write("not-json-garbage\\n");\n');
  const r = spawnSync('node', [join(dir, 'context.mjs'), '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 500)}\nstderr=${r.stderr.slice(0, 500)}`);
  assert.equal(out.auto.action, 'signoff-hold-unavailable', '子进程输出非 JSON → 不得继续按 security-gate 静默路由');
  assert.equal(out.signoff.holdInvocation.invoked, false);
  assert.match(out.auto.reason, /signoff-hold.mjs 的 --dry-run 探测重试后仍失败/, 'reason 必须如实写重试后仍失败');
  assert.match((out.configWarnings ?? []).join(';'), /signoff-hold-unavailable/, '升级事实必须写进 configWarnings');
});

test('F3 接线:signoff-hold.mjs 子进程非零退出 → 探测(重试后)失败升级 auto.action=signoff-hold-unavailable', () => {
  const { repo, env } = setup({ securityReviewPaths: ['src/foo\\.ts'] });
  const work = mkdtempSync(join(tmpdir(), 'ctx-f3-exit1-'));
  const dir = copyScriptsTo(work);
  writeFileSync(join(dir, 'signoff-hold.mjs'), '#!/usr/bin/env node\nprocess.stderr.write("boom\\n");\nprocess.exit(1);\n');
  const r = spawnSync('node', [join(dir, 'context.mjs'), '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 500)}\nstderr=${r.stderr.slice(0, 500)}`);
  assert.equal(out.auto.action, 'signoff-hold-unavailable', '子进程非零退出 → 不得继续按 security-gate 静默路由');
  assert.equal(out.signoff.holdInvocation.invoked, false);
  assert.match(out.auto.reason, /signoff-hold.mjs 的 --dry-run 探测重试后仍失败/, 'reason 必须如实写重试后仍失败');
  assert.match((out.configWarnings ?? []).join(';'), /signoff-hold-unavailable/, '升级事实必须写进 configWarnings');
});

// ── F3 反向锁(2026-08-09,round4):探测失败必须重试一次 ──
// 复审实测:删掉第一个 spawn(第二处成为唯一调用)或删掉第二个 retry spawn,上述 20 个
// 接线测试仍 20/20 全绿——「失败重试一次」没有任何断言锁住(现有断言只锁"至少发生一次
// 子进程副作用",锁不住"两次尝试",也锁不住"重试成功不该升级")。本用例用假 signoff-hold.mjs
// 的状态机补上:第 1 次调用失败(瞬时噪声形态)、第 2 次成功,同时把每次子进程启动追加进
// PROBE_LOG(env 经 spawnScriptJson 原样继承,同 FAKE_GH_LOG 机制)。
//   删掉 retry spawn → 只有第 1 次调用 → 失败 → 升级 → action 断言红 + 计数 1 红;
//   删掉第一个 spawn → 剩下的调用成为"第 1 次"→ 失败 → 升级 → 两条断言同时红。
test('F3 反向锁:探测失败必须重试恰好一次且重试成功不升级(删第一个或第二个 spawn 均转红)', () => {
  const { repo, env } = setup({ securityReviewPaths: ['src/foo\\.ts'] }); // 命中 security-gate
  const work = mkdtempSync(join(tmpdir(), 'ctx-f3-retry-'));
  const dir = copyScriptsTo(work);
  const probeLog = join(work, 'probe.log');
  writeFileSync(join(dir, 'signoff-hold.mjs'), [
    '#!/usr/bin/env node',
    "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
    "const log = process.env.PROBE_LOG;",
    "if (!log) { process.stderr.write('missing PROBE_LOG\\n'); process.exit(2); }",
    "appendFileSync(log, 'invoked\\n');",
    "const n = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length : 1;",
    "if (n === 1) { process.stderr.write('transient boom\\n'); process.exit(1); }", // 第 1 次调用:失败
    "process.stdout.write(JSON.stringify({ ok: true, pr: Number(process.argv[2]) }));", // 第 2 次调用:成功
  ].join('\n'));
  const r = spawnSync('node', [join(dir, 'context.mjs'), '469', '--scan'],
    { cwd: repo, env: { ...env, PROBE_LOG: probeLog }, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 500)}\nstderr=${r.stderr.slice(0, 500)}`);
  const invocations = existsSync(probeLog) ? readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  assert.equal(invocations, 2, '探测失败必须重试恰好一次(共 2 次子进程尝试)——删掉重试 spawn 后只剩 1 次,本断言转红');
  assert.equal(out.auto.action, 'security-gate', '第 2 次尝试成功 → 瞬时失败不得升级为 signoff-hold-unavailable——删掉第一个 spawn 后,唯一调用变成第 1 次调用 → 失败 → 升级 → 本断言转红');
  assert.equal(out.signoff.holdInvocation.ok, true, '重试成功后 holdInvocation 必须如实取到成功结果,不是第一次失败的结果');
  assert.equal(out.signoff.holdInvocation.invoked, true, '重试成功 → invoked 如实 true');
});

// ── SC-3(2026-08-09):admins 放行判据绑 commit oid,不受 submittedAt 时序影响 ──
// 反例场景(dispatch 原文):head=3ae9ec…,review 绑定的 commit=a32ae3…(旧 head),即便
// review 的 submittedAt 晚于 latestCommitDate,只要 commit.oid 不等于当前 headRefOid,
// 就不构成放行——时间戳口径下"更晚提交的 Approve"曾被误判为已放行,新判据不认时间戳。
// 结构性补充:latestOpinionatedReviews 的 GraphQL 查询本就没有取 submittedAt 字段(见
// context.mjs GQL 模板),时序误判在查询层就已不可能重现,不只是判定逻辑层面的修复。

test('SC-3 反例:admins 在旧 commit(非当前 head)Approve → adminsApprovedCurrentHead=false(旧口径会误判为已放行)', () => {
  // 默认 setup():reviewAuthor='PraiseZhu'(admins 名单成员),approveOid=OLD(绑定旧 head)
  const { repo, env } = setup();
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}`);
  assert.equal(out.signoff.adminsApprovedCurrentHead, false, 'Approve 绑定旧 commit(非当前 head)不构成放行,即便时间戳更晚');
});

test('SC-3 正例:admins 在当前 head 上 Approve → adminsApprovedCurrentHead=true', () => {
  const { repo, env } = setup({ approveOid: HEAD, reviewAuthor: 'PraiseZhu' });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}`);
  assert.equal(out.signoff.adminsApprovedCurrentHead, true, 'admins 名单成员在当前 head 上 APPROVED → 必须放行');
});

// D6③(2026-08-09,round2 补测):GitHub 返回的 commit oid 大小写不保证与本地 git 输出一致,
// 判据必须做大小写规范化。以上两个用例的 HEAD/OLD 常量本身全小写,不构成大小写不一致场景——
// 去掉 .toLowerCase() 规范化后上面两个用例仍然全绿,测不出回归。本用例把 review 绑定的
// commit.oid 换成 HEAD 的大写形式,只有真的做了规范化比较才会判定为同一个 commit。
test('SC-3 大小写:review 绑定的 commit.oid 与 headRefOid 大小写不同(同一 commit)→ 仍须规范化后判定为放行', () => {
  const { repo, env } = setup({ approveOid: HEAD.toUpperCase(), reviewAuthor: 'PraiseZhu' });
  const r = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}`);
  assert.equal(out.signoff.adminsApprovedCurrentHead, true, 'commit.oid 大小写不同但指向同一 commit → 去掉大小写规范化就会误判为未放行');
});

// ── SC-4(2026-08-09):signoff 判据消除双头 ──
// scan 模式与全量模式此前各自独立构造一份 signoff 对象(triggers/suggestedHolds 逐字重复),
// 本轮改为共用同一个 signoffCore。以下静态锁住"只有一份推导逻辑",防止之后有人在某一个
// 模式里改了判据、另一个模式漏改,形成隐蔽双头。

// 第二轮复审 m7b:在全量模式的展开处多写一个 `suggestedHolds :`(冒号前加空格)——字面量
// `suggestedHolds:` 计数仍是 1(regex 没匹配到带空格的这处),`signoff: signoffCore,` /
// `...signoffCore,` 的引用检查也照样通过,但 scan 与全量两个模式实际输出的 suggestedHolds
// 值会不一致(双头判据的真实症状)。静态读源码字符串测不出"两个模式的实际产出是否一致",
// 改为真的跑两遍、深比较两次的真实输出值。
test('SC-4 行为锁:signoffCore 是唯一推导来源 —— scan 模式与全量模式实际输出的 suggestedHolds 必须完全一致', () => {
  const { repo, env } = setup({ securityReviewPaths: ['src/foo\\.ts'] }); // 命中 security → suggestedHolds 非空,才有区分力
  const rScan = spawnSync('node', [SCRIPT, '469', '--scan'], { cwd: repo, env, encoding: 'utf8' });
  const rFull = spawnSync('node', [SCRIPT, '469'], { cwd: repo, env, encoding: 'utf8' });
  let outScan = null, outFull = null;
  try { outScan = JSON.parse(rScan.stdout); } catch { /* fallthrough */ }
  try { outFull = JSON.parse(rFull.stdout); } catch { /* fallthrough */ }
  assert.ok(outScan, `scan 模式输出应为 JSON,got status=${rScan.status}\nstdout=${rScan.stdout.slice(0, 800)}`);
  assert.ok(outFull, `全量模式输出应为 JSON,got status=${rFull.status}\nstdout=${rFull.stdout.slice(0, 800)}`);
  assert.ok(outScan.signoff.suggestedHolds.length > 0, '本用例命中 security-gate,suggestedHolds 必须非空才有区分力');
  assert.deepEqual(outFull.signoff.suggestedHolds, outScan.signoff.suggestedHolds, '两个模式的 suggestedHolds 必须来自同一份 signoffCore,实际值不能不一致——不一致就是判据双头的直接证据');
});

// ── SC-2(2026-08-09,round2 改为行为锁):thread id 补字段 + claim/participants 数据契约 + lastComment 不截断 ──
// 第二轮复审 m5/m6:静态读源码字符串锁不住实际输出——
//   - m5:删掉导出里 `id: t.id ?? null` 这行映射,GraphQL 查询串本身没变,静态锁照样过,
//     但输出里再也没有 id 字段;
//   - m6:把 `.replace(/\r/g,'')` 换成 `.replace(/\r/g,'').slice(0,300)`,字面量 `clip(`
//     没出现,静态锁照样过,但输出被重新截断。
// 改为跑真实全量模式(history/reviewThreads 只在全量模式输出,--scan 不含)、断言输出的
// 实际字段值。同时验证 D7 新增的 claim/participants 字段确实被下游接收到——claim 必须取
// 线程**位置首条**评论(cs[0],F5 措辞更正:不是"bot 首条评论",选择器自身不识别 bot;
// 安全性由 human-thread 闸与 participants 闸共同保证),不能被 lastComment(线程最后一
// 条,#13 场景里常是人类异议回复)顶替,这是 #13 blocker 的数据契约根因修复。
// F2(2026-08-09,round3):GraphQL comments(first:50) 无分页——participants 只覆盖前 50
// 条评论。导出对象带显式截断标志(commentsFetched/commentsTotal/participantsTruncated),
// 截断时该字段不构成"无非白名单参与者"的完备判断依据(契约见 SKILL「三门 hold 接线」段)。
const REVIEW_THREAD_ID = 'PRRT_test_0001';
const REVIEW_THREAD_TAIL_MARKER = 'TAIL-MARKER-9f3c';
const REVIEW_THREAD_LAST_COMMENT = `${'X'.repeat(320)}${REVIEW_THREAD_TAIL_MARKER}`; // 336 字,超过 300 字截断阈值
const REVIEW_THREAD_NODES = [{
  id: REVIEW_THREAD_ID, isResolved: false, isOutdated: false, path: 'src/foo.ts',
  comments: { totalCount: 2, nodes: [
    // cs[0]:位置首条评论——claim 必须取这条
    { author: { login: 'coderabbitai', __typename: 'Bot' }, body: '这里疑似有空指针风险,建议加判空处理。', createdAt: '2026-08-04T09:00:00Z' },
    // cs[last]:人类的异议回复——lastComment 取这条,但绝不能被当成 claim
    { author: { login: 'PraiseZhu', __typename: 'User' }, body: REVIEW_THREAD_LAST_COMMENT, createdAt: '2026-08-04T10:00:00Z' },
  ] },
}];

test('SC-2 行为锁:reviewThreads 真实输出 id、claim(首条评论)、participants(全部作者+isBot)、lastComment(末条评论,超 300 字不截断)', () => {
  const { repo, env } = setup({ reviewThreadNodes: REVIEW_THREAD_NODES });
  const r = spawnSync('node', [SCRIPT, '469'], { cwd: repo, env, encoding: 'utf8' }); // 全量模式:history.reviewThreads 只在这里输出,--scan 不含
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  assert.equal(out.history.reviewThreads.length, 1);
  const thread = out.history.reviewThreads[0];
  // m5:id 必须是 GraphQL 返回的真实线程 id(fixture 值),不是"查询串里提到 id"这种静态巧合
  assert.equal(thread.id, REVIEW_THREAD_ID, 'reviewThreads[0].id 必须等于 GraphQL 返回的真实线程 id,不能只是查询串里出现过 id 字面量');
  // m6:lastComment 必须原样保留 320 字之后的尾标记,重新截断到 300 会把它切掉
  assert.equal(thread.lastComment.length, REVIEW_THREAD_LAST_COMMENT.length, 'lastComment 长度必须与原文一致(仅去 \\r,不截断)');
  assert.ok(thread.lastComment.endsWith(REVIEW_THREAD_TAIL_MARKER), `lastComment 必须原样透出超过 300 字的内容,尾标记不能被截断丢失。got tail=${thread.lastComment.slice(-40)}`);
  // D7:claim 取线程位置首条评论(cs[0]),不是 lastComment(人类异议回复)——两者必须是不同值
  assert.equal(thread.claim, '这里疑似有空指针风险,建议加判空处理。', 'claim 必须取线程首条评论原文,不能被 lastComment(线程最后一条)顶替');
  assert.notEqual(thread.claim, thread.lastComment, 'claim 与 lastComment 必须是两个不同字段/不同来源,不能退化成同一个值');
  // D7:participants 暴露评论作者 + isBot(覆盖范围 = 前 50 条评论,见 participantsTruncated),
  // 供下游按自己的白名单口径判断"是否有非白名单机器人的真人参与"
  assert.deepEqual(thread.participants, [
    { author: 'coderabbitai', isBot: true },
    { author: 'PraiseZhu', isBot: false },
  ], 'participants 必须包含线程内评论的 author+isBot(前 50 条),顺序与 GraphQL 返回一致');
  // F2:未截断(2 条 = totalCount 2)必须显式标 participantsTruncated=false,并透出数量
  assert.equal(thread.commentsFetched, 2, 'commentsFetched 必须等于实际取到的条数');
  assert.equal(thread.commentsTotal, 2, 'commentsTotal 必须透出 GraphQL totalCount');
  assert.equal(thread.participantsTruncated, false, 'fetched === total → 已知完备,必须显式 false');
});

test('SC-2 截断标志:评论超过 first:50 → participantsTruncated=true,participants 只含前 50 条(变异:去掉标志计算即红)', () => {
  // 第 51 条评论的作者不在 participants 里(第 1-50 条都是白名单 bot、第 51 条是真人时,
  // 静默的 participants 会漏掉它)——截断必须显式可观测,不许静默声称完备。
  const nodes50 = Array.from({ length: 50 }, (_, i) => ({
    author: { login: `bot-${i}`, __typename: 'Bot' }, body: `comment-${i}`, createdAt: '2026-08-04T09:00:00Z',
  }));
  const { repo, env } = setup({ reviewThreadNodes: [{
    id: 'PRRT_trunc_0001', isResolved: false, isOutdated: false, path: 'src/foo.ts',
    comments: { totalCount: 51, nodes: nodes50 }, // GraphQL 只返回 first:50,真实总条数 51
  }] });
  const r = spawnSync('node', [SCRIPT, '469'], { cwd: repo, env, encoding: 'utf8' }); // 全量模式
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  const thread = out.history.reviewThreads[0];
  assert.equal(thread.commentsFetched, 50, '映射只取到 GraphQL 返回的前 50 条');
  assert.equal(thread.commentsTotal, 51, 'totalCount 必须透出连接的真实总条数');
  assert.equal(thread.participantsTruncated, true, '50 < 51 → 必须显式标截断,不许静默声称 participants 完备');
  assert.equal(thread.participants.length, 50, 'participants 只覆盖前 50 条评论');
  assert.equal(thread.participants[49].author, 'bot-49', 'participants 内容 = 前 50 条评论的作者');
});

// ── R5(2026-08-10):嵌套超时双锁 + 默认值不变量 ──
// 复审席对照实验证实:共享默认 180s 下,假 signoff-hold sleep 1300ms 时子 --scan 确实进入
// 探测(holdProbeEntered=true),但父层先收到自己的超时错误——F3 的升级在 --scan-all 批量
// 路径对病理场景不可达。R5 修法:探测 spawn 显式传小超时(HOLD_PROBE_TIMEOUT_MS 默认 20s,
// env REVIEW_PR_HOLD_PROBE_TIMEOUT_MS 可调),外层 spawn 显式传 SCAN_CHILD_TIMEOUT_MS
// (默认 180s,env REVIEW_PR_SCAN_CHILD_TIMEOUT_MS 可调),「外层 ≥ 内层」成为代码里可见、
// 测试可验的配对。以下两条行为锁都走**真实 --scan-all** 生产路径(1 个候选 → mapPool
// Math.min(4,1)=1 并发退化,时长由单候选决定),不复制 setup 骨架(复制品会与 setup()
// 各自演化,种下「测试环境 ≠ 生产 fixture」的第六个实例)。
const SCAN_ALL_CANDIDATE = [{
  number: 469, title: 'fix: 扫描分类判定越界修复', author: 'aj0928',
  createdAt: '2026-08-04T10:00:00Z', isDraft: false, url: 'https://github.com/xindong/mivo-canvas/pull/469',
}];
// 挂起的假 signoff-hold:进入后永不退出——专门测「外层 kill 时子进程是否已输出升级」。
// 不 exit 1(R4-3 已覆盖 exit1);sleep 无穷大让探测超时/外层超时都由超时机制决定。
const HANGING_HOLD_SCRIPT = [
  '#!/usr/bin/env node',
  'process.stdout.write("holdProbeEntered\\n");', // 进探测即打标记(复审席对照实验同款)
  'setInterval(() => {}, 1 << 30);', // 永不退出
].join('\n');

test('R5 正向锁:探测挂起 → 探测小超时(200ms)让子 --scan 在 8s 外层内输出 signoff-hold-unavailable(删探测 timeoutMs 即红)', () => {
  const { repo, env } = setup({ securityReviewPaths: ['src/foo\\.ts'], prListNodes: SCAN_ALL_CANDIDATE }); // 命中 security-gate + 1 候选
  const work = mkdtempSync(join(tmpdir(), 'ctx-r5-fwd-'));
  const dir = copyScriptsTo(work);
  writeFileSync(join(dir, 'signoff-hold.mjs'), HANGING_HOLD_SCRIPT);
  // env 压低两端:探测 200ms(两次共 400ms),外层 8000ms(> 400ms → 升级来得及送达;余量 20×,
  // 全量并发下子进程启动开销不再吃掉余量 —— 2026-08-10 从 2000ms 上调,修全量并发下的间歇假红)
  const env2 = { ...env, REVIEW_PR_HOLD_PROBE_TIMEOUT_MS: '200', REVIEW_PR_SCAN_CHILD_TIMEOUT_MS: '8000' };
  const r = spawnSync('node', [join(dir, 'context.mjs'), '--scan-all'], { cwd: repo, env: env2, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  const cand = out.results?.find?.((x) => x.pr === 469);
  assert.ok(cand, `results 应含 469 候选,got ${JSON.stringify(out.results)}`);
  assert.equal(cand.ok, true, '探测重试耗尽 → 子进程应正常完成并输出升级(不是外层超时/泛化失败)');
  assert.equal(cand.auto?.action, 'signoff-hold-unavailable', '探测 2×200ms 超时耗尽 → 子 --scan 必须输出升级值');
  // 变异:删掉探测 spawn 的 timeoutMs → 探测回默认 180s → 升级需 360s > 外层 8000ms
  // → 子进程被外层 kill → cand.ok=false 泛化失败 → 本断言红。
});

test('R5 反向锁:外层超时(100ms)先于探测 → 候选为超时失败且错误串含配置值 100(删外层 timeoutMs 即红)', () => {
  const { repo, env } = setup({ securityReviewPaths: ['src/foo\\.ts'], prListNodes: SCAN_ALL_CANDIDATE });
  const work = mkdtempSync(join(tmpdir(), 'ctx-r5-rev-'));
  const dir = copyScriptsTo(work);
  writeFileSync(join(dir, 'signoff-hold.mjs'), HANGING_HOLD_SCRIPT);
  // 外层 100ms ≪ 探测 2×200ms=400ms → 外层必先 kill,子进程来不及输出升级
  const env2 = { ...env, REVIEW_PR_HOLD_PROBE_TIMEOUT_MS: '200', REVIEW_PR_SCAN_CHILD_TIMEOUT_MS: '100' };
  const r = spawnSync('node', [join(dir, 'context.mjs'), '--scan-all'], { cwd: repo, env: env2, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(out, `输出应为 JSON,got status=${r.status}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
  const cand = out.results?.find?.((x) => x.pr === 469);
  assert.ok(cand, `results 应含 469 候选,got ${JSON.stringify(out.results)}`);
  assert.equal(cand.ok, false, '外层 100ms 先 kill → 候选必须为失败(升级来不及送达)');
  assert.match(cand.error, /子进程超时\(100ms\)/, '错误串必须出现配置的外层超时值 100——证明用的确实是 env 配的值,不是别处碰巧超时');
  // 变异:删掉外层 spawn 的 timeoutMs → 外层回默认 180s > 探测 400ms → 升级送达
  // → cand.ok=true → 本断言红;或错误串变 180000 → match 红。
});

// 默认值不变量:行为测试用小值跑,锁不住出厂默认值本身——「外层 ≥ 内层」是出厂配置的
// 硬性要求,单独一条算术断言锁它(不设 env,直接 import 默认常量)。
// 边界(如实声明,不过度声称):余量 30s 只保证「探测单独不足以导致外层 kill」——
// 它**不声称子进程永不超时**:子进程还有 graphql(60s 显式超时)、diff 拉取等,叠加照样
// 能超外层,那是既有事实,也是外层超时失败不升级为 signoff-hold-unavailable(D 否决)的依据。
test('R5 默认值不变量:SCAN_CHILD_TIMEOUT_MS ≥ 2×HOLD_PROBE_TIMEOUT_MS + 30s(探测不是外层超时的原因)', async () => {
  // context.mjs 模块加载期就消费 prRules(loadRules 三级回退:env → 仓根 agent-use/docs
  // → skill config)。裸 import 时 REPO_ROOT 推导可能读到缺 titleTypes 的仓根副本
  // (cwd 敏感存量缺陷,已结案不修),必须显式指向权威 config 才有确定的默认值可断言。
  process.env.REVIEW_PR_RULES_FILE = join(__dirname, '..', 'config', 'pr-rules.json');
  const mod = await import('../scripts/context.mjs');
  const { HOLD_PROBE_TIMEOUT_MS, SCAN_CHILD_TIMEOUT_MS } = mod;
  assert.ok(Number.isFinite(HOLD_PROBE_TIMEOUT_MS) && HOLD_PROBE_TIMEOUT_MS > 0, '探测默认必须为正');
  assert.ok(Number.isFinite(SCAN_CHILD_TIMEOUT_MS) && SCAN_CHILD_TIMEOUT_MS > 0, '外层默认必须为正');
  assert.ok(
    SCAN_CHILD_TIMEOUT_MS >= 2 * HOLD_PROBE_TIMEOUT_MS + 30_000,
    `外层必须 ≥ 内层最坏(2×探测)+ 30s 余量(余量供子进程其余工作;本不变量不声称子进程永不超时,只声称探测不是超时的原因)。外层=${SCAN_CHILD_TIMEOUT_MS},2×探测=${2 * HOLD_PROBE_TIMEOUT_MS},需外层≥${2 * HOLD_PROBE_TIMEOUT_MS + 30_000}。变异:探测 20k→100k(需 230k>180k)或外层<70k 均转红`,
  );
});
