// findApproveMergeAuthorization(head 绑定版,SC-A 2026-08-04)+ parseApproveMergeShaCommands 单测。
//
// 语义变更背景:旧版依赖 latestPushDate(Commit.pushedDate + force-push 事件)判「授权须
// 晚于最后真实 push」。实测 pushedDate 已被 GitHub 废弃(#469 的 12 个 commit 全 null)——
// 无 force-push 的 PR 上全部授权被误判 stale,有旧 force-push 再普通 push 则可能漏判。
// 新版:`/approve-merge <完整 40 位 head SHA>`,SHA 精确等于当前 headRefOid 才有效;push
// 换 head 即天然作废。旧裸格式不构成授权,计入 legacyBare 供提醒重发。
// 原 P1-6(独占一行)/ P2-2(编辑拒绝)/ 展示语境剔除(code fence/blockquote)语义全部保留。
//
// automated-review-gate wave0(2026-08-08)再修订:**授权名单与 admins 解耦**。
// `/approve-merge` 是人工 break-glass 的唯一形态,其授权人名单由
// `mergeAuthorization.breakGlassApprovers` 配置键独立声明——`admins` 只服务于
// admin-trust 结构性路由,不再参与紧急通道授权。测试一律把 breakGlassApprovers 传给
// findApproveMergeAuthorization 当授权契约,admins 传无关值;断言:
//   - admins 含 X 但 breakGlassApprovers 不含 X → 不授权(fail-closed);
//   - breakGlassApprovers 含 X(即便 admins 不含)→ 授权;
//   - breakGlassApprovers 未配置 → 恒不授权(自动化时代人工紧急通道必须显式配置)。
// 以上用例在旧实现(admins 即授权名单)上**全部预期红**——本文件是 TDD 红测试,
// 待 core wave 实现新语义后转绿。编辑拒绝/head 绑定/独占一行等既有语义的用例
// 传参同步迁移,行为断言不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findApproveMergeAuthorization, parseApproveMergeShaCommands, hasApproveMergeCommand } from '../scripts/lib.mjs';

const HEAD = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
// breakGlassApprovers = 紧急通道授权人名单(新语义);admins 与授权判定无关,传无关值
const BREAK_GLASS = ['PraiseZhu', 'kirozeng'];
const UNRELATED_ADMINS = ['outsider'];
const c = (author, body, over = {}) => ({
  author, isBot: false, body, createdAt: '2026-08-04T10:00:00Z', updatedAt: '2026-08-04T10:00:00Z', url: 'u', ...over,
});

test('正确 SHA + breakGlassApprovers 成员 + 独占一行 → authorized(admins 与授权无关)', () => {
  // 旧实现:admins=outsider 不含 PraiseZhu → authorized=null → 本用例预期红
  const r = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${HEAD}`)], admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: HEAD });
  assert.ok(r.authorized);
  assert.equal(r.authorized.author, 'PraiseZhu');
});

test('旧 SHA(push 之后未重发)→ stale,不授权 —— 这是 head 绑定的核心语义', () => {
  const r = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${OLD}`)], admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: HEAD });
  assert.equal(r.authorized, null);
  assert.equal(r.stale.length, 1);
});

test('旧裸格式 /approve-merge(不带 SHA)→ 不授权,计入 legacyBare 供提醒重发', () => {
  const r = findApproveMergeAuthorization({ comments: [c('PraiseZhu', '/approve-merge')], admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: HEAD });
  assert.equal(r.authorized, null);
  assert.equal(r.legacyBare.length, 1);
  assert.equal(r.stale.length, 0);
});

