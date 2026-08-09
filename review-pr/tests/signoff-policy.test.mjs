#!/usr/bin/env node
// signoff-policy.test.mjs — 确认门策略判定的回归:UI 测试路径过滤 + 讨论 issue 收尾/复用
// + 三门(security/arch/rules)触发/放行/重入 + signoff-hold 生产动作 + 排他锁语义。
//
// 为什么在 tests/ 并改用 node:test(round3 D5):本仓文档跑法是 `node --test
// "tests/*.test.mjs"`(见 tests/README.md),tests/ 下 46 个文件全是 node:test;
// 旧文件在 scripts/ 下手写 check()/eq() 计数,glob 命中不到——任何人按文档跑全量
// 测试,对 signoff 门得到 0 覆盖,且本仓无 CI 兜底。与其余 46 个文件保持一致。
//
// round3 增补:
//   - D2 陈旧判据:活 pid + 超 LOCK_STALE_MS 的锁可回收;mutation② 探针:死 pid +
//     新鲜 startedAt 的锁必须回收(isPidAlive 恒 true 会转红);
//   - D3 takeover:新鲜 takeover 残留必须阻塞等待(mutation① 探针:移除两阶段 takeover
//     会转红);超 TTL / round2 裸 pid 残留必须自愈;
//   - D5 解耦鉴别:legacy 清理失败不连坐 labelsOk(mutation③ 探针:回退解耦会转红,
//     旧版所有用例都传 current:[] 导致 legacy 分支从未失败过);
//   - #6 releaseHoldLock:非 ENOENT 的 unlink 失败必须带 unlinkError,不伪装
//     alreadyAbsent:true;
//   - #7 入口守卫失败(--preserve-symlinks-main)必须写 stderr,不再静默 fail-open;
//   - D6 stateful fake gh:三次真实子进程运行共享同一状态文件,端到端验证幂等 claim
//     (三次只建一份 issue)、重入复用旧 issue、renotice 按 head 去重。
//
// 跑:cd review-pr && node --test tests/signoff-policy.test.mjs

import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, cpSync,
  readFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isUiTestPath, UI_TEST_PATH_RE,
  issueNumberFromUrl, decideIssueReuse, shouldCloseDiscussionIssue,
  classifyGateHits, parseSignoffReleases, parseSignoffRenotices,
} from '../scripts/lib.mjs';
import {
  performIssueCreate, performStatusComment, performLabelSync, computeHeld,
  acquireHoldLock, releaseHoldLock, reconcileDuplicateHoldIssues,
  tryTakeoverStaleLock, GH_CALL_TIMEOUT_MS, LOCK_STALE_MS,
} from '../scripts/signoff-hold.mjs';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(TESTS_DIR, '..', 'scripts');

// ── ① UI 测试路径过滤(product 门确定性排除)──
// 必须命中(测试/mock/snapshot,零像素改动);路径形态按本仓(桌面端 apps/*/src/...)适配
test('signoff: 测试路径命中', () => {
  const TEST_PATHS = [
    'apps/desktop/src/renderer/components/__tests__/Button.test.tsx',
    'apps/desktop/src/renderer/components/Button.test.tsx',
    'apps/desktop/src/renderer/components/Button.spec.ts',
    'apps/desktop/src/renderer/__mocks__/electron.ts',
    'apps/desktop/src/renderer/components/__snapshots__/Button.test.tsx.snap',
    'apps/desktop/src/renderer/store/session.mock.ts',
    'apps/mobile/tests/screens/Home.tsx',
    'apps/mobile/test/setup.ts',
    'apps/desktop/src/renderer/mocks/handlers.ts',
    'apps/desktop/src/renderer/src/Panel.snap',
  ];
  for (const p of TEST_PATHS) assert.ok(isUiTestPath(p), `测试路径命中: ${p}`);
});

// 不得命中(生产文件;含「test 是子串但不是段/后缀」的对抗用例)
test('signoff: 生产路径不命中', () => {
  const PROD_PATHS = [
    'apps/desktop/src/renderer/components/Button.tsx',
    'apps/desktop/src/renderer/latest.ts',            // "test" 是 "latest" 的子串
    'apps/desktop/src/renderer/pages/contest.tsx',    // 同上
    'apps/desktop/src/renderer/sections/testimonials.tsx', // "test" 开头但非 .test. 后缀、非 test/ 段
    'apps/desktop/src/renderer/mockup/Preview.tsx',   // "mock" 开头但目录段是 mockup 不是 mocks
    'apps/desktop/src/renderer/utils/protest-banner.tsx',
    'docs/design-rules/cindy-design-system.md', // 设计系统文档必须继续触发产品门
    'apps/desktop/src/renderer/attestation.ts',
  ];
  for (const p of PROD_PATHS) assert.ok(!isUiTestPath(p), `生产路径不命中: ${p}`);
});

// 空值/怪值不炸
test('signoff: 空值/怪值不炸,正则可复用(无 g flag 状态残留)', () => {
  assert.ok(!isUiTestPath(''));
  assert.ok(!isUiTestPath(null));
  assert.ok(!UI_TEST_PATH_RE.global, 'UI_TEST_PATH_RE 不应带 g flag');
});

// ── ② issue URL 解析(只认本仓库)──
test('signoff: issueNumberFromUrl', () => {
  assert.equal(issueNumberFromUrl('acme/app', 'https://github.com/acme/app/issues/42'), 42, '本仓库 issue');
  assert.equal(issueNumberFromUrl('Acme/App', 'https://github.com/acme/app/issues/7'), 7, '大小写不敏感');
  assert.equal(issueNumberFromUrl('acme/app', 'https://github.com/other/repo/issues/42'), null, '跨仓库拒绝');
  assert.equal(issueNumberFromUrl('acme/app', 'https://github.com/acme/app/pull/42'), null, '非 issue 链接拒绝');
  assert.equal(issueNumberFromUrl('acme/app', 'not-a-url'), null, '垃圾输入拒绝');
  assert.equal(issueNumberFromUrl('acme/app', null), null, 'null 输入拒绝');
});

// ── ③ 讨论 issue 复用/新开判定(重入核心:重复 hold 不制造重复 issue)──
test('signoff: decideIssueReuse 复用/新开', () => {
  const URL = 'https://github.com/acme/app/issues/42';
  assert.deepEqual(
    decideIssueReuse({ priorIssueUrl: null, issueState: null }),
    { needNewIssue: true, reuseUrl: null, reason: 'never-held' }, '从未 hold → 新开');
  assert.deepEqual(
    decideIssueReuse({ priorIssueUrl: URL, issueState: 'OPEN' }),
    { needNewIssue: false, reuseUrl: URL, reason: 'prior-open' }, '旧 issue 仍 OPEN → 复用(重入不重复开)');
  assert.deepEqual(
    decideIssueReuse({ priorIssueUrl: URL, issueState: 'CLOSED' }),
    { needNewIssue: true, reuseUrl: null, reason: 'prior-closed' }, '旧 issue 已 CLOSED → 新开');
  assert.deepEqual(
    decideIssueReuse({ priorIssueUrl: URL, issueState: null }),
    { needNewIssue: false, reuseUrl: URL, reason: 'state-unknown-failsafe-reuse' }, 'state 查询失败 → fail-safe 复用旧链接');
  assert.equal(decideIssueReuse({}).reason, 'never-held', '无参调用等价从未 hold');
});

// ── ④ 讨论 issue 收尾判定(--no-longer-required 的触发条件)──
test('signoff: shouldCloseDiscussionIssue', () => {
  const HELD = { kind: 'product', issueUrl: 'https://github.com/acme/app/issues/42', issueNumber: 42, heldAt: '2026-08-01T00:00:00Z' };
  assert.ok(shouldCloseDiscussionIssue({ held: HELD, triggerCount: 0 }), 'hold 过 + 0 触发 → 关');
  assert.ok(!shouldCloseDiscussionIssue({ held: HELD, triggerCount: 1 }), 'hold 过 + 仍有触发 → 不关');
  assert.ok(!shouldCloseDiscussionIssue({ held: null, triggerCount: 0 }), '从未 hold → 无 issue 可关');
  assert.ok(!shouldCloseDiscussionIssue({}), '无参调用不关');
});

