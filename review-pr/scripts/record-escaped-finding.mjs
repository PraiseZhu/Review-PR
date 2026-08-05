#!/usr/bin/env node
// record-escaped-finding.mjs — 逃逸 finding 登记与激活(SC-R7,2026-08-05)。
//
// 两段式(避免"修复 PR 还没合就把 hazard 当既成事实"):
//   1. `--register`:写 STATE_DIR 的**可重放 inbox**(activationStatus=pending-fix-merge)。
//      consume-review-output 依据审查输出的 escapeAssessment(yes 项)确定性调用它——
//      "识别是不是逃逸"是语义判断(T1),但"识别为 yes 之后必须登记"是机器行为。
//   2. `--activate`:核验 fix PR 已 MERGED **且 merged head === 登记的 fixHead**,才把条目
//      upsert 进 canonical `evolution/ledger.json`(activationStatus=active)。
//      **ack 严格晚于 canonical upsert 成功**;失败保留 inbox 重放(幂等 upsert,重复不
//      增条、不降级)。push 由既有 skillRepoCommitPush 流程负责,本脚本只保证落盘顺序。
//
// 用法:
//   node record-escaped-finding.mjs --register --origin-pr N --fix-pr M --fix-head <sha> \
//     --pattern "<一句话模式>" --paths "a/**,b/**" --promotion pending|landed|recorded-only \
//     [--promote-rule <ruleId>] [--promote-profile <profileId>] [--promote-check <checkId>] \
//     [--reason "<recorded-only 必填理由>"] [--evidence "<证据锚点>"]
//   node record-escaped-finding.mjs --activate            # 处理 inbox 里全部 pending
//   node record-escaped-finding.mjs --list
// 退出码:0 成功;2 有条目未能激活(如 fix PR 还没合);1 脚本自身错误。
import process from 'node:process';
import { print, fail, STATE_DIR, ghJson, parseRepo } from './lib.mjs';
import { BUILTIN_RULES } from './lib.preflight-rules.mjs';
import { BUILTIN_PROFILES } from './lib.review-profiles.mjs';
import {
  EVOLUTION_LEDGER, deriveHazardId, loadKnownHazards, upsertHazard,
  loadInbox, saveInbox, verifyActivation, PROMOTION,
} from './lib.escaped-hazards.mjs';

const has = (f) => process.argv.includes(f);
const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };

/** promote 目标必须**实际存在且版本可解析**才允许标 landed(第 3 轮共识)。 */
function resolvePromotionTarget({ promotion, ruleId, profileId, checkId, reason }) {
  if (!PROMOTION.includes(promotion)) return { ok: false, error: `--promotion 必须是 ${PROMOTION.join('|')}` };
  if (promotion === 'recorded-only') {
    return reason ? { ok: true, target: { kind: 'recorded-only', reason } } : { ok: false, error: 'recorded-only 必须带 --reason' };
  }
  if (promotion === 'pending') return { ok: true, target: null };
  // landed:逐项核验目标存在
  if (ruleId) {
    const r = BUILTIN_RULES.find((x) => x.ruleId === ruleId);
    if (!r) return { ok: false, error: `--promote-rule ${ruleId} 在规则注册表里不存在,不能标 landed` };
    return { ok: true, target: { kind: 'rule', ruleId, ruleVersion: r.ruleVersion } };
  }
  if (profileId) {
    const p = BUILTIN_PROFILES.find((x) => x.id === profileId);
    if (!p) return { ok: false, error: `--promote-profile ${profileId} 不存在,不能标 landed` };
    if (checkId && !p.mandatoryChecks.some((c) => c.id === checkId)) {
      return { ok: false, error: `--promote-check ${checkId} 不在 profile ${profileId} 的必答项里,不能标 landed` };
    }
    return { ok: true, target: { kind: 'profile', profileId, checkId: checkId ?? null } };
  }
  return { ok: false, error: 'landed 必须指定 --promote-rule 或 --promote-profile(且目标须实际存在)' };
}

