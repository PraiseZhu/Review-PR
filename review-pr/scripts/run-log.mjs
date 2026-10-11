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

import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteJson, atomicWriteText } from './runtime-io.mjs';
import { stateFile, print, fail } from './lib.mjs';
import { applyReviewedEntries, loadReviewState, saveReviewedState } from './review-state.mjs';
import { buildReviewSummary, formatReviewCard } from './review-summary.mjs';
import { formatLocalIso } from './local-time.mjs';

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
  const reviewStateFile = stateFile('review-state.json');
  const loggedAt = formatLocalIso();

  // Only explicit reviewed=true entries advance the per-PR head watermark.
  // skipped/blocked/failed entries are deliberately ignored so a failed review cannot
  // suppress the next attempt.
  const reviewedEntries = [
    ...(Array.isArray(data.reviewed) ? data.reviewed : []),
    ...(Array.isArray(data.processed) ? data.processed.filter((entry) => entry?.reviewed === true || entry?.codeReview === true) : []),
  ];
  const previousReviewState = loadReviewState(reviewStateFile);
  const nextReviewState = applyReviewedEntries(previousReviewState, reviewedEntries);

  // Keep one normalized summary beside the raw machine log. The scheduler/Feishu
  // layer consumes this stable shape instead of reconstructing counts from mixed
  // processed/skipped/failed arrays.
  const summary = buildReviewSummary({ ...data, generatedAt: data.generatedAt || loggedAt });
  const record = { loggedAt, ...data, summary, summaryMarkdown: formatReviewCard(summary) };
  const rows = existsSync(runsFile) ? readFileSync(runsFile, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const matches = [];
  for (let index = 0; index < rows.length; index += 1) {
    let previous;
    try { previous = JSON.parse(rows[index]); } catch { throw new Error(`runs.jsonl 第 ${index + 1} 行损坏`); }
    if (data.runId && previous.runId === data.runId) matches.push(previous);
  }
  if (matches.length > 1) throw new Error(`run ${data.runId} 在 runs.jsonl 中重复`);
  if (matches.length === 1) {
    const previous = matches[0];
    const stablePrevious = { ...previous }; delete stablePrevious.loggedAt;
    const stableRecord = { ...record }; delete stableRecord.loggedAt;
    if (JSON.stringify(stablePrevious) !== JSON.stringify(stableRecord)) {
      throw new Error(`run ${data.runId} 的运行日志冲突`);
    }
    record.loggedAt = previous.loggedAt;
  } else rows.push(JSON.stringify(record));
  atomicWriteJson(lastRunFile, record);
  atomicWriteText(runsFile, `${rows.join('\n')}\n`);
  if (reviewedEntries.length) saveReviewedState(reviewStateFile, nextReviewState);

  print({ ok: true, loggedAt: record.loggedAt, lastRunFile, runsFile, reviewedWatermarks: reviewedEntries.length,
    note: '汇总 JSON 已落盘;会话最终消息只发人类可读摘要,不要再输出这份 JSON' });
} catch (e) {
  fail(e);
}
