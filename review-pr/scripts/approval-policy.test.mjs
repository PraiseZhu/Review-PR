#!/usr/bin/env node
// approval-policy.test.mjs — 动态维护者权限、signoff 豁免、admin merge 与旧 CR dismissal 回归。
// 跑:node scripts/approval-policy.test.mjs   退出码 0 = 全过。

import {
  evaluateApprovalExemption,
  isApprovalPendingReviewDecision,
  evaluateSignoffBlocking,
  evaluateNormalMergeAvailable,
  evaluateApprovalExemptAdminMerge,
  evaluateFinalMergeAuthorization,
  probeBranchProtection,
  evaluateAdminBranchRules,
  parseStaleRebaseCompare,
  matchPathPatterns,
  fetchAllReviewThreads,
  latestSubstantiveReviews,
  evaluateOwnReviewDismissal,
} from './lib.mjs';
import { readFileSync } from 'node:fs';

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  check(name, actual === expected, `got ${actual}, want ${expected}`);
}

// ── ① 动态 authority:CODEOWNERS 根 Team 当前成员 + 显式补充白名单 ──
// [MIVO-PATCH test-rules] 上游用例校验上游配置取值;Mivo 用 REVIEW_PR_RULES_FILE 指向上游配置夹具。
const config = JSON.parse(readFileSync(process.env.REVIEW_PR_RULES_FILE || new URL('../config/pr-rules.json', import.meta.url), 'utf8'));
check('配置不含 legacy maintainers',
  !Object.prototype.hasOwnProperty.call(config, 'maintainers'));
check('配置不含 legacy approvalExemptAuthors',
  !Object.prototype.hasOwnProperty.call(config, 'approvalExemptAuthors'));
eq('补充维护者白名单保持精确名单', config.maintainerAllowlist, ['fmfsaisai']);
{
  const liveRules = JSON.parse(readFileSync(new URL('../config/pr-rules.json', import.meta.url), 'utf8'));
  eq('真实配置维护者四人名单', liveRules.maintainerAllowlist, ['PraiseZhu', 'kirozeng', 'aj0928', 'zhongxingtian-ai']);
  const four = {
    teamMembers: [],
    allowlistedMembers: ['praisezhu', 'kirozeng', 'aj0928', 'zhongxingtian-ai'],
    members: ['praisezhu', 'kirozeng', 'aj0928', 'zhongxingtian-ai'],
    codeowners: { teamHandle: null },
    digest: `sha256:${'c'.repeat(64)}`,
  };
  for (const login of four.members) {
    const policy = evaluateApprovalExemption({ authorLogin: login, authority: four });
    check(`四人维护者 ${login} 免独立 Approve`, policy.exempt && policy.authorIsMaintainer);
  }
  check('第五个非维护者仍需 Approve', !evaluateApprovalExemption({ authorLogin: 'outsider', authority: four }).exempt);
}
eq('selfFixAuthors 保持精确名单', config.selfFixAuthors, ['magiclizi']);
check('三个 CODEOWNERS 生效位置全部受保护',
  ['.github/', 'CODEOWNERS', 'docs/CODEOWNERS'].every((path) => config.protectedPaths.paths.includes(path)));
