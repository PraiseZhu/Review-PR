#!/usr/bin/env node
// audit-merged-loop-prs.mjs — 事后审计闸(A5,缴械配套,owner 2026-08-04 决策
// mergeAuthority=review-pr-only):每轮扫「上轮审计游标以来 merged 的 loop 托管 PR」,
// 逐个核验 head-bound 审查回执;核不过 → T0 定向告警 + 自动开 revert PR(revert 本身
// 仍走 review-pr 审查合并,本脚本只开不合)。
//
// 为什么需要这道闸:前置门(A1 force-review / A2 封 fast-merge / A3 self-merge 回执
// 硬门)都是「合并前」的;若有人绕开唯一出口 merge-pr.mjs 直接按了合并键(共享 GitHub
// 身份在账号能力上做得到,机器级隔离在缴械台账包 D,择日),前置门全部失效。本闸是
// 「合并后」的最后一道:漏网的合并最迟一轮内被发现、告警、并有 revert PR 等着巡审处置。
//
// 保证等级(如实声明):回执核验只做 receipt 层三条——存在 / headRefOid 逐字等于该 PR
// 的 head / verdict=clean。**不重建** stage2 的 snapshotHash/ledgerHash(事后重建需要
// checkout 历史 head,成本与失败面都大);receipt 文件本身可被本机进程伪造,与
// write-review-receipt.mjs 的既有信任边界一致(防呆不防敌,防的是「流程被绕过」而非
// 「本机被攻破」)。
//
// 首跑语义:无游标时只立游标、不回溯——缴械前的历史 loop PR 由 loop 自己合并,本就没有
// 回执,回溯只会制造成片误告警。审计只对「缴械之后」的合并有意义。
//
// 幂等:audited 台账按 `<pr>:<mergeOid>` 记账(同一 PR 被 revert 后重新合并会有新
// mergeOid,视为新事件再审一次)。告警**只在真送达**远端通道时才记 alerted(降级路径不算,
// 下轮重试);revert PR 创建成功才记 revertPr。两者独立幂等,互不阻塞。
//
// 用法: node scripts/audit-merged-loop-prs.mjs [--dry-run] [--now <iso>]
//         [--input-merged <json>]
//   --dry-run       只判定与打印,不发告警、不开 revert PR、不写游标/台账;
//   --input-merged  测试口:JSON 文件 [{number,title,body,headRefOid,mergeCommitOid,mergedAt}]
//                   绕过 gh 查询(与 reconcile-merged 的 --input-prs 同款测试缝);
//   --now           测试口:确定性时间(游标推进用),缺省 new Date()。
// 退出码:0 = 完成(含无事可做);1 = 脚本自身出错。审计发现缺回执**不改变退出码**——
// 结论在 JSON 输出与告警里,闸的职责是让人看见,不是让巡审主流程炸掉。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseRepo, ghJson, ghGraphql, loadRules, detectLoopExclusion, readReviewReceipt,
  resolveInRepoRoot, print, fail, STATE_DIR,
} from './lib.mjs';

const AUDIT_STATE_FILE = 'audit-merged-loop.json';

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}
const DRY_RUN = process.argv.includes('--dry-run');

export function loadAuditState(stateDir) {
  const p = join(stateDir, AUDIT_STATE_FILE);
  if (!existsSync(p)) return { schemaVersion: 1, cursor: null, audited: {} };
  // 损坏 fail-visible:静默重建会把游标清零→不回溯语义反而丢掉已审窗口,抛给调用方
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  if (parsed.schemaVersion !== 1) throw new Error(`audit-merged-loop schemaVersion=${parsed.schemaVersion} 不识别`);
  return { schemaVersion: 1, cursor: parsed.cursor ?? null, audited: parsed.audited ?? {} };
}

