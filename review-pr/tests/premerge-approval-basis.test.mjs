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
import { buildDiffSnapshot } from '../scripts/lib.diff-snapshot.mjs';
import { computeLedgerHash } from '../scripts/lib.findings-ledger.mjs';
import { escapeSourceHash, knownHazardsHash, loadKnownHazards, hazardsForPaths } from '../scripts/lib.escaped-hazards.mjs';

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

function setup({ approveCommit, ownAckRequired = false, approveMergeComment = null, approver = 'PraiseZhu', reviewDecision = 'APPROVED', includeLatestReviews = true, includePageInfo = true, headFileContent = CLEAN_FILE, omitBaseRefOid = false, filesMeta, approveCommentIsBot = false, approveCommentEdited = false, loopManaged = false, breakGlassApprovers, requireAutomatedReview = false, authorLogin = 'aj0928', selfFixAuthor = false, mergeStateStatus }) {
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
  // wave0 delta(2026-08-08):mergeAuthorization 块可组合(ownAckRequired /
  // breakGlassApprovers / requireAutomatedReview),selfFixAuthors 供 self-merge 场景
  const mergeAuth = {
    ...(ownAckRequired ? { ownAccountApprovalRequiresAck: true } : {}),
    ...(breakGlassApprovers !== undefined ? { breakGlassApprovers } : {}),
    ...(requireAutomatedReview ? { requireAutomatedReviewForAutoMerge: true } : {}),
  };
  writeFileSync(rulesFile, JSON.stringify({
    admins: ['PraiseZhu', 'kirozeng', 'aj0928'],
    structuralBypassAllowlist: ['code_scanning', 'code_quality'],
    ...(Object.keys(mergeAuth).length ? { mergeAuthorization: mergeAuth } : {}),
    ...(selfFixAuthor ? { selfFixAuthors: [authorLogin] } : {}),
    // wave0 追加(2026-08-08):loop 托管 PR 场景需要 loopPrExclusion 配置 + 台账
    ...(loopManaged ? { loopPrExclusion: { titlePrefixes: ['[mivo] '], stateFile: 'history/loops/state.json', forceVerdict: 't2' } } : {}),
  }));
  writeFileSync(join(fixtures, 'pr-view.json'), JSON.stringify({
    title: loopManaged ? '[mivo] fix: 局部重绘交互升级' : 'feat(canvas): 局部重绘交互升级', body: '正文', state: 'OPEN',
    mergeable: 'MERGEABLE', mergeStateStatus: mergeStateStatus ?? 'BLOCKED', reviewDecision,
    isDraft: false,
    headRefOid: HEAD, baseRefName: 'main',
    ...(omitBaseRefOid ? {} : { baseRefOid: BASE }),
    // filesMeta:undefined = 正常清单;null = 整个 files 字段缺失;其它 = 原样写入(含非法形状)
    ...(filesMeta === undefined ? { files: [{ path: 'a.txt' }] } : (filesMeta === null ? {} : { files: filesMeta })),
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint + tsc + unit + logging', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'e2e kernel gate (new)', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  }));
  // wave0 追加:loop 台账(身份门槛,detectLoopExclusion 需要 cluster.pr === 469 才认定托管)
  if (loopManaged) {
    mkdirSync(join(repo, 'history', 'loops'), { recursive: true });
    writeFileSync(join(repo, 'history', 'loops', 'state.json'), JSON.stringify({
      clusters: { c1: { pr: 469 } },
    }));
  }
  writeFileSync(join(fixtures, 'graphql-threads.json'), JSON.stringify({
    data: {
      viewer: { login: 'PraiseZhu' },
      repository: { pullRequest: {
        author: { login: authorLogin },
        reviewThreads: { nodes: [] },
        comments: { nodes: approveComment ? [{
          author: { login: 'PraiseZhu', __typename: approveCommentIsBot ? 'Bot' : 'User' },
          body: approveComment,
          createdAt: '2026-08-04T11:00:00Z', updatedAt: approveCommentEdited ? '2026-08-04T12:00:00Z' : '2026-08-04T11:00:00Z', url: 'c1',
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

/** 落一条真实 current-head clean 回执(与 F4 同款:真实 lib 计算全部绑定值,不手编)。 */
function writeReceiptFor(f, bindings) {
  const code = `import { writeReviewReceipt } from ${JSON.stringify(new URL('../scripts/lib.mjs', import.meta.url).href)};
writeReviewReceipt(JSON.parse(process.env.RECEIPT_JSON));`;
  const r = spawnSync('node', ['--input-type=module', '-e', code], {
    cwd: f.repo,
    env: { ...f.env, RECEIPT_JSON: JSON.stringify({ pr: 469, headRefOid: f.head, verdict: 'clean', p0p1Count: 0, bindings }) },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
}

/** 现场重算与生产同一批绑定值(与 F4 同款)。 */
function liveBindings(f) {
  const snap = buildDiffSnapshot({ repoRoot: f.repo, baseRefOid: f.base, headOid: f.head, expectedPaths: ['a.txt'] });
  assert.equal(snap.complete, true, snap.reason);
  return {
    source: 'consume-review-output', schemaVersion: 'rro-1', outputHash: 'oh1-x',
    snapshotHash: snap.snapshotHash,
    ledgerHash: computeLedgerHash([]),
    escapeSourceHash: escapeSourceHash({ prBody: '正文', issueTexts: [], candidates: [] }),
    knownHazardsHash: knownHazardsHash(hazardsForPaths(loadKnownHazards(), ['a.txt'], 'xindong/mivo-canvas')),
  };
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
    approveMergeComment: '/approve-merge {CURRENT}', breakGlassApprovers: ['PraiseZhu'],
  });
  assert.equal(out.approvedShortcut.granted, true);
  assert.equal(out.structuralBypassReady, true);
});

test('D2 · 旧 SHA 的 /approve-merge 不解锁(head 绑定语义贯穿授权通道)', () => {
  const { out } = runCheck({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: `/approve-merge ${OLD_APPROVE_COMMIT}`, breakGlassApprovers: ['PraiseZhu'],
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
    approveMergeComment: '/approve-merge', breakGlassApprovers: ['PraiseZhu'],
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

test('F3 · 第 4 轮核验 BLOCKER:PR files 元数据缺失/非数组 → 快照判不完整,所有路由终拒且零 pr diff', () => {
  // 上一版把 m.files 缺失折成 expectedPaths:null——而 null 在 DiffSnapshot API 里表示
  // "不要互检",于是元数据整体不可用时快照反而 complete=true,互检被静默跳过。
  for (const [label, filesMeta] of [['files 字段整体缺失', null], ['files 非数组', 'not-an-array'], ['files 条目缺 path', [{ nope: 1 }]]]) {
    const { out, prDiffCalls } = runCheck({ approveCommit: CURRENT, filesMeta });
    assert.equal(out.securityGate.snapshotComplete, false, `${label}:快照必须判不完整`);
    assert.equal(out.securityGate.pass, false, label);
    assert.match(out.securityGate.reasons.join(';'), /元数据|不完整/, label);
    assert.equal(out.canMerge, false, label);
    assert.equal(out.selfMergeAvailable, false, label);
    assert.equal(out.structuralBypassReady, false, label);
    assert.equal(out.authorizedFastMergeAvailable, false, label);
    assert.deepEqual(prDiffCalls, [], `${label}:禁 gh pr diff 退路`);
  }
});

test('F4 · R7 第 4 轮核验 BLOCKER:clean 之后逃逸数据源/canonical hazard 内容变化 → premerge 现场重算把回执打 stale', () => {
  const f = setup({ approveCommit: CURRENT });
  const BIND = liveBindings(f);
  const check = () => JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f.repo, env: f.env, encoding: 'utf8' }).stdout);
  // 对照组:七项绑定全部匹配 → stage2Clean=true(证明下面两个失败不是"一律拒")
  writeReceiptFor(f, BIND);
  const ok = check();
  assert.equal(ok.receiptGate.escapeSourceHash, BIND.escapeSourceHash, 'premerge 必须现场重算逃逸数据源哈希(不是抄回执)');
  assert.equal(ok.receiptGate.knownHazardsHash, BIND.knownHazardsHash, 'premerge 必须现场重算 canonical hazard 哈希');
  assert.equal(ok.receiptGate.stage2Clean, true, `对照组应 stage2Clean:${ok.receiptGate.reasons.join(';')}`);
  // clean 之后 body/关联 issue 变了(回执绑的是当时的数据源)→ stale
  writeReceiptFor(f, { ...BIND, escapeSourceHash: escapeSourceHash({ prBody: '当时的另一份 body', issueTexts: [], candidates: [] }) });
  const drift1 = check();
  assert.equal(drift1.receiptGate.stage2Clean, false, 'body 内容漂移必须打 stale');
  assert.match(drift1.receiptGate.reasons.join(';'), /escapeSourceHash|stale|不一致/);
  // clean 之后 canonical 新增/改了命中路径的 hazard → stale
  writeReceiptFor(f, { ...BIND, knownHazardsHash: 'khh1-before-canonical-change' });
  const drift2 = check();
  assert.equal(drift2.receiptGate.stage2Clean, false, 'canonical hazard 内容漂移必须打 stale');
});

// ── automated-review-gate wave0 追加(2026-08-08):SC-3/SC-5 在合并闸的接线 + 四 basis 反向变异对 ──

test('I · 自动化不得授权(bot 评论发 /approve-merge <当前 head>)→ requested=false,fast-merge 不可用', () => {
  const { out } = runCheck({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: '/approve-merge {CURRENT}', approveCommentIsBot: true,
  });
  assert.equal(out.approvedShortcut.granted, false, 'bot 评论不构成 head 绑定授权');
  assert.equal(out.authorizedFastMergeAvailable, false, 'bot 评论不得打开紧急通道');
  assert.equal(out.structuralBypassReady, false);
});

test('I2 · 被编辑过的授权评论 → 拒绝且 editedAuthComments 显式输出(不能让人以为授权凭空消失)', () => {
  const { out } = runCheck({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: '/approve-merge {CURRENT}', approveCommentEdited: true,
    breakGlassApprovers: ['PraiseZhu'],
  });
  assert.equal(out.approvedShortcut.granted, false, 'edited 评论不得构成授权');
  assert.equal(out.authorizedFastMergeAvailable, false);
  assert.equal(out.editedAuthComments.length, 1, '被拒绝的已编辑授权评论必须显著报告');
});

test('I3 · Mivo 强制策略(requireAutomatedReviewForAutoMerge=true)+ loop 托管 + APPROVED@head + 无回执 → 一切自动化合并均不 ready(旧代码红)', () => {
  // 新语义(裁决 3):配置强制自动审查后,即便 GitHub APPROVED + current head + head 绑定
  // 授权,没有 current-head clean 回执,structuralBypassReady 不成立——自动化合并必须
  // 审查后落回执。approvedShortcut 仍是 GitHub approval 事实(granted=true 如实,裁决 3:
  // 删掉要求 granted=false 的错误断言),约束落在路由(review-pending-approved-bypass)与
  // 合并资格(回执门)。旧代码(只按 approvedShortcut 判 ready)→ true。
  const { out } = runCheck({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: '/approve-merge {CURRENT}', loopManaged: true, requireAutomatedReview: true,
    breakGlassApprovers: ['PraiseZhu'],
  });
  assert.equal(out.loopExclusion.matched, true, '前提:loop 身份必须被认定');
  assert.equal(out.approvedShortcut.granted, true, 'shortcut 是 GitHub approval 事实,强制策略不翻转它(裁决 3)');
  assert.equal(out.authorizedFastMergeAvailable, false, 'loop 托管 PR 无条件封死紧急通道');
  assert.match(out.authorizedFastMergeInfo.blockedReason, /loop-managed-pr-fast-merge-forbidden/);
  assert.equal(out.structuralBypassReady, false, '无 current-head clean 回执时 structural bypass 不得 ready(旧代码在此 true → 红)');
});

test('J · 四 basis 反向变异对(全链路):同一 fixture 只改一个维度,basis/shortcut 恰好翻转', () => {
  // J1:stale→own-account(approveOid 从旧 head 变当前 head)
  const stale = runCheck({ approveCommit: OLD_APPROVE_COMMIT });
  assert.equal(stale.out.approvalBasis.basis, 'stale');
  const fresh = runCheck({ approveCommit: CURRENT });
  assert.equal(fresh.out.approvalBasis.basis, 'own-account', '只改 approve 绑定 head → basis 必须翻转');
  // J2:own-account→independent(approver 从 viewer 变独立 reviewer)
  const own = runCheck({ approveCommit: CURRENT });
  assert.equal(own.out.approvalBasis.basis, 'own-account');
  const indep = runCheck({ approveCommit: CURRENT, approver: 'kirozeng' });
  assert.equal(indep.out.approvalBasis.basis, 'independent', '只改 approver → basis 必须翻转');
  // J3:shortcut granted→denied(reviewDecision 从 APPROVED 变 REVIEW_REQUIRED,approve 仍是 independent@head)
  const appr = runCheck({ approveCommit: CURRENT, approver: 'kirozeng' });
  assert.equal(appr.out.approvedShortcut.granted, true);
  const denied = runCheck({ approveCommit: CURRENT, approver: 'kirozeng', reviewDecision: 'REVIEW_REQUIRED' });
  assert.equal(denied.out.approvedShortcut.granted, false, '只改聚合裁决 → shortcut 必须翻转');
  assert.match(denied.out.approvedShortcut.reason, /github-review-decision-not-approved/);
  // J4:own-account + 配置开:无授权→有 head 绑定授权(granted 翻转,出路唯一)
  const noAck = runCheck({ approveCommit: CURRENT, ownAckRequired: true });
  assert.equal(noAck.out.approvedShortcut.granted, false);
  const ack = runCheck({ approveCommit: CURRENT, ownAckRequired: true, approveMergeComment: '/approve-merge {CURRENT}', breakGlassApprovers: ['PraiseZhu'] });
  assert.equal(ack.out.approvedShortcut.granted, true, 'head 绑定 /approve-merge 是 own-account 收紧的唯一出路');
});

// ── automated-review-gate wave0 delta(2026-08-08):Mivo 强制策略 + breakGlass 独立 + 三条路径回执对照 ──

test('K1 · requireAutomatedReviewForAutoMerge=true:approved(independent@head)+ 无回执 → bypass 不 ready(旧代码红);落回执后 ready', () => {
  const f = setup({ approveCommit: CURRENT, approver: 'kirozeng', requireAutomatedReview: true });
  const run = () => JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f.repo, env: f.env, encoding: 'utf8' }).stdout);
  const before = run();
  assert.equal(before.approvedShortcut.granted, true, 'shortcut 是 GitHub approval 事实,强制策略不翻转它(裁决 3)');
  assert.equal(before.structuralBypassReady, false, '无 current-head clean 回执 → 不 ready(旧代码 true → 红)');
  assert.equal(before.receiptGate.stage2Clean, false, '普通合并路径同样无回执不可合');
  // 落 current-head clean 回执后:自动化路径转 ready(强制审查下放行与否只看回执,
  // structuralRoute=review-pending-approved-bypass 要求 receiptClean)
  writeReceiptFor(f, liveBindings(f));
  const after = run();
  assert.equal(after.structuralBypassReady, true, '回执落定后 structural bypass ready(唯一凭证)');
  assert.equal(after.receiptGate.stage2Clean, true, '普通合并路径同样随回执转 ready');
  assert.equal(after.structuralBypassReady, true, '回执落定后 structural bypass ready 是唯一凭证(结构性 BLOCKED 场景)');
});

test('K1b · 对照组:requireAutomatedReviewForAutoMerge 未配置 → 现状兼容(approved@head 直接 ready,不需要回执)', () => {
  const { out } = runCheck({ approveCommit: CURRENT, approver: 'kirozeng' });
  assert.equal(out.approvedShortcut.granted, true);
  assert.equal(out.structuralBypassReady, true, '未配置强制审查时保持现状(既有仓库不受伤)');
});

test('K2 · 三条正常自动合路径回执对照:ordinary approved / admin-trust / self-merge 均无回执拒、current-head clean 回执放', () => {
  // ordinary approved(普通合并):receiptGate.stage2Clean 是 canMerge 的硬前置
  const f1 = setup({ approveCommit: CURRENT, approver: 'kirozeng' });
  let out = JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f1.repo, env: f1.env, encoding: 'utf8' }).stdout);
  assert.equal(out.receiptGate.stage2Clean, false, 'ordinary:无回执 → stage2 不 clean');
  writeReceiptFor(f1, liveBindings(f1));
  out = JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f1.repo, env: f1.env, encoding: 'utf8' }).stdout);
  assert.equal(out.receiptGate.stage2Clean, true, 'ordinary:current-head clean 回执 → stage2 clean');
  // admin-trust(structural 分级,作者在 admins 但 shortcut 不成立):回执是 ready 唯一凭证
  const f2 = setup({ approveCommit: OLD_APPROVE_COMMIT });
  out = JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f2.repo, env: f2.env, encoding: 'utf8' }).stdout);
  assert.equal(out.structuralBypassBasis, 'admin-trust');
  assert.equal(out.structuralBypassReady, false, 'admin-trust:无回执 → 不 ready');
  writeReceiptFor(f2, liveBindings(f2));
  out = JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f2.repo, env: f2.env, encoding: 'utf8' }).stdout);
  assert.equal(out.structuralBypassReady, true, 'admin-trust:current-head clean 回执 → ready');
  // self-merge(selfFixAuthors 自有 PR,viewer===作者):stage2 凭证是硬前置
  const f3 = setup({ approveCommit: CURRENT, authorLogin: 'PraiseZhu', selfFixAuthor: true, mergeStateStatus: 'CLEAN' });
  out = JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f3.repo, env: f3.env, encoding: 'utf8' }).stdout);
  assert.equal(out.selfMergeAvailable, false, 'self-merge:无回执 → 不可 self-merge');
  writeReceiptFor(f3, liveBindings(f3));
  out = JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f3.repo, env: f3.env, encoding: 'utf8' }).stdout);
  assert.equal(out.selfMergeAvailable, true, 'self-merge:current-head clean 回执 → 可 self-merge');
});

