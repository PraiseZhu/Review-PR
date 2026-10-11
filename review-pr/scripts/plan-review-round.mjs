#!/usr/bin/env node
// Read the hook's list once, fetch every candidate's full context, freeze groups.
// node plan-review-round.mjs --lock-token <token> [--candidate-list <file>]
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRepo, stateFile, mapPool, spawnScriptJson, loadMaintainerAuthoritySnapshot, assertActiveReviewLock, loadRules, print, fail } from './lib.mjs';
import { atomicWriteJson } from './runtime-io.mjs';
import { validateCandidateList, makeReviewPlan } from './review-round.mjs';
import { collectDependencyRefs } from './review-dependencies.mjs';
import { loadCachedCode } from './context-cache.mjs';
import { readPrState } from './gh-read.mjs';
import { startReviewHeartbeat } from './review-heartbeat.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return '';
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
  return process.argv[i + 1];
};
try {
  const { owner, repo } = parseRepo();
  const slug = `${owner}/${repo}`;
  const token = arg('--lock-token');
  const authority = loadMaintainerAuthoritySnapshot({ owner, repo, lockToken: token });
  const manifest = validateCandidateList(JSON.parse(readFileSync(arg('--candidate-list') || stateFile('review-candidates.json'), 'utf8')), { repo: slug });
  if (arg('--mode') !== manifest.mode) throw new Error('--mode 必须与前置名单一致，模式变化请重新 pre-check');
  // Unique per round; resuming an existing plan must use its already frozen files.
  const roundDir = stateFile(`round-${manifest.runId}`);
  const planFile = join(roundDir, 'plan.json');
  if (existsSync(planFile)) throw new Error(`本轮已有计划，请读取并继续 ${planFile}，不要重新分组`);
  mkdirSync(roundDir, { recursive: true });
  mkdirSync(join(roundDir, 'results'), { recursive: true });
  atomicWriteJson(join(roundDir, 'candidates.json'), manifest);
  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(loadRules().batch?.scanConcurrency)) || 8));
  const dependencyReads = new Map();
  const heartbeat = await startReviewHeartbeat(token);
  let contexts;
  try {
  contexts = await mapPool(manifest.candidates, concurrency, async (candidate) => {
    try {
      heartbeat.assertHealthy();
      assertActiveReviewLock(token);
      const contextFile = join(roundDir, `pr-${candidate.number}.json`);
      const diffFile = join(roundDir, `pr-${candidate.number}.diff`);
      const context = await spawnScriptJson(fileURLToPath(new URL('./context.mjs', import.meta.url)),
        [String(candidate.number), '--compact', '--lock-token', token, '--diff-output', diffFile], { timeoutMs: 300_000 });
      if (!context?.ok) return { pr: candidate.number, ok: false, error: context?.error || 'context 读取失败' };
      const dependencies = [];
      const refs = collectDependencyRefs({ repo: slug, candidate, snapshot: manifest.snapshot, meta: context.meta });
      for (const ref of refs) {
        heartbeat.assertHealthy();
        const [depRepo, rawNumber] = ref.split('#');
        const number = Number(rawNumber);
        const atStart = depRepo.toLowerCase() === slug.toLowerCase() && manifest.snapshot.find((p) => p.number === number);
        const key = `${depRepo.toLowerCase()}#${number}`;
        if (!atStart && !dependencyReads.has(key)) dependencyReads.set(key, readPrState(depRepo, number));
        const state = atStart ? 'OPEN' : await dependencyReads.get(key);
        dependencies.push({ repo: depRepo.toLowerCase() === slug.toLowerCase() ? slug : depRepo, number, state });
      }
      if (context.meta.headRefOid !== candidate.head || context.meta.state !== 'OPEN') return context;
      if (context.evidence?.diffFile !== diffFile) throw new Error('context 未返回本轮 diff 文件');
      atomicWriteJson(contextFile, { ...context, dependencies });
      const material = loadCachedCode(contextFile, { repo: slug, pr: candidate.number, meta: context.meta });
      if (!material.reused) throw new Error(`context/diff evidence 校验失败: ${material.reason}`);
      return { ...context, dependencies, contextFile, diffFile };
    } catch (error) { return { pr: candidate.number, ok: false, error: error.message }; }
  });
  } finally { await heartbeat.stop(); }
  assertActiveReviewLock(token);
  let plan = { ...makeReviewPlan(manifest, contexts), authorityDigest: authority.digest, roundDir,
    summaryChat: loadRules().feishuNotify?.summaryChat };
  atomicWriteJson(planFile, plan);
  const notices = await spawnScriptJson(fileURLToPath(new URL('./notify-round-targets.mjs', import.meta.url)),
    ['--plan', planFile, '--lock-token', token], { timeoutMs: (plan.skipped.length + 1) * 190_000 });
  if (!notices?.ok) throw new Error(`目标分支提醒未完成，请恢复已有 plan：${notices?.error || '未取得回执'}`);
  plan = JSON.parse(readFileSync(planFile, 'utf8'));
  print({ ok: true, runId: plan.runId, mode: plan.mode, planFile, roundDir,
    groups: plan.groups, skipped: plan.skipped,
    candidateCount: manifest.candidates.length, preflightSkippedCount: manifest.skipped.length });
} catch (error) { fail(error); }
