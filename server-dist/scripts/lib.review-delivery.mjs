#!/usr/bin/env node
// lib.review-delivery.mjs — 分段投递台账(SC-R4 第 2 轮核验 BLOCKER)。
//
// 修的洞:此前"顺序投递"只是 prompt 里的一句话——builder 把**全部** segment 的 coverage
// key 一次性写进 prompt,consumer 唯一的顺序凭据是模型**自报**的 `receivedOrder`。于是
// "一次性硬审 + 补一份形状正确的分段回执"与"真的分段审过"在机器层完全无法区分。
//
// 现在唯一能拿到某段 coverage key 清单的途径是调用 deliver-review-segment.mjs,而它:
//   - 只接受**下一个**序号(order === deliveries.length + 1),乱序/跳段直接拒(不留记录);
//   - 记录成功投递到 STATE_DIR 的投递台账,并绑定当前 snapshotHash;
//   - consumer 以台账为基准核对回执的 segmentId / receivedOrder,并要求 1..N 全投递完成
//     ——宿主投不完(台账有缺口)即判 invalid,不允许"剩下的自己看着办"。
//
// 诚实边界(T1 上限):台账证明**投递动作按序真实发生过**,不能证明模型是分段读的
// ——编排方仍可先调 N 次再一次性喂给模型。机器能守住的是"没投递过就不能声称覆盖"。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function deliveryPathFor(stateDir, pr) {
  return join(stateDir, `review-delivery-${pr}.json`);
}

/** 读投递台账。文件缺失 = 一次都没投递过(合法空态)。解析失败 → { ok:false }(fail-closed)。 */
export function loadDeliveries(file) {
  if (!existsSync(file)) return { ok: true, snapshotHash: null, deliveries: [] };
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc?.version !== 1 || !Array.isArray(doc.deliveries)) return { ok: false, error: '投递台账版本/形状非法', deliveries: [] };
    for (const d of doc.deliveries) {
      if (!d || typeof d.segmentId !== 'string' || !Number.isInteger(d.order)) {
        return { ok: false, error: '投递台账条目形状非法', deliveries: [] };
      }
    }
    return { ok: true, snapshotHash: doc.snapshotHash ?? null, deliveries: doc.deliveries };
  } catch (e) {
    return { ok: false, error: `投递台账不可读:${e.message}`, deliveries: [] };
  }
}

export function saveDeliveries(file, { snapshotHash, deliveries }) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, snapshotHash, deliveries }, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * 追加一次投递。**只允许下一个序号**;snapshot 漂移时台账整体作废重开(旧 snapshot 的
 * 投递不能顶新 snapshot 的账)。
 * @returns {{ ok: boolean, error?: string, deliveries?: object[], segment?: object }}
 */
export function appendDelivery({ loaded, snapshotHash, segments, order, now }) {
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const fresh = loaded.snapshotHash === snapshotHash ? loaded.deliveries : [];
  const seg = segments.find((s) => s.order === order);
  if (!seg) return { ok: false, error: `order ${order} 不在本轮分片里(共 ${segments.length} 段)` };
  const already = fresh.find((d) => d.order === order);
  if (already) {
    // 幂等重放:同段重投不增条(允许宿主重试),但不得因此跳过后续段
    return { ok: true, deliveries: fresh, segment: seg, replayed: true };
  }
  const expected = fresh.length + 1;
  if (order !== expected) {
    return { ok: false, error: `顺序投递:下一个应投第 ${expected} 段,收到 ${order}——乱序/跳段不予记录` };
  }
  return {
    ok: true,
    deliveries: [...fresh, { segmentId: seg.segmentId, order, deliveredAt: now, keyCount: seg.assignedCoverageKeys.length }],
    segment: seg,
  };
}

/**
 * 核对投递台账与回执(consumer 用)。返回原因数组(空 = 通过)。
 */
export function reconcileDeliveries({ loaded, snapshotHash, segments, receipts }) {
  const reasons = [];
  if (!loaded.ok) { reasons.push(`投递台账不可读:${loaded.error}(fail-closed)`); return reasons; }
  if (loaded.deliveries.length === 0) {
    reasons.push('本轮没有任何分段投递记录(必须经 deliver-review-segment.mjs 逐段投递;一次性硬审不予采信)');
    return reasons;
  }
  if (loaded.snapshotHash !== snapshotHash) {
    reasons.push(`投递台账绑定的 snapshotHash(${loaded.snapshotHash})不是当前 snapshot——head/base 变过,需重新逐段投递`);
    return reasons;
  }
  const byOrder = new Map(loaded.deliveries.map((d) => [d.order, d]));
  for (let i = 1; i <= segments.length; i += 1) {
    if (!byOrder.has(i)) reasons.push(`第 ${i} 段未投递(宿主未能续投 → 本轮不得判 clean)`);
  }
  if (loaded.deliveries.length !== segments.length) {
    reasons.push(`投递 ${loaded.deliveries.length} 段,分片共 ${segments.length} 段`);
  }
  const receiptByOrder = new Map((receipts ?? []).map((r) => [r?.receivedOrder, r]));
  for (const d of loaded.deliveries) {
    const r = receiptByOrder.get(d.order);
    if (!r) { reasons.push(`第 ${d.order} 段已投递但无对应回执(receivedOrder=${d.order})`); continue; }
    if (r.segmentId !== d.segmentId) reasons.push(`第 ${d.order} 段回执的 segmentId(${r.segmentId})与投递记录(${d.segmentId})不符`);
  }
  for (const r of receipts ?? []) {
    if (!byOrder.has(r?.receivedOrder)) reasons.push(`回执声称的 receivedOrder=${r?.receivedOrder} 没有对应投递记录(未投递却声称覆盖)`);
  }
  return reasons;
}