test('headRefOid 缺失/非法 → 全部判 stale(fail-closed,没有"当前 head"可比对绝不放行)', () => {
  for (const head of ['', null, 'deadbeef']) {
    const r = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${HEAD}`)], admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: head });
    assert.equal(r.authorized, null, `head=${head}`);
  }
});

test('非名单 / bot 的命令不算;breakGlassApprovers 缺失 → 回退 admins,显式 [] → 关闭(兼容期两组)', () => {
  const r1 = findApproveMergeAuthorization({ comments: [c('outsider', `/approve-merge ${HEAD}`)], admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: HEAD });
  assert.equal(r1.authorized, null);
  const r2 = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${HEAD}`, { isBot: true })], admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: HEAD });
  assert.equal(r2.authorized, null);
  // 兼容期(裁决 1)两组语义:
  //   缺失(undefined/null)→ 回退 admins 名单(与 resolveMergeAuthorizationPolicy 同口径),
  //   作者在 admins 即构成授权——不是"恒不授权";
  for (const bg of [undefined, null]) {
    const r3 = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${HEAD}`)], admins: ['PraiseZhu'], breakGlassApprovers: bg, headRefOid: HEAD });
    assert.ok(r3.authorized, `breakGlassApprovers=${JSON.stringify(bg)} 缺失必须回退 admins(作者在 admins → 授权)`);
  }
  //   显式 [] → 紧急通道关闭,任何命令都不授权(fail-closed)
  const r4 = findApproveMergeAuthorization({ comments: [c('PraiseZhu', `/approve-merge ${HEAD}`)], admins: ['PraiseZhu'], breakGlassApprovers: [], headRefOid: HEAD });
  assert.equal(r4.authorized, null, 'breakGlassApprovers=[] 显式空名单必须关闭紧急通道');
});

test('admins 含成员但 breakGlassApprovers 不含 → 不授权(名单解耦的核心语义,旧实现红)', () => {
  // 旧实现:admins 含 PraiseZhu → authorized。新语义:admins 不再参与紧急通道 → 必须 null
  const r = findApproveMergeAuthorization({
    comments: [c('PraiseZhu', `/approve-merge ${HEAD}`)],
    admins: ['PraiseZhu', 'kirozeng'], breakGlassApprovers: ['kirozeng'], headRefOid: HEAD,
  });
  assert.equal(r.authorized, null, 'admins 含 PraiseZhu 但 breakGlass 不含 → 不得授权');
  assert.equal(r.stale.length, 0, '非授权名单成员的命令不算 stale 也不算任何形态');
});

test('反向:breakGlassApprovers 含成员(admins 不含)→ 授权(旧实现红)', () => {
  const r = findApproveMergeAuthorization({
    comments: [c('PraiseZhu', `/approve-merge ${HEAD}`)],
    admins: [], breakGlassApprovers: ['PraiseZhu'], headRefOid: HEAD,
  });
  assert.ok(r.authorized, 'breakGlass 名单含 PraiseZhu 即授权,admins 空不影响');
});

test('P2-2 保留:评论被编辑过(updatedAt !== createdAt)→ 拒绝并计入 edited', () => {
  const r = findApproveMergeAuthorization({
    comments: [c('PraiseZhu', `/approve-merge ${HEAD}`, { updatedAt: '2026-08-04T11:00:00Z' })],
    admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: HEAD,
  });
  assert.equal(r.authorized, null);
  assert.equal(r.edited.length, 1);
});

test('独占一行保留:行内追加文字不算下达;code fence/blockquote 里的命令是展示不是下达', () => {
  assert.deepEqual(parseApproveMergeShaCommands(`/approve-merge ${HEAD} 请尽快`), []);
  assert.deepEqual(parseApproveMergeShaCommands('```\n/approve-merge ' + HEAD + '\n```'), []);
  assert.deepEqual(parseApproveMergeShaCommands(`> /approve-merge ${HEAD}`), []);
  assert.deepEqual(parseApproveMergeShaCommands(`说明文字\n/approve-merge ${HEAD}\n收尾`), [HEAD]);
  assert.deepEqual(parseApproveMergeShaCommands(`/approve-merge ${HEAD.toUpperCase()}`), [HEAD]);
  assert.equal(hasApproveMergeCommand('/approve-merge'), true);
});

test('多条有效授权取最新一条', () => {
  const r = findApproveMergeAuthorization({
    comments: [
      c('PraiseZhu', `/approve-merge ${HEAD}`, { createdAt: '2026-08-04T09:00:00Z', updatedAt: '2026-08-04T09:00:00Z', url: 'early' }),
      c('kirozeng', `/approve-merge ${HEAD}`, { createdAt: '2026-08-04T12:00:00Z', updatedAt: '2026-08-04T12:00:00Z', url: 'late' }),
    ],
    admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: HEAD,
  });
  assert.equal(r.authorized.url, 'late');
});

// ── automated-review-gate wave0 追加(SC-3 边界,2026-08-08)──

test('多 SHA 行:一条评论里命中当前 head 的那一行即授权(按行解析,不整体作废)', () => {
  const r = findApproveMergeAuthorization({
    comments: [c('PraiseZhu', `/approve-merge ${OLD}\n/approve-merge ${HEAD}`)],
    admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: HEAD,
  });
  assert.ok(r.authorized);
  assert.equal(r.authorized.author, 'PraiseZhu');
});

test('breakGlassApprovers 名单与评论作者大小写不敏感(normalizeLoginList 归一化接线)', () => {
  const r = findApproveMergeAuthorization({
    comments: [c('praisezhu', `/approve-merge ${HEAD}`)],
    admins: UNRELATED_ADMINS, breakGlassApprovers: ['PraiseZhu', 'KIROZENG'], headRefOid: HEAD,
  });
  assert.ok(r.authorized, '作者小写 + 名单大写必须命中');
  assert.equal(r.authorized.author, 'praisezhu');
});

test('跨时点语义:授权后 push 换 head,同一评论再查即失效(不是"历史授权永久有效")', () => {
  const comment = c('PraiseZhu', `/approve-merge ${HEAD}`);
  const atOldHead = findApproveMergeAuthorization({ comments: [comment], admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: HEAD });
  assert.ok(atOldHead.authorized, '授权时 head 匹配 → authorized');
  const NEW_HEAD = 'f'.repeat(40);
  const afterPush = findApproveMergeAuthorization({ comments: [comment], admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: NEW_HEAD });
  assert.equal(afterPush.authorized, null, 'push 换 head 后同一评论必须失效');
  assert.equal(afterPush.stale.length, 1);
});

test('同账号多格式混合评论:裸格式与带 SHA 行并存时,带 SHA 且命中当前 head 的行构成授权', () => {
  const r = findApproveMergeAuthorization({
    comments: [c('PraiseZhu', `/approve-merge\n/approve-merge ${HEAD}`)],
    admins: UNRELATED_ADMINS, breakGlassApprovers: BREAK_GLASS, headRefOid: HEAD,
  });
  assert.ok(r.authorized, '混合评论里命中的 SHA 行必须构成授权');
  assert.equal(r.legacyBare.length, 0, '带 SHA 行存在时不算裸格式(hasApproveMergeCommand 与 parse 判定分叉)');
});