// ── ⑤ 三门触发判定(classifyGateHits:security / rules / arch-core 路径层事实)──
test('signoff: classifyGateHits 触发', () => {
  const MIVO_STYLE_PATHS = [
    'review-pr/scripts/context.mjs',       // security:review-pr 自身脚本
    'review-pr/SKILL.md',                  // security:脚本/文档同属安全面
    'agent-use/docs/pr-rules.json',        // security:配置
    '.github/workflows/ci.yml',            // security:CI workflow
    'AGENTS.md',                           // rules:规则文档
    'CLAUDE.md',                           // rules:规则文档
    'docs/dev-rules/coding.md',            // rules:前缀命中 + ruleMap 的 doc 本身
    'packages/core/src/index.ts',          // arch:corePaths
    'apps/desktop/src/main/index.ts',      // arch:corePaths
    'src/App.tsx',                         // 普通路径,三门都不命中
  ];
  const CFG = {
    securityReviewPaths: ['review-pr/', 'agent-use/docs/pr-rules.json', '\\.github/workflows/', '\\.github/actions/'],
    ruleFiles: { required: ['AGENTS.md', 'CLAUDE.md', 'docs/dev-rules/'], uiRequired: [], ruleMap: { 'docs/dev-rules/coding.md': ['packages/'] } },
    archCorePaths: ['packages/', 'cindy-protocol/', 'apps/desktop/src/main/', 'apps/desktop/src/preload/'],
  };
  const hits = classifyGateHits({ paths: MIVO_STYLE_PATHS, ...CFG });
  assert.ok(hits.security.includes('review-pr/scripts/context.mjs'), 'security 命中 review-pr 自身脚本');
  assert.ok(hits.security.includes('agent-use/docs/pr-rules.json'), 'security 命中 pr-rules.json');
  assert.ok(hits.security.includes('.github/workflows/ci.yml'), 'security 命中 CI workflow');
  assert.ok(hits.security.includes('review-pr/SKILL.md'), 'security 命中 SKILL.md(脚本/文档同属安全面)');
  assert.ok(!hits.security.includes('src/App.tsx'), 'security 不误伤普通路径');
  assert.ok(hits.rules.includes('AGENTS.md'), 'rules 命中 AGENTS.md');
  assert.ok(hits.rules.includes('CLAUDE.md'), 'rules 命中 CLAUDE.md');
  assert.ok(hits.rules.some((p) => p.startsWith('docs/dev-rules/')), 'rules 前缀命中');
  assert.ok(!hits.rules.includes('review-pr/SKILL.md') && hits.security.includes('review-pr/SKILL.md'),
    'rules 整路径相等:review-pr/SKILL.md 不在 required 清单 → 不命中 rules(仍命中 security)');
  assert.ok(!hits.rules.includes('src/App.tsx'), 'rules 不误伤普通路径');
  assert.ok(hits.archCore.includes('packages/core/src/index.ts'), 'arch 命中 packages/');
  assert.ok(hits.archCore.includes('apps/desktop/src/main/index.ts'), 'arch 命中 apps/desktop/src/main/');
  assert.ok(!hits.archCore.includes('src/App.tsx'), 'arch 不误伤普通路径');
  assert.ok(hits.ruleMapHits.some((h) => h.doc === 'docs/dev-rules/coding.md' && h.paths.includes('packages/core/src/index.ts')),
    'ruleMap 命中:packages/ 归属 docs/dev-rules/coding.md');
});

// 放行:门关闭(配置空)= 恒不触发 —— 「什么都没发生」要有对照组:同路径在门配置后命中、在门关闭时不命中
test('signoff: classifyGateHits 放行/边界语义', () => {
  const MIVO_STYLE_PATHS = ['review-pr/scripts/context.mjs', 'AGENTS.md', 'packages/core/src/index.ts', 'src/App.tsx'];
  const CFG = {
    securityReviewPaths: ['review-pr/', '\\.github/workflows/'],
    ruleFiles: { required: ['AGENTS.md'], uiRequired: [], ruleMap: {} },
    archCorePaths: ['packages/'],
  };
  const DISABLED = classifyGateHits({ paths: MIVO_STYLE_PATHS, securityReviewPaths: [], ruleFiles: null, archCorePaths: [] });
  assert.equal(DISABLED.security.length, 0, 'security 门未配置 → 恒不触发');
  assert.equal(DISABLED.rules.length, 0, 'rules 门未配置 → 恒不触发');
  assert.equal(DISABLED.archCore.length, 0, 'arch 门未配置 → 恒不触发');
  // required 前缀匹配不做 subset 放宽(目录前缀命中,近邻文件不命中)
  const NEAR = classifyGateHits({ paths: ['AGENTS.md.bak', 'docs/dev-rules2/x.md', 'packagesx/y.ts'], ...CFG });
  assert.equal(NEAR.rules.length, 0, 'exact 语义:AGENTS.md.bak 不命中 rules');
  assert.ok(!NEAR.rules.some((p) => p === 'docs/dev-rules2/x.md'), 'exact 语义:docs/dev-rules2/ 不是 docs/dev-rules/ 前缀');
  assert.ok(!NEAR.archCore.includes('packagesx/y.ts'), 'exact 语义:packagesx/ 不是 packages/ 前缀');
});

// ── ⑥ 通过标记 / 状态回帖解析(重入去重键)──
test('signoff: parseSignoffReleases / parseSignoffRenotices', () => {
  const RELEASED = parseSignoffReleases([
    '<!-- review-pr:signoff-release gates=security,rules by=dashhuang -->',
    '普通评论',
  ]);
  assert.equal(RELEASED.get('security')?.by, 'dashhuang', '通过标记解析:security');
  assert.equal(RELEASED.get('rules')?.via, 'release-marker', '通过标记解析:rules');
  assert.ok(!RELEASED.has('product'), '通过标记解析:未出现类别不记');
  assert.equal(parseSignoffReleases([]).size, 0, '通过标记解析:空输入不炸');

  const RENOTICED = parseSignoffRenotices([
    '<!-- review-pr:signoff-renotice head=abc123 -->',
    '<!-- review-pr:signoff-renotice head=ABC123 -->',  // 大小写归一,同一 head 只算一次
    '<!-- review-pr:signoff-renotice head=def456 -->',
  ]);
  assert.ok(RENOTICED.has('abc123') && RENOTICED.has('def456'), '回帖去重:head 归一');
  assert.equal(RENOTICED.size, 2, '回帖去重:同一 head 只回一次');
});

// ── ⑦ signoff-hold 生产动作(SC-3:真加载 signoff-hold.mjs 本体;SC-2:三件套 held 判据)──
// fake ghFn:记录每次调用的 args/opts,按 args 内容分发预设响应,不打真实 gh。
function makeFakeGh(handlers) {
  const calls = [];
  const ghFn = (args, opts) => {
    calls.push({ args, opts });
    for (const h of handlers) {
      if (h.match(args)) return h.result;
    }
    return { ok: true, stdout: '', stderr: '', status: 0 };
  };
  ghFn.calls = calls;
  return ghFn;
}
const isIssueCreate = (a) => a[0] === 'issue' && a[1] === 'create';
const isPrComment = (a) => a[0] === 'pr' && a[1] === 'comment';
const isLabelCreate = (a) => a[0] === 'label' && a[1] === 'create';
const isLabelPost = (a) => a[0] === 'api' && a.includes('-X') && a.includes('POST') && a.some((s) => /\/labels$/.test(s));
const isLegacyDelete = (a) => a[0] === 'api' && a.includes('-X') && a[a.indexOf('-X') + 1] === 'DELETE';

test('signoff: performIssueCreate 成功/失败', () => {
  const ghOk = makeFakeGh([{ match: isIssueCreate, result: { ok: true, stdout: 'https://github.com/acme/app/issues/99\n', stderr: '', status: 0 } }]);
  const r = performIssueCreate({ pr: 42, slug: 'acme/app', kind: 'product', author: 'alice', issueTitle: 'T', issueBody: 'B', ghFn: ghOk });
  assert.equal(r.issueCreated, true, 'issueCreated');
  assert.equal(r.issueUrl, 'https://github.com/acme/app/issues/99', 'issueUrl');
  assert.equal(r.issueError, null, 'issueError 为 null');
  assert.ok(ghOk.calls.some((c) => isIssueCreate(c.args)), '确实调用了 gh issue create');

  const ghFail = makeFakeGh([{ match: isIssueCreate, result: { ok: false, stdout: '', stderr: 'boom-create-failed', status: 1 } }]);
  const rf = performIssueCreate({ pr: 42, slug: 'acme/app', kind: 'product', author: 'alice', issueTitle: 'T', issueBody: 'B', ghFn: ghFail });
  assert.equal(rf.issueCreated, false, '失败:issueCreated=false');
  assert.equal(rf.issueUrl, null, '失败:issueUrl=null');
  assert.ok((rf.issueError ?? '').includes('boom-create-failed'), '失败:issueError 带原因');
});

