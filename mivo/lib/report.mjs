// report.mjs — 校验模型交回的审查结果,并拼出发到 GitHub 的最终报告。纯函数。
// 报告骨架与结论口径照搬 Cindy:## Findings / ## Rule coverage / ## Verification / ## Overall,
// 只报 P0/P1/P2。Mivo 加一行「Mivo 自动审查」区分 PraiseZhu 本人的评论(两者同一账号发出)。
// 作者转 issue 跟进的 P1/P2(见 deferrals.mjs)单列成「已转 issue 跟进的问题」,不阻断、不开 thread。
import { toDeferredSummary } from './deferrals.mjs';
import { normalizeHandoffCoverage } from './handoff.mjs';
import { FINDING_ITEM_SCHEMA, SEVERITIES, normalizeFinding, readHandoffRiskIds, escapeModelText, classifyOrigin, checkEvidence, renderFindingBody, titleOfBody } from './finding.mjs';

export const REPORT_SECTIONS = ['## Findings', '## Rule coverage', '## Verification', '## Overall'];
export const REPORT_HEADER = 'Mivo 自动审查';
export const DEFERRED_SECTION = '## 已转 issue 跟进的问题（不阻断本 PR）';
export const PREEXISTING_SECTION = '## PR 之前就存在的问题（不阻断本 PR）';
export const RULED_KEPT_SECTION = '## 维护者已裁定不改、审查机本轮仍报了（未阻断）';
export const VERIFIER_REFUTED_SECTION = '## 核对员认为不成立（不阻断本 PR）';
export const VERIFIER_DOWNGRADED_SECTION = '## 核对员降级（不阻断本 PR）';
// 打回且有阻断的 P1/P2 时附在结论行后:告诉作者本 PR 修不了的 P1/P2 可以怎么转 issue 跟进。
export const DEFER_HINT = '本 PR 修不了、要留到后续 PR 修的 P1/P2，可以转 issue 跟进：开 issue 写明来自本 PR；在 PR 说明加「转 issue 跟进的审查问题」一节登记，每条一行 `- #<issue 号> <简述>`；再回复并 resolve 对应讨论。审查机重审时不再因它打回。P0 不能这样处理。';
const SEVERITY_RE = /^\s*\[(P[012])\]/;

export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['report', 'findings', 'handoffCoverage'],
  properties: {
    report: { type: 'string', description: '完整 Markdown 审查报告,含四段骨架' },
    findings: { type: 'array', items: FINDING_ITEM_SCHEMA },
    handoffCoverage: {
      type: 'array',
      description: '作者交接 review.md 第 3 节每条 R 的核对结论,每条当前 R 一项;没有交接或没有 R 填空数组',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'evidence', 'note'],
        properties: {
          id: { type: 'string', description: 'R 编号,如 R1' },
          verdict: { type: 'string', enum: ['成立', '不成立', '未核实'] },
          evidence: { type: 'array', description: '证据位置,最多 8 项;每项必须是 PR head 上真实存在的文件和行号',
            items: { type: 'object', additionalProperties: false, required: ['path', 'line'], properties: { path: { type: 'string' }, line: { type: 'integer' } } } },
          note: { type: 'string', description: '核对依据,不超过 800 字;未核实要写原因' },
        },
      },
    },
  },
};

/**
 * @param {unknown} answer 模型交回的 JSON
 * @param {{diffFiles: Record<string,{rightLines:Set<number>, addedLines?:Set<number>}>, deferrals?: {issue:number}[], headReader?: (path:string)=>{exists:boolean,lineCount:number}}} p
 *   diffFiles 是 splitDiffByFile 的结果;deferrals 是服务器核验通过的转 issue 条目;headReader 按 head 上的 git 对象读文件(核对证据)
 * @returns {{ok:true, report:string, findings:object[], deferred:object[], preexisting:object[], notes:string[], evidenceIncomplete:number} | {ok:false, error:string}}
 *   findings 是阻断问题;deferred 是转 issue 跟进的 P1/P2(带 deferredTo,不阻断);preexisting 是 PR 之前就存在的 P1/P2(不阻断)
 *   没有 severity 字段的 v1 项保持原来的判级与输出形状;v2 项带 severity/title/证据/来源等元数据。
 */
