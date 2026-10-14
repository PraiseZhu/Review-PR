// scope.mjs — 增量复审的范围计算(Mivo 特有,方案第 8 节)。纯函数。
// 对比上次审过的版本 H0 与这次的 H1:逐文件比较 PR patch,只审 patch 变了的文件,
// 外加上一轮有问题的文件(逐条核对是否真修好)。任一兜底条件命中就退回全量。
import { createHash } from 'node:crypto';

export const FULL_REVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TIER_RANK = { light: 0, standard: 1, heavy: 2 };

/** 按文件切 unified diff;返回 { path: { hash, changedLines, rightLines:Set<number> } }。 */
export function splitDiffByFile(diffText) {
  const files = {};
  let current = null;
  let newLine = 0;
  const finish = () => {
    if (!current) return;
    current.hash = createHash('sha256').update(current.body.join('\n')).digest('hex');
    delete current.body;
  };
  for (const raw of String(diffText ?? '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      finish();
      const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = { path: m ? m[2] : raw, body: [], changedLines: 0, rightLines: new Set() };
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

/**
 * @param {object} p
 * @param {object|null} p.previous 上一次服务器审查结果(含 head/baseRefName/diffHash/filePatchHashes/findings/deferred/...)
 * @param {object} p.current 本次 {head, baseRefName, diffHash, filePatchHashes, totalDiffLines, tier, triggerKinds, skillSha, rulesDigest, now}
 * @param {boolean|null} p.headIsDescendant H0 是否是 H1 的祖先(git merge-base --is-ancestor);null=未知
 * @returns {{mode:'full'|'incremental'|'reuse', reason:string, files:string[], previousFindings:object[], basedOn:string|null}}
 */
export function computeReviewScope({ previous, current, headIsDescendant }) {
  const full = (reason) => ({ mode: 'full', reason, files: Object.keys(current.filePatchHashes ?? {}).sort(), previousFindings: [], basedOn: null });
  if (!previous) return full('没有上一轮审查记录');
  if (previous.reviewed !== true || previous.reportComplete !== true || previous.outcome === 'error') return full('上一轮没审完或没有完整报告');
  if (previous.baseRefName !== current.baseRefName) return full(`base 分支变了(${previous.baseRefName} → ${current.baseRefName})`);
  if ((TIER_RANK[current.tier] ?? 1) > (TIER_RANK[previous.tier] ?? 1)) return full(`档位升级(${previous.tier} → ${current.tier})`);
  const newKinds = (current.triggerKinds ?? []).filter((kind) => !(previous.triggerKinds ?? []).includes(kind));
  if (newKinds.length) return full(`新增确认门触发(${newKinds.join('、')})`);
  if (previous.skillSha !== current.skillSha) return full('审查 skill 版本变了');
  if (previous.rulesDigest !== current.rulesDigest) return full('规则文件变了');
  const lastFull = Date.parse(previous.lastFullReviewAt ?? '');
  if (!Number.isFinite(lastFull) || current.now - lastFull > FULL_REVIEW_MAX_AGE_MS) return full('距上次完整审查超过 7 天');

  const sameDiff = previous.diffHash && previous.diffHash === current.diffHash;
  // 上一轮转 issue 跟进的问题(deferred)也不算干净:issue 可能已关闭或撤了登记,每轮都重新核验,不沿用结论。
  const carried = [...(previous.findings ?? []), ...(previous.deferred ?? [])];
  const previousClean = carried.length === 0 && previous.reviewClean === true;
  if (previous.head !== current.head && headIsDescendant !== true) {
    if (sameDiff && previousClean) return reuse(previous, '强制推送/rebase,但 diff 完全相同,沿用上次结论');
    return full('上次审过的版本不是当前版本的祖先(强制推送或 rebase)');
  }

  const before = previous.filePatchHashes ?? {};
  const after = current.filePatchHashes ?? {};
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path]).sort();
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
  };
}

function reuse(previous, reason) {
  return { mode: 'reuse', reason, files: [], previousFindings: previous.findings ?? [], basedOn: previous.head };
}
