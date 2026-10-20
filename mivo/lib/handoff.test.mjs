import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { loadHandoffMode, toHandoffFacts, readHandoffFacts, toHandoffPending, toHandoffPromptLines, toProtectedHandoffBlock, HANDOFF_WORKFLOW_PATH } from './handoff.mjs';
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

// 模拟 GitHub:workflows/<file>/runs 只返回该 workflow 文件自己的运行,check-suites/<id>/check-runs 只返回该 suite 的检查。
const fakeGitHub = ({ trustedRuns, checks, annotations = {} }) => {
  const calls = [];
  const ghFn = (args) => {
    const path = args[1];
    calls.push(path);
    const wf = /\/actions\/workflows\/([^/]+)\/runs\?head_sha=([0-9a-f]+)&event=([a-z_]+)/.exec(path);
    if (wf) return { ok: true, stdout: JSON.stringify({ workflow_runs: trustedRuns.filter((r) => r.path.endsWith(`/${wf[1]}`) && r.head_sha === wf[2] && r.event === wf[3]) }) };
    const cs = /\/check-suites\/(\d+)\/check-runs\?check_name=([^&]+)/.exec(path);
    if (cs) return { ok: true, stdout: JSON.stringify({ check_runs: checks.filter((c) => c.check_suite.id === Number(cs[1]) && c.name === cs[2]) }) };
    const an = /\/check-runs\/(\d+)\/annotations/.exec(path);
    if (an) return { ok: true, stdout: JSON.stringify(annotations[an[1]] ?? []) };
    return { ok: false, stderr: `unexpected ${path}` };
  };
  return { ghFn, calls };
};
const trustedRun = { id: 500, path: HANDOFF_WORKFLOW_PATH, event: 'pull_request_target', head_sha: HEAD, status: 'completed', check_suite_id: 99 };
const check = (id, suite, conclusion) => ({ id, name: 'pr-handoff-gate', head_sha: HEAD, app: { slug: 'github-actions' }, status: 'completed', conclusion, check_suite: { id: suite } });
const failedNotes = { 7: [{ annotation_level: 'notice', message: '[MODE] enforce' }, { annotation_level: 'failure', message: '[HANDOFF_MISSING] 缺少 docs/pr/12/qa.md' }] };

test('handoff: 只认 PR Handoff workflow 的 pull_request_target 运行;没有这个运行时不采用别的同名检查', () => {
  const ok = readHandoffFacts({ repo: 'o/r', head: HEAD, ...fakeGitHub({ trustedRuns: [trustedRun], checks: [check(7, 99, 'failure')], annotations: failedNotes }) });
  assert.equal(ok.mode, 'enforce');
  assert.deepEqual(ok.errors.map((e) => e.code), ['HANDOFF_MISSING']);
  // 只有 PR 分支自带的同名 job:可信 workflow 没有运行 → 当作没有交接结果
  const onlyForged = readHandoffFacts({ repo: 'o/r', head: HEAD, ...fakeGitHub({ trustedRuns: [{ ...trustedRun, path: '.github/workflows/forged.yml', event: 'pull_request' }], checks: [check(8, 100, 'success')] }) });
  assert.equal(onlyForged.present, false);
  const unreadable = readHandoffFacts({ repo: 'o/r', head: HEAD, ghFn: () => ({ ok: false, stderr: 'HTTP 403' }) });
  assert.equal(unreadable.present, false);
  assert.match(unreadable.readError, /403/);
});

test('handoff: 再多更晚的冒充同名检查也遮不住可信失败', () => {
  for (const forgedCount of [1, 5, 6, 150]) {
    const forged = Array.from({ length: forgedCount }, (_, i) => check(8 + i, 100 + (i % 7), 'success'));
    const { ghFn, calls } = fakeGitHub({ trustedRuns: [trustedRun], checks: [check(7, 99, 'failure'), ...forged], annotations: failedNotes });
    const facts = readHandoffFacts({ repo: 'o/r', head: HEAD, ghFn });
    assert.equal(facts.present, true, `forged=${forgedCount}`);
    assert.deepEqual(facts.errors.map((e) => e.code), ['HANDOFF_MISSING']);
    assert.equal(toHandoffPending({ featureMode: 'enforce', facts }).length, 1);
    assert.equal(calls.length, 3, '请求次数与冒充数量无关');
  }
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

test('handoff 受保护路径放行:Mivo 门 enforce 且有错误才挡,与审查机开关无关;读不到不挡', () => {
  assert.match(toProtectedHandoffBlock(enforceFacts()), /^受保护路径:作者交接检查 pr-handoff-gate 未通过.*\[HANDOFF_MISSING\]/);
  assert.equal(toProtectedHandoffBlock(enforceFacts({ mode: 'observe' })), null);
  assert.equal(toProtectedHandoffBlock(enforceFacts({ errors: [] })), null);
  assert.equal(toProtectedHandoffBlock({ ...enforceFacts(), present: false, readError: 'HTTP 403' }), null);
  assert.equal(toProtectedHandoffBlock(null), null);
  const many = enforceFacts({ errors: Array.from({ length: 5 }, (_, i) => ({ code: 'FIELD_EMPTY', message: `第 ${i} 处` })) });
  assert.match(toProtectedHandoffBlock(many), /等 5 处/);
});

test('handoff 受保护路径放行:server 在写放行之前读交接并按 toProtectedHandoffBlock 收尾', () => {
  const src = readFileSync(new URL('../server/review.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function prepareProtectedApprove'), src.indexOf('// 转 issue 跟进的登记'));
  const block = body.indexOf('toProtectedHandoffBlock(');
  assert.ok(block > 0, 'prepareProtectedApprove 要调用 toProtectedHandoffBlock');
  assert.ok(block < body.indexOf('state.protectedApproval ='), '交接门在记录放行之前');
  assert.match(body, /readHandoffFacts\(\{ repo: input\.targetRepo, head: input\.head/);
});
