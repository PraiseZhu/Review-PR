import test from 'node:test';
import assert from 'node:assert/strict';
import { TIER_DEFAULTS, FALLBACK, CODEX_BUDGET_MS, SETTLE_MS, PUBLISH_RESERVE_MS, tierConfig, nextAttempt, codexBudgetMs, pickJobStart, roleModel, roleWarnings, parseRoleModel } from './models.mjs';

const MIN = 60_000;

test('三档同一个主模型与思考强度,只有超时不同', () => {
  for (const tier of ['light', 'standard', 'heavy']) {
    assert.equal(TIER_DEFAULTS[tier].model, 'openai/gpt-6-luna');
    assert.equal(TIER_DEFAULTS[tier].effort, 'max');
  }
  assert.deepEqual(FALLBACK, { model: 'openai/gpt-6.1-sol', effort: 'medium' });
});

test('仓库变量可以覆盖某一档', () => {
  const cfg = tierConfig('heavy', { MIVO_REVIEW_MODEL_HEAVY: 'openai/gpt-6-sol', MIVO_REVIEW_EFFORT_HEAVY: 'high' });
  assert.deepEqual(cfg, { model: 'openai/gpt-6-sol', effort: 'high', timeoutMs: 98 * MIN });
  assert.deepEqual(tierConfig('light', {}), { model: 'openai/gpt-6-luna', effort: 'max', timeoutMs: 60 * MIN });
  assert.throws(() => tierConfig('huge', {}), /档位不合法/);
});

test('heavy 主模型上限 98 分钟;主模型在 98 分 6 秒被终止后备用实足 20 分钟以上', () => {
  const heavy = tierConfig('heavy', {});
  assert.equal(heavy.timeoutMs, 98 * MIN);
  const fallback = nextAttempt({ primary: heavy, attempts: [{ ok: false }], elapsedMs: 98 * MIN + 6_000 });
  assert.equal(fallback.model, FALLBACK.model);
  assert.equal(fallback.timeoutMs, 20 * MIN + 54_000);
  assert.ok(fallback.timeoutMs >= 20 * MIN);
  assert.ok(98 * MIN + 6_000 + fallback.timeoutMs + SETTLE_MS <= CODEX_BUDGET_MS, '主备加收尾不超过模型预算');
});

test('light、standard 主模型上限 60 分钟;主模型用满 61 分钟(含收尾)后备用 58 分钟', () => {
  for (const tier of ['light', 'standard']) {
    const primary = tierConfig(tier, {});
    assert.equal(primary.timeoutMs, 60 * MIN, tier);
    // 预算 120 分钟,主模型用满 60 分钟 + 1 分钟收尾:备用 = min(60, 120 − 61 − 1) = 58 分钟
    const fallback = nextAttempt({ primary, attempts: [{ ok: false }], elapsedMs: 61 * MIN });
    assert.equal(fallback.model, FALLBACK.model, tier);
    assert.equal(fallback.timeoutMs, 58 * MIN, tier);
    // 剩余不足 15 分钟时不启动备用(120 − 105 − 1 = 14)
    assert.equal(nextAttempt({ primary, attempts: [{ ok: false }], elapsedMs: 105 * MIN }), null, tier);
  }
});

test('主模型一次;非额度类失败换备用一次;额度类失败或成功都不再试', () => {
  const primary = tierConfig('standard', {});
  assert.deepEqual(nextAttempt({ primary, attempts: [], elapsedMs: 0 }), primary);
  assert.equal(nextAttempt({ primary, attempts: [{ ok: true }], elapsedMs: 3 * MIN }), null);
  assert.equal(nextAttempt({ primary, attempts: [{ ok: false, quota: true }], elapsedMs: MIN }), null);
  assert.deepEqual(nextAttempt({ primary, attempts: [{ ok: false, quota: false }], elapsedMs: 10 * MIN }),
    { model: 'openai/gpt-6.1-sol', effort: 'medium', timeoutMs: 60 * MIN });
  assert.equal(nextAttempt({ primary, attempts: [{ ok: false }, { ok: false }], elapsedMs: 20 * MIN }), null);
});

