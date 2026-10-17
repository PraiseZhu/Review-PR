// Pure contracts for preflight -> frozen batches -> complete per-PR results.
import { createHash, randomUUID } from 'node:crypto';
import { validateApprovalDisposition } from './approval-state.mjs';
import { MERGE_RETRY_VERSION, legacyMergeRetryDue } from './merge-retry.mjs';
import { formatLocalIso } from './local-time.mjs';
import { evaluateFixDispatch, FIX_WATCHDOG_MS } from './fix-session-state.mjs';
import { writeSecond, selfWriteChainMatches } from './self-write-receipts.mjs';
export { explicitDependencies } from './review-dependencies.mjs';
export { FIX_WATCHDOG_MS };

export const GROUP_SIZE = 10;
export const OUTCOMES = {
  merged: '已合并', 'maintainer-signoff': '等待维护者确认', 'threads-unresolved': '存在未解决 thread',
  findings: '审查发现问题', security: '凭证或隐私问题', format: 'PR 格式问题',
  dependency: '等待依赖 PR 合并', retarget: '等待调整 base 分支',
  'ci-failed': 'CI 失败', 'ci-pending': '等待 CI', 'ci-unknown': 'CI 状态不完整',
  'bot-pending': '等待 bot 审查完成', 'changes-requested': '等待作者处理其他审查意见',
  conflict: '存在合并冲突', rebase: '需要 rebase', protected: '受保护路径需人工处理',
  approval: '等待另一位维护者 Approve', 'merge-blocked': '合并条件未满足',
  'approval-pending': 'Approve 尚待确认，将继续补齐',
  'merge-queued': '已进入合并队列，尚未合并', 'review-only': '仅审核模式',
  unchanged: '自上轮处理后状态未变化', 'state-changed': '本轮期间 PR 状态已变化', error: '执行异常',
};
// Thread 卡点沿用 skip-gate，避免 findings→threads-unresolved 换路由后重复投递。
// CI 失败和冲突必须分开；冲突再带当时的 base，main 往前走时能重新投递。
const SELF_FIX_CAUSES = {
  security: 'pushback-security', format: 'pushback-format', findings: 'review-failed',
  'threads-unresolved': 'skip-gate', 'ci-failed': 'skip-ci-failed', conflict: 'skip-conflict',
  rebase: 'skip-stale-rebase', 'changes-requested': 'skip-stale-pushback',
};
const LATE_FIX_CAUSES = new Set(['threads-unresolved', 'ci-failed', 'conflict', 'rebase', 'changes-requested']);
const COMPLETE_REBASE_NOTICE_STATUSES = new Set(['posted', 'deduplicated', 'suppressed']);
const COMPLETE_PROTECTED_NOTICE_STATUSES = new Set(['posted', 'deduplicated', 'suppressed']);

function rebaseNoticeDue(previous) {
  return previous?.outcome === 'rebase' && !COMPLETE_REBASE_NOTICE_STATUSES.has(previous?.authorNotice?.status);
}

function protectedNoticeDue(previous) {
  return previous?.outcome === 'protected' &&
    !COMPLETE_PROTECTED_NOTICE_STATUSES.has(previous?.authorNotice?.status);
}

export function needsTargetBranchNotice(item) {
  return item.outcome === 'retarget' || (item.outcome === 'dependency' &&
    Boolean(item.basePr && item.baseRefName && item.defaultBranch && item.baseRefName !== item.defaultBranch));
}

function targetBranchNoticeDue(previous) {
  if (!['dependency', 'retarget'].includes(previous?.outcome)) return false;
  const status = previous.targetBranchNotice?.status;
  return !['posted', 'deduplicated'].includes(status) && !(previous.outcome === 'dependency' && status === 'not-needed');
}

export function validateTargetBranchNotice(item) {
  if (!needsTargetBranchNotice(item)) return;
  const notice = item.targetBranchNotice;
  if (!item.baseRefName || !item.defaultBranch || notice?.head !== item.head ||
      notice.baseRefName !== item.baseRefName || notice.defaultBranch !== item.defaultBranch ||
      !['posted', 'deduplicated', 'failed'].includes(notice.status)) {
    throw new Error(`PR #${item.pr} 的目标分支作者提醒尚无有效终态`);
  }
  if (['posted', 'deduplicated'].includes(notice.status) && !/^[0-9a-f]{64}$/.test(notice.fingerprint ?? '')) {
    throw new Error(`PR #${item.pr} 的目标分支提醒缺少去重指纹`);
  }
  if (notice.status === 'failed' && (item.retry !== true || !String(notice.reason ?? '').trim())) {
    throw new Error(`PR #${item.pr} 的目标分支提醒失败后必须记录原因并在下轮重试`);
  }
}

