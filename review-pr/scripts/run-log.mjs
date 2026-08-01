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
//   - runs.jsonl    :历史逐行追加,每行 { loggedAt, sinceLastRunHours, ...汇总 }
//     (审计/趋势用)。
//
// sinceLastRunHours(SC2-3):每次写入自动算出"距上一轮多久"——读 runs.jsonl 最后
// 一行的 loggedAt 与本轮相减,首轮(文件不存在/为空/解不出时间)为 null。这不是
// 调度层的失败探测(调度失败在 agent 启动前就发生,本脚本拿不到那层信号),只是
// 让"轮次间隔异常拉长"这一可观测信号浮出水面,交给 SKILL.md 6.1 的摘要模板判断
// 是否要提示"可能有调度缺口"。
//
// 结构校验(SC2-2):只做形态检查、只记 warning,绝不因为形态不对就丢数据或拒绝
// 落盘——run-log 的唯一职责是如实记录这一轮到底发生了什么。
//
// 退出码:0 = 已落盘;1 = stdin 不是合法 JSON 或写盘失败。
// 跑:node <skill-root>/scripts/run-log.mjs   # JSON 走 stdin(pipe 或 --body-file 风格)

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { stateFile, print, fail } from './lib.mjs';

// processed[].event 的合法取值——实际提交给 GitHub 的 review 事件,与 action(业务分类,
// 如 merged/changes-requested/held/conflict-merged)是两个不同口径,不可混用
// (SKILL.md 6.1 有完整映射表)。
const EVENT_VALUES = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'none']);

/**
 * 只读形态校验,返回 warning 字符串数组(可能为空)。绝不修改 data、绝不抛错——
 * 校验不过也要照常落盘,否则「宁可拒绝写入」的代价是把这一轮的真实记录直接丢掉,
 * 比记一条形态不对的历史更糟。
 */
function validateShape(data) {
  const warnings = [];
  for (const item of data.processed ?? []) {
    if (!EVENT_VALUES.has(item?.event)) {
      warnings.push(
        `processed pr=${item?.pr ?? '?'} 的 event 字段缺失或非法(收到 ${JSON.stringify(item?.event)}),` +
        '应为 APPROVE/REQUEST_CHANGES/COMMENT/none 之一',
      );
    }
  }
  if (data.draftSkipped !== undefined) {
    if (!Array.isArray(data.draftSkipped)) {
      warnings.push(
        `draftSkipped 应为 [{pr,reason,url}] 数组,收到 ${typeof data.draftSkipped}` +
        `(${JSON.stringify(data.draftSkipped)})——落一个数字无法追溯是哪些 PR、为什么被跳过`,
      );
    } else {
      data.draftSkipped.forEach((d, i) => {
        if (typeof d !== 'object' || d === null || d.pr === undefined) {
          warnings.push(`draftSkipped[${i}] 缺少 pr 字段: ${JSON.stringify(d)}`);
        }
      });
    }
  }
  return warnings;
}

/**
 * 读 runs.jsonl 最后一行的 loggedAt,与本轮 loggedAt 相减得到小时数(SC2-3)。
 * 文件不存在 / 为空 / 最后一行解不出合法时间戳时返回 null——首轮或历史损坏都是
 * "未知"而不是"零缺口",不能让 null 被误判成 0。
 */
function computeSinceLastRunHours(runsFile, loggedAt) {
  if (!existsSync(runsFile)) return null;
  let lastLine;
  try {
    const lines = readFileSync(runsFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    lastLine = lines.at(-1);
  } catch {
    return null;
  }
  if (!lastLine) return null;
  try {
    const prevMs = new Date(JSON.parse(lastLine).loggedAt).getTime();
    const curMs = new Date(loggedAt).getTime();
    if (!Number.isFinite(prevMs) || !Number.isFinite(curMs)) return null;
    return Math.round(((curMs - prevMs) / 3_600_000) * 100) / 100; // 保留 2 位小数
  } catch {
    return null;
  }
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
  const sinceLastRunHours = computeSinceLastRunHours(runsFile, loggedAt);

  const record = { loggedAt, sinceLastRunHours, ...data };

  writeFileSync(lastRunFile, JSON.stringify(record, null, 2));
  appendFileSync(runsFile, JSON.stringify(record) + '\n');

  if (warnings.length) {
    process.stderr.write(`[review-pr] run-log 形态警告(已落盘,未阻断):\n${warnings.map((w) => `  - ${w}`).join('\n')}\n`);
  }

  print({
    ok: true,
    loggedAt,
    sinceLastRunHours,
    lastRunFile,
    runsFile,
    warnings,
    note: '汇总 JSON 已落盘;会话最终消息只发人类可读摘要,不要再输出这份 JSON。' +
      'sinceLastRunHours 超过 6 时,6.1 摘要的“其他”行需补一句调度缺口提示(见 SKILL.md 6.1)。',
  });
} catch (e) {
  fail(e);
}