export function validateAnswer(answer, { diffFiles, deferrals = [], headReader = null, handoff = null }) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { ok: false, error: '答卷不是 JSON 对象' };
  if (typeof answer.report !== 'string' || !answer.report.trim()) return { ok: false, error: '答卷缺少 report' };
  if (!Array.isArray(answer.findings)) return { ok: false, error: '答卷缺少 findings 数组' };
  const missing = REPORT_SECTIONS.filter((section) => !new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(answer.report));
  if (missing.length) return { ok: false, error: `报告缺少段落:${missing.join(' / ')}` };
  const notes = [];
  const findings = [];
  const deferred = [];
  const preexisting = [];
  let evidenceIncomplete = 0;
  const verifiedIssues = new Set((deferrals ?? []).map((d) => d.issue));
  // 作者交接:只有解析出合法 review 才收 handoffCoverage / handoffRiskIds;出错只记 notes,不影响 ok。
  const handoffOn = handoff?.review?.status === 'parsed';
  const riskIds = new Set(handoffOn ? handoff.review.risks.filter((r) => !r.ambiguous).map((r) => r.id) : []);
  for (const [index, raw] of answer.findings.entries()) {
    const v2 = typeof raw?.severity === 'string';
    const path = String(raw?.path ?? '').trim();
    let body = String(raw?.body ?? '').trim();
    const severity = v2 ? (SEVERITIES.includes(raw.severity) ? raw.severity : undefined) : body.match(SEVERITY_RE)?.[1];
    if (!severity) {
      notes.push(`第 ${index + 1} 条问题不属于 P0/P1/P2,按口径不发布`);
      continue;
    }
    if (!diffFiles[path]) return { ok: false, error: `第 ${index + 1} 条问题的文件 ${path || '(empty)'} 不在本 PR diff 里` };
    const line = Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null;
    const side = raw.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    let item;
    if (line != null && side === 'RIGHT' && diffFiles[path].rightLines.has(line)) {
      item = { path, line, side, body };
    } else {
      // 行号不在 diff 的新侧时不伪造行号:改成文件级 thread(Cindy pr-worker 第 4 节)。文件级项不能带 line 键。
      if (line != null) notes.push(`第 ${index + 1} 条问题的行号 ${line} 不在 diff 新侧,改为文件级评论`);
      item = { path, subject_type: 'file', body };
    }
    if (v2) {
      const normalized = normalizeFinding(raw);
      for (const note of normalized.notes) notes.push(`第 ${index + 1} 条问题:${note}`);
      const meta = normalized.item;
      const origin = classifyOrigin({ ...meta, path, line }, { diffFiles });
      if (origin.note) notes.push(`第 ${index + 1} 条问题:${origin.note}`);
      meta.origin = origin.origin;
      let evidenceComplete = meta.evidence.length > 0;
      if (headReader) {
        const checked = checkEvidence(meta, { headReader });
        evidenceComplete = checked.complete;
        if (!checked.complete) {
          evidenceIncomplete += 1;
          const where = checked.missing.map((m) => (m.path ? `${m.path}${m.line ? `:${m.line}` : ''}` : '(无证据)')).join('、');
          notes.push(`第 ${index + 1} 条问题的证据不完整(${where} 在 head 上找不到),照常阻断`);
        }
      }
      body = renderFindingBody(meta);
      item = { ...item, body, severity, title: meta.title, trigger: meta.trigger, behavior: meta.behavior, impact: meta.impact, fix: meta.fix,
        verify: meta.verify, evidence: meta.evidence, instances: meta.instances, origin: meta.origin, bugClass: meta.bugClass,
        supersedes: meta.supersedes, evidenceComplete };
      if (handoffOn) {
        const linked = readHandoffRiskIds(raw.handoffRiskIds, riskIds);
        if (!linked.complete) notes.push(`第 ${index + 1} 条问题的 handoffRiskIds 缺失或含无效编号,不计入交接关联`);
        item = { ...item, handoffRiskIds: linked.ids, handoffMappingComplete: linked.complete };
      }
    }
    // PR 之前就存在的 P1/P2 不阻断本 PR;P0 不论来源都阻断。
    const place = (target) => ((v2 && ['P1', 'P2'].includes(severity) && target.origin === 'pre-existing') ? preexisting : findings).push(target);
    // 转 issue 跟进:只有 P1/P2、且 issue 号在服务器核验通过的列表里才不阻断;其他情况照常阻断。
    const target = raw.deferredTo ?? null;
    if (target === null) {
      place(item);
    } else if (!Number.isInteger(target) || target <= 0) {
      notes.push(`第 ${index + 1} 条问题的 deferredTo 不是 issue 号,按 null 处理`);
      place(item);
    } else if (severity === 'P0') {
      notes.push(`第 ${index + 1} 条是 P0,不能转 issue(#${target}),照常阻断`);
      place(item);
    } else if (!verifiedIssues.has(target)) {
      notes.push(`第 ${index + 1} 条的 deferredTo #${target} 不在核验通过的 issue 里,照常阻断`);
      place(item);
    } else {
      deferred.push({ ...item, deferredTo: target });
    }
  }
  const coverage = handoffOn ? normalizeHandoffCoverage({ raw: answer.handoffCoverage, review: handoff.review, plan: handoff.plan ?? [], headReader: handoff.headReader, source: handoff.source })
    : { coverage: [], meta: {}, warnings: [] };
  notes.push(...coverage.warnings);
  return { ok: true, report: answer.report.trim(), findings, deferred, preexisting, notes, evidenceIncomplete,
    handoffCoverage: coverage.coverage, handoffCoverageMeta: coverage.meta };
}

