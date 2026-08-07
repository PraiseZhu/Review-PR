// lib.merge-authorization-policy.test.mjs — 合并授权策略矩阵(SC-1..SC-4 策略层,
// automated-review-gate wave0,2026-08-08)。
//
// 本文件不重复既有单测的逐函数矩阵(那些在 lib.find-approve-merge-authorization /
// lib.evaluate-authorized-fast-merge / lib.decide-structural-bypass-route / pkg-a
// 各文件),而是把「自动审查闸」的政策锁成表:正常自动合并均需 current-head clean
// receipt,人工 break-glass 是唯一例外。
//   SC-1:approval 必须绑定当前 head——四 basis 中只有 independent / own-account@head
//         构成合并依据,stale / none 一律不作数;
//   SC-2:approved shortcut 是「GitHub 聚合裁决 ∧ head 绑定 ∧ own-account 配置约束」
//         的三条件合取,任一不满足即不 granted;
//   SC-3:break-glass 唯一合法形态 = admins 成员人工 + 未编辑 + 独占一行 + 当前 head
//         SHA;其余一切形态(bot / 非 admin / edited / stale / 裸格式 / 行内追加 /
//         fence 展示 / head 缺失)都不构成授权;
//   SC-4:break-glass 的机械前提(泄密扫描未完成/硬命中、物理冲突、required 检查
//         未全绿或读取失败)任何情况不可绕过,且硬阻断时 reportOnly 信号不得被吞。
// 反向变异纪律(与 lib.validate-finding-family.test.mjs 同款):表驱动「预测红集」——
// 每个输入维度逐一变异,断言翻转恰红在目标字段/理由上,不是靠别的维度碰巧红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findApproveMergeAuthorization, evaluateApprovalBasis, resolveApprovedShortcut,
  decideAuthorizedFastMerge, evaluateAuthorizedFastMerge,
} from '../scripts/lib.mjs';

const HEAD = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const rev = (author, state, commitOid, over = {}) => ({ author, isBot: false, state, commitOid, ...over });

// ── SC-1:四 basis 矩阵(只有 current-head approval 构成合并依据)──

test('SC-1 四 basis 矩阵:evaluateApprovalBasis 对 independent/own-account/stale/none 的确定性分类', () => {
  let r = evaluateApprovalBasis({
    reviews: [rev('kirozeng', 'APPROVED', HEAD)], headRefOid: HEAD, viewerLogin: 'PraiseZhu', reviewsComplete: true,
  });
  assert.equal(r.basis, 'independent');
  assert.deepEqual(r.independentApprovers, ['kirozeng']);

  r = evaluateApprovalBasis({
    reviews: [rev('PraiseZhu', 'APPROVED', HEAD)], headRefOid: HEAD, viewerLogin: 'PraiseZhu', reviewsComplete: true,
  });
  assert.equal(r.basis, 'own-account');
  assert.equal(r.ownAccountCurrentHead, true);

  r = evaluateApprovalBasis({
    reviews: [rev('kirozeng', 'APPROVED', OLD)], headRefOid: HEAD, viewerLogin: 'PraiseZhu', reviewsComplete: true,
  });
  assert.equal(r.basis, 'stale');
  assert.deepEqual(r.staleApprovers, ['kirozeng']);
  assert.ok(r.reasons.some((x) => /非当前 head/.test(x)), 'stale 必须有原因说明,供补救指引使用');

  r = evaluateApprovalBasis({
    reviews: [], headRefOid: HEAD, viewerLogin: 'PraiseZhu', reviewsComplete: true,
  });
  assert.equal(r.basis, 'none');
});

