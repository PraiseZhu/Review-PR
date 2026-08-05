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

/** hazardId 绑定 repo(核验:别的仓同路径不该吃到本仓 hazard,id 也不该跨仓碰撞)。 */
export function deriveHazardId({ repo, originPr, pattern, paths }) {
  const canon = `${repo ?? '(no-repo)'}|${originPr}|${(pattern ?? '').trim().toLowerCase().replace(/\s+/g, '')}|${[...(paths ?? [])].sort().join(',')}`;
  return `hz1-${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

/** hazard 指纹:内容级去重锚点(与 hazardId 同源但独立字段,供 ledger 合并/审计引用)。 */
export function deriveHazardFingerprint({ repo, originPr, fixPr, pattern }) {
  return `hzf1-${createHash('sha256').update(`${repo ?? ''}|${originPr}|${fixPr}|${(pattern ?? '').trim().toLowerCase().replace(/\s+/g, '')}`).digest('hex').slice(0, 16)}`;
}

/** 完整 schema 校验(核验:此前只验 id + 双状态,缺 paths/origin/fix/target 也当完整)。 */
export function validateHazardShape(h) {
  const errs = [];
  const str = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!str(h?.hazardId)) errs.push('缺 hazardId');
  if (!str(h?.repo)) errs.push('缺 repo(hazard 必须绑定仓库,防跨仓误用)');
  if (!Number.isInteger(h?.originPr)) errs.push('缺 originPr');
  if (!Number.isInteger(h?.fixPr)) errs.push('缺 fixPr');
  if (!str(h?.pattern)) errs.push('缺 pattern');
  if (!str(h?.fingerprint)) errs.push('缺 fingerprint');
  if (!Array.isArray(h?.paths) || h.paths.length === 0 || h.paths.some((p) => !str(p))) errs.push('paths 缺失或非法');
  if (!ACTIVATION.includes(h?.activationStatus)) errs.push(`activationStatus 非法(${ACTIVATION.join('|')})`);
  if (!PROMOTION.includes(h?.promotionStatus)) errs.push(`promotionStatus 非法(${PROMOTION.join('|')})`);
  if (h?.promotionStatus === 'landed' && !(h?.promotionTarget?.kind === 'rule' || h?.promotionTarget?.kind === 'profile')) {
    errs.push('landed 必须有可解析的 promotionTarget(rule|profile)');
  }
  if (h?.promotionStatus === 'recorded-only' && !str(h?.promotionTarget?.reason)) errs.push('recorded-only 必须带理由');
  // #469 种子的 grandfather 规则:该修复早于本机制上线,没有可核验的 fixHead。只允许显式
  // 标记 grandfathered:true 的条目缺 fixHead,其它一律必填(否则激活核验形同虚设)。
  if (!str(h?.fixHead) && h?.grandfathered !== true) errs.push('缺 fixHead(除显式 grandfathered:true 的历史条目外必填)');
  return { ok: errs.length === 0, errors: errs };
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
    const v = validateHazardShape(h);
    if (!v.ok) {
      return { incomplete: true, reason: `escapedHazards 条目形状非法(${h?.hazardId ?? '无 id'}):${v.errors.join(';')}`, hazards: [] };
    }
    hazards.push(h);
  }
  return { incomplete: false, hazards };
}

/** 只有 active 的 hazard 才进 prompt;paths matcher 与本次 changed files 求交。 */
export function hazardsForPaths(loaded, changedPaths, repo = null) {
  if (loaded.incomplete) return [];
  return loaded.hazards.filter((h) => h.activationStatus === 'active'
    // repo 绑定(核验):别的仓同路径不该吃到本仓 hazard。repo 传 null 时不过滤(仅供
    // 无仓上下文的只读展示,如 --list)。
    && (repo == null || h.repo === repo)
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
  // origin PR 现场核验(核验补充):它必须确实是已合并的 PR,且若登记了 originHead 则一致
  // ——originPr 写错/写成还没合的 PR 时,这条 hazard 的"逃逸"前提根本不成立。
  const origin = probe(item.originPr);
  if (!origin || origin.state !== 'MERGED') {
    return { ok: false, reason: `origin PR #${item.originPr} 不是已合并状态(state=${origin?.state ?? '未知'})——逃逸前提不成立` };
  }
  if (item.originHead && (origin.headRefOid ?? '').toLowerCase() !== item.originHead.toLowerCase()) {
    return { ok: false, reason: `origin PR #${item.originPr} 的 head 与登记的 originHead 不一致` };
  }
  return { ok: true };
}

