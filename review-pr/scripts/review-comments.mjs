// Typed GitHub review comments; no invented line/position defaults.
import { createHash } from 'node:crypto';

export function normalizeReviewComments(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw new Error('comments 必须为 1 至 100 条问题数组');
  return input.map((item, i) => {
    if (!item || typeof item.path !== 'string' || !item.path.trim() || /(^\/|\\|(?:^|\/)\.\.(?:\/|$))/.test(item.path) ||
        typeof item.body !== 'string' || item.body.trim().length < 4) throw new Error(`第 ${i + 1} 条问题缺少合法 path/body`);
    const comment = { path: item.path, body: item.body.trim() };
    if (item.subject_type === 'file') {
      if (item.line !== undefined || item.position !== undefined) throw new Error('文件级 thread 不应带伪造行号');
      return { ...comment, subject_type: 'file' };
    }
    if (!Number.isSafeInteger(item.line) || item.line <= 0 || !['LEFT', 'RIGHT'].includes(item.side)) throw new Error(`第 ${i + 1} 条问题缺少真实 line/side`);
    return { ...comment, line: item.line, side: item.side };
  });
}

export function findingsMarker(head, body, comments) {
  const digest = createHash('sha256').update(JSON.stringify({ head, body, comments })).digest('hex');
  return `<!-- review-pr:findings head=${head} digest=${digest} -->`;
}
