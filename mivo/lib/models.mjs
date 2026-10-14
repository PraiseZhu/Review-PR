// models.mjs — 审查模型的选择。三档同一个主模型与思考强度(与 Cindy 一致:档位只决定审查深度),
// 主模型失败(非额度类)时换备用模型重试一次。
// 用户 2026-10-11 决定:主力 gpt-6-luna / max,备用 gpt-6.1-sol / medium。
// 用户 2026-10-14 决定大 PR 审得深:heavy 主模型最多 98 分钟,备用实足 20 分钟以上,作业上限 160 分钟。
//
// 时间一律按毫秒算。主备共用一个预算 budgetMs:review.mjs 在调模型前按本 job 的真实开始时间算
// 「作业截止 − 现在 − 发布预留」,再与 120 分钟取小(codexBudgetMs)。非模型阶段用时长了,预算跟着收缩,
// 发布(含产物上传)始终留 10 分钟。

const MIN = 60_000;
export const TIER_DEFAULTS = {
  light: { model: 'openai/gpt-6-luna', effort: 'max', timeoutMin: 15 },
  standard: { model: 'openai/gpt-6-luna', effort: 'max', timeoutMin: 45 },
  heavy: { model: 'openai/gpt-6-luna', effort: 'max', timeoutMin: 100 },
};
export const FALLBACK = { model: 'openai/gpt-6.1-sol', effort: 'medium' };
export const CODEX_BUDGET_MS = 120 * MIN; // 一次审查里模型调用合计的上限
export const FALLBACK_RESERVE_MS = 20 * MIN; // 主模型上限扣掉这一段,留给备用
export const SETTLE_MS = MIN; // 每次调用被终止后的收尾余量(看门狗 15 秒一查,SIGKILL 再等 10 秒)
export const PUBLISH_RESERVE_MS = 10 * MIN; // 模型之后发布 review、写 check、上传结果包
export const MIN_FALLBACK_MS = 15 * MIN;
// review-pr.yml 的 codex 步骤用 MIVO_REVIEW_JOB_TIMEOUT_MIN 告诉这里作业上限。没传说明还是旧 workflow(110 分钟),
// 按旧上限算才不会把模型预算排到作业被 GitHub 掐断之后。
export const DEFAULT_JOB_TIMEOUT_MIN = 110;

/** 某档的主模型配置;仓库变量 MIVO_REVIEW_{MODEL,EFFORT,TIMEOUT}_<档> 可覆盖默认值。主模型上限给备用和两次收尾留出时间。 */
export function tierConfig(tier, env = process.env, { budgetMs = CODEX_BUDGET_MS } = {}) {
  const defaults = TIER_DEFAULTS[tier];
  if (!defaults) throw new Error(`档位不合法:${tier}`);
  const key = tier.toUpperCase();
  const timeoutMin = Number(env[`MIVO_REVIEW_TIMEOUT_${key}`]) || defaults.timeoutMin;
  return {
    model: env[`MIVO_REVIEW_MODEL_${key}`] || defaults.model,
    effort: env[`MIVO_REVIEW_EFFORT_${key}`] || defaults.effort,
    timeoutMs: Math.max(0, Math.min(timeoutMin * MIN, budgetMs - FALLBACK_RESERVE_MS - 2 * SETTLE_MS)),
  };
}

/**
 * 从 jobs 接口与 run 接口的返回里取作业开始时间(纯函数,review.mjs 负责调接口)。
 * 优先本 job 的 started_at(按 runner 名找,只有一个 job 时直接用);没有就用 run 的 created_at,
 * 它一定不晚于 job 开始,是可靠下界。都没有返回 null:不启动付费模型。
 */
export function pickJobStart({ jobsJson = null, runJson = null, runnerName = '' } = {}) {
  const list = Array.isArray(jobsJson?.jobs) ? jobsJson.jobs : [];
  const job = list.find((j) => runnerName && j?.runner_name === runnerName) ?? (list.length === 1 ? list[0] : null);
  if (job && Number.isFinite(Date.parse(job.started_at))) return { at: job.started_at, from: 'job' };
  if (Number.isFinite(Date.parse(runJson?.created_at))) return { at: runJson.created_at, from: 'run-created' };
  return null;
}

/** 这次审查的模型预算:min(120 分钟, 作业截止 − 现在 − 发布预留)。 */
export function codexBudgetMs({ jobStartMs, jobTimeoutMin, nowMs }) {
  return Math.min(CODEX_BUDGET_MS, jobStartMs + jobTimeoutMin * MIN - nowMs - PUBLISH_RESERVE_MS);
}

/**
 * 下一次尝试;没有下一次时返回 null。主模型上限为 0(预算不够)时不启动。
 * 只在主模型失败且不是额度类报错时换备用;备用超时取 min(主模型上限, 预算 − 已用 − 收尾余量),
 * 不足 15 分钟或备用与主模型相同时不再尝试。
 */
export function nextAttempt({ primary, attempts, elapsedMs, budgetMs = CODEX_BUDGET_MS }) {
  if (attempts.length === 0) return primary.timeoutMs > 0 ? { ...primary } : null;
  if (attempts.length > 1) return null;
  const last = attempts[0];
  if (last.ok) return null;
  if (last.quota) return null;
  if (FALLBACK.model === primary.model) return null;
  const available = budgetMs - elapsedMs - SETTLE_MS;
  if (available < MIN_FALLBACK_MS) return null;
  return { ...FALLBACK, timeoutMs: Math.min(primary.timeoutMs, available) };
}
