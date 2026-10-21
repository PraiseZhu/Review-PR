// Allowlisted Git history for completed automatic review rounds.
// Runtime diffs, contexts, locks, reports, sessions, and Feishu receipts never cross this boundary.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillRepoCommitPush, skillRepoInfo } from './lib.mjs';
import { atomicWriteJson, atomicWriteText } from './runtime-io.mjs';
import { validateApprovalDisposition } from './approval-state.mjs';
import { FINGERPRINT_FIELDS } from './review-round.mjs';

export const REVIEW_HISTORY_REPO = 'makecindy/cindy';
const HISTORY_SLUG = 'makecindy-cindy';
const RUN_ID_RE = /^[a-zA-Z0-9-]+$/;
const MODES = new Set(['auto', 'review-only']);
const METRIC_KEYS = [
  'currentPrCount', 'candidateCount', 'enteredCount', 'mergedCount', 'enteredNotMergedCount',
];
const SUMMARY_PR_KEYS = ['pr', 'title', 'url', 'head', 'reason', 'stage', 'method', 'outcome'];
const STATE_ROW_KEYS = [
  'fingerprint', 'dependencyPrs', 'checkedAt', 'outcome', 'reason', 'reviewClean',
  'fingerprintFields', 'approval', 'fixHandoff', 'retry', 'retryAt', 'mergeRetryVersion', 'targetBranchNotice',
];
const DEFAULT_SKILL_ROOT = resolve(
  process.env.REVIEW_PR_SKILL_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'),
);

const plainObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const RUNTIME_LABEL_RE = /\b(agentId|sessionId|fixSessionId|messageId|lockToken|token|requestFile|sourceFile|reportFile|contextFile|diffFile|worktreePath|ownershipFile|commonDir|roundDir|summaryFile|markdownFile|cardsFile)(\s*[:=]\s*)(?:\[redacted\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi;
const LOCAL_PATH_RE = /(^|[\s=:(["'])(?:file:\/\/)?\/(?:Users|tmp|private\/(?:tmp|var\/folders)|var\/folders)\/[^\s,;)}\]]+/gi;

function projectText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(RUNTIME_LABEL_RE, '$1$2[redacted]')
    .replace(LOCAL_PATH_RE, '$1[redacted]');
}

export function isReviewHistoryEnabled(repo) {
  return repo === REVIEW_HISTORY_REPO;
}

function historyFiles(skillRoot = DEFAULT_SKILL_ROOT) {
  const directory = join(resolve(skillRoot), 'history', HISTORY_SLUG);
  return {
    directory,
    indexFile: join(directory, 'runs.jsonl'),
    stateFile: join(directory, 'round-state.json'),
  };
}

function projectFixHandoff(value, { summary = false } = {}) {
  if (!plainObject(value)) return value;
  const projected = {};
  for (const key of summary ? ['status', 'reason'] : ['status', 'fingerprint', 'reason']) {
    if (hasOwn(value, key)) projected[key] = projectText(value[key]);
  }
  return projected;
}

function projectSummaryPr(value) {
  if (!plainObject(value)) return value;
  const projected = {};
  for (const key of SUMMARY_PR_KEYS) {
    if (hasOwn(value, key)) projected[key] = key === 'pr' ? value[key] : projectText(value[key]);
  }
  if (hasOwn(value, 'fixHandoff')) projected.fixHandoff = projectFixHandoff(value.fixHandoff, { summary: true });
  return projected;
}

function projectSummaryList(value) {
  return Array.isArray(value) ? value.map(projectSummaryPr) : value;
}

function projectFingerprintFields(value, pr, { allowPartial = false } = {}) {
  if (!plainObject(value)) throw new Error(`round-state PR #${pr} fingerprintFields 无效`);
  const projected = {};
  for (const key of FINGERPRINT_FIELDS) {
    if (!hasOwn(value, key)) {
      if (!allowPartial) throw new Error(`round-state PR #${pr} fingerprintFields.${key} 缺失`);
      continue;
    }
    const field = value[key];
    if (key === 'unresolved') {
      if (!Number.isSafeInteger(field) || field < 0) {
        throw new Error(`round-state PR #${pr} fingerprintFields.unresolved 无效`);
      }
      projected[key] = field;
    } else if (key === 'dependencies') {
      if (!Array.isArray(field) || field.some((dependency) => !Array.isArray(dependency) || dependency.length !== 2 ||
          !Number.isSafeInteger(dependency[0]) || dependency[0] <= 0 ||
          (dependency[1] !== null && typeof dependency[1] !== 'string'))) {
        throw new Error(`round-state PR #${pr} fingerprintFields.dependencies 无效`);
      }
      projected[key] = field.map(([number, head]) => [number, projectText(head)]);
    } else if (field !== null && typeof field !== 'string') {
      throw new Error(`round-state PR #${pr} fingerprintFields.${key} 无效`);
    } else {
      projected[key] = projectText(field);
    }
  }
  for (const key of Object.keys(value)) {
    if (!FINGERPRINT_FIELDS.includes(key)) throw new Error(`round-state PR #${pr} fingerprintFields 含未知字段`);
  }
  return projected;
}

const CANDIDATE_DIAGNOSTIC_COUNT_KEYS = [
  'candidateCount', 'unchangedCount', 'draftCount', 'fingerprintChangedCount',
  'forcedRecheckCount', 'baselineMissingCount', 'baselinePartialCount',
  'unattributedFingerprintMismatchCount',
];

function projectCountMap(value, label) {
  if (!plainObject(value)) throw new Error(`${label} 无效`);
  return Object.fromEntries(Object.entries(value).map(([key, count]) => {
    if (!nonempty(key) || !Number.isSafeInteger(count) || count < 0) throw new Error(`${label} 无效`);
    return [projectText(key), count];
  }));
}

function projectCandidateDiagnostics(value) {
  if (value == null) return value;
  if (!plainObject(value)) throw new Error('历史 Summary candidateDiagnostics 无效');
  const projected = { version: value.version };
  for (const key of CANDIDATE_DIAGNOSTIC_COUNT_KEYS) projected[key] = value[key];
  projected.reasonCounts = projectCountMap(value.reasonCounts, '历史 Summary candidateDiagnostics.reasonCounts');
  projected.changedFieldCounts = projectCountMap(value.changedFieldCounts, '历史 Summary candidateDiagnostics.changedFieldCounts');
  if (!Array.isArray(value.rows)) throw new Error('历史 Summary candidateDiagnostics.rows 无效');
  projected.rows = value.rows.map((source, index) => {
    if (!plainObject(source)) throw new Error(`历史 Summary candidateDiagnostics.rows[${index}] 无效`);
    const row = {};
    for (const key of ['pr', 'reasonCodes', 'baseline', 'changedFields', 'previousFingerprint', 'fingerprint']) {
      if (hasOwn(source, key)) row[key] = key === 'previousFingerprint' || key === 'fingerprint'
        ? projectText(source[key]) : source[key];
    }
    if (hasOwn(source, 'before')) row.before = projectFingerprintFields(source.before, source.pr, { allowPartial: true });
    if (hasOwn(source, 'after')) row.after = projectFingerprintFields(source.after, source.pr, { allowPartial: true });
    return row;
  });
  return projected;
}

function projectSummary(summary) {
  const review = plainObject(summary?.review) ? summary.review : {};
  const merge = plainObject(summary?.merge) ? summary.merge : {};
  const projected = {
    version: summary?.version,
    runId: summary?.runId,
    mode: summary?.mode,
    generatedAt: summary?.generatedAt,
    repo: summary?.repo,
    coverageComplete: summary?.coverageComplete,
    validationErrors: Array.isArray(summary?.validationErrors) ? summary.validationErrors.map(projectText) : summary?.validationErrors,
    metrics: Object.fromEntries(METRIC_KEYS.map((key) => [key, summary?.metrics?.[key]])),
    review: {
      eligibleCount: review.eligibleCount,
      enteredCount: review.enteredCount,
      notEnteredCount: review.notEnteredCount,
      coverageComplete: review.coverageComplete,
      entered: projectSummaryList(review.entered),
      notEntered: projectSummaryList(review.notEntered),
      unchangedCount: review.unchangedCount,
      draftCount: review.draftCount,
    },
    merge: {
      mergedCount: merge.mergedCount,
      notMergedCount: merge.notMergedCount,
      merged: projectSummaryList(merge.merged),
      notMerged: projectSummaryList(merge.notMerged),
      notMergedGroups: Array.isArray(merge.notMergedGroups) ? merge.notMergedGroups.map((group) => ({
        key: group?.key,
        label: group?.label,
        items: projectSummaryList(group?.items),
      })) : merge.notMergedGroups,
    },
    policyViolations: Array.isArray(summary?.policyViolations) ? summary.policyViolations.map(projectText) : summary?.policyViolations,
    errors: projectSummaryList(summary?.errors),
    notes: Array.isArray(summary?.notes) ? summary.notes.map(projectText) : summary?.notes,
  };
  if (hasOwn(summary ?? {}, 'candidateDiagnostics')) {
    projected.candidateDiagnostics = projectCandidateDiagnostics(summary.candidateDiagnostics);
  }
  return projected;
}

function validateStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label} 无效`);
}

function validateSummaryPr(value, label) {
  if (!plainObject(value) || !Number.isSafeInteger(value.pr) || value.pr <= 0) throw new Error(`${label} PR 结构无效`);
  for (const key of SUMMARY_PR_KEYS.filter((key) => key !== 'pr')) {
    if (hasOwn(value, key) && typeof value[key] !== 'string') throw new Error(`${label} PR.${key} 无效`);
  }
  if (hasOwn(value, 'fixHandoff')) {
    const handoff = value.fixHandoff;
    if (!plainObject(handoff) || !nonempty(handoff.status) || typeof handoff.reason !== 'string') {
      throw new Error(`${label} fixHandoff 无效`);
    }
  }
}

function validateSummaryList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} 无效`);
  value.forEach((item) => validateSummaryPr(item, label));
}

function validateCountMap(value, label) {
  if (!plainObject(value) || Object.entries(value).some(([key, count]) =>
      !nonempty(key) || !Number.isSafeInteger(count) || count < 0)) throw new Error(`${label} 无效`);
}

function validateCandidateDiagnostics(value) {
  if (value == null) return;
  if (!plainObject(value) || value.version !== 1) throw new Error('历史 Summary candidateDiagnostics 版本无效');
  for (const key of CANDIDATE_DIAGNOSTIC_COUNT_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`历史 Summary candidateDiagnostics.${key} 无效`);
    }
  }
  validateCountMap(value.reasonCounts, '历史 Summary candidateDiagnostics.reasonCounts');
  validateCountMap(value.changedFieldCounts, '历史 Summary candidateDiagnostics.changedFieldCounts');
  if (Object.keys(value.changedFieldCounts).some((key) => !FINGERPRINT_FIELDS.includes(key))) {
    throw new Error('历史 Summary candidateDiagnostics.changedFieldCounts 含未知字段');
  }
  if (!Array.isArray(value.rows) || value.candidateCount !== value.rows.length) {
    throw new Error('历史 Summary candidateDiagnostics.rows 数量无效');
  }
  const seen = new Set();
  value.rows.forEach((row, index) => {
    const label = `历史 Summary candidateDiagnostics.rows[${index}]`;
    if (!plainObject(row) || !Number.isSafeInteger(row.pr) || row.pr <= 0 || seen.has(row.pr)) {
      throw new Error(`${label} PR 无效`);
    }
    seen.add(row.pr);
    validateStringArray(row.reasonCodes, `${label}.reasonCodes`);
    if (!['missing', 'partial', 'available'].includes(row.baseline)) throw new Error(`${label}.baseline 无效`);
    validateStringArray(row.changedFields, `${label}.changedFields`);
    if (row.changedFields.some((field) => !FINGERPRINT_FIELDS.includes(field))) {
      throw new Error(`${label}.changedFields 含未知字段`);
    }
    if (hasOwn(row, 'previousFingerprint') && row.previousFingerprint !== null && typeof row.previousFingerprint !== 'string') {
      throw new Error(`${label}.previousFingerprint 无效`);
    }
    if (hasOwn(row, 'fingerprint') && typeof row.fingerprint !== 'string') throw new Error(`${label}.fingerprint 无效`);
    for (const key of ['before', 'after']) {
      if (hasOwn(row, key)) projectFingerprintFields(row[key], row.pr, { allowPartial: true });
    }
  });
}

