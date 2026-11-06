#!/usr/bin/env node
// 只读回放 dispatch-ledger.json 里「同一 PR 同一 head」的重复派发(#217):
// 每条重复派发,取派发当时判门读到的 context(round 目录的 pr-<N>-live.json)和上一次派发的结果(server/pr-<N>-<runId>/result.json),
// 修复前 = 照旧 decideGate(context);修复后 = 上一次是「核对员推翻」且 PR 当时是自解死锁时,把 gate.overruledAtHead 补进 context 再 decideGate。
// 不调用任何写 GitHub 或派审的入口;只读 ledger、轮次日志、轮次目录。
//   node tools/replay-dispatch-ledger.mjs [--state-root ~/mivo-prereview/state/mivo] [--logs-dir ~/Library/Logs/mivo-prereview/mivo]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideGate } from '../mivo/lib/gates.mjs';

// helpers
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** 一条重复派发的类别:这条派发当时 PR 的卡点 + 上一次派发的结果。 */
export function toRepeatClass({ previous, live }) {
  const blockClass = live?.gate?.blockClass ?? 'unknown';
  const prev = previous?.outcome ?? 'no-result';
  const code = previous?.approvalCode ? `/${previous.approvalCode}` : '';
  return `${blockClass} ← 上次 ${prev}${code}`;
}

/** 修复前后的判门:after 只在「上次核对员推翻 + 当时是自解死锁」时补 gate.overruledAtHead(与 context.mjs 从 GitHub 读到的结论等价)。 */
export function toReplayDecisions({ previous, live }) {
  const before = decideGate(live);
  const overruled = previous?.approvalCode === 'verifier-overruled' && live?.gate?.selfBlockedResolvable === true;
  const after = overruled ? decideGate({ ...live, gate: { ...live.gate, overruledAtHead: { id: null, submittedAt: null } } }) : before;
  return { before, after };
}

/** ledger 里同 PR 同 head 的重复派发:{entry, previousEntry}[]。 */
export function selectRepeats(ledger) {
  const last = new Map();
  const repeats = [];
  for (const entry of ledger) {
    const key = `${entry.pr}:${entry.head}`;
    if (last.has(key)) repeats.push({ entry, previousEntry: last.get(key) });
    last.set(key, entry);
  }
  return repeats;
}

export function replay({ ledger, runIdOf, resultOf, liveOf }) {
  const rows = selectRepeats(ledger).map(({ entry, previousEntry }) => {
    const previous = resultOf(runIdOf(previousEntry.dispatchId));
    const live = liveOf(entry);
    const decisions = live ? toReplayDecisions({ previous, live }) : null;
    return { at: entry.at, pr: entry.pr, head: entry.head.slice(0, 7), class: toRepeatClass({ previous, live }),
      dispatchedBefore: decisions ? decisions.before.stage === 'review' : null,
      dispatchedAfter: decisions ? decisions.after.stage === 'review' : null,
      afterOutcome: decisions?.after.outcome ?? null };
  });
  // reproduced = 修复前的判门在当时的 context 上确实给出「送审」(和 ledger 里发生的派发一致);blockedByFix = 其中修复后不再送审。
  // 当时的 context 已被同一轮后续判门覆盖、回放不出送审的行(如 ci-failed 后的重跑)不计入,两边结论相同。
  const byClass = {};
  for (const row of rows) {
    const c = (byClass[row.class] ??= { repeats: 0, reproduced: 0, blockedByFix: 0 });
    c.repeats += 1;
    if (row.dispatchedBefore === true) c.reproduced += 1;
    if (row.dispatchedBefore === true && row.dispatchedAfter === false) c.blockedByFix += 1;
  }
  const blockedByFix = rows.filter((r) => r.dispatchedBefore === true && r.dispatchedAfter === false).length;
  return { totalDispatches: ledger.length, repeats: rows.length, reproduced: rows.filter((r) => r.dispatchedBefore === true).length, blockedByFix, byClass, rows };
}

// cli
function loadFromDisk({ stateRoot, logsDir }) {
  const ledger = readJson(join(stateRoot, 'mivo', 'dispatch-ledger.json'));
  const runIds = new Map();
  for (const name of readdirSync(logsDir).filter((n) => /^round-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(join(logsDir, name), 'utf8').split('\n')) {
      let record = null;
      try { record = JSON.parse(line); } catch { continue; }
      if (['dispatched', 'dispatch-found'].includes(record.event) && record.runId) runIds.set(record.dispatchId, String(record.runId));
    }
  }
  const projectDir = readdirSync(stateRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(stateRoot, d.name))
    .find((d) => existsSync(join(d, 'admit-candidates.json')));
  const roundDirs = readdirSync(projectDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('round-')).map((d) => join(projectDir, d.name));
  const intents = new Map();
  const results = new Map();
  for (const dir of roundDirs) {
    for (const name of readdirSync(dir)) {
      if (/^dispatch-intent-\d+\.json$/.test(name)) { const i = readJson(join(dir, name)); intents.set(i.dispatchId, dir); }
    }
    const serverDir = join(dir, 'server');
    if (!existsSync(serverDir)) continue;
    for (const name of readdirSync(serverDir)) {
      const m = /^pr-\d+-(\d+)$/.exec(name);
      if (m && existsSync(join(serverDir, name, 'result.json'))) results.set(m[1], join(serverDir, name, 'result.json'));
    }
  }
  return {
    ledger,
    runIdOf: (dispatchId) => runIds.get(dispatchId) ?? null,
    resultOf: (runId) => {
      const file = runId ? results.get(runId) : null;
      if (!file) return null;
      const r = readJson(file);
      return { outcome: r.outcome, approvalCode: r.approval?.code ?? null };
    },
    liveOf: (entry) => {
      const dir = intents.get(entry.dispatchId);
      const file = dir ? join(dir, `pr-${entry.pr}-live.json`) : null;
      return file && existsSync(file) ? readJson(file) : null;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
  const stateRoot = arg('--state-root', join(homedir(), 'mivo-prereview', 'state', 'mivo'));
  const logsDir = arg('--logs-dir', join(homedir(), 'Library', 'Logs', 'mivo-prereview', 'mivo'));
  const result = replay(loadFromDisk({ stateRoot, logsDir }));
  const since = arg('--since', '');
  const rows = since ? result.rows.filter((r) => r.at >= since) : result.rows;
  console.log(JSON.stringify({ ...result, rows: rows.filter((r) => r.dispatchedBefore === true && r.dispatchedAfter === false), rowsNote: '只列修复后会被拦下的重复派发' }, null, 2));
}