test('SC-1 反向变异:只改 approve 绑定的 head(OLD→HEAD)恰好翻转 basis 与 approved 名单', () => {
  const stale = evaluateApprovalBasis({ reviews: [rev('kirozeng', 'APPROVED', OLD)], headRefOid: HEAD, viewerLogin: 'PraiseZhu', reviewsComplete: true });
  assert.equal(stale.basis, 'stale');
  const fresh = evaluateApprovalBasis({ reviews: [rev('kirozeng', 'APPROVED', HEAD)], headRefOid: HEAD, viewerLogin: 'PraiseZhu', reviewsComplete: true });
  assert.equal(fresh.basis, 'independent', '同一 reviewer 同一 state,只改 commitOid → basis 必须翻转');
  assert.deepEqual(fresh.independentApprovers, ['kirozeng']);
});

test('SC-1 数据完整性:reviewsComplete=false(connection 缺失/分页未到底)不得谎报 basis', () => {
  const r = evaluateApprovalBasis({ reviews: [rev('kirozeng', 'APPROVED', HEAD)], headRefOid: HEAD, viewerLogin: 'PraiseZhu', reviewsComplete: false });
  assert.equal(r.dataComplete, false);
  assert.equal(r.basis, 'none', '不完整数据 fail-closed,不当 independent 处理');
});

// ── SC-2:approved shortcut 三条件合取 ──

test('SC-2 resolveApprovedShortcut 矩阵:head 绑定 ∧ 聚合裁决 ∧ own-account 约束', () => {
  const g = (over = {}) => ({ approvalBasis: { basis: 'independent' }, ownAckRequired: false, headBoundAuthorized: false, reviewDecision: 'APPROVED', ...over });
  assert.equal(resolveApprovedShortcut(g()).granted, true, 'independent@head + 聚合 APPROVED → granted');
  // 反向变异 1:approve 变 stale → 红在 stale-approval 理由
  let r = resolveApprovedShortcut(g({ approvalBasis: { basis: 'stale' } }));
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'stale-approval(approve 非当前 head)');
  // 反向变异 2:聚合裁决 REVIEW_REQUIRED(仓库要求 2 个 approval / Code Owner 未满足)→
  // 红在 github-review-decision-not-approved——单条 current-head approval 不能替代聚合规则
  r = resolveApprovedShortcut(g({ reviewDecision: 'REVIEW_REQUIRED' }));
  assert.equal(r.granted, false);
  assert.match(r.reason, /github-review-decision-not-approved/);
  // 反向变异 3:own-account + 配置开 + 无 head 绑定授权 → 红在 needs-explicit-auth
  r = resolveApprovedShortcut(g({ approvalBasis: { basis: 'own-account' }, ownAckRequired: true, headBoundAuthorized: false }));
  assert.equal(r.granted, false);
  assert.match(r.reason, /own-account-approval-needs-explicit-auth/);
  // 变异 3b:同一场景 + head 绑定 /approve-merge 授权 → granted(唯一出路)
  r = resolveApprovedShortcut(g({ approvalBasis: { basis: 'own-account' }, ownAckRequired: true, headBoundAuthorized: true }));
  assert.equal(r.granted, true);
  // 变异 4:own-account + 配置未开 → granted(现状兼容路径不受伤)
  r = resolveApprovedShortcut(g({ approvalBasis: { basis: 'own-account' }, ownAckRequired: false }));
  assert.equal(r.granted, true);
  // 变异 5:无 basis → 拒绝且理由携带原因明细(不是"缺 APPROVED"笼统话术)
  r = resolveApprovedShortcut(g({ approvalBasis: { basis: 'none', reasons: ['无 APPROVED'] } }));
  assert.equal(r.granted, false);
  assert.match(r.reason, /no-approval-basis/);
  assert.match(r.reason, /无 APPROVED/);
});

// ── SC-3:break-glass 唯一合法形态表 ──