function validateRebaseAuthorNotice(result, item) {
  const rebaseBlocked = result.outcome === 'rebase' ||
    (result.outcome === 'merge-blocked' && result.fixCause === 'rebase');
  if (!rebaseBlocked) {
    if (result.authorNotice?.kind === 'stale-rebase') throw new Error(`PR #${item.pr} 非 rebase 卡点却记录了作者 rebase 提醒`);
    return;
  }
  const notice = result.authorNotice;
  if (notice?.kind !== 'stale-rebase' || notice.head !== item.head ||
      !['posted', 'deduplicated', 'suppressed', 'failed'].includes(notice.status)) {
    throw new Error(`PR #${item.pr} 的 stale-rebase 作者提醒尚无有效终态`);
  }
  if (notice.status === 'suppressed' && item.selfFix !== true) {
    throw new Error(`PR #${item.pr} 不是自有 PR，不能跳过 stale-rebase 作者提醒`);
  }
  if (notice.status !== 'suppressed' && item.selfFix === true) {
    throw new Error(`PR #${item.pr} 是自有 PR，stale-rebase 应交修复 session，不应催作者本人`);
  }
  if (['posted', 'deduplicated'].includes(notice.status) && !/^[0-9a-f]{64}$/i.test(notice.fingerprint ?? '')) {
    throw new Error(`PR #${item.pr} 的 stale-rebase 作者提醒缺少去重指纹`);
  }
  if (notice.status === 'failed' && (result.retry !== true || !String(notice.reason ?? '').trim())) {
    throw new Error(`PR #${item.pr} 的 stale-rebase 提醒失败后必须记录原因并在下轮重试`);
  }
}

function validateProtectedPathAuthorNotice(result, item) {
  if (result.outcome !== 'protected') {
    if (result.authorNotice?.kind === 'protected-path') throw new Error(`PR #${item.pr} 非受保护路径卡点却记录了受保护路径提醒`);
    return;
  }
  const notice = result.authorNotice;
  if (notice?.kind !== 'protected-path' || notice.head !== item.head ||
      !['posted', 'deduplicated', 'suppressed', 'failed'].includes(notice.status)) {
    throw new Error(`PR #${item.pr} 的受保护路径作者提醒尚无有效终态`);
  }
  if (notice.status === 'suppressed' && item.selfFix !== true) {
    throw new Error(`PR #${item.pr} 不是自有 PR，不能跳过受保护路径作者提醒`);
  }
  if (notice.status !== 'suppressed' && item.selfFix === true) {
    throw new Error(`PR #${item.pr} 是自有 PR，受保护路径应记录 suppressed 提醒`);
  }
  if (['posted', 'deduplicated'].includes(notice.status) && !String(notice.fingerprint ?? '').trim()) {
    throw new Error(`PR #${item.pr} 的受保护路径作者提醒缺少去重指纹`);
  }
  if (notice.status === 'failed' && (result.retry !== true || !String(notice.reason ?? '').trim())) {
    throw new Error(`PR #${item.pr} 的受保护路径提醒失败后必须记录原因并在下轮重试`);
  }
}
function selfFixFingerprint(cause, head, base) {
  const token = SELF_FIX_CAUSES[cause];
  if (!token) return null;
  if (token === 'skip-conflict' && base) return `${head}|${token}|${base}`;
  return `${head}|${token}`;
}

