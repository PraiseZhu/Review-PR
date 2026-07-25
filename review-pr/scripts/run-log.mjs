#!/usr/bin/env node
// run-log.mjs — 把一轮 review 的机器可读汇总 JSON 落盘到外部状态目录(stdin 传入)。
//
// 动机:汇总 JSON 是给日志与下游脚本消费的,**绝不能出现在会话末尾文本里**——
// scheduler 的桌面/飞书通知会直接转发会话末尾内容,末尾是 JSON 用户就会在飞书
// 收到一坨 JSON(历史事故根因)。落盘后,主 agent 的最终消息只输出人类可读摘要。
//
// 写两处(均在按目标仓库隔离的外部状态目录):
//   - last-run.json :最新一轮,整份覆盖(下游脚本取最新结果用);
//   - runs.jsonl    :历史逐行追加,每行 { loggedAt, ...汇总 } (审计/趋势用)。
//
// 退出码:0 = 已落盘;1 = stdin 不是合法 JSON 或写盘失败。
// 跑:node <skill-root>/scripts/run-log.mjs   # JSON 走 stdin(pipe 或 --body-file 风格)

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { stateFile, print, fail } from './lib.mjs';

try {
  const raw = readFileSync(0, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('stdin 不是合法 JSON——请把 6.1 的汇总 JSON 原样 pipe 进来,不要带 markdown 围栏');
  }

  const lastRunFile = stateFile('last-run.json');
  const runsFile = stateFile('runs.jsonl');
  const loggedAt = new Date().toISOString();

  writeFileSync(lastRunFile, JSON.stringify({ loggedAt, ...data }, null, 2));
  appendFileSync(runsFile, JSON.stringify({ loggedAt, ...data }) + '\n');

  print({ ok: true, loggedAt, lastRunFile, runsFile, note: '汇总 JSON 已落盘;会话最终消息只发人类可读摘要,不要再输出这份 JSON' });
} catch (e) {
  fail(e);
}