test('SC-3 break-glass 唯一形态表:人工+未编辑+独占一行+admin+当前 head,任一维度变异即不授权', () => {
  const c = (author, body, over = {}) => ({
    author, isBot: false, body, createdAt: '2026-08-08T00:00:00Z', updatedAt: '2026-08-08T00:00:00Z', url: 'u', ...over,
  });
  const GOOD = `/approve-merge ${HEAD}`;
  const cases = [
    ['唯一合法形态(对照)', c('PraiseZhu', GOOD), true],
    ['bot 评论(自动化不能授权)', c('PraiseZhu', GOOD, { isBot: true }), false],
    ['非 admins 成员', c('outsider', GOOD), false],
    ['被编辑过(updatedAt≠createdAt)', c('PraiseZhu', GOOD, { updatedAt: '2026-08-08T01:00:00Z' }), false],
    ['旧 SHA(stale,head 已换)', c('PraiseZhu', `/approve-merge ${OLD}`), false],
    ['裸格式(legacyBare)', c('PraiseZhu', '/approve-merge'), false],
    ['行内追加文字', c('PraiseZhu', `${GOOD} 请尽快`), false],
    ['code fence 展示', c('PraiseZhu', '```\n' + GOOD + '\n```'), false],
    ['blockquote 展示', c('PraiseZhu', `> ${GOOD}`), false],
  ];
  for (const [label, comment, expectAuth] of cases) {
    const r = findApproveMergeAuthorization({ comments: [comment], admins: ['PraiseZhu'], headRefOid: HEAD });
    assert.equal(r.authorized != null, expectAuth, `${label}:authorized 应为 ${expectAuth},got ${JSON.stringify(r)}`);
  }
});

test('SC-3 headRefOid 缺失/非法 → break-glass 全灭(fail-closed,没有"当前 head"可比对绝不放行)', () => {
  const c = (body) => ({ author: 'PraiseZhu', isBot: false, body, createdAt: '2026-08-08T00:00:00Z', updatedAt: '2026-08-08T00:00:00Z', url: 'u' });
  for (const head of ['', null, undefined, 'deadbeef']) {
    const r = findApproveMergeAuthorization({ comments: [c(`/approve-merge ${HEAD}`)], admins: ['PraiseZhu'], headRefOid: head });
    assert.equal(r.authorized, null, `head=${head}`);
    assert.equal(r.stale.length, 1, `head=${head}:无 head 可比对时授权评论应计入 stale 待重发`);
  }
});

test('SC-3 跨时点语义:授权后 push 换 head,同一评论再查即失效(不是"历史授权永久有效")', () => {
  const comment = { author: 'PraiseZhu', isBot: false, body: `/approve-merge ${HEAD}`, createdAt: '2026-08-08T00:00:00Z', updatedAt: '2026-08-08T00:00:00Z', url: 'u' };
  const atOldHead = findApproveMergeAuthorization({ comments: [comment], admins: ['PraiseZhu'], headRefOid: HEAD });
  assert.ok(atOldHead.authorized, '授权时 head 匹配 → authorized');
  const NEW_HEAD = 'f'.repeat(40);
  const afterPush = findApproveMergeAuthorization({ comments: [comment], admins: ['PraiseZhu'], headRefOid: NEW_HEAD });
  assert.equal(afterPush.authorized, null, 'push 换 head 后同一评论必须失效');
  assert.equal(afterPush.stale.length, 1);
});

test('SC-3 多 SHA 行:一条评论里命中当前 head 的行即授权(解析按行,不整体作废)', () => {
  const comment = { author: 'PraiseZhu', isBot: false, body: `/approve-merge ${OLD}\n/approve-merge ${HEAD}`, createdAt: '2026-08-08T00:00:00Z', updatedAt: '2026-08-08T00:00:00Z', url: 'u' };
  const r = findApproveMergeAuthorization({ comments: [comment], admins: ['PraiseZhu'], headRefOid: HEAD });
  assert.ok(r.authorized);
  assert.equal(r.authorized.author, 'PraiseZhu');
});

// ── SC-5(策略层):loop 托管 PR 无条件封死 break-glass ──

