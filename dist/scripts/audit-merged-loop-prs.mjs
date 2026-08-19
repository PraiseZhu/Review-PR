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
// 窗口取全保证(F-A5-PAGINATION-CURSOR-LOSS 二审修复):游标推进的前提是本轮已通过
// fetchAllMergedPrs 的 GraphQL 翻页确认取到窗口 [cursor, now] 内的全部 merged PR
// 全集(hasNextPage=false)。翻页未确认取全(超过硬上限)→ 游标原地不动 + 输出
// windowPossiblyTruncated:true,不静默漏审(见 decideCursorAfterFetch)。
//
// 幂等:audited 台账按 `<pr>:<mergeOid>` 记账(同一 PR 被 revert 后重新合并会有新
// mergeOid,视为新事件再审一次)。告警**只在真送达**远端通道时才记 alerted(降级路径不算,
// 下轮重试);revert PR 创建成功才记 revertPr。两者独立幂等,互不阻塞。
//
// 游标推进边界(F-A5-REMEDIATION-RETRY-LOSS 修复):上面这条「下轮重试」承诺曾经是失实
// 声明——main() 无论本轮 remediation 是否成功都无条件把游标推到 now,窗口左边界一旦前移,
// 未解决的 PR 因 mergedAt 早于新游标被窗口过滤器永久排除,再也没有"下一轮"。
// decideCursorAfterRemediation 把这条不变量抽成可单测的纯函数:存在未解决 entry 时,
// 游标停在这些 entry 里最早的 mergedAt,保证它们仍落在下一轮窗口内。「未解决」的判据见
// isMergedLoopEntryResolved,特别处理了一种不该阻塞游标的情形——alertCapabilityOff(仓库
// 压根没配 mergeAckNotify.notifyModule/ops 频道,是仓库级的长期配置状态,不是这次没送达;
// 重试到天荒地老都会是同一个 reason,一旦当作"需要重试"就会让游标永久卡死、窗口越滚越大,
// 最终撞 fetchAllMergedPrs 翻页硬上限连累后续全部合并都审不到)。
//
// 用法: node scripts/audit-merged-loop-prs.mjs [--dry-run] [--now <iso>]
//         [--input-merged <json>]
//   --dry-run       只判定与打印,不发告警、不开 revert PR、不写游标/台账;
//   --input-merged  测试口:JSON 文件 [{number,title,body,headRefOid,mergeCommitOid,mergedAt}]
//                   绕过 gh 查询(与 reconcile-merged 的 --input-prs 同款测试缝);
//   --now           测试口:确定性时间(游标推进用),缺省 new Date()。
// 退出码:0 = 完成(含无事可做);1 = 脚本自身出错。审计发现缺回执**不改变退出码**——
// 结论在 JSON 输出与告警里,闸的职责是让人看见,不是让巡审主流程炸掉。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseRepo, ghJson, ghGraphql, loadRules, detectLoopExclusion, readReviewReceipt,
  resolveInRepoRoot, print, fail, STATE_DIR,
} from './lib.mjs';

const AUDIT_STATE_FILE = 'audit-merged-loop.json';

// sendOpsAlert 返回的两种「能力关闭」reason(仓库级长期配置状态,不是「这次没送达」)——
// 单列常量供 sendOpsAlert 自身与 isMergedLoopEntryResolved 共用同一份字面量,防止两处
// 各写一份逐渐漂移(其中一处改了 reason 文案,另一处没跟着改,判定悄悄失效)。
const ALERT_REASON_MODULE_NOT_CONFIGURED = 'notify-module-not-configured';
const ALERT_REASON_CHANNEL_NOT_CONFIGURED = 'ops-alert-channel-not-configured';
const ALERT_CAPABILITY_OFF_REASONS = new Set([ALERT_REASON_MODULE_NOT_CONFIGURED, ALERT_REASON_CHANNEL_NOT_CONFIGURED]);

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

// GraphQL search 按 cursor 翻页取「merged >= sinceDate」的全部 PR——修复原漏洞:旧实现固定
// `gh pr list --search ... --limit 100` 单页硬顶,超出 100 条的部分既不核验也不告警、游标却
// 照常前移到 now,永久漏审(seat②codex-adversarial R1 finding F-A5-PAGINATION-CURSOR-LOSS)。
// GraphQL 的 pageInfo.hasNextPage 是确定性信号(不同于 REST 「返回数量==limit 就可能被截断」
// 的启发式),翻到 hasNextPage=false 才算真正「取全」。
const MERGED_PR_SEARCH_QUERY = `
  query($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          number
          title
          body
          headRefOid
          mergeCommit { oid }
          mergedAt
        }
      }
    }
  }
`;

