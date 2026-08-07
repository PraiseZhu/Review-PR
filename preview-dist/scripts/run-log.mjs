#!/usr/bin/env node
// run-log.mjs — 把一轮 review 的机器可读汇总 JSON 落盘到外部状态目录(stdin 传入)。
//
// 动机:汇总 JSON 是给日志与下游脚本消费的,**绝不能出现在会话末尾文本里**——
// scheduler 的桌面/飞书通知会直接转发会话末尾内容,末尾是 JSON 用户就会在飞书
// 收到一坨 JSON(历史事故根因)。落盘后,主 agent 的最终消息只输出人类可读摘要。
//
// 写两处(均在按目标仓库隔离的外部状态目录,默认位置见 `lib.mjs` 的
// `resolvePersistentStateRoot()`):
//   - last-run.json :最新一轮,整份覆盖(下游脚本取最新结果用);
//   - runs.jsonl    :历史逐行追加,每行 { loggedAt, sinceLastRunHours,
//     sinceLastRunReason, ...汇总 }(审计/趋势用)。
//
// sinceLastRunHours(SC2-3):每次写入自动算出"距上一轮多久"——从 runs.jsonl 尾部
// 向前找最近一条含合法 loggedAt 的行,与本轮相减,首轮(文件不存在/为空)为 null。
// 这不是调度层的失败探测(调度失败在 agent 启动前就发生,本脚本拿不到那层信号),
// 只是让"轮次间隔异常拉长"这一可观测信号浮出水面,交给 SKILL.md 6.1 的摘要模板
// 判断是否要提示"可能有调度缺口"。sinceLastRunReason 区分三种情况(F6):
// 'ok'(正常算出)/'first-run'(真首轮,文件不存在或为空)/'history-corrupted'
// (文件有内容但一行都解不出合法 loggedAt)——"首轮"与"历史损坏"是完全不同的
// 运维含义,不能都塞进同一个 null 里让人猜。
//
// 结构校验(F5):对顶层 JSON、processed[]、draftSkipped[] 逐层做类型守卫,任何
// 形态不对都只 append warning、照常落盘——绝不因为形态问题 throw、绝不因此
// exit 1(那等于把这一轮的真实记录直接丢掉,比记一条形态不对的历史更糟)。
// 唯一仍会 exit 1 的路径是 stdin 本身不是合法 JSON,或落盘时真的写盘失败
// (磁盘满/权限等),这两类与"形态校验"是不同性质的失败,不受本次改动影响。
//
// 保留字覆盖(F7):落盘记录用 `{ ...data, loggedAt, sinceLastRunHours,
// sinceLastRunReason }`——系统字段放在 spread 之后,调用方在汇总 JSON 里伪造
// 同名字段(如手写一个假的 loggedAt 想搪塞过去)一律被真实值覆盖,不生效。
//
// 跑:node <skill-root>/scripts/run-log.mjs   # JSON 走 stdin(pipe 或 --body-file 风格)

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { stateFile, print, fail } from './lib.mjs';

// processed[].event 的合法取值——实际提交给 GitHub 的 review 事件,与 action(业务分类,
// 如 merged/changes-requested/held/conflict-merged)是两个不同口径,不可混用
// (SKILL.md 6.1 有完整映射表)。
const EVENT_VALUES = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'none']);

/** 非数组一律折叠成空数组——供后续 for...of / forEach 安全遍历,绝不因为形态不对抛错。 */
function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * 只读形态校验,返回 warning 字符串数组(可能为空)。绝不修改 data、绝不抛错
 * (F5):data 本身可能是 null / 数组 / 字符串 / 数字(stdin 是合法 JSON 但顶层
 * 不是对象时 JSON.parse 不会报错),下面每一步都先用 typeof/Array.isArray/
 * 可选链守住,不假设任何字段存在或是期望的类型。
 */
function validateShape(data) {
  const warnings = [];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    warnings.push(
      `汇总 JSON 顶层应为对象,收到 ${Array.isArray(data) ? 'array' : typeof data}` +
      `——按空汇总处理落盘,不代表本轮真的没有任何候选,请检查上游是否传错了 body`,
    );
    return warnings; // 顶层都不是对象,再往下逐字段检查没有意义
  }

  if (data.processed !== undefined && !Array.isArray(data.processed)) {
    warnings.push(`processed 应为数组,收到 ${typeof data.processed}(${JSON.stringify(data.processed)})`);
  }
  for (const item of safeArray(data.processed)) {
    if (!EVENT_VALUES.has(item?.event)) {
      warnings.push(
        `processed pr=${item?.pr ?? '?'} 的 event 字段缺失或非法(收到 ${JSON.stringify(item?.event)}),` +
        '应为 APPROVE/REQUEST_CHANGES/COMMENT/none 之一',
      );
    }
  }

  if (data.draftSkipped === undefined) {
    // R6:字段整体缺失此前零告警——SKILL.md 6.1 要求"必须展开成逐 PR 记录,不能整条
    // 省略",代码要和文档口径对齐:没有任何被跳过的 draft PR 也要显式写空数组 []，
    // 完全不写这个字段无法区分"这轮真的没有"与"agent 忘了填"。
    warnings.push(
      'draftSkipped 字段整体缺失——若本轮确实没有被跳过的 draft PR 请显式写空数组 []，' +
      '不要整条省略该字段',
    );
  } else if (!Array.isArray(data.draftSkipped)) {
    warnings.push(
      `draftSkipped 应为 [{pr,reason,url}] 数组,收到 ${typeof data.draftSkipped}` +
      `(${JSON.stringify(data.draftSkipped)})——落一个数字/其它形态无法追溯是哪些 PR、为什么被跳过`,
    );
  }
  safeArray(data.draftSkipped).forEach((d, i) => {
    for (const field of ['pr', 'reason', 'url']) {
      const v = d?.[field];
      if (v === undefined || v === null || v === '') {
        warnings.push(`draftSkipped[${i}] 缺少 ${field} 字段: ${JSON.stringify(d)}`);
      }
    }
  });

  return warnings;
}

