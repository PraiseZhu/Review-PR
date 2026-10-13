// Local-timezone timestamps for review records and Feishu cards.
// Date.parse still works; the offset replaces trailing Z so the wall clock is readable.

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function offsetParts(date) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return { sign, hours: Math.floor(abs / 60), minutes: abs % 60 };
}

/** Machine-parseable ISO in the host timezone, e.g. 2026-09-17T15:25:02.811+08:00 */
export function formatLocalIso(value = Date.now()) {
  const date = toDate(value);
  if (!date) throw new Error('时间无效');
  const { sign, hours, minutes } = offsetParts(date);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(hours)}:${pad(minutes)}`;
}

/** Human wall-clock for Feishu / markdown, e.g. 2026-09-17 15:25:02 GMT+8 */
export function formatLocalDisplay(value) {
  const date = toDate(value);
  if (!date) return typeof value === 'string' ? value.trim() : '';
  const { sign, hours, minutes } = offsetParts(date);
  const gmt = minutes ? `GMT${sign}${hours}:${pad(minutes)}` : `GMT${sign}${hours}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${gmt}`;
}
