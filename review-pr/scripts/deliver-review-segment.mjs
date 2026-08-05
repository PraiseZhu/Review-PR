#!/usr/bin/env node
// deliver-review-segment.mjs — 分段投递的**唯一**出口(SC-R4 第 2 轮核验 BLOCKER)。
//
// 编排方按 order 逐段调用本脚本,把它打印的 `payload` 投给**同一个**审查会话;每段结束
// 收回执后再投下一段。coverage key 清单只在这里给出(builder 的 prompt.md 不再包含),
// 所以"没投递过就不可能知道该段该覆盖什么"——顺序性因此有了机器凭据(见
// lib.review-delivery.mjs 的诚实边界声明)。
//
// 用法:
//   node deliver-review-segment.mjs <PR> --task <task.json> --base <baseOid> --head <headOid> --order N
// 退出码:0 = 已投递(payload 在 stdout);2 = 拒绝投递(乱序/跳段/task 过期,原因在 JSON);
//         1 = 脚本自身错误。
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';
import { print, fail, parsePR, REPO_ROOT, STATE_DIR, loadRules } from './lib.mjs';
import { buildDiffSnapshot } from './lib.diff-snapshot.mjs';
import { deliveryPathFor, loadDeliveries, saveDeliveries, appendDelivery } from './lib.review-delivery.mjs';
import { computeReviewRequirements, coverageKeyStr, coverageCommitment } from './lib.review-requirements.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };

try {
  const pr = parsePR(process.argv[2]);
  const taskFile = argOf('--task');
  const order = Number(argOf('--order'));
  if (!taskFile || !existsSync(taskFile)) fail(new Error('缺 --task <task.json>'));
  if (!Number.isInteger(order) || order < 1) fail(new Error('缺 --order <正整数>'));
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));
  const snapshot = buildDiffSnapshot({
    repoRoot: REPO_ROOT,
    baseRefOid: (argOf('--base') ?? '').toLowerCase(),
    headOid: (argOf('--head') ?? '').toLowerCase(),
  });
  if (!snapshot.complete) {
    print({ ok: false, pr, refused: `DiffSnapshot 不完整:${snapshot.reason}` });
    process.exit(2);
  }
  if (task.snapshotHash !== snapshot.snapshotHash) {
    print({ ok: false, pr, refused: `task 绑定的 snapshotHash 不是当前 snapshot(task=${task.snapshotHash},当前=${snapshot.snapshotHash})——需重建 task 并从第 1 段重投` });
    process.exit(2);
  }
  // 分片**权威重算**(不信 task 里的声明):task 只公开每段的计数与内容承诺,key 明细
  // 只在这里按序给出。task 的承诺与重算不符即拒(过期/被改)。
  const auth = computeReviewRequirements({ repoRoot: REPO_ROOT, snapshot, rules: loadRules() });
  const segments = auth.segments;
  const declared = Array.isArray(task.segments) ? task.segments : [];
  const mismatch = declared.length !== segments.length || segments.some((seg, i) => (
    declared[i]?.segmentId !== seg.segmentId || declared[i]?.order !== seg.order
    || declared[i]?.keyCount !== seg.assignedCoverageKeys.length
    || declared[i]?.commitment !== coverageCommitment(seg.assignedCoverageKeys)));
  if (mismatch) {
    print({ ok: false, pr, refused: 'task 声明的分片与当前 snapshot 重算不符(段数/序号/计数/内容承诺任一不符)——需重建 task 并从第 1 段重投' });
    process.exit(2);
  }
  const file = deliveryPathFor(STATE_DIR, pr);
  const loaded = loadDeliveries(file);
  const r = appendDelivery({ loaded, snapshotHash: snapshot.snapshotHash, segments, order, now: new Date().toISOString() });
  if (!r.ok) {
    print({ ok: false, pr, refused: r.error, delivered: loaded.deliveries.map((d) => d.order) });
    process.exit(2);
  }
  saveDeliveries(file, { snapshotHash: snapshot.snapshotHash, deliveries: r.deliveries });
  const seg = r.segment;
  const payload = [
    `## 覆盖分段 ${seg.segmentId}(投递序号 ${seg.order} / 共 ${segments.length} 段)`,
    '',
    `本段分配到 ${seg.assignedCoverageKeys.length} 个 coverage key,逐个审并在 \`segmentReceipts[]\` 追加`,
    `\`{segmentId:"${seg.segmentId}", receivedOrder:${seg.order}, coverageKeys:[...本段全部 key...]}\`。`,
    '只能认领本段的 key(跨段冒领/段内重复一律判 invalid)。',
    '',
    ...seg.assignedCoverageKeys.map((k) => `- ${coverageKeyStr(k)}`),
  ].join('\n');
  print({
    ok: true, pr, segmentId: seg.segmentId, order: seg.order, replayed: r.replayed === true,
    // 结构化 key 明细:这是编排方唯一合法的取 key 通道(task.json 里已不含明细)
    assignedCoverageKeys: seg.assignedCoverageKeys,
    totalSegments: segments.length, deliveredOrders: r.deliveries.map((d) => d.order),
    remaining: segments.length - r.deliveries.length,
    snapshotHash: snapshot.snapshotHash, payload,
  });
} catch (e) {
  fail(e);
}
