#!/usr/bin/env node
// notify-summary.mjs — auto 模式收尾时把 6.1 owner 每轮汇总经目标仓库配置的会话层
// 播报出口主动推送(SKILL 6.1「auto 模式必须把完整摘要主动推送给 owner 本人」)。
//
// 与 notify-merge-ack.mjs 的区别:notify-merge-ack.mjs 走
// loopPrExclusion.mergeAckNotify.notifyModule 配置,该模块必须是可 import 的 ES module
// (导出 loadNotifyConfig/sendAlert)。owner 每轮汇总的播报走**独立**的顶层配置
// `summaryBroadcast.command`——不挂在 loopPrExclusion 底下,因为汇总播报与「是否有
// loop 托管排除」无关;且部分目标仓库的会话层播报出口本身就是一个 CLI 脚本(契约
// `<正文> | node <script> --title "<标题>"`,见 mivo-canvas 的
// scripts/loops/bug-doctor/broadcast.mjs),不是可 import 的模块,所以这里用子进程
// 调用而非动态 import。
//
// summaryBroadcast.command 未配置 = 播报能力关闭(posted:false),回退到 SKILL 6.1
// 现状:会话末尾人类可读摘要靠 scheduler 通知转发,不额外主动推送。
//
// 退出码恒 0,从不抛出:播报失败绝不能拖累 auto 收尾本身。为此连本脚本自己的共享
// 底座 `./lib.mjs` 也不在顶层静态 import(同 notify-merge-ack.mjs 的理由:静态 import
// 是装载期动作,`lib.mjs` 缺失/语法错误会在进入任何 try/catch 之前就让进程以非 0 退出)。
//
// 跑:<正文 markdown> | node <skill-root>/scripts/notify-summary.mjs --title "<标题>" [--dry-run]
//   --title:必填,播报标题行(6.1 摘要首行,如 "PR Review 汇总(auto · 2026-07-26 10:00 · 共 3 个候选)")。
//   正文:从 stdin 读取,原样投递给 summaryBroadcast.command 指向的脚本。
//   --dry-run:只打印将发的标题/正文与判定,不真的 spawn 播报命令。

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** 顶层零依赖兜底:不管 `lib.mjs` 是否能装载,永远能把结果吐到 stdout、退出码恒 0。 */
function printFallback(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}

try {
  // lib.mjs 也走动态 import(见文件头说明)——它缺失/语法错误时应落进本 try 的 catch,
  // 不该在模块装载期就让整个进程以非 0 退出。
  const { print, loadRules, resolveInRepoRoot } = await import('./lib.mjs');

  const title = argAfter('--title');
  if (!title) {
    print({ ok: false, posted: false, reason: 'missing-title' });
    process.exit(0);
  }

  let text = '';
  if (!process.stdin.isTTY) {
    try {
      text = readFileSync(0, 'utf8').trim();
    } catch {
      /* stdin 不可读(极少见)—— 允许空正文,仍照常投递标题 */
    }
  }

  const dryRun = process.argv.includes('--dry-run');
  const prRules = loadRules();
  const command = prRules.summaryBroadcast?.command;

  // command 未配置(目标仓库没有自己的会话层播报脚本,或压根没配 summaryBroadcast)
  // = 该门关闭,不尝试任何子进程调用。
  if (!command) {
    print({ ok: true, posted: false, reason: 'summary-broadcast-not-configured' });
    process.exit(0);
  }

  // resolveInRepoRoot 已做过 containment 校验(不允许跳出 REPO_ROOT)。
  const commandPath = resolveInRepoRoot(command);

  if (dryRun) {
    print({ ok: true, posted: false, reason: 'dry-run', title, text, command: commandPath });
    process.exit(0);
  }

  let raw;
  try {
    raw = execFileSync('node', [commandPath, '--title', title], {
      input: text,
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch (e) {
    // 子进程非 0 退出/超时:播报失败不阻断 auto 收尾,如实报告。
    print({ ok: true, posted: false, reason: 'command-failed', command: commandPath, error: String(e?.message ?? e) });
    process.exit(0);
  }

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    result = { channel: 'error', error: 'summaryBroadcast.command 输出不是合法 JSON' };
  }

  // posted 必须真实反映"是否走通 webhook"——降级路径(落 pending-alerts.md/尽力桌面
  // 通知)不算"发出去了",不能报 posted:true(与 notify-merge-ack.mjs 同一纪律)。
  const posted = result.channel === 'webhook';
  print({
    ok: true,
    posted,
    channel: result.channel,
    desktopNotified: result.desktopNotified,
    ...(result.error ? { error: result.error } : {}),
  });
} catch (e) {
  // 播报失败绝不能阻断 auto 收尾:如实报告但退出码仍是 0。不用 `lib.mjs` 的 `print`——
  // 本 catch 兜的正是"`lib.mjs` 本身装载失败"这一种异常,理由同 notify-merge-ack.mjs。
  printFallback({ ok: true, posted: false, reason: 'notify-error', error: String(e?.message ?? e) });
}
