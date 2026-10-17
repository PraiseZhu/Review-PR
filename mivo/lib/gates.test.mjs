import test from 'node:test';
import assert from 'node:assert/strict';
import { decideGate, buildSignoffPayload, buildGatePushback, isProtectedPathHit, toProtectedDispatch, toSignoffReleaseArgs } from './gates.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toProtectedHoldWake } from './admission.mjs';

// 自动放行新增的导出:动态取,缺失时只让对应用例失败,不让整个文件无法加载。
const { toAutoReleaseNotice, toAutoReleaseCloseComment } = await import('./gates.mjs');

// 合成的 context.mjs 输出:只放判门用到的字段。
function ctx(overrides = {}) {
  const base = {
    ok: true, pr: 12,
    meta: { title: 'feat(canvas): 新增对齐线', author: 'outsider', url: 'https://github.com/o/r/pull/12', mergeStateStatus: 'BLOCKED' },
    files: [{ path: 'src/ui/Align.tsx', additions: 40, deletions: 2 }, { path: 'README.md', additions: 1, deletions: 0 }],
    approvalPolicy: { authorIsMaintainer: false },
    signoff: { authorExempt: false, triggers: [], held: null, labels: { hasAnyLabel: false }, currentBlocker: null, discussionIssue: null },
    security: { hardHitCount: 0, hardHits: [] },
    format: { formatPass: true, formatIssues: [] },
    gate: { unresolvedThreads: [], blockClass: 'awaiting-approval', ci: { status: 'pass' }, botSettle: { settled: true }, reviewerPushbacks: [] },
    auto: { action: 'review', reason: '格式门 + 前置门均通过' },
    review: { tier: 'standard' },
  };
  return structuredClone({ ...base, ...overrides,
    signoff: { ...base.signoff, ...(overrides.signoff ?? {}) },
    gate: { ...base.gate, ...(overrides.gate ?? {}) },
    auto: { ...base.auto, ...(overrides.auto ?? {}) },
  });
}
const productTrigger = (extra = {}) => ({ kind: 'product', detail: 'feat 类型 + 命中 UI 路径', blocking: true, released: null, waitingForAuthor: false, uiFiles: ['src/ui/Align.tsx'], ...extra });

test('全部通过 → 送审,带上 context 的档位', () => {
  const d = decideGate(ctx({ review: { tier: 'heavy' } }));
  assert.equal(d.stage, 'review');
  assert.equal(d.tier, 'heavy');
  assert.deepEqual(d.actions, []);
});

test('维护者确认门:首次在拦开 issue,已 hold 只同步标签', () => {
  const first = decideGate(ctx({ signoff: { triggers: [productTrigger()], currentBlocker: { kind: 'product' } }, auto: { action: 'signoff-gate' } }));
  assert.equal(first.outcome, 'maintainer-signoff');
  assert.deepEqual(first.actions, [{ script: 'signoff-hold', mode: 'full', kind: 'product' }]);
  const held = decideGate(ctx({ signoff: { triggers: [productTrigger()], currentBlocker: { kind: 'product' }, held: { issueNumber: 9 } }, auto: { action: 'signoff-gate' } }));
  assert.deepEqual(held.actions, [{ script: 'signoff-hold', mode: 'labels-only', kind: 'product' }]);
});

test('维护者确认门:豁免作者不拦,残留标签摘掉;放行后关 issue 再往下走', () => {
  // 已通知过(held 存在):不再发通知,只摘残留标签。
  const exempt = decideGate(ctx({ signoff: { authorExempt: true, triggers: [productTrigger({ blocking: false })], held: { issueNumber: 9 }, labels: { hasAnyLabel: true } } }));
  assert.equal(exempt.stage, 'review');
  assert.deepEqual(exempt.actions, [{ script: 'signoff-release', mode: 'labels-only' }]);
  const released = decideGate(ctx({ signoff: { triggers: [productTrigger({ blocking: false, released: { via: 'slack-release' } })], labels: { hasAnyLabel: true }, held: { issueNumber: 9 } } }));
  assert.equal(released.stage, 'review');
  assert.deepEqual(released.actions, [{ script: 'signoff-release', mode: 'labels-only-close-issue' }]);
});

const protectedPath = (extra = {}) => ({ files: ['.github/workflows/ci.yml'], fileCount: 1, released: null, waitingForAuthor: false, ...extra });
const protectedCtx = (overrides = {}) => ctx({ protectedPath: protectedPath(), auto: { action: 'skip-protected-path', reason: '受保护路径' }, ...overrides });

const maintainerRelease = { by: 'praisezhu', via: 'author-maintainer', at: null, fingerprint: 'author-maintainer:praisezhu' };
const maintainerAuthorCtx = (overrides = {}) => protectedCtx({
  meta: { title: 'ci: 调整 workflow', author: 'PraiseZhu', url: 'https://github.com/o/r/pull/12', mergeStateStatus: 'BLOCKED' },
  protectedPath: protectedPath({ released: maintainerRelease }),
  ...overrides,
  signoff: { authorExempt: true, triggers: [], ...(overrides.signoff ?? {}) },
});

