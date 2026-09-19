#!/usr/bin/env node
// lib.prescan.mjs — R1 预扫标注层共享逻辑(SC-1/2/3,2026-08-05 final SC v2 架构纠偏)。
//
// 架构纠偏(v1→v2):预扫**不是**脚本外拨网关的 HTTP 调用。mini 的 review-pr 巡审
// schedule 已预设 agent_kind=claude-code, model=deepseek/deepseek-v4-flash——巡审会话
// 本身就跑在该模型上,凭证走宿主 IPC(safeStorage 加密),脚本既读不到也不需要读。
// 预扫是**会话内步骤**:会话按 prepare-prescan-segment.mjs 给出的分段内容产出
// observations,record-prescan-segment.mjs 严格校验并落台账。本文件只提供共享的
// 配置校验/category 白名单/observation schema/artifact 结构与 hash 计算,不含任何
// HTTP 客户端逻辑。
//
// 设计纪律:
//   - category 白名单**硬编码**在代码层:loadRulesWithSource() 是整文件三选一,
//     目标仓 pr-rules.json 整体取代默认文件,白名单放配置里会在部分仓静默消失
//     (同 BUILTIN_PROFILES/lib.preflight-rules.mjs 的教训)。
//   - prescan 配置只允许 {enabled} 一个键——不存在 model/apiKeyEnv/endpoint,因为
//     脚本不发起任何网络调用,没有可配置的调用目标。
//   - artifact 是不可重算的会话产物——机器只保证绑定 + 不可事后篡改(SC-6/7)。
//     `executor` 字段(可选)只供人读("schedule-session"),机器不据此断言模型身份。
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './lib.mjs';

/** SC-2.2: observation category 闭集(代码层 always-on,禁配置覆盖)。删了"其他可疑"
 *  ——否则白名单等于没有范围。与 diff-scanner agent 的清单对齐,但删去"其他可疑"。 */
export const PRESCAN_CATEGORIES = Object.freeze([
  '陈旧注释',
  '漏改引用',
  '术语残留',
  '测试 import 缺失',
  '文档声明与实现不符',
  '明显笔误',
]);

/** SC-1.2: prescan schema 版本。 */
export const PRESCAN_SCHEMA_VERSION = 'prescan-1';

/** SC-3.3: observation 数量上限(代码层,与 HTTP 无关——会话内产出,不设超时/重试)。 */
export const PRESCAN_LIMITS = Object.freeze({
  maxObservationsPerFile: 10,      // 每文件 observation 上限
  maxObservationsGlobal: 100,      // 全局 observation 上限
  maxNoteLength: 500,               // note 单条长度上限
});

/** SC-1.1: 校验 prescan 配置形态。返回 {enabled, valid, error}。
 *  - 缺失 prescan 键 = disabled(合法,中性默认)。
 *  - enabled 严格等于 false = disabled(合法)。
 *  - enabled 严格等于 true = 启用(会话内预扫,无需额外字段)。
 *  - 形态非法(非对象/多余键/enabled 非 boolean) = config-invalid。
 *  只允许 {enabled} 一个键——不接受 model/apiKeyEnv/endpoint(脚本不发起网络调用)。
 */
export function validatePrescanConfig(prescan) {
  if (prescan == null) return { enabled: false, valid: true };
  if (typeof prescan !== 'object' || Array.isArray(prescan)) {
    return { enabled: false, valid: false, error: 'config-invalid: prescan 必须是对象' };
  }
  const allowed = new Set(['enabled']);
  const extra = Object.keys(prescan).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    return { enabled: false, valid: false, error: `config-invalid: prescan 只允许 enabled 键(脚本不发起网络调用,无 model/apiKeyEnv/endpoint 概念),多余键:${extra.join(',')}` };
  }
  if (prescan.enabled !== undefined && prescan.enabled !== true && prescan.enabled !== false) {
    return { enabled: false, valid: false, error: 'config-invalid: prescan.enabled 必须是 boolean' };
  }
  return { enabled: prescan.enabled === true, valid: true };
}

/** SC-3.4: 规范化 JSON(键排序,与 lib.escaped-hazards.mjs 的 canonicalJson 同口径)。 */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** SC-3.4: 计算 input payload 的 hash(全部实际投给会话的分段 payload 的规范化集合)。 */
export function computeInputHash(inputPayloads) {
  const canon = canonicalJson([...(inputPayloads ?? [])].map(canonicalJson).sort());
  return `psi1-${createHash('sha256').update(canon).digest('hex').slice(0, 20)}`;
}

/** SC-3.4: 计算 policy hash(schema 版本/category 版本/数量上限——不含 model,因为脚本
 *  不做模型选择;模型身份由 mini schedule 配置决定,不是本 skill 的安全承诺范围)。 */
export function computePolicyHash({ limits } = {}) {
  const canon = canonicalJson({
    schemaVersion: PRESCAN_SCHEMA_VERSION,
    categories: [...PRESCAN_CATEGORIES],
    limits: { ...(limits ?? PRESCAN_LIMITS) },
  });
  return `psp1-${createHash('sha256').update(canon).digest('hex').slice(0, 20)}`;
}

/** SC-3.4: 计算 artifact hash(排除时间戳等易漂移数据;executor 字段仅供人读,不参与
 *  hash——它不是安全承诺的一部分)。 */
export function computeArtifactHash(artifact) {
  const stable = {
    schemaVersion: artifact.schemaVersion,
    status: artifact.status,
    snapshotHash: artifact.snapshotHash,
    inputHash: artifact.inputHash,
    policyHash: artifact.policyHash,
    observationCount: artifact.observationCount,
    observations: artifact.observations ?? [],
    reasonCode: artifact.reasonCode ?? null,
  };
  const canon = canonicalJson(stable);
  return `pa1-${createHash('sha256').update(canon).digest('hex').slice(0, 20)}`;
}

