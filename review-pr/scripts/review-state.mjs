import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteJson } from './runtime-io.mjs';

export const REVIEW_STATE_VERSION = 1;

export function loadReviewState(file) {
  try {
    if (!existsSync(file)) return { version: REVIEW_STATE_VERSION, prs: {} };
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.version !== REVIEW_STATE_VERSION || !value.prs || typeof value.prs !== 'object') {
      return { version: REVIEW_STATE_VERSION, prs: {} };
    }
    return value;
  } catch {
    return { version: REVIEW_STATE_VERSION, prs: {} };
  }
}

export function normalizeReviewedEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const pr = Number(entry.pr ?? entry.number ?? entry.prNumber);
  const head = String(entry.head ?? entry.headRefOid ?? entry.reviewedHead ?? entry.expectedHead ?? '').trim().toLowerCase();
  if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[0-9a-f]{40,64}$/.test(head)) return null;
  // Explicit reviewed=true is required. A skipped / blocked / failed item must never advance the watermark.
  if (entry.reviewed !== true && entry.codeReview !== true) return null;
  return {
    pr,
    head,
    reviewedAt: String(entry.reviewedAt ?? entry.completedAt ?? new Date().toISOString()),
    outcome: String(entry.outcome ?? entry.status ?? 'reviewed'),
  };
}

export function applyReviewedEntries(state, entries = []) {
  const next = { version: REVIEW_STATE_VERSION, prs: { ...(state?.prs ?? {}) } };
  for (const entry of entries) {
    const normalized = normalizeReviewedEntry(entry);
    if (normalized) next.prs[String(normalized.pr)] = normalized;
  }
  return next;
}

export function reviewSelection(snapshot = [], state = { prs: {} }) {
  const reviewCandidates = [];
  const reviewedUnchanged = [];
  for (const pr of snapshot) {
    if (pr?.isDraft) continue;
    const saved = state.prs?.[String(pr.number)];
    if (saved?.head === String(pr.head ?? '').toLowerCase()) reviewedUnchanged.push(pr.number);
    else reviewCandidates.push(pr);
  }
  return { reviewCandidates, reviewedUnchanged };
}

export function saveReviewedState(file, state) {
  atomicWriteJson(file, state);
}