/**
 * 拉取仓库内「merged >= sinceDate」的全部 merged PR,翻到 hasNextPage=false 才返回。
 * fetchPage(after) 供单测注入(签名同 lib.mjs 的 fetchAllRestPages 惯例),缺省走真实
 * ghGraphql。超过 maxPages 仍未翻完 → fail-closed 返回 null(与 fetchAllRestPages 同款
 * 约定:null = 未确认取全,调用方不得据此推进游标)。
 */
export function fetchAllMergedPrs({ slug, sinceDate, fetchPage, maxPages = 20 }) {
  const doFetch = fetchPage ?? ((after) => {
    const vars = { q: `repo:${slug} is:pr is:merged merged:>=${sinceDate}` };
    if (after) vars.after = after;
    const res = ghGraphql(MERGED_PR_SEARCH_QUERY, vars);
    return res?.data?.search ?? null;
  });
  const all = [];
  let after;
  for (let i = 0; i < maxPages; i++) {
    const page = doFetch(after);
    if (!page) return null;
    for (const node of page.nodes ?? []) { if (node) all.push(node); }
    if (!page.pageInfo?.hasNextPage) return all;
    after = page.pageInfo.endCursor;
    if (!after) return null; // hasNextPage 为真却给不出 endCursor,数据不自洽,fail-closed
  }
  return null; // 超过硬上限仍未翻完(真实场景不会发生),fail-closed,不敢说读全了
}

/**
 * 纯函数:本轮窗口能否安全推进游标(可单测)。pages===null(未确认取全)时游标原地不动,
 * 否则推进到 now——把「游标推进的前提是已确认取全」这条不变量从 main() 的控制流里
 * 抽出来,避免裁决逻辑散落在 if 分支里不可单测。
 * @returns {{cursor:string, windowPossiblyTruncated:boolean}}
 */