test('非模型阶段超过 30 分钟:预算按真实 job 开始时间收缩,发布前留 10 分钟,主备共用', () => {
  const jobStartMs = Date.parse('2026-10-14T10:00:00Z');
  assert.equal(codexBudgetMs({ jobStartMs, jobTimeoutMin: 160, nowMs: jobStartMs + 20 * MIN }), CODEX_BUDGET_MS, '30 分钟以内不收缩');
  const nowMs = jobStartMs + 35 * MIN; // 装依赖 15 + 扫描 10 + 装 semgrep 10
  const budgetMs = codexBudgetMs({ jobStartMs, jobTimeoutMin: 160, nowMs });
  assert.equal(budgetMs, 115 * MIN);
  const heavy = tierConfig('heavy', {}, { budgetMs });
  assert.equal(heavy.timeoutMs, 93 * MIN);
  const primaryRan = heavy.timeoutMs + 6_000;
  const fallback = nextAttempt({ primary: heavy, attempts: [{ ok: false }], elapsedMs: primaryRan, budgetMs });
  assert.ok(fallback.timeoutMs >= 20 * MIN);
  const codexDoneMs = nowMs + primaryRan + fallback.timeoutMs + SETTLE_MS;
  assert.ok(codexDoneMs <= jobStartMs + 160 * MIN - PUBLISH_RESERVE_MS, '模型跑完时发布(含产物上传)还剩 10 分钟');
});

test('每一档「模型上限 + 备用 + 发布预留」都不超过作业上限 160 分钟(非模型阶段 30 分钟以内)', () => {
  for (const tier of ['light', 'standard', 'heavy']) {
    const primary = tierConfig(tier, {});
    const primaryRan = primary.timeoutMs + SETTLE_MS;
    const fallback = nextAttempt({ primary, attempts: [{ ok: false }], elapsedMs: primaryRan });
    const total = 30 * MIN + primaryRan + (fallback?.timeoutMs ?? 0) + SETTLE_MS + PUBLISH_RESERVE_MS;
    assert.ok(total <= 160 * MIN, `${tier}:${total / MIN} 分钟`);
  }
});

test('预算不够时不启动模型;备用可用时间不足 15 分钟时不再试;备用与主模型相同不再试', () => {
  const tiny = tierConfig('heavy', {}, { budgetMs: 20 * MIN });
  assert.equal(tiny.timeoutMs, 0);
  assert.equal(nextAttempt({ primary: tiny, attempts: [], elapsedMs: 0, budgetMs: 20 * MIN }), null);
  const heavy = tierConfig('heavy', {});
  assert.equal(nextAttempt({ primary: heavy, attempts: [{ ok: false }], elapsedMs: 105 * MIN }), null, '120 − 105 − 1 = 14 分钟');
  const fallbackAsPrimary = { ...FALLBACK, timeoutMs: 60 * MIN };
  assert.equal(nextAttempt({ primary: fallbackAsPrimary, attempts: [{ ok: false }], elapsedMs: MIN }), null);
});

test('作业开始时间:先用本 job 的 started_at;jobs 接口读不到用 run 的 created_at;两者都没有返回 null', () => {
  const jobsJson = { jobs: [
    { runner_name: 'mivo-review-l20-1-3', started_at: '2026-10-14T10:00:05Z' },
    { runner_name: 'mivo-review-l20-1-8', started_at: '2026-10-14T10:02:00Z' },
  ] };
  assert.deepEqual(pickJobStart({ jobsJson, runnerName: 'mivo-review-l20-1-8' }), { at: '2026-10-14T10:02:00Z', from: 'job' });
  assert.deepEqual(pickJobStart({ jobsJson: { jobs: [jobsJson.jobs[0]] } }), { at: '2026-10-14T10:00:05Z', from: 'job' }, '只有一个 job');
  assert.equal(pickJobStart({ jobsJson, runnerName: 'other' }), null, '多个 job 又对不上 runner 时不乱猜');
  const runJson = { created_at: '2026-10-14T09:59:58Z' };
  assert.deepEqual(pickJobStart({ jobsJson: null, runJson }), { at: '2026-10-14T09:59:58Z', from: 'run-created' });
  assert.deepEqual(pickJobStart({ jobsJson: { jobs: [{ runner_name: 'x', started_at: null }] }, runJson }), { at: '2026-10-14T09:59:58Z', from: 'run-created' });
  assert.equal(pickJobStart({ jobsJson: null, runJson: null }), null);
  assert.equal(pickJobStart({ jobsJson: { message: 'Not Found' }, runJson: { created_at: 'bad' } }), null);
});

