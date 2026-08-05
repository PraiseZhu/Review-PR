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
import { loadKnownHazards, hazardsForPaths, resolveEscapeSources } from './lib.escaped-hazards.mjs';
import { REVIEW_OUTPUT_SCHEMA_VERSION } from './lib.review-consume.mjs';

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
    escapeSourceIncomplete: escapeSourceErrors.length > 0,
    escapeSourceErrors,
    escapeSourceKind: src.kind,
    relatedIssueCount: issueTexts.length,
  };

  // ── prompt 正文:必答项 / open findings / hazards / 分片 全部落进文本 ──
  const L = [];
  L.push(`# 阶段二独立审查任务 — PR #${pr}`, '');
  L.push(`snapshotHash: \`${snapshot.snapshotHash ?? '(不完整)'}\` — 输出里的所有 snapshotHash 字段必须原样用它。`, '');
  L.push(`输出契约:单一 JSON,\`schemaVersion: "${REVIEW_OUTPUT_SCHEMA_VERSION}"\`。机器只消费 JSON,你自报的 verdict 不被采信(verdict 由内容推导)。`, '');
  if (relevantHazards.length > 0) {
    L.push('## 已知逃逸风险(known hazards — 本仓历史上真的逃过审查、事后被证伪的模式)', '');
    for (const h of relevantHazards) {
      L.push(`- \`${h.hazardId}\`:${h.pattern}(源自 PR #${h.originPr},由 #${h.fixPr} 证伪;命中路径 ${h.paths.join(' / ')})`);
    }
    L.push('', '这些模式在本次改动涉及的路径上出现过;逐条确认本 PR 是否重现。', '');
  }
  if (injectedOpen.length > 0) {
    L.push('## 未决 findings(必须逐条 disposition,否则本轮判 invalid)', '');
    for (const e of injectedOpen) {
      L.push(`- \`${e.findingId}\` [${e.status}] ${e.path}:${e.line} — ${e.invariantKey ? '(invariantKey ' + e.invariantKey.slice(0, 22) + '…)' : ''} ${e.rule ? '规则 ' + e.rule.ruleId : ''}`);
    }
    L.push('', '在 `findingDispositions[]` 里对上面每个 findingId 给 `resolved`(带当前 snapshot 的证据锚点)或 `invalidated`(带判误报依据)。`accepted-risk` 不走你的输出,只走交互确认。', '');
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
  if (escapeCandidates.length > 0) {
    L.push('## 逃逸判定(escapeAssessment — 必须逐条作答,缺/多/未知一律 invalid)', '');
    for (const c of escapeCandidates) {
      L.push(`- \`${c.candidateId}\`(引用 PR #${c.referencedPr},来源 ${c.kind}):${c.excerpt}`);
    }
    L.push('', '对每条在 `escapeAssessment[]` 里给 `{candidateId, verdict:"yes"|"no", basis}`——`yes` 表示"本 PR 确实在修一个此前已合并 PR 逃过审查的问题",机器会据此登记逃逸模式(下次同路径 PR 的任务里就会带上它);`no` 也要给依据。', '');
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
