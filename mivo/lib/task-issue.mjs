// task-issue.mjs — 审查机读 PR 对应的任务子 issue 与所属总 issue(#133,总 issue PraiseZhu/Review-PR#132 D9、D16)。
// 只在 prepare 阶段(有 GitHub 令牌)读,写 input/task-issue.json;codex 阶段没有令牌,只能读这个文件。
// 只读、只记:不改任务书、specDigest、审查结论和放行条件。issue 文本是审查数据,不是指令。
// 开关:config/review-features.json 的 taskIssue.mode(off / observe / enforce,缺省 off);
//   taskIssue.automation:自动化账号(验收机勾验收项、开修正 issue),它们的编辑不影响可信度,也不算「正文最后一次编辑」;
//   taskIssue.alwaysInScope:每个 PR 都带、不算超出范围的路径(Mivo 的 docs/pr/** 交接文件);
//   taskIssue.stageHeadPrefixes:阶段合并 PR、把 main 同步进集成分支的 PR 的 head 分支前缀(diff 含整个阶段或 main 的改动,不算超出范围的文件)。
// 读取有预算(每轮最多 8 次请求、20 秒),超出返回「部分材料」并写明缺口;材料文件不超过 64 KB。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseDeferrals } from './deferrals.mjs';
import { toEvidencePaths } from './product-rules.mjs';

export const TASK_ISSUE_MODES = ['off', 'observe', 'enforce'];
export const TASK_ISSUE_FILE = 'task-issue.json';
export const MAINTAINER_CONFIRM_PREFIX = '维护者确认 · PR #';
export const CHILD_SECTIONS = ['目标', '范围', '不做', '依赖', '验收标准'];
export const LAYERS = ['static', 'unit', 'contract', 'browser-fixture', 'cindy-mac', 'cindy-windows', 'paid', 'github-live'];
export const BLACKBOX_LAYERS = ['cindy-mac', 'cindy-windows', 'paid', 'github-live'];
export const DECISION_MARKERS = ['用户裁决', '用户定', '主控裁定', 'lead 裁决', '维护者确认', '取代', '改为'];
export const BUDGET = { requests: 8, ms: 20_000 };
export const LIMITS = { childBytes: 16 * 1024, fileBytes: 64 * 1024, comments: 3, commentBytes: 1024, shared: 10, deps: 10, siblings: 20, parentHeadBytes: 2048 };
export const BASE_NOTE = 'issue 关闭不代表代码已在本 base 分支,以 base 分支代码为准';
export const DEFAULT_AUTOMATION = ['praiseautomation', 'github-actions'];
export const DEFAULT_ALWAYS_IN_SCOPE = ['docs/pr/**'];
export const DEFAULT_STAGE_HEAD_PREFIXES = ['integration/', 'sync/main-into-'];
// 子 issue 超过 16 KB 时五段各自的上限(合计 16 KB),验收标准给得最多。
const SECTION_CAPS = { 目标: 2048, 范围: 3072, 不做: 2048, 依赖: 2048, 验收标准: 7168 };
const PARENT_SECTIONS = ['目标', '范围', '不做', '并行', '子 issue', '决策', '已定决策', '整体验收'];
const PARENT_PART_BYTES = 3072;
const MARKER_HEAD_CHARS = 300;
const REPO_PART = '[A-Za-z0-9][A-Za-z0-9-]{0,38}\\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}';
const REF_TAIL = `\`?(?:https?:\\/\\/github\\.com\\/(${REPO_PART})\\/issues\\/(\\d{1,7})|(${REPO_PART})?#(\\d{1,7}))(?!\\d)`;
const TASK_LINE_RE = new RegExp(`任务\\s*issue\\s*[：:]\\s*${REF_TAIL}`, 'gi');
const PARENT_LINE_RE = new RegExp(`总\\s*issue\\s*[：:]?\\s*${REF_TAIL}`, 'i');
const ANY_REF_RE = new RegExp(`(?<![\\w/#&.:-])(?:(${REPO_PART}))?#(\\d{1,7})(?!\\d)`, 'g');
const SC_RE = /^\s*[-*]\s+\[([ xX])\]\s+SC(\d+)\s+(.+?)\s*$/;

