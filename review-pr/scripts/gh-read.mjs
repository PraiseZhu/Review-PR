#!/usr/bin/env node
// A bounded read-only child lets planner I/O overlap without duplicating lib's
// credential fallback, retry policy, or result parsing. It accepts no mutations.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ghJson, spawnScriptJson, print, fail } from './lib.mjs';

// A body may cite an issue in a dependency clause ("依赖 #2848"). GitHub answers
// a PR read for that number with this GraphQL error; it means "not a PR", not a
// failed read, so the planner drops the ref instead of skipping the candidate.
// Every other failure (network, permission, unknown repository) stays an error.
export const NOT_A_PULL_REQUEST = 'NOT_A_PULL_REQUEST';
export function isNotPullRequestError(message, pr) {
  return new RegExp(`Could not resolve to a PullRequest with the number of ${Number(pr)}\\b`).test(String(message ?? ''));
}

export async function readPrState(repo, pr) {
  const result = await spawnScriptJson(fileURLToPath(import.meta.url), [repo, String(pr)], { timeoutMs: 120_000 });
  if (!result?.ok) throw new Error(result?.error || '依赖 PR 状态读取失败');
  return result.state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repo = process.argv[2];
    const pr = Number(process.argv[3]);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !Number.isSafeInteger(pr) || pr < 1 || process.argv.length !== 4) {
      throw new Error('用法: gh-read.mjs <owner/repo> <positive PR number>');
    }
    let state;
    try {
      ({ state } = ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'state']));
    } catch (error) {
      if (!isNotPullRequestError(error?.message, pr)) throw error;
      state = NOT_A_PULL_REQUEST;
    }
    if (!['OPEN', 'CLOSED', 'MERGED', NOT_A_PULL_REQUEST].includes(state)) throw new Error('依赖 PR 状态未完整读取');
    print({ ok: true, state });
  } catch (error) { fail(error); }
}
