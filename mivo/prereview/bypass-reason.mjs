#!/usr/bin/env node
// bypass-reason.mjs — 绕过必需检查合入、又没写原因的 PR,在 PR 上提醒一次(由 round.mjs 每轮调用,一小时最多真正扫一次)。
//
//   node mivo/prereview/bypass-reason.mjs --sweep --repo <owner/repo> --state-dir <状态目录> [--dry-run]
//
// 判定规则在 ../lib/bypass.mjs(纯函数)。这里只管读写:
//   - 状态文件 <state-dir>/mivo/bypass-reminders.json:{ since, lastSweepAt, reminded: { <pr>: { at, commentUrl } }, checked: { <after_sha>: <pushed_at> } }
//   - checked 记下已经判定完的规则集记录(已提醒、已有原因、找不到 PR),下一轮跳过它们,单轮 20 条的反查预算才会往后推进;
//     因为预算用完或单轮 5 条提醒用完而没处理到的不记,下一轮接着查;超过 8 天(接口只返回最近一周)的记录从 checked 清掉
//   - 第一次运行只写 since = 现在就退出,只管上线以后的绕过,不回头提醒旧 PR
//   - 距 lastSweepAt 不到 1 小时:直接 skipped: 'throttled';每次真正扫描,不论成败,都先更新 lastSweepAt,出错时不会每轮重试
//   - 读 GitHub 只用 REST(不占 GraphQL 额度);读失败输出 ok:false 加原因,不发任何评论
//   - 发一条评论就立刻写回 reminded 并保存,再发下一条:中途崩溃不会重复提醒
//   - --dry-run:只读,不发评论,也不写状态文件
// stdout 只输出一行 JSON:{ ok, reminded: [pr], skipped: [...], error? };读 GitHub 失败时退出码仍为 0。
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from '../lib/common.mjs';
import { selectBypassSuites, toBypassReminders, toReminderBody } from '../lib/bypass.mjs';

export const SWEEP_EVERY_MS = 60 * 60_000;
export const CHECKED_KEEP_MS = 8 * 24 * 60 * 60_000; // 接口只返回最近一周的记录,多留一天
// 判定完的几种结果(见 toBypassReminders 的 skipped.why);over-limit 是没轮到,不算判定完
const SETTLED = new Set(['no-pr', 'duplicate', 'reminded', 'has-reason']);
const MAX_PR_LOOKUPS = 20; // 单次最多反查这么多条规则集记录对应的 PR,余下的下一次再查
const stateFileOf = (stateDir) => join(stateDir, 'mivo', 'bypass-reminders.json');

/** 真实的 gh:返回 { ok, stdout, stderr }。 */
export function ghCli(args, { input } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', input, timeout: 45_000, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? '', stderr: String(r.stderr || r.error?.message || '').trim() };
}

const fail = (error) => ({ ok: false, error: String(error).slice(0, 300) });

function readSuites(gh, repo) {
  const r = gh(['api', `repos/${repo}/rulesets/rule-suites?ref=refs/heads/main&rule_suite_result=bypass&time_period=week&per_page=100`]);
  if (!r.ok) throw new Error(`读规则集记录失败:${r.stderr}`);
  const suites = JSON.parse(r.stdout);
  if (!Array.isArray(suites)) throw new Error('规则集记录不是数组');
  return suites;
}

function readPrNumber(gh, repo, sha) {
  const r = gh(['api', `repos/${repo}/commits/${sha}/pulls`]);
  if (!r.ok) throw new Error(`反查 ${sha.slice(0, 7)} 对应的 PR 失败:${r.stderr}`);
  const list = JSON.parse(r.stdout);
  const first = Array.isArray(list) ? list[0] : null;
  return Number.isInteger(first?.number) ? first.number : null;
}

function readComments(gh, repo, pr) {
  const r = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments`]);
  if (!r.ok) throw new Error(`读 #${pr} 的评论失败:${r.stderr}`);
  return JSON.parse(r.stdout).flat();
}

/**
 * @param gh (args, { input }) => { ok, stdout, stderr }
 * @param now 毫秒时间戳
 */
