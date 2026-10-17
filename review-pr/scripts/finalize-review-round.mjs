#!/usr/bin/env node
// Require one terminal result per grouped PR before logging or producing cards.
// node finalize-review-round.mjs --plan <file> --lock-token <token> [--notes-file <json array>]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRepo, assertActiveReviewLock, stateFile, print, fail } from './lib.mjs';
import { atomicWriteJson, atomicWriteText, parseScriptResult } from './runtime-io.mjs';
import { collectRoundResults, nextRoundState } from './review-round.mjs';
import { verifyQueueCompletion } from './review-queue.mjs';
import { verifyReviewArtifacts } from './review-artifacts.mjs';
import { publishReviewHistory } from './review-history.mjs';
import { buildReviewSummary, formatReviewCard, formatReviewCards } from './review-summary.mjs';
import { formatLocalIso } from './local-time.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return '';
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
  return process.argv[i + 1];
};

function readOptionalSummary(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`运行时 Summary 损坏或无法解析：${error.message}`);
  }
}

function historyReceipt(result) {
  const receipt = { ok: result.ok, enabled: result.enabled };
  for (const key of ['runId', 'skipped']) if (result[key] !== undefined) receipt[key] = result[key];
  if (result.sync) {
    receipt.sync = {};
    for (const key of ['ok', 'committed', 'commit', 'pushed', 'branch', 'reason']) {
      if (result.sync[key] !== undefined) receipt.sync[key] = result.sync[key];
    }
  }
  return receipt;
}

try {
  const planFile = arg('--plan');
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const token = arg('--lock-token');
  assertActiveReviewLock(token);
  const { owner, repo } = parseRepo();
  if (plan.repo !== `${owner}/${repo}`) throw new Error('计划不属于当前仓库');
  const directory = dirname(planFile);
  const finalFile = join(directory, 'finalized.json');
  await verifyQueueCompletion({ planFile, lockToken: token });
  if (existsSync(finalFile)) {
    print({ ok: true, alreadyFinalized: true, ...JSON.parse(readFileSync(finalFile, 'utf8')) });
    process.exit(0);
  }

  const resultDir = join(directory, 'results');
  const results = readdirSync(resultDir).filter((name) => /^pr-\d+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(resultDir, name), 'utf8')));
  const payload = collectRoundResults(plan, results);
  for (const result of results) verifyReviewArtifacts(planFile, plan, result);
  const notesFile = arg('--notes-file');
  payload.notes = notesFile ? JSON.parse(readFileSync(notesFile, 'utf8')) : [];
  if (!Array.isArray(payload.notes)) throw new Error('附注必须是 JSON 字符串数组');
  const skillSync = plan.manifest?.skillSync;
  if (skillSync?.ok === false) payload.notes.push(`Skill 更新未完成，使用现有副本：${skillSync.error || skillSync.skipped}`);
  for (const result of results) {
    for (const warning of result.warnings ?? []) payload.notes.push(`#${result.pr}: ${warning}`);
  }
  payload.errors = payload.errors.map((result) => ({ ...result,
    reason: result.errors?.length ? result.errors.join('; ') : result.reason }));

  const summaryFile = join(directory, 'summary.json');
  const markdownFile = join(directory, 'summary.md');
  const cardsFile = join(directory, 'feishu-cards.json');
  const previousSummary = readOptionalSummary(summaryFile);
  if (previousSummary && (previousSummary.version !== 1 || previousSummary.runId !== plan.runId ||
      previousSummary.repo !== plan.repo || previousSummary.mode !== plan.mode ||
      !Number.isFinite(Date.parse(previousSummary.generatedAt)))) {
    throw new Error('已存在的运行时 Summary 不属于本轮或结构无效');
  }
  payload.generatedAt = previousSummary?.generatedAt || formatLocalIso();
  const summary = buildReviewSummary(payload);
  if (previousSummary && JSON.stringify(previousSummary) !== JSON.stringify(summary)) {
    throw new Error(`run ${plan.runId} 的运行时 Summary 冲突`);
  }
  const cards = formatReviewCards(summary);
  atomicWriteJson(summaryFile, summary);
  atomicWriteText(markdownFile, formatReviewCard(summary) + '\n');
  atomicWriteJson(cardsFile, { runId: plan.runId, receive_id_type: 'chat_id',
    receive_id: plan.summaryChat?.chatId || null, pages: cards });

  let previous = {};
  try { previous = JSON.parse(readFileSync(stateFile('round-state.json'), 'utf8')); } catch { /* first run */ }
  const releasedFile = join(directory, 'mivo-released.json');
  const released = existsSync(releasedFile) ? JSON.parse(readFileSync(releasedFile, 'utf8')) : {};
  const nextState = nextRoundState({ ...plan, released }, payload, previous, Date.parse(summary.generatedAt));
  atomicWriteJson(stateFile('round-state.json'), nextState);

  assertActiveReviewLock(token);
  const published = publishReviewHistory({ repo: plan.repo, summary, roundState: nextState });
  if (published.enabled && published.ok !== true) {
    throw new Error(`Git 历史发布失败：${published.error || '未推送到默认分支'}`);
  }
  const history = historyReceipt(published);

  assertActiveReviewLock(token);
  const logged = spawnSync(process.execPath, [fileURLToPath(new URL('./run-log.mjs', import.meta.url))], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true,
  });
  const log = parseScriptResult(logged);
  if (!log.ok) throw new Error(log.error || 'run-log 失败');
  const receipt = { runId: plan.runId, summaryFile, markdownFile, cardsFile, loggedAt: log.loggedAt, history };
  atomicWriteJson(finalFile, receipt);
  print({ ok: true, ...receipt, enteredCount: summary.review.enteredCount,
    skippedCount: summary.review.notEnteredCount, mergedCount: summary.merge.mergedCount, cardCount: cards.length });
} catch (error) { fail(error); }
