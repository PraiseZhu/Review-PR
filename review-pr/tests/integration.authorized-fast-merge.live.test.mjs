// 端到端集成重放 —— 用真实 GitHub 数据(xindong/mivo-canvas 的历史/存量 PR,只读 GraphQL/
// REST 查询,不产生任何写操作)喂给完整链路,验证 2026-08-01/2026-08-02 两轮裁决在真实
// 数据下依然成立,而不只是纯函数层面的构造数据。
//
// 需要:已认证的 `gh` CLI + 网络可达 GitHub API。CI / 离线环境会自动 skip,不会让整个
// 套件失败——这是"锦上添花"的真实数据校验,核心正确性由同目录下的纯函数单测保证。
//
// 跑:node --test review-pr/tests/integration.authorized-fast-merge.live.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchHeadCheckContexts, fetchExpectedRequiredContexts, classifyRequiredChecks,
  evaluateAuthorizedFastMerge, findApproveMergeAuthorization, scanPrSensitiveContent,
} from '../scripts/lib.mjs';

// mivo-canvas #394(chore(deps): dependabot 忽略 typescript major 升级)——2026-08-01
// 重放时是结构性 BLOCKED 场景(code_scanning/code_quality 永不上报),head 上所有已上报
// required 检查全绿。选它是因为它是当时唯一现成的、真实存在 structural-check 卡点的
// open PR,可以拿它的 head checks 做"真实数据没有 required 失败"这一断言;PR 状态可能
// 随时间变化(被合并/关闭/新 commit),因此本测试只断言"若查得到数据,链路能正确跑通并
// 与纯函数结果一致",不断言"PR 现在处于什么状态"。
const LIVE_REPO = { owner: 'xindong', repo: 'mivo-canvas', pr: 394, baseRefName: 'main' };

test('端到端:真实 head checks 数据 → classifyRequiredChecks 输出形状正确', async (t) => {
  const nodes = fetchHeadCheckContexts(LIVE_REPO);
  if (!nodes) {
    t.skip('fetchHeadCheckContexts 返回 null(gh 未认证 / 网络不可达 / PR 已不存在),跳过端到端重放');
    return;
  }
  assert.ok(Array.isArray(nodes) && nodes.length > 0, '真实 PR 应该有至少一条 head check');
  const required = classifyRequiredChecks(nodes);
  assert.ok(required, 'classifyRequiredChecks 对真实数据不应返回 null');
  for (const key of ['requiredFailed', 'requiredPending', 'nonRequiredFailed', 'nonRequiredPending']) {
    assert.ok(Array.isArray(required[key]), `${key} 必须是数组`);
  }
});

test('端到端:真实 required-checks 数据 + 构造的格式问题/未 resolve thread → eligible 仍由 required 检查决定(2026-08-01 裁决在真实数据下成立)', async (t) => {
  const nodes = fetchHeadCheckContexts(LIVE_REPO);
  if (!nodes) {
    t.skip('fetchHeadCheckContexts 返回 null(gh 未认证 / 网络不可达 / PR 已不存在),跳过端到端重放');
    return;
  }
  const requiredChecks = classifyRequiredChecks(nodes);
  const hasRequiredProblem = requiredChecks.requiredFailed.length > 0 || requiredChecks.requiredPending.length > 0;

  const evaluation = evaluateAuthorizedFastMerge({
    security: { scanned: true, hardHitCount: 0 }, // 构造:真实安全扫描不在本测试范围内,单独由下面的 scanPrSensitiveContent 测试覆盖
    mergeStateStatus: 'BLOCKED', // 与 #394 当时的结构性 BLOCKED 状态一致,不代表冲突
    unresolvedThreadCount: 2, // 构造:假设有 2 条未 resolve thread
    formatPass: false, // 构造:假设格式门未过
    formatIssues: ['Description 缺段落: 风险'],
    requiredChecks,
  });

  // 核心断言:即使构造了格式问题 + 未 resolve thread,只要真实 required 检查没有已知问题,
  // eligible 就应该是 true——这正是 2026-08-01 裁决要验证的行为,且用的是真实网络数据
  // (不是像纯函数单测那样完全构造 GREEN_REQUIRED),证明 fetchHeadCheckContexts 的真实
  // 输出形状能被 classifyRequiredChecks/evaluateAuthorizedFastMerge 正确消费。
  assert.equal(evaluation.eligible, !hasRequiredProblem, 'eligible 应且只应由真实 required 检查状态决定,不受构造的格式/thread 问题影响');
  assert.deepEqual(evaluation.reportOnly.formatIssues, ['Description 缺段落: 风险']);
  assert.equal(evaluation.reportOnly.unresolvedThreadCount, 2);
});

test('端到端(P1-3):真实分支保护 required_status_checks 名单可读取,classifyRequiredChecks 完整性核验不因缺失分支保护而误报', async (t) => {
  const nodes = fetchHeadCheckContexts(LIVE_REPO);
  if (!nodes) {
    t.skip('fetchHeadCheckContexts 返回 null,跳过端到端重放');
    return;
  }
  const expected = fetchExpectedRequiredContexts(`${LIVE_REPO.owner}/${LIVE_REPO.repo}`, LIVE_REPO.baseRefName);
  if (!expected) {
    t.skip('fetchExpectedRequiredContexts 返回 null(权限/网络问题),跳过——该场景已由纯函数单测覆盖 fail-closed 行为');
    return;
  }
  assert.ok(expected instanceof Set, '真实读取成功时必须返回 Set(即使为空集合)');
  const required = classifyRequiredChecks(nodes, expected);
  assert.ok(required, '带 expectedRequiredNames 的完整性核验不应让真实数据链路抛错或返回 null');
  // 不断言具体数量(真实分支保护规则会变),只验证形状与"不因完整性核验而崩"。
  for (const key of ['requiredFailed', 'requiredPending', 'nonRequiredFailed', 'nonRequiredPending']) {
    assert.ok(Array.isArray(required[key]), `${key} 必须是数组`);
  }
});

test('端到端(P1-1):scanPrSensitiveContent 对真实 PR 标题/body/diff 完整跑一遍,scanned=true(无网络异常时)', async (t) => {
  const result = scanPrSensitiveContent({
    owner: LIVE_REPO.owner, repo: LIVE_REPO.repo, pr: LIVE_REPO.pr, title: 'test title', body: 'test body', sensitiveRules: {},
  });
  if (!result.scanned) {
    t.skip(`scanPrSensitiveContent 未成功完成(${result.error ?? '未知原因'}),跳过——fail-closed 行为已由纯函数单测覆盖`);
    return;
  }
  assert.equal(typeof result.hardHitCount, 'number');
  assert.equal(typeof result.softHitCount, 'number');
  assert.ok(Array.isArray(result.hardHits));
  assert.ok(Array.isArray(result.softHits));
});

test('端到端:findApproveMergeAuthorization 对真实 comments 形状(空评论列表)不抛错,fail-closed 返回 null', () => {
  // 不打真实 GraphQL(评论内容与本次修复无关,且不应对活跃仓库做额外只读调用),只验证
  // 函数签名与真实 PR 数据形状(rawComments 为空数组是完全合法的真实情形)兼容。
  const r = findApproveMergeAuthorization({ comments: [], admins: ['PraiseZhu'], latestPushDate: '2026-08-01T00:00:00Z' });
  assert.equal(r.authorized, null);
  assert.equal(r.adminsConfigured, true);
});