function validateSummary(repo, summary) {
  if (!plainObject(summary) || summary.version !== 1) throw new Error('历史 Summary 版本无效');
  if (summary.repo !== repo) throw new Error('历史 Summary 仓库不匹配');
  if (!RUN_ID_RE.test(summary.runId ?? '')) throw new Error('历史 Summary runId 无效');
  if (!MODES.has(summary.mode)) throw new Error('历史 Summary 模式无效');
  if (!validDate(summary.generatedAt)) throw new Error('历史 Summary 时间无效');
  if (typeof summary.coverageComplete !== 'boolean') throw new Error('历史 Summary 覆盖状态无效');
  validateStringArray(summary.validationErrors, '历史 Summary validationErrors');
  validateStringArray(summary.policyViolations, '历史 Summary policyViolations');
  validateStringArray(summary.notes, '历史 Summary notes');
  const metrics = summary.metrics;
  if (!plainObject(metrics) || METRIC_KEYS.some((key) => !Number.isInteger(metrics[key]) || metrics[key] < 0)) {
    throw new Error('历史 Summary 指标无效');
  }
  if (metrics.enteredCount !== metrics.mergedCount + metrics.enteredNotMergedCount) {
    throw new Error('历史 Summary 的 Review/合并指标不守恒');
  }
  const review = summary.review;
  const merge = summary.merge;
  if (!plainObject(review) || !plainObject(merge) || typeof review.coverageComplete !== 'boolean') {
    throw new Error('历史 Summary 明细结构无效');
  }
  for (const [value, label] of [
    [review.eligibleCount, 'eligibleCount'], [review.enteredCount, 'enteredCount'],
    [review.notEnteredCount, 'notEnteredCount'], [review.unchangedCount, 'unchangedCount'],
    [review.draftCount, 'draftCount'], [merge.mergedCount, 'mergedCount'], [merge.notMergedCount, 'notMergedCount'],
  ]) if (!Number.isInteger(value) || value < 0) throw new Error(`历史 Summary ${label} 无效`);
  validateSummaryList(review.entered, '历史 Summary entered');
  validateSummaryList(review.notEntered, '历史 Summary notEntered');
  validateSummaryList(merge.merged, '历史 Summary merged');
  validateSummaryList(merge.notMerged, '历史 Summary notMerged');
  validateSummaryList(summary.errors, '历史 Summary errors');
  validateCandidateDiagnostics(summary.candidateDiagnostics);
  if (!Array.isArray(merge.notMergedGroups)) throw new Error('历史 Summary notMergedGroups 无效');
  for (const group of merge.notMergedGroups) {
    if (!plainObject(group) || typeof group.key !== 'string' || typeof group.label !== 'string') {
      throw new Error('历史 Summary notMergedGroups 结构无效');
    }
    validateSummaryList(group.items, '历史 Summary notMergedGroups.items');
  }
}

