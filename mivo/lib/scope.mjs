// scope.mjs — 增量复审的范围计算(Mivo 特有,方案第 8 节)。纯函数。
// 对比上次审过的版本 H0 与这次的 H1:逐文件比较 PR patch,只审 patch 变了的文件,
// 外加上一轮有问题的文件(逐条核对是否真修好)。任一兜底条件命中就退回全量。
// 本模块是纯函数:配置文件由调用方读取后注入(loadSpecChangePolicy 只解析注入的读取函数)。
import { createHash } from 'node:crypto';

export const FULL_REVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TIER_RANK = { light: 0, standard: 1, heavy: 2 };

/** 按文件切 unified diff;返回 { path: { hash, changedLines, rightLines:Set<number>, addedLines:Set<number> } };addedLines 只含 `+` 行的新侧行号。 */
export function splitDiffByFile(diffText) {
  const files = {};
  let current = null;
  let newLine = 0;
  const finish = () => {
    if (!current) return;
    current.hash = createHash('sha256').update(current.body.join('\n')).digest('hex');
    // v2:v1 的内容 + 新内容 blob 编号前 7 位 + mode 行。挪位置/只改权限/换二进制(Binary files 行不变)在 v1 里看不出,v2 能区分。
    current.hashV2 = createHash('sha256').update(['v2', ...current.meta, ...current.body].join('\n')).digest('hex');
    delete current.body;
    delete current.meta;
  };
  for (const raw of String(diffText ?? '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      finish();
      const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = { path: m ? m[2] : raw, body: [], meta: [], changedLines: 0, rightLines: new Set(), addedLines: new Set() };
      files[current.path] = current;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).replace(/^b\//, '').trim();
      if (path !== '/dev/null' && path !== current.path) {
        delete files[current.path];
        current.path = path;
        files[path] = current;
      }
      continue;
    }
    if (raw.startsWith('old mode') || raw.startsWith('new mode') || raw.startsWith('new file mode')) current.meta.push(raw);
    else if (raw.startsWith('index ')) {
      const blob = raw.match(/\.\.(\S+)/);
      if (blob) current.meta.push(`index ..${blob[1].slice(0, 7)}`);
    }
    if (raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') ||
        raw.startsWith('similarity ') || raw.startsWith('rename ') || raw.startsWith('old mode') || raw.startsWith('new mode') ||
        raw.startsWith('Binary files')) {
      if (raw.startsWith('Binary files')) current.body.push(raw);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    // 只把真正的改动行算进指纹:base 前移导致的行号/上下文漂移不算这个文件变了。
    if (raw.startsWith('+')) {
      current.body.push(raw);
      current.changedLines += 1;
      current.rightLines.add(newLine);
      current.addedLines.add(newLine);
      newLine += 1;
    } else if (raw.startsWith('-')) {
      current.body.push(raw);
      current.changedLines += 1;
    } else if (!raw.startsWith('\\')) {
      current.rightLines.add(newLine);
      newLine += 1;
    }
  }
  finish();
  return files;
}

export const filePatchHashes = (files) => Object.fromEntries(Object.entries(files).map(([path, f]) => [path, f.hash]).sort());
export const filePatchHashesV2 = (files) => Object.fromEntries(Object.entries(files).map(([path, f]) => [path, f.hashV2]).sort());

/**
 * @param {object} p
 * @param {object|null} p.previous 上一次服务器审查结果(含 head/baseRefName/diffHash/filePatchHashes/findings/deferred/...)
 * @param {object} p.current 本次 {head, baseRefName, diffHash, filePatchHashes, totalDiffLines, tier, triggerKinds, specDigest, now}
 * @param {boolean|null} p.headIsDescendant H0 是否是 H1 的祖先(git merge-base --is-ancestor);null=未知
 * @param {boolean} [p.forceFullOnSpecChange] 维护者开关(review-features.json 的 specChange.forceFull):规则改版时即使代码没变也全量;只认 true
 * @returns {{mode:'full'|'incremental'|'reuse', reason:string, files:string[], previousFindings:object[], basedOn:string|null}}
 */
export function computeReviewScope({ previous, current, headIsDescendant, forceFullOnSpecChange = false }) {
  // 上一轮有完整结果时,全量轮也带着它的问题(含转 issue 的),任务书据此逐条核对;顺序原样,legacy-N 编号依赖它。
  const trusted = previous?.reviewed === true && previous?.reportComplete === true && previous?.outcome !== 'error';
  // 条目的文件已不在本轮 PR 改动里的标 outOfDiff:任务书据此要求只在 Verification 写结论、不进 findings
  // (答卷校验要求 finding 的文件必须在 diff 里,写了整轮会被判答卷不合格)。拿不到本轮指纹时不标。
  const inDiff = current.filePatchHashes ? (path) => path in current.filePatchHashes : () => true;
  const carried = trusted
    ? [...(previous.findings ?? []), ...(previous.deferred ?? [])].map((f) => (inDiff(f.path) ? f : { ...f, outOfDiff: true }))
    : [];
  const full = (reason) => ({ mode: 'full', reason, files: Object.keys(current.filePatchHashes ?? {}).sort(), previousFindings: carried, basedOn: null });
  if (!previous) return full('没有上一轮审查记录');
  // 同 head 上一次运行的收口全量没做完(预算不足或收口失败):这次直接全量补跑。优先于下面「上一轮没审完」的通用分支,
  // 并带上待核对的旧问题清单(outOfDiff 按本轮 diff 重算)。head 变了就不适用,走下面的常规判断。
  const pending = previous.pendingFinalFull;
  if (pending && pending.head === current.head && previous.head === current.head) {
    const restored = pending.previousFindings.map((f) => { const { outOfDiff, ...rest } = f; return inDiff(f.path) ? rest : { ...rest, outOfDiff: true }; });
    return { mode: 'full', reason: '补跑收口全量(上一次运行收口未完成)', files: Object.keys(current.filePatchHashes ?? {}).sort(),
      previousFindings: restored, basedOn: null, purpose: 'final-full', finalFullKind: 'budget-retry' };
  }
  if (previous.reviewed !== true || previous.reportComplete !== true || previous.outcome === 'error') return full('上一轮没审完或没有完整报告');
  // 上一轮因为交接不完整没放行、本轮交接补齐了:按交接重新全量审(增量范围只有那两份 md,看不到交接指向的代码)。
  if ((previous.pendingGates ?? []).includes('handoff') && !(current.pendingGates ?? []).includes('handoff')) return full('上一轮缺有效交接、本轮已补齐,按交接重新全量审查');
  // 上一轮核对员推翻/降级了全部卡点、等人工复核(服务器没有 Approve):状态不能被无关文件的小改动冲掉,
  // 否则增量范围里没有争议代码,新一轮主审返回零问题就会恢复 Approve。重新全量审查,得出新结论为止。
  if (previous.manualReview === true) return full('上一轮核对员推翻/降级了全部卡点,等待人工复核,本轮重新全量审查');
  if (previous.baseRefName !== current.baseRefName) return full(`base 分支变了(${previous.baseRefName} → ${current.baseRefName})`);
  if ((TIER_RANK[current.tier] ?? 1) > (TIER_RANK[previous.tier] ?? 1)) return full(`档位升级(${previous.tier} → ${current.tier})`);
  const newKinds = (current.triggerKinds ?? []).filter((kind) => !(previous.triggerKinds ?? []).includes(kind));
  if (newKinds.length) return full(`新增确认门触发(${newKinds.join('、')})`);
  // 任务书版本(prompt.mjs 的 specDigest):只比任务书材料,审查机代码换版本但材料没变时仍可增量。
  // 先显式判断字段存在:旧结果没有这个字段时退回全量,不能让两个 undefined 判成相等。
  if (!previous.specDigest) return full('上一轮没有任务书版本记录');
  if (!current.specDigest) return full('本轮没有任务书版本');
  // 规则改版本身不触发全量:先比 PR 改动,代码没变就沿用上次结论(下面 specChanged 分支);forceFull=true 才一变就全量。
  const specChanged = previous.specDigest !== current.specDigest;
  if (specChanged && forceFullOnSpecChange === true) return full('审查任务书或规则变了');
  const lastFull = Date.parse(previous.lastFullReviewAt ?? '');
  if (!Number.isFinite(lastFull) || current.now - lastFull > FULL_REVIEW_MAX_AGE_MS) return full('距上次完整审查超过 7 天');

  const sameDiff = previous.diffHash && previous.diffHash === current.diffHash;
  // 上一轮转 issue 跟进的问题(deferred)也不算干净:issue 可能已关闭或撤了登记,每轮都重新核验,不沿用结论。
  const previousClean = carried.length === 0 && previous.reviewClean === true;
  if (previous.head !== current.head && headIsDescendant !== true) {
    if (!specChanged && sameDiff && previousClean) return reuse(previous, '强制推送/rebase,但 diff 完全相同,沿用上次结论');
    return full('上次审过的版本不是当前版本的祖先(强制推送或 rebase)');
  }

  // 过渡期:双方都有 v2(非空对象)才按 v2 比;上一轮只有 v1 时按 v1 比,避免 v1/v2 混比导致全部文件都算变。
  const isFilled = (o) => o && typeof o === 'object' && Object.keys(o).length > 0;
  const useV2 = isFilled(previous.filePatchHashesV2) && isFilled(current.filePatchHashesV2);
  const before = (useV2 ? previous.filePatchHashesV2 : previous.filePatchHashes) ?? {};
  const after = (useV2 ? current.filePatchHashesV2 : current.filePatchHashes) ?? {};
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path]).sort();
  if (specChanged) {
    if (changed.length > 0) return full('审查任务书或规则变了');
    if (!previousClean && carried.length === 0) return full('上一轮未放行且没有可沿用的问题条目,重新全量确认');
    // 转 issue 的问题要本轮仍核验通过才能沿用;issue 关了或撤了登记,不是「只有规则变」,重新全量。
    const verifiedIssues = current.verifiedDeferralIssues ?? [];
    if ((previous.deferred ?? []).some((d) => !verifiedIssues.includes(d.deferredTo))) return full('上一轮转 issue 的问题本轮未核验通过,重新全量确认');
    return reuse(previous, '规则改版，代码未变，沿用上次结论');
  }
  // 上一轮已干净、本轮代码有变化:不先跑增量,直接全量(放行前的收口并入这一轮)。规则改版代码没变的沿用分支已在上面处理。
  if (previousClean && changed.length > 0) return full('上一轮已干净,本轮代码有变化,直接全量');
  const findingFiles = [...new Set(carried.map((f) => f.path).filter((path) => path in after))];
  const changedLines = changed.reduce((sum, path) => sum + (current.fileChangedLines?.[path] ?? 0), 0);
  if (previous.totalDiffLines > 0 && changedLines > previous.totalDiffLines / 2) {
    return full(`变化行数 ${changedLines} 超过上一版 diff(${previous.totalDiffLines} 行)的一半`);
  }
  if (changed.length === 0 && findingFiles.length === 0) {
    if (!previousClean) return full('上一轮有问题但相关文件已不在 diff 里,重新全量确认');
    return reuse(previous, previous.head === current.head ? '同一版本已审过,沿用上次结论' : '只有 base 前移,PR 改动没变,沿用上次结论');
  }
  const files = [...new Set([...changed.filter((path) => path in after), ...findingFiles])].sort();
  if (files.length === 0) return full('变化只有删除文件,重新全量确认');
  return {
    mode: 'incremental',
    reason: `增量(基于 ${String(previous.head).slice(0, 12)},本轮审 ${files.length} 个文件)`,
    files,
    previousFindings: carried,
    basedOn: previous.head,
    // 本轮 patch 变了的文件:收敛模块据此判断「新问题是不是出在没改过的文件里」。
    changedFiles: changed.filter((path) => path in after),
    // 防拉锯:上一轮是收口全量且有问题,本轮改动全落在那些问题所在文件里 → 增量判干净即放行,不再收口。
    // 只是候选;本轮最终确实干净才会写进结果包(review.mjs)。
    ...fixRoundExemption({ previous, changed }),
  };
}

