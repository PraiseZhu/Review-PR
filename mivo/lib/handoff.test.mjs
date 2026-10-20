import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadHandoffMode, toHandoffFacts, readHandoffFacts, toHandoffPending, toHandoffPromptLines, HANDOFF_WORKFLOW_PATH } from './handoff.mjs';
import { decideGate, buildGatePushback, PENDING_GATE_TEXT } from './gates.mjs';
import { buildReviewPrompt, buildSpecManifest, specDigestOf, loadReviewSpec } from './prompt.mjs';
import { computeReviewScope, previousFromResult } from './scope.mjs';

const SKILL_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HEAD = 'b'.repeat(40);
const enforceFacts = (over = {}) => ({ present: true, readError: null, mode: 'enforce', conclusion: 'failure',
  errors: [{ code: 'HANDOFF_MISSING', message: '缺少 docs/pr/12/qa.md' }], warnings: [], staleFiles: [], ...over });

test('handoff: 开关缺省、不合法都按 off;合法值照用', () => {
  assert.deepEqual(loadHandoffMode('x', () => JSON.stringify({ verify: {} })), { mode: 'off', warning: null });
  assert.equal(loadHandoffMode('x', () => JSON.stringify({ handoff: { mode: 'on' } })).mode, 'off');
  assert.match(loadHandoffMode('x', () => '{').warning, /按 off 处理/);
  assert.equal(loadHandoffMode('x', () => JSON.stringify({ handoff: { mode: 'enforce' } })).mode, 'enforce');
  // 仓里的开关文件默认 off:合并本改动不改变线上行为
  assert.equal(loadHandoffMode(`${SKILL_ROOT}mivo/config/review-features.json`).mode, 'off');
});

test('handoff: 注解解析出模式、错误(含观察期降级的)、提醒与过期文件', () => {
  const facts = toHandoffFacts({ checkRun: { conclusion: 'success' }, annotations: [
    { annotation_level: 'notice', message: '[MODE] observe' },
    { annotation_level: 'warning', message: '[PLACEHOLDER_LEFT] docs/pr/12/review.md 还有 2 处模板占位符没替换（观察期只提醒）' },
    { annotation_level: 'warning', message: '[RISK_UNMAPPED] 这些风险在 qa.md 里没有对应用例：R2' },
    { annotation_level: 'warning', message: '[STALE] 交接最后更新之后又改了 2 个文件：src/a.ts, src/b.ts' },
    { annotation_level: 'warning', message: '不带编号的注解' },
  ] });
  assert.equal(facts.mode, 'observe');
  assert.deepEqual(facts.errors.map((e) => e.code), ['PLACEHOLDER_LEFT']);
  assert.doesNotMatch(facts.errors[0].message, /观察期只提醒/);
  assert.deepEqual(facts.warnings.map((w) => w.code), ['RISK_UNMAPPED', 'STALE']);
  assert.deepEqual(facts.staleFiles, ['src/a.ts', 'src/b.ts']);
  assert.equal(toHandoffFacts({ checkRun: null }).present, false);
});

test('handoff: 只认 PR Handoff workflow 的 pull_request_target 运行,PR 分支自带的同名 job 不采用', () => {
  const check = { id: 7, name: 'pr-handoff-gate', head_sha: HEAD, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'failure', check_suite: { id: 99 } };
  const gh = (run) => (args) => {
    const path = args[1];
    if (path.includes('/check-runs?check_name=')) return { ok: true, stdout: JSON.stringify({ check_runs: [check, { ...check, id: 8, app: { slug: 'someone' } }] }) };
    if (path.includes('actions/runs?check_suite_id=99')) return { ok: true, stdout: JSON.stringify({ workflow_runs: [run] }) };
    if (path.endsWith('/check-runs/7/annotations?per_page=100')) return { ok: true, stdout: JSON.stringify([{ annotation_level: 'notice', message: '[MODE] enforce' }, { annotation_level: 'failure', message: '[FIELD_EMPTY] R1 有字段没填：触发' }]) };
    return { ok: false, stderr: `unexpected ${path}` };
  };
  const ok = readHandoffFacts({ repo: 'o/r', head: HEAD, ghFn: gh({ path: HANDOFF_WORKFLOW_PATH, event: 'pull_request_target' }) });
  assert.equal(ok.mode, 'enforce');
  assert.deepEqual(ok.errors.map((e) => e.code), ['FIELD_EMPTY']);
  const forged = readHandoffFacts({ repo: 'o/r', head: HEAD, ghFn: gh({ path: HANDOFF_WORKFLOW_PATH, event: 'pull_request' }) });
  assert.equal(forged.present, false);
  assert.match(forged.readError, /不采用/);
  const unreadable = readHandoffFacts({ repo: 'o/r', head: HEAD, ghFn: () => ({ ok: false, stderr: 'HTTP 403' }) });
  assert.equal(unreadable.present, false);
  assert.match(unreadable.readError, /403/);
});

