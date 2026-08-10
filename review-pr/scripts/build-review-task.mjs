#!/usr/bin/env node
// build-review-task.mjs — 阶段二审查任务的**唯一**构建器(SC-R3/R4/R6/R7,2026-08-05)。
//
// 为什么必须唯一:profile 必答项、覆盖分片、历史 open findings、known hazards 若各处
// 自己拼 prompt,机器就无法对账"问过了没有、覆盖分配给谁了"。本脚本产出两份物:
//   1. task JSON(机器契约,给 consume-review-output 对账用);
//   2. prompt.md(投给审查 agent 的任务正文——check IDs / open findingIds / hazard 文本
//      真出现在里面,测试断言的是**构建产物文本**,不是"context 有字段"这种假绿)。
//
// 用法:
//   node build-review-task.mjs <PR> --base <baseOid> --head <headOid> \
//     --out-task <task.json> --out-prompt <prompt.md> [--preflight <pf.json>]
// 退出码:0 = 构建完成(注意 task.snapshotComplete/profileConfigIncomplete 仍可能为真,
// 它们会让本轮 consume 判 invalid);1 = 脚本自身错误。
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import process from 'node:process';
import { print, fail, REPO_ROOT, STATE_DIR, loadRules, parseRepo, ghJson } from './lib.mjs';
import { buildDiffSnapshot } from './lib.diff-snapshot.mjs';
import {
  computeReviewRequirements, coverageCommitment, profileAnswersCommitment, negativeEvidenceCommitment,
} from './lib.review-requirements.mjs';
import { loadLedger, ledgerPathFor, isEffectiveOpen } from './lib.findings-ledger.mjs';
import { loadKnownHazards, hazardsForPaths, resolveEscapeSources, escapeSourceHash, knownHazardsHash } from './lib.escaped-hazards.mjs';
import { REVIEW_OUTPUT_SCHEMA_VERSION } from './lib.review-consume.mjs';
import { validatePrescanConfig, readPrescanArtifact } from './lib.prescan.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };

try {
  const pr = Number(process.argv[2]);
  if (!Number.isInteger(pr) || pr <= 0) fail(new Error('缺 <PR>'));
  const baseRefOid = (argOf('--base') ?? '').toLowerCase();
  const headOid = (argOf('--head') ?? '').toLowerCase();
  const outTask = argOf('--out-task');
  const outPrompt = argOf('--out-prompt');

  // SC-R8 复审:PR files 元数据与 patch 集互检在生产可达——调用方可传 --expected-paths
  // (逗号分隔,来自 `gh pr view --json files`);不一致/截断即 complete=false,fail-closed。
  const expectedPathsArg = argOf('--expected-paths');
  const expectedPaths = expectedPathsArg ? expectedPathsArg.split(',').map((x) => x.trim()).filter(Boolean) : null;
  const snapshot = buildDiffSnapshot({ repoRoot: REPO_ROOT, baseRefOid, headOid, expectedPaths });
  const rules = loadRules();
  // 权威推导唯一实现(SC-R1a 第 2 轮核验):consumer 用同一函数重算并与本 task 逐组比对,
  // task 文件不再是 coverage / 必答 / required 的可信来源。
  const req = computeReviewRequirements({ repoRoot: REPO_ROOT, snapshot, rules });
  const { profiles, warnings, configIncomplete, coverageKeys, segments, requiredProfileAnswers, requiredNegativeEvidenceKeys } = req;
  const files = snapshot.complete ? snapshot.files : [];
  const classified = req.classifier;

  const ledger = loadLedger(ledgerPathFor(STATE_DIR, pr));
  const injectedOpen = ledger.ok
    ? ledger.entries.filter((e) => isEffectiveOpen(e, snapshot.snapshotHash))
    : [];
  const hazards = loadKnownHazards();
  const changedPaths = files.map((f) => f.newPath ?? f.oldPath).filter(Boolean);
  const repoSlug = (() => { try { const { owner, repo } = parseRepo(); return `${owner}/${repo}`; } catch { return null; } })();
  const relevantHazards = hazardsForPaths(hazards, changedPaths, repoSlug);
  // SC-R7 生产触发链(第 2 轮核验 BLOCKER):此前 `--pr-body-file` 是**可选**参数,生产
  // SKILL 命令又没传 → 候选集恒空,consumer 也允许空 → 真实链条永远不产生逃逸候选。
  // 现在数据源**必需且绑定**:默认由本脚本自己现场取(PR body + 关联 issue),取不到即
  // escapeSourceIncomplete → consumer 判 taskInvalid;文件参数只作离线/测试 seam。
  const prBodyArg = argOf('--pr-body-file');
  const issuesArg = argOf('--related-issues-file');
  const src = resolveEscapeSources({
    pr, repoSlug, bodyFile: prBodyArg, issuesFile: issuesArg, ghJson, readFileSync, existsSync,
  });
  const escapeSourceErrors = src.errors;
  const issueTexts = src.issueTexts;
  const escapeCandidates = src.candidates;

  const task = {
    schemaVersion: REVIEW_OUTPUT_SCHEMA_VERSION,
    pr,
    snapshotHash: snapshot.snapshotHash,
    snapshotComplete: snapshot.complete,
    profileSetHash: req.profileSetHash,
    profileConfigIncomplete: configIncomplete,
    profileWarnings: warnings,
    ledgerReadable: ledger.ok,
    ledgerHash: ledger.ok ? ledger.ledgerHash : null,
    injectedOpenIds: injectedOpen.map((e) => e.findingId),
    // coverage key 明细**不进 task**(第 3 轮核验:prompt 藏了 key 但 task.json 还在,
    // 自己跑一遍 builder 读文件就绕过投递出口)。只给计数与内容承诺,明细由投递出口按序给。
    coverageKeyCount: coverageKeys.length,
    coverageCommitment: coverageCommitment(coverageKeys),
    segments: segments.map((seg) => ({
      segmentId: seg.segmentId, order: seg.order, keyCount: seg.assignedCoverageKeys.length,
      commitment: coverageCommitment(seg.assignedCoverageKeys), sizeBudget: seg.sizeBudget,
    })),
    // 必答项与负向 key 的明细同样不进 task(第 4 轮核验 BLOCKER:requiredNegativeEvidenceKeys
    // 的 {fileId,hunkId} 本身就是 coverage hunk key;必答项的 fileId 是 file key)。
    // 明细随对应分段由投递出口给出;这里只留计数 + 内容承诺供 consumer 对账。
    requiredProfileAnswerCount: requiredProfileAnswers.length,
    profileAnswersCommitment: profileAnswersCommitment(requiredProfileAnswers),
    requiredNegativeEvidenceKeyCount: requiredNegativeEvidenceKeys.length,
    negativeEvidenceCommitment: negativeEvidenceCommitment(requiredNegativeEvidenceKeys),
    knownHazards: relevantHazards,
    // repo 解析不出时 hazardsForPaths 会 fail-closed 返空——那等于静默跳过全部 known
    // hazard,必须显式标不完整(第 3 轮核验)。
    hazardsIncomplete: hazards.incomplete === true || repoSlug === null,
    classifierIncomplete: classified.incomplete,
    classifierIncompleteFiles: classified.incompleteFiles,
    repo: repoSlug,
    escapeCandidates,
    // SC-R7 第 4 轮核验:candidate/hazard 不只比 ID——全内容哈希,consumer 与 premerge
    // 都现场重算比对(同 id 内容漂移、clean 后 body/canonical 变化都要可检)。
    escapeSourceHash: escapeSourceHash({ prBody: src.prBody, issueTexts, candidates: escapeCandidates }),
    knownHazardsHash: knownHazardsHash(relevantHazards),
    escapeSourceIncomplete: escapeSourceErrors.length > 0,
    escapeSourceErrors,
    escapeSourceKind: src.kind,
    relatedIssueCount: issueTexts.length,
  };

  // SC-R1/R8: prescan 配置门——enabled:false/缺失时 task 不含 prescan 字段(关闭态兼容,
  // 输出与基线逐字节一致)。enabled:true 且配置合法时,读取 pre-scan.mjs 已产出的 artifact
  // (若已运行)并填入 task.prescan 承诺字段。artifact 缺失或 snapshot 漂移时不填
  // (consumer 侧 SC-R8 会判 taskInvalid:enabled 但 task 缺 prescan → invalid)。
  const prescanCfg = validatePrescanConfig(rules?.prescan);
  if (prescanCfg.enabled && prescanCfg.valid) {
    const prescanArtifact = readPrescanArtifact(STATE_DIR, pr);
    if (prescanArtifact && prescanArtifact.snapshotHash === snapshot.snapshotHash) {
      task.prescan = {
        schemaVersion: prescanArtifact.schemaVersion,
        status: prescanArtifact.status,
        snapshotHash: prescanArtifact.snapshotHash,
        inputHash: prescanArtifact.inputHash,
        policyHash: prescanArtifact.policyHash,
        artifactHash: prescanArtifact.artifactHash,
        observationCount: prescanArtifact.observationCount,
        reasonCode: prescanArtifact.reasonCode,
      };
    }
  }

  // ── prompt 正文:必答项 / open findings / hazards / 分片 全部落进文本 ──
  const L = [];
  L.push(`# 阶段二独立审查任务 — PR #${pr}`, '');
  L.push(`snapshotHash: \`${snapshot.snapshotHash ?? '(不完整)'}\` — 输出里的所有 snapshotHash 字段必须原样用它。`, '');
  L.push(`输出契约:单一 JSON,\`schemaVersion: "${REVIEW_OUTPUT_SCHEMA_VERSION}"\`。机器只消费 JSON,你自报的 verdict 不被采信(verdict 由内容推导)。`, '');
  // 字段级形状参考(2026-08-07 轮次实跑:审查输出与 rro-1 契约的格式偏差导致整轮 invalid,
  // 主 agent 被迫手工规范化后才可消费——把 5 类已发生的偏差直接写进 prompt,降低格式往返):
  L.push('## 字段级形状(照此形状输出,逐字段精确,勿自创字段名)', '');
  L.push([
    '- `findingFamilies[]` 元素:字段名是 `family_id`(不是 familyId)+ `invariant` + `severity`("P0"|"P1")+ `manifestations[]` + `fixGuidance`;',
    '  每条 manifestation 必须是 `{path, line, severity, evidence, impact, fix, verification}`——`severity` 在 family 与每条 manifestation 都要显式给出。',
    '- `profileAnswers[]` 元素:`{profileId, fileId, checkId, answer, hunkId?, findingRef?, reasonCode?, explanation?}`——`answer` 是字符串闭集 `"checked-clean"|"finding"|"not-applicable"`(不是对象):',
    '  checked-clean 在顶层带 `hunkId`;finding 在顶层带 `findingRef: {family_id, manifestationIndex}`(引用上方 findingFamilies 的真实条目);not-applicable 在顶层带 `reasonCode` + `explanation`。',
    '- `segmentReceipts[].coverageKeys[]` 元素:对象 `{kind:"hunk", fileId, hunkId}`(不是 "fileId:hunkId" 字符串);',
    '  `receivedOrder` 必须等于投递序号,`snapshotHash` 必须等于顶层 snapshotHash。',
    '- `findingDispositions[]` 元素:`{findingId, disposition, evidence?, basis?}`——`disposition` 是闭集 `"resolved"|"invalidated"`(不是 status)。`resolved` 必须带结构化 `evidence`(自由文本不算),二选一:`{kind:"diff-anchor", snapshotHash, fileId, hunkId, note}`(锚当前 diff 的具体改动)或 `{kind:"verification-run", snapshotHash, verificationRunId, note}`(`verificationRunId` 必须存在于 `verificationRuns[]`);`invalidated` 必须带非空 `basis`(判误报依据)。**本轮未注入任何未决项(没有"未决 findings"段)时,本数组必须为 `[]`**——GitHub 上的第三方 bot thread(如 Greptile)不属于注入项,不要给它们写 disposition。',
    '- `negativeEvidence[]` 元素:`{fileId, hunkId, kind:"executed", snapshotHash, command, negativeOracle, observedSignal:"expected-failure-observed", outputAnchor, verificationRunId}`——',
    '  **`command` 与 `outputAnchor` 必须与 `verificationRuns[]` 里被引用 run 的对应字段逐字一致**(机器会做一致性校验,不一致判 invalid);`verificationRunId` 必须引用真实登记的 runId。',
    '- `verificationRuns[]` 元素:`{runId, command, exitCode(整数), outputAnchor}`——每条实验真实执行并登记。',
    '- `escapeAssessment[]` / `verificationGaps[]`:`{candidateId, verdict:"yes"|"no", basis}` / `{description, required:false}`。',
    '  **以下字段即使为空也必须作为数组包含:`verificationGaps`, `findingDispositions`, `profileAnswers`, `negativeEvidence`**(缺字段或传非数组,机器各自硬报错判 invalid)。',
  ].join('\n'), '');
  L.push('> 输出前逐字段自检一遍上述形状;格式偏差会导致整轮判 invalid,机器不会"尽力解析"。', '');
  if (relevantHazards.length > 0) {
    L.push('## 已知逃逸风险(known hazards — 本仓历史上真的逃过审查、事后被证伪的模式)', '');
    for (const h of relevantHazards) {
      L.push(`- \`${h.hazardId}\`:${h.pattern}(源自 PR #${h.originPr},由 #${h.fixPr} 证伪;命中路径 ${h.paths.join(' / ')})`);
    }
    L.push('', '这些模式在本次改动涉及的路径上出现过;逐条确认本 PR 是否重现——确认结论写进 `modelVerdictNote`(供人读),**不要**填进 `escapeAssessment[]`(该字段只覆盖逃逸候选集,见下方逃逸判定段)。', '');
  }
  if (injectedOpen.length > 0) {
    L.push('## 未决 findings(必须逐条 disposition,否则本轮判 invalid)', '');
    for (const e of injectedOpen) {
      L.push(`- \`${e.findingId}\` [${e.status}] ${e.path}:${e.line} — ${e.invariantKey ? '(invariantKey ' + e.invariantKey.slice(0, 22) + '…)' : ''} ${e.rule ? '规则 ' + e.rule.ruleId : ''}`);
    }
    L.push('', '在 `findingDispositions[]` 里对上面每个 findingId 给 `resolved`(带当前 snapshot 的证据锚点)或 `invalidated`(带判误报依据)。`accepted-risk` 不走你的输出,只走交互确认。', '');
    L.push('', '处置选择指引:对 originSnapshotHash 早于当前 snapshot 的**跨 snapshot 历史条目**,先查当前 head 是否已有修复证据(新增/改动代码、负向实测变红等)——**已修复给 `resolved`**,带当前 snapshot 的证据锚点;invalidated 只用于「该指控在当前 snapshot 上不成立且无修复动作」的误报主张。`invalidated` 在 auto 模式没有交互确认出口,不会关门,历史条目每轮都会重新注入——不要把"已修复"误判成"误报"。', '');
  }
  if (requiredProfileAnswers.length > 0) {
    L.push('## 风险 profile 必答项(逐 文件×检查 作答,缺一项判 invalid)', '');
    // 第 4 轮核验:fileId 明细不进 prompt(fileId 是 file coverage key 的全部内容)。
    // 这里只给 check 的语义(profileId/checkId/ask)与总数;哪些文件要答、其 fileId 是
    // 什么,随对应分段由投递出口给出。
    const byProfile = new Map();
    for (const r of requiredProfileAnswers) {
      if (!byProfile.has(r.profileId)) byProfile.set(r.profileId, new Map());
      const m = byProfile.get(r.profileId);
      if (!m.has(r.checkId)) m.set(r.checkId, r.ask);
    }
    for (const [profileId, checks] of byProfile) {
      L.push(`### profile \`${profileId}\``, '');
      for (const [checkId, ask] of checks) L.push(`- \`${checkId}\`:${ask}`);
      L.push('');
    }
    L.push(`本轮共 ${requiredProfileAnswers.length} 条 (profile × 文件 × 检查) 必答——具体文件与 fileId **随对应分段投递给出**。`);
    L.push('每条在 `profileAnswers[]` 里给 `{profileId, fileId, checkId, answer}`:`checked-clean`(带 hunkId)/ `finding`(带本地引用 `{family_id, manifestationIndex}`)/ `not-applicable`(带 reasonCode + explanation)。', '');
  }
  if (requiredNegativeEvidenceKeys.length > 0) {
    L.push('## 负向证据必答(required — 只能用 executed 满足,N/A 不接受)', '');
    // 第 4 轮核验 BLOCKER:此前这里逐项打印 {path, hunkId, fileId}——fileId/hunkId 正是
    // coverage hunk key,拿它就能伪造 segmentReceipts 绕过投递出口。只留计数。
    L.push(`本轮共 ${requiredNegativeEvidenceKeys.length} 处改动触及等待原语/断言/守卫——具体位置(path/fileId/hunkId/原因)**随对应分段投递给出**。`);
    L.push('', '对每处在 `negativeEvidence[]` 里给 `{fileId, hunkId, kind:"executed", snapshotHash, command, negativeOracle, observedSignal:"expected-failure-observed", outputAnchor, verificationRunId}`,并在 `verificationRuns[]` 里登记对应 run。也就是:**把它弄坏一次,证明它真的会红**。', '');
  }
  // SC-4.1: prescan 状态声明——只给状态+总数,不含 observation 明细(明细随对应分段
  // 由 deliver-review-segment.mjs 给出,与必答项/负向证据同一纪律)。
  if (task.prescan) {
    L.push('## 预扫标注(advisory,不构成 finding)', '');
    if (task.prescan.status === 'complete' && task.prescan.observationCount > 0) {
      L.push(`本轮预扫状态 \`${task.prescan.status}\`,共 ${task.prescan.observationCount} 条 advisory 观察——具体内容**随对应分段投递给出**。`, '');
      L.push('每条已投递的观察必须在 `prescanAssessments[]` 里给 `{observationId, disposition, findingRef?, basis}`:`finding`(带本地引用 `{family_id, manifestationIndex}`,该观察确认为真实问题并已计入上方 findingFamilies)或 `dismissed`(带 basis,核实后判定非真实问题)。预扫观察本身**不直接构成** finding,也不驱动 dirty——只有你确认后的正式 finding 才计。', '');
    } else {
      L.push(`本轮预扫状态 \`${task.prescan.status}\`${task.prescan.reasonCode ? `(${task.prescan.reasonCode})` : ''}——无观察,不要求 disposition。`, '');
    }
  }
  if (escapeCandidates.length > 0) {
    L.push('## 逃逸判定(escapeAssessment — 必须逐条作答,缺/多/未知一律 invalid)', '');
    for (const c of escapeCandidates) {
      L.push(`- \`${c.candidateId}\`(引用 PR #${c.referencedPr},来源 ${c.kind}):${c.excerpt}`);
    }
    L.push('', '对每条在 `escapeAssessment[]` 里给 `{candidateId, verdict:"yes"|"no", basis}`——`yes` 表示"本 PR 确实在修一个此前已合并 PR 逃过审查的问题",机器会据此登记逃逸模式(下次同路径 PR 的任务里就会带上它);`no` 也要给依据。', '');
  } else {
    L.push('本轮无逃逸候选(task.escapeCandidates 为空)——`escapeAssessment` 必须为空数组 `[]`;known hazards 的逐条确认不填这里,写进 `modelVerdictNote`。', '');
  }
  L.push('## 覆盖回执(逐段精确集合,缺/重/跨段一律 invalid)', '');
  L.push(`本次改动共 ${coverageKeys.length} 个 coverage key,分 ${segments.length} 段**顺序投递**(同一会话内分段,不增席位):`, '');
  for (const seg of segments) {
    L.push(`- \`${seg.segmentId}\`(投递序号 ${seg.order}):${seg.assignedCoverageKeys.length} 个 key(清单随该段投递给出)`);
  }
  // 第 2 轮核验 BLOCKER:key 清单**不再写进本文件**——否则"一次性硬审 + 补一份形状正确的
  // 分段回执"与"真的分段审过"在机器层无法区分。清单只能经投递出口取得,投递台账因此成为
  // 顺序性的机器凭据(诚实边界见 lib.review-delivery.mjs)。
  L.push('', [
    '编排方必须按 `order` 逐段调用投递出口,把它打印的 payload 投给**同一个**审查会话:',
    '',
    '```',
    `node <SKILL_ROOT>/scripts/deliver-review-segment.mjs ${pr} --task <task.json> \\`,
    `  --base ${baseRefOid || '<baseOid>'} --head ${headOid || '<headOid>'} --order <1..${segments.length}>`,
    '```',
    '',
    '投递出口只接受**下一个**序号(乱序/跳段直接拒且不留记录),并把投递事实记进台账;',
    'consumer 以台账为基准核对回执——没投递过就声称覆盖、或宿主没投完,一律判 invalid。',
    '每段结束在 `segmentReceipts[]` 追加 `{segmentId, receivedOrder, coverageKeys:[...]}`,',
    '`receivedOrder` 必须等于该段投递序号,且只能认领本段分配到的 key。',
  ].join('\n'), '');
  if (!snapshot.complete) L.push(`> ⚠ DiffSnapshot 不完整(${snapshot.reason})——本轮无论如何都会判 invalid,请上报而不是硬审。`, '');
  if (configIncomplete) L.push(`> ⚠ 目标仓 riskProfiles 配置有非法项(${warnings.join(';')})——内置与合法项照常审,但本轮会判 invalid。`, '');

  const prompt = L.join('\n');
  if (outTask) writeFileSync(outTask, `${JSON.stringify(task, null, 2)}\n`);
  if (outPrompt) writeFileSync(outPrompt, prompt);
  print({
    ok: true, pr, snapshotHash: snapshot.snapshotHash, snapshotComplete: snapshot.complete,
    profileConfigIncomplete: configIncomplete, profileWarnings: warnings,
    injectedOpenCount: task.injectedOpenIds.length,
    coverageKeyCount: coverageKeys.length, segmentCount: segments.length,
    requiredProfileAnswerCount: requiredProfileAnswers.length,
    requiredNegativeEvidenceKeyCount: requiredNegativeEvidenceKeys.length,
    knownHazardCount: relevantHazards.length,
    escapeCandidateCount: escapeCandidates.length,
    taskFile: outTask, promptFile: outPrompt,
    ...(outPrompt ? {} : { prompt }),
  });
} catch (e) {
  fail(e);
}