export function createFixHandoffRequest({ mode, selfFix, head, outcome, merged = false, fixCause, fixEvidence, base }) {
  if (mode !== 'auto' || selfFix !== true || merged) return null;
  let cause = outcome;
  if (fixCause !== undefined) {
    if (outcome !== 'merge-blocked' || !LATE_FIX_CAUSES.has(fixCause)) throw new Error('无效的合并前作者侧卡点');
    if (fixEvidence?.head !== head || !String(fixEvidence?.sourceFile ?? '').trim() || !String(fixEvidence?.reason ?? '').trim()) {
      throw new Error('合并前作者侧卡点缺少同 head 的实际检查证据');
    }
    cause = fixCause;
  }
  const fingerprint = selfFixFingerprint(cause, head, base);
  if (!fingerprint) return null;
  return { status: 'requested', fingerprint };
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byAge = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.number - b.number;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

// Keep the material that drives candidate selection explicit.  The hash alone
// is enough to select work, but it is not enough to explain a large wake-up in
// a later round.  Persisting this small, public PR-state object lets history
// say which observable field changed (CI, mergeability, updatedAt, etc.).
export const FINGERPRINT_FIELDS = Object.freeze([
  'head', 'base', 'reviewDecision', 'unresolved', 'mergeable',
  'mergeStateStatus', 'ci', 'updatedAt', 'dependencies',
]);

export function fingerprintMaterial(pr, snapshot, dependencyPrs = []) {
  const dependencies = (snapshot ?? []).filter((p) => dependencyPrs.includes(p.number))
    .map((p) => [p.number, p.head]).sort((a, b) => a[0] - b[0]);
  return {
    head: pr.head ?? null,
    base: pr.base ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    unresolved: pr.unresolved ?? 0,
    mergeable: pr.mergeable ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    ci: pr.ci ?? null,
    updatedAt: pr.updatedAt ?? null,
    dependencies,
  };
}

const TRANSIENT_FINGERPRINT_FIELDS = Object.freeze(['mergeable', 'mergeStateStatus']);
const STABLE_FINGERPRINT_VALUES = Object.freeze({
  mergeable: Object.freeze([null, 'MERGEABLE', 'CONFLICTING']),
  mergeStateStatus: Object.freeze([null, 'BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE']),
});

function fingerprintFromMaterial(pr, material) {
  return hash({ pr: pr.number ?? pr, ...material });
}

function transientPreviousMaterials(material) {
  const values = TRANSIENT_FINGERPRINT_FIELDS.map((field) => {
    const current = material[field];
    // A current UNKNOWN may have replaced any prior stable value.  A current
    // stable value may only have replaced UNKNOWN; never equate two different
    // stable states, because that is a real mergeability change.
    return current === 'UNKNOWN'
      ? [...new Set(['UNKNOWN', ...STABLE_FINGERPRINT_VALUES[field]])]
      : [current, 'UNKNOWN'];
  });
  const rows = [];
  for (const mergeable of values[0]) {
    for (const mergeStateStatus of values[1]) rows.push({ ...material, mergeable, mergeStateStatus });
  }
  return rows;
}

function observeCandidateFingerprint(pr, snapshot, previous, dependencyPrs = []) {
  const rawMaterial = fingerprintMaterial(pr, snapshot, dependencyPrs);
  const rawFingerprint = fingerprintFromMaterial(pr, rawMaterial);
  if (!previous?.fingerprint || rawFingerprint === previous.fingerprint) {
    return { material: rawMaterial, fingerprint: rawFingerprint, equivalentToPrevious: Boolean(previous) };
  }

  // GitHub invalidates mergeability caches after base movement and may return
  // UNKNOWN on the first broad query, then the original stable value on the
  // next query.  Match the previous hash while varying only UNKNOWN edges so
  // legacy states without fingerprintFields are protected too.
  const previousMaterial = transientPreviousMaterials(rawMaterial)
    .find((material) => fingerprintFromMaterial(pr, material) === previous.fingerprint);
  if (previousMaterial) {
    const material = { ...rawMaterial };
    for (const field of TRANSIENT_FINGERPRINT_FIELDS) {
      if (rawMaterial[field] === 'UNKNOWN' && previousMaterial[field] !== 'UNKNOWN') {
        material[field] = previousMaterial[field];
      }
    }
    return { material, fingerprint: fingerprintFromMaterial(pr, material), equivalentToPrevious: true };
  }

  // If another observable field really changed while GitHub is transiently
  // UNKNOWN, keep that real wake-up but do not persist UNKNOWN over a known
  // stable baseline and cause a second, meaningless round later.
  const material = { ...rawMaterial };
  for (const field of TRANSIENT_FINGERPRINT_FIELDS) {
    const baseline = previous.fingerprintFields?.[field];
    if (rawMaterial[field] === 'UNKNOWN' && baseline !== undefined && baseline !== 'UNKNOWN') material[field] = baseline;
  }
  return { material, fingerprint: fingerprintFromMaterial(pr, material), equivalentToPrevious: onlyOwnWritesBumpedUpdatedAt(previous, material) };
}

function onlyOwnWritesBumpedUpdatedAt(previous, material) {
  const fields = previous.fingerprintFields;
  const updatedAt = writeSecond(material.updatedAt);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || updatedAt === null) return false;
  const { baseline, changedFields } = fingerprintMaterialDiff(fields, material);
  return baseline === 'available' && changedFields.length === 1 && changedFields[0] === 'updatedAt' &&
    selfWriteChainMatches(previous.selfWriteReceipts, fields.updatedAt, material.updatedAt, material.head);
}

