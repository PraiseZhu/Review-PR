import { createHash } from 'node:crypto';
import { toReviewIdentity, isReviewIdentity } from './reviewer-identity.mjs';

export function rebaseReminderFingerprint(mergeBaseDate) {
  const value = String(mergeBaseDate ?? '').trim();
  if (!value || Number.isNaN(Date.parse(value))) throw new Error('stale-rebase 提醒缺少有效 merge base 时间');
  return createHash('sha256').update(value).digest('hex');
}

export function rebaseReminderMarker(fingerprint) {
  if (!/^[0-9a-f]{64}$/i.test(String(fingerprint ?? ''))) throw new Error('stale-rebase 提醒指纹无效');
  return `<!-- review-pr:stale-rebase fingerprint=${String(fingerprint).toLowerCase()} -->`;
}

// viewer 可以是登录名字符串,也可以是审查身份对象(集合内任一账号发过的提醒都算已提醒)。
export function hasTrustedRebaseReminder(comments, { viewer, fingerprint, mergeBaseDate }) {
  const identity = toReviewIdentity(typeof viewer === 'string' ? viewer.trim() : viewer);
  if (identity.logins.length === 0 || !Array.isArray(comments)) return false;
  const marker = rebaseReminderMarker(fingerprint);
  const mergeBaseMs = Date.parse(String(mergeBaseDate ?? ''));
  return comments.some((comment) => {
    if (!isReviewIdentity(comment?.user, identity)) return false;
    const body = String(comment?.body ?? '');
    if (body.includes(marker)) return true;
    // 兼容旧版无 marker 评论：只认当前 viewer 在本次 merge-base 之后发出的固定提醒文案。
    const createdMs = Date.parse(String(comment?.created_at ?? ''));
    return Number.isFinite(mergeBaseMs) && Number.isFinite(createdMs) && createdMs >= mergeBaseMs &&
      body.includes('这个 PR 已经有') && body.includes('没有 rebase 了') && body.includes('请在本地 rebase 最新的');
  });
}
