// keys.mjs — 模型网关的主 key 与备用 key(维护者 2026-10-18 定的规则):
//   - 每轮都从主 key(LITELLM_CREDENTIALS_JSON)开始。只有「确定是 key 本身的问题」(codex.mjs 的 toKeyFailure:认证失败、
//     额度/预算用完、没有该模型权限)才换备用 key,同模型同档位原地重跑一次;不占备用模型那一次机会。
//   - 限流(429 且正文没有 budget 字样,#143)不换 key:按 Retry-After(没有就 60 秒)等待后用同一把 key 重试,最多 3 次、
//     总等待不超过 5 分钟,等待时间计入模型预算;重试用完仍限流就当普通失败(可换备用模型),不算额度类、不让 Mini 暂停。
//   - 超时、卡住、5xx、断网、参数错、模型不存在、答卷不合格都不换 key,照旧走「换备用模型 / 暂停」。
//   - 一轮里只换一次、不换回:之后的调用(备用模型、核对员)都用备用 key。两把都报 key 错误时 quota 为真,Mini 照旧暂停 60 分钟。
//   - 主 key 审到一半(模型已经产出过条目)才报 key 错误:剩余时间够就同样换备用 key 重跑,并记 primaryFailedMidRun,
//     Mini 据此写 MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL,之后 60 分钟新开的轮次直接用备用 key,到期再先试主 key。
// 备用 key 来自组织 Secret ANTHROPIC_API_KEY(workflow 传成 LITELLM_BACKUP_API_KEY),网关地址取 LITELLM_BACKUP_BASE_URL,
// 没设时用主凭据的 base_url。备用 key 没配或格式不对时就当没有备用,主 key 照常工作。纯函数,不读环境、不调网络。
import { parseCredentials } from './codex.mjs';

export const BACKUP_KEY_ENV = 'LITELLM_BACKUP_API_KEY';
export const BACKUP_BASE_ENV = 'LITELLM_BACKUP_BASE_URL';
export const PREFER_BACKUP_ENV = 'MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL';

/** 本轮的 key 状态。active 为 null 表示两把都不可用(调用方照旧把主凭据交给 runCodex,让它报出原错误)。 */
export function toKeyRing(env, nowMs = Date.now()) {
  const warnings = [];
  let primary = null;
  try { primary = parseCredentials(env.LITELLM_CREDENTIALS_JSON); } catch (error) {
    warnings.push(`主 key 凭据不可用(${error.message})`);
  }
  let backup = null;
  const backupKey = String(env[BACKUP_KEY_ENV] ?? '').trim();
  if (backupKey) {
    const baseUrl = String(env[BACKUP_BASE_ENV] ?? '').trim() || primary?.baseUrl || '';
    try { backup = parseCredentials(JSON.stringify({ api_key: backupKey, base_url: baseUrl })); } catch (error) {
      warnings.push(`备用 key 凭据不可用(${error.message}),本轮没有备用 key`);
    }
    if (backup && primary && backup.apiKey === primary.apiKey) {
      backup = null;
      warnings.push('备用 key 与主 key 相同,本轮没有备用 key');
    }
  }
  const until = Date.parse(String(env[PREFER_BACKUP_ENV] ?? ''));
  const preferBackup = backup !== null && Number.isFinite(until) && until > nowMs;
  let active = 'primary';
  if (!primary) active = backup ? 'backup' : null;
  else if (preferBackup) active = 'backup';
  if (!primary && backup) warnings.push('主 key 凭据不可用,本轮改用备用 key');
  return {
    primary, backup, active, warnings,
    preferBackup, preferUntil: preferBackup ? new Date(until).toISOString() : null,
    startedOn: active,
    switched: null, // { kind, status, midRun, model, label }:本轮从主 key 换到备用 key 的那次
    primaryOk: false, // 本轮至少有一次主 key 调用没有报 key 错误(主 key 能用)
    down: null, // { kind, status, credential, phase }:本轮最后能用的那把(备用,或没有备用时的主 key)也报了 key 错误
  };
}

export const RATE_LIMIT_RETRIES = 3;
export const RATE_LIMIT_DEFAULT_WAIT_MS = 60_000;
export const RATE_LIMIT_MAX_WAIT_MS = 5 * 60_000;

