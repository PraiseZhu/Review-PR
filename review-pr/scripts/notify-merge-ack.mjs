#!/usr/bin/env node
// notify-merge-ack.mjs — review-pr 合并成功后向自定义通道发致谢播报(SKILL 3A 合并章节最后一步)
// 播报文案固定为 SKILL.md「对外话术与人格边界」模板 E(群内公开,人格淡),本脚本直接
// 拼好 title/text,不留给 agent 现场编。
//
// 背景:部分接入仓库有自己的自动修 bug loop(如 mivo-canvas 的原 bug-doctor loop),那类 PR
// 合并后 loop 自己会播报,review-pr 不该重复发。本脚本通过 pr-rules.json 的
// loopPrExclusion.mergeAckNotify.notifyModule 配置指向目标仓库自己的播报模块(相对
// REPO_ROOT 的路径,模块需导出 loadNotifyConfig(stateDir) 与
// async sendAlert({ stateDir, config, title, text }) → { channel, desktopNotified }),不
// 硬编码任何具体仓库的相对路径——notifyModule 未配置时整套播报能力 no-op(posted:false),
// 这是本脚本与 loop 托管排除机制一样「配置缺失=功能关闭」的地方。
//
// 仅对 review-pr 自己合并的、非 loop 托管的 PR 发(loop 托管的 PR 有自己的播报,判定复用
// lib.mjs 的 detectLoopExclusion,与 context.mjs 同一份逻辑,不会漂移)。
//
// 幂等:去重指纹 = PR 号 + mergeCommit oid,**只在真走通 webhook 通道时才写**(降级路径
// 落 pending-alerts.md/桌面通知不算"送达",不写去重指纹,留给下次重跑重试真送达)。
//
// 失败不阻断:任何异常(含 import lib.mjs / notifyModule 失败、pr-rules.json 解析失败、
// 路径计算失败)都不 throw、退出码恒 0——播报失败绝不能拖累合并流程本身。为此**连本脚本
// 自己的共享底座 `./lib.mjs` 也不在顶层静态 import**——静态 import 是 ES module 装载期动作,
// 若 `lib.mjs` 缺失或有语法错误,装载会在进入任何 try/catch 之前就直接让进程以非 0 退出,
// `fail()`/`print()` 都还没定义,谈不上"退出码恒 0"的承诺。所有可能抛错的 import(含
// `./lib.mjs` 自己与动态引入的 notifyModule)/ 配置读取 / 路径解析全部收进最外层 try,顶层
// 只留零风险的 node 内置模块 import + 两个不依赖 lib.mjs 的本地小工具函数;catch 兜底输出
// 也只用 `process.stdout.write` 直接拼 JSON,不反过来依赖 `lib.mjs` 的 `print`——否则
// `lib.mjs` 装载失败时,catch 块想用它的 `print` 报错本身又会再抛一次,绕回同一个坑。
//
// 跑:node <skill-root>/scripts/notify-merge-ack.mjs <PR> [--summary "<一句话改动摘要>"] [--details "<多行要点>"] [--dry-run]
//   --summary:一句话改动摘要(3A 已经有现成的合并评论文案,直接摘一句传进来;省略则退化成只用标题)。
//   --details:改动要点(3-5 行,每行一条,面向来审阅的人)。仅当 notifyModule 走的是能拿到
//     消息 ts 的通道(channel:'api',Slack Web API)且导出了 sendThreadReply 时,才作为主消息的
//     thread 回复发出——incoming webhook 拿不到 ts,物理上无法 thread,此时 details 静默不发
//     (不拼进主消息,避免频道刷屏;threadReason 字段会说明原因)。
//   --dry-run:只打印将发的消息与判定,不真调 sendAlert、不写去重指纹(供调试 / 自测,
//     即使 webhook 已配置也不会真的发出去)。

import { readFileSync, writeFileSync } from 'node:fs';