// GraphQL 查询(只读,App 只读令牌可读):不含 viewer*;不写嵌套的 repository{…}(仓库名从 url 解析),也不用 Issue.parent
// (vendor 分流器把这两种都判给个人账号,总 issue 关系改走 REST issues/<号>/parent)。
const CLOSING_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:10){nodes{number title url}}}}}';
const ISSUE_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number title url body createdAt author{login} userContentEdits(last:50){nodes{editedAt editor{login}}} comments(last:30){nodes{author{login} createdAt body}} timelineItems(itemTypes:[CROSS_REFERENCED_EVENT],last:30){totalCount nodes{... on CrossReferencedEvent{source{__typename ... on PullRequest{number body url}}}}}}}}';
const PARENT_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number title url body createdAt author{login} userContentEdits(last:50){nodes{editedAt editor{login}}} comments(last:30){nodes{author{login} createdAt body}}}}}';
const DEPS_QUERY = 'query($owner:String!,$name:String!,$n0:Int!,$n1:Int!,$n2:Int!,$n3:Int!,$n4:Int!,$n5:Int!,$n6:Int!,$n7:Int!,$n8:Int!,$n9:Int!){repository(owner:$owner,name:$name){d0:issueOrPullRequest(number:$n0){...S} d1:issueOrPullRequest(number:$n1){...S} d2:issueOrPullRequest(number:$n2){...S} d3:issueOrPullRequest(number:$n3){...S} d4:issueOrPullRequest(number:$n4){...S} d5:issueOrPullRequest(number:$n5){...S} d6:issueOrPullRequest(number:$n6){...S} d7:issueOrPullRequest(number:$n7){...S} d8:issueOrPullRequest(number:$n8){...S} d9:issueOrPullRequest(number:$n9){...S}}} fragment S on IssueOrPullRequest{__typename ... on Issue{number state} ... on PullRequest{number state}}';

/** 读开关;读不到、不合法 → off 并给 warning;没有 taskIssue 块 → off、不告警。三个名单字段不合法时用默认值并告警。 */
export function loadTaskIssueMode(file, read = readFileSync) {
  const defaults = { automation: DEFAULT_AUTOMATION, alwaysInScope: DEFAULT_ALWAYS_IN_SCOPE, stageHeadPrefixes: DEFAULT_STAGE_HEAD_PREFIXES };
  const off = (warning) => ({ mode: 'off', ...defaults, warning });
  let raw;
  try { raw = JSON.parse(read(file, 'utf8')); } catch (error) {
    return off(`review-features.json 读不到或不合法(${clip(error.message, 120)}),任务 issue 按 off 处理`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return off('review-features.json 顶层不是对象,任务 issue 按 off 处理');
  if (raw.taskIssue === undefined) return off(null);
  const mode = raw.taskIssue?.mode;
  if (!TASK_ISSUE_MODES.includes(mode)) return off(`review-features.json 的 taskIssue.mode 不合法(${clip(String(mode), 40)}),任务 issue 按 off 处理`);
  const out = { mode, ...defaults, warning: null };
  const bad = [];
  for (const key of Object.keys(defaults)) {
    const value = raw.taskIssue[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v)) out[key] = value; else bad.push(key);
  }
  if (bad.length) out.warning = `review-features.json 的 taskIssue.${bad.join('、')} 不是非空字符串数组,按默认值处理`;
  return out;
}

// ── 链接 ───────────────────────────────────────────────────────────────────

/** PR 正文里的「任务 issue：」行 → [{repo, number}](去重、按出现顺序);HTML 注释与代码块里的不算。 */
export function parseTaskLines(body, repo) {
  const refs = [];
  for (const m of toPlainText(body).matchAll(TASK_LINE_RE)) pushRef(refs, m[1] ?? m[3] ?? repo, Number(m[2] ?? m[4]));
  return refs;
}

/**
 * 选任务 issue:有「任务 issue：」行只看它,没有才用 Closes 关联(closing 来自 GraphQL closingIssuesReferences)。
 * 「转 issue 跟进的审查问题」一节里的 issue、标题以「维护者确认 · PR #」开头的 issue 不算;多于 1 个只取第一个并告警。
 */
export function selectTaskIssue({ body, repo, pr, closing = [] }) {
  const lineRefs = parseTaskLines(body, repo);
  const via = lineRefs.length ? 'line' : closing.length ? 'closes' : null;
  const source = lineRefs.length ? lineRefs : closing.map((c) => ({ repo: c.repo ?? repo, number: Number(c.number), title: c.title ?? null }));
  const deferred = toDeferredIssues(body, repo, pr);
  const excluded = [];
  const candidates = [];
  for (const ref of source) {
    if (sameRepo(ref.repo, repo) && deferred.has(ref.number)) { excluded.push({ ref: refText(ref), reason: '在「转 issue 跟进的审查问题」一节' }); continue; }
    if (String(ref.title ?? '').startsWith(MAINTAINER_CONFIRM_PREFIX)) { excluded.push({ ref: refText(ref), reason: '维护者确认 issue' }); continue; }
    pushRef(candidates, ref.repo, ref.number);
  }
  const warnings = candidates.length > 1 ? [`关联了多个任务 issue(${candidates.map(refText).join('、')}),按范式一个 PR 对应一个子 issue,只取 ${refText(candidates[0])}`] : [];
  return { via: candidates.length ? via : null, candidates, excluded, warnings };
}

/** 子 issue 正文开头 2 KB 里写明的「总 issue …#N」→ {repo, number} 或 null。 */
export function parentRefFromBody(body, repo) {
  const m = PARENT_LINE_RE.exec(clipBytes(toPlainText(body), LIMITS.parentHeadBytes));
  return m ? { repo: m[1] ?? m[3] ?? repo, number: Number(m[2] ?? m[4]) } : null;
}

// ── 段落与验收标准 ─────────────────────────────────────────────────────────

/** 按二级标题前缀切段(`## 范围（可改）` 算「范围」),每个名字只认第一处;HTML 注释(模板说明)去掉,代码块里的标题不算。没有的段为 null。 */
export function toSections(body, names) {
  const out = Object.fromEntries(names.map((n) => [n, null]));
  let current = null;
  let fence = false;
  for (const line of lines(String(body ?? '').replace(/<!--[\s\S]*?-->/g, ''))) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = heading[1].length === 2 ? names.find((n) => heading[2].startsWith(n) && out[n] === null) ?? null : null;
      if (current) out[current] = [];
      continue;
    }
    if (current) out[current].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v === null ? null : v.join('\n').trim()]));
}

