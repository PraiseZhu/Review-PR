#!/usr/bin/env node
// record-prescan-segment.mjs — 严格记录单段预扫产出(SC-3,2026-08-05 final SC v2)。
//
// 巡审会话对 prepare-prescan-segment.mjs 给出的分段内容产出严格 JSON 数组后,由本脚本
// 校验并落台账。严格解析纪律(SC-3.1):JSON 外任何文字、未知字段、未知 category、
// file 不属于当前段、line 不在新增行、note 空或超长、含 verdict/severity 等定性字段
// ——任一即整段拒绝,不"尽力解析部分内容"。
//
// observationId 由本脚本机器派生(SC-3.2),不接受模型自报——绑定 snapshotHash +
// segmentId + file + line + category + note,防止跨段/跨快照重放。
//
// 全部段记录完成后调用 --finalize 生成 complete artifact(SC-3.4)。中途只有部分段
// 记录、未显式 finalize 的状态**不产出 complete artifact**——consumer 侧据此判
// orchestration-incomplete,不允许"剩下的段自己看着办"。
//
// 用法:
//   记录一段: node record-prescan-segment.mjs <PR> --order <N> --segment-id <segId> \
//     --base <baseOid> --head <headOid> --observations <observations.json>
//   完成汇总: node record-prescan-segment.mjs <PR> --finalize --base <baseOid> --head <headOid>
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { print, fail, REPO_ROOT, STATE_DIR, loadRules, writeJsonAtomic } from './lib.mjs';
import { buildDiffSnapshot, coverageKeysOf } from './lib.diff-snapshot.mjs';
import { buildSegments, segmentBudgetFromRules } from './lib.review-profiles.mjs';
import {
  validatePrescanConfig, validateObservation, deriveObservationId,
  computeInputHash, computePolicyHash, buildArtifact, writePrescanArtifact,
  PRESCAN_LIMITS,
} from './lib.prescan.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };

/** 单段记录的中间态台账(不同于 prescan-delivery——那个只记"准备过哪些段",这个记
 *  "每段实际收到的 observations",供 --finalize 汇总)。 */
function prescanRecordPathFor(stateDir, pr) {
  const n = Number(pr);
  if (!Number.isInteger(n) || n < 0) throw new Error(`prescan record 路径要求 pr 是非负整数,收到:${JSON.stringify(pr)}`);
  return join(stateDir, `prescan-record-${n}.json`);
}

function loadRecord(file) {
  if (!existsSync(file)) return { version: 1, snapshotHash: null, segments: {} };
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc?.version !== 1 || typeof doc.segments !== 'object') return { version: 1, snapshotHash: null, segments: {} };
    return doc;
  } catch {
    return { version: 1, snapshotHash: null, segments: {} };
  }
}

function saveRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true });
  writeJsonAtomic(file, record);
}

