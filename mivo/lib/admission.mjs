// admission.mjs — Mini 前置审查的滚动接单:什么时候另开一轮、哪些 PR 不能进新一轮、held PR 何时唤醒。
//
// 已有轮次在等服务器审查时,每 3 分钟检查一次要不要另开一轮:
//   - 进程运行满 60 分钟后不再接新轮,手上的轮次跑完就退出,launchd 用新代码和新日志文件重启;
//   - 暂停(额度或工具链)和 06:00–07:00 维护窗口内,本次不接;
//   - 任何未结束的轮次还有未领取的任务时不接(先让它领完);
//   - 全进程「已派发、还没收回结果」的服务器 run 达到 maxParallel 时不接,也不再领取任务。
// 同一个 PR 不能同时出现在两个未完成的轮次里;依赖在审 PR 的 PR 一起延后,否则它的指纹少了依赖 head,
// 每个检查点都会被当成「有变化」的候选。纯函数,无 I/O。
export const ADMIT_INTERVAL_MS = 180_000;
export const MAX_ADMIT_MS = 60 * 60_000;

/** 全进程还剩几个服务器审查槽位。rounds[i].inflight 是该轮已派发未收回的 run 数;已结束、失败的轮次也算。 */
export function toFreeSlots({ rounds = [], maxParallel }) {
  const inflight = rounds.reduce((sum, r) => sum + (Number(r?.inflight) || 0), 0);
  return Math.max(0, maxParallel - inflight);
}

/** 这个检查点要不要另开一轮:{admit:true, freeSlots} 或 {admit:false, reason, close?}(close=从此不再接新轮)。 */
export function toAdmissionDecision({ nowMs, startedAtMs, maxRunMs = MAX_ADMIT_MS, closedReason = null,
  paused = false, inWindow = true, rounds = [], maxParallel }) {
  if (closedReason) return { admit: false, reason: closedReason };
  if (nowMs - startedAtMs >= maxRunMs) return { admit: false, reason: 'max-runtime', close: true };
  if (paused) return { admit: false, reason: 'paused' };
  if (!inWindow) return { admit: false, reason: 'maintenance-window' };
  if (rounds.some((r) => !r?.finished && (Number(r?.queued) || 0) > 0)) return { admit: false, reason: 'queued-backlog' };
  const freeSlots = toFreeSlots({ rounds, maxParallel });
  if (freeSlots <= 0) return { admit: false, reason: 'no-free-slot' };
  return { admit: true, freeSlots };
}

/** 未完成轮次里的 PR(计划阶段被跳过的也算):这些 PR 不能进新一轮。 */
export function toBusyPrs(plans = []) {
  const busy = new Set();
  const add = (value) => { const n = Number(value); if (Number.isSafeInteger(n) && n > 0) busy.add(n); };
  for (const plan of plans) {
    for (const candidate of plan?.manifest?.candidates ?? []) add(candidate?.number);
    for (const group of plan?.groups ?? []) for (const item of group?.prs ?? []) add(item?.pr);
  }
  return busy;
}

/** 新一轮要从快照里去掉的 PR:在审 PR,加上 round-state 里(传递地)依赖它们的 PR。 */
export function toExcludedPrs({ busyPrs = new Set(), roundState = {}, mode = 'review-only' }) {
  const excluded = new Set([...busyPrs].map(Number));
  if (roundState?.version !== 1 || roundState.mode !== mode) return excluded;
  const rows = Object.entries(roundState.prs ?? {});
  for (let grew = true; grew;) {
    grew = false;
    for (const [pr, row] of rows) {
      const n = Number(pr);
      if (excluded.has(n)) continue;
      if (!(row?.dependencyPrs ?? []).some((dep) => excluded.has(Number(dep)))) continue;
      excluded.add(n);
      grew = true;
    }
  }
  return excluded;
}

/**
 * 维护者确认 issue 有新留言(Slack「同意放行」同步过来)时唤醒对应 PR。
 * 在审 PR 先不唤醒、保留旧记录:现在写 retry 会被那一轮的 finalize 覆盖,放行就丢了;等它不在审时再触发。
 * 第一次见到的 issue 只记录,不唤醒。
 */
export function toHeldWake({ issues = [], seen = {}, busyPrs = new Set() }) {
  const next = {};
  const wake = [];
  const deferred = [];
  for (const issue of issues) {
    if (issue?.pull_request) continue;
    const m = String(issue?.title ?? '').match(/^维护者确认 · PR #(\d+)/);
    if (!m) continue;
    const pr = Number(m[1]);
    const previous = seen[issue.number];
    const changed = Boolean(previous) && previous.updatedAt !== issue.updated_at;
    if (changed && busyPrs.has(pr)) {
      next[issue.number] = previous;
      deferred.push(pr);
      continue;
    }
    next[issue.number] = { pr, updatedAt: issue.updated_at };
    if (changed) wake.push(pr);
  }
  return { next, wake, deferred };
}
