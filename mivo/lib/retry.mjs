// retry.mjs — 同一个 head 的服务器审查失败后怎么重试(Mini 前置审查用)。
//
// 失败一次后等 10 分钟再派,之后每次翻倍,最多等 4 小时;同一个 head 失败满 6 次就停,
// 等作者推新提交(新 head 重新计数)或维护者在 Mini 上清掉该 PR 的失败记录。
// review-pr.yml 的守卫只收 attempt 1–9,派发次数超过 9 也停,不再派一个必然被拒的 run。
// 维护窗口与工具链不健康不算失败(collectServerRun 里另行处理)。
export const RETRY_BASE_MINUTES = 10;
export const RETRY_MAX_WAIT_MINUTES = 240;
export const MAX_FAILURES_PER_HEAD = 6;
export const MAX_DISPATCH_ATTEMPT = 9;

/** 这次能不能派发:{dispatch:true} 或 {dispatch:false, reason, nextAt?}。 */
export function toRetryDecision({ failure = null, attempt = 1, nowMs = Date.now() } = {}) {
  if (attempt > MAX_DISPATCH_ATTEMPT) {
    return { dispatch: false, reason: `同一提交已派发 ${MAX_DISPATCH_ATTEMPT} 次(review-pr.yml 的上限),停止自动重试,需要人工处理` };
  }
  const count = Number(failure?.count) || 0;
  if (count <= 0) return { dispatch: true };
  if (count >= MAX_FAILURES_PER_HEAD) {
    return { dispatch: false, reason: `同一提交服务器审查失败 ${count} 次,停止自动重试,需要人工处理(推新提交会重新审查)` };
  }
  const waitMs = Math.min(RETRY_BASE_MINUTES * 2 ** (count - 1), RETRY_MAX_WAIT_MINUTES) * 60_000;
  const nextAtMs = Date.parse(failure.at) + waitMs;
  if (!Number.isFinite(nextAtMs)) return { dispatch: true };
  if (nowMs < nextAtMs) {
    const nextAt = new Date(nextAtMs).toISOString();
    return { dispatch: false, reason: `上次服务器审查失败(第 ${count} 次),${nextAt} 之后重试`, nextAt };
  }
  return { dispatch: true };
}

/** 收回一次结果后的失败记录:失败就给这个 head 加一次,成功就清掉。 */
export function toFailureRecord(failures, head, failed, atIso) {
  const next = { ...(failures ?? {}) };
  if (failed) next[head] = { count: (Number(next[head]?.count) || 0) + 1, at: atIso };
  else delete next[head];
  return next;
}
