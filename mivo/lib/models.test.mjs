import test from 'node:test';
import assert from 'node:assert/strict';
import { TIER_DEFAULTS, FALLBACK, tierConfig, nextAttempt } from './models.mjs';

test('三档同一个主模型与思考强度,只有超时不同', () => {
  for (const tier of ['light', 'standard', 'heavy']) {
    assert.equal(TIER_DEFAULTS[tier].model, 'openai/gpt-6-luna');
    assert.equal(TIER_DEFAULTS[tier].effort, 'max');
  }
  assert.deepEqual(FALLBACK, { model: 'x-ai-grok/grok-4.6', effort: 'high' });
});

test('仓库变量可以覆盖某一档', () => {
  const cfg = tierConfig('heavy', { MIVO_REVIEW_MODEL_HEAVY: 'openai/gpt-6-sol', MIVO_REVIEW_EFFORT_HEAVY: 'high' });
  assert.deepEqual(cfg, { model: 'openai/gpt-6-sol', effort: 'high', timeoutMin: 75 });
  assert.deepEqual(tierConfig('light', {}), { model: 'openai/gpt-6-luna', effort: 'max', timeoutMin: 15 });
  assert.throws(() => tierConfig('huge', {}), /档位不合法/);
});

test('主模型一次;非额度类失败换备用一次;额度类失败或成功都不再试', () => {
  const primary = tierConfig('standard', {});
  assert.deepEqual(nextAttempt({ primary, attempts: [], elapsedMin: 0 }), primary);
  assert.equal(nextAttempt({ primary, attempts: [{ ok: true }], elapsedMin: 3 }), null);
  assert.equal(nextAttempt({ primary, attempts: [{ ok: false, quota: true }], elapsedMin: 1 }), null);
  assert.deepEqual(nextAttempt({ primary, attempts: [{ ok: false, quota: false }], elapsedMin: 10 }),
    { model: 'x-ai-grok/grok-4.6', effort: 'high', timeoutMin: 45 });
  assert.equal(nextAttempt({ primary, attempts: [{ ok: false }, { ok: false }], elapsedMin: 20 }), null);
});

test('备用只用剩余预算;不足 5 分钟或与主模型相同时不再试', () => {
  const heavy = tierConfig('heavy', {});
  assert.equal(nextAttempt({ primary: heavy, attempts: [{ ok: false }], elapsedMin: 76 }).timeoutMin, 14);
  assert.equal(nextAttempt({ primary: heavy, attempts: [{ ok: false }], elapsedMin: 86 }), null);
  const grokPrimary = { ...FALLBACK, timeoutMin: 45 };
  assert.equal(nextAttempt({ primary: grokPrimary, attempts: [{ ok: false }], elapsedMin: 1 }), null);
});
