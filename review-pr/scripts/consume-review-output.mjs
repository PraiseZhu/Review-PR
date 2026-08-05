#!/usr/bin/env node
// consume-review-output.mjs — 审查输出的唯一消费与裁决出口(SC-R1b,2026-08-05 SC v4)。
//
// 职责链:读取审查 agent 的 rro-1 JSON → 重建 DiffSnapshot(SC-R8,immutable objects)
// → 校验契约(SC-R1a)→ 应用并验真 disposition 到 findings ledger(SC-R5,单一写者)
// → 外部对账(task 文件给的覆盖 keys / 必答 / required 负向证据 keys / snapshotHash)
// → 机器派生 verdict → 写回执:
//   - clean:唯一入口在这里(write-review-receipt CLI 已禁 clean),回执带五项绑定
//     {source, schemaVersion, outputHash, snapshotHash, ledgerHash};
//   - dirty / invalid:写 non-clean 回执**覆盖撤销**同 snapshot 旧 clean(last-write-wins);
//   - invalid 不落任何 ledger 变更(输出不可信),只记 retry 计数;同 snapshot 连续
//     3 次非法 → blocked(初次+2 次修复重试,SC 共识裁决)。
//
// 用法:
//   node consume-review-output.mjs <PR> --output <rro-1.json> --mode auto|interactive \
//     --base <baseRefOid> --head <headRefOid> [--task <task.json>] [--preflight <pf.json>] \
//     [--confirm <confirm.json>]
// 退出码:0 = verdict clean;2 = dirty/invalid/blocked(JSON 里带原因);1 = 脚本自身错误。
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { parsePR, print, fail, REPO_ROOT, STATE_DIR, writeReviewReceipt, stateFile, writeJsonAtomic } from './lib.mjs';
import { buildDiffSnapshot } from './lib.diff-snapshot.mjs';
import { validateReviewOutput, deriveVerdict, REVIEW_OUTPUT_SCHEMA_VERSION } from './lib.review-consume.mjs';
import { loadLedger, saveLedger, ledgerPathFor, applyReviewOutput, applyInteractiveConfirmation, summarize, computeLedgerHash, isEffectiveOpen } from './lib.findings-ledger.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