/** 修复轮免收口的候选(SC4)。条件全部满足才返回 { finalFullExemption },否则返回 {}。 */
export function fixRoundExemption({ previous, changed }) {
  const source = previous?.finalFull;
  const ctx = previous?.finalFullContext;
  if (!source || source.outcome !== 'findings' || source.head !== previous.head) return {};
  if (!['same-run', 'budget-retry'].includes(ctx?.kind)) return {};
  if ((previous.findings ?? []).length === 0) return {};
  const issueFiles = ctx.findingFiles ?? [];
  if (issueFiles.length === 0 || changed.length === 0 || !changed.every((path) => issueFiles.includes(path))) return {};
  return { finalFullExemption: { sourceHead: source.head, sourceRunId: source.runId, issueFiles: [...issueFiles].sort(), changedFiles: [...changed].sort() } };
}

/**
 * 规则改版沿用带问题的上一轮时,同一 head 上一轮已发过的 review 直接沿用、不再发:
 * reusedReport 改写了正文,发布器的 review 标记(head+正文+comments 摘要)对不上,会在同一 head 再开一遍同样的行内 thread。
 * 跨 head 或上一轮没发过 review(dry-run、发布失败)返回 null,照常发布。
 * @param {object} previous 上一轮 result.json
 * @param {string} head 本轮 head
 */