/** 验收标准行 `- [ ] SC<n> <描述>。验证：<层次>（测试点：…）` → [{sc, description, layer, testPoint, checked}];层次不在词表时为 null。 */
export function toScList(text) {
  const out = [];
  for (const line of lines(text)) {
    const m = SC_RE.exec(line);
    if (!m) continue;
    const verify = /。?\s*验证\s*[：:]\s*(.*)$/.exec(m[3]);
    const tail = verify ? verify[1] : '';
    const word = /^([A-Za-z-]+)/.exec(tail)?.[1]?.toLowerCase() ?? null;
    out.push({ sc: `SC${m[2]}`, description: (verify ? m[3].slice(0, verify.index) : m[3]).trim(),
      layer: LAYERS.includes(word) ? word : null, testPoint: /（测试点\s*[：:]\s*([^）]*)）/.exec(tail)?.[1]?.trim() ?? null, checked: m[1] !== ' ' });
  }
  return out;
}

/** 子 issue 正文 → 五段、验收标准与结构状态;超过 16 KB 只保留五段(各有上限),认不出结构时保留原文。 */
export function toChildMaterial(body) {
  const sections = toSections(body, CHILD_SECTIONS);
  const missing = CHILD_SECTIONS.filter((n) => sections[n] === null);
  const scList = sections.验收标准 ? toScList(sections.验收标准) : [];
  const recognized = !missing.length && scList.length > 0;
  const truncated = bytes(body) > LIMITS.childBytes;
  return {
    structure: recognized ? 'parsed' : 'unrecognized', missingSections: missing, truncated, scList,
    sections: !recognized ? null : truncated ? Object.fromEntries(CHILD_SECTIONS.map((n) => [n, clipBytes(sections[n], SECTION_CAPS[n])])) : sections,
    raw: recognized ? null : clipBytes(String(body ?? ''), LIMITS.childBytes),
  };
}

// ── 可信度与未写回正文的决定 ───────────────────────────────────────────────

/**
 * 可信度(D16):issue 作者是维护者或自动化账号(验收机开的修正 issue)→ 计划方;否则作者陈述。开 PR 后的编辑都记下(谁、什么时候);
 * 维护者改的仍是计划方(「先改 issue 再改代码」是规定流程),非维护者改过的整份降为作者陈述;自动化账号的编辑不计。
 */
export function toTrust({ author, edits = [], prCreatedAt, maintainers = [], automation = DEFAULT_AUTOMATION }) {
  const isMaintainer = (login) => maintainers.some((m) => loginKey(m) === loginKey(login));
  const prAt = Date.parse(prCreatedAt ?? '');
  const editedAfterPr = Number.isFinite(prAt) ? edits
    .filter((e) => Date.parse(e.at) > prAt && !isAutomation(e.editor, automation))
    .map((e) => ({ editor: e.editor ?? null, at: e.at, maintainer: isMaintainer(e.editor) })) : [];
  const planAuthor = isMaintainer(author) || isAutomation(author, automation);
  const outsiders = editedAfterPr.filter((e) => !e.maintainer);
  const trust = planAuthor && !outsiders.length ? 'plan' : 'author';
  return { trust, trustLabel: trust === 'plan' ? '计划方验收标准' : '作者陈述', editedAfterPr,
    trustNote: !planAuthor ? 'issue 作者不是维护者' : outsiders.length ? '开 PR 后非维护者改过' : null };
}