// ── 作者交接核对:统计与报告小节 ─────────────────────────────────────────────────
export const HANDOFF_SECTION = '### 作者交接核对';

/**
 * 防带偏指标。findings 必须是 publish 阶段最终的阻断问题数组(核对员/裁定之后)。
 * blocking = associated + outside;outside 就是「交接之外的发现」:没有有效 R 关联声明的阻断问题。
 * deferred / preexisting / 被核对员移除的都不在 findings 里,不计。
 */
export function computeHandoffStats({ review, coverage = [], meta = {}, findings = [], head = null, runId = null }) {
  const blocking = findings.length;
  if (review?.status !== 'parsed') {
    return { version: 1, measuredHead: head, measuredRunId: runId, reused: false, reviewAvailable: false, complete: false,
      risks: 0, coverageVerified: 0, coverageReused: 0, blocking, associated: 0, outside: blocking, mappingUnknown: 0 };
  }
  const associated = findings.filter((f) => (f.handoffRiskIds ?? []).length > 0).length;
  const mappingUnknown = findings.filter((f) => f.handoffMappingComplete !== true).length;
  const verified = coverage.filter((c) => ['成立', '不成立'].includes(c.verdict) && meta[c.id]?.evidenceValid === true);
  return { version: 1, measuredHead: head, measuredRunId: runId, reused: false, reviewAvailable: true, complete: mappingUnknown === 0,
    risks: new Set(review.risks.map((r) => r.id)).size, coverageVerified: verified.length, coverageReused: verified.filter((c) => meta[c.id]?.reused === true).length,
    blocking, associated, outside: blocking - associated, mappingUnknown };
}

const oneLineText = (text, max = 300) => escapeModelText(String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/`/g, "'").trim()).slice(0, max);

/** 服务端生成的「作者交接核对」小节(逐 R 结论 + 固定一行「交接之外的发现：N 条」)。 */
export function renderHandoffCoverageSection({ coverage = [], meta = {}, stats = null } = {}) {
  const lines = [HANDOFF_SECTION, ''];
  if (!coverage.length) lines.push('- 本 PR 的作者交接没有风险条目（R）。');
  for (const c of coverage) {
    const m = meta[c.id] ?? {};
    const evidence = (c.evidence ?? []).map((e) => `\`${oneLineText(e.line ? `${e.path}:${e.line}` : e.path, 120)}\``).join('、') || '(无)';
    const marks = [m.reused ? `沿用（来源 head \`${String(m.sourceHead ?? '').slice(0, 7)}\`）` : '', m.evidenceValid === false && c.verdict !== '未核实' ? '证据未通过检查' : ''].filter(Boolean);
    lines.push(`- ${c.id} · ${c.verdict} · 证据 ${evidence}${marks.length ? ` · ${marks.join('；')}` : ''}${c.note ? ` · ${oneLineText(c.note)}` : ''}`);
  }
  if (stats) {
    lines.push('', `交接之外的发现：${stats.outside} 条${stats.reviewAvailable === false || stats.complete === false ? '（关联记录不完整，不用于趋势比较）' : ''}`);
  }
  lines.push('');
  return lines;
}