eq('三个 CODEOWNERS 路径均命中 protected matcher',
  matchPathPatterns(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'], config.protectedPaths.paths),
  ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);

const AUTHORITY = {
  teamMembers: ['alice', 'dashhuang'],
  allowlistedMembers: [],
  members: ['alice', 'dashhuang'],
  codeowners: { teamHandle: '@acme/maintainers' },
  digest: `sha256:${'a'.repeat(64)}`,
};
{
  const member = evaluateApprovalExemption({ authorLogin: ' ALICE ', authority: AUTHORITY });
  check('动态 Team 成员作者免 Approve', member.exempt && member.authorIsMaintainer);
  check('成员判断大小写与空白规范化', member.author === 'alice');
  check('exemption 绑定 authority 来源',
    member.source === 'codeowners-root-team' &&
    member.teamHandle === AUTHORITY.codeowners.teamHandle &&
    member.authorityDigest === AUTHORITY.digest);
  check('另一个动态 Team 成员作者也免 Approve',
    evaluateApprovalExemption({ authorLogin: 'DASHHUANG', authority: AUTHORITY }).exempt);
  check('成员从最新 authority 移除后立即不豁免',
    !evaluateApprovalExemption({
      authorLogin: 'alice',
      authority: { ...AUTHORITY, members: ['dashhuang'], digest: `sha256:${'b'.repeat(64)}` },
    }).exempt);
  check('非 Team 成员作者不豁免',
    !evaluateApprovalExemption({ authorLogin: 'carol', authority: AUTHORITY }).exempt);
  check('仅在 selfFixAuthors 的作者不豁免',
    config.selfFixAuthors.includes('magiclizi') &&
    !evaluateApprovalExemption({ authorLogin: 'magiclizi', authority: AUTHORITY }).exempt);
  check('authority 缺失时 fail closed',
    !evaluateApprovalExemption({ authorLogin: 'alice', authority: null }).exempt);
  check('authority members 形状异常时 fail closed',
    !evaluateApprovalExemption({ authorLogin: 'alice', authority: { members: 'alice' } }).exempt);
  check('作者为空 fail closed',
    !evaluateApprovalExemption({ authorLogin: '', authority: AUTHORITY }).exempt);
}
{
  const authority = {
    ...AUTHORITY,
    teamMembers: ['dashhuang'],
    allowlistedMembers: ['fmfsaisai'],
    members: ['dashhuang', 'fmfsaisai'],
  };
  const member = evaluateApprovalExemption({ authorLogin: 'FMFSAISAI', authority });
  check('补充白名单作者免 Approve', member.exempt && member.authorIsMaintainer);
  check('补充白名单来源可审计', member.source === 'maintainer-allowlist');
}

// ── ② 缺 approval 状态:空值归一,CHANGES_REQUESTED 不得混入 ──
check('REVIEW_REQUIRED = awaiting approval', isApprovalPendingReviewDecision('REVIEW_REQUIRED'));
check('null = awaiting approval', isApprovalPendingReviewDecision(null));
check('undefined = awaiting approval', isApprovalPendingReviewDecision(undefined));
check('空串 = awaiting approval', isApprovalPendingReviewDecision(''));
check('空白串 = awaiting approval', isApprovalPendingReviewDecision('   '));
check('APPROVED 不是 awaiting approval', !isApprovalPendingReviewDecision('APPROVED'));
check('CHANGES_REQUESTED 不是 awaiting approval', !isApprovalPendingReviewDecision('CHANGES_REQUESTED'));

// review thread 必须完整分页；partial error / 游标异常 fail closed。
{
  const makeNode = (index) => ({
    isResolved: index !== 100,
    isOutdated: false,
    path: `file-${index}.js`,
    firstComments: { nodes: [] },
    lastComments: { nodes: [] },
  });
  const firstPage = Array.from({ length: 100 }, (_, index) => makeNode(index));
  const secondPage = [makeNode(100)];
  const result = fetchAllReviewThreads('o', 'r', 1, {
    ghGraphqlFn: (_query, vars, opts) => {
      check('分页调用设置超时', opts?.timeoutMs === 20_000);
      const reviewThreads = vars.cursor
        ? { nodes: secondPage, pageInfo: { hasNextPage: false, endCursor: null } }
        : { nodes: firstPage, pageInfo: { hasNextPage: true, endCursor: 'page-2' } };
      return { data: { repository: { pullRequest: { reviewThreads } } } };
    },
  });
  check('101 条 thread 完整分页', result.verified && result.threads.length === 101);
  check('第二页未解决 thread 不漏', !result.threads[100].isResolved);
}
{
  let call = 0;
  const result = fetchAllReviewThreads('o', 'r', 1, {
    ghGraphqlFn: () => {
      call += 1;
      if (call === 1) {
        return { data: { repository: { pullRequest: { reviewThreads: {
          nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page-2' },
        } } } } };
      }
      return { data: { repository: { pullRequest: { reviewThreads: null } } }, errors: [{ message: 'forbidden' }] };
    },
  });
  check('第二页 partial error fail closed', !result.verified && result.errors.includes('forbidden'));
}
{
  const result = fetchAllReviewThreads('o', 'r', 1, {
    ghGraphqlFn: () => ({ data: { repository: { pullRequest: { reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' },
    } } } } }),
  });
  check('重复分页游标 fail closed', !result.verified);
}

