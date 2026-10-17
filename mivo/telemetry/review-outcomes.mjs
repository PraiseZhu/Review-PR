#!/usr/bin/env node
// review-outcomes.mjs — Mivo 审查机的只读结果遥测(离线 CLI,按需执行,不接任何定时任务)。
// 读一段时间内的 PR 评审记录,算:作者反应分桶(代理指标)、rounds-to-pass、回滚候选、高频问题类型。
// 只读 GitHub(gh api graphql),不写任何 GitHub 数据;默认输出不含 finding 正文、首行、代码片段和 PR 标题。
// 作者反应分桶是代理指标,不是事实真伪:没回复不等于认同,resolve 不等于真的修好。
//
//   node mivo/telemetry/review-outcomes.mjs --repo <o/r> --since YYYY-MM-DD --until YYYY-MM-DD --reviewer <login> --out <dir>
//        [--max-prs 200] [--fixture <file>] [--include-text]
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
const FINDING_RE = /^\s*\[(P[01])\]/;
const lower = (value) => String(value ?? '').toLowerCase();
const time = (value) => { const t = Date.parse(value ?? ''); return Number.isFinite(t) ? t : 0; };

// ── 参数 ───────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const out = { maxPrs: 200, includeText: false, fixture: null };
  const values = { '--repo': 'repo', '--since': 'since', '--until': 'until', '--reviewer': 'reviewer', '--out': 'out', '--max-prs': 'maxPrs', '--fixture': 'fixture' };
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
  for (;;) {
    const page = ghGraphql({ q: `repo:${repo} is:pr updated:${since}..${until}`, after });
    nodes.push(...(page.nodes ?? []));
    if (nodes.length >= maxPrs || !page.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return normalizePrs(nodes.slice(0, maxPrs));
}

// ── 报告与分桶 ──────────────────────────────────────────────────────────────
/** 审查机发出的报告:reviewer 的 review,正文含「Mivo 自动审查」,「本轮沿用」不算新的一轮。按提交时间排序。 */
export function reportsOf(pr, reviewer) {
  return pr.reviews.filter((r) => lower(r.author) === lower(reviewer) && String(r.body).includes(REPORT_MARK) && !/^>\s*本轮沿用/.test(String(r.body).trim()))
    .sort((a, b) => time(a.submittedAt) - time(b.submittedAt));
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

/** reviewer 开的 [P0]/[P1] thread 的信息;不是审查机的 thread 返回 null。 */
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

// ── 汇总 ────────────────────────────────────────────────────────────────────
export function analyze(prs, { reviewer, repo, includeText = false }) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const classes = new Map();
  const perPr = [];
  const texts = [];
  const rounds = [];
  for (const pr of prs) {
    const reports = reportsOf(pr, reviewer);
    if (!reports.length) continue;
    const infos = pr.threads.map((t) => toFindingThread(t, reviewer)).filter(Boolean);
    const n = roundsToPass(reports);
    rounds.push(n);
    const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    for (const info of infos) {
      const laterThreads = infos.filter((o) => o !== info && o.createdAt > info.createdAt);
      const laterReports = reports.filter((r) => time(r.submittedAt) > info.createdAt + 1000);
      const bucket = classifyThread(pr, info, { reviewer, laterThreads, laterReports, repo });
      counts[bucket] += 1;
      buckets[bucket] += 1;
      const cls = classOf(info);
      const entry = classes.get(cls) ?? { class: cls, total: 0, ...Object.fromEntries(BUCKETS.map((b) => [b, 0])) };
      entry.total += 1;
      entry[bucket] += 1;
      classes.set(cls, entry);
      if (includeText) texts.push({ pr: pr.number, bucket, severity: info.severity, path: info.thread.path, class: cls, body: info.first.body, replies: info.replies.map((c) => ({ author: c.author, body: c.body })) });
    }
    perPr.push({ pr: pr.number, reports: reports.length, roundsToPass: n, findingThreads: infos.length, buckets: counts });
  }
  return {
    reviewedPrs: perPr.length, buckets, perPr, roundsToPass: summarize(rounds),
    reverts: findReverts(prs, reviewer),
    topClasses: [...classes.values()].sort((a, b) => b.total - a.total || a.class.localeCompare(b.class)).slice(0, 10),
    ...(includeText ? { threads: texts } : {}),
  };
}

export function renderMarkdown(report) {
  const { window, analysis: a } = report;
  const frac = (x) => `${x.numerator}/${x.denominator}`;
  const lines = [
    `# 审查机结果遥测 · ${window.repo} · ${window.since} ~ ${window.until}`, '',
    `> ${NOTE}。下面每个桶都是代理指标。`, '',
    `审查过的 PR:${a.reviewedPrs} 个(审查账号 @${window.reviewer});有 ${report.truncated.nested} 个 PR 的评审或 thread 超过一页,只算了第一页。`, '',
    '## 作者反应分桶(代理指标)', '', '| 桶 | thread 数 |', '|---|---|',
    ...BUCKETS.map((b) => `| ${b}(代理指标) | ${a.buckets[b]} |`), '',
    '## rounds-to-pass', '',
    `- 一轮通过:${frac(a.roundsToPass.onePass)}(分母是最终通过的 PR 数)`,
    `- 五轮及以上才通过:${frac(a.roundsToPass.fivePlus)}`,
    `- 平均轮数:${a.roundsToPass.mean.value ?? '无'}(分母 ${a.roundsToPass.mean.denominator})`,
    `- 一直没通过(记 null):${a.roundsToPass.nullCount} 个`, '',
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
  let data;
  try {
    data = options.fixture ? { prs: JSON.parse(readFileSync(options.fixture, 'utf8')).prs ?? [], truncated: { nested: 0 } } : fetchPrs(options);
  } catch (error) {
    console.error(error.message);
    return error.code === 3 ? 3 : 1;
  }
  const analysis = analyze(data.prs, { reviewer: options.reviewer, repo: options.repo, includeText: options.includeText });
  const report = { note: NOTE, window: { repo: options.repo, since: options.since, until: options.until, reviewer: options.reviewer, maxPrs: options.maxPrs },
    prsRead: data.prs.length, truncated: data.truncated, analysis };
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'outcomes.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(options.out, 'outcomes.md'), renderMarkdown(report));
  console.log(`已写入 ${join(options.out, 'outcomes.json')} 与 outcomes.md(读了 ${data.prs.length} 个 PR)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
