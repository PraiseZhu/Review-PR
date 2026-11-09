#!/usr/bin/env node
// review-outcomes.mjs — Mivo 审查机的只读结果遥测(离线 CLI,按需执行,不接任何定时任务)。
// 读一段时间内的 PR 评审记录,算:作者反应分桶(代理指标)、rounds-to-pass、回滚候选、高频问题类型。
// 只读 GitHub(gh api graphql),不写任何 GitHub 数据;默认输出不含 finding 正文、首行、代码片段和 PR 标题。
// 作者反应分桶是代理指标,不是事实真伪:没回复不等于认同,resolve 不等于真的修好。
//
// #189 起还算:review-pr.yml 成功运行的耗时 p50/p90;漏报(验收机修正 issue 反查到的 PR,审查机是否提前报过同一 SC);噪音 = ruled-keep + rebutted。
// #232 起还算:同一版本的重审次数;准备/模型/发布三段耗时;有总 issue、只有任务 issue、没有任务 issue 三组的同期对照;
// 问题按 key 去重;修正 issue 按归属分类(审查机验不了 / 验收时机不对);--labels 读人工标签算人工口径的噪音。
//
//   node mivo/telemetry/review-outcomes.mjs --repo <o/r> --since YYYY-MM-DD --until YYYY-MM-DD --reviewer <login> --out <dir>
//        [--max-prs 200] [--workflow review-pr.yml] [--fixture <file>] [--include-text] [--labels <file>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseFindingMarker, titleOfBody } from '../lib/finding.mjs';
import { parseRulingReason } from '../lib/rulings.mjs';
import { parseDeferrals } from '../lib/deferrals.mjs';

export const REPORT_MARK = 'Mivo 自动审查';
export const BUCKETS = ['ruled-keep', 'deferred', 're-raised', 'rebutted', 'fixed-proxy', 'unknown'];
export const NOTE = '作者反应分桶是代理指标,不是事实真伪';
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FINDING_RE = /^\s*\[(P[012])\]/;
const lower = (value) => String(value ?? '').toLowerCase();
const time = (value) => { const t = Date.parse(value ?? ''); return Number.isFinite(t) ? t : 0; };

// ── 参数 ───────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const out = { maxPrs: 200, includeText: false, fixture: null, workflow: 'review-pr.yml', labels: null };
  const values = { '--repo': 'repo', '--since': 'since', '--until': 'until', '--reviewer': 'reviewer', '--out': 'out', '--max-prs': 'maxPrs', '--fixture': 'fixture', '--workflow': 'workflow', '--labels': 'labels' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--include-text') { out.includeText = true; continue; }
    if (!(arg in values)) return { error: `不认识的参数:${arg}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `参数 ${arg} 缺少值` };
    out[values[arg]] = value;
    i += 1;
  }
  for (const [flag, key] of [['--repo', 'repo'], ['--since', 'since'], ['--until', 'until'], ['--reviewer', 'reviewer'], ['--out', 'out']]) {
    if (!out[key]) return { error: `缺少参数 ${flag}` };
  }
  if (!REPO_RE.test(out.repo)) return { error: `--repo 格式不对:${out.repo}` };
  for (const key of ['since', 'until']) if (!DATE_RE.test(out[key])) return { error: `--${key} 要写成 YYYY-MM-DD:${out[key]}` };
  if (!/^[\w.-]+\.ya?ml$/.test(out.workflow)) return { error: `--workflow 要写成 workflow 文件名(如 review-pr.yml):${out.workflow}` };
  out.maxPrs = Number(out.maxPrs);
  if (!Number.isInteger(out.maxPrs) || out.maxPrs < 1 || out.maxPrs > 2000) return { error: '--max-prs 要在 1–2000 之间' };
  return { options: out };
}

// ── 读取与规范化 ────────────────────────────────────────────────────────────
const QUERY = `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 20, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { ... on PullRequest { number title body state merged mergedAt createdAt author { login }
    reviews(first: 100) { pageInfo { hasNextPage } nodes { author { login } state body submittedAt commit { oid } } }
    reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved path line
      comments(first: 50) { nodes { author { login } body createdAt url } } } } } } } }`;

/** GraphQL 的 PullRequest 节点 → 规范化形状(fixture 用同一份形状)。 */
export function normalizePrs(nodes) {
  const truncated = { nested: 0 };
  const prs = (nodes ?? []).filter((n) => n && Number.isInteger(n.number)).map((n) => {
    if (n.reviews?.pageInfo?.hasNextPage || n.reviewThreads?.pageInfo?.hasNextPage) truncated.nested += 1;
    return {
      number: n.number, title: n.title ?? '', body: n.body ?? '', state: n.state, merged: n.merged === true,
      mergedAt: n.mergedAt ?? null, createdAt: n.createdAt ?? null, author: n.author?.login ?? '',
      reviews: (n.reviews?.nodes ?? []).map((r) => ({ author: r.author?.login ?? '', state: r.state, body: r.body ?? '',
        submittedAt: r.submittedAt ?? null, commitOid: r.commit?.oid ?? null })),
      threads: (n.reviewThreads?.nodes ?? []).map((t) => ({ isResolved: t.isResolved === true, path: t.path ?? null, line: t.line ?? null,
        comments: (t.comments?.nodes ?? []).map((c) => ({ author: c.author?.login ?? '', body: c.body ?? '', createdAt: c.createdAt ?? null, url: c.url ?? '' })) })),
    };
  });
  return { prs, truncated };
}

function ghGraphql(variables) {
  const args = ['api', 'graphql', '-f', `query=${QUERY}`];
  for (const [key, value] of Object.entries(variables)) if (value != null) args.push('-f', `${key}=${value}`);
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.error) {
    const status = /HTTP (\d{3})/.exec(r.stderr ?? '')?.[1] ?? '?';
    const failure = new Error(`GitHub 读取失败(graphql search, HTTP ${status})`);
    failure.code = 3;
    throw failure;
  }
  try { return JSON.parse(r.stdout).data.search; } catch {
    const failure = new Error('GitHub 读取失败(graphql search, 返回不是 JSON)');
    failure.code = 3;
    throw failure;
  }
}

function fetchPrs({ repo, since, until, maxPrs }) {
  const nodes = [];
  let after = null;
  let more = false;
  for (;;) {
    const page = ghGraphql({ q: `repo:${repo} is:pr updated:${since}..${until}`, after });
    nodes.push(...(page.nodes ?? []));
    if (nodes.length >= maxPrs) { more = nodes.length > maxPrs || page.pageInfo?.hasNextPage === true; break; }
    if (!page.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  const { prs, truncated } = normalizePrs(nodes.slice(0, maxPrs));
  return { prs, truncated: { ...truncated, prs: more } };
}

function ghJson(args, what) {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.error) {
    const status = /HTTP (\d{3})/.exec(r.stderr ?? '')?.[1] ?? '?';
    const failure = new Error(`GitHub 读取失败(${what}, HTTP ${status})`);
    failure.code = 3;
    throw failure;
  }
  try { return JSON.parse(r.stdout); } catch {
    const failure = new Error(`GitHub 读取失败(${what}, 返回不是 JSON)`);
    failure.code = 3;
    throw failure;
  }
}

/** 运行标题「review-pr #2035 06deea80」里的 PR 号;认不出返回 null。 */
export const prOfRunTitle = (title) => { const m = /#(\d+)\b/.exec(String(title ?? '')); return m ? Number(m[1]) : null; };

/** workflow 在时间段内创建的运行 → {runs: [{id, pr, startedAt, updatedAt, conclusion}], truncated};最多 10 页,读不全时 truncated=true。 */
function fetchRuns({ repo, workflow, since, until }) {
  const runs = [];
  let total = 0;
  for (let page = 1; page <= 10; page += 1) {
    const data = ghJson(['api', `repos/${repo}/actions/workflows/${workflow}/runs?created=${since}..${until}&per_page=100&page=${page}`], 'workflow runs');
    const list = data.workflow_runs ?? [];
    total = Math.max(total, data.total_count ?? 0);
    runs.push(...list.map((r) => ({ id: r.id ?? null, pr: prOfRunTitle(r.display_title), startedAt: r.run_started_at ?? r.created_at ?? null, updatedAt: r.updated_at ?? null, conclusion: r.conclusion ?? null })));
    if (list.length < 100) break;
  }
  return { runs, truncated: total > runs.length };
}

/** 分阶段耗时最多读这么多次运行的步骤(最近的优先,每次运行一次 REST 请求)。 */
export const MAX_PHASE_RUNS = 200;

/** 最近 MAX_PHASE_RUNS 次成功运行的 job steps → {runJobs: [{runId, jobs: [{name, steps: [{name, startedAt, completedAt}]}]}], failed};单次读失败只计数,不让整份统计失败。 */
function fetchRunJobs({ repo, runs }) {
  const picked = (runs ?? []).filter((r) => r.conclusion === 'success' && r.id).sort((a, b) => time(b.startedAt) - time(a.startedAt)).slice(0, MAX_PHASE_RUNS);
  const runJobs = [];
  let failed = 0;
  for (const run of picked) {
    try {
      const data = ghJson(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`], 'run jobs');
      runJobs.push({ runId: run.id, jobs: (data.jobs ?? []).map((j) => ({ name: j.name ?? '',
        steps: (j.steps ?? []).map((s) => ({ name: s.name ?? '', startedAt: s.started_at ?? null, completedAt: s.completed_at ?? null })) })) });
    } catch { failed += 1; }
  }
  return { runJobs, failed };
}

