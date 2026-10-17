import test from 'node:test';
import assert from 'node:assert/strict';
import { toCodeScanGate, toStaleCodeScanReason, toRuleFacts, toCheckFacts, fetchCodeScanFacts, MISSING_GRACE_MS, RULES_TTL_MS } from './code-scan.mjs';

// 2026-10-17 #1025:组织规则集对 main 设了 code_scanning(CodeQL)与 code_quality 两条规则;#1025 head 上的 CodeQL check 是
// neutral「1 configuration not found」,GitHub 判不出本 PR 引入了什么告警,mergeStateStatus=BLOCKED,审查机却挂了 review:merge-ready。
// 这里验证:规则要求代码扫描时,CodeQL 必须是明确的 success 才放行;neutral / failure / 进行中 / 缺失 / 读不到各自拦下并给出原因。
const NOW = Date.parse('2026-10-17T19:30:00Z');
const min = (n) => n * 60_000;
const iso = (ms) => new Date(ms).toISOString();

const SCAN_RULE = { type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL', alerts_threshold: 'errors_and_warnings', security_alerts_threshold: 'medium_or_higher' }] } };
const QUALITY_RULE = { type: 'code_quality', parameters: { severity: 'warnings' } };
const codeql = (patch = {}) => ({ name: 'CodeQL', appSlug: 'github-advanced-security', status: 'completed', conclusion: 'success',
  title: 'No new alerts in code changed by this pull request', completedAt: iso(NOW - min(5)), ...patch });
const quality = (patch = {}) => ({ name: 'CodeQL - Code Quality', appSlug: 'github-advanced-security', status: 'completed', conclusion: 'success',
  title: 'No new code quality findings', completedAt: iso(NOW - min(5)), ...patch });
const actionsCheck = (patch = {}) => ({ name: 'verify', appSlug: 'github-actions', status: 'completed', conclusion: 'success', title: null, completedAt: iso(NOW - min(6)), ...patch });
const facts = (patch = {}) => ({ rules: [SCAN_RULE, QUALITY_RULE], rulesError: null, checks: [actionsCheck(), codeql()], ...patch });
const gate = (f, opts = {}) => toCodeScanGate(f, { nowMs: NOW, ...opts });
const codes = (g) => g.blockers.map((b) => b.code);

test('分支不受代码扫描 / 代码质量规则约束:不拦,也不要求有 CodeQL(#1036 的 base 是功能分支)', () => {
  const g = gate(facts({ rules: [], checks: [actionsCheck()] }));
  assert.deepEqual(g, { required: false, items: [], blockers: [], retry: false });
  // 规则里没有这两类、读到的 check 里却有 CodeQL(neutral)也不影响:没有规则就不判
  assert.deepEqual(codes(gate(facts({ rules: [], checks: [codeql({ conclusion: 'neutral' })] }))), []);
});

test('CodeQL success:照常放行', () => {
  const g = gate(facts());
  assert.equal(g.required, true);
  assert.deepEqual(g.blockers, []);
  assert.equal(g.retry, false);
  assert.deepEqual(g.items.map((i) => [i.kind, i.tool, i.state]), [['scan', 'CodeQL', 'pass']]);
});

test('#1025:CodeQL neutral(1 configuration not found)拦下,原因带 check 标题;不标 retry(要人重跑 CodeQL,靠指纹变化唤醒)', () => {
  const g = gate(facts({ checks: [actionsCheck(), codeql({ conclusion: 'neutral', title: '1 configuration not found' })] }));
  assert.deepEqual(codes(g), ['code-scanning-neutral']);
  assert.match(g.blockers[0].reason, /CodeQL/);
  assert.match(g.blockers[0].reason, /1 configuration not found/);
  assert.equal(g.retry, false);
});

test('CodeQL skipped / stale 也是没有结论,与 neutral 同处理', () => {
  for (const conclusion of ['skipped', 'stale']) {
    assert.deepEqual(codes(gate(facts({ checks: [codeql({ conclusion })] }))), ['code-scanning-neutral'], conclusion);
  }
});

test('CodeQL failure / cancelled / timed_out / action_required:拦下,不标 retry', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required']) {
    const g = gate(facts({ checks: [codeql({ conclusion, title: '3 new alerts including 1 high severity security vulnerability' })] }));
    assert.deepEqual(codes(g), ['code-scanning-failed'], conclusion);
    assert.equal(g.retry, false, conclusion);
  }
  assert.match(gate(facts({ checks: [codeql({ conclusion: 'failure', title: '3 new alerts' })] })).blockers[0].reason, /3 new alerts/);
});

