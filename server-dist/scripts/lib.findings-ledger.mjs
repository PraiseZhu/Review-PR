#!/usr/bin/env node
// lib.findings-ledger.mjs — open-findings 逐条核销台账(SC-R5,2026-08-05 SC v4 共识)。
//
// 解决的洞(#469 复盘缺口③):本地席位拒过的 finding 只活在那个会话里,自动化开审
// 从零开始,后一个 APPROVED 静默覆盖前一个拒绝。本模块把"任何席位提出的 finding"
// 变成必须逐条核销的账:
//   - per-PR 物理隔离文件(STATE_DIR/findings-<pr>.json,atomic temp+rename),
//     consumer 是单一写者(交互席/auto 席都经 consume-review-output;3B 打回不二次
//     入账;preflight 命中经 consumer 入账);
//   - findingId 机器派生(fid1-hash(invariantKey|path|line)),family 身份只用
//     invariantKey(lib.review-output-shape 的唯一实现),不用单轮 family_id/slug;
//   - effective-open 机器谓词(R1a clean 三条件消费):
//       open ∪ (invalidated ∧ 未经交互确认——模型单方"误报"主张不关门)
//            ∪ (accepted-risk ∧ snapshotHash ≠ 当前——stale 恢复阻断)。
//     current-snapshot accepted-risk 不进 effective-open,但按 R1a 恒阻 clean(计入
//     acceptedRiskCount);
//   - resolved 仅证据有效关闭:绑定**新** snapshotHash(≠ origin snapshot,同 origin
//     禁自称 resolved)+ 证据锚点;
//   - preflight 项自动核销 = 同 ruleId+ruleVersion 在新 snapshot 重跑不命中(规则
//     实现变更不冒充代码已修——version 变化保持 open);
//   - 损坏/不可读 → { ok:false },消费方 fail-closed;forward-only(不导入历史)。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { invariantKey } from './lib.review-output-shape.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function deriveFindingId({ invariant, path, line }) {
  return `fid1-${sha(`${invariantKey(invariant)}|${path}|${line}`).slice(0, 20)}`;
}

export function derivePreflightFindingId({ ruleId, path, line }) {
  return `fid1-${sha(`rule:${ruleId}|${path}|${line}`).slice(0, 20)}`;
}

export function ledgerPathFor(stateDir, pr) {
  return join(stateDir, `findings-${pr}.json`);
}

export function computeLedgerHash(entries) {
  // 规范序:按 findingId 排序后序列化——hash 不受写入顺序影响
  const canon = [...entries].sort((a, b) => (a.findingId < b.findingId ? -1 : 1));
  return `lh1-${sha(JSON.stringify(canon))}`;
}

/** 读 ledger。文件不存在 = 合法空账;存在但解析/形状失败 = { ok:false }(fail-closed)。 */
export function loadLedger(file) {
  if (!existsSync(file)) return { ok: true, entries: [], ledgerHash: computeLedgerHash([]) };
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc?.version !== 1 || !Array.isArray(doc.entries)) return { ok: false, error: 'ledger 版本/形状非法' };
    for (const e of doc.entries) {
      if (!e || typeof e.findingId !== 'string' || typeof e.status !== 'string') return { ok: false, error: 'ledger 条目形状非法' };
    }
    return { ok: true, entries: doc.entries, ledgerHash: computeLedgerHash(doc.entries) };
  } catch (err) {
    return { ok: false, error: `ledger 不可读:${err.message}` };
  }
}

export function saveLedger(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
  renameSync(tmp, file);
  return computeLedgerHash(entries);
}

const STATUSES = ['open', 'resolved', 'invalidated', 'accepted-risk'];

/** effective-open 谓词(SC-R5 v4)。 */
export function isEffectiveOpen(entry, currentSnapshotHash) {
  if (entry.status === 'open') return true;
  if (entry.status === 'invalidated' && entry.interactiveConfirmed !== true) return true;
  if (entry.status === 'accepted-risk' && entry.acceptedAtSnapshotHash !== currentSnapshotHash) return true;
  return false;
}

export function summarize(entries, currentSnapshotHash) {
  let effectiveOpenCount = 0;
  let acceptedRiskCount = 0;
  for (const e of entries) {
    if (isEffectiveOpen(e, currentSnapshotHash)) effectiveOpenCount += 1;
    if (e.status === 'accepted-risk' && e.acceptedAtSnapshotHash === currentSnapshotHash) acceptedRiskCount += 1;
  }
  // stale accepted-risk 已计入 effective-open;current accepted-risk 单独计数(R1a:恒阻 clean)
  return { effectiveOpenCount, acceptedRiskCount };
}

/**
 * 把一份**已通过 validateReviewOutput** 的审查输出应用到 ledger(consumer 唯一写者)。
 * 纯内存变换:调用方负责 load/save。返回 { entries, applied, errors }——errors 非空时
 * 调用方必须按 invalid 处理(disposition 验真失败不是"忽略这条",是整轮无效)。
 *
 * @param {object} p
 *   entries        现有台账
 *   output         审查输出(rro-1)
 *   seat           'auto' | 'interactive'
 *   snapshot       当前 DiffSnapshot(complete=true)
 *   preflightHits  [{ruleId, ruleVersion, path, line, invariant?}] 本轮 preflight 命中(经 consumer 入账)
 */
