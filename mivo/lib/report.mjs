// report.mjs — 校验模型交回的审查结果,并拼出发到 GitHub 的最终报告。纯函数。
// 报告骨架与结论口径照搬 Cindy:## Findings / ## Rule coverage / ## Verification / ## Overall,
// 只报 P0/P1。Mivo 加一行「Mivo 自动审查」区分 PraiseZhu 本人的评论(两者同一账号发出)。

export const REPORT_SECTIONS = ['## Findings', '## Rule coverage', '## Verification', '## Overall'];
export const REPORT_HEADER = 'Mivo 自动审查';
const SEVERITY_RE = /^\s*\[(P0|P1)\]/;

export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['report', 'findings'],
  properties: {
    report: { type: 'string', description: '完整 Markdown 审查报告,含四段骨架' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line', 'side', 'body'],
        properties: {
          path: { type: 'string', description: '问题所在文件,必须是本 PR diff 里的文件' },
          line: { type: ['integer', 'null'], description: 'RIGHT 侧行号;没有准确行号写 null' },
          side: { type: 'string', enum: ['RIGHT', 'LEFT'] },
          body: { type: 'string', description: '以 [P0] 或 [P1] 开头,写事实/影响/建议修复/验证方式' },
        },
      },
    },
  },
};

/**
 * @param {unknown} answer 模型交回的 JSON
 * @param {{diffFiles: Record<string,{rightLines:Set<number>}>}} diff splitDiffByFile 的结果
 * @returns {{ok:true, report:string, findings:object[], notes:string[]} | {ok:false, error:string}}
 */
export function validateAnswer(answer, { diffFiles }) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { ok: false, error: '答卷不是 JSON 对象' };
  if (typeof answer.report !== 'string' || !answer.report.trim()) return { ok: false, error: '答卷缺少 report' };
  if (!Array.isArray(answer.findings)) return { ok: false, error: '答卷缺少 findings 数组' };
  const missing = REPORT_SECTIONS.filter((section) => !new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(answer.report));
  if (missing.length) return { ok: false, error: `报告缺少段落:${missing.join(' / ')}` };
  const notes = [];
  const findings = [];
  for (const [index, raw] of answer.findings.entries()) {
    const body = String(raw?.body ?? '').trim();
    const path = String(raw?.path ?? '').trim();
    if (!SEVERITY_RE.test(body)) {
      notes.push(`第 ${index + 1} 条问题不是 P0/P1,按口径不发布`);
      continue;
    }
    if (!diffFiles[path]) return { ok: false, error: `第 ${index + 1} 条问题的文件 ${path || '(empty)'} 不在本 PR diff 里` };
    const line = Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null;
    const side = raw.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    if (line != null && side === 'RIGHT' && diffFiles[path].rightLines.has(line)) {
      findings.push({ path, line, side, body });
    } else {
      // 行号不在 diff 的新侧时不伪造行号:改成文件级 thread(Cindy pr-worker 第 4 节)。
      if (line != null) notes.push(`第 ${index + 1} 条问题的行号 ${line} 不在 diff 新侧,改为文件级评论`);
      findings.push({ path, subject_type: 'file', body });
    }
  }
  return { ok: true, report: answer.report.trim(), findings, notes };
}

/** 最终报告:固定头部 + 模型正文;结论行按问题数量重写,保证与实际发布的 thread 一致。 */
export function finalizeReport({ report, findings, pr, url, head, base, diffHash, tier, scope }) {
  const conclusion = findings.length === 0
    ? 'pass —— 没有 P0/P1。'
    : `changes-requested —— ${findings.length} 条 P0/P1，已在对应位置开 review thread。`;
  const lines = String(report).trim().split('\n');
  const overallIndex = lines.findIndex((line) => /^## Overall\s*$/.test(line));
  if (overallIndex >= 0) {
    let next = overallIndex + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next < lines.length && /^(pass|changes-requested)\b/.test(lines[next].trim())) lines[next] = conclusion;
    else lines.splice(overallIndex + 1, 0, '', conclusion);
  }
  const verificationIndex = lines.findIndex((line) => /^## Verification\s*$/.test(line));
  const scopeLine = scope?.mode === 'incremental'
    ? `审查范围:${scope.reason}`
    : `审查范围:全量(${scope?.reason ?? '首次审查'})`;
  if (verificationIndex >= 0 && !lines.slice(verificationIndex + 1, verificationIndex + 3).some((line) => line.startsWith('审查范围'))) {
    lines.splice(verificationIndex + 1, 0, '', scopeLine);
  }
  const header = [
    `> ${REPORT_HEADER} · [PR](${url}) · head \`${String(head).slice(0, 12)}\` · base \`${String(base).slice(0, 12)}\` · diffHash \`${String(diffHash ?? '').slice(0, 12)}\` · 档位 ${tier}`,
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
