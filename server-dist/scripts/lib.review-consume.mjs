#!/usr/bin/env node
// lib.review-consume.mjs — 审查输出的单一 JSON 契约校验 + 机器派生 verdict(SC-R1a,
// 2026-08-05 审查能力层加固,SC v4 共识)。纯函数模块:不碰网络/状态目录,只依赖
// lib.review-output-shape.mjs(family 形状校验与 invariantKey 的唯一实现)。
//
// 背景(#469):deepseek 审查正文写了保留意见,但下游只消费 APPROVED/REQUIRES_CHANGES
// 枚举——"审到了"被裁决结构丢掉。本模块把裁决权从模型自报收回机器:
//   - 输出必须是带 schemaVersion 的单一 JSON(废除"JSON 或等价 Markdown"双轨);
//   - verdict 只由内容推导(模型自报的 modelVerdictNote 仅供人读,机器不采信);
//   - verdict 建立在「应用并验真全部 disposition 之后的 ledger 结果」上(第 3 轮共识
//     修订——不以"本轮 family 存在性"单独定 dirty,防"历史 P1 打成 accepted-risk 且
//     本轮未重报 → 落 clean");
//   - 优先级 invalid > dirty > clean,clean 三条件:当前 P0/P1=0 ∧ effective-open=0
//     ∧ accepted-risk=0(effective-open 谓词由 findings ledger 模块计算后传入)。
//
// 同轮引用规则(第 2 轮共识):模型产出内的交叉引用(profileAnswer→finding、
// negativeEvidence→finding)用本地引用 {family_id, manifestationIndex}——findingId 由
// consumer 验真后机器派生,模型不算 hash;只有「历史 effective-open 的 disposition」
// 引用 build-review-task 注入的已有 findingId。
import { validateFindingFamily } from './lib.review-output-shape.mjs';

export const REVIEW_OUTPUT_SCHEMA_VERSION = 'rro-1';

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

const PROFILE_ANSWERS = ['checked-clean', 'finding', 'not-applicable'];
// accepted-risk 不在模型可产出的 disposition 闭集里——它只接交互编排的独立确认输入
// (consumer 的交互通道,SC-R1a),模型 JSON 里出现即 schema 非法。
const DISPOSITIONS = ['resolved', 'invalidated'];
const NEGATIVE_KINDS = ['executed', 'not-applicable'];
// R6:executed 的 observedSignal 闭集——机器只认"预期失败被观察到"这一个值;其余
// 一律不构成负向证据(诚实边界:一致伪报是 T1 上限,机器验的是声明一致性,见 SKILL)。
const OBSERVED_SIGNALS = ['expected-failure-observed'];
// not-applicable 的 reasonCode 闭集(SC-R6 复审:自由文本 reasonCode 等于没有闭集)
export const NA_REASON_CODES = ['doc-only', 'comment-only', 'generated-file', 'pure-rename', 'config-value-only', 'not-a-test-oracle'];

