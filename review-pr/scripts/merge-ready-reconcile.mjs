#!/usr/bin/env node
// merge-ready-reconcile.mjs — Mivo 专用「可合并」标签闸。
// 只打/摘 `review:merge-ready`，不调用 merge-pr.mjs / gh pr merge。
// 判定复用 pre-merge-check 的完整 stage2 + 安全 + 机械门；snapshotHash 按
// base/mergebase/head/diffDigest 语义核对，禁止与 head SHA 直接比较。
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gh, loadRulesWithSource, parseRepo, REPO_ROOT, SIGNOFF_LABEL_DEFAULT } from './lib.mjs';

export const MIVO_REPO = 'xindong/mivo-canvas-plugin';
export const READY_LABEL = 'review:merge-ready';
export const READY_LABEL_COLOR = '0E8A16';
export function managedReadinessRequest(repo, numbers) {
  if (repo !== MIVO_REPO) return null;
  if (!Array.isArray(numbers) || numbers.some(n => !Number.isSafeInteger(n) || n < 1)) {
    throw new Error('invalid readiness PR numbers');
  }
  return { ok: true, action: 'reconcile-required', publisher: 'workflow', writes: 0,
    prs: [...new Set(numbers)].map(number => ({ repo, number })) };
}
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(SCRIPT_DIR);

const BINDING_KEYS = Object.freeze([
  'source', 'schemaVersion', 'outputHash', 'snapshotHash',
  'ledgerHash', 'escapeSourceHash', 'knownHazardsHash', 'headRefOid',
]);

function mergeReadyRules(rules) {
  const value = rules.mergeReady;
  if (value == null) return { enabled: false, label: READY_LABEL };
  if (typeof value !== 'object' || value === null || typeof value.enabled !== 'boolean' ||
      (value.label !== undefined && (typeof value.label !== 'string' || !value.label.trim())) ||
      (value.repo !== undefined && value.repo !== MIVO_REPO)) {
    throw new Error('mergeReady 配置非法');
  }
  const label = value.label ?? READY_LABEL;
  if (label === 'signoff' || label.startsWith('signoff:') || label === SIGNOFF_LABEL_DEFAULT || label === 'awaiting-discussion') {
    throw new Error('mergeReady.label 不得复用 signoff 标签');
  }
  return {
    enabled: value.enabled === true && (value.repo ?? MIVO_REPO) === MIVO_REPO,
    label,
  };
}

export function resolveMergeReadyConfig({ rules } = {}) {
  return mergeReadyRules(rules ?? {});
}

function receiptBindings(gate) {
  const receipt = gate.reviewReceipt;
  const stage2 = gate.receiptGate?.stage2Clean === true || gate.stage2Clean === true;
  if (!stage2 || !receipt || receipt.verdict !== 'clean') return null;
  if (BINDING_KEYS.some((key) => typeof receipt[key] !== 'string' || !receipt[key])) return null;
  return Object.fromEntries(BINDING_KEYS.map((key) => [key, receipt[key]]));
}

export function evaluateMergeReady({ gate = {}, before = {} }) {
  const bindings = receiptBindings(gate);
  const liveHead = before.headRefOid;
  const liveBase = before.baseRefOid;
  const receiptHead = bindings?.headRefOid;
  const gateHead = gate.headRefOid;
  const snapshotFromGate = gate.receiptGate?.snapshotHash ?? gate.snapshotHash;
  const valid = Boolean(
    bindings
    && before.state === 'OPEN'
    && before.isDraft === false
    && gate.securityGate?.pass === true
    && gate.canMergeMechanical === true
    && receiptHead === liveHead
    && gateHead === liveHead
    && typeof liveHead === 'string' && liveHead.length > 0
    && typeof liveBase === 'string' && liveBase.length > 0
    && gate.baseRefOid === liveBase
    && Array.isArray(before.labels)
    && !currentLabels(before.labels).includes('awaiting-discussion')
    && typeof bindings.snapshotHash === 'string'
    && bindings.snapshotHash === snapshotFromGate
    && bindings.snapshotHash !== liveHead,
  );
  return { valid, bindings };
}

export async function invalidateMergeReady({ pr, config, api, error }) {
  try {
    await api.removeLabel(config.label);
    const after = await api.readPullRequest(pr);
    if (!Array.isArray(after?.labels) || currentLabels(after.labels).includes(config.label)) {
      throw new Error('label absence was not confirmed');
    }
    return { ok: false, action: 'error', error: String(error?.message ?? error), invalidated: true };
  } catch (invalidationError) {
    return { ok: false, action: 'invalidation-unconfirmed', error: String(error?.message ?? error),
      invalidated: false, invalidationError: invalidationError.message };
  }
}

function ghIssueLabel({ slug, pr, label, add }) {
  const path = add
    ? `repos/${slug}/issues/${pr}/labels`
    : `repos/${slug}/issues/${pr}/labels/${encodeURIComponent(label)}`;
  const args = add
    ? ['api', '-X', 'POST', path, '-f', `labels[]=${label}`]
    : ['api', '-X', 'DELETE', path];
  const r = gh(args, { allowFail: true });
  if (!r.ok && !add && /HTTP 404|"status": ?"404"/.test(`${r.stderr ?? ''}${r.stdout ?? ''}`)) {
    return { ...r, ok: true, alreadyAbsent: true };
  }
  return r;
}

function currentLabels(value) {
  return (value ?? []).map((item) => (typeof item === 'string' ? item : item.name)).filter(Boolean);
}