export function fingerprintMaterialDiff(previous, current) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    return { baseline: 'missing', changedFields: [] };
  }
  const changedFields = FINGERPRINT_FIELDS.filter((field) => !hasOwn(previous, field) ||
    JSON.stringify(previous[field]) !== JSON.stringify(current[field]));
  const missingFields = FINGERPRINT_FIELDS.filter((field) => !hasOwn(previous, field));
  return { baseline: missingFields.length ? 'partial' : 'available', changedFields };
}

function changedMaterialValues(previous, current, changedFields) {
  const before = {};
  const after = {};
  for (const field of changedFields) {
    if (hasOwn(previous, field)) before[field] = previous[field];
    after[field] = current[field];
  }
  return { before, after };
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function summarizeCandidateDiagnostics(candidates = [], skipped = []) {
  const rows = candidates.map((candidate) => {
    const selection = candidate.selectionDiagnostics ?? {};
    return {
      pr: candidate.number,
      reasonCodes: [...(selection.reasonCodes ?? [])],
      baseline: selection.baseline ?? 'missing',
      changedFields: [...(selection.changedFields ?? [])],
      previousFingerprint: selection.previousFingerprint ?? null,
      fingerprint: selection.fingerprint ?? candidate.fingerprint ?? null,
      ...(selection.before ? { before: selection.before } : {}),
      ...(selection.after ? { after: selection.after } : {}),
    };
  });
  const reasonCounts = {};
  const changedFieldCounts = {};
  let fingerprintChangedCount = 0;
  let forcedRecheckCount = 0;
  let baselineMissingCount = 0;
  let baselinePartialCount = 0;
  let unattributedFingerprintMismatchCount = 0;
  for (const row of rows) {
    for (const reason of row.reasonCodes) incrementCount(reasonCounts, reason);
    for (const field of row.changedFields) incrementCount(changedFieldCounts, field);
    if (row.reasonCodes.includes('fingerprint-changed')) fingerprintChangedCount += 1;
    if (row.reasonCodes.some((reason) => ['retry', 'approval-due', 'author-notice-due',
      'merge-retry-due', 'retry-window-expired', 'fix-watchdog'].includes(reason))) forcedRecheckCount += 1;
    if (row.baseline === 'missing') baselineMissingCount += 1;
    if (row.baseline === 'partial') baselinePartialCount += 1;
    if (row.reasonCodes.includes('fingerprint-mismatch-unattributed')) unattributedFingerprintMismatchCount += 1;
  }
  return {
    version: 1,
    candidateCount: rows.length,
    unchangedCount: skipped.filter((item) => item.outcome === 'unchanged').length,
    draftCount: skipped.filter((item) => item.outcome === 'draft').length,
    fingerprintChangedCount,
    forcedRecheckCount,
    baselineMissingCount,
    baselinePartialCount,
    unattributedFingerprintMismatchCount,
    reasonCounts,
    changedFieldCounts,
    rows,
  };
}

export function parseReviewMode(args = []) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (/^(?:--review-only|--no-merge|reviewOnly)(?:=|$)/.test(token)) {
      const [key, ...rest] = token.split('=');
      let value = rest.length ? rest.join('=') : undefined;
      if (value === undefined && /^(true|false)$/.test(args[i + 1] ?? '')) value = args[++i];
      if (value === undefined && args[i + 1] && !/^(--|reviewOnly=)/.test(args[i + 1])) throw new Error(`无效布尔参数值: ${args[i + 1]}`);
      if (value === undefined && key.startsWith('--')) value = 'true';
      if (!['true', 'false'].includes(value)) throw new Error(`无效布尔参数: ${token}`);
      values.push(value === 'true');
    }
  }
  if (new Set(values).size > 1) throw new Error('reviewOnly 参数冲突');
  return values[0] ? 'review-only' : 'auto';
}

// Hash the PR's full observable state so that only real changes produce a
// fingerprint mismatch.  Previously only dependency heads were hashed, so
// every PR without dependencies had an identical fingerprint across rounds
export function candidateFingerprint(pr, snapshot, dependencyPrs = []) {
  return fingerprintFromMaterial(pr, fingerprintMaterial(pr, snapshot, dependencyPrs));
}

function fixWatchdogDue(pr, { mode, now, fixSessions }) {
  if (mode !== 'auto') return false;
  const entry = fixSessions?.[pr.number] ?? fixSessions?.[String(pr.number)];
  if (!entry || entry.needsHuman === true) return false;
  const decision = evaluateFixDispatch({
    entry, fingerprint: entry.fingerprint, threadUrls: entry.threadUrls, now,
  });
  return decision.shouldDispatch === true && Boolean(decision.watchdog);
}

