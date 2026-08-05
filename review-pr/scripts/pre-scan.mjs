#!/usr/bin/env node
// pre-scan.mjs — R1 预扫标注层(SC-R2/R4/R5,2026-08-05 final SC)。
//
// 职责:在阶段二独立审查**之前**跑,对 immutable diff 做轻量 LLM 预扫,产出 advisory
// observation(不产 finding、不驱动 dirty)。正式审查席逐条 disposition(SC-R10)。
//
// 状态模型(SC-R1 final):
//   - disabled(配置 enabled:false/缺失):不产出 artifact,不调用网关,task/prompt 不含 prescan
//   - complete:模型调用成功,observation 数组通过 schema 校验
//   - skipped:确定性策略决定不外发(敏感内容命中/输入超限/无文本 hunk)
//   - failed:已尝试运行但失败(超时/429/5xx/认证/schema invalid)
//
// fail-open/fail-closed 边界:
//   - 服务结果 fail-open:skipped/failed 不阻断原本的正式审查,不降低任何既有机器保证
//   - 接线完整性 fail-closed:enabled 后 artifact 缺失/篡改/snapshot 漂移 → consumer 判 invalid
//
// 网关契约(SC-R3)未实测前,enabled 路径产出 failed/gateway-not-implemented——
// 不猜 endpoint/model ID,先有实测契约再接真实调用。
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { print, fail, REPO_ROOT, STATE_DIR, loadRules, scanPrSensitiveContent } from './lib.mjs';
import { buildDiffSnapshot } from './lib.diff-snapshot.mjs';
import {
  validatePrescanConfig, buildArtifact, writePrescanArtifact,
  PRESCAN_CATEGORIES, PRESCAN_ALLOWED_MODELS, PRESCAN_LIMITS, PRESCAN_SCHEMA_VERSION,
  computePolicyHash, computeInputHash,
} from './lib.prescan.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };

try {
  const pr = Number(process.argv[2]);
  if (!Number.isInteger(pr) || pr <= 0) fail(new Error('缺 <PR>'));
  const baseRefOid = (argOf('--base') ?? '').toLowerCase();
  const headOid = (argOf('--head') ?? '').toLowerCase();
  const outFile = argOf('--out');

  const emit = (payload) => {
    if (outFile) writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
    print(payload);
    process.exit(0);
  };

  const rules = loadRules();
  const cfg = validatePrescanConfig(rules?.prescan);

  // SC-R1: disabled(配置缺失或 enabled:false)→ 不产出 artifact,不调网关
  if (!cfg.enabled) {
    emit({ ok: true, enabled: false, pr, note: 'prescan 配置未启用——不产出 artifact,不调用网关;task/prompt 不含 prescan 字段(SC-R1 关闭态兼容)' });
  }

  // SC-R2: 配置形态非法 → 产出 failed/config-invalid artifact(fail-closed:不静默当 disabled)
  if (!cfg.valid) {
    const artifact = buildArtifact({
      status: 'failed', snapshotHash: null, reasonCode: 'config-invalid',
      model: cfg.model, observations: [],
    });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    emit({ ok: false, enabled: true, pr, status: 'failed', reasonCode: 'config-invalid', error: cfg.error, artifactHash: artifact.artifactHash });
  }

  // SC-R3 前置门禁:网关契约未实测 → enabled 路径产出 failed/gateway-not-implemented
  // 不猜 endpoint/model ID。SC-R3 完成后在此接真实网关调用。
  const snapshot = buildDiffSnapshot({ repoRoot: REPO_ROOT, baseRefOid, headOid });
  if (!snapshot.complete) {
    const artifact = buildArtifact({
      status: 'failed', snapshotHash: null, reasonCode: 'snapshot-incomplete',
      model: cfg.model, observations: [],
    });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    emit({ ok: false, enabled: true, pr, status: 'failed', reasonCode: 'snapshot-incomplete', reason: snapshot.reason, artifactHash: artifact.artifactHash });
  }

  // SC-R4: 先 immutable 安全扫描再决定是否外发
  const sensitiveRules = rules?.sensitiveContent ?? {};
  const securityScan = scanPrSensitiveContent({
    owner: '', repo: '', pr, title: '', body: '',
    sensitiveRules, snapshotPatch: snapshot.rawPatch,
  });
  // scanned=false 或 hard/soft hit → skipped/sensitive-content(零网络调用)
  if (!securityScan.scanned || securityScan.hardHitCount > 0 || securityScan.softHitCount > 0) {
    const reasonCode = !securityScan.scanned ? 'security-scan-failed' : 'sensitive-content';
    const artifact = buildArtifact({
      status: 'skipped', snapshotHash: snapshot.snapshotHash, reasonCode,
      model: cfg.model, observations: [],
    });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    emit({
      ok: true, enabled: true, pr, status: 'skipped', reasonCode,
      hardHitCount: securityScan.hardHitCount, softHitCount: securityScan.softHitCount,
      snapshotHash: snapshot.snapshotHash, artifactHash: artifact.artifactHash,
      note: '敏感内容命中或扫描失败——零网络调用,不外发 diff 给外部模型(SC-R4)',
    });
  }

  // SC-R5: 无文本 hunk → skipped/no-text-content
  const textFiles = snapshot.files.filter((f) => f.contentKind === 'text' && f.hunks.length > 0);
  if (textFiles.length === 0) {
    const artifact = buildArtifact({
      status: 'skipped', snapshotHash: snapshot.snapshotHash, reasonCode: 'no-text-content',
      model: cfg.model, observations: [],
    });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    emit({ ok: true, enabled: true, pr, status: 'skipped', reasonCode: 'no-text-content', snapshotHash: snapshot.snapshotHash, artifactHash: artifact.artifactHash });
  }

  // SC-R5: 输入超限 → skipped/input-too-large
  const inputBytes = Buffer.byteLength(snapshot.rawPatch, 'utf8');
  if (inputBytes > PRESCAN_LIMITS.maxInputBytes) {
    const artifact = buildArtifact({
      status: 'skipped', snapshotHash: snapshot.snapshotHash, reasonCode: 'input-too-large',
      model: cfg.model, observations: [],
    });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    emit({ ok: true, enabled: true, pr, status: 'skipped', reasonCode: 'input-too-large', inputBytes, limit: PRESCAN_LIMITS.maxInputBytes, snapshotHash: snapshot.snapshotHash, artifactHash: artifact.artifactHash });
  }

  // SC-R3 前置门禁:网关契约未实测 → 产出 failed/gateway-not-implemented
  // PRESCAN_ALLOWED_MODELS 当前为空数组 → 任何 model 都不在 allowlist
  // (上面的 validatePrescanConfig 已经拦住了,但防御性再判一次)
  if (!PRESCAN_ALLOWED_MODELS.includes(cfg.model)) {
    const policyHash = computePolicyHash({ model: cfg.model, limits: PRESCAN_LIMITS });
    const artifact = buildArtifact({
      status: 'failed', snapshotHash: snapshot.snapshotHash,
      inputHash: null, policyHash, model: cfg.model,
      reasonCode: 'gateway-not-implemented', observations: [],
    });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    emit({
      ok: false, enabled: true, pr, status: 'failed', reasonCode: 'gateway-not-implemented',
      snapshotHash: snapshot.snapshotHash, artifactHash: artifact.artifactHash,
      note: '网关契约未实测(SC-R3 前置门禁)——不猜 endpoint/model ID,等实测后接真实调用',
    });
  }

  // SC-R3 完成后:此处接真实网关调用
  // TODO(SC-R3): 调用 deepseek/deepseek-v4-flash,校验响应 schema(SC-R6),产出 observations
} catch (e) {
  fail(e);
}
