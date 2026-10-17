// convergence.mjs — 审查收敛:同一问题跨轮用同一个 key,连续多轮没修好时提醒回头看方案,带 key 的维护者裁定自动复核。纯函数。
// 只提示、不改结论:同一条 P0/P1 连续 3 轮(含)以上报出,报告插一节「收敛提示」,阻断与否不变;不停审、不放行。
// 裁定复核:维护者对某个 key 裁定不改的 P1,模型本轮仍报了就移出阻断(单列在报告里);P0 永不移出阻断。
import { findingKeyOf, findingMarker, parseFindingMarker, renderFindingBody, titleOfBody } from './finding.mjs';

export const STUCK_ROUNDS = 3;
const FINDING_RE = /^\s*\[(P0|P1)\]/;
const HEX_KEY_RE = /^[0-9a-f]{12}$/;
const lower = (login) => String(login ?? '').toLowerCase();
const commentsOf = (thread) => (Array.isArray(thread?.comments) ? thread.comments : thread?.comments?.nodes ?? []);

/**
 * 从 reviewer 开的 [P0]/[P1] thread 里读 mivo-finding marker。
 * 本轮 head 的 marker 不计:同一 head 重试(attempt 2)时,上一次尝试已经发出去的 marker 不能算成「又一轮」。
 */
export function collectMarkerHistory({ threads = [], reviewer, currentHead }) {
  const current = String(currentHead ?? '').slice(0, 12);
  const history = { byKey: new Map(), heads: new Set(), threadUrlByKey: new Map(), reviewerThreads: 0, legacyThreads: 0 };
  if (!reviewer) return history;
  for (const thread of threads) {
    const [first] = commentsOf(thread);
    if (lower(first?.author?.login) !== lower(reviewer) || !FINDING_RE.test(String(first?.body ?? ''))) continue;
    const marker = parseFindingMarker(first.body);
    if (marker && marker.head.slice(0, 12) === current) continue;
    history.reviewerThreads += 1;
    if (!marker) { history.legacyThreads += 1; continue; }
    const head = marker.head.slice(0, 12);
    history.heads.add(head);
    if (!history.byKey.has(marker.key)) history.byKey.set(marker.key, new Set());
    history.byKey.get(marker.key).add(head);
    if (first.url) history.threadUrlByKey.set(marker.key, first.url);
  }
  return history;
}

/** 上一轮结果包 → 本轮要用的上一轮 key 清单。旧结果没有这些字段时都是空值,不报错。 */
export function toPreviousRound(result) {
  const mivo = result?.mivo ?? {};
  const findings = (mivo.findings ?? []).filter((f) => f?.key).map((f) => ({ key: f.key, seenRounds: Number.isInteger(f.seenRounds) ? f.seenRounds : 1, severity: f.severity ?? null }));
  const keys = new Set([...(mivo.findings ?? []), ...(mivo.deferred ?? []), ...(mivo.preexisting ?? []), ...(mivo.verifierOverruled ?? [])].map((f) => f?.key).filter(Boolean));
  const roundIndex = Number.isInteger(mivo.convergence?.roundIndex) ? mivo.convergence.roundIndex : null;
  return { roundIndex, findings, keys };
}

/** 本轮是第几轮:优先沿上一轮结果链 +1;取不到就数 thread marker 里不同的 head;有历史但数不出来就不猜(null)。 */
export function roundIndexOf({ previousRound = null, hasPrevious = false, history }) {
  if (Number.isInteger(previousRound?.roundIndex)) return previousRound.roundIndex + 1;
  if (history?.heads?.size > 0) return history.heads.size + 1;
  if (hasPrevious || history?.reviewerThreads > 0) return null;
  return 1;
}

const severityOf = (item) => item.severity ?? item.body?.match(FINDING_RE)?.[1] ?? 'P1';

/**
 * 给三类问题(阻断 / PR 之前就存在 / 转 issue)分配 key,算连续轮数,加上 mivo-finding marker;
 * 阻断问题里命中维护者裁定的 P1 移入 ruledKept。
 * @param {object} p
 * @param {object[]} p.findings 阻断问题 @param {object[]} p.preexisting @param {object[]} p.deferred
 * @param {object} p.scope computeReviewScope 的结果 @param {number|null} p.roundIndex
 * @param {{roundIndex,findings,keys}|null} p.previousRound @param {object} p.history collectMarkerHistory 的结果
 * @param {{key?:string, by:string}[]} p.rulings 服务器核验通过的裁定 @param {string} p.head
 */