/** 把服务端生成的小节放进 Rule coverage 末尾;模型自己写的同名小节先去掉,避免两个计数并存。 */
function applyHandoffSection(lines, section) {
  const start = lines.findIndex((line) => /^## Rule coverage\s*$/.test(line));
  if (start < 0) return lines;
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end += 1;
  let body = lines.slice(start + 1, end);
  // 模型可能写了不止一个同名小节:全部去掉,否则旧计数会和服务端的计数并存。
  for (let own = body.findIndex((line) => line.startsWith(HANDOFF_SECTION)); own >= 0; own = body.findIndex((line) => line.startsWith(HANDOFF_SECTION))) {
    let stop = own + 1;
    while (stop < body.length && !/^#{2,3} /.test(body[stop])) stop += 1;
    body = [...body.slice(0, own), ...body.slice(stop)];
  }
  while (body.length && !body.at(-1).trim()) body.pop();
  return [...lines.slice(0, start + 1), ...body, '', ...section, ...lines.slice(end)];
}

/** 报告里「已转 issue 跟进的问题」一节;没有转 issue 的问题、也没有未采用的登记时返回空数组。 */
export function renderDeferredSection({ deferred = [], rejected = [] } = {}) {
  if (!deferred.length && !rejected.length) return [];
  const lines = [DEFERRED_SECTION, ''];
  if (deferred.length) {
    for (const finding of deferred) {
      const where = finding.line ? `${finding.path}:${finding.line}` : finding.path;
      const first = String(finding.body ?? '').split('\n')[0].trim();
      lines.push(`- #${finding.deferredTo} · \`${where}\` · ${first.length > 200 ? `${first.slice(0, 199)}…` : first}`);
    }
  } else {
    lines.push('- 无');
  }
  if (rejected.length) {
    // 未采用的引用一律包反引号:不生成链接,也不给别的仓发回链通知。
    lines.push('- 登记了但没采用：');
    for (const item of rejected) lines.push(`  - \`${String(item.ref ?? '').replace(/`/g, '')}\`：${item.reason}`);
  }
  lines.push('');
  return lines;
}

const whereOf = (finding) => (finding.line ? `${finding.path}:${finding.line}` : finding.path);
const titleOf = (finding) => {
  const text = finding.title || titleOfBody(finding.body);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
};

/** 报告里「PR 之前就存在的问题」一节;没有时返回空数组。这些 P1/P2 不阻断本 PR,建议另开 issue 跟进。 */
export function renderPreexistingSection(list = []) {
  if (!list.length) return [];
  return [PREEXISTING_SECTION, '', ...list.map((f) => `- \`${whereOf(f)}\` · [${f.severity ?? 'P1'}] ${titleOf(f)} · 建议另开 issue 跟进`), ''];
}

/** 报告里「维护者已裁定不改、审查机本轮仍报了」一节;这些 P1/P2 已从阻断问题里移出。 */
export function renderRuledKeptSection(list = []) {
  if (!list.length) return [];
  return [RULED_KEPT_SECTION, '', ...list.map((f) => `- \`${whereOf(f)}\` · [${f.severity ?? 'P1'}] ${titleOf(f)} · 裁定:@${f.rulingBy ?? ''}`), ''];
}