export function applyReviewOutput({ entries, output, seat, snapshot, preflightHits = [], executedRules = [] }) {
  const errors = [];
  const now = new Date().toISOString();
  const cur = snapshot.snapshotHash;
  const byId = new Map(entries.map((e) => [e.findingId, e]));
  const reReported = new Set(); // 本轮**当前 occurrence**:必须 reopen,且不得同轮 resolved/invalidated

  /** 本轮再次被命中的既有条目必须 reopen(第 1 轮核验 BLOCKER:原实现"已存在就跳过",
   *  resolved 的项再次出现时不会重开 → 本轮 dirty、ledger 却是关的,下一轮空报即 clean)。 */
  const reopenOrCreate = (findingId, fresh) => {
    reReported.add(findingId);
    const prev = byId.get(findingId);
    if (!prev) { byId.set(findingId, fresh); return; }
    if (prev.status === 'open') { byId.set(findingId, { ...prev, lastSeenSnapshotHash: cur, lastSeenTs: now }); return; }
    byId.set(findingId, {
      ...prev, status: 'open', reopenedAtSnapshotHash: cur, reopenedTs: now,
      reopenReason: `本轮在 ${cur} 再次命中(上一状态 ${prev.status})——重现即重开`,
      // 关闭态字段清掉,避免"看起来还有 resolved 证据"
      resolvedAtSnapshotHash: undefined, evidence: undefined, interactiveConfirmed: undefined,
      acceptedAtSnapshotHash: undefined,
    });
  };

  // ① 本轮新 finding 入账(families → manifestations,机器派生 id);再次命中 → reopen
  for (const fam of output.findingFamilies ?? []) {
    const key = invariantKey(fam.invariant);
    fam.manifestations.forEach((m, mi) => {
      const findingId = deriveFindingId({ invariant: fam.invariant, path: m.path, line: m.line });
      reopenOrCreate(findingId, {
        findingId, invariantKey: key, path: m.path, line: m.line, severity: m.severity,
        seat, originSnapshotHash: cur, status: 'open', ts: now,
        localRef: { family_id: fam.family_id, manifestationIndex: mi },
      });
    });
  }

  // ② preflight 命中入账(确定性规则,来源标 rule);再次命中 → reopen
  for (const h of preflightHits) {
    const findingId = derivePreflightFindingId(h);
    reopenOrCreate(findingId, {
      findingId, rule: { ruleId: h.ruleId, ruleVersion: h.ruleVersion }, path: h.path, line: h.line,
      severity: h.severity ?? 'P1', seat: 'preflight', originSnapshotHash: cur, status: 'open', ts: now,
    });
  }

  // ③ disposition 应用与验真(只对已存在条目;validateReviewOutput 已保证只引用注入 ID)
  for (const d of output.findingDispositions ?? []) {
    const e = byId.get(d.findingId);
    if (!e) { errors.push(`disposition 引用不存在的台账条目 ${d.findingId}`); continue; }
    if (reReported.has(d.findingId)) {
      errors.push(`${d.findingId} 本轮被重新报告(当前 occurrence 存在),不得在同一轮 ${d.disposition}——先修再核销`);
      continue;
    }
    if (d.disposition === 'resolved') {
      // 第 2 轮核验 BLOCKER:evidence 此前只验**形状**(结构化 union + 字段非空),不验它
      // 指向的对象是否真存在——实测拿 `{snapshotHash:'snap-stale', fileId:'F-fabricated',
      // hunkId:'H-fabricated'}` 就能把 finding 关掉且 effectiveOpen 归零。证据必须绑定到
      // 它所声称验证的那个对象:snapshot 必须是当前的,锚点必须在当前 snapshot 里存在,
      // run 必须是本轮登记的 run。
      const ev = d.evidence ?? {};
      if (ev.snapshotHash !== cur) {
        errors.push(`${d.findingId} 的 resolved 证据绑定的 snapshotHash(${ev.snapshotHash ?? '缺'})不是当前 snapshot(${cur})——stale 证据不关账`);
        continue;
      }
      if (ev.kind === 'diff-anchor') {
        const f = (snapshot.files ?? []).find((x) => x.fileId === ev.fileId);
        if (!f) {
          errors.push(`${d.findingId} 的 diff-anchor 指向不存在的 fileId ${ev.fileId}(不在当前 snapshot 的改动文件里)`);
          continue;
        }
        if (!(f.hunks ?? []).some((h) => h.hunkId === ev.hunkId)) {
          errors.push(`${d.findingId} 的 diff-anchor 指向不存在的 hunkId ${ev.hunkId}(不在 ${f.newPath ?? f.oldPath} 的 hunk 里)`);
          continue;
        }
      } else if (ev.kind === 'verification-run') {
        const runs = output.verificationRuns ?? [];
        if (!runs.some((r) => r?.runId === ev.verificationRunId)) {
          errors.push(`${d.findingId} 的 verification-run 引用了本轮未登记的 runId ${ev.verificationRunId}`);
          continue;
        }
      } else {
        errors.push(`${d.findingId} 的 resolved 证据 kind 非法(${ev.kind ?? '缺'})`);
        continue;
      }
      if (e.originSnapshotHash === cur) {
        errors.push(`${d.findingId} 在 origin snapshot 上自称 resolved(同 snapshot 禁自证已修——代码没变,问题不会自己消失)`);
        continue;
      }
      if (e.rule) {
        errors.push(`${d.findingId} 是 preflight 确定性命中,不接受人工/模型 resolved——只能由同 ruleId+ruleVersion 在新 snapshot 重跑不命中自动核销`);
        continue;
      }
      byId.set(d.findingId, { ...e, status: 'resolved', resolvedAtSnapshotHash: cur, evidence: d.evidence, resolvedBySeat: seat, resolvedTs: now });
    } else if (d.disposition === 'invalidated') {
      // 席位主张误报:不关门(effective-open 仍算),等交互确认
      byId.set(d.findingId, { ...e, status: 'invalidated', invalidatedBasis: d.basis, interactiveConfirmed: e.interactiveConfirmed === true, invalidatedTs: now });
    }
  }

  // ④ preflight 自动核销:同 ruleId+ruleVersion 在当前 snapshot 重跑不命中 → resolved;
  //    版本变了保持 open(规则实现变更不冒充代码已修)
  // 第 1 轮核验 BLOCKER:原实现只看"本轮 hits 里没有它"就核销——零 hits 时 versionNow 为空,
  // 反而直接 resolved(实测:旧 v1 open + preflightHits=[] → status=resolved)。核销必须有
  // **正证据**:preflight 明确报告"该 ruleId 以同一 ruleVersion 在**当前 snapshot** 跑过"
  // (executedRules 由 review-preflight 产出并经 consumer 传入);规则被停用/删除/改版一律
  // 保持 open。
  const hitNow = new Set(preflightHits.map((h) => derivePreflightFindingId(h)));
  const executedVersion = new Map((executedRules ?? []).map((r) => [r.ruleId, r.ruleVersion]));
  for (const [id, e] of byId) {
    if (!e.rule || e.status !== 'open' || hitNow.has(id)) continue;
    // 第 2 轮核验 BLOCKER:同一 origin snapshot 仍可自动核销——喂一份"同规则同版本跑过、
    // hits=[]"的 preflight,代码一个字没变的 finding 就被判 resolved、effectiveOpen 归零。
    // 代码没变问题不会自己消失:核销必须发生在**新** snapshot 上(与 ③ 的人工 resolved
    // 同口径)。
    if (e.originSnapshotHash === cur) continue;
    const ran = executedVersion.get(e.rule.ruleId);
    if (ran === undefined) continue;                 // 本轮没跑过这条规则 → 不能据"没命中"核销
    if (ran !== e.rule.ruleVersion) continue;        // 规则改版 → 不冒充"代码已修"
    byId.set(id, {
      ...e, status: 'resolved', resolvedAtSnapshotHash: cur,
      evidence: { kind: 'preflight-rerun', snapshotHash: cur, ruleId: e.rule.ruleId, ruleVersion: e.rule.ruleVersion },
      resolvedBySeat: 'preflight', resolvedTs: now,
    });
  }

  const next = [...byId.values()];
  for (const e of next) if (!STATUSES.includes(e.status)) errors.push(`非法状态 ${e.status}`);
  return { entries: next, errors };
}

