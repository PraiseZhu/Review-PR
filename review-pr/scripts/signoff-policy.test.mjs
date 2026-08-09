#!/usr/bin/env node
// signoff-policy.test.mjs — 确认门策略判定的回归:UI 测试路径过滤 + 讨论 issue 收尾/复用
// + 三门(security/arch/rules)触发/放行/重入。
//
// 为什么要这个测试:这几组判定的失效都是**静默**的 ——
//   ① isUiTestPath 改松:测试-only PR 被产品门拦下等维护者;改严:生产 UI 文件被当测试放行,
//      产品门形同虚设,两个方向都没有任何报错提示。
//   ② decideIssueReuse / shouldCloseDiscussionIssue 判错的代价是「重复讨论 issue 刷屏」
//      或「把作者/维护者引进一个已关闭的讨论」,同样静默。
//   ③ classifyGateHits(三门触发判定)是编排与脚本共用的同一份事实来源,改错方向
//      (漏触发 = 门空转、多触发 = 误 hold)同样是静默的 —— 脚本层与 SKILL 编排
//      都不会报错,只有巡审发现「该 hold 的没 hold」才暴露。
// 跑:node scripts/signoff-policy.test.mjs   退出码 0 = 全过。

import {
  isUiTestPath, UI_TEST_PATH_RE,
  issueNumberFromUrl, decideIssueReuse, shouldCloseDiscussionIssue,
  classifyGateHits, parseSignoffReleases, parseSignoffRenotices,
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
// 必须命中(测试/mock/snapshot,零像素改动);路径形态按本仓(桌面端 apps/*/src/...)适配
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
for (const p of TEST_PATHS) check(`测试路径命中: ${p}`, isUiTestPath(p));

// 不得命中(生产文件;含「test 是子串但不是段/后缀」的对抗用例)
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

// ── ③ 讨论 issue 复用/新开判定(重入核心:重复 hold 不制造重复 issue)──
const URL = 'https://github.com/acme/app/issues/42';
eq('从未 hold → 新开',
  decideIssueReuse({ priorIssueUrl: null, issueState: null }),
  { needNewIssue: true, reuseUrl: null, reason: 'never-held' });
eq('旧 issue 仍 OPEN → 复用(重入不重复开)',
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

// ── ⑤ 三门触发判定(classifyGateHits:security / rules / arch-core 路径层事实)──
// 触发:命中即非空;放行:门未配置(空数组)= 功能关闭,恒不触发;重入:再次触发时
// issue 复用(见 ③)与 renotice 去重(见 ⑥)保证动作不重复 —— 判定本身无隐藏状态,
// 状态由「当前标签 + 最新 Approve 时序」唯一决定。
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

// 触发:security 命中 review-pr 自身脚本 / 配置 / CI workflow
const hits = classifyGateHits({ paths: MIVO_STYLE_PATHS, ...CFG });
check('security 触发:命中 review-pr 自身脚本', hits.security.includes('review-pr/scripts/context.mjs'));
check('security 触发:命中 pr-rules.json', hits.security.includes('agent-use/docs/pr-rules.json'));
check('security 触发:命中 CI workflow', hits.security.includes('.github/workflows/ci.yml'));
check('security 触发:SKILL.md 也命中(脚本/文档同属安全面)', hits.security.includes('review-pr/SKILL.md'));
check('security 不误伤普通路径', !hits.security.includes('src/App.tsx'));
// 触发:rules 命中规则文档清单
check('rules 触发:AGENTS.md 命中', hits.rules.includes('AGENTS.md'));
check('rules 触发:CLAUDE.md 命中', hits.rules.includes('CLAUDE.md'));
check('rules 触发:docs/dev-rules/ 前缀命中', hits.rules.some((p) => p.startsWith('docs/dev-rules/')));
check('rules 整路径相等:review-pr/SKILL.md 不在 required 清单 → 不命中 rules(仍命中 security)',
  !hits.rules.includes('review-pr/SKILL.md') && hits.security.includes('review-pr/SKILL.md'));
check('rules 不误伤普通路径', !hits.rules.includes('src/App.tsx'));
// 触发:arch-core 命中核心路径
check('arch 触发:packages/ 命中', hits.archCore.includes('packages/core/src/index.ts'));
check('arch 触发:apps/desktop/src/main/ 命中', hits.archCore.includes('apps/desktop/src/main/index.ts'));
check('arch 不误伤普通路径', !hits.archCore.includes('src/App.tsx'));
// ruleMap:管辖路径命中单独输出
check('ruleMap 命中:packages/ 归属 docs/dev-rules/coding.md', hits.ruleMapHits.some((h) => h.doc === 'docs/dev-rules/coding.md' && h.paths.includes('packages/core/src/index.ts')));

// 放行:门关闭(配置空)= 恒不触发 —— 「什么都没发生」要有对照组:同路径在门配置后命中、在门关闭时不命中
const DISABLED = classifyGateHits({ paths: MIVO_STYLE_PATHS, securityReviewPaths: [], ruleFiles: null, archCorePaths: [] });
check('放行:security 门未配置 → 恒不触发', DISABLED.security.length === 0);
check('放行:rules 门未配置 → 恒不触发', DISABLED.rules.length === 0);
check('放行:arch 门未配置 → 恒不触发', DISABLED.archCore.length === 0);
// 放行:required 前缀匹配不做 subset 放宽(目录前缀命中,近邻文件不命中)
const NEAR = classifyGateHits({ paths: ['AGENTS.md.bak', 'docs/dev-rules2/x.md', 'packagesx/y.ts'], ...CFG });
check('exact 语义:AGENTS.md.bak 不命中 rules', NEAR.rules.length === 0);
check('exact 语义:docs/dev-rules2/ 不是 docs/dev-rules/ 前缀', !NEAR.rules.some((p) => p === 'docs/dev-rules2/x.md'));
check('exact 语义:packagesx/ 不是 packages/ 前缀', !NEAR.archCore.includes('packagesx/y.ts'));

// ── ⑥ 通过标记 / 状态回帖解析(重入去重键)──
const RELEASED = parseSignoffReleases([
  '<!-- review-pr:signoff-release gates=security,rules by=dashhuang -->',
  '普通评论',
]);
check('通过标记解析:security', RELEASED.get('security')?.by === 'dashhuang');
check('通过标记解析:rules', RELEASED.get('rules')?.via === 'release-marker');
check('通过标记解析:未出现类别不记', !RELEASED.has('product'));
check('通过标记解析:空输入不炸', parseSignoffReleases([]).size === 0);

const RENOTICED = parseSignoffRenotices([
  '<!-- review-pr:signoff-renotice head=abc123 -->',
  '<!-- review-pr:signoff-renotice head=ABC123 -->',  // 大小写归一,同一 head 只算一次
  '<!-- review-pr:signoff-renotice head=def456 -->',
]);
check('回帖去重:head 归一', RENOTICED.has('abc123') && RENOTICED.has('def456'));
check('回帖去重:同一 head 只回一次', RENOTICED.size === 2);

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('signoff-policy.test.mjs: 全部用例通过');