function projectApproval(value) {
  if (!plainObject(value)) return value;
  const projected = {};
  for (const key of ['status', 'reviewId', 'reviewer', 'head', 'reviewHead', 'source', 'verifiedAt', 'url', 'reason', 'code', 'author', 'authorityDigest', 'teamHandle']) {
    if (hasOwn(value, key)) projected[key] = projectText(value[key]);
  }
  return projected;
}

function validateApproval(value, pr) {
  try { validateApprovalDisposition(value); } catch { throw new Error(`round-state PR #${pr} approval 回执或阻塞状态无效`); }
  if (!plainObject(value) || !['verified', 'blocked', 'pending', 'exempt'].includes(value.status)) {
    throw new Error(`round-state PR #${pr} approval 无效`);
  }
  if (value.status === 'exempt') {
    if (hasOwn(value, 'reviewId') || !nonempty(value.author) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value.head ?? '') ||
        !/^sha256:[0-9a-f]{64}$/i.test(value.authorityDigest ?? '') || !nonempty(value.source) || !nonempty(value.reason)) {
      throw new Error(`round-state PR #${pr} 免审批回执无效`);
    }
  } else if (value.status === 'verified') {
    const reviewId = (typeof value.reviewId === 'string' && /^[1-9]\d*$/.test(value.reviewId)) ||
      (Number.isSafeInteger(value.reviewId) && value.reviewId > 0);
    if (!reviewId || !nonempty(value.reviewer) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value.head ?? '') ||
        !validDate(value.verifiedAt) || (hasOwn(value, 'url') && typeof value.url !== 'string')) {
      throw new Error(`round-state PR #${pr} approval 回执无效`);
    }
  } else if (!nonempty(value.reason) || (hasOwn(value, 'code') && !nonempty(value.code))) {
    throw new Error(`round-state PR #${pr} approval 阻塞原因无效`);
  }
}