test('角色变量:主审三档共用、备用模型可换;单档覆盖变量仍然优先;格式不对用默认值并告警', () => {
  const env = {
    MIVO_REVIEW_ROLE_PRIMARY: JSON.stringify({ model: 'openai/gpt-7', effort: 'ultra', cindyModel: 'gpt-7', setAt: 'x' }),
    MIVO_REVIEW_ROLE_FALLBACK: JSON.stringify({ model: 'openai/gpt-6.1-sol', effort: 'high' }),
  };
  for (const tier of ['light', 'standard', 'heavy']) {
    const cfg = tierConfig(tier, env);
    assert.equal(cfg.model, 'openai/gpt-7', tier);
    assert.equal(cfg.effort, 'ultra', tier);
  }
  assert.deepEqual(tierConfig('heavy', { ...env, MIVO_REVIEW_MODEL_HEAVY: 'openai/test-only' }).model, 'openai/test-only');
  assert.deepEqual(roleModel('fallback', env), { model: 'openai/gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(roleModel('fallback', {}), FALLBACK);
  assert.deepEqual(roleModel('primary', {}), { model: 'openai/gpt-6-luna', effort: 'max' });
  assert.equal(roleModel('verifier', {}), null, '核对员没有默认值,用 review-features.json');
  assert.throws(() => roleModel('boss', {}), /角色不合法/);
  const bad = { MIVO_REVIEW_ROLE_PRIMARY: '{nope', MIVO_REVIEW_ROLE_FALLBACK: JSON.stringify({ model: 'claude-x', effort: 'max' }),
    MIVO_REVIEW_ROLE_VERIFIER: JSON.stringify({ model: 'openai/gpt-6.1-sol', effort: 'extreme' }) };
  assert.equal(tierConfig('light', bad).model, 'openai/gpt-6-luna');
  assert.deepEqual(roleModel('fallback', bad), FALLBACK);
  const warnings = roleWarnings(bad);
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /MIVO_REVIEW_ROLE_PRIMARY 不是合法 JSON/);
  assert.match(warnings.join('\n'), /MIVO_REVIEW_ROLE_FALLBACK model 不合法/);
  assert.match(warnings.join('\n'), /MIVO_REVIEW_ROLE_VERIFIER effort 不合法/);
  assert.deepEqual(roleWarnings({}), []);
  assert.deepEqual(parseRoleModel(''), { value: null, error: null });
  assert.deepEqual(parseRoleModel(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', effort: 'max' })),
    { value: { model: 'deepseek/deepseek-v4.1-flash', effort: 'max' }, error: null });
  assert.match(parseRoleModel(JSON.stringify({ model: 'DeepSeek/x', effort: 'max' })).error, /model 不合法/);
  assert.match(parseRoleModel(JSON.stringify({ model: 'deepseek/a b', effort: 'max' })).error, /model 不合法/);
});

test('nextAttempt 用传进来的备用模型;备用与主模型相同就不再试', () => {
  const primary = tierConfig('standard', {});
  const fallback = { model: 'openai/gpt-7-mini', effort: 'low' };
  assert.deepEqual(nextAttempt({ primary, attempts: [{ ok: false }], elapsedMs: 10 * MIN, fallback }), { ...fallback, timeoutMs: 60 * MIN });
  assert.equal(nextAttempt({ primary, attempts: [{ ok: false }], elapsedMs: 10 * MIN, fallback: { model: primary.model, effort: 'low' } }), null);
});

test('备用模型被 marker 标为降级:主审非额度类失败后不再尝试备用;降级的是别的模型、或没有降级字段时与原来一致', () => {
  const primary = tierConfig('standard', {});
  const attempts = [{ ok: false, quota: false }];
  const sol = { model: FALLBACK.model, reason: 'gateway timeout' };
  assert.deepEqual(nextAttempt({ primary, attempts, elapsedMs: 10 * MIN }), { model: FALLBACK.model, effort: FALLBACK.effort, timeoutMs: primary.timeoutMs });
  assert.equal(nextAttempt({ primary, attempts, elapsedMs: 10 * MIN, degraded: sol }), null);
  assert.deepEqual(nextAttempt({ primary, attempts, elapsedMs: 10 * MIN, degraded: null }), nextAttempt({ primary, attempts, elapsedMs: 10 * MIN }));
  assert.ok(nextAttempt({ primary, attempts, elapsedMs: 10 * MIN, degraded: { model: 'openai/other', reason: '' } }), '降级的不是备用模型就照常换');
  // 角色变量把备用换成别的模型时,按 id 比较,sol 的降级不影响它
  const other = { model: 'openai/gpt-6-terra', effort: 'high' };
  assert.equal(nextAttempt({ primary, attempts, elapsedMs: 10 * MIN, fallback: other, degraded: sol })?.model, other.model);
  // 主审第一次尝试不受降级影响
  assert.deepEqual(nextAttempt({ primary, attempts: [], elapsedMs: 0, degraded: sol }), primary);
});