/** 任务 issue 是否挂在父 issue 下 → {parents: {'owner/repo#n': true|false}, failed};按仓分批(每批 50 个)走 GraphQL,读失败的不写进结果(分组时记为未知)。 */
function fetchParents(refs) {
  const parents = {};
  let failed = 0;
  const byRepo = new Map();
  for (const ref of refs ?? []) {
    if (!REPO_RE.test(ref.repo)) continue;
    const list = byRepo.get(ref.repo) ?? new Set();
    list.add(ref.issue);
    byRepo.set(ref.repo, list);
  }
  for (const [repo, set] of byRepo) {
    const [owner, name] = repo.split('/');
    const numbers = [...set];
    for (let i = 0; i < numbers.length; i += 50) {
      const batch = numbers.slice(i, i + 50);
      const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${batch.map((n) => `i${n}: issue(number: ${n}) { parent { number } }`).join(' ')} } }`;
      const r = spawnSync('gh', ['api', 'graphql', '-f', `query=${query}`], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      let data = null;
      try { data = r.status === 0 ? JSON.parse(r.stdout).data?.repository : null; } catch { data = null; }
      for (const n of batch) {
        const node = data?.[`i${n}`];
        if (!data || node === undefined) { failed += 1; continue; }
        parents[`${repo.toLowerCase()}#${n}`] = Boolean(node?.parent);
      }
    }
  }
  return { parents, failed };
}

/** 时间段内创建、正文像验收机修正 issue 的 issue → {corrections: [{number, body, createdAt}], truncated};只保留能解析出修正标记的。 */
function fetchCorrections({ repo, since, until }) {
  const items = [];
  let total = 0;
  for (let page = 1; page <= 10; page += 1) {
    const data = ghJson(['api', '-X', 'GET', 'search/issues', '-f', `q=repo:${repo} is:issue in:body 验收机 修正 created:${since}..${until}`, '-f', 'per_page=100', '-f', `page=${page}`], 'search issues');
    const list = data.items ?? [];
    total = Math.max(total, data.total_count ?? 0);
    items.push(...list);
    if (list.length < 100) break;
  }
  const corrections = items.map((i) => ({ number: i.number, body: i.body ?? '', createdAt: i.created_at ?? null })).filter((i) => parseCorrectionMarker(i.body));
  return { corrections, truncated: total > items.length };
}