export function createCandidateList({ repo, snapshot, state = {}, mode = 'auto', now = Date.now(), runId = randomUUID(), skillSync, historyRestore, fixSessions = {} }) {
  if (!['auto', 'review-only'].includes(mode)) throw new Error('无效模式');
  if (!Array.isArray(snapshot) || new Set(snapshot.map((p) => p.number)).size !== snapshot.length ||
      snapshot.some((p) => !Number.isSafeInteger(p.number) || p.number <= 0 || !p.head)) throw new Error('候选快照不完整');
  const candidates = [];
  const skipped = [];
  for (const pr of [...snapshot].sort(byAge)) {
    if (pr.isDraft) { skipped.push({ ...pr, outcome: 'draft', reason: '作者尚未标记 Ready' }); continue; }
    const previous = state?.version === 1 && state.mode === mode ? state.prs?.[pr.number] : null;
    const dependencyPrs = previous?.dependencyPrs ?? [];
    const observation = observeCandidateFingerprint(pr, snapshot, previous, dependencyPrs);
    const { material, fingerprint } = observation;
    const approvalDue = previous?.approval?.status === 'pending' ||
      (previous?.reviewClean === true && !previous?.approval) ||
      (previous?.outcome === 'approval' && !previous?.approval) ||
      // Older finish flows rejected authors before checking others' approvals.
      // Recheck once; a real missing approval now has a distinct disposition.
      (previous?.approval?.status === 'blocked' && ['self-author', 'viewer-is-author'].includes(previous.approval.code));
    const authorNoticeDue = rebaseNoticeDue(previous) || protectedNoticeDue(previous) || targetBranchNoticeDue(previous);
    const mergeRetryDue = mode === 'auto' && legacyMergeRetryDue(previous);
    const fingerprintChanged = Boolean(previous && !observation.equivalentToPrevious && previous.fingerprint !== fingerprint);
    const materialDiff = fingerprintMaterialDiff(previous?.fingerprintFields, material);
    const reasonCodes = [];
    if (!previous) reasonCodes.push('no-baseline');
    else if (fingerprintChanged) {
      reasonCodes.push('fingerprint-changed');
      if (!materialDiff.changedFields.length) reasonCodes.push('fingerprint-mismatch-unattributed');
    }
    if (previous?.retry === true) reasonCodes.push('retry');
    if (approvalDue) reasonCodes.push('approval-due');
    if (authorNoticeDue) reasonCodes.push('author-notice-due');
    if (mergeRetryDue) reasonCodes.push('merge-retry-due');
    if (previous?.retryAt && !(Date.parse(previous.retryAt) > now)) reasonCodes.push('retry-window-expired');
    const watchdogDue = previous && observation.equivalentToPrevious && previous.fixHandoff?.status !== 'needs-human'
      && fixWatchdogDue(pr, { mode, now, fixSessions });
    if (watchdogDue) reasonCodes.push('fix-watchdog');
    const selectionDiagnostics = {
      reasonCodes,
      baseline: previous ? materialDiff.baseline : 'missing',
      changedFields: fingerprintChanged ? materialDiff.changedFields : [],
      previousFingerprint: previous?.fingerprint ?? null,
      fingerprint,
      ...(fingerprintChanged
        ? (previous?.fingerprintFields
          ? changedMaterialValues(previous.fingerprintFields, material, materialDiff.changedFields)
          : { before: {}, after: material })
        : {}),
      ...(previous ? {} : { after: material }),
    };
    const unchanged = previous && observation.equivalentToPrevious && previous.retry !== true && !approvalDue && !authorNoticeDue && !mergeRetryDue &&
      (!previous.retryAt || Date.parse(previous.retryAt) > now) && !watchdogDue;
    if (unchanged) skipped.push({ ...pr, outcome: 'unchanged', reason: OUTCOMES.unchanged,
      fingerprint, fingerprintFields: material, lastOutcome: previous.outcome, lastReason: previous.reason, lastFixHandoff: previous.fixHandoff });
    else candidates.push({ ...pr, fingerprint, fingerprintFields: material,
      selectionReason: previous ? '状态变化或上轮未完成' : '尚无本模式的完整处理记录', selectionDiagnostics });
  }
  const candidateDiagnostics = summarizeCandidateDiagnostics(candidates, skipped);
  const manifest = { version: 1, runId, repo, mode, createdAt: formatLocalIso(now), snapshot, candidates, skipped,
    candidateDiagnostics,
    ...(skillSync ? { skillSync } : {}), ...(historyRestore ? { historyRestore } : {}) };
  return { ...manifest, digest: hash(manifest) };
}