export function decideCursorAfterFetch({ pages, cursor, now }) {
  if (pages === null) return { cursor, windowPossiblyTruncated: true };
  return { cursor: now, windowPossiblyTruncated: false };
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
 * 纯函数(可单测):判定 main() 本轮产出的单条 entry 是否已到 remediation 终态——即游标
 * 可以安全越过它的 mergedAt。刻意与 main() 循环开头「已审跳过」同一套判据保持一致
 * (audited[key].alerted || audited[key].verdictOk),再叠加一种 cursor-only 的特例:
 * alertCapabilityOff——仓库没配 mergeAckNotify.notifyModule/ops 频道是仓库级长期配置,
 * 不是"这次没送达",重试到天荒地老都会是同一个 reason;此时只要 revert PR 已创建成功,
 * 就算"在这个仓库的配置下已经做到能做的极限",允许游标越过(但不为这条 entry 补写
 * audited[key].alerted——那个字段的语义仍严格是"真送达",本函数不改写它,只影响游标)。
 * 真正「配置了但这次没送达」(alert-failed 异常 / sendAlert 降级到非 slack 通道,此时
 * entry.alert 没有 reason 字段)与 revert 创建失败一样,判定为未解决,游标停在原地等重试。
 * @returns {boolean}
 */
export function isMergedLoopEntryResolved({ entry, audited }) {
  if (entry.skipped === 'already-audited') return true;
  if (entry.ok) return true;
  const persisted = audited?.[entry.key];
  if (persisted?.alerted || persisted?.verdictOk) return true;
  const revertResolved = persisted?.revertPr != null;
  const alertCapabilityOff = ALERT_CAPABILITY_OFF_REASONS.has(entry.alert?.reason);
  return revertResolved && alertCapabilityOff;
}

/**
 * 纯函数(可单测):综合本轮全部 results 的 remediation 终态,计算下一轮该用的游标
 * (F-A5-REMEDIATION-RETRY-LOSS 修复)。不变量:游标只能推进到「窗口内已完全解决」的
 * 边界——存在未解决 entry 时,停在这些 entry 里最早的 mergedAt(下一轮 [新cursor, 新now]
 * 窗口会重新纳入它,给它一次被重新核验/重试的机会);全部已解决(含本轮压根没见到任何
 * entry 的空窗口)才推进到 now。
 * mergedAt 缺失(理论上不会发生——is:merged 搜索结果必有 mergedAt,`--input-merged`
 * 测试口若手工构造出缺失值)时 fail-closed:原地不动,不假设"缺失=可以放行"。
 * @returns {string} 下一轮该用的 cursor(ISO 时间字符串)
 */
export function decideCursorAfterRemediation({ results, audited, cursor, now }) {
  const unresolved = results.filter((entry) => !isMergedLoopEntryResolved({ entry, audited }));
  if (unresolved.length === 0) return now;
  const times = unresolved.map((entry) => entry.mergedAt);
  if (times.some((t) => !t)) return cursor;
  return times.reduce((min, t) => (t < min ? t : min));
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

/**
 * 纯函数(可单测):sendAlert 结果是否算「真送达远端通道」(F-A5-OPS-ALERT-CONTRACT-DRIFT
 * 修复)。此前误写成 channel==='slack'——通知模块的真实通道枚举是 api/webhook/degraded,
 * 'slack' 从不出现,导致 api 送达被判失败:alerted 不落账、游标被卡、下轮重复告警。
 * 判据与 notify-sync-alert.mjs 的送达判定完全同款(api 或 webhook 算送达;degraded
 * 降级路径不算,留给下轮重试)。sendOpsAlert 已摘掉 webhook(见下),所以生产上实际只会
 * 以 api 送达,保留 webhook 分支是为与参照实现形状一致、且对枚举变化 fail-safe。
 */
export function isOpsAlertDelivered(channel) {
  return channel === 'api' || channel === 'webhook';
}

async function sendOpsAlert({ title, text }) {
  // 与 notify-sync-alert.mjs 完全同款的定向私聊出口:复用 mergeAckNotify.notifyModule +
  // notify.env 的 SLACK_OPS_ALERT_CHANNEL_ID;未配置 = 能力关闭(posted:false),照常返回。
  try {
    const prRules = loadRules();
    const mergeAck = prRules.loopPrExclusion?.mergeAckNotify ?? {};
    if (!mergeAck.notifyModule) return { posted: false, reason: ALERT_REASON_MODULE_NOT_CONFIGURED };
    const mod = await import(pathToFileURL(resolveInRepoRoot(mergeAck.notifyModule)).href);
    const config = mod.loadNotifyConfig(mergeAck.stateDir ? resolveInRepoRoot(mergeAck.stateDir) : undefined);
    const opsChannel = config?.SLACK_OPS_ALERT_CHANNEL_ID;
    if (!opsChannel) return { posted: false, reason: ALERT_REASON_CHANNEL_NOT_CONFIGURED };
    // 私聊目标就地替换 SLACK_CHANNEL_ID,**同时摘掉 webhook**(与 notify-sync-alert.mjs
    // 同款理由):sendAlert 在 api 通道不可用时会降级走 incoming webhook,而 webhook 的
    // 目标频道固定是合并致谢群——T0 运维告警一旦从那儿漏出去,既发错了地方又会因 posted
    // 判定重复告警。摘掉后最坏降级到 pending-alerts + 桌面通知(channel:'degraded',
    // 不写 alerted,下轮重试),绝不发错地方。
    const res = await mod.sendAlert({ config: { ...config, SLACK_WEBHOOK_URL: '', SLACK_CHANNEL_ID: opsChannel }, title, text });
    return { posted: isOpsAlertDelivered(res?.channel), channel: res?.channel ?? null };
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
    const pages = fetchAllMergedPrs({ slug, sinceDate: state.cursor.slice(0, 10) });
    const { windowPossiblyTruncated } = decideCursorAfterFetch({ pages, cursor: state.cursor, now });
    if (windowPossiblyTruncated) {
      // fail-closed:未确认取全窗口内的全部 merged PR,游标原地不动(不落盘,维持 state.cursor
      // 不变),本轮不做任何核验/告警/revert 判定。下一轮会重新覆盖整个 [cursor, now'] 窗口——
      // 幂等台账按 <pr>:<mergeOid> 记账,重覆盖不会对已处理过的 PR 重复告警。
      print({
        ok: true, dryRun: DRY_RUN, windowFrom: state.cursor, windowTo: now,
        audited: [], alertsSent: 0, windowPossiblyTruncated: true,
        note: 'GraphQL 翻页超过硬上限仍未确认取全窗口内的全部 merged PR,本轮不推进游标',
      });
      return 0;
    }
    merged = pages.map((p) => ({
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

  const nextCursor = decideCursorAfterRemediation({ results, audited: state.audited, cursor: state.cursor, now });
  if (!DRY_RUN) await saveAuditState(STATE_DIR, { ...state, cursor: nextCursor });
  print({
    ok: true, dryRun: DRY_RUN, windowFrom: state.cursor, windowTo: now, nextCursor,
    cursorHeldBack: nextCursor !== now, audited: results, alertsSent,
  });
  return 0;
}

// 与 reconcile-merged 同款直跑守卫:被 import(测试)时不执行主流程。
// argv[1] 先 realpath 再比较:生产经 ~/.claude/skills/review-pr 软链调用时,argv[1] 是
// 软链路径而 import.meta.url 是真实路径,严格相等会导致 main() 静默 no-op(evo 台账
// symlink-argv1-import-meta-url-mismatch-silent-noop,2026-08-19 实跑发现审计闸从未运行)。
const isDirectRun = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().then((c) => process.exit(c ?? 0)).catch((e) => { fail(`audit-merged-loop-prs 出错: ${e.message}`); });
}
