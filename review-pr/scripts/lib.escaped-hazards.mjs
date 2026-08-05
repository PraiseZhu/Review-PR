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
import { matchPath, BUILTIN_PROFILES } from './lib.review-profiles.mjs';
import { BUILTIN_RULES } from './lib.preflight-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVOLUTION_LEDGER = resolve(HERE, '..', 'evolution', 'ledger.json');

export const ACTIVATION = ['pending-fix-merge', 'active'];
export const PROMOTION = ['pending', 'landed', 'recorded-only'];

/** grandfather 白名单——**当前为空**。
 *  第 2 轮核验点名"任意条目写上 grandfathered:true 就能绕开 fixHead 必填"。原本唯一需要
 *  豁免的是 #469 种子(当时没记 fixHead);#483 早已合并、head 可现场取,已补进 ledger,
 *  于是豁免整体取消:**没有任何**免 head 核验的通道。将来若真要加,必须往这个显式集合里
 *  写死那一条 hazardId(泛化的 `grandfathered:true` 一律被 validateHazardShape 拒)。 */
export const GRANDFATHERED_IDS = new Set();

/**
 * hazardId = **稳定事件身份**(第 2 轮核验:此前把 reviewer 自由文本 pattern 与 paths 一起
 * 揉进 id,同一事件换个措辞就生成新 ID,幂等被破坏)。身份只由不可争议的事实构成:
 * 仓库 + origin/fix PR 号 + 两侧 head OID。pattern / paths 只作 evidence 字段。
 */