// 2026-10-17 维护者拍板:作者是维护者(approvalPolicy.authorIsMaintainer 或 exemptAuthors,即 authorSignoffExempt)改了受保护路径,
// 照样开 GitHub issue、Slack 通报(notice 模式,建完即关),但自动放行,不等任何人。非维护者作者的行为不变。
test('受保护路径:作者是维护者/豁免名单(#971)开 notice issue 并自动放行,不 hold、不发「转人工」提醒', () => {
  assert.equal(isProtectedPathHit(protectedCtx()), true);
  assert.equal(isProtectedPathHit(ctx()), false);
  for (const who of [{ signoff: { authorExempt: true } }, { signoff: { authorExempt: false }, approvalPolicy: { authorIsMaintainer: true } }]) {
    const first = decideGate(maintainerAuthorCtx(who));
    assert.equal(first.stage, 'protected');
    assert.equal(first.outcome, 'protected');
    assert.deepEqual(first.actions, [{ script: 'signoff-hold', mode: 'full', kind: 'protected', issueMode: 'notice' }]);
    assert.deepEqual(first.autoRelease, { by: 'praisezhu' });
    assert.match(first.reason, /作者为维护者/);
    // 已经通知过(notice issue 建完即关):什么都不再做,仍然自动放行
    for (const heldIssue of [{ number: 9, state: 'CLOSED', mode: 'notice' }, { number: 9, state: 'OPEN', mode: 'notice' }]) {
      const again = decideGate(maintainerAuthorCtx({ ...who, signoff: { ...who.signoff, held: { issueNumber: 9 }, heldIssue } }));
      assert.deepEqual(again.actions, [], JSON.stringify(heldIssue));
      assert.deepEqual(again.autoRelease, { by: 'praisezhu' });
    }
  }
  // 残留的确认标签摘掉
  const labelled = decideGate(maintainerAuthorCtx({ signoff: { held: { issueNumber: 9 }, heldIssue: { number: 9, state: 'CLOSED', mode: 'notice' }, labels: { hasAnyLabel: true } } }));
  assert.deepEqual(labelled.actions, [{ script: 'signoff-release', mode: 'labels-only' }]);
  // 受保护路径同时命中 security 触发:并入这一个 notice,不另开
  const withSecurity = decideGate(maintainerAuthorCtx({ signoff: { triggers: [{ kind: 'security', detail: 'x', blocking: false, released: null }] } }));
  assert.deepEqual(withSecurity.actions, [{ script: 'signoff-hold', mode: 'full', kind: 'protected', issueMode: 'notice' }]);
});

test('受保护路径:维护者作者存量 hold 住的 protected issue 下一轮自动放行并关掉,不留无人管的 open issue', () => {
  const stored = maintainerAuthorCtx({ signoff: { held: { issueNumber: 1054 }, heldIssue: { number: 1054, state: 'OPEN', mode: 'protected' }, labels: { hasAnyLabel: true } } });
  const d = decideGate(stored);
  assert.equal(d.outcome, 'protected');
  assert.deepEqual(d.actions, [{ script: 'signoff-release', mode: 'labels-only-close-issue', autoRelease: { by: 'praisezhu' } }]);
  assert.deepEqual(d.autoRelease, { by: 'praisezhu' });
  // 没有残留标签也要关 issue
  assert.deepEqual(decideGate(maintainerAuthorCtx({ signoff: { held: { issueNumber: 1054 }, heldIssue: { number: 1054, state: 'OPEN', mode: 'protected' } } })).actions,
    [{ script: 'signoff-release', mode: 'labels-only-close-issue', autoRelease: { by: 'praisezhu' } }]);
  // 更早的普通确认 issue(没有模式标记)还开着:同样是无人管的 open issue,一并关掉
  assert.deepEqual(decideGate(maintainerAuthorCtx({ signoff: { held: { issueNumber: 1054 }, heldIssue: { number: 1054, state: 'OPEN', mode: 'normal' } } })).actions,
    [{ script: 'signoff-release', mode: 'labels-only-close-issue', autoRelease: { by: 'praisezhu' } }]);
  // protected issue 已经被人关了:不再动
  assert.deepEqual(decideGate(maintainerAuthorCtx({ signoff: { held: { issueNumber: 1054 }, heldIssue: { number: 1054, state: 'CLOSED', mode: 'protected' } } })).actions, []);
  // 放行成立后派服务器写 review-pr
  assert.deepEqual(toProtectedDispatch({ decision: d, protectedPath: stored.protectedPath, checkDone: false }), { dispatch: true, closeIssue: false });
});

test('受保护路径:维护者作者被别的维护者在当前 head Request Changes 时仍交作者,不通知、不放行', () => {
  const d = decideGate(maintainerAuthorCtx({ protectedPath: protectedPath({ waitingForAuthor: true }) }));
  assert.equal(d.outcome, 'changes-requested');
  assert.deepEqual(d.actions, []);
  assert.equal(d.autoRelease, undefined);
});

