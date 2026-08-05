#!/usr/bin/env node
// lib.review-requirements.mjs — 审查要求的**唯一权威推导**(SC-R1a 第 2 轮核验 BLOCKER)。
//
// 为什么必须独立成一处:此前 coverage keys / segments / profile 必答 / required 负向证据
// 只由 build-review-task 计算并**写进 task 文件**,consumer 只验 task 的 snapshotHash 与
// 数组形状 —— 于是保留真实 snapshotHash、把 coverage/segments/required 三个数组清空,
// consumer 仍 exit 0 + clean(核验席实测)。task 文件是可编辑的普通 JSON,不能当权威。
//
// 现在 consumer 用**同一函数**从 immutable git objects 重算这四组集合:
//   ① 重算值与 task 声明值不一致 → taskInvalid(检测"task 被改过/过期");
//   ② 一切对账都拿**重算值**做基准(task 的数组只是给审查方看的副本,清空它不再有用)。
//
// 供给方:build-review-task(构建 prompt)与 consume-review-output(裁决对账)。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { coverageKeysOf } from './lib.diff-snapshot.mjs';
import { loadVendoredTypescript, oracleCallRanges, scriptKindFor } from './lib.preflight-rules.mjs';
import {
  mergeProfiles, requiredProfileAnswersFor, classifyRequiredNegativeEvidence,
  buildSegments, profileSetHash,
} from './lib.review-profiles.mjs';

/** 括号净差(用于把改动行扩到它所在的**完整语句**)。 */
function bracketBalance(s) {
  let d = 0;
  for (const c of s) {
    if (c === '(' || c === '[' || c === '{') d += 1;
    else if (c === ')' || c === ']' || c === '}') d -= 1;
  }
  return d;
}

/**
 * 把 1-based 行号扩成它所在的**逻辑语句**窗口文本(第 2 轮核验 R6:多行断言只改了参数行时,
 * 单行关键字匹配看不到 `assert.equal(` 那一行 → required 凭空为空)。
 * 向上扩到括号收支平衡(说明找到了语句开头),向下同理;上限 `max` 行防跑飞。
 */
const DEPTH_CACHE = new WeakMap();

/** depth[i] = 第 i 行**结束后**的括号净深度(depth[0] = 0,即第 1 行之前)。整文件算一次。 */
function depthPrefix(lines) {
  let d = DEPTH_CACHE.get(lines);
  if (d) return d;
  d = new Array(lines.length + 1);
  d[0] = 0;
  for (let i = 0; i < lines.length; i += 1) d[i + 1] = d[i] + bracketBalance(lines[i]);
  DEPTH_CACHE.set(lines, d);
  return d;
}

export function logicalWindow(lines, lineNo, max = 12) {
  if (!Array.isArray(lines) || lineNo < 1 || lineNo > lines.length) return '';
  const depth = depthPrefix(lines);
  // 「第 n 行处于未闭合括号内」⇔ depth[n-1] > 0。据此向上走到语句/块的开头,向下走到闭合处。
  let start = lineNo;
  while (start > 1 && depth[start - 1] > 0 && lineNo - start < max) start -= 1;
  let end = lineNo;
  while (end < lines.length && depth[end] > 0 && end - lineNo < max) end += 1;
  return lines.slice(start - 1, end).join('\n');
}

/** 从整份 patch 里按**双向路径键**切出每个文件段的删除行(删除类文件的 `+++` 是 /dev/null,
 *  只按 `+++ b/` 建键会整段丢掉 → 删除掉的断言不再被要求负向证据,核验席点名)。 */
function removedLinesByPath(rawPatch) {
  const byPath = new Map();
  for (const seg of String(rawPatch ?? '').split(/^diff --git /m).slice(1)) {
    const minus = seg.match(/^--- (?:a\/(.*)|\/dev\/null)$/m);
    const plus = seg.match(/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/m);
    const hunks = seg.split(/^@@ .*$/m).slice(1)
      .map((body) => body.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1)));
    for (const k of [plus?.[1], minus?.[1]]) if (k && !byPath.has(k)) byPath.set(k, hunks);
  }
  return byPath;
}

/**
 * 取分类器输入:每个 hunk 的新增行文本、删除行文本、以及新增行所在的**语句窗口**。
 * 取不到文本一律记入 incompleteFiles(→ classifierIncomplete → invalid),绝不静默留空
 * ——留空会让 required 集合凭空变小,该给的负向证据不再被要求。
 */
