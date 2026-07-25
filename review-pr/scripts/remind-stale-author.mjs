#!/usr/bin/env node
// remind-stale-author.mjs — 「停滞催办私聊」的确定性判定:某 PR 卡在作者侧(被打回没改 /
// 评审意见没 resolve / 与主干冲突)且作者已停滞 ≥ idleHours 没有任何动作时,输出
// shouldRemind=true,提示主 agent 去私聊提醒作者(身份映射走 resolve-author-feishu.mjs,
// 实际发送由主 agent 经配置的播报出口完成;本脚本只做判定 + 去重,不拼文案、不发任何
// 消息)。发送时的措辞固定为 SKILL.md「对外话术与人格边界」模板 B,不由 agent 现场编。
//
// 为什么单独成脚本(与 notify-author-resolve.mjs 同理):
//   - 「停滞多久 / 该不该再提醒」是纯时间与状态运算,必须代码判定,不能让 LLM 凭感觉;
//   - 去重状态(上次提醒时间)持久化在本地,与判定原子绑定,主 agent 只消费布尔结果。
//
// 判定模型:
//   卡作者侧(kinds,可并存):
//     - changes-requested : reviewDecision=CHANGES_REQUESTED(被打回还没改)
//     - unresolved-threads: 存在未 resolve 的 review thread
//     - conflict          : mergeable=CONFLICTING(和主干冲突,要作者更新分支)
//   作者侧时间锚点 anchor = max(最近一次"要作者动"的事件时间, 作者最近一次动作时间):
//     - "要作者动"的事件:最新 CHANGES_REQUESTED review 的 submittedAt、
//       未 resolve thread 里最新的非作者评论时间(conflict 没有事件时间,不参与锚点)
//     - 作者动作:作者的 PR 评论 / thread 回复、PR 最新 commit 时间(谁 push 都算——
//       有人在推进就不该催)
//   停滞 = now - anchor ≥ idleHours(默认 24h);同一 PR 两次提醒间隔 ≥ repeatHours(默认 24h)。
//   阈值配置:Skill config/pr-rules.json 的 staleAuthorReminder(缺省用默认值)。
//
// 去重状态位于外部状态目录的 remind-feishu.json：
// { "<pr>": { remindedAt, fingerprint } }。
//   - shouldRemind=true 输出的同时即记状态(锚定"判定"而非"发送":发送失败不立刻重试,
//     repeatHours 后仍停滞会再次 shouldRemind=true,天然兜底重试);
//   - PR 不再卡作者侧 → 清掉该 PR 状态(下次再卡重新计)。
//
// 豁免:PR 非 open / draft / 作者就是当前 gh 登录者(own-pr,不用给自己发)。
//
// 退出码恒 0(脚本自身异常才 1),结果全在 JSON 字段,auto 轮转不因单 PR 失败中断。
//
// 跑:node <skill-root>/scripts/remind-stale-author.mjs <PR...> [--dry-run]
//   --dry-run:照常判定输出,但不写去重状态(供调试 / 自测)。
//   多个 PR 号:批量模式,逐个 spawn 自身聚合输出 { batch:true, results:[…] }——
//   核心判定 / 去重逻辑零改动(就是跑单 PR 模式),单 PR 输出保持原样完全兼容。
//   批量**必须串行**(mapPool 并发 1):共享 remind-feishu.json 去重状态,并发会读写竞态。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRepo, parsePR, gh, ghGraphql, print, fail, spawnScriptJson, mapPool, loadRules, stateFile } from './lib.mjs';

// ── 批量驱动(见文件头)──
{
  const prArgs = process.argv.slice(2).filter((a) => /^#?\d+$/.test(a));
  if (prArgs.length > 1) {
    const flags = process.argv.slice(2).filter((a) => !/^#?\d+$/.test(a)); // --dry-run 等原样透传
    const SELF = fileURLToPath(import.meta.url);
    const results = await mapPool(prArgs, 1, (p) => spawnScriptJson(SELF, [p, ...flags]));
    print({ ok: true, batch: true, count: results.length, results });
    process.exit(0);
  }
}

const STATE_FILE = stateFile('remind-feishu.json');
const prRules = loadRules();
const IDLE_HOURS = Number(prRules.staleAuthorReminder?.idleHours) || 24;
const REPEAT_HOURS = Number(prRules.staleAuthorReminder?.repeatHours) || 24;
// 核心贡献者豁免:命中则直接跳过停滞催办(大小写不敏感)。配置缺失(exemptAuthors 为空)
// = 无豁免,行为与此前完全一致。
const EXEMPT_AUTHORS = (prRules.staleAuthorReminder?.exemptAuthors ?? []).map((s) => s.toLowerCase());

// 一次拉全判定所需字段:作者 / 状态 / 冲突 / reviewDecision / reviews / threads / 评论 / 最新 commit
const GQL = `
  query($owner:String!,$repo:String!,$num:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        author{ login }
        title url state isDraft mergeable reviewDecision
        reviews(last:50){ nodes{ state submittedAt author{ login } } }
        reviewThreads(first:100){ nodes{ isResolved comments(first:100){ nodes{ author{ login } createdAt } } } }
        comments(last:100){ nodes{ author{ login } createdAt } }
        commits(last:1){ nodes{ commit{ committedDate } } }
      }
    }
  }`;

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    return {}; // 文件不存在 / 损坏按空状态起步
  }
}

