#!/usr/bin/env node
// notify-merge-backfill.mjs — 扫描"已合并但没发过致谢播报"的 PR 并补发(auto 轮扫描阶段跑一次)
//
// 背景:notify-merge-ack.mjs 只挂在 review-pr **自己执行合并**的流程末尾。维护者在
// GitHub 网页上手动合并的 PR,agent 无从感知,不会有致谢——这是覆盖面缺口,不是 bug
// (实测 2026-07-30:合 23 个只播 4 条,漏的 19 个全是手动合并)。本脚本每轮 auto 补扫
// 一次:列出近期 merged PR,对比 notify-merge-ack 同一份去重台账,给没播过的补发同一
// 套模板 E 致谢。
//
// 与 notify-merge-ack.mjs 共享:
//   - 去重台账(mergeAckNotify.dedupFile,pr → "pr:mergeOid" 指纹)——两边互认,agent
//     合并的 ack 过就不补,补发过的 ack 也不会重发;
//   - notifyModule 出口与「配置缺失=功能关闭」语义(notifyModule 未配置即整体 no-op);
//   - loop 托管 PR 排除(detectLoopExclusion,那类 PR 有自己的播报);
//   - 「posted 只认真送达」:webhook/api 才写指纹,degraded 不写、下轮重试。
//
// 首轮基线播种(防陈年刷屏):台账里没有 __backfillSeededAt 标记时,本轮**只记账不播报**
// ——把扫描窗口内所有已合并 PR 直接写入台账并落下播种时间戳,之后的轮次才对新出现的
// 合并补发。没有这一步,功能上线第一轮会把过去三天的手动合并一口气全谢一遍。
//
// 措辞:与 notify-merge-ack 完全同一份模板 E,summary 取 PR 标题(补发场景没有 agent
// 审查结论可摘),details 从 PR 描述的「变更说明」段提取(人写的要点,仅 api 通道能
// thread 时发出;webhook 通道静默不发,与 ack 一致)。
//
// 韧性契约与 notify-merge-ack.mjs 相同:任何异常不 throw、退出码恒 0,连 lib.mjs 都走
// 动态 import(理由见 notify-merge-ack.mjs 文件头,此处不重复)。
//
// 跑:node <skill-root>/scripts/notify-merge-backfill.mjs [--dry-run]
//   --dry-run:只打印判定与将发内容,不发送、不写台账(含不做基线播种)。
//
// 可选配置(mergeAckNotify 下,均有默认值,不配即用默认):
//   backfillLookbackHours:扫描窗口,默认 72(覆盖 mini 巡审 3h 周期的几十倍冗余);
//   backfillMaxPerRun:单轮补发上限,默认 5(防手动批量合并时刷屏,超出的下轮继续)。

import { readFileSync, writeFileSync } from 'node:fs';

