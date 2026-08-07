#!/usr/bin/env node
// pre-scan.mjs — R1 预扫准备器与安全门(SC-1.3,2026-08-05 final SC v2 架构纠偏)。
//
// 架构纠偏(v1→v2):本脚本**不**调用任何网关。预扫的实际执行是巡审会话内的步骤
// (会话本身已由 mini schedule 预设跑在 deepseek/deepseek-v4-flash 上)。本脚本只做
// 两件事:①判定是否允许进入预扫(配置门 + 安全门);②给出 disabled/skipped/ready/failed
// 四态判定,供编排方(SKILL 流程)决定要不要调用 prepare-prescan-segment.mjs。
//
// 状态模型:
//   - disabled(配置 enabled:false/缺失):不产出 artifact,task/prompt 不含 prescan 字段
//   - skipped:确定性策略决定不允许预扫(敏感内容命中/无文本 hunk),记录 reasonCode
//   - ready:安全门通过,可以调用 prepare-prescan-segment.mjs 按段准备内容
//   - failed:配置非法或 snapshot 构建失败
//
// fail-open/fail-closed 边界:
//   - 服务/执行结果 fail-open:skipped/failed 不阻断原本的正式审查
//   - 接线完整性 fail-closed:enabled 后 artifact 缺失/篡改/snapshot 漂移 → consumer 判 invalid
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { print, fail, REPO_ROOT, STATE_DIR, loadRules, scanPrSensitiveContent } from './lib.mjs';
import { buildDiffSnapshot } from './lib.diff-snapshot.mjs';
import { validatePrescanConfig, buildArtifact, writePrescanArtifact } from './lib.prescan.mjs';

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

  // SC-1.1: 配置形态非法 → failed/config-invalid(fail-closed:不静默当 disabled)。
  // 必须先判 valid——validatePrescanConfig 对非法配置返回 enabled:false,若先判
  // !cfg.enabled 会把 config-invalid 错误地吞成 disabled(真实 bug,由测试抓到)。
  if (!cfg.valid) {
    const artifact = buildArtifact({ status: 'failed', snapshotHash: null, reasonCode: 'config-invalid', observations: [] });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    emit({ ok: false, status: 'failed', pr, reasonCode: 'config-invalid', error: cfg.error, artifactHash: artifact.artifactHash });
  }

  // SC-1.1: disabled(配置缺失或 enabled:false)→ 不产出 artifact
  if (!cfg.enabled) {
    emit({ ok: true, status: 'disabled', pr, note: 'prescan 配置未启用——不产出 artifact;task/prompt 不含 prescan 字段(SC-1.1 关闭态兼容)' });
  }

  const snapshot = buildDiffSnapshot({ repoRoot: REPO_ROOT, baseRefOid, headOid });
  if (!snapshot.complete) {
    const artifact = buildArtifact({ status: 'failed', snapshotHash: null, reasonCode: 'orchestration-incomplete', observations: [] });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    emit({ ok: false, status: 'failed', pr, reasonCode: 'orchestration-incomplete', reason: snapshot.reason, artifactHash: artifact.artifactHash });
  }

  // SC-2.3: 先 immutable 安全扫描再决定是否允许预扫(安全门前置于任何内容外发,
  // 包括进入会话上下文这种"外发")
  const sensitiveRules = rules?.sensitiveContent ?? {};
  const securityScan = scanPrSensitiveContent({
    owner: '', repo: '', pr, title: '', body: '',
    sensitiveRules, snapshotPatch: snapshot.rawPatch,
  });
  if (!securityScan.scanned || securityScan.hardHitCount > 0 || securityScan.softHitCount > 0) {
    const reasonCode = !securityScan.scanned ? 'security-scan-failed' : 'sensitive-content';
    const artifact = buildArtifact({ status: 'skipped', snapshotHash: snapshot.snapshotHash, reasonCode, observations: [] });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    emit({
      ok: true, status: 'skipped', pr, reasonCode,
      hardHitCount: securityScan.hardHitCount, softHitCount: securityScan.softHitCount,
      snapshotHash: snapshot.snapshotHash, artifactHash: artifact.artifactHash,
      note: '敏感内容命中或扫描失败——不允许进入预扫,prepare-prescan-segment.mjs 将拒绝输出 patch(SC-2.3)',
    });
  }

  // SC-2.3: 无文本 hunk → skipped/no-text-content
  const textFiles = snapshot.files.filter((f) => f.contentKind === 'text' && f.hunks.length > 0);
  if (textFiles.length === 0) {
    const artifact = buildArtifact({ status: 'skipped', snapshotHash: snapshot.snapshotHash, reasonCode: 'no-text-content', observations: [] });
    writePrescanArtifact(STATE_DIR, pr, artifact);
    emit({ ok: true, status: 'skipped', pr, reasonCode: 'no-text-content', snapshotHash: snapshot.snapshotHash, artifactHash: artifact.artifactHash });
  }

  // SC-1.3: ready——安全门通过,可调用 prepare-prescan-segment.mjs 按段准备内容。
  // 本脚本到此为止:不产出 observation、不落 complete artifact(那是
  // record-prescan-segment.mjs 在收到会话产出的分段结果后才做的事)。
  emit({
    ok: true, status: 'ready', pr, snapshotHash: snapshot.snapshotHash,
    textFileCount: textFiles.length,
    note: '安全门通过——调用 prepare-prescan-segment.mjs 按段获取可预扫内容,产出交给巡审会话(已预设跑在 deepseek/deepseek-v4-flash 上),会话输出交 record-prescan-segment.mjs 严格校验落台账(SC-2/3)',
  });
} catch (e) {
  fail(e);
}
