// models.mjs — 审查模型的选择。三档同一个主模型与思考强度(与 Cindy 一致:档位只决定审查深度),
// 主模型失败(非额度类)时换备用模型重试一次。
// 用户 2026-10-11 决定:主力 gpt-6-luna / max,备用 gpt-6.1-sol / medium。

export const TIER_DEFAULTS = {
  light: { model: 'openai/gpt-6-luna', effort: 'max', timeoutMin: 15 },
  standard: { model: 'openai/gpt-6-luna', effort: 'max', timeoutMin: 45 },
  heavy: { model: 'openai/gpt-6-luna', effort: 'max', timeoutMin: 75 },
};
export const FALLBACK = { model: 'openai/gpt-6.1-sol', effort: 'medium' };
// job 上限 110 分钟,扣掉 prepare / deps / publish 的余量后,模型调用合计不超过 90 分钟。
export const CODEX_BUDGET_MIN = 90;
const MIN_FALLBACK_MIN = 5;

/** 某档的主模型配置;仓库变量 MIVO_REVIEW_{MODEL,EFFORT,TIMEOUT}_<档> 可覆盖默认值。 */
export function tierConfig(tier, env = process.env) {
  const defaults = TIER_DEFAULTS[tier];
  if (!defaults) throw new Error(`档位不合法:${tier}`);
  const key = tier.toUpperCase();
  return {
    model: env[`MIVO_REVIEW_MODEL_${key}`] || defaults.model,
    effort: env[`MIVO_REVIEW_EFFORT_${key}`] || defaults.effort,
    timeoutMin: Number(env[`MIVO_REVIEW_TIMEOUT_${key}`]) || defaults.timeoutMin,
  };
}

/**
 * 主模型之后的下一次尝试;没有下一次时返回 null 并给出原因。
 * 只在主模型失败且不是额度类报错时换备用;备用与主模型相同、或剩余预算不足 5 分钟时不再尝试。
 */
export function nextAttempt({ primary, attempts, elapsedMin }) {
  if (attempts.length === 0) return { ...primary };
  if (attempts.length > 1) return null;
  const last = attempts[0];
  if (last.ok) return null;
  if (last.quota) return null;
  if (FALLBACK.model === primary.model) return null;
  const remaining = CODEX_BUDGET_MIN - elapsedMin;
  if (remaining < MIN_FALLBACK_MIN) return null;
  return { ...FALLBACK, timeoutMin: Math.min(primary.timeoutMin, Math.floor(remaining)) };
}
