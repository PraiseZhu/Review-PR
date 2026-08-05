#!/usr/bin/env node
// lib.prescan.mjs — R1 预扫标注层共享逻辑(SC-R2/R6/R7,2026-08-05 final SC)。
//
// 职责:配置校验、category 白名单(代码层 always-on)、observation schema、artifact 结构
// 与 hash 计算。不接网关调用——网关契约实测是 SC-R3 的前置门禁,未完成前 pre-scan.mjs
// 的 enabled 路径产出 failed/gateway-not-implemented。
//
// 设计纪律:
//   - category 白名单**硬编码**在代码层(SC-R2):loadRulesWithSource() 是整文件三选一,
//     目标仓 pr-rules.json 整体取代默认文件,白名单放配置里会在部分仓静默消失
//     (同 BUILTIN_PROFILES/lib.preflight-rules.mjs 的教训)。
//   - prescan 配置只允许 {enabled, model, apiKeyEnv} 三个键;endpoint/baseURL 禁止
//     配置;model 只能来自代码层 allowlist;apiKeyEnv 必须是合法环境变量名。
//   - artifact 是不可重算的 LLM 产物——机器只保证绑定 + 不可事后篡改(SC-R7/R14)。
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './lib.mjs';

/** SC-R6: observation category 闭集(代码层 always-on,禁配置覆盖)。删了"其他可疑"
 *  ——否则白名单等于没有范围。与 diff-scanner agent 的清单对齐,但删去"其他可疑"。 */
export const PRESCAN_CATEGORIES = Object.freeze([
  '陈旧注释',
  '漏改引用',
  '术语残留',
  '测试 import 缺失',
  '文档声明与实现不符',
  '明显笔误',
]);

/** SC-R2: 允许的 model 白名单(代码层)。核实网关契约(SC-R3)后在此添加;
 * 未完成实测前为空数组 → enabled:true 时直接 failed/model-not-allowlisted。 */
export const PRESCAN_ALLOWED_MODELS = Object.freeze([
  // 'deepseek/deepseek-v4-flash',  // 待 SC-R3 实测后取消注释
]);

/** SC-R2: prescan schema 版本。 */
export const PRESCAN_SCHEMA_VERSION = 'prescan-1';

/** SC-R5: 资源上限(代码层;具体数值待 SC-R3 网关限制确定后填入)。 */
export const PRESCAN_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024,        // 单次请求输入上限(保守默认)
  maxResponseBytes: 64 * 1024,    // 响应字节上限
  requestTimeoutMs: 30_000,        // 单次超时
  maxRetries: 2,                   // 最大重试(仅 429/5xx)
  retryBackoffMs: 1_000,          // 重试退避基数
  totalBudgetMs: 90_000,           // 总时间预算
  maxObservationsPerFile: 10,      // 每文件 observation 上限
  maxObservationsGlobal: 100,      // 全局 observation 上限
});

/** SC-R2: 校验 prescan 配置形态。返回 {enabled, valid, error, model, apiKeyEnv}。
 *  - 缺失 prescan 键 = disabled(合法,中性默认)。
 *  - enabled 严格等于 false = disabled(合法)。
 *  - enabled 严格等于 true = 需校验 model/apiKeyEnv。
 *  - 形态非法(非对象/多余键/非法 model/apiKeyEnv) = config-invalid。
 */
export function validatePrescanConfig(prescan) {
  if (prescan == null) return { enabled: false, valid: true, model: null, apiKeyEnv: null };
  if (typeof prescan !== 'object' || Array.isArray(prescan)) {
    return { enabled: false, valid: false, error: 'config-invalid: prescan 必须是对象', model: null, apiKeyEnv: null };
  }
  // 只允许 enabled/model/apiKeyEnv 三个键
  const allowed = new Set(['enabled', 'model', 'apiKeyEnv']);
  const extra = Object.keys(prescan).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    return { enabled: false, valid: false, error: `config-invalid: prescan 只允许 enabled/model/apiKeyEnv,多余键:${extra.join(',')}`, model: null, apiKeyEnv: null };
  }
  const enabled = prescan.enabled === true;
  if (prescan.enabled !== undefined && prescan.enabled !== true && prescan.enabled !== false) {
    return { enabled: false, valid: false, error: 'config-invalid: prescan.enabled 必须是 boolean', model: null, apiKeyEnv: null };
  }
  if (!enabled) return { enabled: false, valid: true, model: null, apiKeyEnv: null };
  // enabled=true 时校验 model 和 apiKeyEnv
  if (typeof prescan.model !== 'string' || !prescan.model) {
    return { enabled: true, valid: false, error: 'config-invalid: enabled=true 时 model 必需', model: null, apiKeyEnv: null };
  }
  if (!PRESCAN_ALLOWED_MODELS.includes(prescan.model)) {
    return { enabled: true, valid: false, error: `config-invalid: model "${prescan.model}" 不在代码层 allowlist(当前允许:${JSON.stringify([...PRESCAN_ALLOWED_MODELS])})`, model: prescan.model, apiKeyEnv: null };
  }
  if (typeof prescan.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(prescan.apiKeyEnv)) {
    return { enabled: true, valid: false, error: 'config-invalid: apiKeyEnv 必须是合法环境变量名(大写字母+数字+下划线,首字大写)', model: prescan.model, apiKeyEnv: null };
  }
  return { enabled: true, valid: true, model: prescan.model, apiKeyEnv: prescan.apiKeyEnv };
}