function saveAuditState(stateDir, st) {
  mkdirSync(stateDir, { recursive: true });
  const p = join(stateDir, AUDIT_STATE_FILE);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(st, null, 2)}\n`);
  renameSync(tmp, p); // 原子落盘(与 reconcile sidecar 同款)
}

/**
 * 纯函数:单个 merged loop PR 的回执裁决(可单测)。
 * @returns {{ok:boolean, reason:string}} ok=false 即「漏网合并」需告警+revert
 */
export function judgeMergedLoopPr({ receipt, headRefOid }) {
  if (!receipt) return { ok: false, reason: 'no-receipt(无阶段二审查回执——合并绕过了 review-pr 流程)' };
  if (!headRefOid) return { ok: false, reason: 'head-unknown(PR head 读不到,无从绑定,fail-closed 按漏网处理)' };
  if (receipt.headRefOid !== headRefOid) {
    return { ok: false, reason: `stale-receipt(回执绑定 ${String(receipt.headRefOid).slice(0, 8)},合并的是 ${headRefOid.slice(0, 8)}——审完又推了新 commit 再合并)` };
  }
  if (receipt.verdict !== 'clean') return { ok: false, reason: `receipt-not-clean(verdict=${receipt.verdict})` };
  return { ok: true, reason: 'head-bound-clean-receipt' };
}

/**
 * 自动开 revert PR:GitHub 原生 revertPullRequest mutation——零本地 git 操作(不建
 * worktree、不 push 分支),GitHub 服务端生成 revert 分支与 PR。revert PR 开 ready
 * (非 draft):它的存在意义就是立即进巡审审合。冲突无法自动 revert 时 GitHub 会报错,
 * 如实带回 reason,人工处置(告警文本已含全部现场信息)。
 */
async function openRevertPr({ slug, prNumber, reason }) {
  try {
    const meta = ghJson(['pr', 'view', String(prNumber), '--repo', slug, '--json', 'id']);
    if (!meta?.id) return { created: false, reason: 'pr-node-id-unavailable' };
    const res = ghGraphql(
      `mutation($prId: ID!, $title: String!, $body: String!) {
        revertPullRequest(input: { pullRequestId: $prId, draft: false, title: $title, body: $body }) {
          revertPullRequest { number url }
        }
      }`,
      {
        prId: meta.id,
        title: `revert: loop PR #${prNumber} 合并未经审查回执(事后审计闸)`,
        body: [
          `事后审计闸(audit-merged-loop-prs.mjs)判定 PR #${prNumber} 为 loop 托管 PR 且其合并未经 head-bound clean 审查回执:`,
          '', `> ${reason}`, '',
          '本 revert PR 由审计闸自动创建,**仍走 review-pr 巡审审查合并**(缴械决策 2026-08-04:review-pr 是唯一合并闸)。',
          '若确认原合并其实合法(如回执因状态目录迁移丢失),直接 close 本 PR 并在原 PR 留言说明即可。',
        ].join('\n'),
      },
    );
    const rp = res?.data?.revertPullRequest?.revertPullRequest;
    if (!rp?.number) return { created: false, reason: `revert-mutation-no-result: ${JSON.stringify(res?.errors ?? res).slice(0, 300)}` };
    return { created: true, number: rp.number, url: rp.url };
  } catch (e) {
    return { created: false, reason: `revert-failed: ${e.message.slice(0, 300)}` };
  }
}

async function sendOpsAlert({ title, text }) {
  // 与 notify-sync-alert.mjs 完全同款的定向私聊出口:复用 mergeAckNotify.notifyModule +
  // notify.env 的 SLACK_OPS_ALERT_CHANNEL_ID;未配置 = 能力关闭(posted:false),照常返回。
  try {
    const prRules = loadRules();
    const mergeAck = prRules.loopPrExclusion?.mergeAckNotify ?? {};
    if (!mergeAck.notifyModule) return { posted: false, reason: 'notify-module-not-configured' };
    const mod = await import(pathToFileURL(resolveInRepoRoot(mergeAck.notifyModule)).href);
    const config = mod.loadNotifyConfig(mergeAck.stateDir ? resolveInRepoRoot(mergeAck.stateDir) : undefined);
    const opsChannel = config?.SLACK_OPS_ALERT_CHANNEL_ID;
    if (!opsChannel) return { posted: false, reason: 'ops-alert-channel-not-configured' };
    const res = await mod.sendAlert({ config: { ...config, SLACK_CHANNEL_ID: opsChannel }, title, text });
    return { posted: res?.channel === 'slack', channel: res?.channel ?? null };
  } catch (e) {
    return { posted: false, reason: `alert-failed: ${e.message}` };
  }
}