/** SC-3.1: 校验单条**原始**observation schema(会话产出的原始 JSON,不含 observationId
 *  ——那是机器派生字段,不接受模型自报;见 deriveObservationId)。返回 {ok, error}。
 *  file/line 校验范围收窄到调用方传入的 allowedFiles(当前段允许的文件集),不是全量
 *  snapshot——分段协议下,某段的 observation 不得引用其他段的文件(SC-2.1/4.2)。 */
export function validateObservation(obs, allowedFiles) {
  if (!obs || typeof obs !== 'object') return { ok: false, error: 'observation 非对象' };
  const allowedKeys = new Set(['file', 'line', 'category', 'note']);
  const extra = Object.keys(obs).filter((k) => !allowedKeys.has(k));
  if (extra.length > 0) return { ok: false, error: `observation 含未知字段:${extra.join(',')}(禁 verdict/severity/fix/observationId 等——observationId 由机器派生,不接受模型自报)` };
  if (typeof obs.file !== 'string' || !obs.file) return { ok: false, error: 'file 缺失或非字符串' };
  if (!Number.isInteger(obs.line) || obs.line < 1) return { ok: false, error: 'line 必须是正整数' };
  if (typeof obs.category !== 'string' || !PRESCAN_CATEGORIES.includes(obs.category)) {
    return { ok: false, error: `category 不在闭集内(允许:${JSON.stringify([...PRESCAN_CATEGORIES])})` };
  }
  if (typeof obs.note !== 'string' || !obs.note || obs.note.length > PRESCAN_LIMITS.maxNoteLength) {
    return { ok: false, error: `note 必须是非空字符串且 ≤${PRESCAN_LIMITS.maxNoteLength} 字符` };
  }
  // file 必须精确属于当前段允许的文件集
  const fileEntry = (allowedFiles ?? []).find((f) => (f.newPath ?? f.oldPath) === obs.file);
  if (!fileEntry) return { ok: false, error: `file "${obs.file}" 不在当前段允许的文件集内` };
  if (fileEntry.contentKind !== 'text') return { ok: false, error: `file "${obs.file}" 不是文本文件` };
  // line 必须是当前 head 有效新增/修改行(落在某个 hunk 的 addedNewLines 内)
  const allAdded = fileEntry.hunks?.flatMap((h) => h.addedNewLines ?? []) ?? [];
  if (!allAdded.includes(obs.line)) return { ok: false, error: `line ${obs.line} 不在 file "${obs.file}" 的本次新增/修改行内` };
  return { ok: true };
}

/** SC-3.2: 机器派生 observationId(snapshot/segment/path/line/category/note)。
 *  不接受模型自报 ID——ID 必须由这些绑定字段派生,防止跨段/跨快照重放。 */
export function deriveObservationId(snapshotHash, segmentId, file, line, category, note) {
  const canon = canonicalJson({ snapshotHash, segmentId, file, line, category, note });
  return `po1-${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

/** SC-3.3: artifact 文件路径(per-PR state 文件)。 */
export function prescanArtifactPath(stateDir, pr) {
  const n = Number(pr);
  if (!Number.isInteger(n) || n < 0) throw new Error(`prescan artifact 路径要求 pr 是非负整数,收到:${JSON.stringify(pr)}`);
  return join(stateDir, `prescan-artifact-${n}.json`);
}

/** SC-3.3: 原子写入 artifact。 */
export function writePrescanArtifact(stateDir, pr, artifact) {
  writeJsonAtomic(prescanArtifactPath(stateDir, pr), artifact);
}

/** SC-3.3: 读取 artifact(不存在/损坏 → null,fail-closed)。 */
export function readPrescanArtifact(stateDir, pr) {
  const file = prescanArtifactPath(stateDir, pr);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 第 2 轮盲审(GPT delta):consumer 与 premerge 都要"读 artifact + 重算 artifactHash
 *  自洽性校验"这同一步骨架,此前各自写了一份、premerge 那份漏了重算(P1-2 的另一半)。
 *  抽成纯函数统一两处消费,避免同一逻辑再次分叉出不同步的两份实现。返回:
 *  {ok:true, artifact} 内容自洽(重算 artifactHash 与文件自带字段一致);
 *  {ok:false, reason} 不可信(缺失/损坏/重算不符)——调用方应视为"artifact 不存在"。 */
export function readTrustedPrescanArtifact(stateDir, pr) {
  const raw = readPrescanArtifact(stateDir, pr);
  if (!raw) return { ok: false, reason: 'missing' };
  if (computeArtifactHash(raw) !== raw.artifactHash) return { ok: false, reason: 'tampered' };
  return { ok: true, artifact: raw };
}

/** SC-3.4: 构建完整 artifact 对象(含 hash 绑定)。`executor` 可选,仅供人读。 */
export function buildArtifact({ status, snapshotHash, inputHash, policyHash, observations, reasonCode, executor }) {
  const artifact = {
    schemaVersion: PRESCAN_SCHEMA_VERSION,
    status,
    snapshotHash,
    inputHash: inputHash ?? null,
    policyHash: policyHash ?? null,
    observationCount: Array.isArray(observations) ? observations.length : 0,
    observations: Array.isArray(observations) ? observations : [],
    reasonCode: reasonCode ?? null,
    executor: executor ?? null,
    writtenAt: new Date().toISOString(),
  };
  artifact.artifactHash = computeArtifactHash(artifact);
  return artifact;
}