/**
 * 判定某个 loggedAt 候选值是否合法(R8①,2026-08-01 二审)。旧版只检查
 * `Number.isFinite(new Date(v).getTime())`——`new Date(null)`/`new Date(false)`
 * 都会被 JS 当数字 0 处理,等价于 epoch(1970-01-01),`getTime()` 返回 0,
 * `Number.isFinite(0)` 为真,于是一行 `{"loggedAt": null, ...}` 的坏行会被
 * 误判成"合法的 1970 年记录",算出一个荒谬的 56 年"距上一轮"间隔而不是被
 * 正确识别为损坏行跳过。现在先确认类型是非空字符串,再交给 `Date` 解析。
 */
function isValidLoggedAt(v) {
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(new Date(v).getTime());
}

/**
 * 从 runs.jsonl 尾部向前找最近一条含合法 loggedAt 的行,与本轮 loggedAt 相减
 * 得到小时数(F6 修订)。旧版只看最后一行——如果恰好最后一行是被截断/手工
 * 改坏的半行 JSON,会把整段真实历史直接判成"首轮"(sinceLastRunHours=null),
 * 悄悄吞掉调度缺口信号。现在向前找到第一条能解出 loggedAt 的行为止;跳过的坏
 * 行数计入 skippedLines(由调用方转成 warning);"文件不存在/为空"(真首轮)与
 * "有内容但一行都解不出"(历史损坏)在 reason 里明确区分,不再都塞进同一个
 * null 里让人猜。
 * 返回 { hours: number|null, reason: 'ok'|'first-run'|'history-corrupted', skippedLines: number }。
 */
function computeSinceLastRun(runsFile, loggedAt) {
  if (!existsSync(runsFile)) return { hours: null, reason: 'first-run', skippedLines: 0 };
  let lines;
  try {
    lines = readFileSync(runsFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return { hours: null, reason: 'history-corrupted', skippedLines: 0 };
  }
  if (!lines.length) return { hours: null, reason: 'first-run', skippedLines: 0 };

  const curMs = new Date(loggedAt).getTime();
  let skippedLines = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let candidate;
    try {
      candidate = JSON.parse(lines[i])?.loggedAt;
    } catch {
      candidate = undefined;
    }
    if (isValidLoggedAt(candidate)) {
      const prevMs = new Date(candidate).getTime();
      if (!Number.isFinite(curMs)) return { hours: null, reason: 'history-corrupted', skippedLines };
      return { hours: Math.round(((curMs - prevMs) / 3_600_000) * 100) / 100, reason: 'ok', skippedLines };
    }
    skippedLines++;
  }
  return { hours: null, reason: 'history-corrupted', skippedLines }; // 全部行都解不出合法 loggedAt
}

try {
  const raw = readFileSync(0, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('stdin 不是合法 JSON——请把 6.1 的汇总 JSON 原样 pipe 进来,不要带 markdown 围栏');
  }

  const warnings = validateShape(data);

  const lastRunFile = stateFile('last-run.json');
  const runsFile = stateFile('runs.jsonl');
  const loggedAt = new Date().toISOString();
  const { hours: sinceLastRunHours, reason: sinceLastRunReason, skippedLines } = computeSinceLastRun(runsFile, loggedAt);
  if (skippedLines > 0) {
    warnings.push(
      `runs.jsonl 尾部有 ${skippedLines} 行解不出合法 loggedAt(已跳过继续向前找);` +
      `sinceLastRunReason=${sinceLastRunReason}`,
    );
  }

  // F7:系统字段放在 spread 之后——调用方在汇总 JSON 里伪造同名字段一律被真实值覆盖。
  const record = { ...data, loggedAt, sinceLastRunHours, sinceLastRunReason };

  writeFileSync(lastRunFile, JSON.stringify(record, null, 2));
  appendFileSync(runsFile, JSON.stringify(record) + '\n');

  if (warnings.length) {
    process.stderr.write(`[review-pr] run-log 形态警告(已落盘,未阻断):\n${warnings.map((w) => `  - ${w}`).join('\n')}\n`);
  }

  print({
    ok: true,
    loggedAt,
    sinceLastRunHours,
    sinceLastRunReason,
    lastRunFile,
    runsFile,
    warnings,
    note: '汇总 JSON 已落盘;会话最终消息只发人类可读摘要,不要再输出这份 JSON。' +
      'sinceLastRunHours 超过 2 时,6.1 摘要的“其他”行需补一句调度缺口提示(见 SKILL.md 6.1)。',
  });
} catch (e) {
  fail(e);
}