try {
  const pr = Number(process.argv[2]);
  if (!Number.isInteger(pr) || pr <= 0) fail(new Error('缺 <PR>'));
  const baseRefOid = (argOf('--base') ?? '').toLowerCase();
  const headOid = (argOf('--head') ?? '').toLowerCase();
  const finalize = process.argv.includes('--finalize');

  const rules = loadRules();
  const cfg = validatePrescanConfig(rules?.prescan);
  // 必须先判 valid——非法配置的 enabled 恒为 false,先判 enabled 会把 config-invalid
  // 吞成 disabled。
  if (!cfg.valid) {
    print({ ok: false, pr, reasonCode: 'config-invalid', error: cfg.error });
    process.exit(2);
  }
  if (!cfg.enabled) {
    print({ ok: false, pr, reasonCode: 'disabled', error: null });
    process.exit(2);
  }

  const snapshot = buildDiffSnapshot({ repoRoot: REPO_ROOT, baseRefOid, headOid });
  if (!snapshot.complete) {
    print({ ok: false, pr, reasonCode: 'orchestration-incomplete', reason: snapshot.reason });
    process.exit(2);
  }

  const coverageKeys = coverageKeysOf(snapshot);
  const segments = buildSegments({ coverageKeys, ...segmentBudgetFromRules(rules) });
  const recordFile = prescanRecordPathFor(STATE_DIR, pr);

  if (finalize) {
    // SC-3.4: 全部段完成才能 finalize complete artifact
    const record = loadRecord(recordFile);
    if (record.snapshotHash !== snapshot.snapshotHash) {
      print({ ok: false, pr, reasonCode: 'orchestration-incomplete', error: 'record 台账绑定的 snapshotHash 与当前不一致——需重新逐段记录' });
      process.exit(2);
    }
    const missing = segments.filter((s) => !(s.segmentId in record.segments));
    if (missing.length > 0) {
      print({ ok: false, pr, reasonCode: 'orchestration-incomplete', error: `缺 ${missing.length} 段未记录:${missing.map((s) => s.segmentId).join(',')}` });
      process.exit(2);
    }
    const allObservations = segments.flatMap((s) => record.segments[s.segmentId]?.observations ?? []);
    const allPayloads = segments.map((s) => record.segments[s.segmentId]?.payload ?? null);
    const inputHash = computeInputHash(allPayloads.filter(Boolean));
    const policyHash = computePolicyHash({ limits: PRESCAN_LIMITS });
    const artifact = buildArtifact({
      status: 'complete', snapshotHash: snapshot.snapshotHash,
      inputHash, policyHash, observations: allObservations,
      executor: 'schedule-session',
    });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    print({ ok: true, pr, status: 'complete', observationCount: allObservations.length, artifactHash: artifact.artifactHash, snapshotHash: snapshot.snapshotHash });
    process.exit(0);
  }

  // ── 记录单段 ──
  const order = Number(argOf('--order'));
  const segmentId = argOf('--segment-id');
  const observationsFile = argOf('--observations');
  if (!Number.isInteger(order) || order < 1) fail(new Error('缺或非法 --order'));
  if (!segmentId) fail(new Error('缺 --segment-id'));
  if (!observationsFile || !existsSync(observationsFile)) fail(new Error('缺或找不到 --observations <file>'));

  const seg = segments.find((s) => s.order === order && s.segmentId === segmentId);
  if (!seg) {
    print({ ok: false, pr, reasonCode: 'orchestration-incomplete', error: `order=${order}/segmentId=${segmentId} 与当前分段不符(共 ${segments.length} 段)` });
    process.exit(2);
  }

  // SC-3.1: 严格解析——JSON 外任何文字即拒绝(不"尽力抠 JSON")
  let raw;
  let parsed;
  try {
    raw = readFileSync(observationsFile, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    print({ ok: false, pr, segmentId, order, reasonCode: 'schema-invalid', error: `不是合法 JSON:${e.message}` });
    process.exit(2);
  }
  if (!Array.isArray(parsed)) {
    print({ ok: false, pr, segmentId, order, reasonCode: 'schema-invalid', error: '顶层必须是数组' });
    process.exit(2);
  }

  // hunk 级隔离(第 1 轮盲审 P1-3 修复,同 prepare-prescan-segment.mjs):按本段
  // assignedCoverageKeys 里该文件被分配到的具体 hunkId 集合构造校验用的文件对象,
  // 不是整文件全部 hunks——否则单文件多 hunk 跨段时,本段的行号校验会接受属于
  // 其他段 hunk 的行号。
  const fileById = new Map(snapshot.files.map((f) => [f.fileId, f]));
  const hunkIdsByFile = new Map(); // fileId → Set<hunkId>,或 'ALL'(file-kind key)
  for (const k of seg.assignedCoverageKeys) {
    if (k.kind === 'file') { hunkIdsByFile.set(k.fileId, 'ALL'); continue; }
    if (!hunkIdsByFile.has(k.fileId)) hunkIdsByFile.set(k.fileId, new Set());
    const existing = hunkIdsByFile.get(k.fileId);
    if (existing !== 'ALL') existing.add(k.hunkId);
  }
  const allowedFiles = [...hunkIdsByFile.entries()].map(([fid, allowedHunkIds]) => {
    const f = fileById.get(fid);
    if (!f) return null;
    const hunks = allowedHunkIds === 'ALL'
      ? (f.hunks ?? [])
      : (f.hunks ?? []).filter((h) => allowedHunkIds.has(h.hunkId));
    return { ...f, hunks };
  }).filter(Boolean);

  // SC-3.3: 每文件/全局上限校验(先于逐条 schema 校验之外单独判断,超限即整段拒绝)
  if (parsed.length > PRESCAN_LIMITS.maxObservationsGlobal) {
    print({ ok: false, pr, segmentId, order, reasonCode: 'output-over-limit', error: `本段 ${parsed.length} 条超过全局上限 ${PRESCAN_LIMITS.maxObservationsGlobal}` });
    process.exit(2);
  }
  const countByFile = new Map();
  for (const o of parsed) {
    if (o && typeof o === 'object' && typeof o.file === 'string') {
      countByFile.set(o.file, (countByFile.get(o.file) ?? 0) + 1);
    }
  }
  for (const [file, count] of countByFile) {
    if (count > PRESCAN_LIMITS.maxObservationsPerFile) {
      print({ ok: false, pr, segmentId, order, reasonCode: 'output-over-limit', error: `file "${file}" ${count} 条超过每文件上限 ${PRESCAN_LIMITS.maxObservationsPerFile}` });
      process.exit(2);
    }
  }

  // SC-3.1: 逐条严格校验,任一失败整段拒绝(不接受部分通过的截断产物)
  const rejected = [];
  const observations = [];
  for (const [i, obs] of parsed.entries()) {
    const v = validateObservation(obs, allowedFiles);
    if (!v.ok) { rejected.push(`[${i}] ${v.error}`); continue; }
    observations.push({
      observationId: deriveObservationId(snapshot.snapshotHash, segmentId, obs.file, obs.line, obs.category, obs.note),
      file: obs.file, line: obs.line, category: obs.category, note: obs.note,
    });
  }
  if (rejected.length > 0) {
    print({ ok: false, pr, segmentId, order, reasonCode: 'schema-invalid', errors: rejected });
    process.exit(2);
  }

  // SC-3.3: 单段重放幂等——同 order 内容不同的二次写入拒绝
  const record = loadRecord(recordFile);
  if (record.snapshotHash && record.snapshotHash !== snapshot.snapshotHash) {
    record.segments = {}; // snapshot 漂移,旧记录整体作废重开
  }
  record.snapshotHash = snapshot.snapshotHash;
  const payloadCanon = JSON.stringify({ segmentId, order, observations });
  const existing = record.segments[segmentId];
  if (existing) {
    const existingCanon = JSON.stringify({ segmentId, order: existing.order, observations: existing.observations });
    if (existingCanon !== payloadCanon) {
      print({ ok: false, pr, segmentId, order, reasonCode: 'schema-invalid', error: '同段重复记录但内容不同——拒绝二次写入(幂等仅允许内容完全一致的重放)' });
      process.exit(2);
    }
    print({ ok: true, pr, segmentId, order, observationCount: observations.length, replayed: true });
    process.exit(0);
  }
  record.segments[segmentId] = { order, observations, payload: { segmentId, order, files: allowedFiles.map((f) => f.newPath ?? f.oldPath) } };
  saveRecord(recordFile, record);
  print({ ok: true, pr, segmentId, order, observationCount: observations.length, replayed: false });
} catch (e) {
  fail(e);
}
