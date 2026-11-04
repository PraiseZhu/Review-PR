// [MIVO-PATCH reviewer-app] 单条 review dismissal 写入:成功 / 已被 dismiss(422 后回读确认)/ 失败。
// 失败信息写清期望与实际 HTTP 状态,不含令牌;一律 noCredFallback,不回落到别的凭证。
import { gh } from './lib.mjs';
import { scrubSecrets } from './secret-scrub.mjs';

export function putDismissal({ slug, pr, reviewId, message, ghFn = gh }) {
  const endpoint = `repos/${slug}/pulls/${pr}/reviews/${reviewId}`;
  const put = ghFn(['api', '--method', 'PUT', `${endpoint}/dismissals`, '--input', '-'], {
    input: JSON.stringify({ message, event: 'DISMISS' }), allowFail: true, timeoutMs: 15_000, noCredFallback: true,
  });
  if (put.ok) return { status: 'dismissed', reviewId };
  const detail = scrubSecrets((put.stderr || put.stdout || '').trim()).slice(0, 300);
  const http = /HTTP (\d{3})/.exec(detail)?.[1] ?? '(无状态码)';
  const failure = (extra = '') => ({ status: 'failed', reviewId,
    error: `dismiss review ${reviewId} 失败:期望 HTTP 2xx 或 review 已是 DISMISSED,实际 HTTP ${http}${extra}(${detail})` });
  // 只有 422(已被撤销 / 并发)才回读确认;403 等直接失败,不重试。
  if (http !== '422') return failure();
  const read = ghFn(['api', '--method', 'GET', endpoint], { allowFail: true, timeoutMs: 15_000, noCredFallback: true });
  let state = '';
  try { state = String(JSON.parse(read.stdout || '{}')?.state ?? ''); } catch { /* 读不出按失败 */ }
  if (read.ok && state.toUpperCase() === 'DISMISSED') return { status: 'already-dismissed', reviewId };
  return failure(`,回读 state=${state || '(读取失败)'}`);
}
