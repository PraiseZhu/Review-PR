// finding.mjs — 审查问题(finding)的 v2 结构:答卷 schema、稳定 key、thread 正文与 marker、证据核对、来源改判。纯函数。
// 借鉴 Claude 官方审查机的三点:每条问题带证据与来源;同一问题跨轮用同一个 key;thread 里留机读 marker 供收敛与遥测使用。
// schema 里不写 maxLength/minItems/maxItems:公司网关的 strict 结构化输出是否支持这些关键字没有核实,
// 被拒收会让每个审查都在模型阶段失败。长度与条数的限制只写在 description 里,由 normalizeFinding 在服务器端截断。
import { createHash } from 'node:crypto';

export const SEVERITIES = ['P0', 'P1', 'P2'];
export const ORIGINS = ['introduced', 'made-reachable', 'pre-existing'];
// 任务范围外的依据(#244):none=在任务范围内。模型的声明要过 classifyBeyondTask 才生效。
export const BEYOND_TASK = ['none', 'not-do', 'other-work', 'accepted', 'no-worse'];
export const BEYOND_TASK_QUOTE_MIN = 6;
export const BEYOND_TASK_QUOTE_FULL = 10;
export const LIMITS = { title: 120, text: 800, bugClass: 60, evidence: 8, instances: 20, beyondTaskQuote: 200 };
export const FINDING_MARKER_RE = /<!--\s*mivo-finding\s+key=([0-9a-f]{12})\s+round=(\d+|null)\s+head=([0-9a-f]{7,40})(?:\s+class=([^\s>]*))?\s*-->/g;
export const SUPERSEDES_RE = /^(?:[0-9a-f]{12}|legacy-\d{1,3})$/;

const LOCATION_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'line'],
  properties: {
    path: { type: 'string', description: '仓内相对路径,必须是 PR head 上真实存在的文件' },
    line: { type: ['integer', 'null'], description: '行号;整个文件或没有准确行号写 null' },
  },
};

export const FINDING_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'title', 'trigger', 'behavior', 'impact', 'fix', 'verify', 'evidence', 'origin', 'bugClass', 'instances', 'supersedes', 'path', 'line', 'side', 'deferredTo', 'handoffRiskIds', 'beyondTask', 'beyondTaskQuote'],
  properties: {
    severity: { type: 'string', enum: SEVERITIES },
    title: { type: 'string', description: '一句话标题,不超过 120 字' },
    trigger: { type: 'string', description: '触发条件,不超过 800 字' },
    behavior: { type: 'string', description: '错误行为,不超过 800 字' },
    impact: { type: 'string', description: '实际影响,不超过 800 字' },
    fix: { type: 'string', description: '建议修复,不超过 800 字' },
    verify: { type: 'string', description: '验证方式,不超过 800 字' },
    evidence: { type: 'array', description: '证据位置,1–8 项;每项必须是 head 上真实存在的文件和行号', items: LOCATION_ITEM },
    origin: { type: 'string', enum: ORIGINS, description: 'introduced=本 PR 引入;made-reachable=本 PR 让旧代码变得可达;pre-existing=PR 之前就存在' },
    bugClass: { type: 'string', description: '问题类型的短标签,例如 null-deref、race、auth-bypass;不超过 60 字' },
    instances: { type: 'array', description: '同一类问题的其他位置,0–20 项;同类问题只报一条,其余位置写在这里', items: LOCATION_ITEM },
    supersedes: { type: ['string', 'null'], description: '没修好的上一轮问题:填任务书里列出的 key(12 位十六进制或 legacy-N);新问题写 null' },
    path: { type: 'string', description: '问题所在文件,必须是本 PR diff 里的文件(PR 之前就存在的问题也一样)' },
    line: { type: ['integer', 'null'], description: 'RIGHT 侧行号;没有准确行号写 null' },
    side: { type: 'string', enum: ['RIGHT', 'LEFT'] },
    handoffRiskIds: { type: 'array', items: { type: 'string' }, description: '本问题与作者交接 review.md 里哪几条 R 描述的是同一个风险/根因(写 R 编号如 R1);同文件不算;没有对应的 R 写空数组' },
    deferredTo: { type: ['integer', 'null'], description: '同一问题已转 issue 跟进时填该 issue 号(只限 P1/P2,且必须在任务书核验通过的列表里);其他一律 null' },
    beyondTask: { type: 'string', enum: BEYOND_TASK, description: '任务范围外的依据。任务书里没有「任务范围」规则、或问题在任务范围内,一律写 none;not-do=任务 issue 写明不做;other-work=总 issue 分给别的子 issue;accepted=计划方写明接受;no-worse=最坏结果不比合并前差且任务 issue 没要求(只限 P2)' },
    beyondTaskQuote: { type: 'string', description: '逐字引用任务 issue 里支持这个依据的一句原文,至少 10 个字、不超过 200 字(汉字逐个算,英文单词、标识符和路径各算一个,数字和标点不算;那一行不到 20 个字时引用整行);beyondTask 为 none 或 no-worse 时写空字符串' },
  },
};

