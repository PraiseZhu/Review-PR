import test from 'node:test';
import assert from 'node:assert/strict';
import { toCodeScanGate, toStaleCodeScanReason, toRuleFacts, toCheckFacts, fetchCodeScanFacts, toCodeScanWakeState, toCodeScanWake, toCodeScanSweepSet, toCodeScanRecord, RULES_TTL_MS } from './code-scan.mjs';

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
const gate = (f) => toCodeScanGate(f);
const codes = (g) => g.blockers.map((b) => b.code);

test('分支不受代码扫描 / 代码质量规则约束:不拦,也不要求有 CodeQL(#1036 的 base 是功能分支)', () => {
  const g = gate(facts({ rules: [], checks: [actionsCheck()] }));
  assert.deepEqual(g, { required: false, items: [], blockers: [] });
  // 规则里没有这两类、读到的 check 里却有 CodeQL(neutral)也不影响:没有规则就不判
  assert.deepEqual(codes(gate(facts({ rules: [], checks: [codeql({ conclusion: 'neutral' })] }))), []);
});

test('CodeQL success:照常放行', () => {
  const g = gate(facts());
  assert.equal(g.required, true);
  assert.deepEqual(g.blockers, []);
  assert.deepEqual(g.items.map((i) => [i.kind, i.tool, i.state]), [['scan', 'CodeQL', 'pass']]);
});

test('#1025:CodeQL neutral(1 configuration not found)拦下,原因带 check 标题', () => {
  const g = gate(facts({ checks: [actionsCheck(), codeql({ conclusion: 'neutral', title: '1 configuration not found' })] }));
  assert.deepEqual(codes(g), ['code-scanning-neutral']);
  assert.match(g.blockers[0].reason, /CodeQL/);
  assert.match(g.blockers[0].reason, /1 configuration not found/);
});

test('CodeQL skipped / stale 也是没有结论,与 neutral 同处理', () => {
  for (const conclusion of ['skipped', 'stale']) {
    assert.deepEqual(codes(gate(facts({ checks: [codeql({ conclusion })] }))), ['code-scanning-neutral'], conclusion);
  }
});

test('CodeQL failure / cancelled / timed_out / action_required:拦下', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required']) {
    const g = gate(facts({ checks: [codeql({ conclusion, title: '3 new alerts including 1 high severity security vulnerability' })] }));
    assert.deepEqual(codes(g), ['code-scanning-failed'], conclusion);
  }
  assert.match(gate(facts({ checks: [codeql({ conclusion: 'failure', title: '3 new alerts' })] })).blockers[0].reason, /3 new alerts/);
});

test('CodeQL 还在跑:拦下', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const g = gate(facts({ checks: [codeql({ status, conclusion: null, completedAt: null })] }));
    assert.deepEqual(codes(g), ['code-scanning-pending'], status);
  }
});

test('CodeQL 缺失:拦下;审查机自己的 review-pr 以及别的 check 在不在跑都不改变判断', () => {
  for (const checks of [[], [actionsCheck()], [actionsCheck({ completedAt: iso(NOW - min(600)) }), actionsCheck({ name: 'review-pr', status: 'in_progress', conclusion: null, completedAt: null })]]) {
    const g = gate(facts({ checks }));
    assert.deepEqual(codes(g), ['code-scanning-missing']);
    assert.equal(g.items[0].state, 'missing');
  }
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
  assert.deepEqual(codes(gate({ rules, rulesError: null, checks: [codeql(), quality({ conclusion: 'failure' })] })), ['code-quality-failed']);
  const pending = gate({ rules, rulesError: null, checks: [codeql(), quality({ status: 'in_progress', conclusion: null, completedAt: null })] });
  assert.deepEqual(codes(pending), ['code-quality-pending']);
  // Actions job 恰好叫这个名字也不算
  assert.deepEqual(codes(gate({ rules, rulesError: null, checks: [codeql(), quality({ appSlug: 'github-actions', conclusion: 'failure' })] })), []);
  // 规则里没有 code_quality 时,出现的 quality check 不影响
  assert.deepEqual(codes(gate({ rules: [SCAN_RULE], rulesError: null, checks: [codeql(), quality({ conclusion: 'failure' })] })), []);
  // 只有 code_quality 规则、没有 code_scanning:CodeQL 不要求
  assert.deepEqual(codes(gate({ rules: [QUALITY_RULE], rulesError: null, checks: [] })), []);
});