/**
 * 校验审查输出的单一 JSON 契约(SC-R1a)。只做**输出自身内**可机械判定的检查:
 * 形状、闭集、唯一性、同轮本地引用可解析、disposition 只引用已注入的历史 open ID。
 * 与外部世界的对账(覆盖 manifest、required negative keys、snapshot 一致性)由
 * consumer CLI 算好后经 deriveVerdict 的 flags 进入 verdict——不在这里重复。
 *
 * @param {object} output 解析后的 JSON 对象
 * @param {object} ctx { injectedOpenIds: string[] } build-review-task 注入的历史 effective-open findingId 清单
 * @param {string[]} ctx.expectedPrescanObservationIds SC-5.1:consumer 现场重算的、
 *   本轮**已投递**的 prescan observationId 全集(未 enabled 或无 observation 时为空数组)。
 *   每一个都要求恰好一条 prescanAssessments 条目——多退少补都判非法。
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateReviewOutput(output, { injectedOpenIds = [], snapshotHash = null, expectedPrescanObservationIds = [], shapeOnly = false } = {}) {
  const errors = [];
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, errors: ['输出不是 JSON 对象'] };
  }
  // 顶层 snapshotHash **必需且必须等于当前**(第 3 轮核验 BLOCKER):此前答卷本身不绑
  // snapshot,于是"base 前进但 diff 与 coverage key 完全相同"时,把旧答卷原样重放就能
  // 再拿一次 clean(实测 exit=0)。consumer 侧重算 task/preflight 挡不住这条——那验的是
  // "任务与快照",不是"这份答卷属于这个快照"。
  // shapeOnly(consume --shape-preflight):只验字段存在,不拿注入清单/预扫 ID 对账;
  // 仍要求顶层 snapshotHash 非空,避免缺绑定字段被误报通过。
  if (shapeOnly || snapshotHash != null) {
    if (!isStr(output.snapshotHash)) {
      errors.push('顶层缺 snapshotHash(答卷必须绑定它所审的那个 snapshot)');
    } else if (typeof snapshotHash === 'string' && snapshotHash && output.snapshotHash !== snapshotHash) {
      errors.push(`顶层 snapshotHash 不是当前 snapshot(答卷=${output.snapshotHash},当前=${snapshotHash})——旧答卷不得跨 snapshot 重放`);
    }
  }
  if (output.schemaVersion !== REVIEW_OUTPUT_SCHEMA_VERSION) {
    errors.push(`schemaVersion 缺失或不受支持(需 ${REVIEW_OUTPUT_SCHEMA_VERSION},got ${JSON.stringify(output.schemaVersion)})`);
  }

  // ── findingFamilies:逐条复用唯一形状校验(真正接线 validateFindingFamily——此前
  // 生产路径零调用,是复审点名的"有 schema 资产但审查输出→判定仍是过程约定")──
  const families = output.findingFamilies;
  if (!Array.isArray(families)) {
    errors.push('findingFamilies 缺失或非数组(无 finding 也必须是空数组,不允许省略)');
  } else {
    families.forEach((f, i) => {
      const r = validateFindingFamily(f);
      if (!r.ok) errors.push(...r.errors.map((e) => `findingFamilies[${i}]: ${e}`));
    });
  }
  const familyRefOk = (ref) => {
    if (!ref || typeof ref !== 'object') return false;
    if (!Array.isArray(families)) return false;
    const fam = families.find((f) => f && f.family_id === ref.family_id);
    if (!fam || !Array.isArray(fam.manifestations)) return false;
    return isInt(ref.manifestationIndex) && ref.manifestationIndex >= 0 && ref.manifestationIndex < fam.manifestations.length;
  };

  // ── verificationGaps ──
  const gaps = output.verificationGaps;
  if (!Array.isArray(gaps)) {
    errors.push('verificationGaps 缺失或非数组');
  } else {
    gaps.forEach((g, i) => {
      if (!g || typeof g !== 'object' || !isStr(g.description) || typeof g.required !== 'boolean') {
        errors.push(`verificationGaps[${i}] 形状非法(需 {description 非空, required 布尔})`);
      }
    });
  }

  // ── verificationRuns:runId 唯一(R6 的 negativeEvidence 引用对象)──
  const runs = output.verificationRuns;
  const runIds = new Set();
  if (!Array.isArray(runs)) {
    errors.push('verificationRuns 缺失或非数组');
  } else {
    runs.forEach((r, i) => {
      if (!r || typeof r !== 'object' || !isStr(r.runId) || !isStr(r.command) || !isInt(r.exitCode) || !(isStr(r.outputDigest) || isStr(r.outputAnchor))) {
        errors.push(`verificationRuns[${i}] 形状非法(需 {runId, command, exitCode, outputDigest|outputAnchor})`);
        return;
      }
      if (runIds.has(r.runId)) errors.push(`verificationRuns[${i}].runId 重复:${r.runId}`);
      runIds.add(r.runId);
    });
  }

  // ── profileAnswers:(profileId,fileId,checkId) 粒度 + 答案闭集 + 本地引用验真 ──
  const answers = output.profileAnswers;
  if (!Array.isArray(answers)) {
    errors.push('profileAnswers 缺失或非数组');
  } else {
    const seen = new Set();
    answers.forEach((a, i) => {
      if (!a || typeof a !== 'object' || !isStr(a.profileId) || !isStr(a.fileId) || !isStr(a.checkId)) {
        errors.push(`profileAnswers[${i}] 缺 profileId/fileId/checkId`);
        return;
      }
      const key = `${a.profileId}\u0000${a.fileId}\u0000${a.checkId}`;
      if (seen.has(key)) errors.push(`profileAnswers[${i}] 重复作答(${a.profileId}/${a.fileId}/${a.checkId})——重复不计入补足`);
      seen.add(key);
      if (!PROFILE_ANSWERS.includes(a.answer)) {
        errors.push(`profileAnswers[${i}].answer 非法(闭集 ${PROFILE_ANSWERS.join('|')})`);
      } else if (a.answer === 'checked-clean' && !isStr(a.hunkId)) {
        errors.push(`profileAnswers[${i}] checked-clean 必须引用当前 diff 的 hunkId`);
      } else if (a.answer === 'finding' && !familyRefOk(a.findingRef)) {
        errors.push(`profileAnswers[${i}] finding 的本地引用 {family_id, manifestationIndex} 无对应 finding 条目`);
      } else if (a.answer === 'not-applicable' && !(isStr(a.reasonCode) && isStr(a.explanation))) {
        errors.push(`profileAnswers[${i}] not-applicable 需 reasonCode+explanation`);
      }
    });
  }

  // ── findingDispositions:只允许引用已注入的历史 open findingId ──
  const dispositions = output.findingDispositions;
  if (!Array.isArray(dispositions)) {
    errors.push('findingDispositions 缺失或非数组');
  } else {
    const injected = new Set(injectedOpenIds);
    const seen = new Set();
    dispositions.forEach((d, i) => {
      if (!d || typeof d !== 'object' || !isStr(d.findingId) || !DISPOSITIONS.includes(d.disposition)) {
        errors.push(`findingDispositions[${i}] 形状非法(需 {findingId, disposition∈${DISPOSITIONS.join('|')}})`);
        return;
      }
      if (!shapeOnly && !injected.has(d.findingId)) errors.push(`findingDispositions[${i}].findingId 未在本轮注入的 open 清单里(${d.findingId})——disposition 只能核销注入项`);
      if (seen.has(d.findingId)) errors.push(`findingDispositions[${i}] 对 ${d.findingId} 重复 disposition`);
      seen.add(d.findingId);
      if (d.disposition === 'resolved') {
        // SC-R5 复审:evidence 不能只是"非空字符串"(`evidence:"x"` 就能关账 = 只验形状)。
        // 必须是结构化 union 之一,且绑定当前 snapshot 的**具体对象**:
        //   {kind:'diff-anchor', snapshotHash, fileId, hunkId, note}
        //   {kind:'verification-run', snapshotHash, verificationRunId, note}
        const e = d.evidence;
        const okKind = e && typeof e === 'object' && ['diff-anchor', 'verification-run'].includes(e.kind);
        if (!okKind) {
          errors.push(`findingDispositions[${i}] resolved 的 evidence 必须是结构化 {kind:'diff-anchor'|'verification-run', ...},不接受自由文本`);
        } else if (!isStr(e.snapshotHash)) {
          errors.push(`findingDispositions[${i}] resolved evidence 缺 snapshotHash(必须绑定当前 snapshot)`);
        } else if (e.kind === 'diff-anchor' && !(isStr(e.fileId) && isStr(e.hunkId))) {
          errors.push(`findingDispositions[${i}] diff-anchor 需 fileId+hunkId(指向当前 diff 的具体改动)`);
        } else if (e.kind === 'verification-run' && !(isStr(e.verificationRunId) && runIds.has(e.verificationRunId))) {
          errors.push(`findingDispositions[${i}] verification-run 的 verificationRunId 悬空`);
        }
      }
      if (d.disposition === 'invalidated' && !isStr(d.basis)) {
        errors.push(`findingDispositions[${i}] invalidated 必须带判误报依据(basis)`);
      }
    });
  }

  // ── segmentReceipts(SC-R4):进顶层 schema,逐段 coverageKeys 形状与去重(转 Set 前
  // 就拒重复——否则同段内重复 key 被 Set 静默折叠后仍能"精确相等")──
  const receipts = output.segmentReceipts;
  if (!Array.isArray(receipts)) {
    errors.push('segmentReceipts 缺失或非数组(无分片也必须是空数组)');
  } else {
    const segIds = new Set();
    receipts.forEach((r, i) => {
      if (!r || typeof r !== 'object' || !isStr(r.segmentId) || !Array.isArray(r.coverageKeys)) {
        errors.push(`segmentReceipts[${i}] 形状非法(需 {segmentId, coverageKeys[]})`);
        return;
      }
      // 顺序投递协议(SC-R4):必须自报投递序号(与 task.segments[].order 对账)
      if (!isInt(r.receivedOrder) || r.receivedOrder < 1) {
        errors.push(`segmentReceipts[${i}] 缺 receivedOrder(投递序号,正整数)——分段审查必须自报本段是第几次投递`);
      }
      // 每段回执也绑 snapshot(第 3 轮核验:整份答卷重放之外,还要挡"混用不同 snapshot 的
      // 分段回执"这种拼装)
      if (typeof snapshotHash === 'string' && snapshotHash && r.snapshotHash !== snapshotHash) {
        errors.push(`segmentReceipts[${i}] 的 snapshotHash 不是当前 snapshot(${r.snapshotHash ?? '缺'})`);
      }
      if (segIds.has(r.segmentId)) errors.push(`segmentReceipts[${i}] segmentId 重复:${r.segmentId}`);
      segIds.add(r.segmentId);
      const seen = new Set();
      r.coverageKeys.forEach((k, j) => {
        if (!k || typeof k !== 'object' || !['hunk', 'file'].includes(k.kind) || !isStr(k.fileId)) {
          errors.push(`segmentReceipts[${i}].coverageKeys[${j}] 形状非法(kind∈hunk|file 且需 fileId)`);
          return;
        }
        if (k.kind === 'hunk' && !isStr(k.hunkId)) {
          errors.push(`segmentReceipts[${i}].coverageKeys[${j}] hunk key 缺 hunkId`);
          return;
        }
        const str = k.kind === 'hunk' ? `hunk:${k.fileId}:${k.hunkId}` : `file:${k.fileId}`;
        if (seen.has(str)) errors.push(`segmentReceipts[${i}] 段内重复 coverage key:${str}(重复不构成覆盖)`);
        seen.add(str);
      });
    });
  }

  // ── negativeEvidence:结构闭集 + verificationRunId 引用存在 ──
  const negatives = output.negativeEvidence;
  if (!Array.isArray(negatives)) {
    errors.push('negativeEvidence 缺失或非数组');
  } else {
    negatives.forEach((n, i) => {
      if (!n || typeof n !== 'object' || !isStr(n.fileId) || !NEGATIVE_KINDS.includes(n.kind)) {
        errors.push(`negativeEvidence[${i}] 形状非法(需 {fileId, kind∈${NEGATIVE_KINDS.join('|')}})`);
        return;
      }
      if (n.kind === 'executed') {
        if (!(isStr(n.snapshotHash) && isStr(n.command) && isStr(n.negativeOracle) && isStr(n.outputAnchor))) {
          errors.push(`negativeEvidence[${i}] executed 缺 snapshotHash/command/negativeOracle/outputAnchor`);
        }
        if (!OBSERVED_SIGNALS.includes(n.observedSignal)) {
          errors.push(`negativeEvidence[${i}].observedSignal 非法(闭集,必须 ${OBSERVED_SIGNALS[0]})`);
        }
        if (!isStr(n.verificationRunId) || !runIds.has(n.verificationRunId)) {
          errors.push(`negativeEvidence[${i}].verificationRunId 悬空(必须引用 verificationRuns 里存在的 runId)`);
        }
      } else if (!(NA_REASON_CODES.includes(n.reasonCode) && isStr(n.explanation))) {
        errors.push(`negativeEvidence[${i}] not-applicable 需 reasonCode∈${NA_REASON_CODES.join('|')} + explanation`);
      }
      // 可选的 finding 交叉引用(同轮本地引用,SC-R1a)
      if (n.findingRef !== undefined && !familyRefOk(n.findingRef)) {
        errors.push(`negativeEvidence[${i}].findingRef 无对应 finding 条目(需本地引用 {family_id, manifestationIndex})`);
      }
    });
  }

  // ── escapeAssessment(R7 生产触发):候选逐项 yes/no+依据;候选清单由构建器注入,
  // 这里只验形状(候选集对账在 consumer CLI,经 flags 进 verdict)──
  const esc = output.escapeAssessment;
  if (!Array.isArray(esc)) {
    errors.push('escapeAssessment 缺失或非数组(无候选也必须是空数组)');
  } else {
    esc.forEach((e, i) => {
      if (!e || typeof e !== 'object' || !isStr(e.candidateId) || !['yes', 'no'].includes(e.verdict) || !isStr(e.basis)) {
        errors.push(`escapeAssessment[${i}] 形状非法(需 {candidateId, verdict∈yes|no, basis})`);
      }
    });
  }

  // ── prescanAssessments(SC-5.1):每个已投递的 prescan observation 恰好一条 assessment。
  // observation 本身不直接驱动 dirty——只有 disposition=finding 引用的真实 finding
  // family 才计;dismissed 必须有非空 basis。expectedPrescanObservationIds 为空数组
  // (disabled/skipped/failed/complete-empty)时不要求任何 assessment(SC-5.2)。 ──
  const assessments = output.prescanAssessments;
  if (expectedPrescanObservationIds.length > 0 || assessments !== undefined) {
    if (!Array.isArray(assessments)) {
      errors.push('prescanAssessments 缺失或非数组(本轮有已投递的预扫观察,必须逐条 disposition)');
    } else {
      const expected = new Set(expectedPrescanObservationIds);
      const seen = new Set();
      assessments.forEach((a, i) => {
        if (!a || typeof a !== 'object' || !isStr(a.observationId) || !['finding', 'dismissed'].includes(a.disposition)) {
          errors.push(`prescanAssessments[${i}] 形状非法(需 {observationId, disposition∈finding|dismissed})`);
          return;
        }
        if (!shapeOnly && !expected.has(a.observationId)) errors.push(`prescanAssessments[${i}].observationId 未在本轮已投递的预扫观察清单里(${a.observationId})`);
        if (seen.has(a.observationId)) errors.push(`prescanAssessments[${i}] 对 ${a.observationId} 重复 disposition`);
        seen.add(a.observationId);
        if (a.disposition === 'finding' && !familyRefOk(a.findingRef)) {
          errors.push(`prescanAssessments[${i}] finding 的本地引用 {family_id, manifestationIndex} 无对应 finding 条目`);
        }
        if (a.disposition === 'dismissed' && !isStr(a.basis)) {
          errors.push(`prescanAssessments[${i}] dismissed 必须带非空 basis(核实后判定非真实问题的依据)`);
        }
      });
      for (const id of expectedPrescanObservationIds) {
        if (!seen.has(id)) errors.push(`预扫观察 ${id} 缺 disposition(本轮已投递的观察必须逐条作答)`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * verdict 派生(SC-R1a,v4 闭合公式)。输入全部由 consumer CLI 备好:
 *   - shape:validateReviewOutput 的结果;
 *   - output:解析后的输出(取 findingFamilies 的当前 P0/P1 与 required gaps);
 *   - ledgerResult:findings ledger **应用并验真全部 disposition 之后**的结果
 *     { effectiveOpenCount, acceptedRiskCount }(effective-open 谓词属 SC-R5:
 *     open ∪ 未经交互确认的 invalidated ∪ stale accepted-risk);
 *   - flags:外部对账结论 { preflightIncomplete, profileConfigIncomplete,
 *     snapshotMismatch, coverageMismatch, requiredNegativeKeysMissing,
 *     missingProfileAnswers, missingDispositions }(任一 true → invalid)。
 *
 * 优先级 invalid > dirty > clean;clean = 当前 P0/P1=0 ∧ effective-open=0 ∧
 * accepted-risk=0。accepted-risk 恒非 clean——带风险合并只走既有 head-bound 授权
 * 旁路,普通 clean receipt 永不因 accepted-risk 成立。模型自报 verdict 恒不采信。
 *
 * @returns {{ verdict: 'invalid'|'dirty'|'clean', reasons: string[] }}
 */
