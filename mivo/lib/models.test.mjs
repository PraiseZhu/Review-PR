import test from 'node:test';
import assert from 'node:assert/strict';
import { TIER_DEFAULTS, FALLBACK, CODEX_BUDGET_MS, SETTLE_MS, PUBLISH_RESERVE_MS, tierConfig, nextAttempt, codexBudgetMs } from './models.mjs';

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
  assert.deepEqual(tierConfig('light', {}), { model: 'openai/gpt-6-luna', effort: 'max', timeoutMs: 15 * MIN });
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

test('standard 主备 45/45,light 15/15', () => {
  const standard = tierConfig('standard', {});
  assert.equal(standard.timeoutMs, 45 * MIN);
  assert.equal(nextAttempt({ primary: standard, attempts: [{ ok: false }], elapsedMs: 45 * MIN + 30_000 }).timeoutMs, 45 * MIN);
  const light = tierConfig('light', {});
  assert.equal(light.timeoutMs, 15 * MIN);
  assert.equal(nextAttempt({ primary: light, attempts: [{ ok: false }], elapsedMs: 15 * MIN + 10_000 }).timeoutMs, 15 * MIN);
});

test('主模型一次;非额度类失败换备用一次;额度类失败或成功都不再试', () => {
  const primary = tierConfig('standard', {});
  assert.deepEqual(nextAttempt({ primary, attempts: [], elapsedMs: 0 }), primary);
  assert.equal(nextAttempt({ primary, attempts: [{ ok: true }], elapsedMs: 3 * MIN }), null);
  assert.equal(nextAttempt({ primary, attempts: [{ ok: false, quota: true }], elapsedMs: MIN }), null);
  assert.deepEqual(nextAttempt({ primary, attempts: [{ ok: false, quota: false }], elapsedMs: 10 * MIN }),
    { model: 'openai/gpt-6.1-sol', effort: 'medium', timeoutMs: 45 * MIN });
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
  const fallbackAsPrimary = { ...FALLBACK, timeoutMs: 45 * MIN };
  assert.equal(nextAttempt({ primary: fallbackAsPrimary, attempts: [{ ok: false }], elapsedMs: MIN }), null);
});