// 模型文本进 thread 正文前转义注释记号,防止伪造 marker。
export const escapeModelText = (text) => String(text ?? '').replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');

const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const clipText = (text, max) => {
  const value = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  return value.length > max ? value.slice(0, max) : value;
};

/** 同一问题跨轮的稳定 key:文件 + 问题类型 + 标题(大小写与空白折叠后)的 12 位摘要。 */
export function findingKeyOf({ path, bugClass = '', title = '' }) {
  const material = `${String(path ?? '')}|${String(bugClass ?? '').trim().toLowerCase()}|${collapse(title).toLowerCase()}`;
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

/** v1 项(只有 body)的标题:body 首行去掉 [Px] 前缀。 */
export const titleOfBody = (body) => collapse(String(body ?? '').split('\n')[0].replace(/^\s*\[P[012]\]\s*/, ''));

const normalizeLocations = (list, limit, label, notes) => {
  const items = Array.isArray(list) ? list : [];
  if (items.length > limit) notes.push(`${label}超过 ${limit} 项,只保留前 ${limit} 项`);
  return items.slice(0, limit).map((item) => ({
    path: String(item?.path ?? '').trim(),
    line: Number.isInteger(item?.line) && item.line > 0 ? item.line : null,
  })).filter((item) => item.path);
};

/**
 * 答卷里的 handoffRiskIds → {ids, complete}。ids 只留 validIds 里的、去重;
 * complete=false 表示字段缺失/类型不对/含无效编号(统计里计入「关联记录不完整」)。
 */
export function readHandoffRiskIds(raw, validIds) {
  if (!Array.isArray(raw)) return { ids: [], complete: false };
  const ids = [];
  let complete = true;
  for (const value of raw) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!validIds.has(id)) complete = false;
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, complete };
}

/** 截断超长字段、多余条目并记 note;不改变语义。 */
export function normalizeFinding(raw) {
  const notes = [];
  const title = clipText(collapse(raw?.title), LIMITS.title);
  if (collapse(raw?.title).length > LIMITS.title) notes.push(`标题超过 ${LIMITS.title} 字,已截断`);
  const text = {};
  for (const field of ['trigger', 'behavior', 'impact', 'fix', 'verify']) {
    const value = String(raw?.[field] ?? '').trim();
    if (value.length > LIMITS.text) notes.push(`${field} 超过 ${LIMITS.text} 字,已截断`);
    text[field] = clipText(value, LIMITS.text);
  }
  const bugClass = clipText(collapse(raw?.bugClass), LIMITS.bugClass);
  const evidence = normalizeLocations(raw?.evidence, LIMITS.evidence, '证据', notes);
  // 位置条数超上限被截断(#244):截掉的位置可能正好是上一轮问题所在的文件,这条问题不能再分到任务范围外。
  const locationsTruncated = (Array.isArray(raw?.evidence) && raw.evidence.length > LIMITS.evidence) || (Array.isArray(raw?.instances) && raw.instances.length > LIMITS.instances);
  if (!evidence.length) notes.push('没有给出证据位置');
  const instances = normalizeLocations(raw?.instances, LIMITS.instances, '同类位置', notes);
  let supersedes = raw?.supersedes ?? null;
  if (supersedes !== null && !(typeof supersedes === 'string' && SUPERSEDES_RE.test(supersedes))) {
    notes.push('supersedes 不是上一轮列出的 key,按新问题处理');
    supersedes = null;
  }
  const origin = ORIGINS.includes(raw?.origin) ? raw.origin : 'introduced';
  // 没有这两个字段的旧答卷按「在任务范围内」处理。
  const beyondTask = BEYOND_TASK.includes(raw?.beyondTask) ? raw.beyondTask : 'none';
  const beyondTaskQuote = beyondTask === 'none' ? '' : clipText(collapse(raw?.beyondTaskQuote), LIMITS.beyondTaskQuote);
  return { item: { severity: raw?.severity, title, ...text, evidence, instances, origin, bugClass, supersedes, beyondTask, beyondTaskQuote, locationsTruncated }, notes };
}