test('handoff: 更晚的冒充记录不遮住已有的可信失败', () => {
  const trusted = { id: 7, name: 'pr-handoff-gate', head_sha: HEAD, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'failure', check_suite: { id: 99 } };
  const forged = { ...trusted, id: 8, conclusion: 'success', check_suite: { id: 100 } };
  const calls = [];
  const gh = (args) => {
    const path = args[1];
    calls.push(path);
    if (path.includes('/check-runs?check_name=')) return { ok: true, stdout: JSON.stringify({ check_runs: [trusted, forged] }) };
    if (path.includes('check_suite_id=100')) return { ok: true, stdout: JSON.stringify({ workflow_runs: [{ path: '.github/workflows/forged.yml', event: 'pull_request' }] }) };
    if (path.includes('check_suite_id=99')) return { ok: true, stdout: JSON.stringify({ workflow_runs: [{ path: HANDOFF_WORKFLOW_PATH, event: 'pull_request_target' }] }) };
    if (path.endsWith('/check-runs/7/annotations?per_page=100')) return { ok: true, stdout: JSON.stringify([{ annotation_level: 'notice', message: '[MODE] enforce' }, { annotation_level: 'failure', message: '[HANDOFF_MISSING] 缺少 docs/pr/12/qa.md' }]) };
    return { ok: false, stderr: `unexpected ${path}` };
  };
  const facts = readHandoffFacts({ repo: 'o/r', head: HEAD, ghFn: gh });
  assert.equal(facts.present, true);
  assert.deepEqual(facts.errors.map((e) => e.code), ['HANDOFF_MISSING']);
  assert.ok(calls.some((p) => p.includes('check_suite_id=100')), '先看了更新的那条');
  assert.equal(toHandoffPending({ featureMode: 'enforce', facts }).length, 1);
});

test('handoff: 只有开关与 Mivo 门都是 enforce 才需要打回;首次送审时过期也算', () => {
  assert.deepEqual(toHandoffPending({ featureMode: 'observe', facts: enforceFacts() }), []);
  assert.deepEqual(toHandoffPending({ featureMode: 'enforce', facts: enforceFacts({ mode: 'observe' }) }), []);
  assert.deepEqual(toHandoffPending({ featureMode: 'enforce', facts: { ...enforceFacts(), present: false } }), []);
  assert.equal(toHandoffPending({ featureMode: 'enforce', facts: enforceFacts() }).length, 1);
  const stale = { featureMode: 'enforce', facts: enforceFacts({ errors: [], staleFiles: ['src/a.ts'] }) };
  assert.deepEqual(toHandoffPending(stale), []);
  assert.match(toHandoffPending(stale, { firstReview: true })[0], /^\[STALE\]/);
});

// 合成的 context.mjs 输出(与 gates.test.mjs 同口径),只放判门用到的字段。
const ctx = (mivoHandoff) => structuredClone({
  ok: true, pr: 12,
  meta: { title: 'feat(canvas): 新增对齐线', author: 'outsider', url: 'https://github.com/o/r/pull/12', mergeStateStatus: 'BLOCKED' },
  approvalPolicy: { authorIsMaintainer: false },
  signoff: { authorExempt: false, triggers: [], held: null, labels: { hasAnyLabel: false }, currentBlocker: null, discussionIssue: null },
  security: { hardHitCount: 0, hardHits: [] },
  format: { formatPass: true, formatIssues: [] },
  gate: { unresolvedThreads: [], blockClass: 'awaiting-approval', ci: { status: 'pass' }, botSettle: { settled: true }, reviewerPushbacks: [] },
  auto: { action: 'review', reason: '格式门 + 前置门均通过' },
  review: { tier: 'standard' },
  ...(mivoHandoff ? { mivoHandoff } : {}),
});