// ── ③ signoff:维护者作者不在审查前重复 hold，最终 Approve 由合并门另行强制 ──
check('非维护者作者命中 trigger 时 blocking', evaluateSignoffBlocking({ enabled: true }));
check('最终维护者集合成员作者审查前不 blocking',
  !evaluateSignoffBlocking({ enabled: true, authorIsMaintainer: true }));
check('Request Changes 等作者时不 blocking', !evaluateSignoffBlocking({ enabled: true, waitingForAuthor: true }));
check('已有 release 时不 blocking', !evaluateSignoffBlocking({ enabled: true, released: { via: 'github-approve' } }));
check('未启用时不 blocking', !evaluateSignoffBlocking({ enabled: false }));

// ── ④ 成员作者 merge routes:普通/admin 都保留硬门 ──
check('非成员作者可沿用 GitHub 普通 merge 保护', evaluateNormalMergeAvailable({
  canMerge: true, blockClass: 'none', approvalExempt: false,
}));
check('成员作者普通 merge 必须绑定 head', !evaluateNormalMergeAvailable({
  canMerge: true, blockClass: 'none', approvalExempt: true, headVerified: false, staleRebaseChecked: true,
}));
check('成员作者普通 merge 的 stale compare 未完成时拒绝', !evaluateNormalMergeAvailable({
  canMerge: true, blockClass: 'none', approvalExempt: true, headVerified: true, staleRebaseChecked: false,
}));
check('成员作者普通 merge 的 head/stale 都验证后放行', evaluateNormalMergeAvailable({
  canMerge: true, blockClass: 'none', approvalExempt: true, headVerified: true, staleRebaseChecked: true,
}));
check('compare behind_by=null 不算已验证', !parseStaleRebaseCompare({ behind_by: null }).verified);
check('compare behind_by 字符串不算已验证', !parseStaleRebaseCompare({ behind_by: '0' }).verified);
check('compare behind_by 负数不算已验证', !parseStaleRebaseCompare({ behind_by: -1 }).verified);
check('compare 落后但无 merge base 日期不算已验证',
  !parseStaleRebaseCompare({ behind_by: 1, merge_base_date: null }).verified);
check('compare 落后但日期非法不算已验证',
  !parseStaleRebaseCompare({ behind_by: 1, merge_base_date: 'not-a-date' }).verified);
check('compare behind 0 可验证', parseStaleRebaseCompare({ behind_by: 0 }).verified);
check('compare 落后且日期有效可验证', parseStaleRebaseCompare({
  behind_by: 1, merge_base_date: '2026-08-01T00:00:00Z',
}).verified);

const ADMIN_BASE = {
  approvalExempt: true,
  headVerified: true,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  blockClass: 'awaiting-approval',
  blockerCount: 0,
  unresolvedCount: 0,
  threadsVerified: true,
  botSettled: true,
  botSettleVerified: true,
  hasSignoffLabel: false,
  staleRebaseBlocking: false,
  staleRebaseChecked: true,
  protectedFileCount: 0,
  branchRulesVerified: true,
  ciStatus: 'pass',
};
check('最终维护者集合成员且只差 approval → admin route 仍禁用',
  !evaluateApprovalExemptAdminMerge(ADMIN_BASE).available &&
  evaluateApprovalExemptAdminMerge(ADMIN_BASE).failedChecks.includes('maintainer-author exemption never authorizes admin merge'));
