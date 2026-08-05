#!/usr/bin/env node
// lib.escaped-hazards.mjs — 逃逸 finding(false-pass)学习闭环(SC-R7,2026-08-05 SC v4)。
//
// 缺口⑦:SKILL §8 自进化只复盘"本轮没走到合并"的候选;#469 这种**已经 APPROVED 并
// 合并、事后由 #483 证伪**的 false negative 恰好不在采集范围,于是同类模式下次照漏。
//
// 双状态机(第 3 轮共识,两者语义不重叠):
//   - activationStatus:`pending-fix-merge`(修复 PR 还没合)| `active`(已核验合并,进入
//     后续审查的 prompt);
//   - promotionStatus:`pending`(还没决定怎么晋升)| `landed`(已晋升为确定性规则/profile
//     检查,且目标真实存在)| `recorded-only`(明确决定只记录,必填理由)。
//
// canonical = Review-PR 自己的 versioned `evolution/ledger.json`(第 3 轮裁决:不放
// STATE_DIR-only——runtime state 会被清理/不可评审,而"可复用知识属于 Skill、事实源是
// versioned ledger"是 §8 的既定口径);STATE_DIR 只作**可重放 inbox**:canonical upsert
// + push 成功后才 ack,失败保留重放。
//
// 损坏 fail-closed:ledger 读不动时返回 { incomplete: true },消费方(build-review-task)
// 把它带进 task,consumer 按 R1 invalid 处理——绝不伪装成"没有 hazard"。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { matchPath } from './lib.review-profiles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVOLUTION_LEDGER = resolve(HERE, '..', 'evolution', 'ledger.json');

export const ACTIVATION = ['pending-fix-merge', 'active'];
export const PROMOTION = ['pending', 'landed', 'recorded-only'];

export function deriveHazardId({ originPr, pattern, paths }) {
  const canon = `${originPr}|${(pattern ?? '').trim().toLowerCase().replace(/\s+/g, '')}|${[...(paths ?? [])].sort().join(',')}`;
  return `hz1-${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

/** 读 canonical ledger 的 escapedHazards 段。 */
export function loadKnownHazards(file = EVOLUTION_LEDGER) {
  if (!existsSync(file)) return { incomplete: false, hazards: [] };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { incomplete: true, reason: `evolution ledger 不可读:${e.message}`, hazards: [] };
  }
  const raw = doc?.escapedHazards;
  if (raw === undefined) return { incomplete: false, hazards: [] };
  if (!Array.isArray(raw)) return { incomplete: true, reason: 'escapedHazards 不是数组', hazards: [] };
  const hazards = [];
  for (const h of raw) {
    if (!h || typeof h.hazardId !== 'string' || !ACTIVATION.includes(h.activationStatus) || !PROMOTION.includes(h.promotionStatus)) {
      return { incomplete: true, reason: `escapedHazards 条目形状非法(${h?.hazardId ?? '无 id'})`, hazards: [] };
    }
    hazards.push(h);
  }
  return { incomplete: false, hazards };
}

/** 只有 active 的 hazard 才进 prompt;paths matcher 与本次 changed files 求交。 */
export function hazardsForPaths(loaded, changedPaths) {
  if (loaded.incomplete) return [];
  return loaded.hazards.filter((h) => h.activationStatus === 'active'
    && (h.paths ?? []).some((pat) => changedPaths.some((p) => matchPath(pat, p))));
}

/** 幂等 upsert(稳定 hazardId;atomic temp+rename)。返回 { changed, hazard }。 */
export function upsertHazard(file, hazard) {
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const list = Array.isArray(doc.escapedHazards) ? doc.escapedHazards : [];
  const idx = list.findIndex((h) => h.hazardId === hazard.hazardId);
  let changed = true;
  if (idx >= 0) {
    const prev = list[idx];
    // 幂等:同内容重复登记不增条、不降级(active 不回退 pending-fix-merge;landed 不回退 pending)
    const merged = {
      ...prev, ...hazard,
      activationStatus: prev.activationStatus === 'active' ? 'active' : hazard.activationStatus,
      promotionStatus: prev.promotionStatus === 'landed' ? 'landed' : hazard.promotionStatus,
    };
    changed = JSON.stringify(merged) !== JSON.stringify(prev);
    list[idx] = merged;
  } else {
    list.push(hazard);
  }
  const next = { ...doc, escapedHazards: list };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  return { changed, hazard: list.find((h) => h.hazardId === hazard.hazardId) };
}

/** pending inbox(STATE_DIR):可重放队列。ack 必须晚于 canonical upsert + push 成功。 */
export function inboxPath(stateDir) { return join(stateDir, 'escaped-hazards-inbox.json'); }

export function loadInbox(stateDir) {
  const f = inboxPath(stateDir);
  if (!existsSync(f)) return { ok: true, items: [] };
  try {
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    return { ok: Array.isArray(doc.items), items: Array.isArray(doc.items) ? doc.items : [] };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
}

export function saveInbox(stateDir, items) {
  const f = inboxPath(stateDir);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, items }, null, 2)}\n`);
  renameSync(tmp, f);
}

/**
 * 激活核验(SC-R7):pending → active 前必须现场核验 fix PR 已 MERGED **且 merged head
 * 精确等于登记时的 fixHead**——pending 之后又 push 新 head 再合并的,旧语义判断不适用,
 * 必须重判(不得直接 landed/active)。
 * @param probe (pr) => { state, mergeCommitOid?, headRefOid? } 由调用方注入(便于测试)
 */
export function verifyActivation({ item, probe }) {
  const info = probe(item.fixPr);
  if (!info || info.state !== 'MERGED') return { ok: false, reason: `fix PR #${item.fixPr} 未合并(state=${info?.state ?? '未知'})` };
  const merged = (info.headRefOid ?? '').toLowerCase();
  if (!merged || merged !== (item.fixHead ?? '').toLowerCase()) {
    return { ok: false, reason: `fix PR #${item.fixPr} 合并时的 head(${merged || '未知'})与登记的 fixHead(${item.fixHead})不一致——pending 后又推过新 commit,需重判` };
  }
  return { ok: true };
}