/** 限流报错里的 Retry-After(秒,或带 ms 单位);认不出时按 60 秒。不截断:要求等得比上限还久的,toRateLimitRetry 直接不等。 */
export function toRateLimitWait(message) {
  const m = String(message ?? '').match(/retry[-_ ]?after\D{0,5}(\d+(?:\.\d+)?)\s*(ms|milliseconds?)?/i);
  if (!m) return RATE_LIMIT_DEFAULT_WAIT_MS;
  const ms = m[2] ? Number(m[1]) : Number(m[1]) * 1000;
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : RATE_LIMIT_DEFAULT_WAIT_MS;
}

/**
 * 一次调用限流失败后要不要同 key 重试:返回 { waitMs } 或 null。retries 是已经重试的次数,waitedMs 是已经等过的总时长,
 * remainingMs 是这段剩余的模型预算,minRetryMs 是重试至少要留的运行时间。
 */
export function toRateLimitRetry({ result, retries, waitedMs, remainingMs, minRetryMs }) {
  if (result?.ok || result?.keyFailure?.kind !== 'rate-limit') return null;
  if (retries >= RATE_LIMIT_RETRIES) return null;
  const waitMs = toRateLimitWait(result.finalError);
  // 网关要求等的比剩下的等待额度还久:提前重试多半还是限流,不等,按普通失败走(e2e 发现)。
  if (waitedMs + waitMs > RATE_LIMIT_MAX_WAIT_MS) return null;
  if (remainingMs - waitMs < minRetryMs) return null;
  return { waitMs };
}

/** 两把 key 原文,给 runCodex 的 redactKeys:产物里任何一把都不能出现。 */
export const keyTexts = (ring) => [ring.primary?.apiKey, ring.backup?.apiKey].filter(Boolean);

/** 当前该用的凭据;两把都不可用时返回主凭据原文,让 runCodex 报出原来的解析错误。 */
export const activeCredentials = (ring, env) => (ring.active ? ring[ring.active] : env.LITELLM_CREDENTIALS_JSON);

/**
 * 一次调用之后:要不要换备用 key 重跑。返回 null 或 { kind, status, midRun }。只在用主 key、有备用 key、
 * 失败且最终错误是 key 本身的问题时换;同时记下主 key 是否能用(成功或模型已产出条目,说明网关收了这把 key)。
 * 调用方负责重跑和更新 ring.active。
 */
export function toKeySwitch(ring, result) {
  if (ring.active !== 'primary') return null;
  if (!result.keyFailure && (result.ok || result.outputStarted)) ring.primaryOk = true;
  if (result.ok || !result.keyFailure) return null;
  if (result.keyFailure.kind === 'rate-limit') return null; // 限流不换 key(#143)
  if (!ring.backup) return null;
  return { kind: result.keyFailure.kind, status: result.keyFailure.status ?? null, midRun: result.outputStarted === true };
}

/**
 * 一次调用(含换 key 重跑)结束后:用的是最后那把 key(备用,或没有备用时的主 key)还报 key 错误,就记成 down。
 * 主审之外的调用(核对员)也走这里,两把都坏时 key 状态才能报 down,不会停在 backup。phase 区分主审与核对员。
 */
export function noteKeyResult(ring, credential, result, phase) {
  const last = credential === 'backup' || !ring.backup;
  // 同一把 key 后面又成功了(例如备用 key 没有主审模型的权限,备用模型却能用):它不是 down。
  if (!result?.keyFailure) { if (last && (result?.ok || result?.outputStarted)) ring.down = null; return; }
  if (result.keyFailure.kind === 'rate-limit') return; // 限流是短暂的,不说明 key 坏了(#143)
  if (last) {
    ring.down = { kind: result.keyFailure.kind, status: result.keyFailure.status ?? null, credential, phase };
  }
}

/** 换到备用 key:只换一次,之后本轮都用备用。 */
export function switchToBackup(ring, change, { model, label }) {
  ring.active = 'backup';
  ring.switched = { ...change, model, label };
}

/** 进结果包的摘要(state.codex.credential):不含任何 key 原文和网关地址。Mini 据此写冷却期和 key 状态。 */
export function toCredentialSummary(ring) {
  return {
    backupConfigured: ring.backup !== null,
    startedOn: ring.startedOn,
    active: ring.active,
    preferBackup: ring.preferBackup,
    preferUntil: ring.preferUntil,
    switched: ring.switched,
    primaryFailedMidRun: ring.switched?.midRun === true,
    primaryOk: ring.primaryOk,
    down: ring.down,
    warnings: [...ring.warnings],
  };
}
