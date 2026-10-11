#!/usr/bin/env node
// Stable, host-independent summary for the review-pr-auto Feishu card.
// The caller supplies explicit per-PR review/merge outcomes; this module only
// normalizes, validates, and renders them. It never reads GitHub or performs writes.

import { OUTCOMES } from './review-round.mjs';
import { formatLocalDisplay, formatLocalIso } from './local-time.mjs';
const MODES = new Set(['auto', 'review-only']);

const text = (value, fallback = '') => {
  const s = value == null ? '' : String(value).replace(/[\r\n]+/g, ' ').trim();
  return s || fallback;
};

function prNumber(item) {
  const n = Number(item?.pr ?? item?.number);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizePr(item, fallbackReason = '') {
  const pr = prNumber(item);
  if (pr == null) return null;
  return {
    pr,
    title: text(item?.title, ''),
    url: text(item?.url, ''),
    head: text(item?.head, text(item?.headRefOid, '')),
    reason: text(item?.reason, fallbackReason),
    stage: text(item?.stage, ''),
    method: text(item?.method, ''),
    ...(item?.outcome ? { outcome: text(item.outcome) } : {}),
    ...(item?.fixHandoff ? { fixHandoff: { status: text(item.fixHandoff.status),
      sessionId: text(item.fixHandoff.sessionId), reason: text(item.fixHandoff.reason) } } : {}),
  };
}

function normalizeList(list, fallbackReason = '') {
  if (!Array.isArray(list)) return [];
  const byPr = new Map();
  for (const item of list) {
    if (typeof item === 'string') continue;
    const normalized = normalizePr(item, fallbackReason);
    if (!normalized) continue;
    const previous = byPr.get(normalized.pr);
    byPr.set(normalized.pr, {
      ...previous,
      ...normalized,
      title: normalized.title || previous?.title || '',
      url: normalized.url || previous?.url || '',
      head: normalized.head || previous?.head || '',
      reason: normalized.reason || previous?.reason || fallbackReason,
      stage: normalized.stage || previous?.stage || '',
      method: normalized.method || previous?.method || '',
    });
  }
  return [...byPr.values()].sort((a, b) => a.pr - b.pr);
}

function firstArray(...values) {
  return values.find(Array.isArray) ?? [];
}

/**
 * Normalize the explicit run payload into the stable card data contract.
 * Preferred input shape:
 * {
 *   mode: 'auto'|'review-only',
 *   review: { eligibleCount, entered: [...], notEntered: [...] },
 *   merge: { merged: [...], notMerged: [...] }
 * }
 * Legacy processed/skipped/merged fields remain accepted as a compatibility fallback.
 */
export function buildReviewSummary(input = {}) {
  const mode = MODES.has(input.mode) ? input.mode : (input.reviewOnly ? 'review-only' : 'auto');
  const reviewInput = input.review && typeof input.review === 'object' ? input.review : {};
  const mergeInput = input.merge && typeof input.merge === 'object' ? input.merge : {};
  const scanInput = input.scan && typeof input.scan === 'object' ? input.scan : {};
  const processed = Array.isArray(input.processed) ? input.processed : [];

  const entered = normalizeList(firstArray(
    reviewInput.entered,
    input.enteredReview,
    processed.filter((item) => item?.enteredReview === true || item?.reviewEntered === true || item?.phase === 'review'),
  ));
  const explicitNotEntered = firstArray(
    reviewInput.notEntered,
    input.notEnteredReview,
    input.notEntered,
    processed.filter((item) => item?.enteredReview === false || item?.reviewEntered === false),
  );
  const unchanged = normalizeList(firstArray(
    reviewInput.unchanged,
    input.unchangedReviewPrs,
    scanInput.unchangedReviewPrs,
  ), '代码相对上次成功 review 未变化');
  const notEntered = normalizeList([...explicitNotEntered, ...unchanged], '本轮未进入 review');
  const merged = normalizeList(firstArray(
    mergeInput.merged,
    input.merged,
    processed.filter((item) => item?.merged === true),
  ));
  const notMerged = normalizeList(firstArray(
    mergeInput.notMerged,
    input.notMerged,
    processed.filter((item) => item?.merged === false),
  ), '本轮未合并');
  const candidateDiagnostics = scanInput.candidateDiagnostics ?? input.candidateDiagnostics;


  const inferredScope = input.reviewScopeCount
    ?? scanInput.totalOpenNonDraft
    ?? (Number(input.totalOpen) >= 0 ? Number(input.totalOpen) - (Number(input.draftSkipped) || 0) : undefined)
    ?? input.candidateCount;
  const eligibleCountRaw = reviewInput.eligibleCount ?? inferredScope;
  const eligibleCount = Number.isInteger(Number(eligibleCountRaw)) && Number(eligibleCountRaw) >= 0
    ? Number(eligibleCountRaw) : entered.length + notEntered.length;
  const enteredCount = entered.length;
  const notEnteredCount = notEntered.length;
  const reviewNumbers = [...entered, ...notEntered].map((p) => p.pr);
  const enteredNumbers = new Set(entered.map((p) => p.pr));
  const mergeNumbers = [...merged, ...notMerged].map((p) => p.pr);
  const coverageComplete = enteredCount + notEnteredCount === eligibleCount && new Set(reviewNumbers).size === eligibleCount;
  const mergeComplete = mergeNumbers.length === eligibleCount && new Set(mergeNumbers).size === eligibleCount &&
    mergeNumbers.every((pr) => reviewNumbers.includes(pr));
  const metric = (value, fallback, label) => {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error(`${label} 必须是非负整数`);
    return number;
  };
  const currentPrCount = metric(scanInput.totalOpen, eligibleCount + (Number(reviewInput.draftCount ?? input.draftSkipped) || 0), '当前 PR 数');
  const candidateCount = metric(scanInput.candidateCount ?? input.candidateCount, enteredCount, '本轮有变化数');
  const enteredNotMergedCount = enteredCount - merged.length;
  const validationErrors = [];
  if (!coverageComplete) validationErrors.push('审查记录有缺失或进入/跳过重叠');
  if (!mergeComplete) validationErrors.push('合并记录有缺失、重叠或范围不一致');
  if (merged.some((item) => !enteredNumbers.has(item.pr)) || enteredNotMergedCount < 0) {
    validationErrors.push('已合并 PR 必须来自进入 Review 的 PR');
  }
  if (Array.isArray(input.scope) && (input.scope.length !== eligibleCount || reviewNumbers.some((pr) => !input.scope.includes(pr)))) {
    validationErrors.push('结果超出冻结名单范围');
  }
  for (const [provided, actual, label] of [
    [reviewInput.enteredCount, enteredCount, 'enteredCount'], [reviewInput.notEnteredCount, notEnteredCount, 'notEnteredCount'],
    [mergeInput.mergedCount, merged.length, 'mergedCount'], [mergeInput.notMergedCount, notMerged.length, 'notMergedCount'],
  ]) if (provided !== undefined && provided !== actual) validationErrors.push(`${label} 与逐 PR 记录不一致`);
  if (input.strictCoverage && validationErrors.length) throw new Error(validationErrors.join('; '));

  const summary = {
    version: 1,
    runId: text(input.runId, ''),
    mode,
    generatedAt: text(input.generatedAt, formatLocalIso()),
    repo: text(input.repo, ''),
    coverageComplete: coverageComplete && mergeComplete && validationErrors.length === 0,
    validationErrors,
    metrics: { currentPrCount, candidateCount, enteredCount, mergedCount: merged.length, enteredNotMergedCount },
    ...(candidateDiagnostics && typeof candidateDiagnostics === 'object' ? { candidateDiagnostics } : {}),
    review: {
      eligibleCount,
      enteredCount,
      notEnteredCount,
      coverageComplete,
      entered,
      notEntered,
      unchangedCount: Number(reviewInput.unchangedCount ?? input.unchangedCount) || 0,
      draftCount: Number(reviewInput.draftCount ?? input.draftSkipped) || 0,
    },
    merge: {
      mergedCount: merged.length,
      notMergedCount: notMerged.length,
      merged,
      notMerged,
      notMergedGroups: Object.entries(OUTCOMES).filter(([key]) => key !== 'merged').map(([key, label]) => ({
        key, label, items: notMerged.filter((item) => (OUTCOMES[item.outcome] ? item.outcome : 'merge-blocked') === key),
      })).filter((group) => group.items.length),
    },
    policyViolations: mode === 'review-only' && merged.length
      ? [`review-only 模式出现 ${merged.length} 个合并记录`]
      : [],
    errors: normalizeList(firstArray(input.errors, input.failed), '本轮异常'),
    notes: (Array.isArray(input.notes) ? input.notes : []).map((note) => text(note)).filter(Boolean),
  };
  return summary;
}

const escapeMarkdown = (value) => text(value)
  .replaceAll('&', '&amp;')
  .replaceAll('[', '&#91;')
  .replaceAll(']', '&#93;');

function truncate(value, limit) {
  const chars = [...text(value)];
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`;
}

function mergedLabel(item, titleLimit = Infinity) {
  const title = escapeMarkdown(truncate(item.title || `PR #${item.pr}`, titleLimit));
  const label = `#${item.pr} · ${title}`;
  return item.url ? `[${label}](${item.url})` : label;
}

/** Render the concise human-readable body mirrored by the Feishu card. */
export function formatReviewCard(summary) {
  const s = summary?.version === 1 ? summary : buildReviewSummary(summary);
  const metrics = s.metrics;
  return [
    `PR Review 汇总 · ${s.mode} · ${formatLocalDisplay(s.generatedAt) || '时间未记录'}`,
    s.repo ? `仓库：${s.repo}` : null,
    '',
    `当前 PR：${metrics.currentPrCount}`,
    `本轮有变化：${metrics.candidateCount}`,
    `进入 Review：${metrics.enteredCount}`,
    `本轮已合并：${metrics.mergedCount}`,
    `本轮未合并：${metrics.enteredNotMergedCount}`,
    '',
    '### ✅ 本轮已合并 PR',
    ...(s.merge.merged.length ? s.merge.merged.map((item) => `- ${mergedLabel(item)}`) : ['本轮没有合并 PR']),
  ].filter((line) => line != null).join('\n');
}

function metricColumn(label, value) {
  return {
    tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top',
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: `**${value}**\n${label}` } }],
  };
}