test('signoff: performStatusComment 成功/失败', () => {
  const ghOk = makeFakeGh([{ match: isPrComment, result: { ok: true, stdout: '', stderr: '', status: 0 } }]);
  const r = performStatusComment({ pr: 42, slug: 'acme/app', kind: 'product', issueUrl: 'https://github.com/acme/app/issues/99', commentBody: '请看讨论', ghFn: ghOk });
  assert.equal(r.commented, true, 'commented');
  assert.equal(r.commentError, null, 'commentError 为 null');
  assert.ok(ghOk.calls.some((c) => isPrComment(c.args)), '确实调用了 gh pr comment');

  const ghFail = makeFakeGh([{ match: isPrComment, result: { ok: false, stdout: '', stderr: 'boom-comment-failed', status: 1 } }]);
  const rf = performStatusComment({ pr: 42, slug: 'acme/app', kind: 'product', issueUrl: 'https://github.com/acme/app/issues/99', commentBody: '请看讨论', ghFn: ghFail });
  assert.equal(rf.commented, false, '失败:commented=false');
  assert.ok(rf.commentError.includes('boom-comment-failed'), '失败:commentError 带原因');
});

// -- performLabelSync(SC-2 核心 fixture:issue+评论成功,标签 POST 失败)--
test('signoff: performLabelSync 成功', () => {
  const ghAllOk = makeFakeGh([
    { match: isLabelCreate, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isLabelPost, result: { ok: true, stdout: '', stderr: '', status: 0 } },
  ]);
  const rOk = performLabelSync({ owner: 'acme', repo: 'app', pr: 42, label: 'needs-discussion', current: [], ghFn: ghAllOk });
  assert.equal(rOk.changed, true, 'changed');
  assert.equal((rOk.errors ?? []).length, 0, '无 errors');
  assert.ok(!rOk.warning, '无 warning');
});

test('signoff: performLabelSync 标签 POST 失败 → errors+warning', () => {
  const ghPostFail = makeFakeGh([
    { match: isLabelCreate, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isLabelPost, result: { ok: false, stdout: '', stderr: 'label POST 失败:权限不足', status: 1 } },
  ]);
  const rFail = performLabelSync({ owner: 'acme', repo: 'app', pr: 42, label: 'needs-discussion', current: [], ghFn: ghPostFail });
  assert.equal(rFail.changed, false, 'changed=false');
  assert.ok((rFail.errors ?? []).length > 0, 'errors 非空(明确失败字段,不是只挂 warning)');
  assert.ok(!!rFail.warning, 'warning 也设置(可读提示)');
});

// round3 D5 鉴别:legacy 清理失败与 signoff 标签同步是两件事——legacy 失败只能走
// legacyErrors/legacyWarning,不得进 errors/warning(labelsOk 不被拖累)。
// 旧版三条变异全绿的根因:所有 performLabelSync 用例都传 current:[],legacy 分支
// 从未失败过。这条用例让 legacy 清理真失败。
test('signoff: D5 解耦——legacy 清理失败不连坐 labelsOk(mutation③ 探针)', () => {
  const ghLegacyFail = makeFakeGh([
    { match: isLabelCreate, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isLabelPost, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isLegacyDelete, result: { ok: false, stdout: '', stderr: 'legacy 清理 403', status: 1 } },
  ]);
  const r = performLabelSync({ owner: 'acme', repo: 'app', pr: 42, label: 'needs-discussion', current: ['need-whitelist'], ghFn: ghLegacyFail });
  assert.equal(r.changed, true, 'signoff 标签本身必须挂上');
  assert.equal((r.errors ?? []).length, 0, 'legacy 失败不得进 errors(否则 labelsOk 被拖成 false)');
  assert.ok(!r.warning, 'legacy 失败不得设置 warning');
  assert.ok((r.legacyErrors ?? []).length > 0, 'legacy 失败单独走 legacyErrors');
  assert.ok(!!r.legacyWarning, 'legacy 失败单独走 legacyWarning');
});

// -- computeHeld(SC-2:三件套全成功才 held;任一失败必须点名 heldBlockedBy,不是只挂侧信道)--
test('signoff: computeHeld 三件套全成功 → held', () => {
  const allGood = computeHeld({ issueCreated: true, priorIssueUrl: null, needIssue: true, commented: true, alreadyHeld: false, labelsOk: true });
  assert.equal(allGood.held, true);
  assert.deepEqual(allGood.heldBlockedBy, []);
});

test('signoff: computeHeld 标签失败 → held=false 点名 labels', () => {
  const labelFail = computeHeld({ issueCreated: true, priorIssueUrl: null, needIssue: true, commented: true, alreadyHeld: false, labelsOk: false });
  assert.equal(labelFail.held, false, 'held=false(不再是「失败不连坐」)');
  assert.ok(labelFail.heldBlockedBy.includes('labels'), 'heldBlockedBy 点名 labels');
  assert.ok(!labelFail.heldBlockedBy.includes('issue') && !labelFail.heldBlockedBy.includes('comment'),
    'heldBlockedBy 不误报 issue/comment');
});

test('signoff: computeHeld issue+评论都失败 → held=false 点名 issue+comment', () => {
  const issueAndCommentFail = computeHeld({ issueCreated: false, priorIssueUrl: null, needIssue: true, commented: false, alreadyHeld: false, labelsOk: true });
  assert.equal(issueAndCommentFail.held, false);
  assert.ok(issueAndCommentFail.heldBlockedBy.includes('issue'));
  assert.ok(issueAndCommentFail.heldBlockedBy.includes('comment'));
});

test('signoff: computeHeld 复用旧 issue(未新建/未新评论但曾 hold 过)→ held=true', () => {
  const reuseCase = computeHeld({ issueCreated: false, priorIssueUrl: 'https://github.com/acme/app/issues/7', needIssue: false, commented: false, alreadyHeld: true, labelsOk: true });
  assert.equal(reuseCase.held, true);
});

// ── ⑧ acquireHoldLock / releaseHoldLock 锁语义(D2/D3/D4:#6:token 归属、陈旧回收、
//     takeover 阻塞与自愈、unlink errno 区分)──
// 锁文件路径由 SIGNOFF_HOLD_LOCK_DIR + owner/repo/pr 决定,与 lockPathFor 同一规则。
function lockPath(lockDir, pr = 42) {
  return join(lockDir, `acme__app__${pr}.lock`);
}

// 拿一个必定已退出的子进程 pid(pid 不会在本测试窗口内被复用)。
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (r.pid == null) throw new Error('无法获取子进程 pid');
  return r.pid;
}

// 每个锁用例独立临时锁目录 + 独立 env,互不干扰;finally 里恢复 env 并清理目录。
function withLockDir(fn) {
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-lock-test-'));
  const prev = process.env.SIGNOFF_HOLD_LOCK_DIR;
  process.env.SIGNOFF_HOLD_LOCK_DIR = lockDir;
  try {
    return fn(lockDir);
  } finally {
    if (prev === undefined) delete process.env.SIGNOFF_HOLD_LOCK_DIR;
    else process.env.SIGNOFF_HOLD_LOCK_DIR = prev;
    rmSync(lockDir, { recursive: true, force: true });
  }
}

test('signoff: acquireHoldLock 首次获取 + 占用时超时(非总是成功,非静默)', () => withLockDir((lockDir) => {
  const l1 = acquireHoldLock('acme', 'app', 42);
  assert.equal(l1.acquired, true, '首次获取成功');
  assert.ok(typeof l1.token === 'string' && l1.token.length > 0, '首次获取带 token');

  // mutation④探测:同一把锁已被占用时,第二次获取(短 timeoutMs)必须超时失败,
  // 不能"总是拿到"——否则两个并发实例会同时认为自己持锁。
  const l2 = acquireHoldLock('acme', 'app', 42, { timeoutMs: 300 });
  assert.equal(l2.acquired, false, '占锁时第二次获取必须超时');
  assert.equal(l2.timeout, true, '超时结果标注 timeout');
  assert.equal(l2.needsIntervention, true, '超时结果标注 needsIntervention(非静默 held:false)');

  const rel = releaseHoldLock(l1);
  assert.equal(rel.released, true, '用真实 token 释放成功');
  assert.ok(!existsSync(l1.path), '释放后锁文件已删除');

  const l3 = acquireHoldLock('acme', 'app', 42);
  assert.equal(l3.acquired, true, '释放后可重新获取(锁未被误判永久占用)');
  releaseHoldLock(l3);

  const relAbsent = releaseHoldLock(l3);
  assert.equal(relAbsent.alreadyAbsent, true, '对已释放的锁重复释放 → alreadyAbsent=true');
}));