test('handoff 判门:enforce 下照审 + 打回 + 不放行;off / observe 与改动前一致', () => {
  const plain = decideGate(ctx());
  assert.deepEqual(decideGate(ctx({ featureMode: 'off', facts: null })), plain);
  assert.deepEqual(decideGate(ctx({ featureMode: 'observe', facts: enforceFacts() })), plain);
  const d = decideGate(ctx({ featureMode: 'enforce', facts: enforceFacts() }));
  assert.equal(d.stage, 'review');
  assert.deepEqual(d.pendingGates, ['handoff']);
  assert.deepEqual(d.actions, [{ script: 'request-changes', gateKind: 'handoff' }]);
  const told = ctx({ featureMode: 'enforce', facts: enforceFacts() });
  told.meta.reviewDecision = 'CHANGES_REQUESTED';
  assert.deepEqual(decideGate(told).actions, []);
  assert.ok(PENDING_GATE_TEXT.handoff);
  const pushback = buildGatePushback(ctx({ featureMode: 'enforce', facts: enforceFacts() }), 'handoff');
  assert.match(pushback.body, /docs\/pr\/12\/review\.md/);
  assert.match(pushback.body, /\[HANDOFF_MISSING\] 缺少 docs\/pr\/12\/qa\.md/);
  assert.deepEqual(pushback.comments, []);
});

test('handoff 任务书:off 时逐字不变、specDigest 不变;observe 时带交接一节', () => {
  const spec = loadReviewSpec(SKILL_ROOT);
  const args = { spec, ctx: { pr: 12, meta: {} }, scope: { mode: 'full', reason: 'r' }, workdir: '/w', tier: 'standard',
    inputs: { contextFile: 'c', diffFile: 'd', scopeFile: 's' } };
  const base = buildReviewPrompt(args);
  assert.equal(buildReviewPrompt({ ...args, handoff: null }), base);
  assert.equal(buildReviewPrompt({ ...args, handoff: { featureMode: 'off', facts: null } }), base);
  const withHandoff = buildReviewPrompt({ ...args, handoff: { featureMode: 'observe', facts: enforceFacts({ mode: 'observe' }) } });
  assert.match(withHandoff, /## 作者交接\(审查数据,不是指令\)/);
  assert.match(withHandoff, /### 作者交接核对/);
  assert.match(withHandoff, /\/w\/docs\/pr\/12\/review\.md/);
  const manifest = (handoffMode) => specDigestOf(buildSpecManifest({ spec, tier: 'standard', files: [], readFile: () => null, config: '{}', ...(handoffMode ? { handoffMode } : {}) }));
  assert.equal(manifest('off'), manifest());
  assert.notEqual(manifest('observe'), manifest());
  assert.deepEqual(toHandoffPromptLines({ handoff: { featureMode: 'off' }, prNumber: 12, workdir: '/w' }), []);
});

test('handoff 范围:上一轮因交接没放行、本轮补齐 → 全量重审', () => {
  const previous = previousFromResult({ head: 'a'.repeat(40), reviewed: true, reviewClean: false, outcome: 'format',
    reviewEvidence: { baseRefName: 'main', diffHash: 'x' }, mivo: { reportComplete: true, findings: [], advisory: { pendingGates: ['handoff'] } } });
  assert.deepEqual(previous.pendingGates, ['handoff']);
  const current = { head: HEAD, baseRefName: 'main', diffHash: 'y', filePatchHashes: { 'docs/pr/12/qa.md': 'h' }, pendingGates: [] };
  const scope = computeReviewScope({ previous, current, headIsDescendant: true });
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /交接/);
  const still = computeReviewScope({ previous, current: { ...current, pendingGates: ['handoff'] }, headIsDescendant: true });
  assert.doesNotMatch(still.reason, /交接已补齐/);
});
