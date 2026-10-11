import test from 'node:test';
import assert from 'node:assert/strict';
import { decideGate, buildSignoffPayload, buildGatePushback } from './gates.mjs';

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
  const exempt = decideGate(ctx({ signoff: { authorExempt: true, triggers: [productTrigger({ blocking: false })], labels: { hasAnyLabel: true } } }));
  assert.equal(exempt.stage, 'review');
  assert.deepEqual(exempt.actions, [{ script: 'signoff-release', mode: 'labels-only' }]);
  const released = decideGate(ctx({ signoff: { triggers: [productTrigger({ blocking: false, released: { via: 'slack-release' } })], labels: { hasAnyLabel: true }, held: { issueNumber: 9 } } }));
  assert.equal(released.stage, 'review');
  assert.deepEqual(released.actions, [{ script: 'signoff-release', mode: 'labels-only-close-issue' }]);
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
  assert.match(payload.issueBody, /在相关 Slack 会话留言「同意放行」，或直接在 PR 上 Approve/);
  assert.match(payload.issueBody, /`src\/ui\/Align.tsx`\(42 行\)/);
  assert.match(payload.commentBody, /讨论 issue：\{\{ISSUE_URL\}\}/);
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
