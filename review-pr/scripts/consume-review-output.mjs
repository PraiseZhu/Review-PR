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
import { loadLedger, saveLedger, ledgerPathFor, applyReviewOutput, applyInteractiveConfirmation, summarize, isEffectiveOpen } from './lib.findings-ledger.mjs';
import { loadInbox, saveInbox, deriveHazardId, deriveHazardFingerprint } from './lib.escaped-hazards.mjs';

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

  // ── task 文件(build-review-task 产物)**必需**(SC-R1a 复审 BLOCKER:可省略时
  // coverage/必答/required 负向证据全部跳过且能 clean——等于所有对账形同虚设)。
  // 它还必须绑定当前 snapshot:task 是上一步按某个 snapshot 构建的,head/base 变了就作废。
  const taskFile = argOf('--task');
  if (!taskFile || !existsSync(taskFile)) {
    print({ ok: false, pr, verdict: 'invalid', reasons: ['缺 --task <task.json>(build-review-task 产物)——没有它就无法对账覆盖/必答/负向证据,fail-closed'] });
    process.exit(2);
  }
  let task = null;
  const taskErrors = [];
  try { task = readJson(taskFile); } catch (e) { taskErrors.push(`task 文件不可读:${e.message}`); }
  if (task) {
    if (task.schemaVersion !== REVIEW_OUTPUT_SCHEMA_VERSION) taskErrors.push(`task.schemaVersion 不符(需 ${REVIEW_OUTPUT_SCHEMA_VERSION})`);
    if (task.snapshotComplete !== true) taskErrors.push('task.snapshotComplete!==true(构建时快照就不完整)');
    if (task.snapshotHash !== snapshot.snapshotHash) taskErrors.push(`task.snapshotHash 与当前 snapshot 不一致(task=${task.snapshotHash},当前=${snapshot.snapshotHash})——head/base 变过,需重建 task`);
    if (task.ledgerReadable !== true) taskErrors.push('task.ledgerReadable!==true');
    for (const k of ['injectedOpenIds', 'coverageKeys', 'segments', 'requiredProfileAnswers', 'requiredNegativeEvidenceKeys']) {
      if (!Array.isArray(task[k])) taskErrors.push(`task.${k} 缺失或非数组`);
    }
    if (task.hazardsIncomplete === true) taskErrors.push('task.hazardsIncomplete=true(known hazards 加载失败,不得据"无 hazard"放行)');
  }
  const injectedOpenIds = Array.isArray(task?.injectedOpenIds) ? task.injectedOpenIds : [];

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
  if (taskErrors.length > 0) flags.taskInvalid = true;
  if (!snapshot.complete) flags.snapshotMismatch = true;
  if (task?.snapshotHash && task.snapshotHash !== snapshot.snapshotHash) flags.snapshotMismatch = true;
  if (task?.profileConfigIncomplete === true) flags.profileConfigIncomplete = true;
  if (task?.classifierIncomplete === true) flags.classifierIncomplete = true;
  // 覆盖对账(SC-R4):逐 segment 精确集合相等 + 并集 === 全集;coverage key 序列化为
  // "hunk:<fileId>:<hunkId>" / "file:<fileId>"
  const keyStr = (k) => (k.kind === 'hunk' ? `hunk:${k.fileId}:${k.hunkId}` : `file:${k.fileId}`);
  // 当前 snapshot 的合法 hunk 集(SC-R3 复审:checked-clean 只验 hunkId 非空 → stale/
  // 编造的 hunkId 也能满足必答;这里给出权威可引用集合)
  const validHunkByFile = new Map();
  for (const f of snapshot.files ?? []) validHunkByFile.set(f.fileId, new Set((f.hunks ?? []).map((h) => h.hunkId)));
  if (Array.isArray(task?.segments)) {
    const claimedBySeg = new Map((output.segmentReceipts ?? []).map((s) => [s.segmentId, new Set((s.coverageKeys ?? []).map(keyStr))]));
    let okAll = (output.segmentReceipts ?? []).length === task.segments.length;
    const orderBySeg = new Map((output.segmentReceipts ?? []).map((s) => [s.segmentId, s.receivedOrder]));
    const union = new Set();
    for (const seg of task.segments) {
      const want = new Set(seg.assignedCoverageKeys.map(keyStr));
      const got = claimedBySeg.get(seg.segmentId);
      if (!got || !setEq(want, got)) { okAll = false; break; }
      // 顺序投递协议(SC-R4):回执必须自报与 task 一致的投递序号——缺段/乱序/未投递却
      // 声称覆盖都在这里被拒(单纯"最终集合相等"区分不出是否真的分段审过)。
      if (seg.order !== undefined && orderBySeg.get(seg.segmentId) !== seg.order) { okAll = false; flags.segmentOrderMismatch = true; break; }
      for (const k of got) { if (union.has(k)) { okAll = false; break; } union.add(k); }
    }
    const all = new Set((task.coverageKeys ?? []).map(keyStr));
    if (!okAll || !setEq(union, all)) flags.coverageMismatch = true;
  }
  // 必答对账(SC-R3):required (profileId,fileId,checkId) 全集必须被合法作答覆盖
  if (Array.isArray(task?.requiredProfileAnswers)) {
    const want = new Set(task.requiredProfileAnswers.map((r) => `${r.profileId} ${r.fileId} ${r.checkId}`));
    // 只有**合法**作答才计入补足:checked-clean 引用的 hunkId 必须属于当前 snapshot 的同一
    // file(stale/编造的 hunkId 不算);finding 引用已在 schema 层验真。
    const got = new Set();
    for (const a of output.profileAnswers ?? []) {
      if (a?.answer === 'checked-clean') {
        const set = validHunkByFile.get(a.fileId);
        if (!set || !set.has(a.hunkId)) { flags.staleProfileAnchor = true; continue; }
      }
      got.add(`${a.profileId} ${a.fileId} ${a.checkId}`);
    }
    if (![...want].every((k) => got.has(k))) flags.missingProfileAnswers = true;
  }
  // required 负向证据对账(SC-R6):required key 只能由 executed 条目满足(N/A 不算)
  if (Array.isArray(task?.requiredNegativeEvidenceKeys)) {
    const want = new Set(task.requiredNegativeEvidenceKeys.map((k) => `${k.fileId}:${k.hunkId}`));
    const runById = new Map((output.verificationRuns ?? []).map((r) => [r?.runId, r]));
    const got = new Set();
    for (const n of output.negativeEvidence ?? []) {
      if (n?.kind !== 'executed' || n.snapshotHash !== snapshot.snapshotHash) continue;
      // 声明一致性(SC-R6 复审):引用的 run 必须存在,且它的 command 与本条一致、
      // outputAnchor 与本条一致——"引了个不相干的 run"不是 T1 上限,是可机器判的不一致。
      const run = runById.get(n.verificationRunId);
      if (!run || run.command !== n.command || (run.outputAnchor ?? run.outputDigest) !== n.outputAnchor) {
        flags.negativeEvidenceInconsistent = true;
        continue;
      }
      got.add(`${n.fileId}:${n.hunkId}`);
    }
    if (![...want].every((k) => got.has(k))) flags.requiredNegativeKeysMissing = true;
  }

  // ── R7 生产触发链(核验 BLOCKER):escapeAssessment 必须逐条覆盖 task 注入的候选集;
  // yes 项**确定性**写 pending inbox(写失败 → hazardRegisterFailed → invalid,不放行)。
  const candidates = Array.isArray(task?.escapeCandidates) ? task.escapeCandidates : [];
  let ledgerErrors = [];
  const registeredHazards = [];
  if (shape.ok && candidates.length > 0) {
    const want = new Set(candidates.map((c) => c.candidateId));
    const answered = new Map();
    for (const a of output.escapeAssessment ?? []) {
      if (!want.has(a.candidateId) || answered.has(a.candidateId)) { flags.escapeAssessmentMismatch = true; continue; }
      answered.set(a.candidateId, a);
    }
    if (answered.size !== want.size) flags.escapeAssessmentMismatch = true;
    if (!flags.escapeAssessmentMismatch) {
      const yes = [...answered.values()].filter((a) => a.verdict === 'yes');
      if (yes.length > 0) {
        try {
          const inbox = loadInbox(STATE_DIR);
          if (!inbox.ok) throw new Error(`inbox 不可读:${inbox.error}`);
          const items = [...inbox.items];
          for (const a of yes) {
            const cand = candidates.find((c) => c.candidateId === a.candidateId);
            const paths = [...new Set((snapshot.files ?? []).map((f) => f.newPath ?? f.oldPath).filter(Boolean))];
            const base = {
              repo: task.repo ?? null, originPr: cand.referencedPr, originHead: null,
              fixPr: pr, fixHead: headRefOid, pattern: a.basis, paths,
              evidence: `本轮审查判定:${a.basis}`,
              activationStatus: 'pending-fix-merge', promotionStatus: 'pending', promotionTarget: null,
              registeredAt: new Date().toISOString(), registeredBy: 'consume-review-output',
            };
            const hazardId = deriveHazardId(base);
            const item = { ...base, hazardId, fingerprint: deriveHazardFingerprint(base) };
            const idx = items.findIndex((x) => x.hazardId === hazardId);
            if (idx >= 0) items[idx] = { ...items[idx], ...item }; else items.push(item);
            registeredHazards.push(hazardId);
          }
          saveInbox(STATE_DIR, items);
        } catch (e) {
          flags.hazardRegisterFailed = true;
          ledgerErrors.push(`逃逸候选登记失败:${e.message}(登记不可用时不得放行)`);
        }
      }
    }
  } else if (shape.ok && (output.escapeAssessment ?? []).length > 0) {
    // 没有候选却给了答卷:形状层已允许,这里判不一致(防"自造候选骗过对账")
    flags.escapeAssessmentMismatch = true;
  }

  // ── ledger 应用(shape ok 才应用;disposition 验真失败 = 整轮 invalid)──
  let entries = ledger.entries;
  if (shape.ok) {
    const applied = applyReviewOutput({
      entries, output, seat: mode, snapshot,
      preflightHits: preflightIncomplete ? [] : (preflight.hits ?? []),
      // 只有 preflight 完成时才交 executedRules(SC-R5:核销必须有正证据)
      executedRules: preflightIncomplete ? [] : (preflight.executedRules ?? []),
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

  const shapeAll = { ok: shape.ok && ledgerErrors.length === 0 && taskErrors.length === 0, errors: [...shape.errors, ...ledgerErrors, ...taskErrors] };
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
    writeReviewReceipt({ pr, headRefOid, verdict: 'dirty', p0p1Count: Array.isArray(output.findingFamilies) ? output.findingFamilies.length : 0, bindings: { ...bindings, reason: verdict } });
  }

  print({
    ok: true, pr, mode, verdict, reasons, blocked,
    attempts: attempts.count, snapshotHash: snapshot.snapshotHash, snapshotComplete: snapshot.complete,
    ledgerHash, effectiveOpenCount: ledgerResult.effectiveOpenCount, acceptedRiskCount: ledgerResult.acceptedRiskCount,
    injectedOpenIds, registeredHazards,
  });
  process.exit(verdict === 'clean' ? 0 : 2);
} catch (e) {
  fail(e);
}