export async function reconcileMergeReady({
  pr, config, gate, loadGate, api, dryRun = false, now = new Date().toISOString(),
}) {
  if (!config.enabled) return { ok: true, action: 'disabled', writes: 0 };
  if (config.label === 'signoff' || config.label.startsWith('signoff:') || config.label === SIGNOFF_LABEL_DEFAULT || config.label === 'awaiting-discussion') {
    throw new Error('merge-ready label cannot be signoff');
  }
  let changed = false;
  try {
    if (loadGate) gate = await loadGate();
    const before = await api.readPullRequest(pr);
    const { valid, bindings } = evaluateMergeReady({ gate, before });
    if (dryRun) return { ok: true, action: 'dry-run', writes: 0, ready: valid };
    if (!Array.isArray(before?.labels)) throw new Error('pull request labels unknown');
    const has = before.labels.includes(config.label);
    if (valid && !has) {
      await api.addLabel(config.label);
      changed = true;
    }
    if (!valid && has) {
      await api.removeLabel(config.label);
      changed = true;
    }
    const after = await api.readPullRequest(pr);
    if (after.baseRefOid !== before.baseRefOid || after.headRefOid !== before.headRefOid ||
        gate.headRefOid !== after.headRefOid || (gate.baseRefOid && gate.baseRefOid !== after.baseRefOid)) {
      throw new Error('pull request changed during reconcile');
    }
    if (!valid) {
      if (!Array.isArray(after.labels) || currentLabels(after.labels).includes(config.label)) throw new Error('label absence was not confirmed');
      return { ok: true, action: changed ? 'removed' : 'unchanged', writes: changed ? 1 : 0, ready: false };
    }
    if (!evaluateMergeReady({ gate, before: after }).valid) throw new Error('pull request quality changed during reconcile');
    if (after.labels.includes(config.label) !== true) throw new Error('merge-ready label was not confirmed');
    await api.writeReceipt({
      repo: pr.repo, pr: pr.number, verdict: 'clean', headRefOid: after.headRefOid, baseRefOid: after.baseRefOid,
      snapshotHash: bindings.snapshotHash, ...bindings, action: 'merge-ready', writtenAt: now,
    });
    const final = await api.readPullRequest(pr);
    if (!evaluateMergeReady({ gate, before: final }).valid || !currentLabels(final.labels).includes(config.label)) {
      throw new Error('pull request changed after receipt publication');
    }
    return { ok: true, action: changed ? 'added' : 'unchanged', writes: changed ? 1 : 0 };
  } catch (error) {
    if (dryRun) return { ok: false, action: 'error', error: error.message, writes: 0, invalidated: false };
    return invalidateMergeReady({ pr, config, api, error });
  }
}

function runPreMerge(prNumber) {
  const output = execFileSync(process.execPath, [`${SCRIPT_DIR}/pre-merge-check.mjs`, String(prNumber)], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, REVIEW_PR_REPO_ROOT: REPO_ROOT },
  });
  const line = output.trim().split('\n').at(-1);
  return JSON.parse(line);
}

function cliApi(repo, prNumber) {
  const slug = repo;
  return {
    readPullRequest: async () => {
      const view = JSON.parse(gh([
        'pr', 'view', String(prNumber), '--repo', repo,
        '--json', 'baseRefOid,headRefOid,labels,isDraft,state',
      ]).stdout);
      return { ...view, labels: Array.isArray(view.labels) ? currentLabels(view.labels) : undefined };
    },
    addLabel: async (label) => {
      gh(['label', 'create', label, '--repo', slug, '--description', '审查机判定当前 head 可人工合并', '--color', READY_LABEL_COLOR], { allowFail: true });
      const r = ghIssueLabel({ slug, pr: prNumber, label, add: true });
      if (!r.ok) throw new Error(`add label failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    },
    removeLabel: async (label) => {
      const r = ghIssueLabel({ slug, pr: prNumber, label, add: false });
      if (!r.ok) throw new Error(`remove label failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    },
    writeReceipt: async () => { throw new Error('merge-ready receipt publisher is not configured; refusing unreceipted readiness'); },
  };
}

export async function reconcilePrNumber(prNumber, { dryRun = false } = {}) {
  const parsedRepo = parseRepo();
  const repo = `${parsedRepo.owner}/${parsedRepo.repo}`;
  // Repository identity, not rules from an older base, selects the managed writer.
  const request = managedReadinessRequest(repo, [prNumber]);
  if (request) return request;
  const { rules } = loadRulesWithSource();
  const config = resolveMergeReadyConfig({ rules });
  if (!config.enabled) return { ok: true, action: 'disabled', writes: 0 };
  if (repo !== MIVO_REPO) throw new Error('merge-ready scope is limited to xindong/mivo-canvas-plugin');
  return reconcileMergeReady({
    pr: { repo, number: prNumber },
    config,
    loadGate: async () => {
      const view = JSON.parse(gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'baseRefOid,headRefOid,isDraft,state']).stdout);
      return { ...runPreMerge(prNumber), baseRefOid: view.baseRefOid };
    },
    api: cliApi(repo, prNumber),
    dryRun,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const prNumber = Number(process.argv[2]);
    if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('用法: merge-ready-reconcile.mjs <PR> [--dry-run]');
    const result = await reconcilePrNumber(prNumber, { dryRun: process.argv.includes('--dry-run') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
