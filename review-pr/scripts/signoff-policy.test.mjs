#!/usr/bin/env node
// signoff-policy.test.mjs — 确认门策略判定的回归:UI 测试路径过滤 + 讨论 issue 收尾/复用。
//
// 为什么要这个测试:这两组判定的失效都是**静默**的 ——
//   ① isUiTestPath 改松:测试-only PR 被产品门拦下等维护者(把确定事实交回语义判断,
//      正是 2026-07-28 `.d.ts` 拍板要消灭的坏形态);改严:生产 UI 文件被当测试放行,
//      产品门形同虚设,两个方向都没有任何报错提示。
//   ② decideIssueReuse / shouldCloseDiscussionIssue 判错的代价是「重复讨论 issue 刷屏」
//      或「把作者/维护者引进一个已关闭的讨论」,同样静默。
// 跑:node scripts/signoff-policy.test.mjs   退出码 0 = 全过。

import {
  isUiTestPath, UI_TEST_PATH_RE,
  issueNumberFromUrl, decideIssueReuse, shouldCloseDiscussionIssue,
} from './lib.mjs';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, `got ${g}, want ${w}`);
}

// ── ① UI 测试路径过滤(product 门确定性排除)──
// 必须命中(测试/mock/snapshot,零像素改动)
const TEST_PATHS = [
  'apps/renderer/src/components/__tests__/Button.test.tsx',
  'apps/renderer/src/components/Button.test.tsx',
  'apps/renderer/src/components/Button.spec.ts',
  'apps/renderer/src/__mocks__/electron.ts',
  'apps/renderer/src/components/__snapshots__/Button.test.tsx.snap',
  'apps/renderer/src/store/session.mock.ts',
  'apps/mobile/tests/screens/Home.tsx',
  'apps/mobile/test/setup.ts',
  'apps/renderer/mocks/handlers.ts',
  'apps/renderer/src/Panel.snap',
];
for (const p of TEST_PATHS) check(`测试路径命中: ${p}`, isUiTestPath(p));

// 不得命中(生产文件;含「test 是子串但不是段/后缀」的对抗用例)
const PROD_PATHS = [
  'apps/renderer/src/components/Button.tsx',
  'apps/renderer/src/latest.ts',            // "test" 是 "latest" 的子串
  'apps/renderer/src/pages/contest.tsx',    // 同上
  'apps/renderer/src/sections/testimonials.tsx', // "test" 开头但非 .test. 后缀、非 test/ 段
  'apps/renderer/src/mockup/Preview.tsx',   // "mock" 开头但目录段是 mockup 不是 mocks
  'apps/renderer/src/utils/protest-banner.tsx',
  'docs/design-rules/cindy-design-system.md', // 设计系统文档必须继续触发产品门
  'apps/renderer/src/attestation.ts',
];
for (const p of PROD_PATHS) check(`生产路径不命中: ${p}`, !isUiTestPath(p));

// 空值/怪值不炸
check('空串不命中', !isUiTestPath(''));
check('null 不命中', !isUiTestPath(null));
check('正则可复用(无 g flag 状态残留)', !UI_TEST_PATH_RE.global, 'UI_TEST_PATH_RE 不应带 g flag');

// ── ② issue URL 解析(只认本仓库)──
eq('本仓库 issue', issueNumberFromUrl('acme/app', 'https://github.com/acme/app/issues/42'), 42);
eq('大小写不敏感', issueNumberFromUrl('Acme/App', 'https://github.com/acme/app/issues/7'), 7);
eq('跨仓库拒绝', issueNumberFromUrl('acme/app', 'https://github.com/other/repo/issues/42'), null);
eq('非 issue 链接拒绝', issueNumberFromUrl('acme/app', 'https://github.com/acme/app/pull/42'), null);
eq('垃圾输入拒绝', issueNumberFromUrl('acme/app', 'not-a-url'), null);
eq('null 输入拒绝', issueNumberFromUrl('acme/app', null), null);

// ── ③ 讨论 issue 复用/新开判定 ──
const URL = 'https://github.com/acme/app/issues/42';
eq('从未 hold → 新开',
  decideIssueReuse({ priorIssueUrl: null, issueState: null }),
  { needNewIssue: true, reuseUrl: null, reason: 'never-held' });
eq('旧 issue 仍 OPEN → 复用',
  decideIssueReuse({ priorIssueUrl: URL, issueState: 'OPEN' }),
  { needNewIssue: false, reuseUrl: URL, reason: 'prior-open' });
eq('旧 issue 已 CLOSED → 新开(--no-longer-required 收尾后 gate 再触发)',
  decideIssueReuse({ priorIssueUrl: URL, issueState: 'CLOSED' }),
  { needNewIssue: true, reuseUrl: null, reason: 'prior-closed' });
eq('state 查询失败 → fail-safe 复用旧链接(网络抖动不制造重复 issue)',
  decideIssueReuse({ priorIssueUrl: URL, issueState: null }),
  { needNewIssue: false, reuseUrl: URL, reason: 'state-unknown-failsafe-reuse' });
eq('无参调用等价从未 hold', decideIssueReuse({}).reason, 'never-held');

// ── ④ 讨论 issue 收尾判定(--no-longer-required 的触发条件)──
const HELD = { kind: 'product', issueUrl: URL, issueNumber: 42, heldAt: '2026-08-01T00:00:00Z' };
check('hold 过 + 0 触发 → 关', shouldCloseDiscussionIssue({ held: HELD, triggerCount: 0 }));
check('hold 过 + 仍有触发(即使 blocking=false)→ 不关',
  !shouldCloseDiscussionIssue({ held: HELD, triggerCount: 1 }));
check('从未 hold → 无 issue 可关', !shouldCloseDiscussionIssue({ held: null, triggerCount: 0 }));
check('无参调用不关', !shouldCloseDiscussionIssue({}));

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('signoff-policy.test.mjs: 全部用例通过');