export function deriveHazardId({ repo, originPr, fixPr, originHead, fixHead }) {
  const canon = [
    repo ?? '(no-repo)', originPr, fixPr,
    (originHead ?? '(no-origin-head)').toLowerCase(),
    (fixHead ?? '(no-fix-head)').toLowerCase(),
  ].join('|');
  return `hz2-${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

/** hazard 指纹:与 hazardId 同一稳定身份的独立字段(供 ledger 合并/审计交叉引用)。 */
export function deriveHazardFingerprint({ repo, originPr, fixPr, originHead, fixHead }) {
  const canon = [repo ?? '', originPr, fixPr, (originHead ?? '').toLowerCase(), (fixHead ?? '').toLowerCase()].join('|');
  return `hzf2-${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

/** landed 的 promotionTarget 必须指向**真实存在**的注册表项(第 2 轮核验:此前只验 kind
 *  字段形状,写个不存在的 ruleId 也算 landed)。 */
export function validatePromotionTarget(t) {
  if (t?.kind === 'rule') {
    const r = BUILTIN_RULES.find((x) => x.ruleId === t.ruleId);
    if (!r) return `promotionTarget.ruleId ${t.ruleId} 不在规则注册表里`;
    if (t.ruleVersion && t.ruleVersion !== r.ruleVersion) {
      return `promotionTarget.ruleVersion ${t.ruleVersion} 与注册表当前版本 ${r.ruleVersion} 不符`;
    }
    return null;
  }
  if (t?.kind === 'profile') {
    const p = BUILTIN_PROFILES.find((x) => x.id === t.profileId);
    if (!p) return `promotionTarget.profileId ${t.profileId} 不在 profile 注册表里`;
    if (t.checkId && !p.mandatoryChecks.some((c) => c.id === t.checkId)) {
      return `promotionTarget.checkId ${t.checkId} 不在 profile ${t.profileId} 的必答项里`;
    }
    return null;
  }
  return 'landed 必须有可解析的 promotionTarget(rule|profile)';
}

/** 完整 schema 校验(核验:此前只验 id + 双状态,缺 paths/origin/fix/target 也当完整)。 */
export function validateHazardShape(h) {
  const errs = [];
  const str = (v) => typeof v === 'string' && v.trim().length > 0;
  const sha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v.toLowerCase());
  if (!str(h?.hazardId)) errs.push('缺 hazardId');
  if (!str(h?.repo)) errs.push('缺 repo(hazard 必须绑定仓库,防跨仓误用)');
  if (!Number.isInteger(h?.originPr)) errs.push('缺 originPr');
  if (!Number.isInteger(h?.fixPr)) errs.push('缺 fixPr');
  if (!str(h?.pattern)) errs.push('缺 pattern');
  if (!str(h?.evidence)) errs.push('缺 evidence(判定依据必须留痕,不能只有 pattern 一句)');
  if (!str(h?.fingerprint)) errs.push('缺 fingerprint');
  if (!Array.isArray(h?.paths) || h.paths.length === 0 || h.paths.some((p) => !str(p))) errs.push('paths 缺失或非法');
  if (!ACTIVATION.includes(h?.activationStatus)) errs.push(`activationStatus 非法(${ACTIVATION.join('|')})`);
  if (!PROMOTION.includes(h?.promotionStatus)) errs.push(`promotionStatus 非法(${PROMOTION.join('|')})`);
  if (h?.promotionStatus === 'landed') {
    const bad = validatePromotionTarget(h?.promotionTarget);
    if (bad) errs.push(bad);
  }
  if (h?.promotionStatus === 'recorded-only' && !str(h?.promotionTarget?.reason)) errs.push('recorded-only 必须带理由');
  // grandfather 只对**显式白名单里的种子 identity** 生效(第 2 轮核验:此前任意条目自称
  // grandfathered 就能免 fixHead)。白名单外一律要求两侧完整 40 位 head OID。
  const grandfathered = h?.grandfathered === true && GRANDFATHERED_IDS.has(h?.hazardId);
  if (h?.grandfathered === true && !grandfathered) {
    errs.push(`grandfathered:true 只允许白名单内的种子条目(${h?.hazardId} 不在其中)`);
  }
  if (!grandfathered) {
    if (!sha(h?.fixHead)) errs.push('缺 fixHead(完整 40 位 SHA;激活时要精确核验)');
    if (!sha(h?.originHead)) errs.push('缺 originHead(完整 40 位 SHA;origin OID 门不能留空)');
  }
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

/** 只有 active 的 hazard 才进 prompt;paths matcher 与本次 changed files 求交。
 *  repo **必须**能解析:解析失败(null)时返回空集并置 incomplete —— 第 2 轮核验点名
 *  "repo 解析失败可变 null 并禁用过滤",那等于跨仓漏用 + 无声降级。只读展示(--list)
 *  显式传 allowNoRepo:true。 */
export function hazardsForPaths(loaded, changedPaths, repo = null, { allowNoRepo = false } = {}) {
  if (loaded.incomplete) return [];
  if (repo == null && !allowNoRepo) return [];
  return loaded.hazards.filter((h) => h.activationStatus === 'active'
    && (repo == null || h.repo === repo)
    && (h.paths ?? []).some((pat) => changedPaths.some((p) => matchPath(pat, p))));
}

export const ACT_RANK = { 'pending-fix-merge': 0, active: 1 };
export const PROM_RANK = { pending: 0, 'recorded-only': 1, landed: 2 };

/**
 * 合并同一 hazardId 的两份记录。**方向无关**(mergeHazardPair(a,b) 与 (b,a) 结果全等)
 * —— 第 2 轮核验实测的反例:一方 landed+promotionTarget、另一方 pending+显式
 * `promotionTarget:null` 时,`{...cur, ...h}` 会让状态升级到 landed 却把 target 覆盖成 null,
 * 反向又得到 landed+target。状态与它的附属元数据必须**原子地**取自同一个赢家。
 */
export function mergeHazardPair(a, b) {
  const rankWin = (rank, field) => ((rank[b?.[field]] ?? -1) > (rank[a?.[field]] ?? -1) ? b : a);
  const actWin = rankWin(ACT_RANK, 'activationStatus');
  const promWin = rankWin(PROM_RANK, 'promotionStatus');
  // 非状态字段:先取非空,再按字典序定序(保证对称);两侧一致时无差别
  const scalar = (field) => {
    const x = a?.[field];
    const y = b?.[field];
    if (x === undefined || x === null || x === '') return y ?? null;
    if (y === undefined || y === null || y === '') return x;
    if (JSON.stringify(x) === JSON.stringify(y)) return x;
    return JSON.stringify(x) < JSON.stringify(y) ? x : y;
  };
  const out = {};
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) out[k] = scalar(k);
  out.activationStatus = actWin.activationStatus;
  out.activatedAt = actWin.activatedAt ?? null;
  out.promotionStatus = promWin.promotionStatus;
  out.promotionTarget = promWin.promotionTarget ?? null;
  return out;
}

/** 幂等 upsert(稳定 hazardId;atomic temp+rename)。返回 { changed, hazard }。 */
export function upsertHazard(file, hazard) {
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const list = Array.isArray(doc.escapedHazards) ? doc.escapedHazards : [];
  const idx = list.findIndex((h) => h.hazardId === hazard.hazardId);
  let changed = true;
  if (idx >= 0) {
    const prev = list[idx];
    // 幂等:同内容重复登记不增条、不降级(active 不回退 pending-fix-merge;landed 不回退
    // pending),且状态与其附属元数据原子取自赢家(见 mergeHazardPair)。
    const merged = mergeHazardPair(prev, hazard);
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
export function verifyActivation({ item, probe, currentRepo = null }) {
  // 激活必须发生在**本仓**(第 2 轮核验:repo 不校验时,别的仓的 inbox 条目会被写进
  // canonical 并对本仓生效)。
  if (currentRepo != null && item.repo !== currentRepo) {
    return { ok: false, reason: `hazard 绑定的 repo(${item.repo})不是当前仓(${currentRepo})——不得跨仓激活` };
  }
  if (!/^[0-9a-f]{40}$/.test(String(item.originHead ?? '').toLowerCase())) {
    return { ok: false, reason: 'originHead 不是完整 40 位 SHA——origin OID 门不能留空(否则"逃逸前提"无从核验)' };
  }
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
  if ((origin.headRefOid ?? '').toLowerCase() !== item.originHead.toLowerCase()) {
    return { ok: false, reason: `origin PR #${item.originPr} 的 head(${origin.headRefOid ?? '未知'})与登记的 originHead(${item.originHead})不一致` };
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
 * @param {object} p { items, probe, upsert, readback, sync, remoteVerify, currentRepo }
 *   upsert(item)          → 写 canonical,返回 { hazard }
 *   readback()            → 读 canonical,返回 { incomplete, hazards }
 *   sync(hazard)          → 提交并推送,返回 { ok, pushed, error?, skipped?, reason? }
 *   remoteVerify(hazard)  → 读 remote 上的 canonical,返回 { ok, present } —— 只在 sync 报
 *                           `nothing-to-push` 时用到(第 2 轮核验:push 成功后进程在 ack 前
 *                           崩溃,重放会拿到 pushed=false + nothing-to-push,旧逻辑永远保留
 *                           inbox。此时必须核验远端确实已含**完全一致**的 hazard 再安全 ack)
 * @returns {{ activated: string[], kept: object[] }}
 */
export function activateInboxItems({ items, probe, upsert, readback, sync, remoteVerify = null, currentRepo = null }) {
  const activated = [];
  const kept = [];
  for (const item of items ?? []) {
    const v = verifyActivation({ item, probe, currentRepo });
    if (!v.ok) { kept.push({ ...item, lastActivationCheck: v.reason }); continue; }
    const { hazard } = upsert({ ...item, activationStatus: 'active', activatedAt: new Date().toISOString() });
    const verify = readback();
    if (verify.incomplete || !verify.hazards.some((h) => h.hazardId === item.hazardId && h.activationStatus === 'active')) {
      kept.push({ ...item, lastActivationCheck: 'canonical 回读校验失败,保留重放' });
      continue;
    }
    const s = sync(hazard);
    if (s?.ok === true && s.pushed !== true && s.reason === 'nothing-to-push') {
      // 无可推 = 本地 HEAD 已等于远端。只有远端确实带着这条 active hazard 才允许 ack。
      const rv = remoteVerify ? remoteVerify(hazard) : { ok: false, present: false };
      if (rv?.ok === true && rv.present === true) { activated.push(hazard.hazardId); continue; }
      kept.push({ ...item, lastActivationCheck: `sync 报 nothing-to-push,但远端核验未确认该 hazard(${rv?.error ?? 'present=false'}),保留 inbox 重放` });
      continue;
    }
    if (!s?.ok || s.pushed !== true) {
      kept.push({ ...item, lastActivationCheck: `canonical 已写但 push 未成功(${s?.error ?? s?.skipped ?? s?.reason ?? 'pushed=false'}),保留 inbox 重放` });
      continue;
    }
    activated.push(hazard.hazardId);
  }
  return { activated, kept };
}