const locations = (list) => (list ?? []).map((e) => `\`${whereOf(e)}\``).join('、') || '(未给出)';
const oneLine = (text, max = 300) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** 报告里「核对员认为不成立」一节:公开列出标题、位置和推翻证据,作者与维护者可以复核核对员。没有时返回空数组。 */
export function renderVerifierRefutedSection(list = []) {
  if (!list.length) return [];
  return [VERIFIER_REFUTED_SECTION, '', ...list.map((f) => `- \`${whereOf(f)}\` · [${f.severity ?? 'P1'}] ${titleOf(f)} · 推翻证据：${locations(f.evidence)}${f.note ? ` · 依据：${oneLine(f.note)}` : ''}`), ''];
}

export const VERIFIER_UNAVAILABLE_SECTION = '## 核对员未运行（不影响结论）';
/** 核对员模型不可用没核的 P1/P2:只提示,不改结论和阻断判定(这些 P1/P2 照常阻断)。unverified=0 或没有原因时返回空数组。 */
export function renderVerifierUnavailableSection({ count = 0, reason = '' } = {}) {
  if (!count) return [];
  return [VERIFIER_UNAVAILABLE_SECTION, '', `${reason || '核对员模型当前不可用'},${count} 条 P1/P2 没有经过核对员核对,照常阻断。`, ''];
}

/** 报告里「核对员降级」一节:问题成立但核对员认为实际只是 P3,不报,附理由。 */
export function renderVerifierDowngradedSection(list = []) {
  if (!list.length) return [];
  return [VERIFIER_DOWNGRADED_SECTION, '', ...list.map((f) => `- \`${whereOf(f)}\` · [${f.severity ?? 'P1'}] ${titleOf(f)} · 降级理由：${oneLine(f.note)}`), ''];
}

/**
 * 最终报告:固定头部 + 模型正文;结论行按问题数量重写,保证与实际发布的 thread 一致。
 * 有转 issue 跟进的问题或未采用的登记时,在 Rule coverage 前插一节单列;打回且阻断问题里有 P1/P2 时,结论行后附转 issue 的做法。
 */

const MARKER_BLOCK_RE = /\n*<!--\s*mivo-finding[\s\S]*?-->/g;
const stripFindingMarker = (body) => String(body ?? "").replace(MARKER_BLOCK_RE, "").trim();

/** 用最终阻断 findings 重建 Findings 段正文,与 thread 等级一致;去掉服务端 mivo-finding marker。 */
function renderBlockingFindings(findings = []) {
  if (!findings.length) return ["无"];
  const out = [];
  for (const finding of findings) {
    const severity = finding.severity ?? String(finding.body ?? "").match(/^\s*\[(P[012])\]/)?.[1] ?? "P1";
    const title = finding.title || titleOfBody(finding.body);
    out.push("[" + severity + "] " + whereOf(finding) + " — " + title);
    if (finding.title) {
      if (finding.trigger) out.push("触发条件：" + finding.trigger);
      if (finding.behavior) out.push("错误行为：" + finding.behavior);
      if (finding.impact) out.push("影响：" + finding.impact);
      if (finding.evidence && finding.evidence.length) out.push("证据：" + finding.evidence.map((e) => "`" + whereOf(e) + "`").join("、"));
      if (finding.instances && finding.instances.length) out.push("同类位置：" + finding.instances.map((e) => "`" + whereOf(e) + "`").join("、"));
      if (finding.fix) out.push("建议修复：" + finding.fix);
      if (finding.verify) out.push("验证方式：" + finding.verify);
    } else {
      const rest = stripFindingMarker(finding.body).split("\n").slice(1).join("\n").trim();
      if (rest) out.push(rest);
    }
    out.push("");
  }
  while (out.length && out.at(-1) === "") out.pop();
  return out;
}