/** 正文最后一次实质编辑(自动化账号的不算)的时间;没有编辑记录时是创建时间。 */
export function lastBodyEditAt({ createdAt, edits = [], automation = DEFAULT_AUTOMATION }) {
  return edits.filter((e) => !isAutomation(e.editor, automation)).map((e) => e.at).concat(createdAt ?? [])
    .filter((t) => Number.isFinite(Date.parse(t))).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/**
 * 未写回正文的决定(D16):只取正文最后一次编辑之后、维护者发的、开头含裁定字样的评论,最多 3 条、每条截到 1 KB。
 * 派发 / 认领 / 归档日志、验收记录、正文备份、编辑之前的评论和非维护者评论都不读。
 */
export function selectUndecided({ comments = [], since, maintainers = [] }) {
  const sinceAt = Date.parse(since ?? '') || 0;
  return comments
    .filter((c) => maintainers.some((m) => loginKey(m) === loginKey(c.author)) && Date.parse(c.createdAt) > sinceAt)
    .filter((c) => {
      const head = String(c.body ?? '').slice(0, MARKER_HEAD_CHARS);
      return DECISION_MARKERS.some((mark) => head.includes(mark)) && !head.split('\n', 1)[0].includes('正文备份');
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-LIMITS.comments)
    .map((c) => ({ author: c.author, at: c.createdAt, body: clipBytes(c.body, LIMITS.commentBytes), clipped: bytes(c.body) > LIMITS.commentBytes }));
}

// ── 所属总 issue ───────────────────────────────────────────────────────────

/** 决策表:按表头找列;首列是 D<n> 的为结构化决定,其余行原样保留为「未结构化决定」;识别「取代 D<n>」。 */
export function toDecisions(text) {
  const decisions = [];
  const unstructured = [];
  let header = null;
  for (const line of lines(text)) {
    if (/^\s*待定/.test(line)) break;
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!header && cells.some((c) => /决策|决定/.test(c)) && !/^D\d+$/.test(cells[0])) { header = cells; continue; }
    if (!/^D\d+$/.test(cells[0])) { unstructured.push(clip(line.trim(), 500)); continue; }
    const col = (re, fallback) => { const i = header ? header.findIndex((h) => re.test(h)) : -1; return cells[i >= 0 ? i : fallback] ?? ''; };
    decisions.push({ id: cells[0], date: col(/日期/, 1), decision: clip(col(/决策|决定/, 2), 600), type: col(/类型/, 3), by: col(/谁定/, 4), basis: clip(col(/依据/, 5), 300), supersededBy: null });
  }
  for (const d of decisions) {
    for (const m of d.decision.matchAll(/取代\s*(D\d+)/g)) {
      const target = decisions.find((x) => x.id === m[1] && x !== d);
      if (target) target.supersededBy = d.id;
    }
  }
  return { decisions, unstructured: unstructured.slice(0, 30) };
}

/** 子 issue 表:表格行(去掉表头和分隔线),标出本子 issue 那一行;没有表格时取提到 #N 的列表行。 */
export function toChildRows(text, child, parentRepo) {
  const all = lines(text);
  const table = all.filter((l) => /^\s*\|/.test(l)).filter((l) => !/^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l)).slice(1);
  const rows = table.length ? table : all.filter((l) => /^\s*[-*]\s/.test(l) && l.includes('#'));
  return rows.slice(0, 40).map((line) => ({ line: clip(line.trim(), 300), self: refsIn(line, parentRepo).some((r) => sameRef(r, child)) }));
}

/** 总 issue 正文 → 只取目标、不做、并行 / 串行原则、子 issue 表、决策表、整体验收;背景、变更记录、上线后验证不读。 */
export function toParentSections(body, child, parentRepo) {
  const s = toSections(body, PARENT_SECTIONS);
  const { decisions, unstructured } = toDecisions(s.决策 ?? s.已定决策);
  return {
    goal: clipBytes(s.目标, PARENT_PART_BYTES), notDo: clipBytes(s.不做 ?? notDoInScope(s.范围), PARENT_PART_BYTES),
    order: clipBytes(s.并行, PARENT_PART_BYTES), childRows: toChildRows(s['子 issue'], child, parentRepo),
    decisions, unstructuredDecisions: unstructured, overall: clipBytes(s.整体验收, PARENT_PART_BYTES),
  };
}

// ── 代码判定项 ─────────────────────────────────────────────────────────────