/**
 * 交互通道(SC-R1a/R5):accepted-risk 与 invalidated 确认只能从这里进,auto 模式禁用。
 * confirmation = { findingId, action: 'accept-risk'|'confirm-invalidated', reason, snapshotHash }
 */
export function applyInteractiveConfirmation({ entries, confirmation, mode }) {
  if (mode !== 'interactive') return { entries, error: 'accepted-risk/invalidated 确认只在交互模式存在(auto 无出口)' };
  const { findingId, action, reason, snapshotHash } = confirmation ?? {};
  const idx = entries.findIndex((e) => e.findingId === findingId);
  if (idx < 0) return { entries, error: `台账无此条目 ${findingId}` };
  const e = entries[idx];
  if (typeof reason !== 'string' || !reason.trim()) return { entries, error: '确认必须带理由' };
  const next = [...entries];
  if (action === 'accept-risk') {
    if ((e.severity === 'P0') || e.security === true) return { entries, error: 'P0/安全隐私 finding 不可 accepted-risk(硬门不可豁免)' };
    next[idx] = { ...e, status: 'accepted-risk', acceptedAtSnapshotHash: snapshotHash, acceptedReason: reason, acceptedSource: '交互会话操作者', acceptedTs: new Date().toISOString() };
  } else if (action === 'confirm-invalidated') {
    if (e.status !== 'invalidated') return { entries, error: `条目状态 ${e.status} 不是 invalidated,无可确认` };
    next[idx] = { ...e, interactiveConfirmed: true, confirmedReason: reason, confirmedTs: new Date().toISOString() };
  } else {
    return { entries, error: `未知确认动作 ${action}` };
  }
  return { entries: next, error: null };
}
