#!/usr/bin/env node
// admit-candidates.mjs — 滚动接单用的候选名单(round.mjs 在已有轮次等服务器审查时调用)。
// 与 pre-check.mjs 的区别:不做 skill pull;不因为有未完成轮次就停;未完成轮次里的 PR(及依赖它们的 PR)
// 从快照里去掉;名单写到 admit-candidates.json,不覆盖 review-candidates.json。只读 GitHub,不写。
//
//   node mivo/prereview/admit-candidates.mjs --repo-root <dir> [--incomplete-only]
//
// 输出一行 JSON。退出码:0=有候选(--incomplete-only 时总是 0),2=没有候选,1=失败。
import { readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCRIPTS } from '../lib/common.mjs';
import { toBusyPrs, toExcludedPrs } from '../lib/admission.mjs';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i < 0 ? '' : String(args[i + 1] ?? ''); };
const readState = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sorted = (set) => [...set].sort((a, b) => a - b);

try {
  const repoRoot = resolve(arg('--repo-root') || process.env.REVIEW_PR_REPO_ROOT || process.cwd());
  process.env.REVIEW_PR_REPO_ROOT = repoRoot;
  process.chdir(repoRoot);
  if (process.platform !== 'win32') process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(delimiter);
  // lib.mjs 在 import 时按环境变量定状态目录:先设好环境,再 import(同 pre-check.mjs)。
  const load = (name) => import(pathToFileURL(join(SCRIPTS, name)).href);
  const { STATE_DIR, stateFile, parseRepo, fetchOpenPrSnapshot } = await load('lib.mjs');
  const { createCandidateList } = await load('review-round.mjs');
  const { findIncompleteRounds } = await load('review-queue.mjs');
  const { atomicWriteJson } = await load('runtime-io.mjs');
  const mode = 'review-only';
  const { owner, repo } = parseRepo();
  const repository = `${owner}/${repo}`;
  const incompletePlans = findIncompleteRounds(STATE_DIR, repository, mode);
  if (args.includes('--incomplete-only')) {
    print({ ok: true, incompletePlans });
    process.exit(0);
  }

  const state = readState(stateFile('round-state.json'));
  const busy = toBusyPrs(incompletePlans.map((file) => JSON.parse(readFileSync(file, 'utf8'))));
  const excluded = toExcludedPrs({ busyPrs: busy, roundState: state, mode });
  const snapshot = fetchOpenPrSnapshot({ owner, repo, timeoutMs: 30_000 }).filter((pr) => !excluded.has(pr.number));
  const manifest = createCandidateList({ repo: repository, snapshot, mode, state, fixSessions: readState(stateFile('fix-sessions.json')) });
  const candidateList = stateFile('admit-candidates.json');
  // 空名单也写:免得上一次的名单被当成这一次的用。
  atomicWriteJson(candidateList, manifest);
  const candidateCount = manifest.candidates.length;
  print({ ok: true, decision: candidateCount ? 'run' : 'skip', reason: candidateCount ? 'candidates-ready' : 'no-review-candidates',
    runId: manifest.runId, mode, candidateList, candidateCount, skippedCount: manifest.skipped.length,
    busyPrs: sorted(busy), excludedPrs: sorted(excluded), incompletePlans });
  process.exitCode = candidateCount ? 0 : 2;
} catch (error) {
  // 查询失败不等于没有候选:报失败,调用方下个检查点再试。
  print({ ok: false, error: error.message });
  process.exitCode = 1;
}