// ── 报告与分桶 ──────────────────────────────────────────────────────────────
/** 审查机发出的报告:reviewer 的 review,正文含「Mivo 自动审查」,「本轮沿用」不算新的一轮。按提交时间排序。 */
export function reportsOf(pr, reviewer) {
  return pr.reviews.filter((r) => lower(r.author) === lower(reviewer) && String(r.body).includes(REPORT_MARK) && !/^>\s*本轮沿用/.test(String(r.body).trim()))
    .sort((a, b) => time(a.submittedAt) - time(b.submittedAt));
}

export const VERIFIER_REFUTED_HEADING = '## 核对员认为不成立';
export const VERIFIER_DOWNGRADED_HEADING = '## 核对员降级';

/**
 * 从一份已发布的审查报告里数「核对员认为不成立」「核对员降级」两节的条数(每条一个 `- ` 列表项,到下一个 `## ` 标题为止)。
 * 报告里没有 finding key,同一问题跨轮重复被推翻会在每一轮各算一次。lines 是节里的原文行,只在 --include-text 时才输出。
 */
export function parseVerifierSections(body) {
  const out = { refuted: 0, downgraded: 0, lines: [] };
  let section = null;
  for (const line of String(body ?? '').split('\n')) {
    if (/^## /.test(line)) {
      section = line.startsWith(VERIFIER_REFUTED_HEADING) ? 'refuted' : line.startsWith(VERIFIER_DOWNGRADED_HEADING) ? 'downgraded' : null;
      continue;
    }
    if (section && /^- /.test(line)) { out[section] += 1; out.lines.push({ kind: section, text: line.slice(2) }); }
  }
  return out;
}

