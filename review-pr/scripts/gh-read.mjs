#!/usr/bin/env node
// A bounded read-only child lets planner I/O overlap without duplicating lib's
// credential fallback, retry policy, or result parsing. It accepts no mutations.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ghJson, spawnScriptJson, print, fail } from './lib.mjs';

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
    const { state } = ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'state']);
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(state)) throw new Error('依赖 PR 状态未完整读取');
    print({ ok: true, state });
  } catch (error) { fail(error); }
}