const where = ({ path, line }) => (line ? `${path}:${line}` : path);
const codeList = (list) => list.map((item) => `\`${escapeModelText(where(item))}\``).join('、');

/** thread 正文(不含 marker)。首行必须是 `[P0|P1|P2] 标题`:rulings、报告、发布都靠它判级。 */
export function renderFindingText(item) {
  const lines = [`[${item.severity}] ${escapeModelText(item.title)}`, ''];
  lines.push(`**触发条件**：${escapeModelText(item.trigger)}`);
  lines.push(`**错误行为**：${escapeModelText(item.behavior)}`);
  lines.push(`**影响**：${escapeModelText(item.impact)}`);
  if (item.evidence?.length) lines.push(`**证据**：${codeList(item.evidence)}`);
  if (item.instances?.length) lines.push(`**同类位置**：${codeList(item.instances)}`);
  if (item.origin === 'made-reachable') lines.push('**来源**：本 PR 让旧代码变得可达');
  else if (item.origin === 'pre-existing') lines.push('**来源**：PR 之前就存在');
  lines.push(`**建议修复**：${escapeModelText(item.fix)}`);
  lines.push(`**验证方式**：${escapeModelText(item.verify)}`);
  return lines.join('\n');
}

export function findingMarker({ key, round = null, head, bugClass = '' }) {
  const cls = bugClass ? ` class=${encodeURIComponent(bugClass)}` : '';
  return `<!-- mivo-finding key=${key} round=${Number.isInteger(round) ? round : 'null'} head=${String(head).slice(0, 12)}${cls} -->`;
}

export function renderFindingBody(item, marker = null) {
  const text = renderFindingText(item);
  return marker ? `${text}\n\n${findingMarker(marker)}` : text;
}

/** 取正文里最后一个 marker;没有返回 null。 */
export function parseFindingMarker(body) {
  let last = null;
  for (const match of String(body ?? '').matchAll(FINDING_MARKER_RE)) last = match;
  if (!last) return null;
  let bugClass = '';
  try { bugClass = decodeURIComponent(last[4] ?? ''); } catch { bugClass = last[4] ?? ''; }
  return { key: last[1], round: last[2] === 'null' ? null : Number(last[2]), head: last[3], bugClass };
}

const pathIsSafe = (path) => {
  const text = String(path ?? '');
  return Boolean(text) && !text.startsWith('/') && !text.includes('\\') && !text.split('/').includes('..');
};

/**
 * 证据是否都在 head 上。headReader(path) → {exists, lineCount};按 git 对象读,不信工作树。
 * 证据不全不放行也不降级,只记下来:调用方照常阻断并写 warning。
 */
export function checkEvidence(item, { headReader }) {
  const missing = [];
  // regular:每个证据都是普通文件(headReader 给了 regularFile 才算;#244 任务范围外只认普通文件)。不影响 complete。
  let regular = true;
  const evidence = item?.evidence ?? [];
  if (!evidence.length) missing.push({ path: null, line: null, reason: 'empty' });
  for (const { path, line } of evidence) {
    if (!pathIsSafe(path)) { missing.push({ path, line, reason: 'path-invalid' }); continue; }
    const read = headReader(path) ?? { exists: false, lineCount: 0 };
    if (read.regularFile !== true) regular = false;
    if (!read.exists) missing.push({ path, line, reason: 'not-found' });
    else if (line && read.lineCount > 0 && line > read.lineCount) missing.push({ path, line, reason: 'line-out-of-range' });
  }
  return { complete: missing.length === 0, regular: regular && evidence.length > 0, missing };
}

