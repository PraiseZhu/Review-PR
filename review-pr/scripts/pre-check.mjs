#!/usr/bin/env node
// Scheduler hook: exit 0 + a durable list, exit 2 = no session, exit 1 = failed.
// No GitHub writes or agent invocation. Keep this path for existing schedules.
import { readFileSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  if (i < 0) return '';
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
  return args[i + 1];
}
function readState(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}
try {
  const repoRoot = resolve(arg('--repo-root') || process.env.REVIEW_PR_REPO_ROOT || process.cwd());
  process.env.REVIEW_PR_REPO_ROOT = repoRoot;
  process.chdir(repoRoot);
  if (process.platform !== 'win32') process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(delimiter);
  const { LOCK_FILE, STATE_DIR, stateFile, parseRepo, fetchOpenPrSnapshot, skillRepoPull, fetchDefaultBranch, loadRules } = await import('./lib.mjs');
  const lock = readState(LOCK_FILE);
  if (Date.now() - Date.parse(lock.startedAt) < 60 * 60 * 1000) {
    process.stdout.write(JSON.stringify({ decision: 'skip', reason: 'lock-held' }) + '\n');
    process.exit(2);
  }
  // Update before deciding whether a session is needed, including empty rounds.
  // Re-exec once after a real update: imports already in memory still contain old code.
  let skillSync;
  const inheritedSync = process.env.REVIEW_PR_PREFLIGHT_SKILL_SYNC;
  if (inheritedSync) skillSync = JSON.parse(inheritedSync);
  else {
    try { skillSync = skillRepoPull({ timeoutMs: 30_000 }); }
    catch (error) { skillSync = { ok: false, action: 'pull', error: error.message }; }
    if (skillSync.updated) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
        cwd: repoRoot, env: { ...process.env, REVIEW_PR_PREFLIGHT_SKILL_SYNC: JSON.stringify(skillSync) },
        encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      });
      if (child.error) throw child.error;
      process.stdout.write(child.stdout ?? '');
      process.stderr.write(child.stderr ?? '');
      process.exit(child.status ?? 1);
    }
  }
  const { createCandidateList, parseReviewMode } = await import('./review-round.mjs');
  const { atomicWriteJson } = await import('./runtime-io.mjs');
  const { findIncompleteRounds } = await import('./review-queue.mjs');
  const { restoreReviewHistoryState } = await import('./review-history.mjs');
  const mode = parseReviewMode(args);
  atomicWriteJson(stateFile('skill-sync.json'), { ...skillSync, checkedAt: new Date().toISOString() });
  const { owner, repo } = parseRepo();
  const repository = `${owner}/${repo}`;
  const historyRestore = restoreReviewHistoryState({ repo: repository, mode,
    localStateFile: stateFile('round-state.json') });
  const unfinished = findIncompleteRounds(STATE_DIR, repository, mode);
  if (unfinished.length) {
    process.stdout.write(JSON.stringify({ decision: 'run', reason: 'unfinished-round', mode,
      resumePlan: unfinished[0], incompleteRoundCount: unfinished.length, skillSync, historyRestore }) + '\n');
    process.exit(0);
  }
  // [MIVO-PATCH gate-bases] 配了 gateBases 才读默认分支(名单外分支不送审);读不到按失败,不放行。
  const { toGateBases } = await import('./gate-bases.mjs');
  const gateBases = toGateBases(loadRules().gateBases);
  const defaultBranch = gateBases.length > 0 ? fetchDefaultBranch({ owner, repo, timeoutMs: 30_000 }) : undefined;
  const snapshot = fetchOpenPrSnapshot({ owner, repo, timeoutMs: 30_000 });
  const manifest = createCandidateList({ repo: repository, snapshot, mode, skillSync, historyRestore, defaultBranch, gateBases,
    state: readState(stateFile('round-state.json')),
    fixSessions: readState(stateFile('fix-sessions.json')) });
  const candidateList = resolve(arg('--output') || stateFile('review-candidates.json'));
  // Replace even an empty list so an older run cannot be resurrected.
  atomicWriteJson(candidateList, manifest);
  const candidateCount = manifest.candidates.length;
  process.stdout.write(JSON.stringify({ decision: candidateCount ? 'run' : 'skip',
    reason: candidateCount ? 'candidates-ready' : 'no-review-candidates', runId: manifest.runId, mode,
    candidateList, candidateCount, skippedCount: manifest.skipped.length, skillSync, historyRestore }) + '\n');
  process.exitCode = candidateCount ? 0 : 2;
} catch (error) {
  // A failed query is not an empty list. Do not start on an old manifest.
  process.stderr.write(`[pre-check] ${error.message}\n`);
  process.exitCode = 1;
}