test('signoff: releaseHoldLock 校验 token 归属(伪造 token 不能删别人的锁)', () => withLockDir((lockDir) => {
  const l1 = acquireHoldLock('acme', 'app', 42);
  const forged = { ...l1, token: 'not-the-real-token' };
  const relForged = releaseHoldLock(forged);
  assert.equal(relForged.notOwner, true, 'token 不匹配 → notOwner=true');
  assert.equal(relForged.released, false, 'token 不匹配 → released=false');
  assert.ok(existsSync(l1.path), 'token 不匹配 → 锁文件未被删除');
  releaseHoldLock(l1);
}));

test('signoff: D2 陈旧判据——活 pid + 超 LOCK_STALE_MS 的锁可回收(纯 pid 判定会永久死锁)', () => withLockDir((lockDir) => {
  // R2 判据 stale=!isPidAlive:活 pid 永不过期,而 readLockInfo 对合法 JSON 恒返回
  // 非 null,mtime 兜底永远走不到 → 锁永久不可回收。本轮加回时间上限后必须可回收。
  const path = lockPath(lockDir);
  writeFileSync(path, JSON.stringify({
    pid: process.pid,
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 超过 5 分钟阈值
    token: 'old',
  }));
  const l = acquireHoldLock('acme', 'app', 42, { timeoutMs: 1500 });
  assert.equal(l.acquired, true, '活 pid 但持有超时 → 必须判陈旧并回收(D2)');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, l.token, '回收后是带新 token 的新锁');
  releaseHoldLock(l);
}));

test('signoff: mutation②探针——死 pid + 新鲜 startedAt 的锁必须回收(isPidAlive 恒 true 会转红)', () => withLockDir((lockDir) => {
  // 死 pid 已足够判陈旧(pid 子句);新鲜 startedAt 保证时间子句不生效——
  // 若 isPidAlive 被写成恒 true,锁将不可回收,本用例转红。
  const path = lockPath(lockDir);
  writeFileSync(path, JSON.stringify({
    pid: deadPid(),
    startedAt: new Date().toISOString(),
    token: 'x',
  }));
  const l = acquireHoldLock('acme', 'app', 42, { timeoutMs: 1500 });
  assert.equal(l.acquired, true, '死 pid 必须判陈旧并回收');
  releaseHoldLock(l);
}));

test('signoff: mutation①探针——stale 主锁 + 新鲜 takeover 残留必须等待不抢(移除两阶段 takeover 会转红)', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  writeFileSync(path, JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString(), token: 'x' })); // stale 主锁
  writeFileSync(`${path}.takeover`, JSON.stringify({ startedAt: new Date().toISOString(), token: 'another-instance' })); // 另一实例正在接管
  const l = acquireHoldLock('acme', 'app', 42, { timeoutMs: 800 });
  assert.equal(l.acquired, false, '别人正在接管时不得抢锁');
  assert.equal(l.timeout, true, '接管阻塞 → 超时退让');
  assert.equal(JSON.parse(readFileSync(`${path}.takeover`, 'utf8')).token, 'another-instance', '接管残留必须原样保留(不得被清理/覆盖)');
}));

test('signoff: D3 自愈——超 TTL 的 takeover 残留清理后重试,不永久堵死', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  writeFileSync(path, JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString(), token: 'x' }));
  writeFileSync(`${path}.takeover`, JSON.stringify({
    startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 超过 60s TTL
    token: 'stale-takeover',
  }));
  const l = acquireHoldLock('acme', 'app', 42, { timeoutMs: 1500 });
  assert.equal(l.acquired, true, '超 TTL 残留必须自愈回收');
  assert.ok(!existsSync(`${path}.takeover`), '残留必须被清理');
  releaseHoldLock(l);
}));

test('signoff: D3 自愈——round2 裸 pid 格式的 takeover 残留同样自愈', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  writeFileSync(path, JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString(), token: 'x' }));
  writeFileSync(`${path}.takeover`, String(deadPid())); // round2 写的是裸 pid,连 TTL 都无从算
  const l = acquireHoldLock('acme', 'app', 42, { timeoutMs: 1500 });
  assert.equal(l.acquired, true, '裸 pid 残留(无法解析 TTL)必须按可清理残留处理');
  releaseHoldLock(l);
}));

test('signoff: #6 releaseHoldLock 非 ENOENT unlink 失败必须带 unlinkError,不伪装 alreadyAbsent', () => withLockDir((lockDir) => {
  const l = acquireHoldLock('acme', 'app', 42);
  assert.equal(l.acquired, true);
  chmodSync(lockDir, 0o500); // 目录不可写 → unlink 必 EACCES(≠ 文件不存在)
  try {
    const r = releaseHoldLock(l);
    assert.equal(r.released, false, '删除失败不得报 released');
    assert.equal(r.alreadyAbsent, false, 'EACCES 不是「已缺席」');
    assert.ok(r.unlinkError, '必须带 unlinkError');
  } finally {
    chmodSync(lockDir, 0o700); // 恢复可写,否则清理不掉临时目录
  }
}));

// ── ⑨ stateful fake gh(round3 D6)──
// 共享状态文件 $FAKE_GH_STATE:第二个进程能看到第一个进程写下的 issue/评论/标签。
// 无状态 fake gh 的 pr view 恒返回空,测试分不清「锁生效所以只建一份」与「锁失效
// 但 fake gh 看不见」;幂等 claim / 重入复用旧 issue / renotice 去重必须靠共享状态
// 才拿得到端到端真覆盖。
const FAKE_GH_STATEFUL_SRC = `#!/usr/bin/env node
// stateful fake gh(round3 D6):状态存 $FAKE_GH_STATE 共享 JSON——第二个进程能看到
// 第一个进程写下的 issue/评论/标签。FAKE_GH_FAIL_LABEL_ADD=1 时标签添加恒失败,
// 用于 labelsOk 判别。
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const STATE = process.env.FAKE_GH_STATE;
const load = () => {
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    return { issueSeq: 0, issues: {}, comments: [], labels: [], headOid: 'deadbeef', ...s };
  }
  catch { return { issueSeq: 0, issues: {}, comments: [], labels: [], headOid: 'deadbeef' }; }
};
const save = (s) => writeFileSync(STATE, JSON.stringify(s));
if (args[0] === 'pr' && args[1] === 'view') {
  const s = load();
  const num = Number(args[2]);
  process.stdout.write(JSON.stringify({
    number: num, state: 'OPEN', mergedAt: null,
    author: { login: 'tester' }, url: 'https://github.com/acme/app/pull/' + num,
    comments: s.comments.filter((c) => c.pr === num).map((c) => ({ body: c.body })),
    labels: s.labels.filter((l) => l.pr === num).map((l) => ({ name: l.name })),
    headRefOid: s.headOid,
  }));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'create') {
  // round4 D3:竞态屏障(仅 FAKE_GH_RACE_BARRIER 设置时)——两个并发进程都到 create 点
  // 后一起放行,用于真并发 e2e:无锁(mutation 删掉 acquireHoldLock 接线)时双方都到达
  // → 必然双写(测试转红);有锁时第二个进程根本到不了 create(锁互斥),第一个进程
  // 等满短超时(1200ms)放行,只增加少量测试时长。
  if (process.env.FAKE_GH_RACE_BARRIER) {
    appendFileSync(process.env.FAKE_GH_RACE_BARRIER + '/arrivals', process.pid + '\\n');
    const deadline = Date.now() + 1200;
    while (true) {
      const arrivals = readFileSync(process.env.FAKE_GH_RACE_BARRIER + '/arrivals', 'utf8')
        .trim().split('\\n').filter(Boolean).length;
      if (arrivals >= 2 || Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const s = load();
  s.issueSeq += 1;
  s.issues[s.issueSeq] = { state: 'OPEN' };
  save(s);
  process.stdout.write('https://github.com/acme/app/issues/' + s.issueSeq + '\\n');
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') {
  const s = load();
  const num = Number(args[2]);
  const st = s.issues[num] ? s.issues[num].state : (process.env.FAKE_GH_ISSUE_STATE || 'OPEN');
  process.stdout.write(JSON.stringify({ state: st }));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'close') {
  const s = load();
  const num = Number(args[2]);
  if (s.issues[num]) s.issues[num].state = 'CLOSED';
  save(s);
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'comment') {
  const s = load();
  const bodyIdx = args.indexOf('--body');
  const body = bodyIdx >= 0 ? args[bodyIdx + 1] : readFileSync(0, 'utf8');
  s.comments.push({ pr: Number(args[2]), body });
  save(s);
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  const s = load();
  s.comments.push({ pr: Number(args[2]), body: readFileSync(0, 'utf8') });
  save(s);
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'create') process.exit(0);
if (args[0] === 'api' && args.includes('-X')) {
  const x = args.indexOf('-X');
  const method = args[x + 1];
  const m = (args[x + 2] || '').match(/issues\\/(\\d+)\\/labels(?:\\/([^/]+))?$/);
  if (!m) { process.stderr.write('unexpected api call: ' + args.join(' ')); process.exit(1); }
  const num = Number(m[1]);
  if (method === 'POST') {
    if (process.env.FAKE_GH_FAIL_LABEL_ADD === '1') {
      process.stderr.write('HTTP 403: mock label-add failure'); process.exit(1);
    }
    const s = load();
    const f = args[args.indexOf('-f') + 1] || '';
    const name = m[2] || f.replace(/^labels\\[\\]=/, '');
    s.labels.push({ pr: num, name });
    save(s);
    process.exit(0);
  }
  if (method === 'DELETE') {
    const s = load();
    s.labels = s.labels.filter((l) => !(l.pr === num && l.name === m[2]));
    save(s);
    process.exit(0);
  }
}
process.stderr.write('unexpected gh call: ' + args.join(' '));
process.exit(1);
`;