function replaceFindingsSection(lines, findings) {
  const start = lines.findIndex((line) => /^## Findings\s*$/.test(line));
  if (start < 0) return lines;
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end += 1;
  const body = renderBlockingFindings(findings);
  return [...lines.slice(0, start + 1), "", ...body, "", ...lines.slice(end)];
}

/**
 * 放行前收口全量的状态说明(Verification 下一行)。outcome 来自结果包 mivo.finalFull.outcome,kind 来自 finalFullContext.kind。
 * 没有收口记录(沿用旧结论等)返回 null。
 */
export function finalFullLine({ finalFull = null, kind = null } = {}) {
  if (!finalFull) return null;
  if (finalFull.outcome === 'skipped-fix-round') return '收口全量:本轮是修复轮,改动只落在上次收口问题所在文件,未再收口。';
  if (finalFull.outcome === 'pending-budget') return '收口全量:收口待补——本轮只完成增量,剩余模型预算不足以再做收口,尚未放行;审查机会在同一 head 上自动补跑全量。';
  if (finalFull.outcome === 'error') return '收口全量:收口未完成(模型调用失败),尚未放行;审查机会在同一 head 上自动补跑全量。';
  if (kind === 'same-run') return '收口全量:本轮增量判干净后,同一次运行接着对完整 diff 做了放行前收口全量,以下结论以收口为准。';
  if (kind === 'budget-retry') return '收口全量:补跑(上一次运行的收口没做完),本轮对完整 diff 做收口全量。';
  return '全量审查:本轮已审完整 diff,不需要再做收口。';
}

/** 收口待补的报告:只完成增量,不是通过。Overall 写 pending,不能留下 pass。 */
export function pendingFinalFullReport({ pr, url, head, base, diffHash, tier, scope, remainingMs, requiredMs, skillSha = '', specDigest = '' }) {
  const min = (ms) => Math.max(0, Math.floor((Number(ms) || 0) / 60_000));
  const versions = `${skillSha ? ` · skill \`${String(skillSha).slice(0, 7)}\`` : ''}${specDigest ? ` · spec \`${String(specDigest).slice(0, 7)}\`` : ''}`;
  return [
    `> ${REPORT_HEADER} · [PR](${url}) · head \`${String(head).slice(0, 12)}\` · base \`${String(base).slice(0, 12)}\` · diffHash \`${String(diffHash ?? '').slice(0, 12)}\` · 档位 ${tier}${versions}`,
    '', '## Findings', '', '本轮增量审查没有发现阻断问题,但放行前的收口全量还没做,所以这不是最终结论。', '',
    '## Rule coverage', '', '收口全量完成后给出。', '',
    '## Verification', '', `审查范围:${scope?.reason ?? '增量'}`, '',
    `只完成增量;本轮未完成收口。作业剩余模型预算约 ${min(remainingMs)} 分钟,收口全量至少需要 ${min(requiredMs)} 分钟。审查机会在同一 head 上自动补跑全量,补跑完成前不会 Approve。`, '',
    '## Overall', '', 'pending —— 收口待补，尚未放行。', '',
  ].join('\n');
}