function projectRoundState(state, mode) {
  if (!plainObject(state) || state.version !== 1 || state.mode !== mode || !plainObject(state.prs)) {
    throw new Error('round-state 版本、模式或结构无效');
  }
  const prs = {};
  for (const [pr, source] of Object.entries(state.prs)) {
    if (!/^\d+$/.test(pr) || !plainObject(source)) throw new Error(`round-state PR #${pr} 结构无效`);
    const row = {};
    for (const key of STATE_ROW_KEYS) {
      if (!hasOwn(source, key)) continue;
      if (key === 'approval') row.approval = projectApproval(source.approval);
      else if (key === 'fixHandoff') row.fixHandoff = projectFixHandoff(source.fixHandoff);
      else if (key === 'fingerprintFields') row.fingerprintFields = projectFingerprintFields(source.fingerprintFields, pr);
      else if (key === 'targetBranchNotice') {
        const notice = source.targetBranchNotice;
        if (!plainObject(notice) || !['posted', 'deduplicated', 'failed', 'not-needed'].includes(notice.status)) {
          throw new Error(`round-state PR #${pr} 目标分支提醒无效`);
        }
        row.targetBranchNotice = Object.fromEntries(['status', 'head', 'baseRefName', 'defaultBranch', 'fingerprint', 'reason']
          .filter((field) => hasOwn(notice, field)).map((field) => [field, projectText(notice[field])]));
        if (Object.values(row.targetBranchNotice).some((value) => typeof value !== 'string')) {
          throw new Error(`round-state PR #${pr} 目标分支提醒字段无效`);
        }
        if (notice.status !== 'not-needed' && (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(notice.head ?? '') ||
            !nonempty(notice.baseRefName) || !nonempty(notice.defaultBranch) ||
            (notice.status === 'failed' ? !nonempty(notice.reason) : !/^[0-9a-f]{64}$/.test(notice.fingerprint ?? '')))) {
          throw new Error(`round-state PR #${pr} 目标分支提醒证据无效`);
        }
      }
      else if (key === 'dependencyPrs' && Array.isArray(source.dependencyPrs)) row.dependencyPrs = [...source.dependencyPrs];
      else row[key] = typeof source[key] === 'string' ? projectText(source[key]) : source[key];
    }
    if (!nonempty(row.fingerprint) || !nonempty(row.outcome) || !nonempty(row.reason) ||
        (hasOwn(row, 'checkedAt') && !validDate(row.checkedAt)) ||
        (hasOwn(row, 'retryAt') && row.retryAt != null && !validDate(row.retryAt)) ||
        (hasOwn(row, 'retry') && typeof row.retry !== 'boolean') ||
        (hasOwn(row, 'mergeRetryVersion') && (!Number.isSafeInteger(row.mergeRetryVersion) || row.mergeRetryVersion < 1)) ||
        (hasOwn(row, 'reviewClean') && typeof row.reviewClean !== 'boolean') ||
        (hasOwn(row, 'dependencyPrs') && (!Array.isArray(row.dependencyPrs) ||
          row.dependencyPrs.some((item) => !Number.isSafeInteger(item) || item <= 0)))) {
      throw new Error(`round-state PR #${pr} 结构无效`);
    }
    if (hasOwn(row, 'approval')) validateApproval(row.approval, pr);
    if (hasOwn(row, 'fixHandoff') && (!plainObject(row.fixHandoff) || !nonempty(row.fixHandoff.status) ||
        !nonempty(row.fixHandoff.fingerprint) || !nonempty(row.fixHandoff.reason))) {
      throw new Error(`round-state PR #${pr} fixHandoff 无效`);
    }
    prs[pr] = row;
  }
  return { version: 1, mode, prs };
}

