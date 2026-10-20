// finding.mjs — 审查问题(finding)的 v2 结构:答卷 schema、稳定 key、thread 正文与 marker、证据核对、来源改判。纯函数。
// 借鉴 Claude 官方审查机的三点:每条问题带证据与来源;同一问题跨轮用同一个 key;thread 里留机读 marker 供收敛与遥测使用。
// schema 里不写 maxLength/minItems/maxItems:公司网关的 strict 结构化输出是否支持这些关键字没有核实,
// 被拒收会让每个审查都在模型阶段失败。长度与条数的限制只写在 description 里,由 normalizeFinding 在服务器端截断。
import { createHash } from 'node:crypto';

export const SEVERITIES = ['P0', 'P1', 'P2'];
export const ORIGINS = ['introduced', 'made-reachable', 'pre-existing'];
export const LIMITS = { title: 120, text: 800, bugClass: 60, evidence: 8, instances: 20 };
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
  required: ['severity', 'title', 'trigger', 'behavior', 'impact', 'fix', 'verify', 'evidence', 'origin', 'bugClass', 'instances', 'supersedes', 'path', 'line', 'side', 'deferredTo'],
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
    deferredTo: { type: ['integer', 'null'], description: '同一问题已转 issue 跟进时填该 issue 号(只限 P1/P2,且必须在任务书核验通过的列表里);其他一律 null' },
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
  if (!evidence.length) notes.push('没有给出证据位置');
  const instances = normalizeLocations(raw?.instances, LIMITS.instances, '同类位置', notes);
  let supersedes = raw?.supersedes ?? null;
  if (supersedes !== null && !(typeof supersedes === 'string' && SUPERSEDES_RE.test(supersedes))) {
    notes.push('supersedes 不是上一轮列出的 key,按新问题处理');
    supersedes = null;
  }
  const origin = ORIGINS.includes(raw?.origin) ? raw.origin : 'introduced';
  return { item: { severity: raw?.severity, title, ...text, evidence, instances, origin, bugClass, supersedes }, notes };
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
  const evidence = item?.evidence ?? [];
  if (!evidence.length) missing.push({ path: null, line: null, reason: 'empty' });
  for (const { path, line } of evidence) {
    if (!pathIsSafe(path)) { missing.push({ path, line, reason: 'path-invalid' }); continue; }
    const read = headReader(path) ?? { exists: false, lineCount: 0 };
    if (!read.exists) missing.push({ path, line, reason: 'not-found' });
    else if (line && read.lineCount > 0 && line > read.lineCount) missing.push({ path, line, reason: 'line-out-of-range' });
  }
  return { complete: missing.length === 0, missing };
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