/** 顶层零依赖兜底:不管 `lib.mjs` 是否能装载,永远能把结果吐到 stdout、退出码恒 0。 */
function printFallback(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function readDedupState(dedupFile) {
  try {
    return JSON.parse(readFileSync(dedupFile, 'utf8')) || {};
  } catch {
    return {}; // 文件不存在 / 损坏都按空状态起步
  }
}

function writeDedupState(dedupFile, state) {
  try {
    writeFileSync(dedupFile, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* best-effort:写失败最多下次重复播报一次,不影响主流程 */
  }
}

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}

try {
  // lib.mjs 也走动态 import(见文件头说明)——它缺失 / 语法错误时应落进本 try 的 catch,
  // 不该在模块装载期就让整个进程以非 0 退出。
  const { parseRepo, parsePR, ghJson, print, detectLoopExclusion, resolveInRepoRoot, loadRules } = await import('./lib.mjs');

  const prRules = loadRules();
  const LOOP_RULES = prRules.loopPrExclusion ?? null;
  const MERGE_ACK = LOOP_RULES?.mergeAckNotify ?? {};

  // notifyModule 未配置(目标仓库没有自己的播报模块,或压根没配 loopPrExclusion)
  // = 整套播报能力关闭,不尝试任何 sendAlert。
  if (!MERGE_ACK.notifyModule) {
    print({ ok: true, posted: false, reason: 'notify-module-not-configured' });
    process.exit(0);
  }

  const DEDUP_FILE = resolveInRepoRoot(MERGE_ACK.dedupFile ?? 'scripts/review-pr/.merge-notified.json');
  const NOTIFY_STATE_DIR = resolveInRepoRoot(MERGE_ACK.stateDir ?? 'history/loops/state');

  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');
  const summary = argAfter('--summary');
  const details = argAfter('--details');

  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'title,body,author,url,state,mergedAt,mergeCommit',
  ]);

  if (!meta.mergedAt) {
    print({ ok: true, pr, posted: false, reason: 'pr-not-merged', state: meta.state });
    process.exit(0);
  }

  // ── loop 托管的 PR 有自己的播报,review-pr 不重复发 ──
  const loopExclusion = detectLoopExclusion({ title: meta.title ?? '', body: meta.body ?? '', pr, rules: LOOP_RULES });
  if (loopExclusion) {
    print({ ok: true, pr, posted: false, reason: 'loop-managed-has-own-broadcast', loopExclusion });
    process.exit(0);
  }

  const author = meta.author?.login ?? '';
  const mergeCommitOid = meta.mergeCommit?.oid ?? '';
  const fingerprint = `${pr}:${mergeCommitOid}`;

  const state = readDedupState(DEDUP_FILE);
  if (state[String(pr)] === fingerprint) {
    print({ ok: true, pr, posted: false, reason: 'already-notified', fingerprint });
    process.exit(0);
  }

  // 措辞固定为 SKILL.md「对外话术与人格边界」模板 E(群内公开,人格淡,状态用文字不用
  // 状态图标,表情按配额 0-1 个放句尾),不由 agent 现场改写。
  const title = `PR #${pr} 合了 —— 感谢 @${author}。`;
  const text = `${summary || meta.title || ''} 😌\n${meta.url ?? ''}`;

  if (dryRun) {
    print({ ok: true, pr, posted: false, reason: 'dry-run', title, text, details: details || null, notifyStateDir: NOTIFY_STATE_DIR, notifyModule: MERGE_ACK.notifyModule });
    process.exit(0);
  }

  // 动态 import(而非顶层 import):notifyModule 装载失败(路径配错 / 语法错误)只应让本脚本
  // 走 catch 降级,不该让整个 review-pr 播报能力在模块装载阶段直接崩掉。resolveInRepoRoot
  // 已做过 containment 校验,这里拿到的是确认落在 REPO_ROOT 内的绝对路径。
  const notifyModulePath = resolveInRepoRoot(MERGE_ACK.notifyModule);
  const { loadNotifyConfig, sendAlert, sendThreadReply } = await import(`file://${notifyModulePath}`);
  const config = loadNotifyConfig(NOTIFY_STATE_DIR);
  const result = await sendAlert({ stateDir: NOTIFY_STATE_DIR, config, title, text });

  // posted 必须真实反映"是否真送达远端通道"——'api'(Slack Web API,能拿 ts)与
  // 'webhook'(incoming webhook)都算送达;'degraded'(已落 pending-alerts.md + 尽力
  // 桌面通知)不算,不能报 posted:true,也不能写去重指纹(否则下次重跑会误判"已发过"
  // 而永久跳过重试)。
  const posted = result.channel === 'api' || result.channel === 'webhook';
  if (posted) {
    state[String(pr)] = fingerprint;
    writeDedupState(DEDUP_FILE, state);
  }

  // ── thread 回复:改动要点跟在致谢主消息下,供人快速审阅(形态对齐 cindy 频道惯例)──
  // 仅 'api' 通道可行(webhook 拿不到 ts);notifyModule 是老版本没导出 sendThreadReply
  // 时同样静默跳过。thread 失败不回滚主消息去重——主致谢已送达,细节丢了不值得重发致谢。
  let threadPosted = false;
  let threadReason = null;
  if (posted && details) {
    if (result.channel === 'api' && result.ts && typeof sendThreadReply === 'function') {
      const tr = await sendThreadReply({ config, ts: result.ts, text: details });
      threadPosted = !!tr?.ok;
      if (!threadPosted) threadReason = tr?.reason ?? 'unknown';
    } else {
      threadReason = result.channel !== 'api'
        ? 'webhook-cannot-thread(需 SLACK_BOT_TOKEN+SLACK_CHANNEL_ID 走 api 通道)'
        : (typeof sendThreadReply !== 'function' ? 'notify-module-has-no-sendThreadReply' : 'no-ts');
    }
  }

  print({
    ok: true,
    pr,
    posted,
    channel: result.channel,
    desktopNotified: result.desktopNotified,
    ...(details ? { threadPosted, ...(threadReason ? { threadReason } : {}) } : {}),
    ...(posted ? { fingerprint } : {}),
  });
} catch (e) {
  // 播报失败绝不阻断合并流程本身:如实报告但退出码仍是 0(与文件头「退出码恒 0」的
  // 承诺一致;不像其余 review-pr 脚本那样对未知异常走 fail() 退出 1)。**不用 `lib.mjs`
  // 的 `print`**——本 catch 兜的正是"`lib.mjs` 本身装载失败"这一种异常,若这里还依赖
  // 它的 `print`,`print` 从 `import()` 失败起就是 undefined,这行自己会再抛一次,
  // 绕回同一个坑,所以只用顶层定义的零依赖 `printFallback`。
  printFallback({ ok: true, posted: false, reason: 'notify-error', error: String(e?.message ?? e) });
}