export function validateCandidateList(manifest, { repo, now = Date.now() } = {}) {
  const { digest, ...body } = manifest ?? {};
  if (body.version !== 1 || !/^[a-zA-Z0-9-]+$/.test(body.runId ?? '') || hash(body) !== digest) throw new Error('候选名单损坏或被修改，请重新 pre-check');
  if (repo && body.repo !== repo) throw new Error('候选名单不属于目标仓库');
  const age = now - Date.parse(body.createdAt);
  if (!Number.isFinite(age) || age < 0 || age > 60 * 60 * 1000) throw new Error('候选名单超过 1 小时，请重新 pre-check');
  return manifest;
}

export function makeReviewPlan(manifest, contexts) {
  const eligible = [];
  const skipped = [];
  for (const candidate of manifest.candidates) {
    const context = contexts.find((c) => c.pr === candidate.number);
    const item = { pr: candidate.number, number: candidate.number, title: candidate.title, url: candidate.url,
      createdAt: candidate.createdAt, head: candidate.head, selfFix: context?.auto?.selfFix === true,
      contextFile: context?.contextFile, diffFile: context?.diffFile,
      base: context?.meta?.baseRefOid, baseRefName: context?.meta?.baseRefName,
      defaultBranch: context?.meta?.defaultBranch, basePr: context?.meta?.basePr ?? null, evidence: context?.evidence };
    let outcome;
    let reason;
    if (!context?.ok) { outcome = 'error'; reason = context?.error || '详细信息未成功读取'; }
    else if (context.meta?.state !== 'OPEN' || context.meta?.isDraft || context.meta?.headRefOid !== candidate.head) {
      outcome = 'state-changed'; reason = '名单生成后 PR 已关闭、转 draft 或 head 已变化；下轮重新采集';
    } else if (context.dependencies?.some((d) => d.state !== 'MERGED')) {
      outcome = 'dependency';
      reason = context.dependencies.filter((d) => d.state !== 'MERGED').map((d) => `${d.repo}#${d.number} (${d.state})`).join('；');
    } else if (context.meta.needsRetarget) { outcome = 'retarget'; reason = OUTCOMES.retarget; }
    item.dependencyPrs = (context?.dependencies ?? []).filter((d) => d.repo === manifest.repo).map((d) => d.number);
    if (outcome) skipped.push({ ...item, outcome, reason, enteredReview: false, reviewed: false, merged: false });
    else eligible.push(item);
  }
  eligible.sort(byAge);
  const groups = [];
  for (let i = 0; i < eligible.length; i += GROUP_SIZE) groups.push({ id: groups.length + 1, prs: eligible.slice(i, i + GROUP_SIZE) });
  return { version: 1, runId: manifest.runId, mode: manifest.mode, repo: manifest.repo,
    manifest, groupSize: GROUP_SIZE, groups, skipped,
    execution: { version: 1, scheduler: 'rolling', worktreeCleanupRequired: true } };
}

export function validateReviewCompletion(result, item) {
  if (result.mode === 'auto' && result.outcome === 'review-only') throw new Error(`PR #${item.pr} 的 auto 模式不能只 Approve 后当作 review-only 完成`);
  if (result.reviewed && typeof result.reviewClean !== 'boolean') throw new Error(`PR #${item.pr} 缺少独立的 reviewClean 结论`);
  if (result.reviewClean === true) {
    if (!result.reviewed || !result.enteredReview || result.outcome === 'findings') throw new Error(`PR #${item.pr} 的干净审查结论矛盾`);
    validateApprovalDisposition(result.approval, { head: item.head });
    if (!String(result.reportFile ?? '').trim()) throw new Error(`PR #${item.pr} 缺少落盘审查报告`);
    if (item.evidence && ['head', 'base', 'baseRefName', 'diffHash'].some((k) => !item.evidence[k] || result.reviewEvidence?.[k] !== item.evidence[k])) {
      throw new Error(`PR #${item.pr} 审查证据与计划的 head/base/diff 不一致`);
    }
  } else if (result.merged || ['approval', 'approval-pending', 'review-only', 'merge-queued'].includes(result.outcome)) {
    throw new Error(`PR #${item.pr} 未完成干净审查却记录审批或合并结论`);
  }
  if (result.merged && result.approval?.status !== 'verified') throw new Error(`PR #${item.pr} 合并缺少可核验 Approve 回执`);
  if (result.approval?.status === 'pending' && result.outcome !== 'approval-pending' && result.outcome !== 'error') {
    throw new Error(`PR #${item.pr} 待确认 Approve 不得冒充正常等待或完成`);
  }
}