export function reusableReview(previous, head) {
  if (!previous?.head || previous.head !== head || !previous.mivo?.review) return null;
  return { review: previous.mivo.review, threadUrls: previous.threadUrls ?? [] };
}

function reuse(previous, reason) {
  return { mode: 'reuse', reason, files: [], previousFindings: [...(previous.findings ?? []), ...(previous.deferred ?? [])], basedOn: previous.head };
}

/**
 * 沿用上一轮阻断问题时的锚点处理:head 或 diff 变了(规则改版沿用可以跨 head),旧行号在新版本上不一定有效,
 * 发布器不会按 diff 重定位。这时改成文件级评论,key/轮次/正文不动。head 与 diffHash 都确认相同才保留原行号。
 * @returns {object[]} 新数组,不改输入
 */
export function reanchorReusedFindings(findings, { previousHead, previousDiffHash, head, diffHash }) {
  const sameAnchor = Boolean(previousHead) && previousHead === head && Boolean(previousDiffHash) && previousDiffHash === diffHash;
  if (sameAnchor) return (findings ?? []).map((f) => ({ ...f }));
  return (findings ?? []).map((f) => {
    const { line, side, position, start_line, start_side, ...rest } = f;
    return { ...rest, subject_type: 'file' };
  });
}

/**
 * 规则改版沿用时的 findings 与 review:同一 head 上一轮已发过 review 就整体沿用(findings 原样、不重发),
 * 否则要发新 review,这时才按 head/diff 重定位(转文件级)。
 * 沿用不重发时 PR 上仍是原来的行级 thread,结果包里的 findings 必须和它一致:base 前移导致 diffHash 变了也不能抹行号,
 * 否则后续轮次任务书里的旧问题丢了原位置。
 * @returns {{findings: object[], reusedReview: {review: object, threadUrls: string[]}|null}}
 */