test('受保护路径:非维护者作者行为不变——开 protected issue 转人工审核,作者本人的放行不算', () => {
  const outsider = { meta: { title: 'ci: x', author: 'outsider', url: 'https://github.com/o/r/pull/12', mergeStateStatus: 'BLOCKED' }, signoff: { authorExempt: false, triggers: [] } };
  const first = decideGate(protectedCtx(outsider));
  assert.equal(first.outcome, 'protected');
  assert.deepEqual(first.actions, [
    { script: 'signoff-hold', mode: 'full', kind: 'protected', issueMode: 'protected' },
    { script: 'notify-protected' },
  ]);
  assert.equal(first.autoRelease, undefined);
  // 已有可复用的确认 issue:只补标签
  const held = decideGate(protectedCtx({ ...outsider, signoff: { ...outsider.signoff, held: { issueNumber: 9 }, heldIssue: { number: 9, state: 'OPEN', mode: 'protected' } } }));
  assert.deepEqual(held.actions[0], { script: 'signoff-hold', mode: 'labels-only', kind: 'protected', issueMode: 'protected' });
  // 旧 issue 是通知(或已关闭):另开新的完整 issue
  for (const heldIssue of [{ number: 9, state: 'CLOSED', mode: 'notice' }, { number: 9, state: 'OPEN', mode: 'notice' }, { number: 9, state: 'CLOSED', mode: 'protected' }]) {
    const fresh = decideGate(protectedCtx({ ...outsider, signoff: { ...outsider.signoff, held: { issueNumber: 9 }, heldIssue } }));
    assert.equal(fresh.actions[0].mode, 'full', JSON.stringify(heldIssue));
  }
  // 非豁免作者 + security 触发 + 受保护路径:只出一个 protected 的 hold,不出普通 hold
  const withSecurity = decideGate(protectedCtx({ signoff: { triggers: [{ kind: 'security', detail: 'x', blocking: true, released: null }], currentBlocker: { kind: 'security' } } }));
  assert.equal(withSecurity.outcome, 'protected');
  assert.deepEqual(withSecurity.actions.filter((a) => a.script === 'signoff-hold'), [{ script: 'signoff-hold', mode: 'full', kind: 'protected', issueMode: 'protected' }]);
  // 作者本人的放行 context 不会给出 released(evaluateMaintainerReview 剔除作者):没有 released 就不派发
  assert.deepEqual(toProtectedDispatch({ decision: first, protectedPath: protectedPath(), checkDone: false }), { dispatch: false, closeIssue: false });
});

test('受保护路径从未 hold 过时(非维护者作者)即使已放行也开 protected issue;已 hold 过才只摘标签', () => {
  const released = protectedPath({ released: { by: 'kirozeng', via: 'github-approve', at: '2026-10-16T01:00:00Z' } });
  const outsider = { meta: { title: 'ci: x', author: 'outsider', url: 'u', mergeStateStatus: 'BLOCKED' } };
  const first = decideGate(protectedCtx({ ...outsider, protectedPath: released, signoff: { authorExempt: false } }));
  assert.equal(first.outcome, 'protected');
  assert.deepEqual(first.actions.filter((a) => a.script === 'signoff-hold'), [
    { script: 'signoff-hold', mode: 'full', kind: 'protected', issueMode: 'protected' },
  ]);
  assert.ok(first.actions.some((a) => a.script === 'notify-protected'));
  const held = decideGate(protectedCtx({
    ...outsider,
    protectedPath: released,
    signoff: { authorExempt: false, held: { issueNumber: 9 }, heldIssue: { number: 9, state: 'OPEN', mode: 'protected' }, labels: { hasAnyLabel: true } },
  }));
  assert.equal(held.actions.some((a) => a.script === 'signoff-hold' && a.mode === 'full'), false);
  assert.deepEqual(held.actions, [{ script: 'signoff-release', mode: 'labels-only' }, { script: 'notify-protected' }]);
});

test('受保护路径已放行(非维护者作者):不再 hold,有残留标签只摘标签;当前 head 被 Request Changes 交作者', () => {
  const released = decideGate(protectedCtx({
    meta: { title: 'ci: x', author: 'outsider', url: 'u', mergeStateStatus: 'BLOCKED' },
    protectedPath: protectedPath({ released: { by: 'kirozeng', via: 'github-approve', at: '2026-10-16T01:00:00Z' } }),
    signoff: { authorExempt: false, labels: { hasAnyLabel: true } },
  }));
  assert.equal(released.outcome, 'protected');
  assert.deepEqual(released.actions, [
    { script: 'signoff-hold', mode: 'full', kind: 'protected', issueMode: 'protected' },
    { script: 'signoff-release', mode: 'labels-only' },
    { script: 'notify-protected' },
  ]);
  const clean = decideGate(protectedCtx({
    protectedPath: protectedPath({ released: { by: 'kirozeng', via: 'issue-comment' } }),
    signoff: { held: { issueNumber: 9 }, heldIssue: { number: 9, state: 'OPEN', mode: 'protected' } },
  }));
  assert.deepEqual(clean.actions, [{ script: 'notify-protected' }]);
  const waiting = decideGate(protectedCtx({ protectedPath: protectedPath({ waitingForAuthor: true }), signoff: { labels: { hasAnyLabel: true } } }));
  assert.equal(waiting.outcome, 'changes-requested');
  assert.deepEqual(waiting.actions, [{ script: 'signoff-release', mode: 'labels-only' }]);
});