/** SC-R7: 规范化 JSON(键排序,与 lib.escaped-hazards.mjs 的 canonicalJson 同口径)。 */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** SC-R7: 计算 input payload 的 hash(送给模型的规范化 payload)。 */
export function computeInputHash(inputPayload) {
  const canon = canonicalJson(inputPayload);
  return `psi1-${createHash('sha256').update(canon).digest('hex').slice(0, 20)}`;
}

/** SC-R7: 计算 policy hash(model/category 版本/schema 版本/资源上限)。 */
export function computePolicyHash({ model, limits }) {
  const canon = canonicalJson({
    model,
    schemaVersion: PRESCAN_SCHEMA_VERSION,
    categories: [...PRESCAN_CATEGORIES],
    limits: { ...limits },
  });
  return `psp1-${createHash('sha256').update(canon).digest('hex').slice(0, 20)}`;
}

/** SC-R7: 计算 artifact hash(排除时间戳/provider request ID/原始错误文本等易漂移数据)。 */
export function computeArtifactHash(artifact) {
  const stable = {
    schemaVersion: artifact.schemaVersion,
    status: artifact.status,
    snapshotHash: artifact.snapshotHash,
    inputHash: artifact.inputHash,
    policyHash: artifact.policyHash,
    model: artifact.model,
    observationCount: artifact.observationCount,
    observations: artifact.observations ?? [],
    reasonCode: artifact.reasonCode ?? null,
  };
  const canon = canonicalJson(stable);
  return `pa1-${createHash('sha256').update(canon).digest('hex').slice(0, 20)}`;
}

/** SC-R6: 校验单条 observation schema。返回 {ok, error}。 */
export function validateObservation(obs, snapshotFiles, snapshotHash) {
  if (!obs || typeof obs !== 'object') return { ok: false, error: 'observation 非对象' };
  // 必需字段
  if (typeof obs.observationId !== 'string' || !obs.observationId) return { ok: false, error: 'observationId 缺失或非字符串' };
  if (typeof obs.file !== 'string' || !obs.file) return { ok: false, error: 'file 缺失或非字符串' };
  if (!Number.isInteger(obs.line) || obs.line < 1) return { ok: false, error: 'line 必须是正整数' };
  if (typeof obs.category !== 'string' || !PRESCAN_CATEGORIES.includes(obs.category)) {
    return { ok: false, error: `category 不在闭集内(允许:${JSON.stringify([...PRESCAN_CATEGORIES])})` };
  }
  if (typeof obs.note !== 'string' || !obs.note || obs.note.length > 500) {
    return { ok: false, error: 'note 必须是非空字符串且 ≤500 字符' };
  }
  // 禁止字段
  if (obs.verdict !== undefined || obs.severity !== undefined || obs.fix !== undefined) {
    return { ok: false, error: 'observation 禁含 verdict/severity/fix(预扫不下判断)' };
  }
  // file 必须精确属于当前 snapshot 的文本文件
  const fileEntry = snapshotFiles.find((f) => (f.newPath ?? f.oldPath) === obs.file);
  if (!fileEntry) return { ok: false, error: `file "${obs.file}" 不在当前 snapshot 文件集内` };
  if (fileEntry.contentKind !== 'text') return { ok: false, error: `file "${obs.file}" 不是文本文件` };
  // line 必须是当前 head 有效新增/修改行(落在某个 hunk 的 addedNewLines 内)
  const allAdded = fileEntry.hunks?.flatMap((h) => h.addedNewLines ?? []) ?? [];
  if (!allAdded.includes(obs.line)) return { ok: false, error: `line ${obs.line} 不在 file "${obs.file}" 的本次新增/修改行内` };
  return { ok: true };
}

/** SC-R6: 机器派生 observationId(snapshot/path/line/category/note)。 */
export function deriveObservationId(snapshotHash, file, line, category, note) {
  const canon = canonicalJson({ snapshotHash, file, line, category, note });
  return `po1-${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

/** SC-R7: artifact 文件路径(per-PR state 文件)。 */
export function prescanArtifactPath(stateDir, pr) {
  const n = Number(pr);
  if (!Number.isInteger(n) || n < 0) throw new Error(`prescan artifact 路径要求 pr 是非负整数,收到:${JSON.stringify(pr)}`);
  return join(stateDir, `prescan-artifact-${n}.json`);
}

/** SC-R7: 原子写入 artifact。 */
export function writePrescanArtifact(stateDir, pr, artifact) {
  writeJsonAtomic(prescanArtifactPath(stateDir, pr), artifact);
}

/** SC-R7: 读取 artifact(不存在/损坏 → null,fail-closed)。 */
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

/** SC-R7: 构建完整 artifact 对象(含 hash 绑定)。 */
export function buildArtifact({ status, snapshotHash, inputHash, policyHash, model, observations, reasonCode }) {
  const artifact = {
    schemaVersion: PRESCAN_SCHEMA_VERSION,
    status,
    snapshotHash,
    inputHash: inputHash ?? null,
    policyHash: policyHash ?? null,
    model: model ?? null,
    observationCount: Array.isArray(observations) ? observations.length : 0,
    observations: Array.isArray(observations) ? observations : [],
    reasonCode: reasonCode ?? null,
    writtenAt: new Date().toISOString(),
  };
  artifact.artifactHash = computeArtifactHash(artifact);
  return artifact;
}
