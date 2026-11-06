// thread-resolution.mjs — 已修旧 thread 的回复清单(Review-PR #115,#185 改为只回复、不关闭)。纯函数:不读文件、不访问网络、不改入参。
// 条件:本轮完整模型审查已发布;审查机自己发的、带 mivo-finding marker 且 marker 的 head 不是当前 head 的 thread;
// 本轮没有再报(也不在转 issue / pre-existing / 裁定不改 / 核对员推翻的名单里);prepare 之后内容没有变化。
// 选中的 thread 只留一条带 mivo-review:thread-fixed 标记(key + head)的说明,关闭由 Mini 盯梢做;同一 key + head 不重复回复。
// 拿不准一律不选:宁可留给下一轮,不错放。
import { parseFindingMarker } from './finding.mjs';
import { collectRulings } from './rulings.mjs';
import { hasReviewer, toReviewerMatcher } from './reviewer-match.mjs';
import { normalizeReviewActor } from '../../review-pr/scripts/reviewer-identity.mjs';

export const TRIAGE_MARKER = '<!-- review-pr:thread-triage -->';
/** 「已修复,由盯梢关闭」回复末尾的机器可读标记:盯梢按 key + 完整 head + 作者认它。 */
export const renderThreadFixedMarker = ({ key, head }) => `<!-- mivo-review:thread-fixed key=${key} head=${head} -->`;
const HEAD_RE = /^[0-9a-f]{40}$/;
const KEY_RE = /^[0-9a-f]{12}$/;
const RUN_URL_RE = /^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/actions\/runs\/\d+$/;
// 本轮结论已经发到 PR 上的 outcome;error / state-changed / approval-pending 不算。
const PUBLISHED_OUTCOMES = new Set(['findings', 'review-only', 'approval', 'merge-blocked', 'format']);
const lower = (value) => String(value ?? '').toLowerCase();
const commentsOf = (thread) => (Array.isArray(thread?.comments) ? thread.comments : thread?.comments?.nodes ?? []);
// 评论内容指纹:id + 作者 + 正文。新增、删除、编辑评论都会改变它。
// 作者用规范 key:同一个 Bot 的 REST(x[bot])与 GraphQL(x + Bot)写法不产生假变更,同名 User 则不同。
const fingerprint = (thread) => JSON.stringify(commentsOf(thread).map((c) => [c?.id ?? null, normalizeReviewActor(c?.author)?.key ?? '', String(c?.body ?? '')]));

const skip = (skippedReason) => ({ skippedReason, threads: [] });

/** 本轮「已修复」的回复正文:固定中文模板,末尾是 thread-fixed 标记,不拼接模型自由文本。 */
export function renderResolveReply({ head, runUrl, key }) {
  return `本轮在提交 ${head} 完成复核:本轮复核未再发现该问题(key=${key})。已修复，由盯梢关闭；如仍有异议，可在此回复。审查运行:${runUrl}。\n\n${renderThreadFixedMarker({ key, head })}`;
}

/**
 * @returns {{skippedReason: string|null, threads: {id:string, key:string, oldHead:string, reply:string}[]}}
 */
export function buildThreadResolutionPlan({ round = {}, head, reviewer, reviewerIdentity, runUrl, reviewedThreads, liveThreads, threadsVerified, excludedKeys, maintainers } = {}) {
  if (round.mode !== 'live') return skip('not-live');
  if (round.published !== true) return skip('not-published');
  if (round.reviewed !== true || round.reportComplete !== true) return skip('report-incomplete');
  if (round.sourceComplete !== true) return skip('classification-truncated');
  if (!['full', 'incremental'].includes(round.scopeMode)) return skip('scope-not-eligible');
  if (!PUBLISHED_OUTCOMES.has(round.outcome)) return skip('outcome-not-eligible');
  if (['pending-budget', 'error'].includes(round.finalFullOutcome)) return skip('final-full-pending');
  if (!HEAD_RE.test(String(head ?? ''))) return skip('bad-head');
  if (!hasReviewer(reviewer, reviewerIdentity)) return skip('no-reviewer');
  const isReviewer = toReviewerMatcher(reviewer, reviewerIdentity);
  if (!RUN_URL_RE.test(String(runUrl ?? ''))) return skip('bad-run-url');
  if (threadsVerified !== true) return skip('threads-unverified');
  if (!Array.isArray(reviewedThreads) || !Array.isArray(liveThreads) || !Array.isArray(maintainers)) return skip('threads-unavailable');
  if (!Array.isArray(excludedKeys) || excludedKeys.some((k) => !KEY_RE.test(String(k)))) return skip('excluded-keys-invalid');

  // 排除集合 = 本轮报出/分类的 key + 全部 live thread 上维护者的裁定 key(逐条 collect,避开 20 条上限;不管 thread 是否已 resolve)。
  const excluded = new Set(excludedKeys);
  for (const thread of liveThreads) {
    for (const ruling of collectRulings({ threads: [thread], reviewer, reviewerIdentity, maintainers }).verified) if (ruling.key) excluded.add(ruling.key);
  }

  const reviewedById = new Map();
  for (const thread of reviewedThreads) if (thread?.id) reviewedById.set(thread.id, thread);
  const idCount = new Map();
  for (const thread of liveThreads) idCount.set(thread?.id, (idCount.get(thread?.id) ?? 0) + 1);

  const picked = [];
  for (const thread of liveThreads) {
    const id = thread?.id;
    if (!id || idCount.get(id) !== 1 || thread.isResolved !== false) continue;
    const comments = commentsOf(thread);
    const first = comments[0];
    if (!first?.id || !isReviewer(first.author)) continue;
    const marker = parseFindingMarker(first.body);
    if (!marker || !KEY_RE.test(marker.key)) continue;
    // marker 的 head 可能是 7–40 位前缀:当前 head 以它开头就是同一提交上发的,不算旧 thread。
    if (head.startsWith(lower(marker.head))) continue;
    if (excluded.has(marker.key)) continue;
    if (comments.some((c) => String(c?.body ?? '').includes(TRIAGE_MARKER))) continue;
    // 同一 key + 同一完整 head 审查身份已经回复过:不重复发。换了 head 重新复核,可以再发一条(盯梢要的是当前 head)。
    const fixedMarker = renderThreadFixedMarker({ key: marker.key, head });
    if (comments.some((c) => isReviewer(c?.author) && String(c?.body ?? '').includes(fixedMarker))) continue;
    // prepare 时必须见过这条 thread,且明确未 resolve、内容没变:模型没审过的东西不回复。
    const reviewed = reviewedById.get(id);
    if (!reviewed || reviewed.isResolved !== false || fingerprint(reviewed) !== fingerprint(thread)) continue;
    picked.push({ id, key: marker.key, oldHead: marker.head, reply: renderResolveReply({ head, runUrl, key: marker.key }) });
  }
  return { skippedReason: picked.length ? null : 'no-candidates', threads: picked };
}
