#!/usr/bin/env node
// retry-ci.mjs — 对可证明的 GitHub Actions 调度异常做一次有界重跑。
// 只允许 workflow failure + 全部 jobs success + 缺 required check。

import { openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  assertActiveReviewLock, fetchMaintainerAuthority, gh, ghJson, parsePR, parseRepo,
  print, fail, probeBranchProtection, stateFile,
} from './lib.mjs';
import { atomicWriteJson } from './runtime-io.mjs';

export const CI_RERUN_VERSION = 1;
const FAILED = new Set(['failure', 'startup_failure', 'timed_out', 'cancelled']);
const successJob = (job) => job?.status === 'completed' && job?.conclusion === 'success';
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

function value(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] ?? '').trim() : '';
}
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
export function requiredCheckNames(probe) {
  return [...new Set((probe?.requiredStatusChecks ?? [])
    .map((c) => typeof c === 'string' ? c : c?.context)
    .map((name) => String(name ?? '').trim()).filter(Boolean))];
}
export function classifyCiRerunCandidate({ run, jobs, requiredChecks, observedChecks = [] } = {}) {
  if (!run || run.status !== 'completed' || !FAILED.has(String(run.conclusion ?? '').toLowerCase())) {
    return { eligible: false, reason: 'workflow 不是可重跑的失败终态' };
  }
  if (Number(run.run_attempt ?? 1) > 1) return { eligible: false, reason: '该 workflow 已有重跑记录' };
  if (!Array.isArray(jobs) || jobs.length === 0) return { eligible: false, reason: 'workflow jobs 读取为空，不能证明是调度异常' };
  const incomplete = jobs.filter((job) => !successJob(job));
  if (incomplete.length) return {
    eligible: false, reason: '存在真实失败或未完成 job',
    failedJobs: incomplete.map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion })),
  };
  const observed = new Set(observedChecks.map((name) => String(name ?? '').trim()).filter(Boolean));
  const missingRequiredChecks = requiredChecks.filter((name) => !observed.has(name));
  if (!missingRequiredChecks.length) return { eligible: false, reason: 'required checks 均已上报，不能证明是缺 job 调度异常' };
  return { eligible: true, workflow: run.name, runId: Number(run.id), runAttempt: Number(run.run_attempt ?? 1),
    missingRequiredChecks, jobCount: jobs.length };
}
function workflowRuns(slug, head) {
  const r = gh(['api', 'repos/' + slug + '/actions/runs?head_sha=' + head + '&per_page=100'], {
    allowFail: true, noCredFallback: true, timeoutMs: 30000,
  });
  if (!r.ok) throw new Error('读取 workflow runs 失败:' + String(r.stderr || r.stdout || '').trim().slice(0, 300));
  let j; try { j = JSON.parse(r.stdout || '{}'); } catch { throw new Error('workflow runs 返回的 JSON 无法解析'); }
  if (!Array.isArray(j.workflow_runs)) throw new Error('workflow runs 返回结构异常');
  return j.workflow_runs;
}
function jobsFor(slug, id) {
  const r = gh(['api', '--method', 'GET', '--paginate', '--slurp',
    'repos/' + slug + '/actions/runs/' + id + '/jobs?per_page=100&filter=latest'], {
    allowFail: true, noCredFallback: true, timeoutMs: 30000,
  });
  if (!r.ok) throw new Error('读取 workflow jobs 失败:' + String(r.stderr || r.stdout || '').trim().slice(0, 300));
  let pages; try { pages = JSON.parse(r.stdout || '[]'); } catch { throw new Error('workflow jobs 返回的 JSON 无法解析'); }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page?.jobs))) throw new Error('workflow jobs 返回结构异常');
  return pages.flatMap((page) => page.jobs);
}
function observedChecks(slug, pr) {
  const j = ghJson(['pr', 'view', String(pr), '--repo', slug, '--json', 'statusCheckRollup']);
  if (!Array.isArray(j.statusCheckRollup)) throw new Error('statusCheckRollup 读取不完整');
  return [...new Set(j.statusCheckRollup.map((c) => c.name ?? c.context)
    .map((name) => String(name ?? '').trim()).filter(Boolean))];
}
function journalFile(pr, head) { return stateFile('ci-rerun-' + pr + '-' + head + '.json'); }
function claimFile(file) { return file + '.claim'; }
function save(file, value) { atomicWriteJson(file, { version: CI_RERUN_VERSION, ...value, updatedAt: new Date().toISOString() }); }
function acquireClaim(file, value) {
  let fd;
  try {
    fd = openSync(claimFile(file), 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString(), ...value }));
    closeSync(fd);
    return true;
  } catch (error) {
    try { if (fd !== undefined) closeSync(fd); } catch {}
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}
function releaseClaim(file) {
  try { unlinkSync(claimFile(file)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

export async function runCli() {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = owner + '/' + repo;
  const lockToken = value('--lock-token');
  const expectedHead = value('--expected-head');
  const expectedAuthorityDigest = value('--expected-authority-digest');
  if (!lockToken || !expectedHead || !expectedAuthorityDigest) throw new Error('缺少 --lock-token / --expected-head / --expected-authority-digest');
  assertActiveReviewLock(lockToken);
  const meta = ghJson(['pr', 'view', String(pr), '--repo', slug, '--json', 'state,isDraft,headRefOid,baseRefName']);
  if (meta.state !== 'OPEN' || meta.isDraft || !same(meta.headRefOid, expectedHead)) {
    print({ ok: true, pr, action: 'state-changed', reason: 'PR state/draft/head 与审查快照不一致', retry: true }); process.exit(2);
  }
  const authority = fetchMaintainerAuthority({ owner, repo });
  if (authority.digest !== expectedAuthorityDigest) throw new Error('维护者权限已变化，不能执行 CI 重跑');
  const runs = workflowRuns(slug, expectedHead);
  const journal = journalFile(pr, expectedHead);
  let claimOwned = false;
  const cleanupClaim = () => {
    if (!claimOwned) return;
    // Keep the claim when an uncertain POST has already been journaled as
    // posting; the next invocation must reconcile by reads before retrying.
    if (readJson(journal)?.status === 'posting') return;
    claimOwned = false;
    try { releaseClaim(journal); } catch {}
  };
  process.once('exit', cleanupClaim);
  const previous = readJson(journal);
  if (previous?.status === 'requested') {
    print({ ok: true, pr, action: 'already-requested', journal, ...previous });
    process.exit(0);
  }
  if (previous?.status === 'posting') {
    const found = runs.find((r) => r.name === previous.workflow && Number(r.run_attempt ?? 1) > Number(previous.runAttempt ?? 1));
    if (found) { save(journal, { ...previous, status: 'requested', rerunRunId: Number(found.id), rerunRunAttempt: Number(found.run_attempt ?? 1) }); releaseClaim(journal);
      print({ ok: true, pr, action: 'reconciled', journal }); process.exit(0); }
    print({ ok: true, pr, action: 'pending-reconciliation', retry: true, journal, ...previous }); process.exit(2);
  }
  const probe = probeBranchProtection(slug, meta.baseRefName, { fresh: true });
  const requiredChecks = requiredCheckNames(probe);
  if (!requiredChecks.length || probe?.requiredStatusChecksKnown === false) {
    print({ ok: true, pr, action: 'not-eligible', reason: 'required checks 未能完整读取，拒绝自动重跑', requiredChecks }); process.exit(0);
  }
  const failedRuns = runs.filter((r) => r.status === 'completed' && FAILED.has(String(r.conclusion ?? '').toLowerCase()))
    .sort((a, b) => String(b.updated_at ?? b.created_at ?? '').localeCompare(String(a.updated_at ?? a.created_at ?? '')));
  let candidate;
  let reason = '没有符合条件的 workflow failure';
  for (const run of failedRuns) {
    const jobs = jobsFor(slug, run.id);
    const classified = classifyCiRerunCandidate({ run, jobs, requiredChecks, observedChecks: observedChecks(slug, pr) });
    if (classified.eligible) { candidate = classified; break; }
    reason = classified.reason;
  }
  if (!candidate) { print({ ok: true, pr, action: 'not-eligible', reason, requiredChecks, failedRunCount: failedRuns.length }); process.exit(0); }
  if (previous?.status === 'failed' && Number(previous.runId) === candidate.runId) {
    print({ ok: true, pr, action: 'previously-failed', journal, ...previous });
    process.exit(2);
  }
  if (!acquireClaim(journal, { pr, head: expectedHead, workflow: candidate.workflow, runId: candidate.runId })) {
    print({ ok: true, pr, action: 'pending-reconciliation', retry: true, journal, reason: '已有另一个重跑请求正在核验或写入' });
    process.exit(2);
  }
  claimOwned = true;
  // Re-read mutable evidence after claiming the write slot. A run can finish,
  // a required context can appear, or the PR can move during collection; stale
  // evidence must never trigger a rerun POST.
  try {
    const latestMeta = ghJson(['pr', 'view', String(pr), '--repo', slug, '--json', 'state,isDraft,headRefOid,baseRefName']);
    const latestAuthority = fetchMaintainerAuthority({ owner, repo });
    if (latestMeta.state !== 'OPEN' || latestMeta.isDraft || !same(latestMeta.headRefOid, expectedHead) ||
        latestMeta.baseRefName !== meta.baseRefName || latestAuthority.digest !== expectedAuthorityDigest) {
      releaseClaim(journal);
      print({ ok: true, pr, action: 'state-changed', reason: 'CI 重跑前 PR head/base/state 或维护者权限已变化', retry: true }); process.exit(2);
    }
    const latestProbe = probeBranchProtection(slug, latestMeta.baseRefName);
    const latestRequired = requiredCheckNames(latestProbe);
    if (!latestRequired.length || latestProbe?.requiredStatusChecksKnown === false) {
      releaseClaim(journal);
      print({ ok: true, pr, action: 'not-eligible', reason: 'CI 重跑前 required checks 未能完整读取，拒绝自动重跑', requiredChecks: latestRequired }); process.exit(0);
    }
    const latestRun = workflowRuns(slug, expectedHead).find((run) => Number(run.id) === candidate.runId);
    if (!latestRun) {
      releaseClaim(journal);
      print({ ok: true, pr, action: 'not-eligible', reason: 'CI 重跑前原 workflow run 已不可用', requiredChecks: latestRequired }); process.exit(0);
    }
    const latestJobs = jobsFor(slug, latestRun.id);
    const latestClassified = classifyCiRerunCandidate({ run: latestRun, jobs: latestJobs, requiredChecks: latestRequired, observedChecks: observedChecks(slug, pr) });
    if (!latestClassified.eligible) {
      releaseClaim(journal);
      print({ ok: true, pr, action: 'not-eligible', reason: 'CI 重跑前候选已不再满足调度异常证据：' + latestClassified.reason, requiredChecks: latestRequired }); process.exit(0);
    }
    candidate = latestClassified;
  } catch (error) {
    releaseClaim(journal);
    throw error;
  }
  const intent = { workflow: candidate.workflow, runId: candidate.runId, runAttempt: candidate.runAttempt,
    missingRequiredChecks: candidate.missingRequiredChecks, attemptedAt: new Date().toISOString(), status: 'posting' };
  assertActiveReviewLock(lockToken);
  save(journal, intent);
  assertActiveReviewLock(lockToken);
  const response = gh(['api', '--method', 'POST', 'repos/' + slug + '/actions/runs/' + candidate.runId + '/rerun'], {
    allowFail: true, noCredFallback: true, timeoutMs: 60000,
  });
  if (response.ok) { save(journal, { ...intent, status: 'requested' }); releaseClaim(journal);
    print({ ok: true, pr, action: 'rerun-requested', retry: true, journal, workflow: candidate.workflow, runId: candidate.runId, missingRequiredChecks: candidate.missingRequiredChecks }); process.exit(0); }
  const detail = String(response.stderr || response.stdout || '').trim().slice(0, 300) || 'GitHub 未返回错误详情';
  if (/HTTP (?:400|401|403|404|409|422)\\b/i.test(detail)) { save(journal, { ...intent, status: 'failed', reason: detail });
    print({ ok: true, pr, action: 'rerun-rejected', retry: false, journal, reason: detail }); process.exit(2); }
  print({ ok: true, pr, action: 'pending-reconciliation', retry: true, journal, reason: detail }); process.exit(2);
}

// Tests import the pure classifiers from this module.  Do not execute the
// GitHub-mutating CLI on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runCli(); } catch (error) { fail(error); }
}
