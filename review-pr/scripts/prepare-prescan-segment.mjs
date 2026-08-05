#!/usr/bin/env node
// prepare-prescan-segment.mjs — 预扫分段准备出口(SC-2.1/2.2/2.3,2026-08-05 final SC v2)。
//
// 唯一获取"某段可预扫内容"的途径。同 deliver-review-segment.mjs 的顺序纪律:
//   - 只接受**下一个**序号(order === deliveries.length + 1),乱序/跳段直接拒且不留记录;
//   - 记录成功准备到 STATE_DIR 的台账(prescan-delivery-<pr>.json),绑定当前 snapshotHash;
//   - 后段内容在前段准备完成前不可见——本脚本每次调用只返回**一段**的内容。
//
// 安全门(SC-2.3):敏感内容命中或扫描失败时,本脚本拒绝输出 patch——即使调用方传入合法
// order,也只返回 { ok:false, reasonCode } 而不含任何 diff 文本。
//
// 分段基于 lib.review-profiles.mjs 的 buildSegments(与阶段二审查分段同一实现,同一
// sizeBudget 配置),而不是重新发明一套分段算法——两者共享"顺序投递,后段不可见"的
// 同一诚实边界(见 lib.review-delivery.mjs 头部注释)。
//
// 用法:
//   node prepare-prescan-segment.mjs <PR> --base <baseOid> --head <headOid> --order <1..N>
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { print, fail, REPO_ROOT, STATE_DIR, loadRules, scanPrSensitiveContent } from './lib.mjs';
import { buildDiffSnapshot, coverageKeysOf } from './lib.diff-snapshot.mjs';
import { buildSegments } from './lib.review-profiles.mjs';
import { validatePrescanConfig } from './lib.prescan.mjs';
import { loadDeliveries, saveDeliveries, appendDelivery } from './lib.review-delivery.mjs';
import { join } from 'node:path';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };

/** prescan 专用投递台账路径(与阶段二审查的 review-delivery 台账**分开**,两者是独立
 *  的顺序协议——预扫可能在阶段二审查之前完成、也可能被跳过,不能共享同一份台账)。 */
function prescanDeliveryPathFor(stateDir, pr) {
  const n = Number(pr);
  if (!Number.isInteger(n) || n < 0) throw new Error(`prescan 投递台账路径要求 pr 是非负整数,收到:${JSON.stringify(pr)}`);
  return join(stateDir, `prescan-delivery-${n}.json`);
}

try {
  const pr = Number(process.argv[2]);
  if (!Number.isInteger(pr) || pr <= 0) fail(new Error('缺 <PR>'));
  const baseRefOid = (argOf('--base') ?? '').toLowerCase();
  const headOid = (argOf('--head') ?? '').toLowerCase();
  const order = Number(argOf('--order'));
  if (!Number.isInteger(order) || order < 1) fail(new Error('缺或非法 --order(必须是 ≥1 的整数)'));

  const rules = loadRules();
  const cfg = validatePrescanConfig(rules?.prescan);
  // 必须先判 valid——非法配置的 enabled 恒为 false,先判 enabled 会把 config-invalid
  // 吞成 disabled。
  if (!cfg.valid) {
    print({ ok: false, pr, reasonCode: 'config-invalid', error: cfg.error });
    process.exit(2);
  }
  if (!cfg.enabled) {
    print({ ok: false, pr, reasonCode: 'disabled', note: 'prescan 未启用——不应调用本出口' });
    process.exit(2);
  }

  const snapshot = buildDiffSnapshot({ repoRoot: REPO_ROOT, baseRefOid, headOid });
  if (!snapshot.complete) {
    print({ ok: false, pr, reasonCode: 'orchestration-incomplete', reason: snapshot.reason });
    process.exit(2);
  }

  // SC-2.3: 安全门前置——敏感内容命中或扫描失败时,任何 order 都拒绝输出 patch
  const sensitiveRules = rules?.sensitiveContent ?? {};
  const securityScan = scanPrSensitiveContent({
    owner: '', repo: '', pr, title: '', body: '',
    sensitiveRules, snapshotPatch: snapshot.rawPatch,
  });
  if (!securityScan.scanned || securityScan.hardHitCount > 0 || securityScan.softHitCount > 0) {
    const reasonCode = !securityScan.scanned ? 'security-scan-failed' : 'sensitive-content';
    print({ ok: false, pr, reasonCode, note: '敏感内容命中或扫描失败——拒绝输出 patch(SC-2.3),不含任何 diff 文本' });
    process.exit(2);
  }

  // SC-2.1: 分段与阶段二审查同一算法(buildSegments),同一 sizeBudget 配置
  const coverageKeys = coverageKeysOf(snapshot);
  const segments = buildSegments({ coverageKeys, sizeBudget: Number(rules?.reviewSegments?.sizeBudget) || 60 });
  const seg = segments.find((s) => s.order === order);
  if (!seg) {
    print({ ok: false, pr, reasonCode: 'orchestration-incomplete', error: `order ${order} 不在本轮分片里(共 ${segments.length} 段)` });
    process.exit(2);
  }

  // SC-2.1: 顺序投递台账——只接受下一个序号,乱序/跳段不留记录
  const deliveryFile = prescanDeliveryPathFor(STATE_DIR, pr);
  const loaded = loadDeliveries(deliveryFile);
  const appended = appendDelivery({ loaded, snapshotHash: snapshot.snapshotHash, segments, order, now: new Date().toISOString() });
  if (!appended.ok) {
    print({ ok: false, pr, reasonCode: 'orchestration-incomplete', error: appended.error });
    process.exit(2);
  }
  saveDeliveries(deliveryFile, { snapshotHash: snapshot.snapshotHash, deliveries: appended.deliveries });

  // SC-2.1: 输出该段可预扫内容——只含本段文件的 path/行区间/immutable patch/允许扫描
  // 的新增行,不含后续段任何信息(后段文件甚至不在 fileById 映射里)
  const fileById = new Map(snapshot.files.map((f) => [f.fileId, f]));
  const segFileIds = new Set(seg.assignedCoverageKeys.map((k) => k.fileId));
  const allowedFiles = [...segFileIds].map((fid) => fileById.get(fid)).filter(Boolean);
  const filesPayload = allowedFiles.map((f) => ({
    path: f.newPath ?? f.oldPath,
    changeType: f.changeType,
    contentKind: f.contentKind,
    hunks: (f.hunks ?? []).map((h) => ({
      oldRanges: h.oldRanges, newRanges: h.newRanges, addedNewLines: h.addedNewLines,
      patchText: h.patchText,
    })),
  }));

  print({
    ok: true, pr, segmentId: seg.segmentId, order: seg.order, totalSegments: segments.length,
    snapshotHash: snapshot.snapshotHash, replayed: appended.replayed === true,
    files: filesPayload,
    note: '本段可预扫内容——固定六类白名单(陈旧注释/漏改引用/术语残留/测试 import 缺失/'
      + '文档声明与实现不符/明显笔误),禁 verdict/severity/修复建议;无可疑项返回 []。'
      + '产出交 record-prescan-segment.mjs 严格校验落台账(SC-2.2/3)',
  });
} catch (e) {
  fail(e);
}