export function reuseFindings(previous, { head, diffHash }) {
  const reusedReview = reusableReview(previous, head);
  const findings = reusedReview
    ? (previous?.mivo?.findings ?? []).map((f) => ({ ...f }))
    : reanchorReusedFindings(previous?.mivo?.findings ?? [], { previousHead: previous?.head, previousDiffHash: previous?.reviewEvidence?.diffHash, head, diffHash });
  return { findings, reusedReview };
}

/**
 * review-features.json 的 specChange 策略。readText 由调用方注入(读不到就抛)。
 * 缺块/缺字段=默认 false 且不告警(旧配置兼容);读不到、解析失败、类型不对=false + 固定 warning(不回显配置原文)。
 * @returns {{forceFull:boolean, warning:string|null}}
 */
export function loadSpecChangePolicy(readText) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  let raw;
  try { raw = JSON.parse(readText()); } catch {
    return { forceFull: false, warning: 'review-features.json 读不到或不合法，specChange.forceFull 按 false 处理' };
  }
  const bad = { forceFull: false, warning: 'review-features.json 的 specChange.forceFull 配置不合法，按 false 处理' };
  if (!isObject(raw)) return { forceFull: false, warning: 'review-features.json 读不到或不合法，specChange.forceFull 按 false 处理' };
  if (raw.specChange === undefined) return { forceFull: false, warning: null };
  if (!isObject(raw.specChange)) return bad;
  const value = raw.specChange.forceFull;
  if (value === undefined) return { forceFull: false, warning: null };
  if (typeof value !== 'boolean') return bad;
  return { forceFull: value, warning: null };
}