function richCard(summary, titleLimit) {
  const metrics = summary.metrics;
  const merged = summary.merge.merged.length
    ? summary.merge.merged.map((item) => mergedLabel(item, titleLimit)).join('\n')
    : '本轮没有合并 PR';
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: 'PR Review 汇总' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${escapeMarkdown(summary.repo || '仓库未记录')}**  ·  ${escapeMarkdown(summary.mode)}  ·  ${escapeMarkdown(formatLocalDisplay(summary.generatedAt) || '时间未记录')}` } },
      { tag: 'column_set', flex_mode: 'none', columns: [
        metricColumn('当前 PR', metrics.currentPrCount),
        metricColumn('本轮有变化', metrics.candidateCount),
        metricColumn('进入 Review', metrics.enteredCount),
      ] },
      { tag: 'column_set', flex_mode: 'none', columns: [
        metricColumn('本轮已合并', metrics.mergedCount),
        metricColumn('本轮未合并', metrics.enteredNotMergedCount),
      ] },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '**✅ 本轮已合并 PR**' } },
      { tag: 'div', text: { tag: 'lark_md', content: merged } },
    ],
  };
}

// Always return one card. Under byte pressure, shorten titles but never drop a PR number or URL.
export function formatReviewCards(summary, maxBytes = 28_000) {
  const s = summary?.version === 1 ? summary : buildReviewSummary(summary);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('卡片字节上限必须是正整数');
  const size = (card) => Buffer.byteLength(JSON.stringify(card));
  const fullLimit = Math.max(1, ...s.merge.merged.map((item) => [...text(item.title || `PR #${item.pr}`)].length));
  let card = richCard(s, fullLimit);
  if (size(card) > maxBytes) {
    let low = 1;
    let high = fullLimit;
    let best = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = richCard(s, middle);
      if (size(candidate) <= maxBytes) { best = candidate; low = middle + 1; }
      else high = middle - 1;
    }
    if (!best) throw new Error('合并 PR 数量超过单张飞书卡片容量');
    card = best;
  }
  return [{ page: 1, total: 1, card }];
}

if (process.argv[1] && process.argv[1].endsWith('review-summary.mjs')) {
  try {
    const raw = await new Promise((resolve, reject) => {
      let value = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { value += chunk; });
      process.stdin.on('end', () => resolve(value));
      process.stdin.on('error', reject);
    });
    const input = JSON.parse(raw || '{}');
    const summary = buildReviewSummary(input);
    process.stdout.write(JSON.stringify({ ok: true, summary, markdown: formatReviewCard(summary), cards: formatReviewCards(summary) }) + '\n');
  } catch (error) {
    process.stderr.write(`[review-summary] ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
