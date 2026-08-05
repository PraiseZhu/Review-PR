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
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { print, fail, REPO_ROOT, STATE_DIR, loadRules } from './lib.mjs';
import { buildDiffSnapshot, coverageKeysOf } from './lib.diff-snapshot.mjs';
import { mergeProfiles, requiredProfileAnswersFor, classifyRequiredNegativeEvidence, buildSegments, profileSetHash } from './lib.review-profiles.mjs';
import { loadLedger, ledgerPathFor, isEffectiveOpen } from './lib.findings-ledger.mjs';
import { loadKnownHazards, hazardsForPaths } from './lib.escaped-hazards.mjs';
import { REVIEW_OUTPUT_SCHEMA_VERSION } from './lib.review-consume.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };
const keyStr = (k) => (k.kind === 'hunk' ? `hunk:${k.fileId}:${k.hunkId}` : `file:${k.fileId}`);

/** 取每个 hunk 的新增行文本(R6 分类器输入)。 */
function addedLineTextsFor(snapshot) {
  const out = {};
  for (const f of snapshot.files) {
    const path = f.newPath;
    if (!path || f.contentKind !== 'text' || f.changeType === 'deleted') continue;
    const show = spawnSync('git', ['show', `${snapshot.headOid}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (show.status !== 0) continue;
    const lines = show.stdout.split('\n');
    out[path] = {};
    for (const h of f.hunks) out[path][h.hunkId] = (h.addedNewLines ?? []).map((ln) => lines[ln - 1] ?? '');
  }
  return out;
}

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
  const { profiles, warnings, configIncomplete } = mergeProfiles(rules.riskProfiles);

  const files = snapshot.complete ? snapshot.files : [];
  const coverageKeys = snapshot.complete ? coverageKeysOf(snapshot) : [];
  const segments = buildSegments({ coverageKeys, sizeBudget: Number(rules.reviewSegments?.sizeBudget) || 60 });
  const requiredProfileAnswers = requiredProfileAnswersFor(profiles, files);
  const requiredNegativeEvidenceKeys = snapshot.complete
    ? classifyRequiredNegativeEvidence({ profiles, files, addedLineTextByFile: addedLineTextsFor(snapshot) })
    : [];

  const ledger = loadLedger(ledgerPathFor(STATE_DIR, pr));
  const injectedOpen = ledger.ok
    ? ledger.entries.filter((e) => isEffectiveOpen(e, snapshot.snapshotHash))
    : [];
  const hazards = loadKnownHazards();
  const changedPaths = files.map((f) => f.newPath ?? f.oldPath).filter(Boolean);
  const relevantHazards = hazardsForPaths(hazards, changedPaths);

  const task = {
    schemaVersion: REVIEW_OUTPUT_SCHEMA_VERSION,
    pr,
    snapshotHash: snapshot.snapshotHash,
    snapshotComplete: snapshot.complete,
    profileSetHash: profileSetHash(profiles),
    profileConfigIncomplete: configIncomplete,
    profileWarnings: warnings,
    ledgerReadable: ledger.ok,
    ledgerHash: ledger.ok ? ledger.ledgerHash : null,
    injectedOpenIds: injectedOpen.map((e) => e.findingId),
    coverageKeys,
    segments,
    requiredProfileAnswers,
    requiredNegativeEvidenceKeys,
    knownHazards: relevantHazards,
    hazardsIncomplete: hazards.incomplete === true,
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
    const byProfile = new Map();
    for (const r of requiredProfileAnswers) {
      if (!byProfile.has(r.profileId)) byProfile.set(r.profileId, new Map());
      const m = byProfile.get(r.profileId);
      if (!m.has(r.checkId)) m.set(r.checkId, { ask: r.ask, files: [] });
      m.get(r.checkId).files.push(`${r.path} (fileId ${r.fileId})`);
    }
    for (const [profileId, checks] of byProfile) {
      L.push(`### profile \`${profileId}\``, '');
      for (const [checkId, v] of checks) {
        L.push(`- \`${checkId}\`:${v.ask}`);
        for (const f of v.files) L.push(`  - ${f}`);
      }
      L.push('');
    }
    L.push('每条在 `profileAnswers[]` 里给 `{profileId, fileId, checkId, answer}`:`checked-clean`(带 hunkId)/ `finding`(带本地引用 `{family_id, manifestationIndex}`)/ `not-applicable`(带 reasonCode + explanation)。', '');
  }
  if (requiredNegativeEvidenceKeys.length > 0) {
    L.push('## 负向证据必答(required — 只能用 executed 满足,N/A 不接受)', '');
    for (const k of requiredNegativeEvidenceKeys) L.push(`- ${k.path} hunk \`${k.hunkId}\`(fileId ${k.fileId}):${k.reason}`);
    L.push('', '在 `negativeEvidence[]` 里给 `{fileId, hunkId, kind:"executed", snapshotHash, command, negativeOracle, observedSignal:"expected-failure-observed", outputAnchor, verificationRunId}`,并在 `verificationRuns[]` 里登记对应 run。也就是:**把它弄坏一次,证明它真的会红**。', '');
  }
  L.push('## 覆盖回执(逐段精确集合,缺/重/跨段一律 invalid)', '');
  L.push(`本次改动共 ${coverageKeys.length} 个 coverage key,分 ${segments.length} 段顺序审查(同一会话内分段,不增席位):`, '');
  for (const seg of segments) {
    L.push(`- \`${seg.segmentId}\`:${seg.assignedCoverageKeys.length} 个 key`);
    for (const k of seg.assignedCoverageKeys) L.push(`  - ${keyStr(k)}`);
  }
  L.push('', '每段结束在 `segmentReceipts[]` 追加 `{segmentId, coverageKeys:[...]}`——只能认领本段分配到的 key。', '');
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
    taskFile: outTask, promptFile: outPrompt,
    ...(outPrompt ? {} : { prompt }),
  });
} catch (e) {
  fail(e);
}