// advisory(review.mjs 的 publishAdvisory):代码没有 P0/P1,只是前置门没过。result.reviewClean 记 false 是给 Mini 看的「还没放行」,
// 不是「代码审查有问题」。范围判定要的是后者:有挂起的门、且没有问题条目,代码层面就是干净的。
// 转 issue 的问题(deferred)不在这里算,computeReviewScope 的 carried 另外拦。
// 挂起的门有两种来源:pendingGates(prepare 时判门发现的)和 blockers(作者就是审查账号时,发布阶段 approve 脚本实时读到的其它拦截项),都算。
const codeReviewClean = (result) => result.reviewClean === true
  || (((result.mivo?.advisory?.pendingGates?.length ?? 0) + (result.mivo?.advisory?.blockers?.length ?? 0)) > 0
    && (result.mivo?.findings ?? []).length === 0);

// 结果包里的收口记录(result.mivo.finalFull / finalFullContext)只认形状完整的值;缺失或畸形一律当没有,相关豁免/补跑随之失效。
const FINAL_FULL_OUTCOMES = ['clean', 'findings', 'manual-review', 'pending-budget', 'error', 'skipped-fix-round'];
const FINAL_FULL_KINDS = ['same-run', 'budget-retry', 'direct-full'];
const safePath = (p) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..');
const pathList = (v) => (Array.isArray(v) && v.every(safePath) ? [...new Set(v)].sort() : null);
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);

export function readFinalFull(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isSha(raw.head) || !/^\d{1,15}$/.test(String(raw.runId ?? '')) || !FINAL_FULL_OUTCOMES.includes(raw.outcome)) return null;
  return { head: raw.head, runId: String(raw.runId), outcome: raw.outcome };
}

export function readFinalFullContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !FINAL_FULL_KINDS.includes(raw.kind)) return null;
  const findingFiles = pathList(raw.findingFiles ?? []);
  return findingFiles ? { kind: raw.kind, findingFiles, previousRound: raw.previousRound ?? null } : null;
}

// 同 head 的收口没做完(待补/失败)的标记:顶层必须是 error+retry,记录的 head/runId 与结果自己的一致。
function pendingFinalFullOf(result, finalFull, context) {
  if (!finalFull || !context || !['pending-budget', 'error'].includes(finalFull.outcome)) return null;
  if (!['same-run', 'budget-retry'].includes(context.kind)) return null;
  if (result.outcome !== 'error' || result.retry !== true || finalFull.head !== result.head || finalFull.runId !== String(result.mivo?.runId ?? '')) return null;
  const old = result.mivo?.scope?.previousFindings;
  const previousFindings = Array.isArray(old) ? old.filter((f) => f && typeof f === 'object' && safePath(f.path)) : [];
  return { head: finalFull.head, runId: finalFull.runId, kind: context.kind, previousFindings };
}

/** 上一次服务器审查的结果包(result.json + report.md)→ computeReviewScope 用的上一轮记录。 */
export function previousFromResult(result, report = '') {
  const finalFull = readFinalFull(result.mivo?.finalFull);
  const finalFullContext = readFinalFullContext(result.mivo?.finalFullContext);
  return {
    finalFull, finalFullContext, pendingFinalFull: pendingFinalFullOf(result, finalFull, finalFullContext),
    head: result.head, baseRefName: result.reviewEvidence?.baseRefName, diffHash: result.reviewEvidence?.diffHash,
    reviewed: result.reviewed, reviewClean: codeReviewClean(result), outcome: result.outcome,
    pendingGates: result.mivo?.advisory?.pendingGates ?? [],
    reportComplete: result.mivo?.reportComplete === true, findings: result.mivo?.findings ?? [], deferred: result.mivo?.deferred ?? [],
    filePatchHashes: result.mivo?.filePatchHashes ?? {}, filePatchHashesV2: result.mivo?.filePatchHashesV2 ?? null, totalDiffLines: result.mivo?.totalDiffLines ?? 0,
    tier: result.mivo?.tier, triggerKinds: result.mivo?.triggerKinds ?? [], skillSha: result.mivo?.skillSha,
    specDigest: result.mivo?.specDigest, lastFullReviewAt: result.mivo?.lastFullReviewAt, report,
    // 全部卡点被核对员推翻/降级、等人工复核。没有显式标记时按形状认:没有阻断问题、有被推翻/降级的问题、而且上一轮没有放行。
    manualReview: result.mivo?.verifierOverruledAll === true || (result.reviewClean !== true && (result.mivo?.findings ?? []).length === 0
      && (result.mivo?.deferred ?? []).length === 0 && (result.mivo?.verifierOverruled ?? []).length > 0),
  };
}