export function collectRoundResults(plan, results) {
  const expected = plan.groups.flatMap((g) => g.prs);
  if (new Set(results.map((r) => r.pr)).size !== results.length) throw new Error('同一 PR 出现重复结果');
  if (results.some((r) => !expected.some((p) => p.pr === r.pr))) throw new Error('结果包含本轮分组以外的 PR');
  const processed = expected.map((item) => {
    const result = results.find((r) => r.pr === item.pr);
    if (!result) throw new Error(`PR #${item.pr} 尚无终态结果，不能宣告本轮完成`);
    if (result.runId !== plan.runId || result.head !== item.head) throw new Error(`PR #${item.pr} 的结果来自其他轮次或 head`);
    if (result.mode !== plan.mode) throw new Error(`PR #${item.pr} 的执行模式与计划不一致`);
    if (!OUTCOMES[result.outcome] || typeof result.enteredReview !== 'boolean' || typeof result.reviewed !== 'boolean' ||
        typeof result.merged !== 'boolean' || !String(result.reason ?? '').trim()) throw new Error(`PR #${item.pr} 结果字段不完整`);
    if (result.reviewed && !result.enteredReview) throw new Error(`PR #${item.pr} 未进入审查却标记 reviewed`);
    if (result.merged !== (result.outcome === 'merged') || (result.merged && (!result.reviewed || plan.mode === 'review-only'))) {
      throw new Error(`PR #${item.pr} 合并记录与审查状态/模式冲突`);
    }
    if (['maintainer-signoff', 'threads-unresolved', 'dependency'].includes(result.outcome) && result.enteredReview) {
      throw new Error(`PR #${item.pr} 前置门未通过却进入代码审查`);
    }
    validateReviewCompletion(result, item);
    validateRebaseAuthorNotice(result, item);
    validateProtectedPathAuthorNotice(result, item);
    validateTargetBranchNotice({ ...item, ...result });
    const request = createFixHandoffRequest({ ...result, selfFix: item.selfFix, mode: plan.mode, base: result.base ?? item.base });
    const handoff = result.fixHandoff;
    if (request) {
      if (!handoff || !['dispatched', 'deduplicated', 'failed', 'stale', 'needs-human'].includes(handoff.status) ||
          handoff.fingerprint !== request.fingerprint || !String(handoff.reason ?? '').trim()) {
        throw new Error(`PR #${item.pr} 的自有 PR 跟进尚无有效投递终态`);
      }
      if (['dispatched', 'deduplicated', 'needs-human'].includes(handoff.status) && !String(handoff.sessionId ?? '').trim()) {
        throw new Error(`PR #${item.pr} 的跟进缺少真实 session ID`);
      }
    } else if (handoff) {
      throw new Error(`PR #${item.pr} 的模式或卡点不允许投递修复 session`);
    }
    return { ...item, ...result, ...(handoff?.status === 'failed' ? {
      errors: [...(result.errors ?? []), `修复 session 投递失败：${handoff.reason}`],
    } : {}) };
  });
  const unchanged = plan.manifest.skipped.filter((p) => !p.isDraft).map((p) => ({ ...p, pr: p.number,
    outcome: OUTCOMES[p.lastOutcome] && p.lastOutcome !== 'merged' ? p.lastOutcome : 'unchanged',
    reason: p.lastReason ? `${p.lastReason}（状态未变化，沿用上轮结论）` : p.reason,
    ...(p.lastFixHandoff ? { fixHandoff: p.lastFixHandoff } : {}),
    notEnteredReason: OUTCOMES.unchanged, enteredReview: false, reviewed: false, merged: false }));
  for (const item of plan.skipped) validateTargetBranchNotice(item);
  const all = [...processed, ...plan.skipped, ...unchanged];
  const scope = plan.manifest.snapshot.filter((p) => !p.isDraft).map((p) => p.number);
  if (all.length !== scope.length || new Set(all.map((p) => p.pr)).size !== scope.length || all.some((p) => !scope.includes(p.pr))) {
    throw new Error('本轮记录没有完整覆盖冻结名单');
  }
  return { runId: plan.runId, mode: plan.mode, repo: plan.repo, strictCoverage: true, scope, processed: all,
    scan: { totalOpen: plan.manifest.snapshot.length, candidateCount: plan.manifest.candidates.length,
      candidateDiagnostics: plan.manifest.candidateDiagnostics },
    review: { eligibleCount: scope.length, entered: all.filter((p) => p.enteredReview),
      notEntered: all.filter((p) => !p.enteredReview).map((p) => ({ ...p, reason: p.notEnteredReason || p.reason })),
      unchangedCount: unchanged.length, draftCount: plan.manifest.snapshot.filter((p) => p.isDraft).length },
    merge: { merged: all.filter((p) => p.merged), notMerged: all.filter((p) => !p.merged) },
    errors: all.filter((p) => p.outcome === 'error' || p.errors?.length) };
}