// signoff-hold.mjs 的完整本地依赖闭包(递归解析 `from '...'`,便于带空格/中文路径场景
// 复制到新目录时不缺文件而 ERR_MODULE_NOT_FOUND):
//   signoff-hold.mjs -> lib.mjs -> lib.escaped-hazards.mjs -> lib.review-profiles.mjs,
//   lib.preflight-rules.mjs
const LOCAL_DEPS = [
  'signoff-hold.mjs', 'lib.mjs', 'lib.escaped-hazards.mjs',
  'lib.review-profiles.mjs', 'lib.preflight-rules.mjs',
];

function makeStatefulShimDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-stateful-'));
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, FAKE_GH_STATEFUL_SRC);
  chmodSync(ghPath, 0o755);
  return dir;
}

function makeTempRepoDir() {
  const dir = mkdtempSync(join(tmpdir(), 'signoff-hold-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: dir });
  mkdirSync(join(dir, 'agent-use', 'docs'), { recursive: true });
  writeFileSync(join(dir, 'agent-use', 'docs', 'pr-rules.json'), '{}');
  return dir;
}

// 以真实子进程跑 `node <scriptPath> <args>`,fake gh 走 stateful shim,记录调用到
// logPath。返回 { status, stdout, stderr, calls, parsed }。
function runSignoff({ scriptPath, args, repoDir, shimDir, logPath, statePath, extraEnv = {}, timeout = 15000 }) {
  const r = spawnSync('node', [scriptPath, ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      FAKE_GH_LOG: logPath,
      FAKE_GH_STATE: statePath,
      ...extraEnv,
    },
    timeout,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON,parsed 保持 null 交调用方判失败 */ }
  const calls = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, parsed };
}

// ── ⑩ 入口守卫(D1/mutation②:isMainModule 必须用 realpathSync 归一化比较,不是
//     import.meta.url 与 argv[1] 的裸字符串比较)——
//     symlink / 带空格路径 / 中文路径三种变体下,脚本都必须真正跑到主流程并调用 gh,
//     而不是静默 fail-open(退出码 0、零 gh 调用、空输出)。--
function runEntryGuardVariant(scriptPath) {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  try {
    return runSignoff({ scriptPath, args: ['42', '--dry-run'], repoDir, shimDir, logPath: join(shimDir, 'gh-calls.log'), statePath });
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
}

function assertEntryGuardRan(r, label) {
  assert.equal(r.status, 0, `${label}:退出码 0(非 fail-open) stderr=${r.stderr}`);
  assert.ok(r.calls.some((c) => c[0] === 'pr' && c[1] === 'view'), `${label}:确实调用了 gh pr view`);
  assert.equal(r.parsed?.ok, true, `${label}:stdout 是合法 JSON 且 ok=true`);
}

test('signoff: 入口守卫-直接调用(基线)', () => {
  assertEntryGuardRan(runEntryGuardVariant(join(SCRIPTS_DIR, 'signoff-hold.mjs')), '直接调用');
});

test('signoff: 入口守卫-symlink 调用(realpathSync 穿透符号链接)', () => {
  const linkDir = mkdtempSync(join(tmpdir(), 'signoff-hold-symlink-'));
  const linkPath = join(linkDir, 'signoff-hold-link.mjs');
  symlinkSync(join(SCRIPTS_DIR, 'signoff-hold.mjs'), linkPath);
  try {
    assertEntryGuardRan(runEntryGuardVariant(linkPath), 'symlink 调用');
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
});

test('signoff: 入口守卫-带空格路径(percent-encode 归一)', () => {
  const spaceDir = mkdtempSync(join(tmpdir(), 'signoff hold space '));
  for (const f of LOCAL_DEPS) cpSync(join(SCRIPTS_DIR, f), join(spaceDir, f));
  try {
    assertEntryGuardRan(runEntryGuardVariant(join(spaceDir, 'signoff-hold.mjs')), '带空格路径');
  } finally {
    rmSync(spaceDir, { recursive: true, force: true });
  }
});

test('signoff: 入口守卫-中文路径(percent-encode 归一)', () => {
  const cjkDir = mkdtempSync(join(tmpdir(), 'signoff-hold-cjk-'));
  const cjkTarget = join(cjkDir, '签收保持中文目录');
  mkdirSync(cjkTarget, { recursive: true });
  for (const f of LOCAL_DEPS) cpSync(join(SCRIPTS_DIR, f), join(cjkTarget, f));
  try {
    assertEntryGuardRan(runEntryGuardVariant(join(cjkTarget, 'signoff-hold.mjs')), '中文路径');
  } finally {
    rmSync(cjkDir, { recursive: true, force: true });
  }
});

test('signoff: D4 入口守卫误判(--preserve-symlinks-main)必须 stdout JSON 错误 + 非零退出,不再静默 fail-open', () => {
  // round3 实测:该场景 exit=0、零 gh 调用、stdout 空——自动化消费方按脚本自声明的
  // 「stdout 输出 JSON」契约,会把空 stdout 当成「成功但无结果」,hold 动作从未执行
  // 却没人知道。round4 修复:守卫误判 → stdout 输出 {ok:false, error:...} + 退出码 1。
  const plDir = mkdtempSync(join(tmpdir(), 'signoff-hold-preserve-symlinks-'));
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  const logPath = join(shimDir, 'gh-calls.log');
  try {
    // 依赖闭包放在 symlink 旁边:--preserve-symlinks-main 下相对 import 按 symlink 目录解析
    for (const f of LOCAL_DEPS.filter((x) => x !== 'signoff-hold.mjs')) cpSync(join(SCRIPTS_DIR, f), join(plDir, f));
    symlinkSync(join(SCRIPTS_DIR, 'signoff-hold.mjs'), join(plDir, 'signoff-hold.mjs'));
    const r = spawnSync('node', ['--preserve-symlinks-main', join(plDir, 'signoff-hold.mjs'), '42', '--dry-run'], {
      cwd: repoDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, FAKE_GH_LOG: logPath, FAKE_GH_STATE: statePath },
      timeout: 15000,
    });
    assert.notEqual(r.status, 0, `守卫误判必须非零退出,实际 status=${r.status} stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON */ }
    assert.ok(parsed && parsed.ok === false, `stdout 必须是 {ok:false} JSON,实际:${JSON.stringify(r.stdout)}`);
    assert.equal(parsed.error, 'entry-guard-misclassified', `error 字段点明误判,实际:${JSON.stringify(r.stdout)}`);
    const ghCalls = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : [];
    assert.equal(ghCalls.length, 0, '守卫误判时不得发起任何 gh 调用(没有静默执行半套流程)');
  } finally {
    rmSync(plDir, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('signoff: D4 合法 import 路径完全静默(不输出任何东西)', () => {
  // 被 import(如测试运行器 / 调用方脚本)时 argv[1] 是别的文件,守卫分支不报警、
  // 无输出——这是正常形态,输出任何东西都会污染消费方的 stdout 契约。
  const importDir = mkdtempSync(join(tmpdir(), 'signoff-import-silent-'));
  try {
    for (const f of LOCAL_DEPS) cpSync(join(SCRIPTS_DIR, f), join(importDir, f));
    writeFileSync(join(importDir, 'importer.mjs'),
      "import { acquireHoldLock } from './signoff-hold.mjs';\nconsole.log(typeof acquireHoldLock);\n");
    const r = spawnSync(process.execPath, [join(importDir, 'importer.mjs')], {
      cwd: importDir, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal((r.stdout ?? '').trim(), 'function',
      `import 路径必须静默加载成功(无守卫噪音/无主流程输出),实际 stdout=${JSON.stringify(r.stdout)}`);
  } finally {
    rmSync(importDir, { recursive: true, force: true });
  }
});

// ── ⑪ labelsOk 判别(mutation③:main() 里 labelsOk 不能被写死成 true)──
// 真实子进程 + stateful fake gh:pr view / issue create / pr comment / label create 全
// 放行,只让 label add(api POST .../labels)失败 → labels.warning 为真、held=false、
// heldBlockedBy 点名 labels。
test('signoff: labelsOk 判别——标签 POST 失败 → held=false 点名 labels(mutation③ 探针)', () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-lock-labelfail-'));
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  const logPath = join(shimDir, 'gh-calls.log');
  const payloadPath = join(repoDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify({
    issueTitle: '讨论:labelsOk 判别测试专用 issue',
    issueBody: '本 issue 由 signoff-policy.test.mjs 的 labelsOk 判别测试自动创建。',
    commentBody: '本 PR 待维护者确认,详情见关联 issue。',
  }));
  try {
    const r = runSignoff({
      scriptPath: join(SCRIPTS_DIR, 'signoff-hold.mjs'),
      args: ['42', '--payload-file', payloadPath],
      repoDir, shimDir, logPath, statePath,
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, FAKE_GH_FAIL_LABEL_ADD: '1' },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const labelAddCalled = r.calls.some((c) => c[0] === 'api' && c.includes('-X') && c[c.indexOf('-X') + 1] === 'POST');
    assert.ok(labelAddCalled, '标签失败不是没发生调用(否则断言是真空)', JSON.stringify(r.calls));
    assert.ok(Boolean(r.parsed?.labels?.warning), `labels.warning 为真(标签同步真的失败了) stdout=${r.stdout}`);
    assert.equal(r.parsed?.held, false, 'held 必须为 false(非写死 true——mutation③ 探针)');
    assert.ok(Array.isArray(r.parsed?.heldBlockedBy) && r.parsed.heldBlockedBy.includes('labels'),
      `heldBlockedBy 点名 labels stdout=${r.stdout}`);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

// ── ⑫ D6 端到端幂等(round3 核心:本 PR 头号目标「幂等 claim / 重入不重复开 issue」
//     在共享状态 fake gh 下拿到真覆盖)──
// 三次真实子进程运行共享同一状态文件:
//   运行 1(全新状态):完整模式 → 建 issue + 首发评论 + 挂标签,held=true;
//   运行 2(维护者摘了标签):重入 → 复用旧 issue(不新开)、补状态回帖,held=true;
//   运行 3(标签又被摘 + 标签写入失败):held=false 点名 labels,回帖按 head 去重不再发。
test('signoff: D6 幂等 claim——三次运行只建一份 issue、重入复用、renotice 按 head 去重', () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-multirun-lock-'));
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  const payloadPath = join(repoDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify({
    issueTitle: '讨论:幂等 claim 端到端测试专用 issue',
    issueBody: '本 issue 由 signoff-policy.test.mjs 的 D6 端到端测试自动创建。',
    commentBody: '本 PR 待维护者确认,详情见关联 issue。',
  }));
  const scriptPath = join(SCRIPTS_DIR, 'signoff-hold.mjs');
  const base = { scriptPath, args: ['42', '--payload-file', payloadPath], repoDir, shimDir, statePath, extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir } };
  try {
    // 运行 1:全新状态,完整模式
    const r1 = runSignoff({ ...base, logPath: join(shimDir, 'r1.log') });
    assert.equal(r1.status, 0, `r1 stderr=${r1.stderr}`);
    assert.equal(r1.parsed?.ok, true, `r1 stdout=${r1.stdout}`);
    assert.equal(r1.parsed?.held, true, 'r1 三件套全成功必须 held');
    assert.equal(r1.parsed?.issueCreated, true, 'r1 必须新建 issue');
    assert.equal(r1.parsed?.alreadyHeld, false, 'r1 首次 hold');
    assert.equal(r1.parsed?.issueUrl, 'https://github.com/acme/app/issues/1', 'r1 建出第一份 issue');
    assert.equal(r1.calls.filter((c) => c[0] === 'issue' && c[1] === 'create').length, 1, 'r1 恰好建一份 issue');
    const state1 = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state1.comments.length, 1, 'r1 首发评论只有一条');
    assert.ok(state1.labels.some((l) => l.pr === 42), 'r1 标签已挂上');

    // 运行 2:维护者摘了标签(状态里删掉)→ 重入复用旧 issue,不新开;补状态回帖
    const s2 = JSON.parse(readFileSync(statePath, 'utf8'));
    s2.labels = s2.labels.filter((l) => l.pr !== 42);
    writeFileSync(statePath, JSON.stringify(s2));
    const r2 = runSignoff({ ...base, logPath: join(shimDir, 'r2.log') });
    assert.equal(r2.status, 0, `r2 stderr=${r2.stderr}`);
    assert.equal(r2.parsed?.held, true, `r2 复用路径三件套仍须 held stdout=${r2.stdout}`);
    assert.equal(r2.parsed?.issueCreated, false, 'r2 重入不得再建 issue');
    assert.equal(r2.parsed?.alreadyHeld, true, 'r2 必须看到既有标记评论');
    assert.equal(r2.parsed?.issueUrl, 'https://github.com/acme/app/issues/1', 'r2 复用同一讨论 issue');
    assert.equal(r2.parsed?.renoticed, true, 'r2 标签不在 → 补状态回帖');
    assert.equal(r2.calls.filter((c) => c[0] === 'issue' && c[1] === 'create').length, 0, 'r2 不得再建 issue');

    // 运行 3:标签又被摘 + 标签写入失败 → held=false 点名 labels;回帖按 head 去重不再发
    const s3 = JSON.parse(readFileSync(statePath, 'utf8'));
    s3.labels = s3.labels.filter((l) => l.pr !== 42);
    writeFileSync(statePath, JSON.stringify(s3));
    const r3 = runSignoff({
      ...base,
      logPath: join(shimDir, 'r3.log'),
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, FAKE_GH_FAIL_LABEL_ADD: '1' },
    });
    assert.equal(r3.status, 0, `r3 stderr=${r3.stderr}`);
    assert.equal(r3.parsed?.held, false, `r3 标签失败 → held 必须 false stdout=${r3.stdout}`);
    assert.ok(Array.isArray(r3.parsed?.heldBlockedBy) && r3.parsed.heldBlockedBy.includes('labels'),
      `r3 heldBlockedBy 点名 labels stdout=${r3.stdout}`);
    assert.equal(r3.parsed?.renoticed, false, 'r3 不再补回帖');
    assert.equal(r3.parsed?.renoticeSkipped, 'already-noticed-for-head', 'r3 同一 head 只回一次帖');
    assert.equal(r3.calls.filter((c) => c[0] === 'issue' && c[1] === 'create').length, 0, 'r3 不得再建 issue');
    assert.equal(r3.calls.filter((c) => c[0] === 'pr' && c[1] === 'comment').length, 0, 'r3 回帖去重后不得再发评论');
    const state3 = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state3.comments.length, 2, '三次运行总共只有首发 + 一次回帖两条评论');
    assert.equal(Object.keys(state3.issues ?? {}).length, 1, '三次运行总共只建一份 issue');
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════
// round4 修复(PR #11 第四轮):D1 startedAt 类型对齐 / D2 有界临界区与对账 /
// D3 原子 claim 绑定 main / D4 入口守卫 JSON 契约 / D5 读失败不伪装缺席 /
// D6 编程错误重抛
// ══════════════════════════════════════════════════════════════════════

// ── round4 D1(blocker):startedAt 类型对齐——数字/缺失/非法/未来四类形态 ──
test('signoff: D1 写入格式为 ISO 8601 字符串(不再写数字)', () => withLockDir((lockDir) => {
  const l = acquireHoldLock('acme', 'app', 42);
  const raw = JSON.parse(readFileSync(l.path, 'utf8'));
  assert.equal(typeof raw.startedAt, 'string', 'startedAt 必须是字符串(ISO 8601)');
  assert.ok(!Number.isNaN(Date.parse(raw.startedAt)), 'startedAt 必须可解析');
  assert.ok(Math.abs(Date.now() - Date.parse(raw.startedAt)) < 60_000, 'startedAt 是当前时间');
  releaseHoldLock(l);
}));

test('signoff: D1 数字时间戳(旧格式残留)——活 pid + 超 LOCK_STALE_MS 必须回收,不再永不陈旧', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  writeFileSync(path, JSON.stringify({
    pid: process.pid,                       // 活 pid:唯一能判陈旧的是时间子句
    startedAt: Date.now() - 10 * 60 * 1000, // 数字毫秒时间戳(round3 写入格式)
    token: 'old',
  }));
  const l = acquireHoldLock('acme', 'app', 42, { timeoutMs: 1500 });
  assert.equal(l.acquired, true, '数字时间戳 + 活 pid + 超时 → 必须判陈旧回收(D1 核心 bug 场景:Date.parse 数字返回 NaN)');
  releaseHoldLock(l);
}));

test('signoff: D1 数字时间戳新鲜(未超时)——fail-closed 不回收', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'old' }));
  const l = acquireHoldLock('acme', 'app', 42, { timeoutMs: 500 });
  assert.equal(l.acquired, false, '数字时间戳新鲜 → 不回收(fail-closed)');
  assert.equal(l.timeout, true, '标注超时');
}));

test('signoff: D1 startedAt 缺失——死 pid 回收,活 pid fail-closed 不抢', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  // 缺失 + 死 pid → pid 子句判定陈旧 → 回收(不落到"永不陈旧")
  writeFileSync(path, JSON.stringify({ pid: deadPid(), token: 'old' }));
  const l1 = acquireHoldLock('acme', 'app', 42, { timeoutMs: 1500 });
  assert.equal(l1.acquired, true, '缺失 + 死 pid → 必须回收(pid 兜底,不得永不陈旧)');
  releaseHoldLock(l1);
  // 缺失 + 活 pid → 无法凭时间判定年龄 → fail-closed 不凭时间抢占活进程
  writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'old' }));
  const l2 = acquireHoldLock('acme', 'app', 42, { timeoutMs: 500 });
  assert.equal(l2.acquired, false, '缺失 + 活 pid → fail-closed 不回收');
}));

test('signoff: D1 startedAt 非法字符串——死 pid 回收,活 pid fail-closed 不抢', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  writeFileSync(path, JSON.stringify({ pid: deadPid(), startedAt: 'not-a-date', token: 'old' }));
  const l1 = acquireHoldLock('acme', 'app', 42, { timeoutMs: 1500 });
  assert.equal(l1.acquired, true, '非法字符串 + 死 pid → 必须回收');
  releaseHoldLock(l1);
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: 'not-a-date', token: 'old' }));
  const l2 = acquireHoldLock('acme', 'app', 42, { timeoutMs: 500 });
  assert.equal(l2.acquired, false, '非法字符串 + 活 pid → fail-closed 不回收');
}));

test('signoff: D1 startedAt 未来时间戳——活 pid fail-closed 不回收,死 pid 仍回收', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() + 3600_000).toISOString(), token: 'old' }));
  const l1 = acquireHoldLock('acme', 'app', 42, { timeoutMs: 500 });
  assert.equal(l1.acquired, false, '未来时间戳 + 活 pid → fail-closed 不回收(时钟偏移保护)');
  // 未来 + 死 pid → pid 子句照常回收
  writeFileSync(path, JSON.stringify({ pid: deadPid(), startedAt: new Date(Date.now() + 3600_000).toISOString(), token: 'old' }));
  const l2 = acquireHoldLock('acme', 'app', 42, { timeoutMs: 1500 });
  assert.equal(l2.acquired, true, '未来时间戳 + 死 pid → 仍回收(pid 兜底)');
  releaseHoldLock(l2);
}));

// ── round4 D5(blocker):releaseHoldLock 读失败不得映射成 alreadyAbsent ──
test('signoff: D5 releaseHoldLock 读失败(chmod 000)→ readError + 非 alreadyAbsent + 文件仍在', () => withLockDir((lockDir) => {
  const l = acquireHoldLock('acme', 'app', 42);
  assert.equal(l.acquired, true);
  chmodSync(l.path, 0o000); // 锁文件不可读 → readFileSync 必 EACCES(≠ 文件不存在)
  try {
    const r = releaseHoldLock(l);
    assert.equal(r.released, false, '读取失败不得报 released');
    assert.equal(r.alreadyAbsent, false, 'EACCES 不是「已缺席」——锁文件还在,不能当它没了');
    assert.equal(r.notOwner, false, '不是 token 不匹配');
    assert.ok(r.readError, `必须带 readError,实际:${JSON.stringify(r)}`);
    assert.ok(existsSync(l.path), '锁文件必须仍然存在');
  } finally {
    chmodSync(l.path, 0o644); // 恢复可读,保证临时目录可清理
  }
}));

// ── round4 D6(blocker):takeover 重建块宽 catch 重抛编程错误 ──
test('signoff: D6 takeover 重建块编程错误(ReferenceError)必须重抛,不留 0 字节锁', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  const takeoverPath = `${path}.takeover`;
  writeFileSync(path, JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString(), token: 'old' })); // stale 主锁
  const boom = () => { throw new ReferenceError('injected-programming-error'); };
  assert.throws(
    () => tryTakeoverStaleLock(path, takeoverPath, 'my-token', boom),
    ReferenceError,
    '编程错误必须重新抛出,不得静默降级成"抢占失败"',
  );
  assert.ok(!existsSync(path), '0 字节主锁残留必须被清理(不留半成品锁)');
  assert.ok(!existsSync(takeoverPath), 'takeover 残留必须被 finally 清理');
}));

// ── round4 D2(blocker):有界临界区——数学上界 + 挂住 gh 实测 ──
test('signoff: D2 临界区数学上界——最坏 11 次 gh 调用 × 单次超时 < LOCK_STALE_MS', () => {
  // 临界区调用清单:pr view / issue view / issue create / pr comment / label create /
  // label POST / legacy label DELETE / renotice 评论 = 8 次基础,对账最多处理 1 个
  // 重复 issue(view + close + comment) = +3 → 最坏 11 次。活持有者不可能超出租约,
  // 抢占只发生在真死或真挂死超时之后。
  const WORST_CASE_CALLS = 11;
  assert.ok(GH_CALL_TIMEOUT_MS * WORST_CASE_CALLS < LOCK_STALE_MS,
    `最坏总耗时 ${GH_CALL_TIMEOUT_MS * WORST_CASE_CALLS}ms 必须 < 租约 ${LOCK_STALE_MS}ms`);
});

// 挂住 fake gh:pr view 卡死 10s(模拟无超时的 gh 调用),其余调用照常快速返回。
const HANGING_GH_SRC = `#!/usr/bin/env node
// round4 D2:挂住 fake gh——pr view 卡死 10s,其余快速返回。
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
}
process.exit(0);
`;

test('signoff: D2 挂住的 gh 调用被超时杀掉——临界区不可能无限挂住', () => {
  const hangDir = mkdtempSync(join(tmpdir(), 'fake-gh-hang-'));
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-hanglock-'));
  const logPath = join(hangDir, 'gh-calls.log');
  writeFileSync(logPath, '');
  const ghPath = join(hangDir, 'gh');
  writeFileSync(ghPath, HANGING_GH_SRC);
  chmodSync(ghPath, 0o755);
  const payloadPath = join(repoDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify({ issueTitle: 'T', issueBody: 'B', commentBody: 'C' }));
  try {
    const t0 = Date.now();
    const r = runSignoff({
      scriptPath: join(SCRIPTS_DIR, 'signoff-hold.mjs'),
      args: ['42', '--payload-file', payloadPath],
      repoDir, shimDir: hangDir, logPath, statePath: join(hangDir, 'state.json'),
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, SIGNOFF_HOLD_GH_TIMEOUT_MS: '500' },
      timeout: 15000,
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `挂住调用必须被超时杀掉(实测 ${elapsed}ms),不允许卡满 10s`);
    assert.notEqual(r.status, 0, `pr view 挂住超时 → fail-closed 非零退出,status=${r.status}`);
    assert.ok((r.stdout ?? '').includes('"ok": false'), `stdout 输出 JSON 错误,实际:${JSON.stringify(r.stdout)}`);
  } finally {
    rmSync(hangDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

// ── round4 D2:GitHub 侧对账(双写自愈)──
const isIssueClose = (a) => a[0] === 'issue' && a[1] === 'close';
const isIssueComment = (a) => a[0] === 'issue' && a[1] === 'comment';

test('signoff: D2 对账——多份 hold issue 保留最早(number 最小),关闭其余并留说明', () => {
  const gh = makeFakeGh([
    { match: (a) => a[0] === 'issue' && a[1] === 'view', result: { ok: true, stdout: '{"state":"OPEN"}', stderr: '', status: 0 } },
    { match: isIssueClose, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isIssueComment, result: { ok: true, stdout: '', stderr: '', status: 0 } },
  ]);
  const r = reconcileDuplicateHoldIssues({
    slug: 'acme/app',
    urls: ['https://github.com/acme/app/issues/5', 'https://github.com/acme/app/issues/3', 'https://github.com/acme/app/issues/5'],
    ghFn: gh,
  });
  assert.equal(r.keptUrl, 'https://github.com/acme/app/issues/3', '保留 number 最小(最早创建)的 issue');
  assert.deepEqual(r.closed.map((c) => c.number), [5], '关闭其余(去重后只有 #5)');
  assert.deepEqual(r.errors, [], '无错误');
  const closes = gh.calls.filter((c) => isIssueClose(c.args));
  assert.equal(closes.length, 1, '恰好关一份重复 issue');
  assert.ok(closes[0].args.includes('5'), '关闭的是 #5');
  const comments = gh.calls.filter((c) => isIssueComment(c.args));
  assert.equal(comments.length, 1, '留一条说明');
  assert.ok(comments[0].args.some((a) => a.includes('#3')), '说明指向保留的 #3');
});

test('signoff: D2 对账——单份 / 无 / 跨仓库 URL 都不动作(零 gh 调用)', () => {
  const gh = makeFakeGh([]);
  const r1 = reconcileDuplicateHoldIssues({ slug: 'acme/app', urls: ['https://github.com/acme/app/issues/3'], ghFn: gh });
  assert.equal(r1.keptUrl, 'https://github.com/acme/app/issues/3', '单份保留');
  assert.equal(r1.closed.length, 0, '单份不动作');
  const r2 = reconcileDuplicateHoldIssues({ slug: 'acme/app', urls: [], ghFn: gh });
  assert.equal(r2.keptUrl, null, '无 issue → keptUrl null');
  assert.equal(r2.closed.length, 0);
  const r3 = reconcileDuplicateHoldIssues({
    slug: 'acme/app',
    urls: ['https://github.com/other/repo/issues/9', 'https://github.com/acme/app/issues/2'],
    ghFn: gh,
  });
  assert.equal(r3.keptUrl, 'https://github.com/acme/app/issues/2', '跨仓库 URL 不参与对账');
  assert.equal(r3.closed.length, 0, '跨仓库 URL 不得动作');
  assert.equal(gh.calls.length, 0, '全程零 gh 调用');
});

test('signoff: D2 对账——state 查询失败 → errors 点名,不误关', () => {
  const gh = makeFakeGh([
    { match: (a) => a[0] === 'issue' && a[1] === 'view', result: { ok: false, stdout: '', stderr: '403', status: 1 } },
  ]);
  const r = reconcileDuplicateHoldIssues({
    slug: 'acme/app',
    urls: ['https://github.com/acme/app/issues/3', 'https://github.com/acme/app/issues/7'],
    ghFn: gh,
  });
  assert.equal(r.keptUrl, 'https://github.com/acme/app/issues/3', '仍保留最早');
  assert.equal(r.closed.length, 0, '查询失败不误关');
  assert.ok(r.errors.length > 0 && r.errors[0].includes('duplicate-issue-7'), `错误点名失败的 issue,实际:${JSON.stringify(r.errors)}`);
});

// ── round4 D3(blocker):原子 claim 绑定 main()——真并发双子进程 e2e ──
// 两个真实子进程**同时**对同一 PR 跑完整模式,共享锁目录与 fake gh 状态。有锁时
// 恰好 1 个 issue + 1 条评论;竞态屏障(FAKE_GH_RACE_BARRIER,见 stateful shim)在
// mutation(删掉 main() 的 acquireHoldLock 接线)下让两个进程都到 create 点 →
// 必然双写 → 测试转红。
function runSignoffAsync({ scriptPath, args, repoDir, shimDir, logPath, statePath, extraEnv = {}, timeout = 30000 }) {
  return new Promise((resolve) => {
    const r = spawn('node', [scriptPath, ...args], {
      cwd: repoDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, FAKE_GH_LOG: logPath, FAKE_GH_STATE: statePath, ...extraEnv },
      timeout,
    });
    let stdout = '';
    let stderr = '';
    r.stdout.on('data', (d) => { stdout += d; });
    r.stderr.on('data', (d) => { stderr += d; });
    r.on('close', (code, signal) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* 非 JSON */ }
      const calls = existsSync(logPath)
        ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
      resolve({ status: code, signal, stdout, stderr, calls, parsed });
    });
  });
}

test('signoff: D3 真并发双子进程——恰好 1 issue + 1 评论(锁串行化)', async () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-concurrent-lock-'));
  const barrierDir = mkdtempSync(join(tmpdir(), 'signoff-hold-barrier-'));
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  const payloadPath = join(repoDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify({
    issueTitle: '讨论:真并发 e2e 专用 issue',
    issueBody: '本 issue 由 signoff-policy.test.mjs 的真并发测试自动创建。',
    commentBody: '本 PR 待维护者确认,详情见关联 issue。',
  }));
  const scriptPath = join(SCRIPTS_DIR, 'signoff-hold.mjs');
  try {
    const [p1, p2] = await Promise.all([
      runSignoffAsync({
        scriptPath, args: ['42', '--payload-file', payloadPath], repoDir, shimDir,
        logPath: join(shimDir, 'c1.log'), statePath,
        extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, FAKE_GH_RACE_BARRIER: barrierDir },
      }),
      runSignoffAsync({
        scriptPath, args: ['42', '--payload-file', payloadPath], repoDir, shimDir,
        logPath: join(shimDir, 'c2.log'), statePath,
        extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, FAKE_GH_RACE_BARRIER: barrierDir },
      }),
    ]);
    assert.equal(p1.status, 0, `p1 stderr=${p1.stderr}`);
    assert.equal(p2.status, 0, `p2 stderr=${p2.stderr}`);
    assert.equal(p1.parsed?.ok, true, `p1 stdout=${p1.stdout}`);
    assert.equal(p2.parsed?.ok, true, `p2 stdout=${p2.stdout}`);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(Object.keys(state.issues ?? {}).length, 1, `两个并发进程总共只建一份 issue,实际:${JSON.stringify(state.issues)}`);
    assert.equal((state.comments ?? []).length, 1, `两个并发进程总共只发一条评论,实际:${state.comments.length}`);
    const allCreates = [...p1.calls, ...p2.calls].filter((c) => c[0] === 'issue' && c[1] === 'create');
    assert.equal(allCreates.length, 1, `issue create 调用合计 1 次,实际 ${allCreates.length}`);
    // 锁串行化的直接证据:一个进程新建,另一个进程拿锁后看到已 hold → 复用
    assert.ok(p1.parsed?.issueCreated === true || p2.parsed?.issueCreated === true, '至少一个进程新建');
    assert.ok(p1.parsed?.issueCreated === false || p2.parsed?.issueCreated === false, '至少一个进程复用(串行化生效)');
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
    rmSync(barrierDir, { recursive: true, force: true });
  }
});

// ── round4 D2:对账在主流程的接线(删掉 main() 的 reconcile 调用必须转红)──
// 预置两份不同 hold issue 的标记评论 + 两个 OPEN issue → 跑完整模式 → 必须出现
// reconciliation 字段、关闭 #2 保留 #1,且后续复用路径指向保留的 #1。
test('signoff: D2 对账主流程接线——双写残留自愈,保留最早 issue', () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-reconcile-lock-'));
  const statePath = join(shimDir, 'state.json');
  const MARKER = '<!-- review-pr:product-gate';
  const PRE = {
    issueSeq: 2,
    issues: { 1: { state: 'OPEN' }, 2: { state: 'OPEN' } },
    comments: [
      { pr: 42, body: `${MARKER} issue=https://github.com/acme/app/issues/1 -->` },
      { pr: 42, body: `${MARKER} issue=https://github.com/acme/app/issues/2 -->` },
    ],
    labels: [],
    headOid: 'deadbeef',
  };
  writeFileSync(statePath, JSON.stringify(PRE));
  const logPath = join(shimDir, 'r.log');
  try {
    const r = runSignoff({
      scriptPath: join(SCRIPTS_DIR, 'signoff-hold.mjs'),
      args: ['42'],
      repoDir, shimDir, logPath, statePath,
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.parsed?.ok, true, `stdout=${r.stdout}`);
    assert.ok(r.parsed?.reconciliation, `输出必须带 reconciliation 字段,实际:${r.stdout}`);
    assert.equal(r.parsed.reconciliation.keptUrl, 'https://github.com/acme/app/issues/1', '保留最早 issue #1');
    assert.deepEqual(r.parsed.reconciliation.closed.map((c) => c.number), [2], '关闭重复 issue #2');
    assert.equal(r.parsed.issueUrl, 'https://github.com/acme/app/issues/1', '复用路径指向保留的 #1,不再把作者引到已关闭的 #2');
    assert.equal(r.parsed.issueCreated, false, '对账后不新开 issue');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.issues['1'].state, 'OPEN', '#1 保持 OPEN');
    assert.equal(state.issues['2'].state, 'CLOSED', '#2 已关闭');
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});