try {
  if (has('--list')) {
    const loaded = loadKnownHazards();
    print({ ok: !loaded.incomplete, incomplete: loaded.incomplete, reason: loaded.reason ?? null, hazards: loaded.hazards, inbox: loadInbox(STATE_DIR).items });
    process.exit(0);
  }

  if (has('--register')) {
    const originPr = Number(argOf('--origin-pr'));
    const fixPr = Number(argOf('--fix-pr'));
    const fixHead = (argOf('--fix-head') ?? '').toLowerCase();
    const pattern = argOf('--pattern');
    const paths = (argOf('--paths') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const promotion = argOf('--promotion') ?? 'pending';
    if (!Number.isInteger(originPr) || !Number.isInteger(fixPr)) fail(new Error('缺 --origin-pr / --fix-pr'));
    if (!/^[0-9a-f]{40}$/.test(fixHead)) fail(new Error('缺 --fix-head <完整 40 位 SHA>(激活时要精确核验)'));
    if (!pattern || paths.length === 0) fail(new Error('缺 --pattern / --paths'));
    const t = resolvePromotionTarget({ promotion, ruleId: argOf('--promote-rule'), profileId: argOf('--promote-profile'), checkId: argOf('--promote-check'), reason: argOf('--reason') });
    if (!t.ok) fail(new Error(t.error));

    const hazardId = deriveHazardId({ originPr, pattern, paths });
    const item = {
      hazardId, originPr, originHead: (argOf('--origin-head') ?? null), fixPr, fixHead,
      pattern, paths, evidence: argOf('--evidence') ?? null,
      activationStatus: 'pending-fix-merge', promotionStatus: promotion,
      promotionTarget: t.target, registeredAt: new Date().toISOString(),
    };
    const inbox = loadInbox(STATE_DIR);
    if (!inbox.ok) fail(new Error(`inbox 不可读:${inbox.error}(fail-closed)`));
    const items = inbox.items.filter((x) => x.hazardId !== hazardId);
    items.push(item);
    saveInbox(STATE_DIR, items);
    print({ ok: true, action: 'register', hazardId, queued: items.length, note: '已入 inbox(pending-fix-merge);fix PR 合并后跑 --activate 核验并写入 canonical evolution/ledger.json' });
    process.exit(0);
  }

  if (has('--activate')) {
    const inbox = loadInbox(STATE_DIR);
    if (!inbox.ok) fail(new Error(`inbox 不可读:${inbox.error}(fail-closed)`));
    const { owner, repo } = parseRepo();
    const probe = (pr) => {
      try {
        const v = ghJson(['pr', 'view', String(pr), '--repo', `${owner}/${repo}`, '--json', 'state,mergeCommit,headRefOid']);
        return { state: v.state, headRefOid: v.headRefOid, mergeCommitOid: v.mergeCommit?.oid ?? null };
      } catch { return null; }
    };
    const activated = [];
    const kept = [];
    for (const item of inbox.items) {
      const v = verifyActivation({ item, probe });
      if (!v.ok) { kept.push({ ...item, lastActivationCheck: v.reason }); continue; }
      // canonical upsert 成功后才 ack(从 inbox 移除)
      const { hazard } = upsertHazard(EVOLUTION_LEDGER, { ...item, activationStatus: 'active', activatedAt: new Date().toISOString() });
      const verify = loadKnownHazards();
      if (verify.incomplete || !verify.hazards.some((h) => h.hazardId === item.hazardId && h.activationStatus === 'active')) {
        kept.push({ ...item, lastActivationCheck: 'canonical 回读校验失败,保留重放' });
        continue;
      }
      activated.push(hazard.hazardId);
    }
    saveInbox(STATE_DIR, kept);
    print({
      ok: kept.length === 0, action: 'activate', activated, pending: kept.map((k) => ({ hazardId: k.hazardId, reason: k.lastActivationCheck })),
      note: '已激活的条目写进 canonical evolution/ledger.json(需随 skill 仓提交/推送才对其它机器生效);未激活的留在 inbox 下轮重放。',
    });
    process.exit(kept.length === 0 ? 0 : 2);
  }

  fail(new Error('需指定 --register / --activate / --list'));
} catch (e) {
  fail(e);
}