test('K3 · breakGlass 名单独立接线:admins 含成员但 breakGlassApprovers 不含 → 紧急通道不可用(旧代码红);反向可用', () => {
  // admins 含 PraiseZhu(发令者)+ breakGlassApprovers 只含 kirozeng → 新语义不授权
  const f1 = setup({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: '/approve-merge {CURRENT}', breakGlassApprovers: ['kirozeng'],
  });
  let out = JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f1.repo, env: f1.env, encoding: 'utf8' }).stdout);
  assert.equal(out.authorizedFastMergeAvailable, false, 'breakGlass 不含发令者 → 不可用(旧代码 admins 含 → true → 红)');
  assert.equal(out.authorizedFastMergeInfo, null, '无有效授权 → 无通道信息');
  // 反向:breakGlassApprovers 含 PraiseZhu → 可用(新旧实现都绿——本用例是行为对照)
  const f2 = setup({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: '/approve-merge {CURRENT}', breakGlassApprovers: ['PraiseZhu'],
  });
  out = JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f2.repo, env: f2.env, encoding: 'utf8' }).stdout);
  assert.equal(out.authorizedFastMergeAvailable, true, 'breakGlass 含发令者 + 机械前提过 → 可用');
  assert.ok(out.authorizedFastMergeInfo, '有效授权 → 通道信息非空');
  // 兼容期两组(裁决 1):缺失 breakGlassApprovers → 回退 admins(本 fixture admins 含
  // PraiseZhu)→ 通道可用 + 回退 warning;显式 [] → 关闭紧急通道。
  const f3 = setup({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: '/approve-merge {CURRENT}',
  });
  out = JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f3.repo, env: f3.env, encoding: 'utf8' }).stdout);
  assert.equal(out.authorizedFastMergeAvailable, true, '缺失 breakGlassApprovers → 兼容回退 admins,名单成员人工命令仍可用(裁决 1)');
  assert.match((out.configWarnings ?? []).join(';'), /breakGlassApprovers 未配置.*回退到 admins/, '兼容回退必须产出显式 warning');
  const f4 = setup({
    approveCommit: CURRENT, ownAckRequired: true,
    approveMergeComment: '/approve-merge {CURRENT}', breakGlassApprovers: [],
  });
  out = JSON.parse(spawnSync('node', [SCRIPT, '469'], { cwd: f4.repo, env: f4.env, encoding: 'utf8' }).stdout);
  assert.equal(out.authorizedFastMergeAvailable, false, 'breakGlassApprovers=[] 显式空名单 → 紧急通道关闭(fail-closed)');
  assert.equal(out.authorizedFastMergeInfo, null);
});