test('CodeQL 还在跑:拦下并标 retry(会自己变化)', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const g = gate(facts({ checks: [codeql({ status, conclusion: null, completedAt: null })] }));
    assert.deepEqual(codes(g), ['code-scanning-pending'], status);
    assert.equal(g.retry, true, status);
  }
});

test('CodeQL 缺失:其它 check 刚跑完 / 还在跑时可能只是结果还没出现,标 retry;其它 check 早就跑完了仍没有,视为稳定缺失,不标 retry', () => {
  const justDone = gate(facts({ checks: [actionsCheck({ completedAt: iso(NOW - min(5)) })] }));
  assert.deepEqual(codes(justDone), ['code-scanning-missing']);
  assert.equal(justDone.retry, true);
  const running = gate(facts({ checks: [actionsCheck({ completedAt: iso(NOW - min(300)) }), actionsCheck({ name: 'lint', status: 'in_progress', conclusion: null, completedAt: null })] }));
  assert.equal(running.retry, true, '还有 check 在跑');
  const old = gate(facts({ checks: [actionsCheck({ completedAt: iso(NOW - MISSING_GRACE_MS - min(1)) })] }));
  assert.deepEqual(codes(old), ['code-scanning-missing']);
  assert.equal(old.retry, false);
  const none = gate(facts({ checks: [] }));
  assert.deepEqual(codes(none), ['code-scanning-missing']);
  assert.equal(none.retry, false, '一个 check 都没有时没有"刚跑完"的依据');
});

test('名为 CodeQL 的 Actions job 不能冒充代码扫描结果:只认 github-advanced-security', () => {
  const spoof = codeql({ appSlug: 'github-actions' });
  assert.deepEqual(codes(gate(facts({ checks: [actionsCheck(), spoof] }))), ['code-scanning-missing']);
  assert.deepEqual(codes(gate(facts({ checks: [codeql({ appSlug: null })] }))), ['code-scanning-missing']);
});

test('check 名与规则里的 tool 名不分大小写匹配', () => {
  assert.deepEqual(codes(gate(facts({ checks: [codeql({ name: 'codeql' })] }))), []);
});

test('同名 check 有多条:取最新一条(进行中视为最新)', () => {
  const older = codeql({ conclusion: 'neutral', completedAt: iso(NOW - min(60)) });
  const newer = codeql({ conclusion: 'success', completedAt: iso(NOW - min(10)) });
  assert.deepEqual(codes(gate(facts({ checks: [older, newer] }))), []);
  assert.deepEqual(codes(gate(facts({ checks: [newer, older] }))), []);
  const rerun = codeql({ status: 'in_progress', conclusion: null, completedAt: null });
  assert.deepEqual(codes(gate(facts({ checks: [newer, rerun] }))), ['code-scanning-pending']);
});