test('两项都不通过时各自列出', () => {
  const g = gate(facts({ checks: [codeql({ conclusion: 'neutral' }), quality({ status: 'queued', conclusion: null, completedAt: null })] }));
  assert.deepEqual(codes(g), ['code-scanning-neutral', 'code-quality-pending']);
});

test('规则或 check 读不到 / 规则形状认不出:拦下', () => {
  const noRules = gate(facts({ rules: null, rulesError: 'HTTP 502: Bad Gateway' }));
  assert.deepEqual(codes(noRules), ['code-scanning-unverified']);
  assert.match(noRules.blockers[0].reason, /HTTP 502/);
  const noChecks = gate(facts({ checks: null, checksError: 'HTTP 403: Resource not accessible by integration' }));
  assert.deepEqual(codes(noChecks), ['code-scanning-unverified']);
  assert.match(noChecks.blockers[0].reason, /Resource not accessible/);
  assert.deepEqual(codes(gate(facts({ rules: [{ type: 'code_scanning', parameters: {} }] }))), ['code-scanning-unverified']);
  assert.deepEqual(codes(gate(facts({ rules: [{ type: 'code_scanning' }] }))), ['code-scanning-unverified']);
  // check 读不到但规则明确不要求:不受影响
  assert.deepEqual(gate({ rules: [], rulesError: null, checks: null }).blockers, []);
});

test('回执里根本没有 codeScanning 字段(脚本版本对不上):拦下', () => {
  for (const bad of [undefined, null, 'x', 42]) assert.deepEqual(codes(toCodeScanGate(bad)), ['code-scanning-not-reported'], String(bad));
});