const overallLine = (body) => {
  const lines = String(body).split('\n');
  const at = lines.findIndex((l) => /^## Overall\s*$/.test(l));
  if (at < 0) return null;
  return lines.slice(at + 1).find((l) => l.trim())?.trim() ?? null;
};
const headOfReport = (body) => /head `([0-9a-f]{7,40})`/.exec(String(body))?.[1] ?? null;
const tierOfReport = (body) => /档位 (light|standard|heavy)/.exec(String(body))?.[1] ?? null;

/** 第一份结论以 pass 开头的报告的序号(从 1 起);一直没有 pass 返回 null。 */
export function roundsToPass(reports) {
  const at = reports.findIndex((r) => /^pass\b/.test(overallLine(r.body) ?? ''));
  return at < 0 ? null : at + 1;
}

export function summarize(rounds) {
  const passed = rounds.filter((n) => n !== null);
  const denominator = passed.length;
  return {
    onePass: { numerator: passed.filter((n) => n === 1).length, denominator },
    fivePlus: { numerator: passed.filter((n) => n >= 5).length, denominator },
    mean: { value: denominator ? Math.round((passed.reduce((a, b) => a + b, 0) / denominator) * 100) / 100 : null, denominator },
    nullCount: rounds.length - denominator,
  };
}

/** reviewer 开的 [P0]/[P1]/[P2] thread 的信息;不是审查机的 thread 返回 null。 */
export function toFindingThread(thread, reviewer) {
  const [first, ...replies] = thread.comments ?? [];
  if (!first || lower(first.author) !== lower(reviewer)) return null;
  const severity = FINDING_RE.exec(first.body ?? '')?.[1];
  if (!severity) return null;
  const marker = parseFindingMarker(first.body);
  return { thread, first, replies, severity, marker, createdAt: time(first.createdAt),
    title: titleOfBody(first.body), keyOf: marker?.key ?? `${thread.path ?? ''}|${lower(titleOfBody(first.body))}` };
}

/**
 * 一条 finding thread 的作者反应分桶。优先级:ruled-keep > deferred > re-raised > rebutted > fixed-proxy > unknown。
 * re-raised 先于 rebutted:rebutted 要求之后审查机没再报同一问题。
 */
export function classifyThread(pr, info, { reviewer, laterThreads = [], laterReports = [], repo }) {
  const replies = info.replies.filter((c) => !/<!--\s*mivo-watcher-receipt\b/.test(String(c.body ?? '')));
  if (replies.some((c) => parseRulingReason(c.body) !== null)) return 'ruled-keep';
  const issues = new Set((parseDeferrals(pr.body, { repo, pr: pr.number }).entries ?? []).map((e) => e.issue));
  if (issues.size && replies.some((c) => [...String(c.body ?? '').matchAll(/#(\d{1,7})(?!\d)/g)].some((m) => issues.has(Number(m[1]))))) return 'deferred';
  const raisedAgain = laterThreads.some((t) => t.keyOf === info.keyOf);
  if (raisedAgain) return 're-raised';
  if (replies.some((c) => lower(c.author) === lower(pr.author))) return 'rebutted';
  if (info.thread.isResolved) {
    const markerHead = info.marker?.head;
    const later = laterReports.some((r) => (markerHead
      ? !String(r.commitOid ?? headOfReport(r.body) ?? '').startsWith(markerHead)
      : time(r.submittedAt) > info.createdAt + 1000));
    if (later) return 'fixed-proxy';
  }
  return 'unknown';
}

const classOf = (info) => info.marker?.bugClass || String(info.thread.path ?? '(无路径)').split('/').slice(0, -1).join('/') || '(根目录)';

// ── 回滚候选 ────────────────────────────────────────────────────────────────
export function findReverts(prs, reviewer) {
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const out = [];
  for (const pr of prs) {
    if (!(/^revert\b/i.test(pr.title) || /This reverts commit/i.test(pr.body))) continue;
    let original = null;
    const ref = /Reverts\s+[\w.-]+\/[\w.-]+#(\d+)/i.exec(pr.body)?.[1];
    if (ref) original = Number(ref);
    else {
      const name = /^Revert\s+"(.+)"/i.exec(pr.title)?.[1];
      if (name) original = prs.find((p) => p.number !== pr.number && p.title === name)?.number ?? null;
    }
    const target = original != null ? byNumber.get(original) : null;
    const last = target ? reportsOf(target, reviewer).at(-1) : null;
    const line = last ? overallLine(last.body) : null;
    out.push({ revertPr: pr.number, originalPr: original, originalInWindow: Boolean(target),
      conclusion: line ? (/^pass\b/.test(line) ? 'pass' : /^changes-requested\b/.test(line) ? 'changes-requested' : null) : null,
      tier: last ? tierOfReport(last.body) : null });
  }
  return out;
}

// ── 审查耗时(#189) ─────────────────────────────────────────────────────────
/** 第 q 分位(nearest-rank:排序后取第 ceil(q·n) 个);空数组返回 null。 */
export function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1];
}

/** 成功的 workflow run → 时长(分钟,从 run_started_at 到 updated_at)的 p50 / p90,保留一位小数。 */
export function durationStats(runs) {
  const minutes = (runs ?? []).filter((r) => r?.conclusion === 'success')
    .map((r) => (time(r.updatedAt) - time(r.startedAt)) / 60_000)
    .filter((m) => Number.isFinite(m) && m >= 0);
  return { count: minutes.length, p50: round1(percentile(minutes, 0.5)), p90: round1(percentile(minutes, 0.9)) };
}

const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

// ── 同版本重审(#232) ───────────────────────────────────────────────────────
/** 收口补跑的报告:同一 head 上的合理重审,不算白跑。 */
export const FINAL_FULL_RETRY_MARK = '收口全量:补跑';

/**
 * 同一代码版本(commit)上审查机又发了一份要跑模型的报告。「本轮沿用」不跑模型,reportsOf 已排除。
 * 前后两份都是 Request Changes 记「打回后又打回」(白跑:代码没变、结论没变);其余记「放行类重复」。收口补跑不计入。
 * 给了 since / until(YYYY-MM-DD,按 UTC 整天,与 PR 查询的 updated 口径一致)时,只数「后一份报告」提交时间落在窗口内的事件;
 * 窗口之前同一版本的报告只作比较基准,不计数(PR 按 updated 选进来,但它的评审是整个生命周期的)。
 */
export function sameHeadRepeatOf(prs, reviewer, { since = null, until = null } = {}) {
  const from = since ? Date.parse(`${since}T00:00:00Z`) : -Infinity;
  const to = until ? Date.parse(`${until}T23:59:59.999Z`) : Infinity;
  const inWindow = (r) => { const t = time(r.submittedAt); return t >= from && t <= to; };
  const out = { reports: 0, rejectAfterReject: 0, passLike: 0, excludedFinalFull: 0, prs: [] };
  for (const pr of prs ?? []) {
    const reports = reportsOf(pr, reviewer);
    out.reports += reports.filter(inWindow).length;
    const byHead = new Map();
    for (const r of reports) {
      const head = r.commitOid ?? headOfReport(r.body);
      if (!head) continue;
      byHead.set(head, [...(byHead.get(head) ?? []), r]);
    }
    let repeats = 0;
    for (const list of byHead.values()) {
      for (let i = 1; i < list.length; i += 1) {
        if (!inWindow(list[i])) continue;
        if (String(list[i].body).includes(FINAL_FULL_RETRY_MARK)) { out.excludedFinalFull += 1; continue; }
        if (list[i - 1].state === 'CHANGES_REQUESTED' && list[i].state === 'CHANGES_REQUESTED') { out.rejectAfterReject += 1; repeats += 1; } else out.passLike += 1;
      }
    }
    if (repeats) out.prs.push({ pr: pr.number, rejectAfterReject: repeats });
  }
  out.prs = out.prs.sort((a, b) => b.rejectAfterReject - a.rejectAfterReject || a.pr - b.pr).slice(0, 10);
  return out;
}

// ── 分阶段耗时(#232) ───────────────────────────────────────────────────────
export const PHASES = ['prepare', 'model', 'publish', 'other'];

/** review-pr.yml 的步骤名 → 阶段。对照表之外的步骤(准备 job、发令牌、镜像状态等)归 other。 */
export function phaseOfStep(name) {
  const n = String(name ?? '');
  if (/^Prepare\b/.test(n) || /^Dependencies and security scan\b/.test(n)) return 'prepare';
  if (/^Review with Codex\b/.test(n)) return 'model';
  if (/^Publish\b/.test(n) || /^Upload result\b/.test(n)) return 'publish';
  return 'other';
}

/** 每次运行按阶段累加步骤时长(分钟),再取各阶段的 p50 / p90。起止时间缺失或倒挂的步骤跳过。 */
export function phaseDurationStats(runJobs) {
  const per = Object.fromEntries(PHASES.map((p) => [p, []]));
  let otherSteps = 0;
  for (const run of runJobs ?? []) {
    const sums = Object.fromEntries(PHASES.map((p) => [p, 0]));
    for (const job of run.jobs ?? []) {
      for (const step of job.steps ?? []) {
        if (!step.startedAt || !step.completedAt) continue;
        const ms = time(step.completedAt) - time(step.startedAt);
        if (!(ms >= 0)) continue;
        const phase = phaseOfStep(step.name);
        if (phase === 'other') otherSteps += 1;
        sums[phase] += ms / 60_000;
      }
    }
    for (const p of PHASES) per[p].push(sums[p]);
  }
  return { sample: (runJobs ?? []).length, otherSteps,
    ...Object.fromEntries(PHASES.map((p) => [p, { p50: round1(percentile(per[p], 0.5)), p90: round1(percentile(per[p], 0.9)) }])) };
}

// ── 同期分组(#232) ─────────────────────────────────────────────────────────
export const GROUPS = ['withParent', 'withTask', 'noTask'];

/**
 * 审查过的 PR 按「任务 issue：」行与该 issue 的父 issue 分三组,同一窗口内对照:
 * withParent = 任务 issue 挂在父 issue 下;withTask = 有任务 issue、没有父 issue(或读不到,计入 parentUnknown);noTask = 没写任务 issue。
 * 每组给 PR 数、平均轮数、五轮及以上占比、每个 PR 的报告数(这三项与 rounds-to-pass 一样按所选 PR 的整个生命周期算),
 * 以及按运行标题归到本组 PR 的成功运行耗时(只含窗口内创建的运行)。
 */
export function groupsOf(prs, { reviewer, repo, parents = {}, runs = [] }) {
  const runsByPr = new Map();
  for (const run of runs ?? []) if (run?.pr) runsByPr.set(run.pr, [...(runsByPr.get(run.pr) ?? []), run]);
  const acc = Object.fromEntries(GROUPS.map((g) => [g, { prs: 0, rounds: [], reports: 0, runs: [], parentUnknown: 0 }]));
  for (const pr of prs ?? []) {
    const reports = reportsOf(pr, reviewer);
    if (!reports.length) continue;
    const ref = taskIssueOf(pr.body, repo);
    const known = ref ? parents[`${String(ref.repo).toLowerCase()}#${ref.issue}`] : undefined;
    const group = !ref ? 'noTask' : known === true ? 'withParent' : 'withTask';
    const a = acc[group];
    a.prs += 1;
    a.rounds.push(roundsToPass(reports));
    a.reports += reports.length;
    a.runs.push(...(runsByPr.get(pr.number) ?? []));
    if (ref && known === undefined) a.parentUnknown += 1;
  }
  return Object.fromEntries(GROUPS.map((g) => {
    const a = acc[g];
    const s = summarize(a.rounds);
    return [g, { prs: a.prs, meanRounds: s.mean.value, fivePlus: s.fivePlus, reportsPerPr: a.prs ? Math.round((a.reports / a.prs) * 100) / 100 : null,
      duration: durationStats(a.runs), ...(g === 'withTask' ? { parentUnknown: a.parentUnknown } : {}) }];
  }));
}

// ── 人工标签(#232) ─────────────────────────────────────────────────────────
export const LABEL_VERDICTS = ['valid', 'invalid', 'uncertain'];

/** --labels 文件 → {labels} 或 {error}。每项 {pr, findingKey, verdict: valid|invalid|uncertain, reason?};同一 pr + key 后写的覆盖先写的。 */
export function parseLabels(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return { error: '--labels 文件不是合法 JSON' }; }
  if (!Array.isArray(raw)) return { error: '--labels 文件要是数组' };
  const labels = new Map();
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object') return { error: `--labels 第 ${i + 1} 项不是对象` };
    if (!Number.isInteger(item.pr) || item.pr < 1) return { error: `--labels 第 ${i + 1} 项的 pr 不是正整数` };
    if (typeof item.findingKey !== 'string' || !item.findingKey.trim() || item.findingKey.length > 200) return { error: `--labels 第 ${i + 1} 项的 findingKey 不合法` };
    if (!LABEL_VERDICTS.includes(item.verdict)) return { error: `--labels 第 ${i + 1} 项的 verdict 只能是 ${LABEL_VERDICTS.join(' / ')}` };
    labels.set(`${item.pr}|${item.findingKey.trim()}`, item.verdict);
  }
  return { labels };
}

// ── 漏报(#189,照 makecindy/cindy Review 北极星:合并后才发现的必改问题里,审查机提前发现了几成) ──
// 只认验收机的修正 issue(PraiseZhu/vigil docs/acceptance-session.md「修正标记与复用」);
// Ready 之后人或机器人的必改意见没有可靠信号判断「随后被修了」,不统计。
const CORRECTION_RE = /\[验收机\]\s*修正\s*·\s*总\s*([\w.-]+\/[\w.-]+)#(\d+)\s*·\s*项\s*([\w.-]+\/[\w.-]+)#(\d+)\s*SC(\d+)/;
const TASK_ISSUE_RE = /任务\s*issue[：:]\s*`?(?:([\w.-]+\/[\w.-]+))?#(\d+)/;

/** 修正 issue 正文 → {parent, itemRepo, itemIssue, sc};不是修正 issue 返回 null。 */
export function parseCorrectionMarker(body) {
  const m = CORRECTION_RE.exec(String(body ?? ''));
  if (!m) return null;
  return { parent: `${m[1]}#${m[2]}`, itemRepo: m[3], itemIssue: Number(m[4]), sc: Number(m[5]) };
}