async function main() {
  const rules = loadRules();
  const LOOP_RULES = rules.loopPrExclusion ?? null;
  if (!LOOP_RULES) { print({ ok: true, audited: [], reason: 'loopPrExclusion-not-configured(目标仓库无 loop,本闸天然关闭)' }); return 0; }

  const now = argAfter('--now') || new Date().toISOString();
  const state = loadAuditState(STATE_DIR);

  // 首跑:只立游标不回溯(见文件头)。dry-run 不落盘。
  if (!state.cursor) {
    if (!DRY_RUN) await saveAuditState(STATE_DIR, { ...state, cursor: now });
    print({ ok: true, audited: [], firstRun: true, cursorSet: now, note: '首跑只立游标,不回溯缴械前的历史合并' });
    return 0;
  }

  // 取窗口内 merged PR(测试口可注入)
  let merged = [];
  const inputFile = argAfter('--input-merged');
  if (inputFile) {
    merged = JSON.parse(readFileSync(inputFile, 'utf8'));
  } else {
    const { slug } = parseRepo();
    const list = ghJson([
      'pr', 'list', '--repo', slug, '--state', 'merged', '--limit', '100',
      '--search', `merged:>=${state.cursor.slice(0, 10)}`,
      '--json', 'number,title,body,headRefOid,mergeCommit,mergedAt',
    ]) ?? [];
    merged = list.map((p) => ({
      number: p.number, title: p.title ?? '', body: p.body ?? '',
      headRefOid: p.headRefOid ?? null, mergeCommitOid: p.mergeCommit?.oid ?? null, mergedAt: p.mergedAt ?? null,
    }));
  }

  const results = [];
  let alertsSent = 0;
  for (const p of merged) {
    // 窗口 [cursor, now] 两端都裁:左边界因 gh 搜索只到天粒度必须在这里精确裁;右边界在
    // 生产不可达(now 是当前时刻,GitHub 不会给出未来的 mergedAt),但窗口语义要完整——
    // 只裁一端会让 `--now` 回溯审计把窗口之后的合并也吞进来,且使「跨过的窗口一并审到」
    // 这个说法失准(实测发现,2026-08-05)。
    if (p.mergedAt && (p.mergedAt < state.cursor || p.mergedAt > now)) continue;
    const loop = detectLoopExclusion({ title: p.title, body: p.body, pr: p.number, rules: LOOP_RULES });
    if (!loop) continue; // 非 loop 托管 PR:普通 PR 的合并纪律由既有 receipt/audit 通道管,不在本闸范围
    const key = `${p.number}:${p.mergeCommitOid ?? 'unknown-oid'}`;
    const prior = state.audited[key];
    if (prior?.alerted || prior?.verdictOk) { results.push({ pr: p.number, key, skipped: 'already-audited' }); continue; }

    const receipt = readReviewReceipt(p.number);
    const verdict = judgeMergedLoopPr({ receipt, headRefOid: p.headRefOid });
    const entry = { pr: p.number, key, mergedAt: p.mergedAt, ok: verdict.ok, reason: verdict.reason };

    if (verdict.ok) {
      state.audited[key] = { verdictOk: true, at: now };
    } else if (!DRY_RUN) {
      // 漏网合并:先开 revert PR(幂等:创建成功才记 revertPr,失败下轮重试),再发 T0 告警
      // (告警文案要带上 revert PR 结果——开成开败都得让人一眼看到现场全貌)。
      if (!prior?.revertPr) {
        const { slug } = parseRepo();
        const revert = await openRevertPr({ slug, prNumber: p.number, reason: verdict.reason });
        entry.revert = revert;
        if (revert.created) state.audited[key] = { ...(state.audited[key] ?? {}), revertPr: revert.number, at: now };
      } else {
        entry.revert = { created: true, number: prior.revertPr, note: 'revert PR 已在此前轮次创建' };
      }
      const alert = await sendOpsAlert({
        title: `🛑 [review-pr] 事后审计:loop PR #${p.number} 的合并未经审查回执`,
        text: [
          `PR #${p.number}(merged ${p.mergedAt ?? '未知时刻'})是 loop 托管 PR,但 ${verdict.reason}。`,
          `合并绕过了 review-pr 唯一闸(缴械决策 2026-08-04)。已按台账 ${key} 记账。`,
          entry.revert?.created
            ? `revert PR 已自动开:#${entry.revert.number}(仍走巡审审合;若原合并其实合法,close 它并留言即可)。`
            : `revert PR 自动创建失败(${entry.revert?.reason ?? '未知'}),下轮幂等重试;需要人工先行处置。`,
        ].join('\n'),
      });
      entry.alert = alert;
      if (alert.posted) {
        alertsSent += 1;
        state.audited[key] = { ...(state.audited[key] ?? {}), alerted: true, at: now, reason: verdict.reason };
      }
    }
    results.push(entry);
  }

  if (!DRY_RUN) await saveAuditState(STATE_DIR, { ...state, cursor: now });
  print({ ok: true, dryRun: DRY_RUN, windowFrom: state.cursor, windowTo: now, audited: results, alertsSent });
  return 0;
}

// 与 reconcile-merged 同款直跑守卫:被 import(测试)时不执行主流程
const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().then((c) => process.exit(c ?? 0)).catch((e) => { fail(`audit-merged-loop-prs 出错: ${e.message}`); });
}