/** 顶层零依赖兜底:不管 lib.mjs 是否能装载,永远能把结果吐到 stdout、退出码恒 0。 */
function printFallback(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function readDedupState(dedupFile) {
  try {
    return JSON.parse(readFileSync(dedupFile, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeDedupState(dedupFile, state) {
  try {
    writeFileSync(dedupFile, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* best-effort:写失败最多下轮重复判定一次 */
  }
}

/**
 * 从 PR 描述提取要点作为 thread 内容(实测本仓 PR 段落名不统一:模板是「变更说明」,
 * 实际还有「改动说明」「用户能感知到什么」,也有不带标题的纯正文)。优先取说明类段落,
 * 都没有时兜底取正文首段;括号起头的流程备注行(如"(此 PR 在开发过程中…)")跳过。
 * 提不到返回 ''(调用侧对空 details 不发 thread)。
 */
function extractDetails(body) {
  if (!body) return '';
  const lines = String(body).split('\n');
  let start = lines.findIndex((l) => /^#{1,4}\s*(变更说明|改动说明|用户能感知到什么)/.test(l.trim()));
  let stopAtHeading = true;
  if (start < 0) {
    // 段名五花八门,穷举注定漏(实测本仓还有「背景」「症状与影响」「根因」「验证」等)。
    // 兜底取**第一个段落**的正文:那是作者自己写的开篇,对来审阅的人一样有信息量,
    // 比因为段名不认识就发一条没有要点的空致谢好。
    const firstHeading = lines.findIndex((l) => /^#{1,4}\s/.test(l.trim()));
    if (firstHeading >= 0) {
      start = firstHeading;
    } else {
      start = -1; // 纯正文:从头取首段
      stopAtHeading = false;
    }
  }
  const picked = [];
  let inCode = false;
  for (let i = start + 1; i < lines.length && picked.length < 4; i++) {
    const t = lines[i].trim();
    // 代码块整段丢弃:栈回溯 / 报错原文进 thread 只是噪音,看的人要的是「改了什么」。
    if (/^```/.test(t)) { inCode = !inCode; continue; }
    if (inCode) continue;
    if (stopAtHeading && /^#{1,4}\s/.test(t)) break; // 下一个标题,段落结束
    if (!t) {
      if (!stopAtHeading && picked.length) break; // 纯正文模式:首段取完即止
      continue;
    }
    if (/^[(（>|]/.test(t)) continue; // 流程备注 / 引用 / 表格行不进要点
    if (/^[-=|:\s]+$/.test(t)) continue; // 分隔线、表格分隔行
    // 列表符号只在「符号 + 空白」时才算,否则会把 **加粗** 的第一个星号当成列表符吃掉。
    const body = /^[-*+]\s+/.test(t) ? t.replace(/^[-*+]\s+/, '') : t;
    const clean = body.replace(/\*\*/g, '').trim(); // Slack 不认 ** 加粗,去掉避免露出符号
    if (!clean) continue;
    picked.push(`• ${clean.length > 140 ? `${clean.slice(0, 140)}…` : clean}`);
  }
  return picked.join('\n');
}

try {
  const { parseRepo, ghJson, print, detectLoopExclusion, resolveInRepoRoot, loadRules } = await import('./lib.mjs');

  const prRules = loadRules();
  const LOOP_RULES = prRules.loopPrExclusion ?? null;
  const MERGE_ACK = LOOP_RULES?.mergeAckNotify ?? {};

  if (!MERGE_ACK.notifyModule) {
    print({ ok: true, posted: [], reason: 'notify-module-not-configured' });
    process.exit(0);
  }

  // sender:"cloud" = 致谢由目标仓库的 CI 在合并事件里发,本地补发退场(否则重复致谢:
  // 云端不写本地台账,本地扫到同一批 merged PR 会再谢一遍)。见 notify-merge-ack.mjs 同处注释。
  if (MERGE_ACK.sender === 'cloud') {
    print({ ok: true, posted: [], reason: 'sender-is-cloud(合并致谢由目标仓库 CI 发,本地不补发)' });
    process.exit(0);
  }

  const DEDUP_FILE = resolveInRepoRoot(MERGE_ACK.dedupFile ?? 'scripts/review-pr/.merge-notified.json');
  const NOTIFY_STATE_DIR = resolveInRepoRoot(MERGE_ACK.stateDir ?? 'history/loops/state');
  const LOOKBACK_MS = (Number(MERGE_ACK.backfillLookbackHours) > 0 ? Number(MERGE_ACK.backfillLookbackHours) : 72) * 3600_000;
  const MAX_PER_RUN = Number(MERGE_ACK.backfillMaxPerRun) > 0 ? Number(MERGE_ACK.backfillMaxPerRun) : 5;

  const { owner, repo } = parseRepo();
  const slug = `${owner}/${repo}`;
  const dryRun = process.argv.includes('--dry-run');

  const merged = ghJson([
    'pr', 'list', '--repo', slug, '--state', 'merged', '--limit', '40',
    '--json', 'number,title,body,author,url,mergedAt,mergeCommit',
  ]);
  // 机器人作者不致谢:dependabot 这类 PR 占比不低,「感谢 @app/dependabot」纯噪音,
  // 而致谢的目的是对人表达 + 给人看改动要点。仍然记账(写去重指纹),避免每轮重新判定。
  const isBotAuthor = (a) => Boolean(a?.is_bot) || /\[bot\]$/.test(a?.login ?? '') || /^app\//.test(a?.login ?? '');
  const cutoff = Date.now() - LOOKBACK_MS;
  const inWindow = (Array.isArray(merged) ? merged : [])
    .filter((p) => p.mergedAt && Date.parse(p.mergedAt) >= cutoff)
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt)); // 旧的先谢,顺序符合直觉

  const state = readDedupState(DEDUP_FILE);

  // ── 首轮基线播种:只记账不播报 ──
  if (!state.__backfillSeededAt) {
    const seeded = [];
    for (const p of inWindow) {
      if (!state[String(p.number)]) {
        state[String(p.number)] = `${p.number}:${p.mergeCommit?.oid ?? ''}`;
        seeded.push(p.number);
      }
    }
    if (!dryRun) {
      state.__backfillSeededAt = new Date().toISOString();
      writeDedupState(DEDUP_FILE, state);
    }
    print({ ok: true, posted: [], reason: dryRun ? 'dry-run-would-seed' : 'baseline-seeded', seeded });
    process.exit(0);
  }

  const posted = [];
  const skipped = [];
  let sent = 0;

  for (const p of inWindow) {
    const pr = p.number;
    if (state[String(pr)]) continue; // 已播报过(ack 或往轮补发),台账有账即跳过,不重谢
    if (isBotAuthor(p.author)) {
      // 记账后跳过:下轮不再重复判定这条(不发,但也不反复扫)。
      state[String(pr)] = `${pr}:${p.mergeCommit?.oid ?? ''}`;
      if (!dryRun) writeDedupState(DEDUP_FILE, state);
      skipped.push({ pr, reason: 'bot-author-no-thanks', author: p.author?.login });
      continue;
    }
    const loopExclusion = detectLoopExclusion({ title: p.title ?? '', body: p.body ?? '', pr, rules: LOOP_RULES });
    if (loopExclusion) {
      skipped.push({ pr, reason: 'loop-managed-has-own-broadcast' });
      continue;
    }
    if (sent >= MAX_PER_RUN) {
      skipped.push({ pr, reason: 'max-per-run-reached(下轮继续)' });
      continue;
    }

    const author = p.author?.login ?? '';
    const fingerprint = `${pr}:${p.mergeCommit?.oid ?? ''}`;
    const title = `PR #${pr} 合了 —— 感谢 @${author}。`;
    const text = `${p.title ?? ''} 😌\n${p.url ?? ''}`;
    const details = extractDetails(p.body);

    if (dryRun) {
      posted.push({ pr, dryRun: true, title, text, details: details || null });
      sent++;
      continue;
    }

    // 每个候选独立 try:单个 PR 播报失败不拖累同轮其余候选。
    try {
      const notifyModulePath = resolveInRepoRoot(MERGE_ACK.notifyModule);
      const { loadNotifyConfig, sendAlert, sendThreadReply } = await import(`file://${notifyModulePath}`);
      const config = loadNotifyConfig(NOTIFY_STATE_DIR);
      const result = await sendAlert({ stateDir: NOTIFY_STATE_DIR, config, title, text });
      const delivered = result.channel === 'api' || result.channel === 'webhook';
      if (delivered) {
        state[String(pr)] = fingerprint;
        writeDedupState(DEDUP_FILE, state);
        sent++;
        let threadPosted = false;
        if (details && result.channel === 'api' && result.ts && typeof sendThreadReply === 'function') {
          const tr = await sendThreadReply({ config, ts: result.ts, text: details });
          threadPosted = !!tr?.ok;
        }
        posted.push({ pr, channel: result.channel, ...(details ? { threadPosted } : {}) });
      } else {
        skipped.push({ pr, reason: `not-delivered(channel=${result.channel ?? 'none'})` });
      }
    } catch (e) {
      skipped.push({ pr, reason: `notify-error: ${String(e?.message ?? e)}` });
    }
  }

  print({ ok: true, scanned: inWindow.length, posted, skipped });
} catch (e) {
  printFallback({ ok: true, posted: [], reason: 'backfill-error', error: String(e?.message ?? e) });
}