/** PR 正文的「任务 issue：」行 → {repo, issue};同仓写法 repo 用默认仓。 */
export function taskIssueOf(body, defaultRepo) {
  const m = TASK_ISSUE_RE.exec(String(body ?? ''));
  return m ? { repo: m[1] ?? defaultRepo, issue: Number(m[2]) } : null;
}

/**
 * 每条修正 issue 反查「写了同一任务 issue、在修正 issue 创建前合并」的 PR;这些 PR 上审查机在合并前发的 finding thread 首帖提到同一 SC<k>
 * 记为已提前发现,否则记为漏报。找不到对应 PR 的单列 unmatched。代理指标:#134 之前审查不提 SC,基线的已提前发现预计为 0。
 */
/** 审查机在服务器上验不了的验证层(要本人手测、真机或付费调用)。 */
export const NOT_REVIEWER_LAYERS = ['manual', 'cindy-mac', 'cindy-windows', 'paid'];

/**
 * 修正 issue 的归属(#232):目标行写的验证层在 NOT_REVIEWER_LAYERS 里 → not-reviewer;
 * 「## 原因」里写了集成分支 / integration/(实现还在阶段分支、没进 main 就验收)→ acceptance-timing;其余返回 null,走原来的匹配。
 */
export function correctionAttribution(body) {
  const text = String(body ?? '');
  const layer = /验证[：:]\s*([a-z][a-z-]*)/.exec(text)?.[1] ?? null;
  if (layer && NOT_REVIEWER_LAYERS.includes(layer)) return 'not-reviewer';
  const reason = /##\s*原因\s*\n([\s\S]*?)(?=\n##\s|\n\[验收机\]|$)/.exec(text)?.[1] ?? '';
  if (/集成分支|integration\//.test(reason)) return 'acceptance-timing';
  return null;
}

export function missedStats(corrections, prs, { reviewer, repo }) {
  const out = { corrections: 0, caught: 0, missed: 0, unmatched: 0, notReviewer: 0, acceptanceTiming: 0, items: [] };
  for (const issue of corrections ?? []) {
    const marker = parseCorrectionMarker(issue.body);
    if (!marker || marker.itemRepo.toLowerCase() !== String(repo).toLowerCase()) continue;
    out.corrections += 1;
    const attribution = correctionAttribution(issue.body);
    if (attribution) {
      out[attribution === 'not-reviewer' ? 'notReviewer' : 'acceptanceTiming'] += 1;
      out.items.push({ correction: issue.number, item: `${marker.itemRepo}#${marker.itemIssue}`, sc: marker.sc, prs: [], result: attribution });
      continue;
    }
    const created = time(issue.createdAt);
    const owners = prs.filter((pr) => pr.merged && time(pr.mergedAt) <= created
      && ((ref) => ref && ref.repo.toLowerCase() === marker.itemRepo.toLowerCase() && ref.issue === marker.itemIssue)(taskIssueOf(pr.body, repo)));
    if (!owners.length) { out.unmatched += 1; out.items.push({ correction: issue.number, item: `${marker.itemRepo}#${marker.itemIssue}`, sc: marker.sc, prs: [], result: 'unmatched' }); continue; }
    const scRe = new RegExp(`(?<![A-Za-z0-9])SC${marker.sc}(?!\\d)`);
    const caught = owners.some((pr) => pr.threads.some((t) => { const info = toFindingThread(t, reviewer); return info && info.createdAt <= time(pr.mergedAt) && scRe.test(info.first.body ?? ''); }));
    out[caught ? 'caught' : 'missed'] += 1;
    out.items.push({ correction: issue.number, item: `${marker.itemRepo}#${marker.itemIssue}`, sc: marker.sc, prs: owners.map((p) => p.number), result: caught ? 'caught' : 'missed' });
  }
  return out;
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
export function analyze(prs, { reviewer, repo, includeText = false, labels = null }) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  // 去重(#232):同一 PR 里同一问题 key 跨轮重报只算一个问题;按桶各自去重(同一 key 可能先 re-raised 后 unknown)。
  const dedup = { threads: 0, findingKeys: 0 };
  const bucketKeys = Object.fromEntries(BUCKETS.map((b) => [b, new Set()]));
  const seenKeys = new Set();
  const classes = new Map();
  const perPr = [];
  const texts = [];
  const rounds = [];
  const verifier = { reports: 0, reportsWithOverruled: 0, prsWithOverruled: 0, refuted: 0, downgraded: 0 };
  const verifierLines = [];
  for (const pr of prs) {
    const reports = reportsOf(pr, reviewer);
    if (!reports.length) continue;
    const infos = pr.threads.map((t) => toFindingThread(t, reviewer)).filter(Boolean);
    const n = roundsToPass(reports);
    rounds.push(n);
    const perRound = reports.map((r, i) => ({ round: i + 1, ...parseVerifierSections(r.body) }));
    const prVerifier = { refuted: perRound.reduce((a, r) => a + r.refuted, 0), downgraded: perRound.reduce((a, r) => a + r.downgraded, 0),
      rounds: perRound.map(({ round, refuted, downgraded }) => ({ round, refuted, downgraded })) };
    verifier.reports += reports.length;
    verifier.reportsWithOverruled += perRound.filter((r) => r.refuted + r.downgraded > 0).length;
    verifier.refuted += prVerifier.refuted;
    verifier.downgraded += prVerifier.downgraded;
    if (prVerifier.refuted + prVerifier.downgraded > 0) verifier.prsWithOverruled += 1;
    if (includeText) for (const r of perRound) for (const line of r.lines) verifierLines.push({ pr: pr.number, round: r.round, kind: line.kind, text: line.text });
    const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    for (const info of infos) {
      const laterThreads = infos.filter((o) => o !== info && o.createdAt > info.createdAt);
      const laterReports = reports.filter((r) => time(r.submittedAt) > info.createdAt + 1000);
      const bucket = classifyThread(pr, info, { reviewer, laterThreads, laterReports, repo });
      counts[bucket] += 1;
      buckets[bucket] += 1;
      bucketKeys[bucket].add(`${pr.number}|${info.keyOf}`);
      seenKeys.add(`${pr.number}|${info.keyOf}`);
      const cls = classOf(info);
      const entry = classes.get(cls) ?? { class: cls, total: 0, ...Object.fromEntries(BUCKETS.map((b) => [b, 0])) };
      entry.total += 1;
      entry[bucket] += 1;
      classes.set(cls, entry);
      if (includeText) texts.push({ pr: pr.number, bucket, severity: info.severity, path: info.thread.path, class: cls, body: info.first.body, replies: info.replies.map((c) => ({ author: c.author, body: c.body })) });
    }
    const findingKeys = new Set(infos.map((info) => info.keyOf)).size;
    dedup.threads += infos.length;
    dedup.findingKeys += findingKeys;
    perPr.push({ pr: pr.number, reports: reports.length, roundsToPass: n, findingThreads: infos.length, findingKeys, buckets: counts, verifier: prVerifier });
  }
  // 人工口径(#232):只数窗口里真的出现过的 pr + key;invalid 记为人工确认的噪音。
  let human = null;
  if (labels) {
    human = { labeled: labels.size, matched: 0, valid: 0, invalid: 0, uncertain: 0 };
    for (const [key, verdict] of labels) {
      if (!seenKeys.has(key)) continue;
      human.matched += 1;
      human[verdict] += 1;
    }
  }
  return {
    reviewedPrs: perPr.length, buckets, perPr, roundsToPass: summarize(rounds), verifier,
    dedup: { ...dedup, bucketKeys: Object.fromEntries(BUCKETS.map((b) => [b, bucketKeys[b].size])) },
    ...(human ? { human } : {}),
    reverts: findReverts(prs, reviewer),
    topClasses: [...classes.values()].sort((a, b) => b.total - a.total || a.class.localeCompare(b.class)).slice(0, 10),
    ...(includeText ? { threads: texts, verifierLines } : {}),
  };
}

/** 噪音代理:维护者裁定不改 + 作者申辩。 */
export const noiseOf = (buckets) => (buckets?.['ruled-keep'] ?? 0) + (buckets?.rebutted ?? 0);

export function renderMarkdown(report) {
  const { window, analysis: a } = report;
  const frac = (x) => `${x.numerator}/${x.denominator}`;
  const lines = [
    `# 审查机结果遥测 · ${window.repo} · ${window.since} ~ ${window.until}`, '',
    `> ${NOTE}。下面每个桶都是代理指标。`, '',
    `审查过的 PR:${a.reviewedPrs} 个(审查账号 @${window.reviewer});有 ${report.truncated.nested} 个 PR 的评审或 thread 超过一页,只算了第一页。`,
    ...(report.truncated.prs ? [`警告:窗口内 PR 超过 --max-prs ${window.maxPrs},只统计了前 ${window.maxPrs} 个;漏报的 unmatched 可能偏多。`] : []), '',
    '## 作者反应分桶(代理指标)', '', '| 桶 | thread 数 |', '|---|---|',
    ...BUCKETS.map((b) => `| ${b}(代理指标) | ${a.buckets[b]} |`), '',
    `噪音(代理指标) = ruled-keep + rebutted = ${noiseOf(a.buckets)}`, '',
    ...(report.durations ? ['## 审查耗时', '', `- ${window.workflow ?? 'review-pr.yml'} 成功运行 ${report.durations.count} 次:p50 ${report.durations.p50 ?? '无'} 分钟,p90 ${report.durations.p90 ?? '无'} 分钟(从开始运行到结束,含排队后的执行)`,
      ...(report.truncated.runs ? ['- 警告:运行没读全(GitHub 一次最多给 1000 条),只统计了读到的部分。'] : []), ''] : []),
    ...(report.missed ? ['## 漏报(北极星,代理指标)', '',
      `- 验收机修正 issue ${report.missed.corrections} 条:审查机合并前已提过同一 SC ${report.missed.caught} 条,漏报 ${report.missed.missed} 条,反查不到对应 PR ${report.missed.unmatched} 条`,
      '- 只认验收机修正 issue;「已提前发现」看审查机在合并前发的 finding thread 首帖是否提到同一 SC<k>。',
      ...(report.missed.notReviewer !== undefined ? [`- 不归审查机的(不进上面三项):审查机验不了的验证层(${NOT_REVIEWER_LAYERS.join(' / ')})${report.missed.notReviewer} 条;实现还在集成分支、验收时机不对 ${report.missed.acceptanceTiming} 条`] : []),
      ...(report.truncated.corrections ? ['- 警告:修正 issue 没读全(GitHub 一次最多给 1000 条),只统计了读到的部分。'] : []), ''] : []),
    ...(report.sameHeadRepeat ? ['## 同一版本重审', '',
      `- 窗口内审查机跑过模型的报告 ${report.sameHeadRepeat.reports} 份;窗口内同一 commit 上「打回后又打回」${report.sameHeadRepeat.rejectAfterReject} 次(代码没变、结论没变),其余同版本重复 ${report.sameHeadRepeat.passLike} 次;收口补跑 ${report.sameHeadRepeat.excludedFinalFull} 次不计入`,
      ...(report.sameHeadRepeat.prs.length ? [`- 最多的 PR:${report.sameHeadRepeat.prs.map((p) => `#${p.pr} ${p.rejectAfterReject} 次`).join('、')}`] : []), ''] : []),
    ...(report.phaseDurations ? ['## 分阶段耗时', '',
      `- 样本:最近 ${report.phaseDurations.sample} 次成功运行(上限 ${MAX_PHASE_RUNS})${report.phaseDurations.failed ? `,另有 ${report.phaseDurations.failed} 次读步骤失败` : ''};对照表外的步骤 ${report.phaseDurations.otherSteps} 个计入「其他」`,
      '| 阶段 | p50(分钟) | p90(分钟) |', '|---|---|---|',
      ...PHASES.map((p) => `| ${{ prepare: '准备', model: '模型', publish: '发布', other: '其他' }[p]} | ${report.phaseDurations[p].p50 ?? '无'} | ${report.phaseDurations[p].p90 ?? '无'} |`), ''] : []),
    ...(report.groups ? ['## 同期分组对照', '',
      '| 组 | PR 数 | 平均轮数 | 五轮及以上 | 每个 PR 的报告数 | 单次耗时 p50(分钟) |', '|---|---|---|---|---|---|',
      ...GROUPS.map((g) => { const x = report.groups[g]; return `| ${{ withParent: '有总 issue', withTask: '只有任务 issue', noTask: '没写任务 issue' }[g]} | ${x.prs} | ${x.meanRounds ?? '无'} | ${x.fivePlus.numerator}/${x.fivePlus.denominator} | ${x.reportsPerPr ?? '无'} | ${x.duration.p50 ?? '无'} |`; }),
      ...(report.groups.withTask.parentUnknown ? [`- 「只有任务 issue」里有 ${report.groups.withTask.parentUnknown} 个 PR 的父 issue 没读到,按没有父 issue 计。`] : []), ''] : []),
    ...(a.dedup ? ['## 按问题去重', '',
      `- finding thread ${a.dedup.threads} 条,去重后 ${a.dedup.findingKeys} 个问题(同一 PR 同一 key 跨轮重报只算一个)`,
      `- 各桶去重后:${BUCKETS.map((b) => `${b} ${a.dedup.bucketKeys[b]}`).join('、')}`, ''] : []),
    ...(a.human ? ['## 人工口径(--labels)', '',
      `- 标注 ${a.human.labeled} 条,窗口内对上 ${a.human.matched} 条:成立 ${a.human.valid}、不成立 ${a.human.invalid}(人工确认的噪音)、拿不准 ${a.human.uncertain}`, ''] : []),
    '## rounds-to-pass', '',
    `- 一轮通过:${frac(a.roundsToPass.onePass)}(分母是最终通过的 PR 数)`,
    `- 五轮及以上才通过:${frac(a.roundsToPass.fivePlus)}`,
    `- 平均轮数:${a.roundsToPass.mean.value ?? '无'}(分母 ${a.roundsToPass.mean.denominator})`,
    `- 一直没通过(记 null):${a.roundsToPass.nullCount} 个`, '',
    '## 核对员推翻/降级（从已发布的审查报告里数）', '',
    `- 推翻（refuted）：${a.verifier.refuted} 条；降级（downgraded）：${a.verifier.downgraded} 条`,
    `- 有推翻/降级的 PR：${a.verifier.prsWithOverruled}/${a.reviewedPrs}；有推翻/降级的报告：${a.verifier.reportsWithOverruled}/${a.verifier.reports}`,
    '- 报告里没有 finding key：同一问题跨轮被重复推翻会在每一轮各算一次；这里只有计数。', '',
    '## 回滚候选', '',
    ...(a.reverts.length ? a.reverts.map((r) => `- #${r.revertPr} 回滚 ${r.originalPr ? `#${r.originalPr}` : '(找不到原 PR)'}${r.originalInWindow ? '' : '(原 PR 不在窗口内)'},审查结论 ${r.conclusion ?? '未知'},档位 ${r.tier ?? '未知'}`) : ['- 无']), '',
    '## 高频问题类型 Top 10', '',
    ...(a.topClasses.length ? a.topClasses.map((c) => `- ${c.class}:${c.total} 条(${BUCKETS.filter((b) => c[b]).map((b) => `${b} ${c[b]}`).join('、')})`) : ['- 无']), '',
  ];
  return `${lines.join('\n')}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(parsed.error); return 2; }
  const { options } = parsed;
  let labels = null;
  if (options.labels) {
    let text;
    try { text = readFileSync(options.labels, 'utf8'); } catch (error) { console.error(`--labels 读不到:${String(error.message).slice(0, 120)}`); return 2; }
    const read = parseLabels(text);
    if (read.error) { console.error(read.error); return 2; }
    labels = read.labels;
  }
  let data;
  try {
    if (options.fixture) {
      const fixture = JSON.parse(readFileSync(options.fixture, 'utf8'));
      data = { prs: fixture.prs ?? [], truncated: { nested: 0, prs: false, runs: false, corrections: false }, runs: fixture.runs ?? null, corrections: fixture.corrections ?? null,
        runJobs: fixture.runJobs ? { runJobs: fixture.runJobs, failed: 0 } : null, parents: fixture.parents ?? {} };
    } else {
      const { prs, truncated } = fetchPrs(options);
      const runs = fetchRuns(options);
      const corrections = fetchCorrections(options);
      const runJobs = fetchRunJobs({ repo: options.repo, runs: runs.runs });
      const refs = prs.map((pr) => taskIssueOf(pr.body, options.repo)).filter(Boolean);
      const parents = fetchParents(refs);
      if (runJobs.failed) console.error(`警告:${runJobs.failed} 次运行的步骤没读到,分阶段耗时只按读到的部分统计`);
      if (parents.failed) console.error(`警告:${parents.failed} 个任务 issue 的父 issue 没读到,分组时按没有父 issue 计`);
      data = { prs, truncated: { ...truncated, runs: runs.truncated, corrections: corrections.truncated }, runs: runs.runs, corrections: corrections.corrections, runJobs, parents: parents.parents };
    }
    if (data.truncated.prs) console.error(`警告:窗口内 PR 超过 --max-prs ${options.maxPrs},只统计了前 ${options.maxPrs} 个;漏报的 unmatched 可能偏多`);
    if (data.truncated.runs) console.error('警告:workflow 运行没读全(GitHub 一次最多给 1000 条),耗时只按读到的部分统计');
    if (data.truncated.corrections) console.error('警告:验收机修正 issue 没读全(GitHub 一次最多给 1000 条),漏报只按读到的部分统计');
  } catch (error) {
    console.error(error.message);
    return error.code === 3 ? 3 : 1;
  }
  const analysis = analyze(data.prs, { reviewer: options.reviewer, repo: options.repo, includeText: options.includeText, labels });
  const report = { note: NOTE, window: { repo: options.repo, since: options.since, until: options.until, reviewer: options.reviewer, maxPrs: options.maxPrs, workflow: options.workflow },
    prsRead: data.prs.length, truncated: data.truncated, analysis, noise: noiseOf(analysis.buckets),
    durations: data.runs ? durationStats(data.runs) : null,
    missed: data.corrections ? missedStats(data.corrections, data.prs, { reviewer: options.reviewer, repo: options.repo }) : null,
    sameHeadRepeat: sameHeadRepeatOf(data.prs, options.reviewer, { since: options.since, until: options.until }),
    phaseDurations: data.runJobs ? { ...phaseDurationStats(data.runJobs.runJobs), failed: data.runJobs.failed } : null,
    groups: groupsOf(data.prs, { reviewer: options.reviewer, repo: options.repo, parents: data.parents ?? {}, runs: data.runs ?? [] }),
    ...(analysis.human ? { noiseHuman: analysis.human.invalid } : {}) };
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'outcomes.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(options.out, 'outcomes.md'), renderMarkdown(report));
  console.log(`已写入 ${join(options.out, 'outcomes.json')} 与 outcomes.md(读了 ${data.prs.length} 个 PR)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