/**
 * 声称 pre-existing 但问题行、任一证据行或任一同类位置(instances)落在本 PR 新增行上 → 改判 introduced。
 * 证据一起判:防止模型把 line 写成 null 来躲开判定;同类合并的问题只要有一个实例是本 PR 新增的,整组就不能按旧问题免责。
 */
export function classifyOrigin(item, { diffFiles }) {
  if (item?.origin !== 'pre-existing') return { origin: item?.origin ?? 'introduced', note: null };
  const added = (path, line) => Boolean(line) && diffFiles?.[path]?.addedLines?.has(line);
  const hit = added(item.path, item.line) || [...(item.evidence ?? []), ...(item.instances ?? [])].some((e) => added(e.path, e.line));
  return hit
    ? { origin: 'introduced', note: '声称 PR 之前就存在,但落在本 PR 新增行上,按本 PR 引入处理' }
    : { origin: 'pre-existing', note: null };
}

// 比对引用时忽略空白、反引号和各种引号:任务书里的 issue 原文是压成一行、换掉反引号后的样子,模型照抄时这些地方会和原文不同。
const squash = (text) => String(text ?? '').replace(/[\s`'"“”‘’「」『』]/g, '');
// 引用的长度按「字」算:汉字一个算一个;英文单词、代码标识符、路径各算一个(下划线、连字符、点、斜杠、冒号连着的不拆开);
// 数字和标点不算。这样日期、编号、标点凑不出一句话,单独一个函数名、文件名或路径也不够。
const unitCount = (text) => (String(text ?? '').match(/\p{Script=Han}|[^\p{Script=Han}\s，。、；：！？（）【】《》「」『』“”‘’,;!?()[\]{}<>|"'`]+/gu) ?? []).filter((token) => /\p{L}/u.test(token)).length;
// 比较文件时去掉开头的 ./、合并重复的 /、忽略大小写:写法不同的同一个文件不能躲开修复轮的从严。
export const toPathKey = (path) => String(path ?? '').trim().replace(/^(?:\.\/)+/, '').replace(/\/{2,}/g, '/').toLowerCase();

/**
 * 引用是否落在某一行原文里,而且够长。返回 'ok' / 'short'(对上了但太短)/ 'missing'。
 * 够长 = 至少 BEYOND_TASK_QUOTE_FULL 个字;那一行不到两倍长度时至少引用一半,且不少于 BEYOND_TASK_QUOTE_MIN 个字。
 * 只在同一行里匹配:不能把相邻两行的尾和头拼成一句。
 */
function matchPlanQuote(quote, lines) {
  const q = squash(quote);
  const n = unitCount(quote);
  let short = false;
  for (const line of lines ?? []) {
    if (!squash(line).includes(q)) continue;
    if (n >= Math.max(BEYOND_TASK_QUOTE_MIN, Math.min(BEYOND_TASK_QUOTE_FULL, Math.ceil(unitCount(line) / 2)))) return 'ok';
    short = true;
  }
  return short ? 'short' : 'missing';
}

/**
 * 模型声称「任务范围外」的问题,由服务器核对后才不阻断(#244)。纯函数。
 * 通过的条件:
 * - P1/P2;不是上一轮已经阻断过的问题(supersedes 为空、不是连续报出)。
 * - 证据完整:证据不为空、每个位置在 head 上都找得到(evidenceComplete)且是普通文件(evidenceRegular)、位置条数没有超上限被截断(locationsTruncated)。
 * - 修复轮按文件从严:previousOpen 是上一轮阻断、本轮没有按原 key 再报的问题(可能已修好,也可能换了说法重报——key 靠标题算,
 *   服务器分不出来),每条带 files(它的位置、证据、同类位置所在的文件;splitBeyondTask 算好)。这条问题的位置、任一证据或任一同类位置
 *   落在这些文件上时,一律照常阻断;files 为 null(旧记录没有完整的文件清单、或其中有文件在本轮版本上已不存在或不是普通文件)时也照常阻断。
 *   previousUnknown(上一轮结果读不到、PR 上却已有审查机的 thread)时全部照常阻断。
 * - not-do / other-work / accepted 三种依据要逐字引用计划方写的 issue 原文:落在对应依据那部分的同一行里,够长(matchPlanQuote)。
 * - no-worse 只限 P2,不要求引用。
 * 其余一律照常阻断并给出原因。
 * @param {object} item 带 severity / beyondTask / beyondTaskQuote / supersedes / seenRounds / path / evidence / instances 的问题
 * @param {{planText: {notDo:string[], otherWork:string[], accepted:string[]}, previousOpen?: object[], previousUnknown?: boolean}} p
 *   planText 是计划方原文按依据分开的行(task-issue.mjs toTaskIssuePlanText)
 * @returns {{beyond:boolean, basis:string|null, note:string|null}}
 */