check('null reviewDecision 标记 empty 但拒绝 admin',
  !evaluateApprovalExemptAdminMerge({ ...ADMIN_BASE, reviewDecision: null }).available &&
  evaluateApprovalExemptAdminMerge({ ...ADMIN_BASE, reviewDecision: null }).reviewDecisionWasEmpty);
check('空 reviewDecision 从严拒绝 admin',
  !evaluateApprovalExemptAdminMerge({ ...ADMIN_BASE, reviewDecision: '' }).available);

const ADMIN_FAILURES = [
  ['作者不在最终维护者集合', { approvalExempt: false }],
  ['head 未绑定', { headVerified: false }],
  ['PR 非 OPEN', { state: 'CLOSED' }],
  ['mergeable UNKNOWN', { mergeable: 'UNKNOWN' }],
  ['冲突', { mergeable: 'CONFLICTING' }],
  ['非 BLOCKED', { mergeStateStatus: 'CLEAN' }],
  ['CHANGES_REQUESTED', { reviewDecision: 'CHANGES_REQUESTED' }],
  ['blockClass 不对', { blockClass: 'structural-check' }],
  ['仍有其它 blocker', { blockerCount: 1 }],
  ['thread 状态未验证', { threadsVerified: false }],
  ['仍有 thread', { unresolvedCount: 1 }],
  ['机器人输入未验证', { botSettleVerified: false }],
  ['机器人未静默', { botSettled: false }],
  ['确认标签仍在', { hasSignoffLabel: true }],
  ['stale compare 未完成', { staleRebaseChecked: false }],
  ['stale rebase', { staleRebaseBlocking: true }],
  ['受保护路径', { protectedFileCount: 1 }],
  ['branch rules 未验证', { branchRulesVerified: false }],
  ['CI failed', { ciStatus: 'failed' }],
  ['CI pending', { ciStatus: 'pending' }],
  ['CI unknown', { ciStatus: 'unknown' }],
];
for (const [name, patch] of ADMIN_FAILURES) {
  const result = evaluateApprovalExemptAdminMerge({ ...ADMIN_BASE, ...patch });
  check(`${name} → admin route 不可用`, !result.available, result.failedChecks.join(';'));
}

const FINAL_WRITE_BASE = {
  admin: true,
  approvalExemptAdminAvailable: true,
  structuralBypassAvailable: false,
  expectedHead: 'abc123',
  actualHead: 'ABC123',
  expectedAuthorityDigest: 'sha256:one',
  actualAuthorityDigest: 'sha256:one',
  expectedViewer: 'reviewer',
  actualViewer: 'Reviewer',
  expectedAuthor: 'member',
  actualAuthor: 'Member',
  authorIsMaintainer: true,
  approvalRequired: false,
  maintainerReviewsVerified: true,
  effectiveMaintainerApproval: false,
  reviewDecision: 'REVIEW_REQUIRED',
  state: 'OPEN',
};
check('写侧 authority/head/viewer/author 全绑定后可 admin',
  evaluateFinalMergeAuthorization(FINAL_WRITE_BASE).available);
check('写前新 CHANGES_REQUESTED 关闭 approval-exempt admin route',
  !evaluateFinalMergeAuthorization({ ...FINAL_WRITE_BASE, reviewDecision: 'CHANGES_REQUESTED' }).available);
check('写前 Team digest 变化关闭 merge',
  !evaluateFinalMergeAuthorization({ ...FINAL_WRITE_BASE, actualAuthorityDigest: 'sha256:two' }).available);
check('写前 viewer 切换关闭 merge',
  !evaluateFinalMergeAuthorization({ ...FINAL_WRITE_BASE, actualViewer: 'other' }).available);