/**
 * 逃逸候选集(SC-R7 生产触发链的**确定性**部分,2026-08-05 核验):从 PR body / 关联 issue
 * 文本里抽出"本 PR 是在修此前已合并 PR 的问题"的信号。候选本身是确定性的(引用了哪些
 * PR/issue 号 + 修复语义关键词),"这算不算逃逸"仍是语义判断(T1)——所以候选逐条进 prompt
 * 由审查方给 yes/no + 依据,consumer 再据 yes 确定性写 pending inbox。
 *
 * **有意偏向多收**:关键词匹配是保守方向的启发式(如"无修复语义"里也含"修复"),宁可多问
 * 一句由审查方答 no,也不要漏掉真的逃逸——漏掉的代价是同类问题下次继续逃过审查。
 *
 * @returns [{ candidateId, referencedPr, kind: 'body-reference'|'issue-reference', excerpt }]
 */
export function extractEscapeCandidates({ body = '', issueTexts = [] } = {}) {
  const out = [];
  const seen = new Set();
  // 修复语义关键词 + PR 引用同段出现才算候选(避免把"依赖 #123"之类的普通引用全抓进来)
  const FIX_RE = /(修复|修掉|回归|regress|fix(?:es|ed)?|revert|漏(?:审|判)|逃(?:逸|过)|误(?:判|放))/i;
  const scan = (text, kind) => {
    // 按句子终止符切段(中英文标点均算,不要求后接空白——`...问题;另外...` 这类无空格
    // 写法此前会把两句并成一段,导致同段里的无关 PR 引用也被当候选)。
    for (const raw of String(text ?? '').split(/[\n。;;!?]+|\.\s|\. *$/)) {
      const seg = raw.trim();
      if (!seg || !FIX_RE.test(seg)) continue;
      for (const m of seg.matchAll(/#(\d{1,7})\b/g)) {
        const referencedPr = Number(m[1]);
        const candidateId = `esc-${kind}-${referencedPr}`;
        if (seen.has(candidateId)) continue;
        seen.add(candidateId);
        out.push({ candidateId, referencedPr, kind, excerpt: seg.slice(0, 200) });
      }
    }
  };
  scan(body, 'body-reference');
  for (const t of issueTexts) scan(t, 'issue-reference');
  return out;
}

/**
 * 激活编排(SC-R7,可注入依赖 → 可行为测试)。ack(从 inbox 移除)**严格晚于**三件事全过:
 *   ① verifyActivation(fix PR 已 MERGED 且 merged head === 登记 fixHead;origin PR 也已合并)
 *   ② canonical upsert + 回读校验(readback 里确实出现 active 条目)
 *   ③ commit&push 成功(sync.ok && sync.pushed === true)
 * 任一失败 → 该条留在 kept(下轮重放),不进 activated。幂等由 upsert 保证。
 *
 * @param {object} p { items, probe, upsert, readback, sync }
 *   upsert(item)   → 写 canonical,返回 { hazard }
 *   readback()     → 读 canonical,返回 { incomplete, hazards }
 *   sync(hazard)   → 提交并推送,返回 { ok, pushed, error?, skipped? }
 * @returns {{ activated: string[], kept: object[] }}
 */
export function activateInboxItems({ items, probe, upsert, readback, sync }) {
  const activated = [];
  const kept = [];
  for (const item of items ?? []) {
    const v = verifyActivation({ item, probe });
    if (!v.ok) { kept.push({ ...item, lastActivationCheck: v.reason }); continue; }
    const { hazard } = upsert({ ...item, activationStatus: 'active', activatedAt: new Date().toISOString() });
    const verify = readback();
    if (verify.incomplete || !verify.hazards.some((h) => h.hazardId === item.hazardId && h.activationStatus === 'active')) {
      kept.push({ ...item, lastActivationCheck: 'canonical 回读校验失败,保留重放' });
      continue;
    }
    const s = sync(hazard);
    if (!s?.ok || s.pushed !== true) {
      kept.push({ ...item, lastActivationCheck: `canonical 已写但 push 未成功(${s?.error ?? s?.skipped ?? 'pushed=false'}),保留 inbox 重放` });
      continue;
    }
    activated.push(hazard.hazardId);
  }
  return { activated, kept };
}