/** 改动文件是否落在「范围」的某条路径里:支持 `*`(不跨目录)、`**`(后面跟 / 时可以是零层目录)、以 / 结尾的目录和不带 / 的目录前缀。 */
export function matchesScope(file, pattern) {
  const p = String(pattern).trim().replace(/^\.\//, '');
  if (p.includes('*')) {
    const glob = (part) => part.split('**').map((s) => s.split('*').map(escapeRe).join('[^/]*')).join('.*');
    return new RegExp(`^${p.split('**/').map(glob).join('(?:.*/)?')}$`).test(file);
  }
  if (p.endsWith('/')) return file.startsWith(p);
  return file === p || file.startsWith(`${p}/`);
}

/** 「范围」里的路径:反引号里带 / 的(同产品规则的验收路径口径),加上不带 / 的文件名(按仓库根目录文件认,如 `AGENTS.md`)。 */
export function toScopePatterns(scopeText) {
  const rootFiles = [...String(scopeText ?? '').matchAll(/`([^`\s/]+\.[A-Za-z0-9]{1,8})`/g)].map((m) => m[1]);
  return [...new Set([...toEvidencePaths(scopeText), ...rootFiles])];
}

/** 测试文件对应的源文件:去掉 .test / .spec,再去掉 __tests__/ 这一层;不是测试文件时为空。 */
function sourcesOfTest(file) {
  const source = file.replace(/\.(test|spec)(\.[^./]+)$/, '$2');
  return source === file ? [] : [...new Set([source, source.replace(/(^|\/)__tests__\//, '$1')])];
}

/**
 * 准备阶段直接算好、不交给模型的几项(D16):超出范围的文件、黑盒验证层的 SC、还开着的依赖。
 * 交接文件(alwaysInScope)、范围内源文件的测试不算超出;阶段合并 PR(head 分支带 stageHeadPrefixes 前缀)不算。
 */
export function toDerived({ child, files = [], deps = null, headRefName = null, alwaysInScope = DEFAULT_ALWAYS_IN_SCOPE, stageHeadPrefixes = DEFAULT_STAGE_HEAD_PREFIXES }) {
  const patterns = child?.sections?.范围 ? toScopePatterns(child.sections.范围) : [];
  const stage = Boolean(headRefName) && stageHeadPrefixes.some((p) => String(headRefName).startsWith(p));
  const inScope = (f) => [...patterns, ...alwaysInScope].some((p) => matchesScope(f, p))
    || sourcesOfTest(f).some((s) => patterns.some((p) => matchesScope(s, p)));
  const scopeNote = stage ? `阶段合并 PR(head ${clip(headRefName, 80)}):diff 含整个阶段的改动,不算超出范围的文件`
    : !child?.sections ? '结构未识别,没算超出范围的文件'
      : !patterns.length ? '范围未列路径' : child.truncated ? '范围已截断,超出范围的文件可能多报' : null;
  return {
    scopeOutside: !stage && patterns.length ? files.filter((f) => !inScope(f)).sort() : null,
    scopeNote, scopePatterns: patterns,
    blackboxSc: (child?.scList ?? []).filter((s) => BLACKBOX_LAYERS.includes(s.layer)).map((s) => s.sc),
    depsOpen: (deps?.items ?? []).filter((d) => d.state === 'OPEN').map((d) => d.ref),
  };
}

/** 共用识别:issue 时间线里同仓、正文「任务 issue：」行指向这个 issue 的其它 PR(最多 10 个;时间线没取全时标不完整)。 */
export function toShared({ timeline, prRepo, pr, issueRef }) {
  const prs = [];
  for (const node of timeline?.nodes ?? []) {
    const source = node?.source;
    if (source?.__typename !== 'PullRequest' || !sameRepo(repoFromUrl(source.url), prRepo) || source.number === pr) continue;
    if (parseTaskLines(source.body, prRepo).some((r) => sameRef(r, issueRef)) && !prs.includes(source.number)) prs.push(source.number);
  }
  const incomplete = (timeline?.totalCount ?? 0) > (timeline?.nodes?.length ?? 0) || prs.length > LIMITS.shared;
  return { shared: prs.length > 0, prs: prs.sort((a, b) => a - b).slice(0, LIMITS.shared), incomplete };
}

// ── 读取 ───────────────────────────────────────────────────────────────────

/** gh api graphql 的输出 → {data, error};GraphQL 部分字段报错时 gh 退出码非 0,但 data 仍可用。 */
export function toGraphqlResult(out) {
  let parsed = null;
  try { parsed = JSON.parse(String(out?.stdout ?? '')); } catch { parsed = null; }
  const errors = Array.isArray(parsed?.errors) ? parsed.errors.map((e) => clip(String(e?.message ?? e), 160)) : [];
  if (!parsed?.data) return { data: null, error: errors.join('; ') || clip(out?.stderr || out?.error || `gh 退出码 ${out?.status}`, 200) };
  return { data: parsed.data, error: errors.length ? `部分字段读不到:${errors.join('; ')}` : null };
}

/** gh api <REST 路径> 的输出 → {data, error};404 不算错(没有总 issue 时 issues/<号>/parent 返回 404)。 */
export function toRestResult(out) {
  let parsed = null;
  try { parsed = JSON.parse(String(out?.stdout ?? '')); } catch { parsed = null; }
  if (out?.ok && parsed && typeof parsed === 'object') return { data: parsed, error: null };
  const notFound = String(parsed?.status ?? '') === '404' || /HTTP 404/.test(String(out?.stderr ?? ''));
  return { data: null, error: notFound ? null : clip(parsed?.message || out?.stderr || out?.error || `gh 退出码 ${out?.status}`, 200) };
}

/**
 * 读任务 issue 和所属总 issue,返回 task-issue.json 的内容。ghFn 是注入的 gh 调用(prepare 阶段的 gh);now 可换假时钟。
 * 典型 4 次请求(任务 issue 连时间线、依赖状态、总 issue 关系、总 issue);没有「任务 issue：」行再加 1 次读 Closes。
 */
export function readTaskIssue({ repo, pr, prBody, prCreatedAt, baseRefName, headRefName = null, files = [], maintainers = [], automation = DEFAULT_AUTOMATION,
  alwaysInScope = DEFAULT_ALWAYS_IN_SCOPE, stageHeadPrefixes = DEFAULT_STAGE_HEAD_PREFIXES, ghFn, now = Date.now, budget = BUDGET }) {
  const started = now();
  const material = { version: 1, status: 'read', ref: null, via: null, note: null, warnings: [], gaps: [], excluded: [], requests: 0, elapsedMs: 0,
    baseRef: baseRefName ?? null, baseNote: BASE_NOTE, issue: null, shared: null, deps: null, parent: null, derived: null, truncated: [] };
  const call = (label, send, parse = toGraphqlResult) => {
    if (material.requests >= budget.requests) { material.gaps.push(`${label}:已用满 ${budget.requests} 次请求,没读`); return null; }
    const left = budget.ms - (now() - started);
    if (left <= 0) { material.gaps.push(`${label}:已超过 ${Math.round(budget.ms / 1000)} 秒,没读`); return null; }
    material.requests += 1;
    const out = parse(send(Math.max(1000, Math.min(left, 10_000))));
    if (out.error) material.warnings.push(`${label}:${out.error}`);
    return out.data;
  };
  const finish = () => {
    material.elapsedMs = now() - started;
    if (material.status === 'read' && material.gaps.length) material.status = 'partial';
    return toSizedMaterial(material);
  };

  let closing = [];
  if (!parseTaskLines(prBody, repo).length) {
    const prVars = { ...ownerName(repo), number: pr };
    const data = call('PR 的 Closes 关联', (timeoutMs) => ghFn(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: CLOSING_QUERY, variables: prVars }), timeoutMs, allowFail: true }));
    closing = (data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [])
      .map((n) => ({ repo: repoFromUrl(n?.url) ?? repo, number: n?.number, title: n?.title ?? null })).filter((n) => Number.isInteger(n.number));
  }
  const picked = selectTaskIssue({ body: prBody, repo, pr, closing });
  material.warnings.push(...picked.warnings);
  material.excluded.push(...picked.excluded);
  material.via = picked.via;
  if (!picked.candidates.length) { material.status = 'unlinked'; material.note = '未关联'; return finish(); }

  let node = null;
  for (const candidate of picked.candidates.slice(0, 2)) {
    const issueVars = { ...ownerName(candidate.repo), number: candidate.number };
    const data = call(`任务 issue ${refText(candidate)}`, (timeoutMs) => ghFn(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: ISSUE_QUERY, variables: issueVars }), timeoutMs, allowFail: true }));
    const found = data?.repository?.issue ?? null;
    if (!found) break;
    if (String(found.title ?? '').startsWith(MAINTAINER_CONFIRM_PREFIX)) { material.excluded.push({ ref: refText(candidate), reason: '维护者确认 issue' }); continue; }
    node = found;
    material.ref = refText(candidate);
    break;
  }
  if (!node) {
    material.status = material.requests && !material.excluded.some((e) => e.reason === '维护者确认 issue') ? 'unreadable' : 'unlinked';
    material.note = material.status === 'unlinked' ? '未关联' : '任务 issue 读不到';
    return finish();
  }

  // 子 issue 本身
  const issueRef = refFromText(material.ref);
  const edits = editsOf(node);
  const child = toChildMaterial(node.body);
  if (child.truncated) material.truncated.push('子 issue 正文超过 16 KB,只保留五个必需段');
  material.issue = {
    ref: material.ref, url: node.url ?? null, title: clip(node.title, 300), author: node.author?.login ?? null, createdAt: node.createdAt ?? null,
    edits: edits.slice(-20), ...toTrust({ author: node.author?.login, edits, prCreatedAt, maintainers, automation }),
    digest: sha256(node.body), ...child,
    undecided: selectUndecided({ comments: commentsOf(node), since: lastBodyEditAt({ createdAt: node.createdAt, edits, automation }), maintainers }),
  };
  material.shared = toShared({ timeline: node.timelineItems, prRepo: repo, pr, issueRef });
  if (material.shared.incomplete) material.gaps.push('共用识别:时间线没取全或超过 10 个,共用 PR 列表不完整');

  // 依赖状态:同仓(子 issue 所在仓)一次读最多 10 个;其它仓的依赖不读,写明缺口。
  const depRefs = refsIn(child.sections?.依赖 ?? '', issueRef.repo);
  if (depRefs.length) {
    const local = depRefs.filter((r) => sameRepo(r.repo, issueRef.repo)).slice(0, LIMITS.deps);
    const skipped = depRefs.length - local.length;
    const numbers = local.map((r) => r.number);
    const depsVars = { ...ownerName(issueRef.repo), ...Object.fromEntries(Array.from({ length: LIMITS.deps }, (_, i) => [`n${i}`, numbers[i] ?? numbers[0]])) };
    const data = local.length ? call('依赖状态', (timeoutMs) => ghFn(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: DEPS_QUERY, variables: depsVars }), timeoutMs, allowFail: true })) : null;
    material.deps = { items: local.map((r, i) => ({ ref: refText(r), type: data?.repository?.[`d${i}`]?.__typename ?? null, state: data?.repository?.[`d${i}`]?.state ?? null })), incomplete: skipped > 0 };
    if (skipped > 0) material.gaps.push(`依赖:另有 ${skipped} 个跨仓或超出 10 个的依赖没读`);
  }

  // 所属总 issue:先用 GitHub 的子 issue 关系(REST issues/<号>/parent),没有再认正文开头写明的总 issue;两者矛盾记冲突;只上溯一层。
  const bodyRef = parentRefFromBody(node.body, issueRef.repo);
  const { owner, name } = ownerName(issueRef.repo);
  const pointer = call('总 issue 关系', (timeoutMs) => ghFn(['api', `repos/${owner}/${name}/issues/${issueRef.number}/parent`], { timeoutMs, allowFail: true }), toRestResult);
  const apiRef = Number.isInteger(pointer?.number) ? { repo: repoFromUrl(pointer.html_url) ?? issueRef.repo, number: pointer.number } : null;
  const parentRef = apiRef ?? bodyRef;
  const via = apiRef ? 'api' : bodyRef ? 'body' : null;
  let conflict = null;
  if (apiRef && bodyRef && !sameRef(apiRef, bodyRef)) {
    conflict = { api: refText(apiRef), body: refText(bodyRef) };
    material.warnings.push(`父 issue 冲突:子 issue 关系是 ${conflict.api},正文写的是 ${conflict.body}`);
  }
  let parentNode = null;
  if (parentRef) {
    const parentVars = { ...ownerName(parentRef.repo), number: parentRef.number };
    const data = call(`总 issue ${refText(parentRef)}`, (timeoutMs) => ghFn(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: PARENT_QUERY, variables: parentVars }), timeoutMs, allowFail: true }));
    parentNode = data?.repository?.issue ?? null;
  }
  if (parentNode) {
    const parentEdits = editsOf(parentNode);
    const trust = toTrust({ author: parentNode.author?.login, edits: parentEdits, prCreatedAt, maintainers, automation });
    material.parent = {
      ref: refText(parentRef), via, conflict, url: parentNode.url ?? null, title: clip(parentNode.title, 300), author: parentNode.author?.login ?? null,
      notTotal: !String(parentNode.title ?? '').trim().startsWith('[总]'), trust: trust.trust, trustLabel: trust.trustLabel, trustNote: trust.trustNote,
      editedAfterPr: trust.editedAfterPr, digest: sha256(parentNode.body), ...toParentSections(parentNode.body, issueRef, parentRef.repo),
      undecided: selectUndecided({ comments: commentsOf(parentNode), since: lastBodyEditAt({ createdAt: parentNode.createdAt, edits: parentEdits, automation }), maintainers }),
    };
    if (material.parent.notTotal) material.warnings.push(`父 issue ${material.parent.ref} 不是总 issue(标题不以 [总] 开头),照读`);
  }
  material.derived = toDerived({ child: material.issue, files, deps: material.deps, headRefName, alwaysInScope, stageHeadPrefixes });
  return finish();
}

/** 超过 64 KB 时按固定顺序删减并记进 truncated:最旧的未写回正文的决定 → 第 20 个以后的兄弟子 issue → 流程类决定 → 已取代的决定 → 整体验收的文字。 */
export function toSizedMaterial(material, limit = LIMITS.fileBytes) {
  const size = () => bytes(JSON.stringify(material));
  const steps = [
    ['最旧的未写回正文的决定', () => {
      const pools = [material.issue?.undecided, material.parent?.undecided].filter((p) => p?.length);
      if (!pools.length) return false;
      const oldest = pools.reduce((a, b) => (Date.parse(a[0].at) <= Date.parse(b[0].at) ? a : b));
      oldest.shift();
      return true;
    }],
    ['第 20 个以后的兄弟子 issue', () => {
      const rows = material.parent?.childRows ?? [];
      if (rows.length <= LIMITS.siblings) return false;
      material.parent.childRows = rows.filter((r, i) => i < LIMITS.siblings || r.self);
      return material.parent.childRows.length < rows.length;
    }],
    ['流程类决定', () => dropDecisions((d) => d.type.includes('流程'))],
    ['已取代的决定', () => dropDecisions((d) => d.supersededBy)],
    ['整体验收的文字', () => { if (!material.parent?.overall) return false; material.parent.overall = null; return true; }],
  ];
  function dropDecisions(match) {
    const list = material.parent?.decisions ?? [];
    const kept = list.filter((d) => !match(d));
    if (kept.length === list.length) return false;
    material.parent.decisions = kept;
    return true;
  }
  for (const [label, drop] of steps) {
    let dropped = 0;
    while (size() > limit && drop()) dropped += 1;
    if (dropped) material.truncated.push(`${label}(删 ${dropped} 次)`);
  }
  if (size() > limit && material.parent) {
    material.parent = { ref: material.parent.ref, via: material.parent.via, trust: material.parent.trust, digest: material.parent.digest, dropped: true };
    material.truncated.push('总 issue 材料整体删去,只留链接与摘要');
  }
  return material;
}

/** 结果包里的一笔(mivo.taskIssue):不含正文,只留链接、摘要、可信度和 SC 编号。 */
export function toTaskIssueSummary(material) {
  return {
    ref: material.ref ?? null, digest: material.issue?.digest ?? null, trust: material.issue?.trust ?? null,
    scList: (material.issue?.scList ?? []).map((s) => ({ sc: s.sc, layer: s.layer })),
    parent: material.parent ? { ref: material.parent.ref, via: material.parent.via, trust: material.parent.trust, digest: material.parent.digest } : null,
    baseRef: material.baseRef ?? null, status: material.status, truncated: material.truncated ?? [],
  };
}

/** prepare 的入口:任何异常都收成「读不到」,只记 warning,不让整轮失败。 */
export function collectTaskIssue(params) {
  let material;
  try { material = readTaskIssue(params); } catch (error) {
    material = { version: 1, status: 'unreadable', ref: null, via: null, note: '任务 issue 读不到', warnings: [`读取异常:${clip(error.message, 200)}`], gaps: [], excluded: [],
      requests: 0, elapsedMs: 0, baseRef: params?.baseRefName ?? null, baseNote: BASE_NOTE, issue: null, shared: null, deps: null, parent: null, derived: null, truncated: [] };
  }
  return { material, summary: toTaskIssueSummary(material) };
}

// helpers

const lines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
const bytes = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');
const sha256 = (text) => createHash('sha256').update(String(text ?? '')).digest('hex');
const loginKey = (login) => String(login ?? '').toLowerCase().replace(/\[bot\]$/, '');
const isAutomation = (login, automation) => automation.some((a) => loginKey(a) === loginKey(login));
const sameRepo = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const sameRef = (a, b) => Boolean(a && b) && sameRepo(a.repo, b.repo) && Number(a.number) === Number(b.number);
const refText = (ref) => `${ref.repo}#${ref.number}`;
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ownerName = (repo) => { const [owner, name] = String(repo).split('/'); return { owner, name }; };
const editsOf = (node) => (node?.userContentEdits?.nodes ?? []).filter((e) => e?.editedAt).map((e) => ({ editor: e.editor?.login ?? null, at: e.editedAt }));
const commentsOf = (node) => (node?.comments?.nodes ?? []).map((c) => ({ author: c?.author?.login ?? null, createdAt: c?.createdAt ?? null, body: c?.body ?? '' }));

/** github.com 的 issue / PR 网址 → owner/repo;认不出为 null。 */
function repoFromUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+/.exec(String(url ?? ''));
  return m ? m[1] : null;
}

function refFromText(text) {
  const i = text.lastIndexOf('#');
  return { repo: text.slice(0, i), number: Number(text.slice(i + 1)) };
}

function pushRef(list, repo, number) {
  if (!Number.isInteger(number) || number <= 0 || list.some((r) => sameRef(r, { repo, number }))) return;
  list.push({ repo, number });
}

function refsIn(text, repo) {
  const refs = [];
  for (const m of toPlainText(text).matchAll(ANY_REF_RE)) pushRef(refs, m[1] ?? repo, Number(m[2]));
  return refs;
}

function toDeferredIssues(body, repo, pr) {
  const parsed = parseDeferrals(body, { repo, pr });
  return new Set([...parsed.entries, ...parsed.rejected].map((e) => e.issue).filter((n) => Number.isInteger(n)));
}

/** 去掉 HTML 注释和代码块(模板示例里的链接不算)。 */
function toPlainText(text) {
  const out = [];
  let fence = false;
  for (const line of lines(String(text ?? '').replace(/<!--[\s\S]*?-->/g, ''))) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (!fence) out.push(line);
  }
  return out.join('\n');
}

/** 「范围」里写的「不做」子列表(旧模板把不做写在范围下面)。 */
function notDoInScope(scope) {
  const all = lines(scope);
  const start = all.findIndex((l) => /^\s*[-*]\s*不做/.test(l));
  if (start < 0) return null;
  const indent = /^\s*/.exec(all[start])[0].length;
  const out = [all[start]];
  for (const line of all.slice(start + 1)) {
    if (line.trim() && /^\s*/.exec(line)[0].length <= indent) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function clip(text, max) {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 按 UTF-8 字节截断,不切开多字节字符;截断时末尾加「…(已截断)」。null 原样返回。 */
function clipBytes(text, max) {
  if (text === null || text === undefined) return null;
  const t = String(text);
  if (bytes(t) <= max) return t;
  const tail = '…(已截断)';
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(t.slice(0, mid)) + bytes(tail) <= max) lo = mid; else hi = mid - 1;
  }
  return t.slice(0, lo) + tail;
}
