#!/usr/bin/env node
// consume-review-output.mjs — 审查输出的唯一消费与裁决出口(SC-R1b,2026-08-05 SC v4)。
//
// 职责链:读取审查 agent 的 rro-1 JSON → 重建 DiffSnapshot(SC-R8,immutable objects)
// → **从 snapshot 权威重算**覆盖/分片/必答/required 负向证据(SC-R1a 第 2 轮核验:task
// 文件是可编辑的普通 JSON,不能当权威;重算值与 task 声明值不符即 taskInvalid)
// → 校验契约(SC-R1a)→ 核对分段投递台账(SC-R4)→ 应用并验真 disposition 到 findings
// ledger(SC-R5,单一写者)→ 机器派生 verdict → 写回执:
//   - clean:唯一入口在这里(write-review-receipt CLI 已禁 clean),回执带五项绑定
//     {source, schemaVersion, outputHash, snapshotHash, ledgerHash};
//   - dirty / invalid:写 non-clean 回执**覆盖撤销**同 snapshot 旧 clean(last-write-wins);
//   - invalid 不落任何 ledger 变更(输出不可信),只记 retry 计数;同 snapshot 连续
//     3 次非法 → blocked(初次+2 次修复重试,SC 共识裁决)。
//
// **所有**输入级失败(缺 --output / 缺或坏 --task / snapshot 建不起来 / ledger 不可读)
// 都走统一 bail:写 non-clean 回执(撤销同 snapshot 旧 clean)+ 记 retry,再退出 2。
// 第 2 轮核验 BLOCKER:此前这些路径是提前 return,旧 clean 回执被完整保留,pre-merge
// 后续照样接受——"缺 task 就当没跑过"变成了"缺 task 就沿用上次的清白"。
//
// 用法:
//   node consume-review-output.mjs <PR> --output <rro-1.json> --mode auto|interactive \
//     --base <baseRefOid> --head <headRefOid> --task <task.json> [--preflight <pf.json>] \
//     [--confirm <confirm.json>]
//   (--task 必需:没有它就无法对账覆盖/必答/负向证据)
// 退出码:0 = verdict clean;2 = dirty/invalid/blocked(JSON 里带原因);1 = 脚本自身错误。
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { parsePR, print, fail, REPO_ROOT, STATE_DIR, loadRules, parseRepo, writeReviewReceipt, stateFile, writeJsonAtomic, ghJson } from './lib.mjs';
import { buildDiffSnapshot } from './lib.diff-snapshot.mjs';
import { validateReviewOutput, deriveVerdict, REVIEW_OUTPUT_SCHEMA_VERSION } from './lib.review-consume.mjs';
import { computeReviewRequirements, diffRequirements, coverageKeyStr, profileAnswerKeyStr, negativeKeyStr } from './lib.review-requirements.mjs';
import { loadLedger, saveLedger, ledgerPathFor, applyReviewOutput, applyInteractiveConfirmation, summarize, isEffectiveOpen } from './lib.findings-ledger.mjs';
import { deliveryPathFor, loadDeliveries, reconcileDeliveries } from './lib.review-delivery.mjs';
import { loadInbox, saveInbox, deriveHazardId, deriveHazardFingerprint, resolveEscapeSources, loadKnownHazards, hazardsForPaths } from './lib.escaped-hazards.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
/** 只在 shape 校验通过时才把数组字段交给下游;否则一律当空数组。
 *  第 3 轮核验:schema 已判 invalid 后仍把 wrong-type 字段(如 `segmentReceipts:{}`)送进
 *  `.map` 会抛到最外层 catch,于是"invalid"这一轮既不写 non-clean 也不记 retry。 */
const arr = (ok, v) => (ok && Array.isArray(v) ? v : []);

/** retry 记账(同 snapshot 维度;snapshot 漂移即重置)。 */
function bumpAttempts(pr, snapshotHash, invalid) {
  const attemptsFile = stateFile(`review-attempts-${pr}.json`);
  let attempts = { snapshotHash, count: 0 };
  try { const a = JSON.parse(readFileSync(attemptsFile, 'utf8')); if (a.snapshotHash === snapshotHash) attempts = a; } catch { /* 首次 */ }
  if (invalid) attempts.count += 1; else attempts.count = 0;
  attempts.snapshotHash = snapshotHash;
  writeJsonAtomic(attemptsFile, attempts);
  return attempts;
}

