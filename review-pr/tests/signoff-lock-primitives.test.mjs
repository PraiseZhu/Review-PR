#!/usr/bin/env node
// signoff-lock-primitives.test.mjs — lib.mjs 的 signoff 基础能力回归(R8 拆节 A 节):
// UI 测试路径过滤 + 讨论 issue 收尾/复用 + 三门触发/放行 + 通过/回帖标记解析 +
// 排他锁原语(acquireHoldLock / releaseHoldLock / tryTakeoverStaleLock / 陈旧判据)。
//
// R8 拆节说明:本文件自 signoff-policy.test.mjs 沿「锁原语」缝拆出,测的代码全部
// 在 lib.mjs(signoff 常量/解析 + 自 signoff-hold.mjs 迁入的锁原语)。signoff-hold.mjs
// 的生产动作测试(perform*/computeHeld/入口守卫/对账/收敛/预算)留在
// tests/signoff-policy.test.mjs(B 节);signoff-release.mjs 无独立测试(C 节)。
// 跑:cd review-pr && node --test tests/signoff-lock-primitives.test.mjs

import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isUiTestPath, UI_TEST_PATH_RE,
  issueNumberFromUrl, decideIssueReuse, shouldCloseDiscussionIssue,
  classifyGateHits, parseSignoffReleases, parseSignoffRenotices,
  acquireHoldLock, releaseHoldLock, tryTakeoverStaleLock,
  parseStartedAtMs, isLockStale, LOCK_STALE_MS,
} from '../scripts/lib.mjs';

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

// ══════════════════════════════════════════════════════════════════════
// round4 修复(PR #11 第四轮):D1 startedAt 类型对齐 / D2 有界临界区与对账 /
// D3 原子 claim 绑定 main / D4 入口守卫 JSON 契约 / D5 读失败不伪装缺席 /
// D6 编程错误重抛
// ══════════════════════════════════════════════════════════════════════

// ── round4 D1(blocker):startedAt 类型对齐——数字/缺失/非法/未来四类形态 ──
// round5 R5-3(复审 finding):四种异常形态里只有 ISO 一条走生产写入路径,其余三条都是
// writeFileSync 手搓对象,没有「生产写入形状 → 读取判定」的端到端证据。本轮补:
//   1) 端到端断言:acquireHoldLock 真实写锁 → 读回 → parseStartedAtMs / isLockStale
//      在同一份真实形状上行为正确;
//   2) missing 形态改由生产写入派生(写锁后删 startedAt 字段,其余字段与生产一致);
//   3) numeric / invalid / future 三条必须手搓的理由写进注释——生产写入器恒写
//      new Date().toISOString() 当前时间,产不出这些形状(它们分别对应历史遗留格式 /
//      外部损坏 / 时钟偏移),手搓是唯一办法,不是偷懒。
test('signoff: D1 写入格式为 ISO 8601 字符串(不再写数字)', () => withLockDir((lockDir) => {
  const l = acquireHoldLock('acme', 'app', 42);
  const raw = JSON.parse(readFileSync(l.path, 'utf8'));
  assert.equal(typeof raw.startedAt, 'string', 'startedAt 必须是字符串(ISO 8601)');
  assert.ok(!Number.isNaN(Date.parse(raw.startedAt)), 'startedAt 必须可解析');
  assert.ok(Math.abs(Date.now() - Date.parse(raw.startedAt)) < 60_000, 'startedAt 是当前时间');
  releaseHoldLock(l);
}));