function projectIndexRow(value) {
  if (!plainObject(value)) return value;
  return {
    runId: value.runId,
    generatedAt: value.generatedAt,
    mode: value.mode,
    currentPrCount: value.currentPrCount,
    candidateCount: value.candidateCount,
    enteredCount: value.enteredCount,
    mergedCount: value.mergedCount,
    enteredNotMergedCount: value.enteredNotMergedCount,
    summary: value.summary,
  };
}

function validateIndexRow(value, index) {
  if (!plainObject(value) || !RUN_ID_RE.test(value.runId ?? '') || !validDate(value.generatedAt) ||
      !MODES.has(value.mode) || METRIC_KEYS.some((key) => !Number.isInteger(value[key]) || value[key] < 0) ||
      value.enteredCount !== value.mergedCount + value.enteredNotMergedCount ||
      value.summary !== `runs/${value.runId}/summary.json`) {
    throw new Error(`历史索引第 ${index + 1} 行无效`);
  }
}

function readIndex(file) {
  if (!existsSync(file)) return [];
  const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  return rows.map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch { throw new Error(`历史索引第 ${index + 1} 行损坏`); }
    const projected = projectIndexRow(value);
    validateIndexRow(projected, index);
    return projected;
  });
}

function indexRow(summary) {
  return {
    runId: summary.runId,
    generatedAt: summary.generatedAt,
    mode: summary.mode,
    currentPrCount: summary.metrics.currentPrCount,
    candidateCount: summary.metrics.candidateCount,
    enteredCount: summary.metrics.enteredCount,
    mergedCount: summary.metrics.mergedCount,
    enteredNotMergedCount: summary.metrics.enteredNotMergedCount,
    summary: `runs/${summary.runId}/summary.json`,
  };
}

export function preflightReviewHistoryPublication({ skillRoot = DEFAULT_SKILL_ROOT } = {}) {
  const info = skillRepoInfo({ skillRoot: resolve(skillRoot) });
  if (!info) return { ok: false, step: 'preflight', error: 'skill 不在 Git 仓库中' };
  if (!info.branch || info.branch === 'HEAD') return { ok: false, step: 'preflight', error: 'skill Git 处于 detached HEAD' };
  if (info.branch !== info.defaultBranch) {
    return { ok: false, step: 'preflight', branch: info.branch, defaultBranch: info.defaultBranch,
      error: `skill Git 不在默认分支 ${info.defaultBranch}` };
  }
  return { ok: true, branch: info.branch, defaultBranch: info.defaultBranch };
}