export function nextRoundState(plan, payload, previous = {}, now = Date.now()) {
  const prs = { ...(previous.version === 1 && previous.mode === plan.mode ? previous.prs : {}) };
  // [MIVO-PATCH round-owner] 作者推了新提交时,Mivo 前置把 PR 提前从旧轮释放、交给更新的轮次。旧轮晚收尾时,
  // 这一行已经由更新的轮次写过,不能写回成旧 head。行里记着写它的轮次和创建时间;没有记录的旧行照常覆盖。
  const roundCreatedAt = plan.manifest?.createdAt ?? null;
  const roundAt = Date.parse(roundCreatedAt ?? '');
  const ownedByNewerRound = (row) => Number.isFinite(roundAt) && Date.parse(row?.roundCreatedAt ?? '') > roundAt;
  for (const result of payload.processed) {
    if (!plan.manifest.candidates.some((p) => p.number === result.pr)) continue;
    if (ownedByNewerRound(prs[result.pr])) continue;
    const dependencyPrs = result.dependencyPrs ?? [];
    // Cache the observation BEFORE actions. Never swallow a racing new thread
    // by fingerprinting a post-action state we did not actually review.
    const original = plan.manifest.snapshot.find((p) => p.number === result.pr);
    const observation = observeCandidateFingerprint(original, plan.manifest.snapshot, prs[result.pr], dependencyPrs);
    prs[result.pr] = { fingerprint: observation.fingerprint,
      fingerprintFields: observation.material,
      selfWriteReceipts: (Array.isArray(result.selfWriteReceipts) ? result.selfWriteReceipts : [])
        .filter((receipt) => receipt?.repo === plan.repo && receipt.pr === result.pr && receipt.head === original.head &&
          writeSecond(receipt.beforeUpdatedAt) !== null && writeSecond(receipt.updatedAt) !== null),
      dependencyPrs, checkedAt: formatLocalIso(now), outcome: result.outcome, reason: result.reason,
      ...(result.outcome === 'merge-blocked' ? { mergeRetryVersion: MERGE_RETRY_VERSION } : {}),
      ...(result.fixHandoff ? { fixHandoff: result.fixHandoff } : {}),
      ...(result.fixCause ? { fixCause: result.fixCause } : {}),
      ...(result.authorNotice ? { authorNotice: result.authorNotice } : {}),
      ...(result.targetBranchNotice ? { targetBranchNotice: result.targetBranchNotice } :
        result.outcome === 'dependency' && !needsTargetBranchNotice(result) ? { targetBranchNotice: { status: 'not-needed' } } : {}),
      reviewClean: result.reviewClean === true,
      ...(result.approval ? { approval: result.approval } : {}),
      retry: result.retry === true || ['error', 'state-changed', 'merge-queued', 'approval-pending'].includes(result.outcome) || result.approval?.status === 'pending' || Boolean(result.errors?.length) || result.fixHandoff?.status === 'stale' || result.authorNotice?.status === 'failed' || result.targetBranchNotice?.status === 'failed',
      retryAt: result.outcome === 'bot-pending' ? formatLocalIso(now + 5 * 60 * 1000) : null,
      ...(roundCreatedAt ? { roundRunId: plan.runId, roundCreatedAt } : {}) };
  }
  // A skipped unchanged PR was still observed this round.  Refresh its
  // diagnostic baseline without changing its review outcome or checkedAt.
  const candidateNumbers = new Set(plan.manifest.candidates.map((candidate) => candidate.number));
  for (const original of plan.manifest.snapshot.filter((item) => !item.isDraft && !candidateNumbers.has(item.number))) {
    const row = prs[original.number];
    if (!row || ownedByNewerRound(row)) continue;
    const dependencyPrs = row.dependencyPrs ?? [];
    const observation = observeCandidateFingerprint(original, plan.manifest.snapshot, row, dependencyPrs);
    if (observation.equivalentToPrevious) {
      prs[original.number] = { ...row, fingerprint: observation.fingerprint, fingerprintFields: observation.material };
    }
  }
  return { version: 1, mode: plan.mode, prs };
}