test('豁免作者碰到确认门但没改受保护路径:发通知 issue,同一轮照常送审;已通知或没有触发不再发', () => {
  const exempt = { authorExempt: true };
  const notice = decideGate(ctx({ signoff: { ...exempt, triggers: [productTrigger({ blocking: false }), { kind: 'arch', detail: 'huge-diff', blocking: false }] } }));
  assert.equal(notice.stage, 'review');
  assert.deepEqual(notice.actions, [{ script: 'signoff-hold', mode: 'full', kind: 'product', issueMode: 'notice' }]);
  // 类别按处置优先级取
  const sec = decideGate(ctx({ signoff: { ...exempt, triggers: [{ kind: 'arch', blocking: false }, { kind: 'security', blocking: false }] } }));
  assert.equal(sec.actions[0].kind, 'security');
  // 通知不挂标签:有残留标签时只是摘掉
  const withLabel = decideGate(ctx({ signoff: { ...exempt, triggers: [productTrigger({ blocking: false })], labels: { hasAnyLabel: true } } }));
  assert.deepEqual(withLabel.actions.map((a) => a.script), ['signoff-hold', 'signoff-release']);
  // 已通知(PR 上有确认标记)/ 没有触发:不发
  assert.deepEqual(decideGate(ctx({ signoff: { ...exempt, triggers: [productTrigger({ blocking: false })], held: { issueNumber: 9 } } })).actions, []);
  assert.deepEqual(decideGate(ctx({ signoff: { ...exempt, triggers: [] } })).actions, []);
  // 维护者作者同样走通知
  const maintainerAuthor = decideGate(ctx({ approvalPolicy: { authorIsMaintainer: true }, signoff: { triggers: [productTrigger({ blocking: false })] } }));
  assert.equal(maintainerAuthor.actions[0].issueMode, 'notice');
});

test('toProtectedDispatch:放行成立才派 protected-approve;review-pr 已成功只补关 issue', () => {
  const decision = { stage: 'protected', outcome: 'protected' };
  const released = protectedPath({ released: { by: 'kirozeng', via: 'github-approve' } });
  assert.deepEqual(toProtectedDispatch({ decision, protectedPath: released, checkDone: false }), { dispatch: true, closeIssue: false });
  assert.deepEqual(toProtectedDispatch({ decision, protectedPath: released, checkDone: true }), { dispatch: false, closeIssue: true });
  assert.deepEqual(toProtectedDispatch({ decision, protectedPath: protectedPath(), checkDone: false }), { dispatch: false, closeIssue: false });
  assert.deepEqual(toProtectedDispatch({ decision, protectedPath: { ...released, waitingForAuthor: true } }), { dispatch: false, closeIssue: false });
  assert.deepEqual(toProtectedDispatch({ decision: { stage: 'review', outcome: null }, protectedPath: released }), { dispatch: false, closeIssue: false });
  assert.deepEqual(toProtectedDispatch({ decision: { stage: 'protected', outcome: 'changes-requested' }, protectedPath: released }), { dispatch: false, closeIssue: false });
});

test('维护者 Request Changes → changes-requested,不进审查', () => {
  const d = decideGate(ctx({ signoff: { triggers: [productTrigger({ blocking: false, waitingForAuthor: true })], labels: { hasAnyLabel: true } } }));
  assert.equal(d.outcome, 'changes-requested');
  assert.deepEqual(d.actions, [{ script: 'signoff-release', mode: 'labels-only' }]);
});

test('触发全部消失:收旧 issue、摘标签', () => {
  const d = decideGate(ctx({ signoff: { triggers: [], held: { issueNumber: 9 }, labels: { hasAnyLabel: true } } }));
  assert.equal(d.stage, 'review');
  assert.deepEqual(d.actions.map((a) => a.script), ['close-product-issue', 'signoff-release']);
});

test('未解决 thread 排在格式与 CI 之前', () => {
  const d = decideGate(ctx({ gate: { unresolvedThreads: [{ id: 't1' }], ci: { status: 'failed' } }, auto: { action: 'pushback-format' } }));
  assert.equal(d.outcome, 'threads-unresolved');
});

test('凭证硬命中最先打回,不被维护者门包裹', () => {
  const d = decideGate(ctx({
    security: { hardHitCount: 1, hardHits: [{ file: 'src/a.ts', line: 3, kind: 'github-token' }] },
    signoff: { triggers: [productTrigger()] }, auto: { action: 'pushback-security' },
  }));
  assert.equal(d.outcome, 'security');
  assert.deepEqual(d.actions, [{ script: 'request-changes', gateKind: 'security' }]);
});

test('受保护路径 / 格式 / rebase / CI / 冲突 / bot 静默期 各自落到对应结果', () => {
  assert.equal(decideGate(ctx({ auto: { action: 'skip-protected-path', reason: 'x' } })).outcome, 'protected');
  assert.equal(decideGate(ctx({ format: { formatPass: false, formatIssues: ['缺段落'] }, auto: { action: 'pushback-format' } })).outcome, 'format');
  assert.equal(decideGate(ctx({ auto: { action: 'skip-stale-rebase', reason: 'x' } })).outcome, 'rebase');
  const ciFailed = decideGate(ctx({ gate: { ci: { status: 'failed' }, blockClass: 'ci-failed' }, auto: { action: 'skip-gate', reason: 'x' } }));
  assert.equal(ciFailed.outcome, 'ci-failed');
  assert.deepEqual(ciFailed.actions, [{ script: 'retry-ci' }]);
  assert.equal(decideGate(ctx({ gate: { ci: { status: 'pending' } }, auto: { action: 'skip-gate' } })).outcome, 'ci-pending');
  assert.equal(decideGate(ctx({ gate: { blockClass: 'conflict' }, meta: { mergeStateStatus: 'DIRTY' }, auto: { action: 'skip-gate' } })).outcome, 'conflict');
  assert.equal(decideGate(ctx({ gate: { botSettle: { settled: false } }, auto: { action: 'skip-gate' } })).outcome, 'bot-pending');
  assert.equal(decideGate(ctx({ gate: { blockClass: 'review-changes-requested' }, auto: { action: 'skip-gate' } })).outcome, 'changes-requested');
});