test('规则要求多个 tool:每个都要通过', () => {
  const rule = { type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL' }, { tool: 'Semgrep' }] } };
  const semgrep = codeql({ name: 'Semgrep', appSlug: 'semgrep-app' });
  // 除 CodeQL 外的 tool 不要求来自 github-advanced-security,只要不是 Actions job
  assert.deepEqual(codes(gate({ rules: [rule], rulesError: null, checks: [codeql(), semgrep] })), []);
  assert.deepEqual(codes(gate({ rules: [rule], rulesError: null, checks: [codeql()] })), ['code-scanning-missing']);
  const spoof = codeql({ name: 'Semgrep', appSlug: 'github-actions' });
  assert.deepEqual(codes(gate({ rules: [rule], rulesError: null, checks: [codeql(), spoof] })), ['code-scanning-missing']);
});

test('代码质量:规则要求且 head 上出现该 check 时必须 success;缺失不拦(这个仓没启用 Code Quality,近期 PR 都没有该 check)', () => {
  const rules = [SCAN_RULE, QUALITY_RULE];
  assert.deepEqual(codes(gate({ rules, rulesError: null, checks: [codeql()] })), [], '规则在、check 不存在:不拦');
  assert.deepEqual(codes(gate({ rules, rulesError: null, checks: [codeql(), quality()] })), []);
  const neutral = gate({ rules, rulesError: null, checks: [codeql(), quality({ conclusion: 'neutral', title: 'analysis incomplete' })] });
  assert.deepEqual(codes(neutral), ['code-quality-neutral']);
  assert.equal(neutral.retry, false);
  assert.deepEqual(codes(gate({ rules, rulesError: null, checks: [codeql(), quality({ conclusion: 'failure' })] })), ['code-quality-failed']);
  const pending = gate({ rules, rulesError: null, checks: [codeql(), quality({ status: 'in_progress', conclusion: null, completedAt: null })] });
  assert.deepEqual(codes(pending), ['code-quality-pending']);
  assert.equal(pending.retry, true);
  // Actions job 恰好叫这个名字也不算
  assert.deepEqual(codes(gate({ rules, rulesError: null, checks: [codeql(), quality({ appSlug: 'github-actions', conclusion: 'failure' })] })), []);
  // 规则里没有 code_quality 时,出现的 quality check 不影响
  assert.deepEqual(codes(gate({ rules: [SCAN_RULE], rulesError: null, checks: [codeql(), quality({ conclusion: 'failure' })] })), []);
  // 只有 code_quality 规则、没有 code_scanning:CodeQL 不要求
  assert.deepEqual(codes(gate({ rules: [QUALITY_RULE], rulesError: null, checks: [] })), []);
});

test('两项都不通过时各自列出,retry 取并集', () => {
  const g = gate(facts({ checks: [codeql({ conclusion: 'neutral' }), quality({ status: 'queued', conclusion: null, completedAt: null })] }));
  assert.deepEqual(codes(g), ['code-scanning-neutral', 'code-quality-pending']);
  assert.equal(g.retry, true);
});

test('规则或 check 读不到:拦下并标 retry;规则形状认不出:拦下但不标 retry(等不来)', () => {
  const noRules = gate(facts({ rules: null, rulesError: 'HTTP 502: Bad Gateway' }));
  assert.deepEqual(codes(noRules), ['code-scanning-unverified']);
  assert.match(noRules.blockers[0].reason, /HTTP 502/);
  assert.equal(noRules.retry, true);
  // 限流是瞬态,可以重读;没权限 / 不存在 / 凭证无效等不来,标 retry 只会每轮重新派发
  assert.equal(gate(facts({ rules: null, rulesError: 'HTTP 403: API rate limit exceeded' })).retry, true);
  for (const error of ['HTTP 404: Not Found', 'HTTP 403: Resource not accessible by integration', 'HTTP 401: Bad credentials']) {
    assert.equal(gate(facts({ rules: null, rulesError: error })).retry, false, error);
    assert.equal(gate(facts({ checks: null, checksError: error })).retry, false, error);
  }
  const noChecks = gate(facts({ checks: null }));
  assert.deepEqual(codes(noChecks), ['code-scanning-unverified']);
  assert.equal(noChecks.retry, true);
  const drift = gate(facts({ rules: [{ type: 'code_scanning', parameters: {} }] }));
  assert.deepEqual(codes(drift), ['code-scanning-unverified']);
  assert.equal(drift.retry, false);
  assert.deepEqual(codes(gate(facts({ rules: [{ type: 'code_scanning' }] }))), ['code-scanning-unverified']);
  // check 读不到但规则明确不要求:不受影响
  assert.deepEqual(gate({ rules: [], rulesError: null, checks: null }).blockers, []);
});

test('回执里根本没有 codeScanning 字段(脚本版本对不上):拦下,不标 retry', () => {
  for (const bad of [undefined, null, 'x', 42]) {
    const g = toCodeScanGate(bad, { nowMs: NOW });
    assert.deepEqual(codes(g), ['code-scanning-not-reported'], String(bad));
    assert.equal(g.retry, false, String(bad));
  }
});

test('Mini 摘标签的判据:只在稳定不通过(neutral / failure)时给原因;进行中、缺失、读不到、通过、不受约束都不摘,避免来回加摘', () => {
  const reason = (f) => toStaleCodeScanReason(gate(f));
  assert.match(reason(facts({ checks: [codeql({ conclusion: 'neutral', title: '1 configuration not found' })] })), /CodeQL.*1 configuration not found/);
  assert.match(reason(facts({ checks: [codeql({ conclusion: 'failure', title: '2 new alerts' })] })), /2 new alerts/);
  assert.match(reason(facts({ checks: [codeql(), quality({ conclusion: 'failure' })] })), /代码质量/);
  assert.equal(reason(facts({ checks: [codeql({ status: 'in_progress', conclusion: null, completedAt: null })] })), null, '进行中');
  assert.equal(reason(facts({ checks: [actionsCheck()] })), null, '缺失');
  assert.equal(reason(facts({ rules: null, rulesError: 'boom' })), null, '规则读不到');
  assert.equal(reason(facts({ checks: null })), null, 'check 读不到');
  assert.equal(reason(facts()), null, '通过');
  assert.equal(reason(facts({ rules: [] })), null, '不受约束');
  assert.equal(toStaleCodeScanReason(null), null);
  assert.equal(toStaleCodeScanReason(undefined), null);
});

// ── 事实的读取(REST 形状 → 事实)──
test('toRuleFacts 只留 code_scanning / code_quality 两类,形状不对返回 null', () => {
  const raw = [{ type: 'deletion', ruleset_id: 1 }, { ...SCAN_RULE, ruleset_id: 2, ruleset_source: 'xindong' }, { ...QUALITY_RULE, ruleset_id: 2 }, { type: 'pull_request', parameters: { x: 1 } }];
  assert.deepEqual(toRuleFacts(raw), [SCAN_RULE, QUALITY_RULE]);
  assert.deepEqual(toRuleFacts([{ type: 'deletion' }]), []);
  for (const bad of [null, undefined, {}, 'x', 1]) assert.equal(toRuleFacts(bad), null);
});

test('toCheckFacts 把 check-runs 的 REST 形状压成事实(app.slug / output.title / completed_at)', () => {
  const rest = [
    { name: 'CodeQL', app: { slug: 'github-advanced-security', id: 57789 }, status: 'completed', conclusion: 'neutral', output: { title: '1 configuration not found', summary: 'long text' }, completed_at: '2026-10-17T19:06:00Z', started_at: 'x' },
    { name: 'verify', app: { slug: 'github-actions' }, status: 'in_progress', conclusion: null, output: {}, completed_at: null },
    { name: 'odd' },
  ];
  assert.deepEqual(toCheckFacts(rest), [
    { name: 'CodeQL', appSlug: 'github-advanced-security', status: 'completed', conclusion: 'neutral', title: '1 configuration not found', completedAt: '2026-10-17T19:06:00Z' },
    { name: 'verify', appSlug: 'github-actions', status: 'in_progress', conclusion: null, title: null, completedAt: null },
    { name: 'odd', appSlug: null, status: null, conclusion: null, title: null, completedAt: null },
  ]);
  assert.equal(toCheckFacts(null), null);
  assert.equal(toCheckFacts({}), null);
});

// ── Mini 用:读规则(按 base 缓存)与 head 上的 check run ──
function fakeGh(handlers) {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args[1]);
    for (const [pattern, reply] of handlers) {
      if (args[1].includes(pattern)) return typeof reply === 'function' ? reply(args) : reply;
    }
    return { ok: false, stdout: '', stderr: 'HTTP 404' };
  };
  return { ghFn, calls };
}
const ok = (value) => ({ ok: true, stdout: JSON.stringify(value), stderr: '' });
const memoryCache = () => { const store = new Map(); return { get: (key) => store.get(key) ?? null, set: (key, value) => { store.set(key, value); }, store }; };
const REST_RULES = [{ type: 'deletion' }, { ...SCAN_RULE, ruleset_id: 9 }, { ...QUALITY_RULE, ruleset_id: 9 }];
const REST_CHECKS = { total_count: 2, check_runs: [
  { name: 'verify', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', output: {}, completed_at: iso(NOW - min(6)) },
  { name: 'CodeQL', app: { slug: 'github-advanced-security' }, status: 'completed', conclusion: 'neutral', output: { title: '1 configuration not found' }, completed_at: iso(NOW - min(5)) },
] };

test('fetchCodeScanFacts:规则读一次放进缓存,TTL 内同 base 的其它 PR 直接复用;check-runs 每次读一次', () => {
  const { ghFn, calls } = fakeGh([['/rules/branches/main', ok(REST_RULES)], ['/commits/abc/check-runs', ok(REST_CHECKS)], ['/commits/def/check-runs', ok(REST_CHECKS)]]);
  const cache = memoryCache();
  const first = fetchCodeScanFacts({ ghFn, repo: 'o/r', baseRefName: 'main', head: 'abc', cache, nowMs: NOW });
  assert.deepEqual(first.rules, [SCAN_RULE, QUALITY_RULE]);
  assert.equal(first.rulesError, null);
  assert.equal(first.checks.length, 2);
  assert.deepEqual(codes(toCodeScanGate(first, { nowMs: NOW })), ['code-scanning-neutral']);
  assert.equal(calls.length, 2);
  const second = fetchCodeScanFacts({ ghFn, repo: 'o/r', baseRefName: 'main', head: 'def', cache, nowMs: NOW + min(5) });
  assert.deepEqual(second.rules, first.rules);
  assert.equal(calls.length, 3, '第二个 PR 只多读 check-runs,规则走缓存');
  const expired = fetchCodeScanFacts({ ghFn, repo: 'o/r', baseRefName: 'main', head: 'def', cache, nowMs: NOW + RULES_TTL_MS + 1 });
  assert.deepEqual(expired.rules, first.rules);
  assert.equal(calls.length, 5, 'TTL 过后重新读规则');
});

test('fetchCodeScanFacts:base 分支名要 URL 编码;规则不要求代码扫描 / 质量时不读 check-runs', () => {
  const { ghFn, calls } = fakeGh([['/rules/branches/feat%2Fautomerge-gate', ok([{ type: 'deletion' }])]]);
  const facts1 = fetchCodeScanFacts({ ghFn, repo: 'o/r', baseRefName: 'feat/automerge-gate', head: 'abc', cache: memoryCache(), nowMs: NOW });
  assert.deepEqual(facts1.rules, []);
  assert.deepEqual(facts1.checks, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(toCodeScanGate(facts1, { nowMs: NOW }).blockers, []);
});

test('fetchCodeScanFacts:读不到规则不缓存,读不到 check-runs / 条数超过一页都按读不到处理', () => {
  const cache = memoryCache();
  const bad = fetchCodeScanFacts({ ghFn: fakeGh([]).ghFn, repo: 'o/r', baseRefName: 'main', head: 'abc', cache, nowMs: NOW });
  assert.equal(bad.rules, null);
  assert.match(bad.rulesError, /404/);
  assert.equal(cache.store.size, 0, '失败不写缓存');
  const noChecks = fetchCodeScanFacts({ ghFn: fakeGh([['/rules/branches/main', ok(REST_RULES)]]).ghFn, repo: 'o/r', baseRefName: 'main', head: 'abc', cache: memoryCache(), nowMs: NOW });
  assert.equal(noChecks.checks, null);
  assert.ok(noChecks.checksError);
  const big = { total_count: 150, check_runs: REST_CHECKS.check_runs };
  const paged = fetchCodeScanFacts({ ghFn: fakeGh([['/rules/branches/main', ok(REST_RULES)], ['/check-runs', ok(big)]]).ghFn, repo: 'o/r', baseRefName: 'main', head: 'abc', cache: memoryCache(), nowMs: NOW });
  assert.equal(paged.checks, null, '没读全不能当作"没有 CodeQL"');
  assert.match(paged.checksError, /150/);
  const garbage = fetchCodeScanFacts({ ghFn: fakeGh([['/rules/branches/main', { ok: true, stdout: 'not json', stderr: '' }]]).ghFn, repo: 'o/r', baseRefName: 'main', head: 'abc', cache: memoryCache(), nowMs: NOW });
  assert.equal(garbage.rules, null);
  assert.ok(garbage.rulesError);
  // 缓存里的坏数据(旧版本、被改)不信,重新读
  const dirty = memoryCache();
  dirty.set('o/r|main', { at: NOW, rules: 'x' });
  const { ghFn, calls } = fakeGh([['/rules/branches/main', ok(REST_RULES)], ['/check-runs', ok(REST_CHECKS)]]);
  fetchCodeScanFacts({ ghFn, repo: 'o/r', baseRefName: 'main', head: 'abc', cache: dirty, nowMs: NOW });
  assert.equal(calls.length, 2);
});