function writeState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* best-effort:写失败最多提前重复提醒一次,不影响主流程 */
  }
}

const ts = (iso) => (iso ? Date.parse(iso) || 0 : 0);
const maxTs = (arr) => arr.reduce((m, v) => Math.max(m, v), 0);

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const prKey = String(pr);
  const dryRun = process.argv.includes('--dry-run');

  const data = ghGraphql(GQL, { owner, repo, num: pr })?.data?.repository?.pullRequest;
  if (!data) throw new Error(`拉 PR #${pr} 数据失败(GraphQL 空返回)`);

  const author = data.author?.login ?? '';
  const state = readState();
  const done = (obj) => {
    print({
      ok: true, pr, author, title: data.title ?? '', url: data.url ?? '',
      thresholdHours: IDLE_HOURS, repeatHours: REPEAT_HOURS,
      ...obj,
    });
  };
  const clearAndDone = (reason) => {
    if (state[prKey] !== undefined && !dryRun) {
      delete state[prKey];
      writeState(state);
    }
    done({ shouldRemind: false, reason });
  };

  // ── 豁免:核心贡献者(exemptAuthors,大小写不敏感)──
  if (author && EXEMPT_AUTHORS.includes(author.toLowerCase())) {
    clearAndDone('exempt-author');
    process.exit(0);
  }

  // ── 豁免:非 open / draft ──
  if (data.state !== 'OPEN') { clearAndDone('pr-not-open'); process.exit(0); }
  if (data.isDraft) { clearAndDone('draft'); process.exit(0); }

  // ── 卡作者侧判定(kinds 可并存)──
  const kinds = [];
  const askTimes = []; // "要作者动"的事件时间

  if (data.reviewDecision === 'CHANGES_REQUESTED') {
    kinds.push('changes-requested');
    const crTimes = (data.reviews?.nodes ?? [])
      .filter((r) => r.state === 'CHANGES_REQUESTED')
      .map((r) => ts(r.submittedAt));
    askTimes.push(maxTs(crTimes));
  }

  const unresolved = (data.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved);
  if (unresolved.length > 0) {
    kinds.push('unresolved-threads');
    const nonAuthorTimes = unresolved.flatMap((t) =>
      (t.comments?.nodes ?? [])
        .filter((c) => c.author?.login && c.author.login !== author)
        .map((c) => ts(c.createdAt)),
    );
    askTimes.push(maxTs(nonAuthorTimes));
  }

  if (data.mergeable === 'CONFLICTING') kinds.push('conflict');

  if (kinds.length === 0) { clearAndDone('not-blocked-on-author'); process.exit(0); }

  // ── own-pr 豁免(kinds 命中才值得花这次 API 调用查 viewer)──
  const viewerRes = gh(['api', 'user', '--jq', '.login'], { allowFail: true });
  const viewer = viewerRes.ok ? viewerRes.stdout.trim() : '';
  if (viewer && author && viewer.toLowerCase() === author.toLowerCase()) {
    clearAndDone('own-pr');
    process.exit(0);
  }

  // ── 作者最近动作 ──
  const authorActivityTimes = [
    ...(data.comments?.nodes ?? [])
      .filter((c) => c.author?.login === author)
      .map((c) => ts(c.createdAt)),
    ...(data.reviewThreads?.nodes ?? []).flatMap((t) =>
      (t.comments?.nodes ?? [])
        .filter((c) => c.author?.login === author)
        .map((c) => ts(c.createdAt)),
    ),
    ts(data.commits?.nodes?.[0]?.commit?.committedDate),
  ];
  const lastAuthorActivity = maxTs(authorActivityTimes);
  const anchor = Math.max(maxTs(askTimes), lastAuthorActivity);

  const now = Date.now();
  const idleMs = anchor > 0 ? now - anchor : 0;
  const idleHours = Math.round((idleMs / 3600_000) * 10) / 10;
  const idleDays = Math.round((idleMs / 86400_000) * 10) / 10;
  const common = {
    kinds,
    unresolvedCount: unresolved.length,
    blockedSince: maxTs(askTimes) ? new Date(maxTs(askTimes)).toISOString() : null,
    lastAuthorActivityAt: lastAuthorActivity ? new Date(lastAuthorActivity).toISOString() : null,
    idleHours, idleDays,
  };

  if (anchor === 0 || idleMs < IDLE_HOURS * 3600_000) {
    // 还没到停滞阈值:不清状态(同一停滞的 remindedAt 要留着算 repeat 间隔)
    done({ shouldRemind: false, reason: 'not-stale-yet', ...common });
    process.exit(0);
  }

  // ── 停滞成立,查去重 ──
  const prev = state[prKey];
  if (prev?.remindedAt && now - ts(prev.remindedAt) < REPEAT_HOURS * 3600_000) {
    done({ shouldRemind: false, reason: 'recently-reminded', remindedAt: prev.remindedAt, ...common });
    process.exit(0);
  }

  const fingerprint = `${kinds.slice().sort().join('+')}|${common.blockedSince ?? '-'}|${common.lastAuthorActivityAt ?? '-'}`;
  if (!dryRun) {
    state[prKey] = { remindedAt: new Date(now).toISOString(), fingerprint };
    writeState(state);
  }
  done({ shouldRemind: true, reason: dryRun ? 'dry-run' : 'stale', fingerprint, ...common });
} catch (e) {
  fail(e);
}
