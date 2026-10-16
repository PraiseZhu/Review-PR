// admission.mjs — Mini 前置审查的滚动接单:什么时候另开一轮、哪些 PR 不能进新一轮、held PR 何时唤醒。
//
// 已有轮次在等服务器审查时,每 3 分钟检查一次要不要另开一轮:
//   - 轮次重叠多久都照常接单(用户 2026-10-14:白天不停接单);所有轮次结束时进程退出,launchd 用新代码重启。
//     运行满 24 小时只是保险上限;检出新 SHA、维护者名单变化、部署暂停时停止接单,手上的跑完退出;
//   - 进入 06:00–07:00 维护窗口就停止接单(先于暂停判断),手上的跑完退出,07:00 后 launchd 拉起的进程照常接单;
//   - 暂停(额度或工具链)期间本次不接;
//   - 任何未结束的轮次还有未领取的任务时不接(先让它领完);
//   - 全进程在审(已派发还没收回结果的服务器 run,以及还不知道有没有派出的派发)达到 maxParallel 时不接,也不再领取任务。
// 同一个 PR 不能同时出现在两个未完成的轮次里(作者推了新提交、旧 run 已确认结束而提前释放的除外);
// 依赖在审 PR 的 PR 一起延后,否则它的指纹少了依赖 head,每个检查点都会被当成「有变化」的候选。纯函数,无 I/O。
export const ADMIT_INTERVAL_MS = 180_000;
export const MAX_ADMIT_MS = 24 * 60 * 60_000;
// 服务器审查的取消线:作业上限 160 分钟;执行超过 170 分钟才取消。排队单独计时:超过 30 分钟记慢,超过 120 分钟才取消。
export const MAX_EXEC_MINUTES = 170;
export const MAX_QUEUE_MINUTES = 120;
export const QUEUE_SLOW_MINUTES = 30;

/** 全进程还剩几个服务器审查槽位。rounds[i].inflight 是该轮已派发未收回的 run 数;已结束、失败的轮次也算。 */
export function toFreeSlots({ rounds = [], maxParallel }) {
  const inflight = rounds.reduce((sum, r) => sum + (Number(r?.inflight) || 0), 0);
  return Math.max(0, maxParallel - inflight);
}

/** 这个检查点要不要另开一轮:{admit:true, freeSlots} 或 {admit:false, reason, close?}(close=从此不再接新轮)。 */
export function toAdmissionDecision({ nowMs, startedAtMs, maxRunMs = MAX_ADMIT_MS, closedReason = null,
  deployHold = false, paused = false, inWindow = true, rounds = [], maxParallel }) {
  if (closedReason) return { admit: false, reason: closedReason };
  if (nowMs - startedAtMs >= maxRunMs) return { admit: false, reason: 'max-runtime', close: true };
  if (deployHold) return { admit: false, reason: 'deploy-hold', close: true };
  if (!inWindow) return { admit: false, reason: 'maintenance-window', close: true };
  if (paused) return { admit: false, reason: 'paused' };
  if (rounds.some((r) => !r?.finished && (Number(r?.queued) || 0) > 0)) return { admit: false, reason: 'queued-backlog' };
  const freeSlots = toFreeSlots({ rounds, maxParallel });
  if (freeSlots <= 0) return { admit: false, reason: 'no-free-slot' };
  return { admit: true, freeSlots };
}

/**
 * 未完成轮次里的 PR(计划阶段被跳过的也算):这些 PR 不能进新一轮。
 * plan.released 里的 PR 除外:作者推了新提交、旧 run 已确认结束,已从这一轮提前释放(轮次目录的 mivo-released.json)。
 */
export function toBusyPrs(plans = []) {
  const busy = new Set();
  for (const plan of plans) {
    const released = new Set(Object.keys(plan?.released ?? {}).map(Number));
    const add = (value) => { const n = Number(value); if (Number.isSafeInteger(n) && n > 0 && !released.has(n)) busy.add(n); };
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
 * 第一次见到的 issue:没有评论只记录;已经有评论(comments > 0)也要唤醒。issue 创建后最多隔一个周期才被第一次记录,
 * 维护者在这段时间里回复的「同意放行」否则要等到指纹再变化才被看到(受保护路径 PR 会白等)。多一次重判,没有副作用。
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
    const firstSeenWithComments = !previous && Number(issue?.comments) > 0;
    if ((changed || firstSeenWithComments) && busyPrs.has(pr)) {
      // 首次见到的不记录:下个周期仍是首次,在审结束后照样唤醒。
      if (previous) next[issue.number] = previous;
      deferred.push(pr);
      continue;
    }
    next[issue.number] = { pr, updatedAt: issue.updated_at };
    if (changed || firstSeenWithComments) wake.push(pr);
  }
  return { next, wake, deferred };
}

/**
 * 还没结束的服务器 run 怎么办:排队和执行分开计时。run 是 `gh run view --json status,createdAt,jobs` 的结果。
 * 只有已经开始执行的 job 才用它的 startedAt;排队中的 job 按 run 的 createdAt 算排队时间。
 * 返回 {phase, execMin?, queueMin?, cancel: 'exec'|'queue'|null, slow}。
 */
export function toRunTiming({ nowMs, run }) {
  const started = (run?.jobs ?? []).find((job) => ['in_progress', 'completed'].includes(job?.status) && Date.parse(job?.startedAt) > 0);
  if (started) {
    const execMin = (nowMs - Date.parse(started.startedAt)) / 60_000;
    return { phase: 'running', execMin, cancel: execMin > MAX_EXEC_MINUTES ? 'exec' : null, slow: false };
  }
  const queueMin = (nowMs - Date.parse(run?.createdAt)) / 60_000;
  if (!Number.isFinite(queueMin)) return { phase: 'unknown', cancel: null, slow: false };
  return { phase: 'queued', queueMin, cancel: queueMin > MAX_QUEUE_MINUTES ? 'queue' : null, slow: queueMin > QUEUE_SLOW_MINUTES };
}

/**
 * `gh workflow run` 失败时这次派发算什么:带错误内容的 HTTP 4xx 是明确被拒(没派出,可以按失败重试);
 * 超时、断线、5xx 以及其它情况一律算「不知道有没有派出」,不能重发。
 */
export function toDispatchFailure({ stderr = '', error = null } = {}) {
  const text = String(stderr ?? '');
  const status = text.match(/\bHTTP 4\d\d\b/);
  if (error || !status) return 'unknown';
  return text.replace(status[0], '').replace(/[\s:]/g, '').length > 0 ? 'rejected' : 'unknown';
}

/**
 * 在 `gh api --paginate --slurp .../runs?created=>=…` 的分页结果里按 run 名「review-pr #<pr> <dispatch_id>」找自己派的 run。
 * complete=false 表示列表没拿全(total_count 比拿到的多),没找到也不能当作没派出。
 */
export function findDispatchRun(pages, { pr, dispatchId }) {
  const list = Array.isArray(pages) ? pages : pages ? [pages] : [];
  const runs = list.flatMap((page) => page?.workflow_runs ?? []);
  const title = `review-pr #${pr} ${dispatchId}`;
  const hit = runs.find((run) => run?.display_title === title);
  if (hit) return { runId: String(hit.id), complete: true };
  const total = Number(list[0]?.total_count);
  return { runId: null, complete: list.length > 0 && Number.isFinite(total) && runs.length >= total };
}