export function applyConvergence({ findings = [], preexisting = [], deferred = [], scope = null, roundIndex = null, previousRound = null, history, rulings = [], head }) {
  const hist = history ?? collectMarkerHistory({});
  const rulingKeys = new Set(rulings.map((r) => r.key).filter(Boolean));
  const known = new Set([...(previousRound?.keys ?? []), ...hist.byKey.keys(), ...rulingKeys]);
  const previousBlocking = new Map((previousRound?.findings ?? []).map((f) => [f.key, f.seenRounds]));
  const legacyCount = (scope?.previousFindings ?? []).length;

  const keyed = (item) => {
    const severity = severityOf(item);
    const title = item.title ?? titleOfBody(item.body);
    const bugClass = item.bugClass ?? '';
    const computed = findingKeyOf({ path: item.path, bugClass, title });
    let ref = item.supersedes ?? null;
    if (ref === null && known.has(computed)) ref = computed;
    const key = ref && HEX_KEY_RE.test(ref) && known.has(ref) ? ref : computed;
    let seenRounds = 1;
    if (ref && previousBlocking.has(ref)) seenRounds = previousBlocking.get(ref) + 1;
    else if (ref && previousRound === null && hist.byKey.has(ref)) seenRounds = hist.byKey.get(ref).size + 1;
    else if (ref && /^legacy-(\d{1,3})$/.test(ref) && Number(ref.slice(7)) <= legacyCount) seenRounds = 2;
    const marker = { key, round: roundIndex, head, bugClass };
    // v2 项重新渲染(带 marker);没有结构化字段的 v1 项在原正文后追加 marker。
    const body = item.title ? renderFindingBody(item, marker) : `${item.body}\n\n${findingMarker(marker)}`;
    const late = scope?.mode === 'incremental' && (item.supersedes ?? null) === null && !(scope.changedFiles ?? []).includes(item.path);
    return { ...item, body, key, severity, origin: item.origin ?? 'introduced', bugClass, seenRounds, late, evidenceComplete: item.evidenceComplete };
  };

  const ruledKept = [];
  let rulingViolations = 0;
  const blocking = [];
  for (const item of findings.map(keyed)) {
    const ruling = rulings.find((r) => r.key && r.key === item.key);
    if (ruling) rulingViolations += 1;
    if (ruling && item.severity === 'P1') {
      ruledKept.push({ key: item.key, severity: item.severity, path: item.path, line: item.line ?? null, title: item.title ?? titleOfBody(item.body), rulingBy: ruling.by });
      continue;
    }
    blocking.push(item);
  }
  const stuck = blocking.filter((f) => ['P0', 'P1'].includes(f.severity) && f.seenRounds >= STUCK_ROUNDS)
    .map((f) => ({ key: f.key, severity: f.severity, title: f.title ?? titleOfBody(f.body), path: f.path, line: f.line ?? null, seenRounds: f.seenRounds, threadUrl: hist.threadUrlByKey.get(f.key) ?? null }));
  const convergence = {
    roundIndex, repeatCount: blocking.filter((f) => f.seenRounds >= 2).length, lateCount: blocking.filter((f) => f.late).length,
    rulingViolations, rethink: stuck.length > 0, stuckKeys: stuck.map((s) => s.key),
  };
  return { findings: blocking, preexisting: preexisting.map(keyed), deferred: deferred.map(keyed), ruledKept, stuck, convergence };
}

/** 报告里的「收敛提示」一节;不需要提示时返回空数组。 */
export function renderConvergenceSection(convergence, stuck = []) {
  if (!convergence?.rethink || !stuck.length) return [];
  return [
    '## 收敛提示', '',
    `下列 P0/P1 问题已连续 ${STUCK_ROUNDS} 轮或以上报出，本轮核对仍未修好。建议先回头看实现方案是否要调整，再逐条修；认为不成立的，在对应 thread 按作者申辩写明依据。`, '',
    ...stuck.map((s) => `- [${s.severity}] ${s.title}（已连续 ${s.seenRounds} 轮）${s.threadUrl ? ` · [thread](${s.threadUrl})` : ` · \`${s.line ? `${s.path}:${s.line}` : s.path}\``}`),
    '',
  ];
}