try {
  const pr = parsePR(process.argv[2]);
  const mode = argOf('--mode');
  if (mode !== 'auto' && mode !== 'interactive') fail(new Error('缺 --mode auto|interactive'));
  const outputFile = argOf('--output');
  const baseRefOid = (argOf('--base') ?? '').toLowerCase();
  const headRefOid = (argOf('--head') ?? '').toLowerCase();
  if (!outputFile || !existsSync(outputFile)) fail(new Error('缺 --output <rro-1.json>'));

  // ── DiffSnapshot 重建(fail-closed:不完整时本轮只能 invalid,绝不放行)──
  const snapshot = buildDiffSnapshot({ repoRoot: REPO_ROOT, baseRefOid, headOid: headRefOid });

  // ── ledger 加载(损坏 → blocked,连回执都不写:ledgerHash 算不出,fail-closed)──
  const ledgerFile = ledgerPathFor(STATE_DIR, pr);
  const ledger = loadLedger(ledgerFile);
  if (!ledger.ok) {
    print({ ok: false, pr, verdict: 'blocked', reasons: [`findings ledger 不可读:${ledger.error}(fail-closed,人工修复后重试)`] });
    process.exit(2);
  }

  // ── task 文件(build-review-task 产物):注入的 open IDs / 覆盖 keys / 必答 / required 负向 keys ──
  const taskFile = argOf('--task');
  const task = taskFile ? readJson(taskFile) : null;
  const injectedOpenIds = task?.injectedOpenIds
    ?? ledger.entries.filter((e) => isEffectiveOpen(e, snapshot.snapshotHash)).map((e) => e.findingId);

  // ── 输出解析 + 契约校验 ──
  const rawOutput = readFileSync(outputFile, 'utf8');
  let output = null;
  let shape;
  try {
    output = JSON.parse(rawOutput);
    shape = validateReviewOutput(output, { injectedOpenIds });
  } catch (e) {
    shape = { ok: false, errors: [`输出不是合法 JSON:${e.message}`] };
    output = {};
  }

  // ── preflight 结果(SC-R2 产物;缺文件 = 本轮没跑 preflight → 按不完整处理,fail-closed)──
  const preflightFile = argOf('--preflight');
  const preflight = preflightFile && existsSync(preflightFile) ? readJson(preflightFile) : null;
  const preflightIncomplete = !preflight || preflight.complete !== true || preflight.snapshotHash !== snapshot.snapshotHash;

  // ── 外部对账 flags ──
  const flags = { preflightIncomplete };
  if (!snapshot.complete) flags.snapshotMismatch = true;
  if (task?.snapshotHash && task.snapshotHash !== snapshot.snapshotHash) flags.snapshotMismatch = true;
  if (task?.profileConfigIncomplete === true) flags.profileConfigIncomplete = true;
  // 覆盖对账(SC-R4):逐 segment 精确集合相等 + 并集 === 全集;coverage key 序列化为
  // "hunk:<fileId>:<hunkId>" / "file:<fileId>"
  if (task?.segments) {
    const keyStr = (k) => (k.kind === 'hunk' ? `hunk:${k.fileId}:${k.hunkId}` : `file:${k.fileId}`);
    const claimedBySeg = new Map((output.segmentReceipts ?? []).map((s) => [s.segmentId, new Set((s.coverageKeys ?? []).map(keyStr))]));
    let okAll = (output.segmentReceipts ?? []).length === task.segments.length;
    const union = new Set();
    for (const seg of task.segments) {
      const want = new Set(seg.assignedCoverageKeys.map(keyStr));
      const got = claimedBySeg.get(seg.segmentId);
      if (!got || !setEq(want, got)) { okAll = false; break; }
      for (const k of got) { if (union.has(k)) { okAll = false; break; } union.add(k); }
    }
    const all = new Set((task.coverageKeys ?? []).map(keyStr));
    if (!okAll || !setEq(union, all)) flags.coverageMismatch = true;
  }
  // 必答对账(SC-R3):required (profileId,fileId,checkId) 全集必须被合法作答覆盖
  if (task?.requiredProfileAnswers) {
    const want = new Set(task.requiredProfileAnswers.map((r) => `${r.profileId} ${r.fileId} ${r.checkId}`));
    const got = new Set((output.profileAnswers ?? []).map((a) => `${a.profileId} ${a.fileId} ${a.checkId}`));
    if (![...want].every((k) => got.has(k))) flags.missingProfileAnswers = true;
  }
  // required 负向证据对账(SC-R6):required key 只能由 executed 条目满足(N/A 不算)
  if (task?.requiredNegativeEvidenceKeys) {
    const want = new Set(task.requiredNegativeEvidenceKeys.map((k) => `${k.fileId}:${k.hunkId}`));
    const got = new Set((output.negativeEvidence ?? [])
      .filter((n) => n.kind === 'executed' && n.snapshotHash === snapshot.snapshotHash)
      .map((n) => `${n.fileId}:${n.hunkId}`));
    if (![...want].every((k) => got.has(k))) flags.requiredNegativeKeysMissing = true;
  }

  // ── ledger 应用(shape ok 才应用;disposition 验真失败 = 整轮 invalid)──
  let entries = ledger.entries;
  let ledgerErrors = [];
  if (shape.ok) {
    const applied = applyReviewOutput({
      entries, output, seat: mode, snapshot,
      preflightHits: preflightIncomplete ? [] : (preflight.hits ?? []),
    });
    entries = applied.entries;
    ledgerErrors = applied.errors;
  }
  // 交互确认(accepted-risk / confirm-invalidated;auto 模式在函数内被拒)
  const confirmFile = argOf('--confirm');
  if (confirmFile && existsSync(confirmFile)) {
    for (const c of readJson(confirmFile)) {
      const r = applyInteractiveConfirmation({ entries, confirmation: { ...c, snapshotHash: snapshot.snapshotHash }, mode });
      if (r.error) ledgerErrors.push(r.error);
      else entries = r.entries;
    }
  }
  // 注入 open 是否逐条 disposition(SC-R5 门)
  const dispositioned = new Set((output.findingDispositions ?? []).map((d) => d.findingId));
  if (shape.ok && injectedOpenIds.some((id) => !dispositioned.has(id) && entries.find((e) => e.findingId === id && isEffectiveOpen(e, snapshot.snapshotHash)))) {
    flags.missingDispositions = true;
  }

  const shapeAll = { ok: shape.ok && ledgerErrors.length === 0, errors: [...shape.errors, ...ledgerErrors] };
  const ledgerResult = summarize(entries, snapshot.snapshotHash);
  const { verdict, reasons } = deriveVerdict({ shape: shapeAll, output, ledgerResult, flags });

  // ── retry 记账(同 snapshot 维度;snapshot 漂移即重置——共识:初次+2 重试,3 次即 blocked)──
  const attemptsFile = stateFile(`review-attempts-${pr}.json`);
  let attempts = { snapshotHash: snapshot.snapshotHash, count: 0 };
  try { const a = JSON.parse(readFileSync(attemptsFile, 'utf8')); if (a.snapshotHash === snapshot.snapshotHash) attempts = a; } catch { /* 首次 */ }
  let blocked = false;
  if (verdict === 'invalid') {
    attempts.count += 1;
    writeJsonAtomic(attemptsFile, attempts);
    if (attempts.count >= 3) blocked = true;
  } else {
    writeJsonAtomic(attemptsFile, { snapshotHash: snapshot.snapshotHash, count: 0 });
  }

  // ── 落盘与回执 ──
  const outputHash = `oh1-${createHash('sha256').update(rawOutput, 'utf8').digest('hex')}`;
  let ledgerHash = ledger.ledgerHash;
  if (verdict !== 'invalid') {
    ledgerHash = saveLedger(ledgerFile, entries); // 单一写者:只有本脚本写 ledger
  }
  const bindings = {
    source: 'consume-review-output', schemaVersion: REVIEW_OUTPUT_SCHEMA_VERSION,
    outputHash, snapshotHash: snapshot.snapshotHash ?? 'snapshot-incomplete', ledgerHash,
  };
  if (verdict === 'clean') {
    writeReviewReceipt({ pr, headRefOid, verdict: 'clean', p0p1Count: 0, bindings });
  } else {
    // dirty/invalid:写 non-clean 回执,覆盖撤销同 snapshot 旧 clean(last-write-wins)
    writeReviewReceipt({ pr, headRefOid, verdict: 'dirty', p0p1Count: (output.findingFamilies ?? []).length, bindings: { ...bindings, reason: verdict } });
  }

  print({
    ok: true, pr, mode, verdict, reasons, blocked,
    attempts: attempts.count, snapshotHash: snapshot.snapshotHash, snapshotComplete: snapshot.complete,
    ledgerHash, effectiveOpenCount: ledgerResult.effectiveOpenCount, acceptedRiskCount: ledgerResult.acceptedRiskCount,
    injectedOpenIds,
  });
  process.exit(verdict === 'clean' ? 0 : 2);
} catch (e) {
  fail(e);
}