test('维护者门在拦时包裹的原走向:放行后按 fallback 继续', () => {
  const d = decideGate(ctx({
    signoff: { triggers: [productTrigger({ blocking: false, released: { via: 'github-approve' } })] },
    auto: { action: 'signoff-gate', fallback: { action: 'review', reason: '通过' } },
  }));
  assert.equal(d.stage, 'review');
});

test('确认 issue 文案:标题前缀、三段正文与确认方式固定', () => {
  const payload = buildSignoffPayload(ctx({ signoff: { triggers: [productTrigger()] } }), 'product');
  assert.equal(payload.issueTitle, '维护者确认 · PR #12 feat(canvas): 新增对齐线');
  assert.match(payload.issueBody, /^### 触发原因\n\n\*\*product\*\* — feat 类型/);
  assert.match(payload.issueBody, /### PR\nhttps:\/\/github.com\/o\/r\/pull\/12/);
  assert.match(payload.issueBody, /在相关 Slack 会话留言「同意放行」、在本 issue 下评论「同意放行」，或直接在 PR 上 Approve；批一次一直有效/);
  assert.match(payload.issueBody, /`src\/ui\/Align.tsx`\(42 行\)/);
  assert.match(payload.commentBody, /讨论 issue：\{\{ISSUE_URL\}\}/);
});

test('确认 issue 三种模式:骨架一致(标题前缀 + 三段),确认方式与首评文案各自写准,正文不含「关联 PR:#」', () => {
  const base = ctx({ signoff: { triggers: [productTrigger()] }, protectedPath: protectedPath() });
  const payloads = {
    normal: buildSignoffPayload(base, 'product', 'normal'),
    protected: buildSignoffPayload(base, 'protected', 'protected'),
    notice: buildSignoffPayload(base, 'product', 'notice'),
  };
  for (const [mode, payload] of Object.entries(payloads)) {
    assert.equal(payload.issueTitle, '维护者确认 · PR #12 feat(canvas): 新增对齐线', mode);
    assert.match(payload.issueBody, /^### 触发原因\n\n[\s\S]*\n### PR\nhttps:\/\/github.com\/o\/r\/pull\/12\n\n### 确认方式\n\n/, mode);
    assert.doesNotMatch(payload.issueBody, /关联\s*PR:#/, mode);
    assert.match(payload.commentBody, /\{\{ISSUE_URL\}\}/, mode);
  }
  assert.match(payloads.protected.issueBody, /\*\*protected\*\* — 改动受保护路径 \.github\/workflows\/ci\.yml\(转人工审核\)/);
  assert.match(payloads.protected.issueBody, /批一次一直有效/);
  assert.match(payloads.protected.issueBody, /把 `review-pr` 检查写为通过/);
  assert.match(payloads.protected.commentBody, /已转人工审核/);
  assert.match(payloads.protected.commentBody, /批一次之后再推新提交不用重批/);
  assert.match(payloads.notice.issueBody, /本 issue 只是通知：作者在豁免名单内，维护者确认门不拦/);
  assert.doesNotMatch(payloads.notice.issueBody, /\*\*通过\*\*/);
  assert.match(payloads.notice.commentBody, /确认门不拦，PR 照常进入自动审查/);
  assert.doesNotMatch(payloads.notice.commentBody, /请维护者审阅/);
  assert.match(payloads.normal.commentBody, /在 Slack 讨论串、讨论 issue 下回复「同意放行」/);
});

test('凭证打回只写文件/行号/类型,行内评论锚在新增行', () => {
  const pushback = buildGatePushback(ctx({ security: { hardHitCount: 2, hardHits: [
    { file: 'src/a.ts', line: 3, kind: 'github-token', sample: 'ghp_ab…(共 40 字符)' },
    { file: 'PR body', line: 1, kind: 'sk-api-key', sample: 'sk-abc…' },
  ] } }), 'security');
  assert.doesNotMatch(pushback.body, /ghp_|sk-abc/);
  assert.match(pushback.body, /`src\/a.ts` 第 3 行:github-token/);
  assert.deepEqual(pushback.comments.map((c) => [c.path, c.line]), [['src/a.ts', 3]]);
});

test('只缺界面证据:打回正文说清楚补截图或 HTML,不提维护者确认', () => {
  const pushback = buildGatePushback(ctx({ format: { formatPass: false, uiEvidenceRequired: true,
    formatIssues: ['缺界面证据:改了界面(src/ui/Align.tsx),但描述里没有改动后的截图/录屏或 HTML 界面。'] } }), 'format');
  assert.match(pushback.body, /改了界面,描述里还没有改动后的界面证据/);
  assert.match(pushback.body, /只要在描述里补上截图\/录屏或 HTML 界面/);
  assert.doesNotMatch(pushback.body, /三段/);
  const mixed = buildGatePushback(ctx({ format: { formatPass: false, uiEvidenceRequired: true,
    formatIssues: ['Title 命中含糊词黑名单', '缺界面证据:改了界面(src/ui/Align.tsx)'] } }), 'format');
  assert.match(mixed.body, /不符合仓库的 PR 格式要求/);
});

test('缺界面证据但只有评论形式的旧打回:打回一次;已有生效的 Request Changes 就不重复', () => {
  const meta = (reviewDecision) => ({ title: 'docs(canvas): x', author: 'outsider', url: 'u', mergeStateStatus: 'BLOCKED', reviewDecision });
  const format = { formatPass: false, uiEvidenceRequired: true, formatIssues: ['缺界面证据:改了界面(src/a.tsx)'] };
  const untold = decideGate(ctx({ meta: meta('APPROVED'), format, auto: { action: 'skip-stale-pushback', reason: 'x' } }));
  assert.equal(untold.outcome, 'format');
  assert.deepEqual(untold.actions, [{ script: 'request-changes', gateKind: 'format' }]);
  const told = decideGate(ctx({ meta: meta('CHANGES_REQUESTED'), format, auto: { action: 'skip-stale-pushback', reason: 'x' } }));
  assert.deepEqual(told.actions, []);
  const otherFormat = decideGate(ctx({ meta: meta('APPROVED'), format: { formatPass: false, formatIssues: ['缺段落'] }, auto: { action: 'skip-stale-pushback', reason: 'x' } }));
  assert.deepEqual(otherFormat.actions, []);
});

// 2026-10-15:只剩 Greptile thread(#927)或只缺界面证据(#926/#935)时零审查被强合;现在照审,补齐前不放行。
const botThread = (id) => ({ id, isBot: true, author: 'greptile-apps' });
const humanThread = (id) => ({ id, isBot: false, author: 'someone' });

test('只剩机器人 thread:照样送审,带 pendingGates;有人留的 thread 照旧卡住', () => {
  const bot = decideGate(ctx({ gate: { unresolvedThreads: [botThread('t1'), botThread('t2')] } }));
  assert.equal(bot.stage, 'review');
  assert.deepEqual(bot.pendingGates, ['bot-threads']);
  assert.match(bot.reason, /只剩 2 条机器人/);
  assert.equal(decideGate(ctx({ gate: { unresolvedThreads: [botThread('t1'), humanThread('t2')] } })).outcome, 'threads-unresolved');
  assert.equal(decideGate(ctx({ gate: { unresolvedThreads: undefined, unresolvedThreadCount: 2 } })).outcome, 'threads-unresolved', '读不到明细按有人的算');
  // 机器人 thread 之外还有别的卡点(context 走 skip-gate):照旧按 thread 卡住,不送审。
  assert.equal(decideGate(ctx({ gate: { unresolvedThreads: [botThread('t1')], ci: { status: 'failed' } }, auto: { action: 'skip-gate', reason: 'x' } })).outcome, 'threads-unresolved');
  assert.equal(decideGate(ctx()).pendingGates, undefined, '全部通过时没有 pendingGates');
});

test('只缺界面证据、其他门都过:打回要证据,同时送审代码', () => {
  const evidence = { formatPass: false, formatIssues: ['缺界面证据'], uiEvidenceRequired: true };
  const first = decideGate(ctx({ format: evidence, gate: { gatePass: true }, auto: { action: 'pushback-format' } }));
  assert.equal(first.stage, 'review');
  assert.deepEqual(first.pendingGates, ['ui-evidence']);
  assert.deepEqual(first.actions, [{ script: 'request-changes', gateKind: 'format' }]);
  // 已经打回过、作者没动:不重复打回,照审。
  const stale = decideGate(ctx({ format: evidence, gate: { gatePass: true }, meta: { reviewDecision: 'CHANGES_REQUESTED' }, auto: { action: 'skip-stale-pushback' } }));
  assert.equal(stale.stage, 'review');
  assert.deepEqual(stale.actions, []);
  // 机器人 thread + 缺证据:两项都挂上。
  const both = decideGate(ctx({ format: evidence, gate: { gatePass: false, blockers: ['1 条 conversation 未 resolve(不分作者)'], unresolvedThreads: [botThread('t1')] }, auto: { action: 'pushback-format' } }));
  assert.deepEqual(both.pendingGates, ['ui-evidence', 'bot-threads']);
  // 还有别的前置门没过,或格式门还有别的问题:照旧只打回。
  assert.equal(decideGate(ctx({ format: evidence, gate: { gatePass: false, blockers: ['CI 未全过:x'] }, auto: { action: 'pushback-format' } })).outcome, 'format');
  assert.equal(decideGate(ctx({ format: { ...evidence, formatIssues: ['缺界面证据', '标题格式不对'] }, gate: { gatePass: true }, auto: { action: 'pushback-format' } })).outcome, 'format');
  assert.equal(decideGate(ctx({ format: { formatPass: false, formatIssues: ['缺段落'] }, gate: { gatePass: true }, auto: { action: 'pushback-format' } })).outcome, 'format');
});

// 放行后补关确认 issue:hold 标记评论任何人都能发,只有绑定本 PR 的 issue 才关(终审 F1)。
const bindings = ['--lock-token', 'tok', '--expected-head', 'h', '--expected-authority-digest', 'd'];
const closeAction = { script: 'signoff-release', mode: 'labels-only-close-issue' };
const heldMarker = { issueUrl: 'https://github.com/o/r/issues/900', issueNumber: 900 };

test('toSignoffReleaseArgs:issue 绑定本 PR 才带 --close-issue', () => {
  const ok = toSignoffReleaseArgs({ action: closeAction, pr: 971, held: heldMarker, heldIssue: { number: 900, state: 'OPEN', mode: 'protected' }, bindings });
  assert.deepEqual(ok.args, ['971', '--labels-only', '--close-issue', ...bindings]);
  assert.equal(ok.warning, undefined);
  // notice issue 属于本 PR,照旧可关
  assert.ok(toSignoffReleaseArgs({ action: closeAction, pr: 971, held: heldMarker, heldIssue: { number: 900, state: 'OPEN', mode: 'notice', releaseUntrusted: 'notice-issue' }, bindings }).args.includes('--close-issue'));
  // 没有 hold 标记:没有要关的 issue,脚本自己跳过,参数不变
  assert.ok(toSignoffReleaseArgs({ action: closeAction, pr: 971, held: null, heldIssue: null, bindings }).args.includes('--close-issue'));
  // 只摘标签的 action 不受影响
  assert.deepEqual(toSignoffReleaseArgs({ action: { script: 'signoff-release', mode: 'labels-only' }, pr: 971, held: heldMarker, heldIssue: null, bindings }).args, ['971', '--labels-only', ...bindings]);
});

test('toSignoffReleaseArgs:伪造标记指向别的 PR 的 issue、读不到 issue、编号对不上都不带 --close-issue,只给 warning', () => {
  const forged = toSignoffReleaseArgs({ action: closeAction, pr: 971, held: heldMarker,
    heldIssue: { number: 900, state: 'OPEN', mode: 'normal', releaseUntrusted: 'issue-not-bound' }, bindings });
  assert.deepEqual(forged.args, ['971', '--labels-only', ...bindings]);
  assert.match(forged.warning, /issue-not-bound/);
  assert.match(forged.warning, /900/);
  const unread = toSignoffReleaseArgs({ action: closeAction, pr: 971, held: heldMarker, heldIssue: { number: 900, state: null }, bindings });
  assert.ok(!unread.args.includes('--close-issue'));
  assert.match(unread.warning, /issue-unverified/);
  assert.ok(!toSignoffReleaseArgs({ action: closeAction, pr: 971, held: heldMarker, heldIssue: null, bindings }).args.includes('--close-issue'));
  assert.ok(!toSignoffReleaseArgs({ action: closeAction, pr: 971, held: heldMarker, heldIssue: { number: 901, state: 'OPEN' }, bindings }).args.includes('--close-issue'));
});

test('终审 F1 复现:受保护路径已放行 + check 已 success + 伪造标记指向别的 PR 的 issue → 仍判 closeIssue,但执行时不带 --close-issue', () => {
  const protectedPath = { files: ['.github/workflows/ci.yml'], released: true, waitingForAuthor: false };
  const decision = decideGate(ctx({ protectedPath, auto: { action: 'skip-protected-path' },
    signoff: { held: heldMarker, heldIssue: { number: 900, state: 'OPEN', mode: 'normal', releaseUntrusted: 'issue-not-bound' } } }));
  assert.equal(decision.stage, 'protected');
  const next = toProtectedDispatch({ decision, protectedPath, checkDone: true });
  assert.equal(next.closeIssue, true);
  const run = toSignoffReleaseArgs({ action: closeAction, pr: 12, held: heldMarker,
    heldIssue: { number: 900, state: 'OPEN', mode: 'normal', releaseUntrusted: 'issue-not-bound' }, bindings });
  assert.ok(!run.args.includes('--close-issue'));
});

test('接线:round 用 toSignoffReleaseArgs 并记 warning;context 把 releaseUntrusted 放进 heldIssue', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const round = read('../prereview/round.mjs');
  assert.match(round, /toSignoffReleaseArgs\(/);
  assert.doesNotMatch(round, /action\.mode === 'labels-only-close-issue' \? \['--close-issue'\]/);
  assert.match(read('../../review-pr/scripts/context.mjs'), /heldIssue: earlyDiscussionIssue[\s\S]{0,300}releaseUntrusted/);
});

test('受保护路径 notice 文案:骨架与普通 notice 一致,写准「作者为维护者、自动放行」,不要求任何人回复', () => {
  const base = maintainerAuthorCtx();
  const payload = buildSignoffPayload(base, 'protected', 'notice');
  assert.equal(payload.issueTitle, '维护者确认 · PR #12 ci: 调整 workflow');
  assert.match(payload.issueBody, /^### 触发原因\n\n[\s\S]*\n### PR\nhttps:\/\/github.com\/o\/r\/pull\/12\n\n### 确认方式\n\n/);
  assert.doesNotMatch(payload.issueBody, /关联\s*PR:#/);
  assert.match(payload.issueBody, /\*\*protected\*\* — 改动受保护路径 \.github\/workflows\/ci\.yml(?:\(|（)作者为维护者，自动放行/);
  assert.match(payload.issueBody, /本 issue 只是通知：作者是维护者，受保护路径改动按规则自动放行，不需要回复/);
  assert.match(payload.issueBody, /把 `review-pr` 检查写为通过/);
  assert.doesNotMatch(payload.issueBody, /同意放行|转人工审核|豁免名单/);
  assert.match(payload.commentBody, /本 PR 改了受保护路径（\.github\/workflows\/ci\.yml）/);
  assert.match(payload.commentBody, /作者是维护者，按规则自动放行/);
  assert.match(payload.commentBody, /\{\{ISSUE_URL\}\}/);
  assert.doesNotMatch(payload.commentBody, /已转人工审核|请维护者审阅/);
  // 普通 notice 与 protected 模式文案不被碰
  assert.match(buildSignoffPayload(ctx({ signoff: { triggers: [productTrigger()] }, protectedPath: protectedPath() }), 'product', 'notice').issueBody, /本 issue 只是通知：作者在豁免名单内，维护者确认门不拦/);
  assert.match(buildSignoffPayload(ctx({ protectedPath: protectedPath() }), 'protected', 'protected').commentBody, /已转人工审核/);
});

test('自动放行的作者提醒回执:deduplicated + 指纹,不发评论;能过轮次汇总的受保护提醒校验', () => {
  assert.deepEqual(toAutoReleaseNotice({ head: 'h1', by: 'praisezhu' }), {
    kind: 'protected-path', status: 'deduplicated', head: 'h1', fingerprint: 'author-maintainer:praisezhu', reason: 'author-maintainer-auto-release',
  });
});

test('toAutoReleaseCloseComment:关闭存量 protected issue 时留一句说明', () => {
  const body = toAutoReleaseCloseComment({ pr: 1037, url: 'https://github.com/o/r/pull/1037', by: 'PraiseZhu' });
  assert.match(body, /作者为维护者，按新规则自动放行/);
  assert.match(body, /@PraiseZhu/);
  assert.match(body, /关联 PR:#1037/);
  assert.match(body, /本 issue 由 review-pr 流程自动关闭/);
});

test('toSignoffReleaseArgs:自动放行的关 issue 动作带说明文案文件;绑定校验失败时不带 --close-issue 也不带文案', () => {
  const action = { script: 'signoff-release', mode: 'labels-only-close-issue', autoRelease: { by: 'praisezhu' } };
  const held = { issueUrl: 'https://github.com/o/r/issues/1054', issueNumber: 1054 };
  const ok = toSignoffReleaseArgs({ action, pr: 1037, held, heldIssue: { number: 1054, state: 'OPEN', mode: 'protected' }, bindings, payloadFile: '/r/close.json' });
  assert.deepEqual(ok.args, ['1037', '--labels-only', '--close-issue', '--payload-file', '/r/close.json', ...bindings]);
  const forged = toSignoffReleaseArgs({ action, pr: 1037, held, heldIssue: { number: 1054, state: 'OPEN', mode: 'protected', releaseUntrusted: 'issue-not-bound' }, bindings, payloadFile: '/r/close.json' });
  assert.deepEqual(forged.args, ['1037', '--labels-only', ...bindings]);
  assert.match(forged.warning, /issue-not-bound/);
  // 非自动放行的动作不受影响
  assert.deepEqual(toSignoffReleaseArgs({ action: closeAction, pr: 1037, held, heldIssue: { number: 1054, state: 'OPEN', mode: 'protected' }, bindings, payloadFile: '/r/close.json' }).args,
    ['1037', '--labels-only', '--close-issue', ...bindings]);
});

test('接线:Mini 与服务器只读 context 的 protectedPath.released;说明文案经 payload 文件走 signoff-release/signoff-hold', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const round = read('../prereview/round.mjs');
  const review = read('../server/review.mjs');
  const context = read('../../review-pr/scripts/context.mjs');
  const release = read('../../review-pr/scripts/signoff-release.mjs');
  const hold = read('../../review-pr/scripts/signoff-hold.mjs');
  // 「作者是不是维护者」只在 context 判一次(authorSignoffExempt),Mini 与服务器各自不另写判断
  assert.match(context, /evaluateProtectedPathRelease\(\{[\s\S]{0,300}authorExempt: authorSignoffExempt/);
  for (const [name, src] of [['round.mjs', round], ['review.mjs', review]]) {
    assert.doesNotMatch(src, /exemptAuthors|isSignoffExemptAuthor|authorIsMaintainer/, name);
  }
  assert.match(review, /ctx\.protectedPath\?\.released/);
  // round:自动放行补作者提醒回执,关 issue 的说明文案走 payload 文件
  assert.match(round, /toAutoReleaseNotice\(/);
  assert.match(round, /decision\.autoRelease/);
  assert.match(round, /toAutoReleaseCloseComment\(/);
  assert.match(round, /payloadFile/);
  // 脚本:signoff-release 读 closeCommentBody;signoff-hold 的 notice 关闭文案按 kind 取
  assert.match(release, /closeCommentBody/);
  assert.match(hold, /toNoticeCloseComment\(/);
});

test('接线:自动放行上线时,已 hold 的 protected 记录再被唤醒一次(独立标记文件,不和 #68 那次互相挡)', () => {
  const round = readFileSync(fileURLToPath(new URL('../prereview/round.mjs', import.meta.url)), 'utf8');
  assert.match(round, /function wakeProtectedHoldOnce\(markerName/);
  assert.match(round, /'protected-hold-wake\.json'/);
  assert.match(round, /'protected-author-release-wake\.json'/);
  // 存量维护者 PR(如 #1037)outcome=protected,指纹没变:toProtectedHoldWake 把它们标 retry 一次
  const roundState = { prs: { 1037: { outcome: 'protected', head: 'h' }, 1040: { outcome: 'review', head: 'h2' } } };
  const wake = toProtectedHoldWake({ roundState, alreadyDone: false });
  assert.deepEqual(wake.wake, [1037]);
  assert.equal(wake.next.prs[1037].retry, true);
  assert.equal(wake.next.prs[1040].retry, undefined);
  assert.deepEqual(toProtectedHoldWake({ roundState, alreadyDone: true }).wake, []);
});