// 模块级 finalize:让最外层 catch 也能撤销旧 clean(第 3 轮核验 BLOCKER——非法 --mode、
// malformed preflight/confirm、wrong-type 字段引发的抛错此前一路落到 fail(),既不写
// non-clean 也不记 retry,已有的同 snapshot clean 被完整保留)。
let FINALIZE = null;

try {
  const pr = parsePR(process.argv[2]);
  const mode = argOf('--mode');
  const baseRefOid = (argOf('--base') ?? '').toLowerCase();
  const headRefOid = (argOf('--head') ?? '').toLowerCase();

  // ── DiffSnapshot 重建(建不起来也要落 non-clean 回执:撤销旧 clean 是本脚本的义务)──
  let snapshot = { complete: false, snapshotHash: null, reason: '未构建', files: [], rawPatch: '' };
  let snapshotThrew = null;
  try {
    snapshot = buildDiffSnapshot({ repoRoot: REPO_ROOT, baseRefOid, headOid: headRefOid });
  } catch (e) { snapshotThrew = String(e.message ?? e); }

  /** 统一 bail:任何输入级失败都在这里落 non-clean 回执 + 记 retry,再退出 2。 */
  const bail = (verdict, reasons) => {
    const snapshotHash = snapshot.snapshotHash ?? 'snapshot-incomplete';
    const attempts = bumpAttempts(pr, snapshotHash, true);
    writeReviewReceipt({
      pr, headRefOid, verdict: 'dirty', p0p1Count: 0,
      bindings: {
        source: 'consume-review-output', schemaVersion: REVIEW_OUTPUT_SCHEMA_VERSION,
        outputHash: null, snapshotHash, ledgerHash: null, reason: verdict,
      },
    });
    print({
      ok: false, pr, mode: mode ?? null, verdict, reasons, blocked: attempts.count >= 3, attempts: attempts.count,
      snapshotHash: snapshot.snapshotHash, snapshotComplete: snapshot.complete,
      note: '已写 non-clean 回执覆盖撤销同 snapshot 的旧 clean(输入级失败不得沿用上次的清白)',
    });
    process.exit(2);
  };
  FINALIZE = bail;

  if (mode !== 'auto' && mode !== 'interactive') bail('invalid', ['缺 --mode auto|interactive']);
  const outputFile = argOf('--output');
  if (!outputFile || !existsSync(outputFile)) bail('invalid', ['缺 --output <rro-1.json>']);
  if (snapshotThrew) bail('invalid', [`DiffSnapshot 构建失败:${snapshotThrew}(fail-closed)`]);

  // ── ledger 加载(损坏 → blocked;仍然写 non-clean 回执)──
  const ledgerFile = ledgerPathFor(STATE_DIR, pr);
  const ledger = loadLedger(ledgerFile);
  if (!ledger.ok) bail('blocked', [`findings ledger 不可读:${ledger.error}(fail-closed,人工修复后重试)`]);

  // ── task 文件**必需**;且只作"审查方看到的副本",权威集合由本脚本重算 ──
  const taskFile = argOf('--task');
  if (!taskFile || !existsSync(taskFile)) {
    bail('invalid', ['缺 --task <task.json>(build-review-task 产物)——没有它就无法对账覆盖/必答/负向证据,fail-closed']);
  }
  let task = null;
  try { task = readJson(taskFile); } catch (e) { bail('invalid', [`task 文件不可读:${e.message}`]); }

  // ── 权威重算(SC-R1a 第 2 轮核验 BLOCKER)──
  const rules = loadRules();
  const auth = computeReviewRequirements({ repoRoot: REPO_ROOT, snapshot, rules });

  const taskErrors = [];
  if (task.schemaVersion !== REVIEW_OUTPUT_SCHEMA_VERSION) taskErrors.push(`task.schemaVersion 不符(需 ${REVIEW_OUTPUT_SCHEMA_VERSION})`);
  if (task.snapshotComplete !== true) taskErrors.push('task.snapshotComplete!==true(构建时快照就不完整)');
  if (task.snapshotHash !== snapshot.snapshotHash) taskErrors.push(`task.snapshotHash 与当前 snapshot 不一致(task=${task.snapshotHash},当前=${snapshot.snapshotHash})——head/base 变过,需重建 task`);
  if (task.ledgerReadable !== true) taskErrors.push('task.ledgerReadable!==true');
  if (task.hazardsIncomplete === true) taskErrors.push('task.hazardsIncomplete=true(known hazards 加载失败,不得据"无 hazard"放行)');
  if (task.escapeSourceIncomplete === true) taskErrors.push(`task.escapeSourceIncomplete=true(逃逸候选数据源缺失:${(task.escapeSourceErrors ?? []).join(';')})`);
  if (!Array.isArray(task.injectedOpenIds)) taskErrors.push('task.injectedOpenIds 缺失或非数组');
  if (!Array.isArray(task.escapeCandidates)) taskErrors.push('task.escapeCandidates 缺失或非数组');
  // 重算 vs 声明:清空/篡改 task 的四组集合再也换不来 clean
  taskErrors.push(...diffRequirements(auth, task));

  // ── R7 第 3 轮核验 BLOCKER:candidates / repo / known hazards 也必须**独立重算** ──
  // 此前 consumer 只重算 coverage/profile/negative,于是保留真 snapshotHash、把
  // escapeCandidates 清空 + escapeSourceIncomplete:false,再给一份空 escapeAssessment,
  // 就能 exit 0 + clean 且零 pending(核验席实测)。
  const authRepo = (() => { try { const { owner, repo } = parseRepo(); return `${owner}/${repo}`; } catch { return null; } })();
  if (task.repo !== authRepo) taskErrors.push(`task.repo 与现场解析不符(task=${task.repo},现场=${authRepo})`);
  const authSrc = resolveEscapeSources({
    pr, repoSlug: authRepo,
    bodyFile: argOf('--pr-body-file'), issuesFile: argOf('--related-issues-file'),
    ghJson, readFileSync, existsSync,
  });
  if ((authSrc.errors.length > 0) !== (task.escapeSourceIncomplete === true)) {
    taskErrors.push(`task.escapeSourceIncomplete 与现场重算不符(现场 errors=${authSrc.errors.length})`);
  }
  if (authSrc.errors.length > 0) taskErrors.push(`逃逸候选数据源现场重算失败:${authSrc.errors.join(';')}`);
  const authCandIds = new Set(authSrc.candidates.map((c) => c.candidateId));
  const taskCandIds = new Set((Array.isArray(task.escapeCandidates) ? task.escapeCandidates : []).map((c) => c?.candidateId));
  if (authCandIds.size !== taskCandIds.size || [...authCandIds].some((x) => !taskCandIds.has(x))) {
    taskErrors.push(`task.escapeCandidates 与现场重算不一致(现场 ${authCandIds.size} 条,task ${taskCandIds.size} 条)——被改过或过期`);
  }
  const authHazards = loadKnownHazards();
  const authRelevant = hazardsForPaths(authHazards, (snapshot.files ?? []).map((f) => f.newPath ?? f.oldPath).filter(Boolean), authRepo);
  const authHazardIds = new Set(authRelevant.map((h) => h.hazardId));
  const taskHazardIds = new Set((Array.isArray(task.knownHazards) ? task.knownHazards : []).map((h) => h?.hazardId));
  if ((authHazards.incomplete === true || authRepo === null) !== (task.hazardsIncomplete === true)) {
    taskErrors.push('task.hazardsIncomplete 与现场重算不符');
  }
  if (authHazardIds.size !== taskHazardIds.size || [...authHazardIds].some((x) => !taskHazardIds.has(x))) {
    taskErrors.push(`task.knownHazards 与现场重算不一致(现场 ${authHazardIds.size} 条,task ${taskHazardIds.size} 条)`);
  }

  const injectedOpenIds = Array.isArray(task.injectedOpenIds) ? task.injectedOpenIds : [];

  // ── 输出解析 + 契约校验 ──
  const rawOutput = readFileSync(outputFile, 'utf8');
  let output = null;
  let shape;
  try {
    output = JSON.parse(rawOutput);
    shape = validateReviewOutput(output, { injectedOpenIds, snapshotHash: snapshot.snapshotHash });
  } catch (e) {
    shape = { ok: false, errors: [`输出不是合法 JSON:${e.message}`] };
    output = {};
  }

  // ── preflight 结果(SC-R2 产物;缺文件 = 本轮没跑 preflight → fail-closed)──
  const preflightFile = argOf('--preflight');
  let preflight = null;
  if (preflightFile && existsSync(preflightFile)) {
    try { preflight = readJson(preflightFile); } catch (e) { bail('invalid', [`preflight 文件不可读:${e.message}(fail-closed)`]); }
  }
  const preflightIncomplete = !preflight || preflight.complete !== true || preflight.snapshotHash !== snapshot.snapshotHash;

  // ── 外部对账 flags(一律拿**重算值**做基准)──
  const flags = { preflightIncomplete };
  if (taskErrors.length > 0) flags.taskInvalid = true;
  if (!snapshot.complete) flags.snapshotMismatch = true;
  if (task.snapshotHash && task.snapshotHash !== snapshot.snapshotHash) flags.snapshotMismatch = true;
  if (auth.configIncomplete) flags.profileConfigIncomplete = true;
  if (auth.classifier.incomplete) flags.classifierIncomplete = true;

  // 当前 snapshot 的合法 hunk 集(checked-clean 锚点必须真存在)
  const validHunkByFile = new Map();
  for (const f of snapshot.files ?? []) validHunkByFile.set(f.fileId, new Set((f.hunks ?? []).map((h) => h.hunkId)));

  // 分段投递台账核对(SC-R4 第 2 轮核验 BLOCKER:此前唯一"顺序"凭据是模型自报)
  const delivery = loadDeliveries(deliveryPathFor(STATE_DIR, pr));
  const deliveryReasons = reconcileDeliveries({
    loaded: delivery, snapshotHash: snapshot.snapshotHash,
    segments: auth.segments, receipts: arr(shape.ok, output.segmentReceipts),
  });
  if (deliveryReasons.length > 0) flags.segmentsNotDelivered = true;

  // 覆盖对账(SC-R4):逐 segment 精确集合相等 + 并集 === 全集
  {
    const claimedBySeg = new Map((arr(shape.ok, output.segmentReceipts)).map((s) => [s.segmentId, new Set((s.coverageKeys ?? []).map(coverageKeyStr))]));
    const orderBySeg = new Map((arr(shape.ok, output.segmentReceipts)).map((s) => [s.segmentId, s.receivedOrder]));
    let okAll = (arr(shape.ok, output.segmentReceipts)).length === auth.segments.length;
    const union = new Set();
    for (const seg of auth.segments) {
      const want = new Set(seg.assignedCoverageKeys.map(coverageKeyStr));
      const got = claimedBySeg.get(seg.segmentId);
      if (!got || !setEq(want, got)) { okAll = false; break; }
      if (orderBySeg.get(seg.segmentId) !== seg.order) { okAll = false; flags.segmentOrderMismatch = true; break; }
      for (const k of got) { if (union.has(k)) { okAll = false; break; } union.add(k); }
    }
    const all = new Set(auth.coverageKeys.map(coverageKeyStr));
    if (!okAll || !setEq(union, all)) flags.coverageMismatch = true;
  }
  // 必答对账(SC-R3):required 全集必须被**合法**作答覆盖
  {
    const want = new Set(auth.requiredProfileAnswers.map(profileAnswerKeyStr));
    const got = new Set();
    for (const a of arr(shape.ok, output.profileAnswers)) {
      if (a?.answer === 'checked-clean') {
        const set = validHunkByFile.get(a.fileId);
        if (!set || !set.has(a.hunkId)) { flags.staleProfileAnchor = true; continue; }
      }
      got.add(profileAnswerKeyStr(a));
    }
    if (![...want].every((k) => got.has(k))) flags.missingProfileAnswers = true;
  }
  // required 负向证据对账(SC-R6):required key 只能由 executed 条目满足(N/A 不算)
  {
    const want = new Set(auth.requiredNegativeEvidenceKeys.map(negativeKeyStr));
    const runById = new Map((arr(shape.ok, output.verificationRuns)).map((r) => [r?.runId, r]));
    const got = new Set();
    for (const n of arr(shape.ok, output.negativeEvidence)) {
      if (n?.kind !== 'executed' || n.snapshotHash !== snapshot.snapshotHash) continue;
      const run = runById.get(n.verificationRunId);
      if (!run || run.command !== n.command || (run.outputAnchor ?? run.outputDigest) !== n.outputAnchor) {
        flags.negativeEvidenceInconsistent = true;
        continue;
      }
      got.add(negativeKeyStr(n));
    }
    if (![...want].every((k) => got.has(k))) flags.requiredNegativeKeysMissing = true;
  }

  // ── R7 逃逸判定对账(登记本身推迟到 provisional verdict 之后,见下)──
  // 对账基准用**现场重算**的候选(task 的副本已在上面比过一致性)
  const candidates = authSrc.candidates;
  const answeredYes = [];
  if (shape.ok) {
    const want = new Set(candidates.map((c) => c.candidateId));
    const answered = new Map();
    for (const a of arr(shape.ok, output.escapeAssessment)) {
      if (!want.has(a.candidateId) || answered.has(a.candidateId)) { flags.escapeAssessmentMismatch = true; continue; }
      answered.set(a.candidateId, a);
    }
    if (answered.size !== want.size) flags.escapeAssessmentMismatch = true;
    if (!flags.escapeAssessmentMismatch) answeredYes.push(...[...answered.values()].filter((a) => a.verdict === 'yes'));
  }

  // ── ledger 应用(shape ok 才应用;disposition 验真失败 = 整轮 invalid)──
  let entries = ledger.entries;
  let ledgerErrors = [];
  if (shape.ok) {
    const applied = applyReviewOutput({
      entries, output, seat: mode, snapshot,
      preflightHits: preflightIncomplete ? [] : (preflight.hits ?? []),
      executedRules: preflightIncomplete ? [] : (preflight.executedRules ?? []),
    });
    entries = applied.entries;
    ledgerErrors = applied.errors;
  }
  const confirmFile = argOf('--confirm');
  if (confirmFile && existsSync(confirmFile)) {
    let confirmations = null;
    try {
      confirmations = readJson(confirmFile);
      if (!Array.isArray(confirmations)) throw new Error('confirm 文件须是数组');
    } catch (e) { bail('invalid', [`confirm 文件不可用:${e.message}(fail-closed)`]); }
    for (const c of confirmations) {
      const r = applyInteractiveConfirmation({ entries, confirmation: { ...c, snapshotHash: snapshot.snapshotHash }, mode });
      if (r.error) ledgerErrors.push(r.error);
      else entries = r.entries;
    }
  }
  const dispositioned = new Set((arr(shape.ok, output.findingDispositions)).map((d) => d.findingId));
  if (shape.ok && injectedOpenIds.some((id) => !dispositioned.has(id) && entries.find((e) => e.findingId === id && isEffectiveOpen(e, snapshot.snapshotHash)))) {
    flags.missingDispositions = true;
  }

  const ledgerResult = summarize(entries, snapshot.snapshotHash);
  // 注意:deliveryReasons **不进** shapeAll——shape 不 ok 时 deriveVerdict 会提前返回,
  // 那样其余 flag 标签(preflight 未完成之类)就看不见了。投递缺口只经 flag 表达,细节
  // 单独打印。
  const mkVerdict = () => {
    const shapeAll = {
      ok: shape.ok && ledgerErrors.length === 0 && taskErrors.length === 0,
      errors: [...shape.errors, ...ledgerErrors, ...taskErrors],
    };
    return deriveVerdict({ shape: shapeAll, output, ledgerResult, flags });
  };

  // ── 逃逸登记:**必须晚于** provisional verdict(第 2 轮核验:此前在 flags/verdict 成型前
  // 就写 pending inbox,coverage/required/task 任一 invalid 时仍留下 durable state)。
  // originHead 也必须现场取到完整 40 位 SHA——此前硬编码 null,verifyActivation 的 origin
  // OID 门只在 non-null 时比对,于是被完全旁路。
  const provisional = mkVerdict();
  const registeredHazards = [];
  if (provisional.verdict !== 'invalid' && answeredYes.length > 0) {
    try {
      const inbox = loadInbox(STATE_DIR);
      if (!inbox.ok) throw new Error(`inbox 不可读:${inbox.error}`);
      const items = [...inbox.items];
      const paths = [...new Set((snapshot.files ?? []).map((f) => f.newPath ?? f.oldPath).filter(Boolean))];
      const repoSlug = task.repo ?? null;
      if (!repoSlug) throw new Error('task.repo 缺失(hazard 必须绑定仓库)');
      for (const a of answeredYes) {
        const cand = candidates.find((c) => c.candidateId === a.candidateId);
        let originHead = null;
        // REVIEW_PR_ORIGIN_HEAD_MAP:**测试专用 seam**(同 REVIEW_PR_VENDOR_TS_DIR 的定位),
        // JSON `{"<prNumber>":"<40hex>"}`。生产不设此变量,一律现场 gh 取。
        const seam = process.env.REVIEW_PR_ORIGIN_HEAD_MAP;
        if (seam) {
          try { originHead = String(JSON.parse(seam)[String(cand.referencedPr)] ?? '').toLowerCase(); } catch { originHead = ''; }
        } else {
          try {
            const v = ghJson(['pr', 'view', String(cand.referencedPr), '--repo', repoSlug, '--json', 'headRefOid']);
            originHead = (v.headRefOid ?? '').toLowerCase();
          } catch (e) { throw new Error(`取 origin PR #${cand.referencedPr} 的 head 失败:${String(e.message ?? e).slice(0, 160)}`); }
        }
        if (!/^[0-9a-f]{40}$/.test(originHead)) throw new Error(`origin PR #${cand.referencedPr} 的 head 不是完整 40 位 SHA(${originHead || '空'})——激活核验的 origin OID 门不能留空`);
        const base = {
          repo: repoSlug, originPr: cand.referencedPr, originHead,
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
      registeredHazards.length = 0;
    }
  }

  const { verdict, reasons } = mkVerdict();
  const attempts = bumpAttempts(pr, snapshot.snapshotHash ?? 'snapshot-incomplete', verdict === 'invalid');
  const blocked = verdict === 'invalid' && attempts.count >= 3;

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
    writeReviewReceipt({ pr, headRefOid, verdict: 'dirty', p0p1Count: Array.isArray(output.findingFamilies) ? output.findingFamilies.length : 0, bindings: { ...bindings, reason: verdict } });
  }

  print({
    ok: true, pr, mode, verdict, reasons, blocked, deliveryReasons,
    attempts: attempts.count, snapshotHash: snapshot.snapshotHash, snapshotComplete: snapshot.complete,
    ledgerHash, effectiveOpenCount: ledgerResult.effectiveOpenCount, acceptedRiskCount: ledgerResult.acceptedRiskCount,
    injectedOpenIds, registeredHazards,
    authoritative: {
      coverageKeyCount: auth.coverageKeys.length, segmentCount: auth.segments.length,
      requiredProfileAnswerCount: auth.requiredProfileAnswers.length,
      requiredNegativeEvidenceKeyCount: auth.requiredNegativeEvidenceKeys.length,
      deliveredSegments: delivery.deliveries.length,
    },
  });
  process.exit(verdict === 'clean' ? 0 : 2);
} catch (e) {
  // 兜底:未预期异常同样不得让同 snapshot 的旧 clean 留着(第 3 轮核验 BLOCKER)。
  // FINALIZE 在 pr/snapshot 已知之后才被装上;装不上说明连 PR 号都没解析出来,那时不存在
  // "沿用上次清白"的风险(回执按 PR 号定位),照原样 fail 即可。
  if (FINALIZE) {
    try {
      FINALIZE('invalid', [`未预期异常:${String(e?.message ?? e).slice(0, 300)}(已撤销同 snapshot 旧 clean,fail-closed)`]);
    } catch { /* FINALIZE 自身失败 → 落到下面的 fail */ }
  }
  fail(e);
}