export function finalizeReport({ report, findings, deferred = [], deferralsRejected = [], preexisting = [], ruledKept = [], convergenceLines = [], verifierRefuted = [], verifierDowngraded = [], verifierUnavailable = null,
  pr, url, head, base, diffHash, tier, scope, skillSha = '', specDigest = '', finalFull = null, finalFullKind = null, handoff = null }) {
  const summary = toDeferredSummary(deferred);
  const overruled = verifierRefuted.length + verifierDowngraded.length;
  let conclusion = findings.length === 0
    ? (summary ? `pass —— 没有阻断的 P0/P1/P2；${summary.text}，不阻断本 PR。` : (preexisting.length || overruled ? 'pass —— 没有阻断的 P0/P1/P2。' : 'pass —— 没有 P0/P1/P2。'))
    : `changes-requested —— ${findings.length} 条 P0/P1/P2，已在对应位置开 review thread。`;
  if (findings.length && summary) conclusion += `另有 ${summary.text}，不阻断。`;
  if (!findings.length && preexisting.length) conclusion += `另有 ${preexisting.length} 条 PR 之前就存在的 P1/P2，不阻断本 PR。`;
  // 核对员推翻/降级的 P1/P2:全部卡点都被推翻/降级时明确提示人工再看一眼(服务器不 Approve,只发评论)。
  if (overruled && !findings.length) conclusion += `核对员推翻/降级了全部卡点（${overruled} 条），请人工看一眼再合。`;
  else if (overruled) conclusion += `另有 ${overruled} 条 P1/P2 被核对员推翻/降级，不阻断。`;
  let lines = replaceFindingsSection(String(report).trim().split('\n'), findings);
  if (handoff?.review?.status === 'parsed') lines = applyHandoffSection(lines, renderHandoffCoverageSection(handoff));
  const overallIndex = lines.findIndex((line) => /^## Overall\s*$/.test(line));
  if (overallIndex >= 0) {
    let next = overallIndex + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    let conclusionIndex = next;
    if (next < lines.length && /^(pass|changes-requested)\b/.test(lines[next].trim())) lines[next] = conclusion;
    else { lines.splice(overallIndex + 1, 0, '', conclusion); conclusionIndex = overallIndex + 2; }
    if (findings.some((finding) => /^\s*\[P[12]\]/.test(finding.body))) lines.splice(conclusionIndex + 1, 0, '', DEFER_HINT);
  }
  const verificationIndex = lines.findIndex((line) => /^## Verification\s*$/.test(line));
  const scopeLine = scope?.mode === 'incremental'
    ? `审查范围:${scope.reason}`
    : `审查范围:全量(${scope?.reason ?? '首次审查'})`;
  if (verificationIndex >= 0 && !lines.slice(verificationIndex + 1, verificationIndex + 3).some((line) => line.startsWith('审查范围'))) {
    const stateLine = finalFullLine({ finalFull, kind: finalFullKind });
    lines.splice(verificationIndex + 1, 0, '', scopeLine, ...(stateLine ? ['', stateLine] : []));
  }
  // 单列的几节在 Rule coverage 前一次性插入,已转 issue 的在最前。
  const extraLines = [...renderDeferredSection({ deferred, rejected: deferralsRejected }), ...renderPreexistingSection(preexisting),
    ...renderRuledKeptSection(ruledKept), ...renderVerifierRefutedSection(verifierRefuted), ...renderVerifierDowngradedSection(verifierDowngraded), ...renderVerifierUnavailableSection(verifierUnavailable ?? {}), ...convergenceLines];
  if (extraLines.length) {
    const coverageIndex = lines.findIndex((line) => /^## Rule coverage\s*$/.test(line));
    if (coverageIndex >= 0) lines.splice(coverageIndex, 0, ...(lines[coverageIndex - 1]?.trim() ? [''] : []), ...extraLines);
    else lines.push('', ...extraLines);
  }
  const versions = `${skillSha ? ` · skill \`${String(skillSha).slice(0, 7)}\`` : ''}${specDigest ? ` · spec \`${String(specDigest).slice(0, 7)}\`` : ''}`;
  const header = [
    `> ${REPORT_HEADER} · [PR](${url}) · head \`${String(head).slice(0, 12)}\` · base \`${String(base).slice(0, 12)}\` · diffHash \`${String(diffHash ?? '').slice(0, 12)}\` · 档位 ${tier}${versions}`,
    '',
  ];
  const body = lines.join('\n').replace(/^>\s*Mivo 自动审查[^\n]*\n+/, '');
  return `${header.join('\n')}${body}\n`;
}

/** 复用上一轮结论时的报告:说明来源,不冒充本轮重新读过代码。 */
export function reusedReport({ previousReport, scope }) {
  const note = `> 本轮沿用上一轮审查结论(${scope.reason};上一轮 head \`${String(scope.basedOn ?? '').slice(0, 12)}\`)。`;
  return `${note}\n\n${String(previousReport ?? '').trim()}\n`;
}

// 发布前最后一道:报告和问题里出现高置信凭证格式就替换掉。审查 agent 读得到 runner 上的文件,
// PR 里的提示注入可能诱导它把凭证抄进报告;报告是发到 PR 上的,宁可多删。
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9][A-Za-z0-9-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];
export function scrubSecrets(text) {
  let out = String(text ?? '');
  let hits = 0;
  for (const re of SECRET_PATTERNS) out = out.replace(re, () => { hits += 1; return '‹凭证已脱敏›'; });
  return { text: out, hits };
}