export function deriveVerdict({ shape, output, ledgerResult, flags = {} }) {
  const reasons = [];
  if (!shape?.ok) {
    reasons.push(...(shape?.errors ?? ['schema 校验结果缺失(fail-closed)']));
    return { verdict: 'invalid', reasons };
  }
  const requiredGaps = (output.verificationGaps ?? []).filter((g) => g?.required === true);
  if (requiredGaps.length > 0) reasons.push(`required verificationGap 非空(${requiredGaps.length} 条)`);
  for (const [flag, label] of [
    ['preflightIncomplete', 'preflight 未完成(引擎/parser 失败,不得据"无命中"放行)'],
    ['profileConfigIncomplete', '目标仓 riskProfiles 配置非法(声明过的高危检查不允许被悄悄摘掉)'],
    ['snapshotMismatch', 'snapshot 漂移(输出绑定的 snapshotHash ≠ 当前)'],
    ['coverageMismatch', '覆盖对账不符(coverage keys 集合不相等)'],
    ['requiredNegativeKeysMissing', 'required negative-evidence key 未被 executed 条目满足'],
    ['missingProfileAnswers', '命中 profile 的必答项缺失'],
    ['missingDispositions', '已注入的历史 open findingId 缺 disposition'],
    ['taskInvalid', 'task 文件缺失/不符当前 snapshot/字段不全(没有它无法对账,fail-closed)'],
    ['segmentOrderMismatch', '分段回执的 receivedOrder 与 task 的投递顺序不符(缺段/乱序/未投递却声称覆盖)'],
    ['staleProfileAnchor', 'checked-clean 引用了不属于当前 snapshot 的 hunkId(stale/编造锚点不计作答)'],
    ['negativeEvidenceInconsistent', 'negativeEvidence 与其引用的 verificationRun 声明不一致(command/outputAnchor 不符)'],
    ['classifierIncomplete', 'required 负向证据分类器未完成(无法确定哪些 hunk 必须给证据)'],
    ['escapeAssessmentMismatch', 'escapeAssessment 未逐条覆盖 task 注入的候选集(缺/未知/重复)'],
    ['hazardRegisterFailed', '逃逸候选判 yes 但登记 pending 失败(登记不可用时不得放行)'],
    ['segmentsNotDelivered', '分段投递台账缺失/有缺口/与回执不符(必须经 deliver-review-segment 逐段投递;宿主投不完即不得判 clean)'],
  ]) {
    if (flags[flag] === true) reasons.push(label);
  }
  if (reasons.length > 0) return { verdict: 'invalid', reasons };

  if (ledgerResult == null || !Number.isInteger(ledgerResult.effectiveOpenCount) || !Number.isInteger(ledgerResult.acceptedRiskCount)) {
    return { verdict: 'invalid', reasons: ['ledger 结果缺失/非法(fail-closed:verdict 必须建立在 disposition 后的 ledger 结果上)'] };
  }
  const p0p1 = Array.isArray(output.findingFamilies) ? output.findingFamilies.length : 0; // 非数组已在 shape 层判 invalid,这里只保证不抛
  const dirtyReasons = [];
  if (p0p1 > 0) dirtyReasons.push(`本轮存在 ${p0p1} 个 P0/P1 family`);
  if (ledgerResult.effectiveOpenCount > 0) dirtyReasons.push(`disposition 应用后 effective-open=${ledgerResult.effectiveOpenCount}`);
  if (ledgerResult.acceptedRiskCount > 0) dirtyReasons.push(`存在 accepted-risk=${ledgerResult.acceptedRiskCount}(恒非 clean,带风险合并只走既有授权旁路)`);
  if (dirtyReasons.length > 0) return { verdict: 'dirty', reasons: dirtyReasons };
  return { verdict: 'clean', reasons: ['当前 P0/P1=0 ∧ effective-open=0 ∧ accepted-risk=0'] };
}