// 代码扫描门本身不标 retry:标 retry 会让 Mini 每 3 分钟重新派发一次服务器审查(dailyCap=30、同 head 20 次完成上限)。
// 审查指出过「进行中 / 5xx 也标 retry」同样会烧额度;"等结果出来再判"由 wakeCodeScanPrs 靠状态变化唤醒。
test('门的结果里没有 retry:不管是什么状态都不会让 Mini 每轮重新派发', () => {
  const running = codeql({ status: 'in_progress', conclusion: null, completedAt: null });
  for (const f of [facts(), facts({ checks: [codeql({ conclusion: 'neutral' })] }), facts({ checks: [running] }), facts({ checks: [] }),
    facts({ rules: null, rulesError: 'HTTP 502' }), facts({ checks: null }), facts({ rules: [] }), undefined]) {
    assert.equal('retry' in toCodeScanGate(f), false, JSON.stringify(f)?.slice(0, 80));
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

// ── 审查 P2-2:代码扫描状态变化不改 PR 指纹(ci 仍是聚合状态),要有独立的唤醒依据 ──
test('唤醒用的状态:通过 / 稳定不通过(neutral、failure)/ 瞬态(进行中、缺失、读不到)/ 不受约束', () => {
  const state = (f) => toCodeScanWakeState(gate(f));
  assert.equal(state(facts()), 'pass');
  assert.equal(state(facts({ checks: [codeql({ conclusion: 'neutral' })] })), 'fail');
  assert.equal(state(facts({ checks: [codeql({ conclusion: 'failure' })] })), 'fail');
  assert.equal(state(facts({ checks: [codeql(), quality({ conclusion: 'failure' })] })), 'fail');
  assert.equal(state(facts({ checks: [codeql({ status: 'in_progress', conclusion: null, completedAt: null })] })), 'transient');
  assert.equal(state(facts({ checks: [actionsCheck()] })), 'transient', '缺失');
  assert.equal(state(facts({ rules: null, rulesError: 'boom' })), 'transient');
  assert.equal(state(facts({ checks: null })), 'transient');
  assert.equal(toCodeScanWakeState(toCodeScanGate(undefined)), 'transient');
  assert.equal(state(facts({ rules: [] })), null, '不受约束:没有什么可唤醒的');
  assert.equal(toCodeScanWakeState(null), null);
});

test('唤醒判断:稳定状态与基线不同才唤醒;瞬态 / 读不到不唤醒也不改基线;在审的 PR 推迟', () => {
  const A = '2026-10-17T20:00:00Z';
  const watched = [
    { pr: 1, head: 'h1', state: 'fail', at: A },       // 作者自批 advisory:CodeQL 重跑成功 → 唤醒重新放行
    { pr: 2, head: 'h2', state: 'pass', at: A },       // 标签已挂:CodeQL 变 neutral → 唤醒摘标签
    { pr: 3, head: 'h3', state: 'pass', at: A },       // 没变
    { pr: 4, head: 'h4', state: 'fail', at: A },       // 重跑中(瞬态):不唤醒
    { pr: 5, head: 'h5', state: 'transient', at: A },  // 服务器当时没等到结果,现在稳定通过 → 唤醒
    { pr: 6, head: 'h6', state: 'fail', at: A },       // 读不到
    { pr: 7, head: 'h7', state: 'fail', at: A },       // 在审:推迟
    { pr: 8, head: 'h8', state: 'transient', at: A },  // 服务器读规则遇到 5xx 记了瞬态,现在读到规则不再要求扫描(null)→ 唤醒
    { pr: 9, head: 'h9', state: 'fail', at: A },       // 规则被撤销(null)→ 唤醒
    { pr: 10, head: 'h10', state: 'pass', at: A },     // 本来就是通过,规则撤销(null)不必唤醒
  ];
  const observed = { 1: 'pass', 2: 'fail', 3: 'pass', 4: 'transient', 5: 'pass', 7: 'pass', 8: null, 9: null, 10: null };
  const r = toCodeScanWake({ watched, observed, seen: {}, busyPrs: new Set([7]) });
  assert.deepEqual(r.wake, [1, 2, 5, 8, 9]);
  assert.deepEqual(r.deferred, [7]);
  assert.deepEqual(r.next, { 1: { head: 'h1', state: 'pass', at: A }, 2: { head: 'h2', state: 'fail', at: A }, 3: { head: 'h3', state: 'pass', at: A }, 5: { head: 'h5', state: 'pass', at: A },
    8: { head: 'h8', state: 'pass', at: A }, 9: { head: 'h9', state: 'pass', at: A }, 10: { head: 'h10', state: 'pass', at: A } });
  // 唤醒过一次后基线是上次观察到的值:同一个状态不再重复唤醒
  const again = toCodeScanWake({ watched, observed, seen: r.next, busyPrs: new Set([7]) });
  assert.deepEqual(again.wake, []);
  assert.deepEqual(again.deferred, [7]);
  // 换了 head 重新以服务器记录为基线
  const newHead = toCodeScanWake({ watched: [{ pr: 1, head: 'h1b', state: 'pass', at: A }], observed: { 1: 'pass' }, seen: { 1: { head: 'h1', state: 'fail', at: A } } });
  assert.deepEqual(newHead.wake, []);
  assert.deepEqual(newHead.next, { 1: { head: 'h1b', state: 'pass', at: A } });
  // 瞬态期间保留上次的基线:pass → 重跑中 → 又 pass 不算变化
  const flap = toCodeScanWake({ watched: [{ pr: 2, head: 'h2', state: 'fail', at: A }], observed: { 2: 'transient' }, seen: { 2: { head: 'h2', state: 'pass', at: A } } });
  assert.deepEqual(flap.wake, []);
  assert.deepEqual(flap.next, { 2: { head: 'h2', state: 'pass', at: A } });
  assert.deepEqual(toCodeScanWake(), { wake: [], deferred: [], next: {} });
});

// 审查 P2(复审):服务器在唤醒之后又评估了一次(同一个 head、新的评估时间)时,旧的 seen 必须作废,
// 否则「fail → 唤醒(seen=pass)→ 服务器复核时仍是 fail,记 fail → CodeQL 又变 pass」会因为 seen=pass 对 pass 而漏掉这次唤醒。
test('服务器重新评估过(同 head、新的评估时间):旧的 seen 作废,以服务器新记录为基线', () => {
  const first = toCodeScanWake({ watched: [{ pr: 1, head: 'h1', state: 'fail', at: 'T1' }], observed: { 1: 'pass' }, seen: {} });
  assert.deepEqual(first.wake, [1]);
  assert.deepEqual(first.next[1], { head: 'h1', state: 'pass', at: 'T1' });
  const second = toCodeScanWake({ watched: [{ pr: 1, head: 'h1', state: 'fail', at: 'T2' }], observed: { 1: 'pass' }, seen: first.next });
  assert.deepEqual(second.wake, [1], '服务器 T2 又记了 fail,现在 pass:要再唤醒一次');
  // 对称:服务器重挂标签后记 pass,之后 CodeQL 变 fail
  const third = toCodeScanWake({ watched: [{ pr: 1, head: 'h1', state: 'pass', at: 'T3' }], observed: { 1: 'fail' }, seen: second.next });
  assert.deepEqual(third.wake, [1]);
  // 同一次评估(at 没变)不会因为 seen 重复唤醒
  const same = toCodeScanWake({ watched: [{ pr: 1, head: 'h1', state: 'fail', at: 'T2' }], observed: { 1: 'pass' }, seen: second.next });
  assert.deepEqual(same.wake, []);
});

test('每次最多读 max 个,按上次读取时间轮转(没读过的最先):开放 PR 多于 max 时不会让后面的永远轮不到', () => {
  const watched = Array.from({ length: 5 }, (_, i) => ({ pr: i + 1, head: `h${i + 1}`, state: 'pass', at: 'T' }));
  const picked = [];
  let checked = {};
  for (let round = 0; round < 3; round += 1) {
    const batch = toCodeScanSweepSet({ watched, checked, max: 2 });
    assert.equal(batch.length, 2);
    picked.push(batch.map((entry) => entry.pr));
    checked = { ...checked, ...Object.fromEntries(batch.map((entry) => [entry.pr, 1000 + round])) };
  }
  assert.deepEqual(picked, [[1, 2], [3, 4], [5, 1]]);
  assert.deepEqual(toCodeScanSweepSet({ watched, checked: {}, max: 30 }).map((entry) => entry.pr), [1, 2, 3, 4, 5]);
  assert.deepEqual(toCodeScanSweepSet(), []);
});

test('服务器结果被采纳时的基线记录:评估过就记,完成了但没评估就清,失败 / 退回不动', () => {
  const base = { head: 'h1', base: 'main', at: '2026-10-17T20:00:00Z' };
  assert.deepEqual(toCodeScanRecord({ ...base, codeScan: { required: true, state: 'fail' }, completed: true }), { codeScan: { head: 'h1', base: 'main', required: true, state: 'fail', at: base.at } });
  assert.deepEqual(toCodeScanRecord({ ...base, codeScan: { required: true, state: 'pass' }, completed: false }).codeScan.state, 'pass');
  assert.deepEqual(toCodeScanRecord({ ...base, codeScan: undefined, completed: true }), { codeScan: null }, '这次审查完成了、规则不要求:清掉旧基线');
  assert.deepEqual(toCodeScanRecord({ ...base, codeScan: undefined, completed: false }), {}, '失败 / 退回:保留上一次的基线');
  for (const bad of [{ required: false, state: 'pass' }, { required: true, state: 'weird' }, { state: 'pass' }, 'x']) {
    assert.deepEqual(toCodeScanRecord({ ...base, codeScan: bad, completed: true }), { codeScan: null }, JSON.stringify(bad));
  }
  assert.deepEqual(toCodeScanRecord({ codeScan: { required: true, state: 'pass' }, head: 'h1', completed: true }), { codeScan: null }, '缺 base 不记');
  assert.deepEqual(toCodeScanRecord(), {});
});