test('SC-5 loop 托管 PR + 有效授权 + 其余条件均满足 → authorizedFastMergeAvailable 仍为 false,且不发起机械评估', () => {
  let evalCalls = 0;
  const r = decideAuthorizedFastMerge({
    approveMergeAuth: { authorized: { author: 'PraiseZhu', url: 'u', createdAt: '2026-08-08T00:00:00Z' } },
    loopExclusionForGate: { matched: true, verdict: 't2', source: 'state.json', matchedPrefix: '[mivo] ' },
    computeEligibility: () => { evalCalls += 1; return { authorizedFastMergeAvailable: true, blockedReason: null, reportOnly: [] }; },
  });
  assert.equal(r.authorizedFastMergeAvailable, false, 'loop 托管必须压过一切其余条件');
  assert.match(r.authorizedFastMergeInfo.blockedReason, /loop-managed-pr-fast-merge-forbidden/);
  assert.equal(evalCalls, 0, 'loop 命中时不发起网络请求(既有行为)');
});

// ── SC-4:break-glass 机械前提矩阵 ──

test('SC-4 机械前提预测红集:五类硬门逐一变异必须恰好红在各自 blockedReason', () => {
  const GREEN = { requiredFailed: [], requiredPending: [], nonRequiredFailed: [], nonRequiredPending: [] };
  const base = {
    security: { scanned: true, hardHitCount: 0 }, mergeStateStatus: 'CLEAN',
    unresolvedThreadCount: 0, formatPass: true, formatIssues: [], requiredChecks: GREEN,
  };
  const reds = [
    ['scanned=false(未证明无泄露)', { ...base, security: { scanned: false, hardHitCount: 0 } }, /扫描未成功完成|重试/],
    ['hardHitCount=1(泄密硬门)', { ...base, security: { scanned: true, hardHitCount: 1 } }, /security\.hardHits/],
    ['mergeStateStatus=DIRTY(物理冲突)', { ...base, mergeStateStatus: 'DIRTY' }, /DIRTY/],
    ['requiredFailed 非空', { ...base, requiredChecks: { ...GREEN, requiredFailed: ['lint'] } }, /必需检查失败/],
    ['requiredPending 非空', { ...base, requiredChecks: { ...GREEN, requiredPending: ['e2e'] } }, /还在跑/],
    ['requiredChecks=null(读取失败)', { ...base, requiredChecks: null }, /读取失败/],
  ];
  for (const [label, input, re] of reds) {
    const r = evaluateAuthorizedFastMerge(input);
    assert.equal(r.eligible, false, `${label}:必须 eligible=false`);
    assert.match(r.blockedReason, re, `${label}:blockedReason 必须锚定该维度,不能是别的理由`);
  }
  // 对照组:全绿 → eligible=true(证明上面不是"一律拒")
  const ok = evaluateAuthorizedFastMerge(base);
  assert.equal(ok.eligible, true);
  assert.equal(ok.blockedReason, null);
});

test('SC-4 security 缺失/空对象 → fail-closed(未证明无泄露不当"无命中"处理)', () => {
  for (const security of [undefined, null, {}]) {
    const r = evaluateAuthorizedFastMerge({
      security, mergeStateStatus: 'CLEAN', unresolvedThreadCount: 0, formatPass: true,
      formatIssues: [], requiredChecks: { requiredFailed: [], requiredPending: [], nonRequiredFailed: [], nonRequiredPending: [] },
    });
    assert.equal(r.eligible, false, `security=${JSON.stringify(security)}`);
    assert.match(r.blockedReason, /扫描未成功完成|重试/);
  }
});

test('SC-4 硬阻断时 reportOnly 不吞信号(fail-visible:扫描失败也要带上格式/thread 信号)', () => {
  const r = evaluateAuthorizedFastMerge({
    security: { scanned: false, hardHitCount: 0 }, mergeStateStatus: 'CLEAN',
    unresolvedThreadCount: 2, formatPass: false, formatIssues: ['Title 缺合规 type 前缀'],
    requiredChecks: { requiredFailed: [], requiredPending: [], nonRequiredFailed: [], nonRequiredPending: [] },
  });
  assert.equal(r.eligible, false);
  assert.deepEqual(r.reportOnly.formatIssues, ['Title 缺合规 type 前缀']);
  assert.equal(r.reportOnly.unresolvedThreadCount, 2);
});