export function publishReviewHistory(options = {}) {
  const {
    repo, summary, roundState, skillRoot = DEFAULT_SKILL_ROOT, sync = skillRepoCommitPush,
    preflight = sync === skillRepoCommitPush ? preflightReviewHistoryPublication : () => ({ ok: true }),
  } = options;
  if (!isReviewHistoryEnabled(repo)) return { ok: true, enabled: false, skipped: 'repo-not-allowlisted' };
  const safeSummary = projectSummary(summary);
  validateSummary(repo, safeSummary);
  const safeState = projectRoundState(roundState, safeSummary.mode);
  const preflightResult = preflight({ skillRoot: resolve(skillRoot) });
  if (preflightResult?.ok !== true) {
    return { ok: false, enabled: true, runId: safeSummary.runId, preflight: preflightResult,
      error: preflightResult?.error || 'Git 历史发布前置检查失败' };
  }

  const files = historyFiles(skillRoot);
  const runDirectory = join(files.directory, 'runs', safeSummary.runId);
  const summaryFile = join(runDirectory, 'summary.json');
  const summaryData = canonicalJson(safeSummary);
  if (existsSync(summaryFile)) {
    if (readFileSync(summaryFile, 'utf8') !== summaryData) throw new Error(`run ${safeSummary.runId} 的历史 Summary 冲突`);
  } else atomicWriteText(summaryFile, summaryData);

  const desiredIndex = indexRow(safeSummary);
  const index = readIndex(files.indexFile);
  const existing = index.find((row) => row.runId === safeSummary.runId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(desiredIndex)) {
    throw new Error(`run ${safeSummary.runId} 的历史索引冲突`);
  }
  const envelope = {
    version: 1,
    repo,
    mode: safeSummary.mode,
    updatedAt: safeSummary.generatedAt,
    runId: safeSummary.runId,
    state: safeState,
  };
  if (existing && existsSync(files.stateFile)) {
    const currentEnvelope = canonicalJson(JSON.parse(readFileSync(files.stateFile, 'utf8')));
    if (currentEnvelope !== canonicalJson(envelope)) {
      throw new Error(`run ${safeSummary.runId} 的历史 round-state 冲突`);
    }
  }
  if (!existing) index.push(desiredIndex);
  atomicWriteText(files.indexFile, index.map((row) => JSON.stringify(row)).join('\n') + '\n');
  atomicWriteJson(files.stateFile, envelope);

  const syncResult = sync({
    skillRoot: resolve(skillRoot),
    paths: [`history/${HISTORY_SLUG}`],
    message: `review: archive ${repo} round ${safeSummary.runId}`,
  });
  const synced = syncResult?.ok === true && (syncResult.pushed === true || syncResult.reason === 'nothing-to-push');
  return {
    ok: synced,
    enabled: true,
    runId: safeSummary.runId,
    summaryFile,
    stateFile: files.stateFile,
    indexFile: files.indexFile,
    preflight: preflightResult,
    sync: syncResult,
    ...(synced ? {} : { error: syncResult?.error || syncResult?.skipped || '历史提交未推送到默认分支' }),
  };
}

export function restoreReviewHistoryState({
  repo, mode, localStateFile, skillRoot = DEFAULT_SKILL_ROOT,
} = {}) {
  if (existsSync(localStateFile)) return { restored: false, source: 'local' };
  if (!isReviewHistoryEnabled(repo)) return { restored: false, source: 'none', reason: 'repo-not-allowlisted' };
  const file = historyFiles(skillRoot).stateFile;
  if (!existsSync(file)) return { restored: false, source: 'none', reason: 'history-not-found' };
  let envelope;
  let safeState;
  try {
    envelope = JSON.parse(readFileSync(file, 'utf8'));
    if (!plainObject(envelope) || envelope.version !== 1 || envelope.repo !== repo || envelope.mode !== mode ||
        !RUN_ID_RE.test(envelope.runId ?? '') || !validDate(envelope.updatedAt)) throw new Error('历史状态信封无效');
    safeState = projectRoundState(envelope.state, mode);
  } catch (error) {
    return { restored: false, source: 'none', reason: `history-invalid: ${error.message}` };
  }
  atomicWriteJson(localStateFile, safeState);
  return { restored: true, source: 'git-history', runId: envelope.runId };
}
