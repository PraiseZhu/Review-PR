// models.mjs — 审查模型的选择。三档同一个主模型与思考强度(与 Cindy 一致:档位只决定审查深度),
// 主模型失败(非额度类)时换备用模型重试一次。
// 用户 2026-10-11 决定:主力 gpt-6-luna / max,备用 gpt-6.1-sol / medium。
// 用户 2026-10-14 决定大 PR 审得深:heavy 主模型最多 98 分钟,备用实足 20 分钟以上,作业上限 160 分钟。
// 用户 2026-10-15 决定小 PR 上限 1 小时;2026-10-16 起 standard 也改为 60(45 分钟上限截断了正在输出的审查)。
//
// 时间一律按毫秒算。主备共用一个预算 budgetMs:review.mjs 在调模型前按本 job 的真实开始时间算
// 「作业截止 − 现在 − 发布预留」,再与 120 分钟取小(codexBudgetMs)。非模型阶段用时长了,预算跟着收缩,
// 发布(含产物上传)始终留 10 分钟。

const MIN = 60_000;
export const TIER_DEFAULTS = {
  light: { model: 'openai/gpt-6-luna', effort: 'max', timeoutMin: 60 },
  standard: { model: 'openai/gpt-6-luna', effort: 'max', timeoutMin: 60 },
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

// 角色变量(维护者 2026-10-18):Mini 上「审查机主审模型 / 备用模型 / 核对员模型」三个 Cindy 自动化验证通过后写的仓库变量,
// review-pr.yml 原样传进来。值是 JSON,只认 model 和 effort 两项,其余字段(选的 Cindy 模型、验证 run)只是记录:
//   MIVO_REVIEW_ROLE_PRIMARY  = {"model":"openai/gpt-6-luna","effort":"max",...}   三档主审
//   MIVO_REVIEW_ROLE_FALLBACK = {"model":"openai/gpt-6.1-sol","effort":"medium",...} 主审失败(非额度类)时的备用模型
//   MIVO_REVIEW_ROLE_VERIFIER = {...}                                                 核对员,覆盖 review-features.json 的 model/effort
// 优先级:单档覆盖 MIVO_REVIEW_{MODEL,EFFORT}_<档>(只在测试时临时用)> 角色变量 > 默认值。
// 变量格式不对时用默认值并给出告警,不让整轮审查失败:写入方(models/switch.mjs)写之前已经验证过格式和可用性。
export const ROLE_ENV = { primary: 'MIVO_REVIEW_ROLE_PRIMARY', fallback: 'MIVO_REVIEW_ROLE_FALLBACK', verifier: 'MIVO_REVIEW_ROLE_VERIFIER' };
export const ROLE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const SERVER_MODEL_RE = /^openai\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** 解析一个角色变量:没设返回 { value: null };格式不对返回 { value: null, error }。 */
export function parseRoleModel(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { value: null, error: null };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { value: null, error: '不是合法 JSON' }; }
  const model = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
  const effort = typeof parsed?.effort === 'string' ? parsed.effort.trim() : '';
  if (!SERVER_MODEL_RE.test(model)) return { value: null, error: `model 不合法(${model.slice(0, 80) || '空'})` };
  if (!ROLE_EFFORTS.includes(effort)) return { value: null, error: `effort 不合法(${effort.slice(0, 20) || '空'})` };
  return { value: { model, effort }, error: null };
}

/** 某个角色当前生效的模型:角色变量合法就用它,否则用默认值;verifier 没有默认值(用 review-features.json),返回 null。 */
export function roleModel(role, env = process.env) {
  if (!ROLE_ENV[role]) throw new Error(`角色不合法:${role}`);
  const { value } = parseRoleModel(env[ROLE_ENV[role]]);
  if (value) return value;
  if (role === 'primary') return { model: TIER_DEFAULTS.standard.model, effort: TIER_DEFAULTS.standard.effort };
  if (role === 'fallback') return { ...FALLBACK };
  return null;
}

/** 三个角色变量里格式不对的,每个一条告警(写进结果包,给人看)。 */
export function roleWarnings(env = process.env) {
  return Object.entries(ROLE_ENV).flatMap(([role, name]) => {
    const { error } = parseRoleModel(env[name]);
    return error ? [`仓库变量 ${name} ${error},${role} 按默认值处理`] : [];
  });
}

/** 某档的主模型配置;单档变量 MIVO_REVIEW_{MODEL,EFFORT,TIMEOUT}_<档> > 角色变量 MIVO_REVIEW_ROLE_PRIMARY > 默认值。主模型上限给备用和两次收尾留出时间。 */
export function tierConfig(tier, env = process.env, { budgetMs = CODEX_BUDGET_MS } = {}) {
  const defaults = TIER_DEFAULTS[tier];
  if (!defaults) throw new Error(`档位不合法:${tier}`);
  const key = tier.toUpperCase();
  const timeoutMin = Number(env[`MIVO_REVIEW_TIMEOUT_${key}`]) || defaults.timeoutMin;
  const role = parseRoleModel(env[ROLE_ENV.primary]).value;
  return {
    model: env[`MIVO_REVIEW_MODEL_${key}`] || role?.model || defaults.model,
    effort: env[`MIVO_REVIEW_EFFORT_${key}`] || role?.effort || defaults.effort,
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

/** healthy.marker 把这个模型标成降级(网关不可用)了吗?degraded 是 health.mjs 的 { model, reason } 或 null,按模型 id 比较。 */
export const isDegraded = (degraded, model) => Boolean(degraded?.model) && degraded.model === model;

/**
 * 下一次尝试;没有下一次时返回 null。主模型上限为 0(预算不够)时不启动。
 * 只在主模型失败且不是额度类报错时换备用;备用超时取 min(主模型上限, 预算 − 已用 − 收尾余量),
 * 不足 15 分钟或备用与主模型相同时不再尝试。备用模型取 fallback(review.mjs 传 roleModel('fallback')),默认 FALLBACK。
 * 备用模型被 healthy.marker 标降级(degraded.model 等于它)时不再尝试:网关不可用,等也是白等到超时(2026-10-19 sol 实测)。
 * 换备用 key 重跑同一模型不算一次尝试(见 server/keys.mjs),attempts 里每个模型只有一项。
 */
export function nextAttempt({ primary, attempts, elapsedMs, budgetMs = CODEX_BUDGET_MS, fallback = FALLBACK, degraded = null }) {
  if (attempts.length === 0) return primary.timeoutMs > 0 ? { ...primary } : null;
  if (attempts.length > 1) return null;
  const last = attempts[0];
  if (last.ok) return null;
  if (last.quota) return null;
  if (fallback.model === primary.model) return null;
  if (isDegraded(degraded, fallback.model)) return null;
  const available = budgetMs - elapsedMs - SETTLE_MS;
  if (available < MIN_FALLBACK_MS) return null;
  return { model: fallback.model, effort: fallback.effort, timeoutMs: Math.min(primary.timeoutMs, available) };
}