export function classifyBeyondTask(item, { planText, previousOpen = [], previousUnknown = false }) {
  const basis = BEYOND_TASK.includes(item?.beyondTask) ? item.beyondTask : 'none';
  const keep = (note) => ({ beyond: false, basis: null, note });
  if (basis === 'none') return keep(null);
  if (!['P1', 'P2'].includes(item.severity)) return keep('声称任务范围外,但 P0 不论范围都阻断');
  if ((item.supersedes ?? null) !== null || (item.seenRounds ?? 1) > 1) return keep('声称任务范围外,但上一轮已经阻断过这条问题,照常阻断');
  if (previousUnknown) return keep('声称任务范围外,但上一轮的审查结果读不到,无法确认不是上一轮挡过的问题,照常阻断');
  if (item.evidenceComplete !== true || item.evidenceRegular !== true || item.locationsTruncated === true) return keep('声称任务范围外,但证据不完整(证据为空、有位置在本轮版本上找不到或不是普通文件、或位置条数超上限被截断),照常阻断');
  const touched = new Set([item.path, ...(item.evidence ?? []).map((e) => e?.path), ...(item.instances ?? []).map((i) => i?.path)].filter(Boolean).map(toPathKey));
  if (previousOpen.some((p) => !Array.isArray(p?.files) || !p.files.length)) return keep('声称任务范围外,但上一轮有阻断问题本轮没有按原编号再报,而它的文件清单缺失或文件在本轮版本上已不存在、不再是普通文件(改名、删除或替换),修复轮从严,照常阻断');
  if (previousOpen.some((p) => p.files.some((f) => touched.has(toPathKey(f))))) return keep('声称任务范围外,但上一轮这个文件有阻断问题、本轮没有按原编号再报,修复轮按文件从严,照常阻断');
  if (basis === 'no-worse') return item.severity === 'P2' ? { beyond: true, basis, note: null } : keep('「不比合并前差」只适用于 P2,这条是 P1,照常阻断');
  if (unitCount(item.beyondTaskQuote) < BEYOND_TASK_QUOTE_MIN) return keep(`声称任务范围外,但引用的任务 issue 原文不足 ${BEYOND_TASK_QUOTE_MIN} 个字(汉字逐个算,英文单词、标识符和路径各算一个,数字和标点不算),照常阻断`);
  const lines = { 'not-do': planText?.notDo, 'other-work': planText?.otherWork, accepted: planText?.accepted }[basis];
  const matched = matchPlanQuote(item.beyondTaskQuote, lines);
  if (matched === 'missing') return keep('声称任务范围外,但引用的原文在计划方写的任务 issue 对应部分里找不到,照常阻断');
  if (matched === 'short') return keep(`声称任务范围外,但引用太短:要引用那一行的一半以上或至少 ${BEYOND_TASK_QUOTE_FULL} 个字,照常阻断`);
  return { beyond: true, basis, note: null };
}

/**
 * 问题的位置、证据、同类位置所在的文件(#244 修复轮按文件从严用),写进结果包的 files。
 * 已经算好的原样保留;没有证据数组(沿用的旧结果、v1 答卷)时算不全,返回 null,不能只拿 path 冒充完整清单。
 */
export function toLocationFiles(finding) {
  if (Array.isArray(finding?.files)) return finding.files;
  if (!Array.isArray(finding?.evidence)) return null;
  return [...new Set([finding.path, ...finding.evidence.map((e) => e?.path), ...(finding.instances ?? []).map((i) => i?.path)].filter((p) => typeof p === 'string' && p))];
}