const FINAL_TEAM_APPROVED = {
  ...FINAL_WRITE_BASE,
  admin: false,
  approvalExemptAdminAvailable: false,
  expectedAuthor: 'outside',
  actualAuthor: 'outside',
  authorIsMaintainer: false,
  approvalRequired: true,
  maintainerReviewsVerified: true,
  effectiveMaintainerApproval: true,
  reviewDecision: 'APPROVED',
};
check('普通 merge 写前仍有最终维护者集合成员 Approve 时可用',
  evaluateFinalMergeAuthorization(FINAL_TEAM_APPROVED).available);
check('普通 merge 写前 Team Approve 被 dismiss 后关闭',
  !evaluateFinalMergeAuthorization({ ...FINAL_TEAM_APPROVED, effectiveMaintainerApproval: false }).available);
check('structural admin 写前必须仍为 APPROVED', !evaluateFinalMergeAuthorization({
  ...FINAL_WRITE_BASE,
  approvalExemptAdminAvailable: false,
  structuralBypassAvailable: true,
  authorIsMaintainer: false,
  expectedAuthor: 'outside',
  actualAuthor: 'outside',
  reviewDecision: 'CHANGES_REQUESTED',
}).available);

// BLOCKED 同时含其它 ruleset / classic protection 时不得冒充“只差 approval”。
{
  const result = probeBranchProtection('o/r', 'main', {
    ghFn: (args) => {
      const endpoint = args[1] ?? '';
      if (endpoint === 'repos/o/r/rules/branches/main') {
        return { ok: true, stdout: JSON.stringify([
          { type: 'repository_name' },
          { type: 'creation' },
          { type: 'deletion' },
          { type: 'non_fast_forward' },
          { type: 'pull_request' },
          { type: 'update' },
          { type: 'required_status_checks', parameters: {
            required_status_checks: [{ context: 'unit', integration_id: 123 }],
            strict_required_status_checks_policy: true,
          } },
        ]), stderr: '', status: 0 };
      }
      if (endpoint === 'repos/o/r/branches/main/protection') {
        return { ok: true, stdout: JSON.stringify({
          required_status_checks: { checks: [{ context: 'classic-unit', app_id: null }], strict: true },
          required_linear_history: { enabled: true },
        }), stderr: '', status: 0 };
      }
      if (endpoint.endsWith('/required_signatures')) {
        return { ok: false, stdout: '', stderr: 'HTTP 404 Not Found', status: 1 };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  });
  check('classic protection 状态被读取', result?.classicProtectionKnown === true);
  check('ruleset/classic strict 策略被保留', result?.requiredStatusChecksStrict === true);
  check('ruleset integration_id 被保留',
    result?.requiredStatusChecks.some((item) => item.context === 'unit' && item.integrationId === 123));
  check('classic required check 被合并',
    result?.requiredStatusChecks.some((item) => item.context === 'classic-unit' && item.source === 'classic'));
  check('update rule 从严列为不可验证', result?.adminUnverifiedRuleTypes.includes('update'));
  check('repository_name/deletion/non_fast_forward 不误当 PR merge blocker',
    !result?.adminUnverifiedRuleTypes.some((type) => ['repository_name', 'deletion', 'non_fast_forward'].includes(type)));
  check('classic linear history 从严列为不可验证',
    result?.adminUnverifiedRuleTypes.includes('classic:required_linear_history'));
}
{
  const result = probeBranchProtection('o/r', 'main', {
    ghFn: (args) => (args[1] === 'repos/o/r/rules/branches/main'
      ? { ok: true, stdout: '[]', stderr: '', status: 0 }
      : { ok: false, stdout: '', stderr: 'HTTP 403 Forbidden', status: 1 }),
  });
  eq('classic protection 权限不足 fail closed', result, null);
}
check('branch rules 读不到 → 不可 admin',
  !evaluateAdminBranchRules({ probe: null, rollupContexts: [] }).verified);
check('required check 明确上报成功 → rules 可验证',
  evaluateAdminBranchRules({
    probe: {
      classicProtectionKnown: true,
      requiredStatusChecksKnown: true,
      requiredStatusChecks: ['unit'],
      adminUnverifiedRuleTypes: [],
    },
    rollupContexts: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  }).verified);
check('required check 未上报 → 不可 admin',
  !evaluateAdminBranchRules({
    probe: {
      classicProtectionKnown: true,
      requiredStatusChecksKnown: true,
      requiredStatusChecks: ['unit'],
      adminUnverifiedRuleTypes: [],
    },
    rollupContexts: [],
  }).verified);
check('code_scanning 等无法本地证明的规则 → 不可 admin',
  !evaluateAdminBranchRules({
    probe: {
      classicProtectionKnown: true,
      requiredStatusChecksKnown: true,
      requiredStatusChecks: [],
      adminUnverifiedRuleTypes: ['code_scanning'],
    },
    rollupContexts: [],
  }).verified);
check('classic branch protection 未确认 → 不可 admin',
  !evaluateAdminBranchRules({
    probe: {
      classicProtectionKnown: false,
      requiredStatusChecksKnown: true,
      requiredStatusChecks: [],
      adminUnverifiedRuleTypes: [],
    },
    rollupContexts: [],
  }).verified);
check('update rule 不得假装可本地验证',
  !evaluateAdminBranchRules({
    probe: {
      classicProtectionKnown: true,
      requiredStatusChecksKnown: true,
      requiredStatusChecks: [],
      adminUnverifiedRuleTypes: ['update'],
    },
    rollupContexts: [],
  }).verified);
check('绑定 App 的同名 required check 无来源证据 → 不可 admin',
  !evaluateAdminBranchRules({
    probe: {
      classicProtectionKnown: true,
      requiredStatusChecksKnown: true,
      requiredStatusChecks: [{ context: 'unit', integrationId: 123, source: 'ruleset' }],
      adminUnverifiedRuleTypes: [],
    },
    rollupContexts: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  }).verified);
check('绑定 App 的 required check 来源与结果都匹配 → 可验证',
  evaluateAdminBranchRules({
    probe: {
      classicProtectionKnown: true,
      requiredStatusChecksKnown: true,
      requiredStatusChecks: [{ context: 'unit', integrationId: 123, source: 'ruleset' }],
      adminUnverifiedRuleTypes: [],
    },
    rollupContexts: [],
    checkRunsWithApps: [{
      name: 'unit', integrationId: 123, status: 'completed', conclusion: 'success',
    }],
  }).verified);
check('同名 check 来自错误 App → 不可 admin',
  !evaluateAdminBranchRules({
    probe: {
      classicProtectionKnown: true,
      requiredStatusChecksKnown: true,
      requiredStatusChecks: [{ context: 'unit', integrationId: 123, source: 'ruleset' }],
      adminUnverifiedRuleTypes: [],
    },
    rollupContexts: [],
    checkRunsWithApps: [{
      name: 'unit', integrationId: 999, status: 'completed', conclusion: 'success',
    }],
  }).verified);
check('STALE required check 不算严格通过',
  !evaluateAdminBranchRules({
    probe: {
      classicProtectionKnown: true,
      requiredStatusChecksKnown: true,
      requiredStatusChecksStrict: false,
      requiredStatusChecks: ['unit'],
      adminUnverifiedRuleTypes: [],
    },
    rollupContexts: [{ name: 'unit', status: 'COMPLETED', conclusion: 'STALE' }],
  }).verified);
{
  const strictProbe = {
    classicProtectionKnown: true,
    requiredStatusChecksKnown: true,
    requiredStatusChecksStrict: true,
    requiredStatusChecks: ['unit'],
    adminUnverifiedRuleTypes: [],
  };
  const rollupContexts = [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  check('strict required checks + behind 1 → 不可 admin', !evaluateAdminBranchRules({
    probe: strictProbe, rollupContexts, behindBy: 1,
  }).verified);
  check('strict required checks + behind 0 → 可验证', evaluateAdminBranchRules({
    probe: strictProbe, rollupContexts, behindBy: 0,
  }).verified);
}

// ── ⑤ 成员作者旧 CR dismissal:只撤 viewer 自己、必须最终重审通过 ──
const DISMISS_BASE = {
  approvalExempt: true,
  reviewClean: true,
  state: 'OPEN',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'CHANGES_REQUESTED',
  viewerLogin: 'Reviewer',
  reviews: [{ id: 101, state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } }],
  unresolvedCount: 0,
  threadsVerified: true,
  expectedHead: 'abc123',
  actualHead: 'ABC123',
};
{
  const result = evaluateOwnReviewDismissal(DISMISS_BASE);
  check('最终维护者集合成员最终重审通过且只有自己的 CR → 可 dismiss',
    result.available, result.failedChecks.join(';'));
  eq('dismiss 使用 REST numeric id', result.reviewIds, [101]);
}
{
  const reviews = [
    { id: 201, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T01:00:00Z', user: { login: 'other' } },
    { id: 202, state: 'APPROVED', submitted_at: '2026-08-01T02:00:00Z', user: { login: 'other' } },
    { id: 203, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T03:00:00Z', user: { login: 'reviewer' } },
  ];
  eq('每个 reviewer 只保留最后一条实质 review',
    latestSubstantiveReviews(reviews).map((review) => review.id), [202, 203]);
  eq('DISMISSED 终止同一 reviewer 更早的 Approve', latestSubstantiveReviews([
    { id: 301, state: 'APPROVED', submitted_at: '2026-08-01T01:00:00Z', user: { login: 'other' } },
    { id: 301, state: 'DISMISSED', submitted_at: '2026-08-01T01:00:00Z', user: { login: 'other' } },
  ]).map((review) => review.state), ['DISMISSED']);
  const result = evaluateOwnReviewDismissal({ ...DISMISS_BASE, reviews });
  check('别人已被后续 Approve 覆盖的历史 CR 不阻断 viewer 自解',
    result.available, result.failedChecks.join(';'));
  eq('只 dismiss viewer 的当前有效 CR', result.reviewIds, [203]);
}
{
  const result = evaluateOwnReviewDismissal({
    ...DISMISS_BASE,
    reviews: [
      { id: 401, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T01:00:00Z', user: { login: 'reviewer' } },
      { id: 402, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T02:00:00Z', user: { login: 'reviewer' } },
    ],
  });
  check('viewer 有多条历史 CR 时可自解', result.available, result.failedChecks.join(';'));
  eq('dismiss viewer 全部历史 CR 防旧 review 重新浮上', result.reviewIds, [401, 402]);
}
const DISMISS_FAILURES = [
  ['作者不在最终维护者集合', { approvalExempt: false }],
  ['未声明 review clean', { reviewClean: false }],
  ['PR 非 OPEN', { state: 'CLOSED' }],
  ['非 BLOCKED', { mergeStateStatus: 'CLEAN' }],
  ['reviewDecision 非 CR', { reviewDecision: 'REVIEW_REQUIRED' }],
  ['viewer 为空', { viewerLogin: '' }],
  ['混有别人的 CR', { reviews: [
    { id: 101, state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } },
    { id: 102, state: 'CHANGES_REQUESTED', user: { login: 'other' } },
  ] }],
  ['GraphQL node id 不得冒充 REST id', { reviews: [
    { id: 'PRR_node_id', state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } },
  ] }],
  ['thread 状态未完整验证', { threadsVerified: false }],
  ['仍有 thread', { unresolvedCount: 1 }],
  ['缺 expected head', { expectedHead: '' }],
  ['当前 head 为空', { actualHead: '' }],
  ['head 已变化', { actualHead: 'def456' }],
];
for (const [name, patch] of DISMISS_FAILURES) {
  const result = evaluateOwnReviewDismissal({ ...DISMISS_BASE, ...patch });
  check(`${name} → 不可 dismiss`, !result.available, result.failedChecks.join(';'));
}

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('approval-policy.test.mjs: 全部用例通过');
