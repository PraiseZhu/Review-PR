#!/usr/bin/env node
// record-escaped-finding.mjs — 逃逸 finding 登记与激活(SC-R7,2026-08-05)。
//
// 两段式(避免"修复 PR 还没合就把 hazard 当既成事实"):
//   1. `--register`:写 STATE_DIR 的**可重放 inbox**(activationStatus=pending-fix-merge)。
//      consume-review-output 依据审查输出的 escapeAssessment(yes 项)确定性调用它——
//      "识别是不是逃逸"是语义判断(T1),但"识别为 yes 之后必须登记"是机器行为。
//   2. `--activate`:核验 fix PR 已 MERGED **且 merged head === 登记的 fixHead**,才把条目
//      upsert 进 canonical `evolution/ledger.json`(activationStatus=active)。
//      **ack 严格晚于 canonical upsert + 回读 + commit&push 成功**(push 就在本脚本里,经
//      skillRepoCommitPush 注入);失败保留 inbox 重放(幂等 upsert,重复不增条、不降级)。
//      push 报 `nothing-to-push`(上轮已推成功但崩在 ack 之前)时,必须读**远端** canonical
//      确认该 hazard 已 active 才安全 ack。
//   生产触发点是**合并出口** merge-pr.mjs:合并成功后自动调 `--activate`,不依赖手工命令。
//
// 用法:
//   node record-escaped-finding.mjs --register --origin-pr N --fix-pr M \
//     --fix-head <40hex> --origin-head <40hex> \
//     --pattern "<一句话模式>" --evidence "<判定依据>" --paths "a/**,b/**" \
//     --promotion pending|landed|recorded-only \
//     [--promote-rule <ruleId>] [--promote-profile <profileId>] [--promote-check <checkId>] \
//     [--reason "<recorded-only 必填理由>"] [--evidence "<证据锚点>"]
//   node record-escaped-finding.mjs --activate            # 处理 inbox 里全部 pending
//   node record-escaped-finding.mjs --list
// 退出码:0 成功;2 有条目未能激活(如 fix PR 还没合);1 脚本自身错误。
import process from 'node:process';
import { print, fail, STATE_DIR, ghJson, parseRepo, skillRepoCommitPush, readRemoteSkillFile } from './lib.mjs';
import { BUILTIN_RULES } from './lib.preflight-rules.mjs';
import { BUILTIN_PROFILES } from './lib.review-profiles.mjs';
import {
  EVOLUTION_LEDGER, deriveHazardId, deriveHazardFingerprint, loadKnownHazards, upsertHazard,
  loadInbox, saveInbox, verifyActivation, validateHazardShape, activateInboxItems, PROMOTION, remoteHazardPresent,
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
  // landed:逐项核验目标存在。
  // 第 5 轮核验 BLOCKER:此前 `if (ruleId) { ...; return ... }` 在分支选择前不做任何互斥
  // 校验——同时给 `--promote-rule <合法规则> --promote-profile test-infra`(不带
  // --promote-check)时,ruleId 分支直接命中并 return,profileId 被静默忽略,exit 0
  // 成功登记。两个目标类型互斥,且 profile 目标缺 checkId 必须在**选分支之前**拒绝,
  // 不能指望"进了 profile 分支才检查"——因为可能永远进不了那个分支。
  if (ruleId && profileId) {
    return { ok: false, error: '--promote-rule 与 --promote-profile 不能同时指定(landed 目标只能是其一,不得静默忽略另一个)' };
  }
  if (profileId && !checkId) {
    return { ok: false, error: '--promote-profile 必须搭配 --promote-check <checkId>(landed 必须指到具体必答项)' };
  }
  if (ruleId) {
    const r = BUILTIN_RULES.find((x) => x.ruleId === ruleId);
    if (!r) return { ok: false, error: `--promote-rule ${ruleId} 在规则注册表里不存在,不能标 landed` };
    return { ok: true, target: { kind: 'rule', ruleId, ruleVersion: r.ruleVersion } };
  }
  if (profileId) {
    const p = BUILTIN_PROFILES.find((x) => x.id === profileId);
    if (!p) return { ok: false, error: `--promote-profile ${profileId} 不存在,不能标 landed` };
    if (!p.mandatoryChecks.some((c) => c.id === checkId)) {
      return { ok: false, error: `--promote-check ${checkId} 不在 profile ${profileId} 的必答项里,不能标 landed` };
    }
    return { ok: true, target: { kind: 'profile', profileId, checkId } };
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

    const { owner, repo } = (() => { try { return parseRepo(); } catch { return { owner: null, repo: null }; } })();
    const repoSlug = owner && repo ? `${owner}/${repo}` : null;
    if (!repoSlug) fail(new Error('无法解析目标仓库(hazard 必须绑定 repo,防跨仓误用)'));
    const originHead = (argOf('--origin-head') ?? '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(originHead)) fail(new Error('缺 --origin-head <完整 40 位 SHA>(origin OID 门不能留空)'));
    // hazardId 只绑稳定事件身份(repo + 两个 PR 号 + 两侧 head);pattern/paths 是 evidence,
    // 换措辞不得生成新 ID(第 2 轮核验:幂等被自由文本破坏)。
    const seed = { repo: repoSlug, originPr, fixPr, originHead, fixHead };
    const item = {
      hazardId: deriveHazardId(seed), fingerprint: deriveHazardFingerprint(seed),
      repo: repoSlug, originPr, originHead, fixPr, fixHead,
      pattern, paths, evidence: argOf('--evidence') ?? null,
      activationStatus: 'pending-fix-merge', promotionStatus: promotion,
      promotionTarget: t.target, registeredAt: new Date().toISOString(),
    };
    const hazardId = item.hazardId;
    const shape = validateHazardShape({ ...item, activationStatus: 'active' }); // 校验字段完整性
    if (!shape.ok) fail(new Error(`hazard 字段不完整:${shape.errors.join(';')}`));
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
    const { activated, kept } = activateInboxItems({
      items: inbox.items,
      probe,
      currentRepo: `${owner}/${repo}`,
      upsert: (item) => upsertHazard(EVOLUTION_LEDGER, item),
      readback: () => loadKnownHazards(),
      sync: (hazard) => skillRepoCommitPush({
        paths: ['evolution/ledger.json'],
        message: `evo: activate escaped hazard ${hazard.hazardId} (origin #${hazard.originPr} → fix #${hazard.fixPr})`,
      }),
      // push 已成功但进程在 ack 前崩溃时,重放会拿到 nothing-to-push —— 此时读**远端**
      // canonical 确认该 hazard 已 active 才安全 ack(否则条目永远卡在 inbox)。
      // 判定逻辑在 lib 里唯一实现(remoteHazardPresent),便于单测:**完全等价**才算已落地,
      // 同 id + active 只能说明"有过一条"(第 3 轮核验点名的误 ack 面)。
      remoteVerify: (hazard) => readRemoteSkillFile('evolution/ledger.json', (text) => remoteHazardPresent(text, hazard)),
    });
    saveInbox(STATE_DIR, kept);
    print({
      ok: kept.length === 0, action: 'activate', activated, pending: kept.map((k) => ({ hazardId: k.hazardId, reason: k.lastActivationCheck })),
      note: 'ack(从 inbox 移除)严格晚于 canonical upsert + 回读校验 + commit&push 成功;三者任一失败都保留 inbox 下轮重放(幂等 upsert,重复不增条、不降级)。',
    });
    process.exit(kept.length === 0 ? 0 : 2);
  }

  fail(new Error('需指定 --register / --activate / --list'));
} catch (e) {
  fail(e);
}