export function sweep({ repo, stateDir, gh = ghCli, now = Date.now(), dryRun = false, readState = readJson, writeState = writeJson }) {
  const file = stateFileOf(stateDir);
  const state = readState(file, null);
  const at = new Date(now).toISOString();
  if (!state?.since) {
    if (!dryRun) writeState(file, { since: at, lastSweepAt: null, reminded: {} });
    return { ok: true, initialized: true, since: at, reminded: [], skipped: [] };
  }
  const last = Date.parse(state.lastSweepAt ?? '');
  if (Number.isFinite(last) && now - last < SWEEP_EVERY_MS) return { ok: true, skipped: 'throttled', reminded: [] };
  const reminded = { ...(state.reminded ?? {}) };
  const checked = toCheckedWithinWindow(state.checked, now);
  // 先记扫描时间:读 GitHub 失败也不会每轮重试
  const save = () => { if (!dryRun) writeState(file, { ...state, lastSweepAt: at, reminded, checked }); };
  save();
  let plan;
  let pending;
  try {
    const suites = readSuites(gh, repo);
    // 已判定完的跳过,剩下的取最早的 MAX_PR_LOOKUPS 条:预算每轮往后推进,不会一直卡在最早的那批
    pending = selectBypassSuites({ suites, since: state.since }).filter((suite) => !Object.hasOwn(checked, suite.after_sha)).slice(0, MAX_PR_LOOKUPS);
    const prBySha = {};
    const commentsByPr = {};
    for (const entry of pending) {
      const pr = readPrNumber(gh, repo, entry.after_sha);
      if (!pr) continue;
      prBySha[entry.after_sha] = pr;
      if (!Object.hasOwn(reminded, String(pr)) && !Object.hasOwn(commentsByPr, pr)) commentsByPr[pr] = readComments(gh, repo, pr);
    }
    plan = toBypassReminders({ suites: pending, prBySha, commentsByPr, reminded, since: state.since });
  } catch (error) {
    return { ...fail(error.message), reminded: [], skipped: [] };
  }
  if (dryRun) return { ok: true, dryRun: true, wouldRemind: plan.remind.map((r) => r.pr), reminded: [], skipped: plan.skipped };
  const pushedAtOf = new Map(pending.map((suite) => [suite.after_sha, suite.pushed_at]));
  for (const item of plan.skipped) if (SETTLED.has(item.why)) checked[item.sha] = pushedAtOf.get(item.sha);
  save();
  const done = [];
  for (const item of plan.remind) {
    const posted = gh(['api', `repos/${repo}/issues/${item.pr}/comments`, '-f', `body=${toReminderBody({ actor: item.actor })}`]);
    if (!posted.ok) {
      // 一条发不出去就停(多半是限额或权限):没写进 reminded 的下次再来,已写的不会重复
      return { ...fail(`在 #${item.pr} 上发提醒失败:${posted.stderr}`), reminded: done, skipped: plan.skipped };
    }
    let commentUrl = null;
    try { commentUrl = JSON.parse(posted.stdout)?.html_url ?? null; } catch { /* 评论已发出,链接没有也要记账 */ }
    reminded[String(item.pr)] = { at: new Date().toISOString(), commentUrl };
    checked[item.sha] = item.at;
    save();
    done.push(item.pr);
  }
  return { ok: true, reminded: done, skipped: plan.skipped };
}

/** checked 里只留最近 CHECKED_KEEP_MS 内的记录(值是该记录的 pushed_at);读不懂时间的也清掉。 */
function toCheckedWithinWindow(checked, now) {
  const kept = {};
  for (const [sha, pushedAt] of Object.entries(checked ?? {})) {
    if (now - Date.parse(pushedAt) <= CHECKED_KEEP_MS) kept[sha] = pushedAt;
  }
  return kept;
}

function main() {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
  if (!process.argv.includes('--sweep') || !arg('repo') || !arg('state-dir')) {
    console.error('用法: bypass-reason.mjs --sweep --repo <owner/repo> --state-dir <目录> [--dry-run]');
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = sweep({ repo: arg('repo'), stateDir: arg('state-dir'), dryRun: process.argv.includes('--dry-run') });
  } catch (error) {
    result = { ...fail(error.message), reminded: [], skipped: [] };
  }
  console.log(JSON.stringify(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