// round5 R5-3:生产写入 → 读取判定的端到端闭环。同一份 acquireHoldLock 真实产出的
// 锁文件,喂给生产同款 parseStartedAtMs / isLockStale——不再只喂手搓对象。
test('signoff: D1 端到端——生产写入锁文件读回,parseStartedAtMs 解析正确、isLockStale 行为正确', () => withLockDir((lockDir) => {
  const l = acquireHoldLock('acme', 'app', 42);
  assert.equal(l.acquired, true);
  const raw = JSON.parse(readFileSync(l.path, 'utf8'));
  // 生产写入的真实形状:pid + ISO startedAt + token
  const startedAt = parseStartedAtMs(raw.startedAt);
  assert.ok(Number.isFinite(startedAt), `生产写入的 startedAt 必须能解析,实际:${JSON.stringify(raw.startedAt)}`);
  assert.ok(Math.abs(Date.now() - startedAt) < 60_000, '解析出的是当前时间');
  // 新鲜锁 + 活 pid → 不陈旧
  assert.equal(isLockStale(raw), false, '真实新锁不得判陈旧');
  // 同一真实形状仅把年龄改旧 → 时间子句必须判陈旧(与生产一致的时间判据)
  const aged = { ...raw, startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
  assert.equal(isLockStale(aged), true, '同形状 + 超时年龄 → 判陈旧');
  releaseHoldLock(l);
}));

test('signoff: D1 数字时间戳(旧格式残留)——活 pid + 超 LOCK_STALE_MS 必须回收,不再永不陈旧', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  // 手搓理由(R5-3):数字毫秒是 round3 的生产写入格式,round4 改 ISO 后当前写入器
  // (new Date().toISOString())不再产出数字形状——此 fixture 模拟历史遗留锁文件残留,
  // 只能手搓,不能由生产路径产出。
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
  // 手搓理由同上:数字形状是 round3 历史格式残留,当前写入器产不出,只能手搓。
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'old' }));
  const l = acquireHoldLock('acme', 'app', 42, { timeoutMs: 500 });
  assert.equal(l.acquired, false, '数字时间戳新鲜 → 不回收(fail-closed)');
  assert.equal(l.timeout, true, '标注超时');
}));

test('signoff: D1 startedAt 缺失——死 pid 回收,活 pid fail-closed 不抢', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  // round5 R5-3:missing 形状从生产写入派生——acquireHoldLock 真实写锁后删 startedAt
  // 字段(生产写入器恒写 startedAt,「缺失」只可能来自旧格式残留/外部删字段;删字段使
  // 形状 = 生产写入 - 一个字段,其余字段与生产逐字节一致,不再整只手搓)。
  const prod = acquireHoldLock('acme', 'app', 42);
  const base = JSON.parse(readFileSync(path, 'utf8'));
  releaseHoldLock(prod);
  // 缺失 + 死 pid → pid 子句判定陈旧 → 回收(不落到"永不陈旧")
  const deadShape = { ...base, pid: deadPid() };
  delete deadShape.startedAt;
  writeFileSync(path, JSON.stringify(deadShape));
  const l1 = acquireHoldLock('acme', 'app', 42, { timeoutMs: 1500 });
  assert.equal(l1.acquired, true, '缺失 + 死 pid → 必须回收(pid 兜底,不得永不陈旧)');
  releaseHoldLock(l1);
  // 缺失 + 活 pid → 无法凭时间判定年龄 → fail-closed 不凭时间抢占活进程
  const aliveShape = { ...base };
  delete aliveShape.startedAt;
  writeFileSync(path, JSON.stringify(aliveShape));
  const l2 = acquireHoldLock('acme', 'app', 42, { timeoutMs: 500 });
  assert.equal(l2.acquired, false, '缺失 + 活 pid → fail-closed 不回收');
}));

test('signoff: D1 startedAt 非法字符串——死 pid 回收,活 pid fail-closed 不抢', () => withLockDir((lockDir) => {
  const path = lockPath(lockDir);
  // 手搓理由(R5-3):写入器恒写 ISO 8601(或旧版数字),'not-a-date' 是内容损坏/外部
  // 篡改的结果,生产路径产不出该形状,只能手搓。
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
  // 手搓理由(R5-3):写入器恒写当前时间(时钟单调前进),未来时间戳只能是时钟偏移/
  // 手动篡改,生产路径产不出,只能手搓。
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
