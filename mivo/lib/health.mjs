// health.mjs — 新审查机读老审查机同一份营业窗口与 healthy.marker,语义逐条照搬 Mivo 的
// `.github/scripts/review_tool_health.py`(两套共用 L20-1 上同一个工具目录和同一个 codex 二进制,
// 06:00 关席、06:05 更新器维护的也是同一份 marker):
//   - 窗口:Asia/Shanghai 06:00–07:00 关门,其余时间开门;
//   - marker:status=healthy 且有 run_id 才放行;缺文件放行(还没装更新器);读不到按不健康;
//   - 超过 26 小时没更新只告警、不拦(维护者 2026-09-09 决定「通知但不停审」)。
import { readFileSync, statSync } from 'node:fs';
import { FALLBACK, SERVER_MODEL_RE } from './models.mjs';

export const DEFAULT_MARKER = '/AIGC_Group/github-actions-runner/mivo-review-tools/healthy.marker';
export const STALE_AFTER_HOURS = 26;
const ALLOWED_STATUS = new Set(['healthy', 'unhealthy', 'updating']);
// marker 里的备用/核对员模型降级字段(字段名与取值集中在这里;Mivo 仓更新器写入,名字以那边为准):
//   fallback=down|unavailable|failed|timeout(大小写不敏感)  备用模型(同时也是核对员默认用的模型)网关当前不可用;
//   fallback_reason=<一句话>                                 可选,原因,进 warnings 和报告;
//   fallback_model=<模型 id>                                 可选,被标降级的模型,缺省 = 默认备用模型。
// 没有这些字段、值不认识、模型 id 格式不对 = 没有降级(现行为)。不影响放行判据。
export const MARKER_FALLBACK = {
  statusKey: 'fallback', reasonKey: 'fallback_reason', modelKey: 'fallback_model',
  downValues: new Set(['down', 'unavailable', 'failed', 'timeout']), defaultModel: FALLBACK.model,
};
const HOUR_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' });

export function shanghaiHour(now = new Date()) {
  return Number(HOUR_FORMAT.format(now));
}

export function inBusinessWindow(now = new Date()) {
  const hour = shanghaiHour(now);
  return !(hour >= 6 && hour < 7);
}

export function parseMarker(text) {
  const fields = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#') || !stripped.includes('=')) continue;
    const at = stripped.indexOf('=');
    const key = stripped.slice(0, at).trim();
    if (key) fields[key] = stripped.slice(at + 1).trim();
  }
  return fields;
}

export function markerStatus(fields) {
  if (!fields || Object.keys(fields).length === 0) return 'unhealthy';
  const status = String(fields.status ?? '').trim().toLowerCase();
  return ALLOWED_STATUS.has(status) ? status : 'unhealthy';
}

export function isHealthyMarker(fields) {
  return markerStatus(fields) === 'healthy' && String(fields?.run_id ?? '').trim() !== '';
}

/** marker 的降级信息:{ model, reason } 或 null。 */
export function toDegradation(fields) {
  if (!fields) return null;
  const value = String(fields[MARKER_FALLBACK.statusKey] ?? '').trim().toLowerCase();
  if (!MARKER_FALLBACK.downValues.has(value)) return null;
  const model = String(fields[MARKER_FALLBACK.modelKey] ?? '').trim() || MARKER_FALLBACK.defaultModel;
  if (!SERVER_MODEL_RE.test(model)) return null;
  // 原因进报告和 warnings:去掉控制字符并限长
  const reason = String(fields[MARKER_FALLBACK.reasonKey] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  return { model, reason };
}

/** 纯函数:fields=null 表示文件不存在;unreadable=true 表示存在但读不到(按不健康)。 */
export function toHealthVerdict({ now = new Date(), fields = null, unreadable = false, writtenAt = null, markerPath = DEFAULT_MARKER } = {}) {
  const window = inBusinessWindow(now);
  const ageHours = writtenAt ? Math.round(((now - writtenAt) / 3_600_000) * 10) / 10 : null;
  let ok;
  let reason;
  let status = unreadable ? 'unreadable' : fields === null ? 'missing' : markerStatus(fields);
  if (!window) {
    ok = false;
    reason = 'outside-business-window';
  } else if (unreadable) {
    ok = false;
    reason = 'toolchain-unreadable';
  } else if (fields === null) {
    ok = true;
    reason = 'ok-no-marker';
  } else if (!isHealthyMarker(fields)) {
    ok = false;
    reason = `toolchain-${status}`;
  } else {
    ok = true;
    reason = 'ok';
    status = 'healthy';
  }
  return {
    ok, window, reason, markerStatus: status,
    runId: fields?.run_id ?? '', failStreak: fields?.fail_streak ?? '0',
    markerWrittenAt: writtenAt ? writtenAt.toISOString() : '', markerAgeHours: ageHours,
    markerStale: ageHours !== null && ageHours > STALE_AFTER_HOURS, markerPath,
    degraded: unreadable ? null : toDegradation(fields),
  };
}

export function readHealth({ now = new Date(), markerPath = process.env.MIVO_REVIEW_HEALTH_MARKER || DEFAULT_MARKER } = {}) {
  let fields = null;
  let unreadable = false;
  try {
    fields = parseMarker(readFileSync(markerPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') unreadable = true;
  }
  let writtenAt = null;
  try { writtenAt = statSync(markerPath).mtime; } catch { /* 缺文件或没权限:没有写盘时间 */ }
  return toHealthVerdict({ now, fields, unreadable, writtenAt, markerPath });
}

/** 给人看的一句话:为什么这次不开审、什么时候会继续。 */
export function toHealthReason(verdict) {
  if (verdict.reason === 'outside-business-window') return '维护窗口(06:00–07:00 Asia/Shanghai)不开审,07:00 后自动重审';
  return `审查工具链不健康(healthy.marker ${verdict.markerStatus}${verdict.failStreak !== '0' ? `,连续失败 ${verdict.failStreak} 天` : ''}),每日更新恢复健康后自动重审`;
}