export function lineTextsFor(snapshot, { repoRoot }) {
  const added = {};
  const removed = {};
  const windows = {};
  const astRanges = {}; // { [path]: { head: ranges[], base: ranges[] } }
  const incompleteFiles = [];
  const removedByPath = removedLinesByPath(snapshot.rawPatch);
  const blobText = (oid, path) => {
    const r = spawnSync('git', ['show', `${oid}:${path}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const blob = (oid, path) => {
    const t = blobText(oid, path);
    return t === null ? null : t.split('\n');
  };
  // SC-R6 第 3 轮核验:判定器识别改用**AST 调用节点行范围**与 hunk 求交(固定行窗口在真实
  // 多行调用上仍会漏)。parser 不可用 / 支持的扩展名解析失败 → 该文件进 incompleteFiles
  // (fail-closed:不许"解析不了就当没有判定器")。
  const parser = loadVendoredTypescript();
  const rangesFor = (oid, path) => {
    if (!parser.ok) return { supported: true, failed: true, ranges: [] };
    if (scriptKindFor(parser.ts, path) == null) return { supported: false, failed: false, ranges: [] };
    const text = blobText(oid, path);
    if (text === null) return { supported: true, failed: true, ranges: [] };
    const r = oracleCallRanges(parser.ts, { path, text });
    return { supported: true, failed: !r.ok, ranges: r.ranges ?? [] };
  };
  for (const f of snapshot.files) {
    if (f.contentKind !== 'text') continue;
    const path = f.newPath ?? f.oldPath;
    if (!path) continue;
    const deleted = f.changeType === 'deleted';
    // 删除类文件没有 head blob(内容全在 patch 的 `-` 行里);其余读 head blob 做语句窗口
    const lines = deleted ? null : blob(snapshot.headOid, path);
    if (!deleted && lines === null) { incompleteFiles.push(path); continue; }
    const removedHunks = removedByPath.get(path);
    if (deleted && !removedHunks) { incompleteFiles.push(path); continue; } // 删除文本映射失败 → fail-closed
    // AST 范围:head 侧用于新增行,base 侧用于被删除的行
    const headR = deleted ? { supported: false, failed: false, ranges: [] } : rangesFor(snapshot.headOid, path);
    const baseR = (f.changeType === 'added') ? { supported: false, failed: false, ranges: [] } : rangesFor(snapshot.mergeBaseOid, f.oldPath ?? path);
    if ((headR.supported && headR.failed) || (baseR.supported && baseR.failed)) { incompleteFiles.push(path); continue; }
    if (headR.supported || baseR.supported) astRanges[path] = { head: headR.ranges, base: baseR.ranges };
    added[path] = {};
    removed[path] = {};
    windows[path] = {};
    f.hunks.forEach((h, i) => {
      const addedLines = h.addedNewLines ?? [];
      added[path][h.hunkId] = lines ? addedLines.map((ln) => lines[ln - 1] ?? '') : [];
      removed[path][h.hunkId] = (removedHunks?.[i] ?? []).map((t) => t);
      windows[path][h.hunkId] = lines
        ? [...new Set(addedLines.map((ln) => logicalWindow(lines, ln)))].join('\n')
        : (removedHunks?.[i] ?? []).join('\n'); // 删除类:窗口就是被删掉的那段文本
    });
  }
  return { added, removed, windows, astRanges, incompleteFiles };
}

/**
 * 权威推导(唯一实现)。snapshot 不完整时返回空集合 + incomplete 标记——调用方 fail-closed。
 * @returns {{ profiles, warnings, configIncomplete, coverageKeys, segments,
 *   requiredProfileAnswers, requiredNegativeEvidenceKeys, classifier, profileSetHash }}
 */
export function computeReviewRequirements({ repoRoot, snapshot, rules }) {
  const { profiles, warnings, configIncomplete } = mergeProfiles(rules?.riskProfiles);
  const files = snapshot.complete ? snapshot.files : [];
  const coverageKeys = snapshot.complete ? coverageKeysOf(snapshot) : [];
  const segments = buildSegments({ coverageKeys, sizeBudget: Number(rules?.reviewSegments?.sizeBudget) || 60 });
  const requiredProfileAnswers = requiredProfileAnswersFor(profiles, files);
  const texts = snapshot.complete
    ? lineTextsFor(snapshot, { repoRoot })
    : { added: {}, removed: {}, windows: {}, astRanges: {}, incompleteFiles: [] };
  const classified = snapshot.complete
    ? classifyRequiredNegativeEvidence({
      profiles, files,
      addedLineTextByFile: texts.added,
      removedLineTextByFile: texts.removed,
      windowTextByFile: texts.windows,
      astRangesByFile: texts.astRanges,
      incompleteFiles: texts.incompleteFiles,
    })
    : { required: [], incomplete: false, incompleteFiles: [] };
  return {
    profiles, warnings, configIncomplete,
    coverageKeys, segments, requiredProfileAnswers,
    requiredNegativeEvidenceKeys: classified.required,
    classifier: classified,
    profileSetHash: profileSetHash(profiles),
  };
}

/** coverage key 集合的内容承诺(顺序无关)。task 只公开它,不公开 key 本身——
 *  第 3 轮核验:prompt 里藏了 key,但 task.json 仍含全量 coverageKeys 与
 *  segments[].assignedCoverageKeys,自己跑一遍 builder 读文件就完全绕过投递出口。 */
export function coverageCommitment(keys) {
  const canon = [...(keys ?? [])].map(coverageKeyStr).sort().join('\n');
  return `cc1-${createHash('sha256').update(canon).digest('hex').slice(0, 20)}`;
}

/** 规范序列化:用于把重算集合与 task 声明集合做**顺序无关**的精确比较。 */
export const coverageKeyStr = (k) => (k?.kind === 'hunk' ? `hunk:${k.fileId}:${k.hunkId}` : `file:${k?.fileId}`);
export const profileAnswerKeyStr = (r) => `${r?.profileId} ${r?.fileId} ${r?.checkId}`;
export const negativeKeyStr = (k) => `${k?.fileId}:${k?.hunkId ?? ''}`;

/** profile 必答项集合的内容承诺(第 4 轮核验:task 不再携带 fileId 明细)。 */
export function profileAnswersCommitment(reqs) {
  const canon = [...(reqs ?? [])].map(profileAnswerKeyStr).sort().join('\n');
  return `pc1-${createHash('sha256').update(canon).digest('hex').slice(0, 20)}`;
}

/** required 负向证据 key 集合的内容承诺(第 4 轮核验:task/prompt 逐项打印 fileId/hunkId
 *  本身就是 coverage hunk key 泄露——自己拼回执就能绕过投递出口)。 */
export function negativeEvidenceCommitment(keys) {
  const canon = [...(keys ?? [])].map(negativeKeyStr).sort().join('\n');
  return `nec1-${createHash('sha256').update(canon).digest('hex').slice(0, 20)}`;
}

/** 重算值 vs task 声明值:逐组精确比较,返回差异说明数组(空 = 一致)。 */
export function diffRequirements(authoritative, task) {
  const errs = [];
  // 明细一律**不在** task 里(第 3/4 轮核验:coverage key、必答项 fileId、负向 key 的
  // fileId/hunkId 全是回执素材,写进 task/prompt 等于把投递出口废掉),改比内容承诺 + 计数
  if (task?.coverageKeys !== undefined) errs.push('task 不得携带 coverageKeys 明细(key 只能经投递出口取得)');
  if (task?.requiredProfileAnswers !== undefined) errs.push('task 不得携带 requiredProfileAnswers 明细(fileId 只能随分段投递给出)');
  if (task?.requiredNegativeEvidenceKeys !== undefined) errs.push('task 不得携带 requiredNegativeEvidenceKeys 明细(fileId/hunkId 就是 coverage hunk key)');
  if (coverageCommitment(authoritative.coverageKeys) !== task?.coverageCommitment) {
    errs.push(`task.coverageCommitment 与重算值不符(重算 ${coverageCommitment(authoritative.coverageKeys)},task ${task?.coverageCommitment})`);
  }
  if (authoritative.coverageKeys.length !== task?.coverageKeyCount) {
    errs.push(`task.coverageKeyCount 与重算值不符(重算 ${authoritative.coverageKeys.length},task ${task?.coverageKeyCount})`);
  }
  if (profileAnswersCommitment(authoritative.requiredProfileAnswers) !== task?.profileAnswersCommitment) {
    errs.push('task.profileAnswersCommitment 与重算值不符——task 过期或被改过,不得据它对账');
  }
  if (authoritative.requiredProfileAnswers.length !== task?.requiredProfileAnswerCount) {
    errs.push(`task.requiredProfileAnswerCount 与重算值不符(重算 ${authoritative.requiredProfileAnswers.length},task ${task?.requiredProfileAnswerCount})`);
  }
  if (negativeEvidenceCommitment(authoritative.requiredNegativeEvidenceKeys) !== task?.negativeEvidenceCommitment) {
    errs.push('task.negativeEvidenceCommitment 与重算值不符——task 过期或被改过,不得据它对账');
  }
  if (authoritative.requiredNegativeEvidenceKeys.length !== task?.requiredNegativeEvidenceKeyCount) {
    errs.push(`task.requiredNegativeEvidenceKeyCount 与重算值不符(重算 ${authoritative.requiredNegativeEvidenceKeys.length},task ${task?.requiredNegativeEvidenceKeyCount})`);
  }
  if (!Array.isArray(task?.segments)) errs.push('task.segments 缺失或非数组');
  else {
    if (task.segments.some((x) => x?.assignedCoverageKeys !== undefined)) {
      errs.push('task.segments 不得携带 assignedCoverageKeys(下一段的 key 必须在上一段完成前不可见)');
    }
    const mine = authoritative.segments.map((s) => `${s.segmentId}#${s.order}#${s.assignedCoverageKeys.length}#${coverageCommitment(s.assignedCoverageKeys)}`);
    const theirs = task.segments.map((s) => `${s?.segmentId}#${s?.order}#${s?.keyCount}#${s?.commitment}`);
    if (mine.length !== theirs.length || mine.some((x, i) => x !== theirs[i])) {
      errs.push('task.segments 与重算分片不一致(段数/序号/计数/内容承诺任一不符)');
    }
  }
  if (authoritative.profileSetHash !== task?.profileSetHash) {
    errs.push(`task.profileSetHash 与当前 profile 集不一致(重算 ${authoritative.profileSetHash},task ${task?.profileSetHash})`);
  }
  return errs;
}
