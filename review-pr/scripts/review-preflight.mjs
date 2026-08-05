#!/usr/bin/env node
// review-preflight.mjs — 阶段二审查**之前**跑的确定性规则层(SC-R2,2026-08-05)。
//
// 命中即机器打回(经 consume-review-output 入 findings 台账并驱动 dirty),不经 LLM。
// 归因:只有落在 base..head 新增/修改行上的命中才阻断;既存命中 report-only(不拿
// PR 之前的旧账打回作者)。
//
// fail-closed:parser 缺失/版本不符、snapshot 不完整、任一文件解析失败 →
// `complete:false`,消费方按 R1 invalid 处理——绝不因"跑不了"当成"无命中"。
//
// 用法:
//   node review-preflight.mjs --base <baseRefOid> --head <headRefOid> [--out <file.json>]
// 退出码:0 = 跑完(complete 与 hits 看输出);2 = 不完整(complete:false);1 = 脚本自身错误。
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { print, fail, REPO_ROOT, loadRules } from './lib.mjs';
import { buildDiffSnapshot } from './lib.diff-snapshot.mjs';
import { loadVendoredTypescript, scanSource, hitTouchesNewLines, ruleSetHash, BUILTIN_RULES } from './lib.preflight-rules.mjs';

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };

/** 从 immutable object 读文件内容(不读工作树——工作树可能是别的 head)。 */
function readBlobAtHead(path, headOid) {
  const r = spawnSync('git', ['show', `${headOid}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

try {
  const baseRefOid = (argOf('--base') ?? '').toLowerCase();
  const headOid = (argOf('--head') ?? '').toLowerCase();
  const outFile = argOf('--out');
  const emit = (payload) => {
    if (outFile) writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
    print(payload);
    process.exit(payload.complete ? 0 : 2);
  };

  const snapshot = buildDiffSnapshot({ repoRoot: REPO_ROOT, baseRefOid, headOid });
  if (!snapshot.complete) {
    emit({ complete: false, reason: `DiffSnapshot 不完整:${snapshot.reason}`, snapshotHash: null, hits: [], reportOnly: [] });
  }

  const parser = loadVendoredTypescript();
  if (!parser.ok) {
    emit({
      complete: false, reason: `parser 不可用:${parser.error}(禁 regex 降级——本轮按 preflightIncomplete 处理)`,
      snapshotHash: snapshot.snapshotHash, hits: [], reportOnly: [],
    });
  }

  // 目标仓自定义规则:只接受**声明式参数**(启停/严重度覆盖),永不执行来自 PR head 的
  // 规则代码;配置读维护侧 checkout 的 pr-rules.json(loadRules 的既有三层优先级)。
  const rules = loadRules();
  const cfg = rules.reviewPreflight ?? {};
  const disabled = new Set(Array.isArray(cfg.disabledRuleIds) ? cfg.disabledRuleIds : []);
  const activeRules = BUILTIN_RULES.filter((r) => !disabled.has(r.ruleId));

  const hits = [];
  const reportOnly = [];
  const unparsable = [];
  const scanned = [];
  for (const f of snapshot.files) {
    if (f.changeType === 'deleted' || f.contentKind !== 'text') continue;
    const path = f.newPath;
    if (!path) continue;
    const text = readBlobAtHead(path, snapshot.headOid);
    if (text == null) { unparsable.push({ path, reason: 'git show 取不到 head blob' }); continue; }
    const r = scanSource(parser.ts, { path, text });
    if (!r.ok) { unparsable.push({ path, reason: r.error }); continue; }
    if (r.skipped) continue;
    scanned.push(path);
    const addedLineSets = f.hunks.map((h) => h.addedNewLines ?? []);
    for (const hit of r.hits) {
      if (!activeRules.some((ar) => ar.ruleId === hit.ruleId)) continue;
      const target = hitTouchesNewLines(hit, addedLineSets) ? hits : reportOnly;
      target.push({ ...hit, fileId: f.fileId });
    }
  }

  // 任一文件解析失败 → 本轮不完整(不给"扫过了、没命中"的结论)
  if (unparsable.length > 0) {
    emit({
      complete: false, reason: `${unparsable.length} 个文件无法解析(不产出"无命中"结论)`,
      unparsable, snapshotHash: snapshot.snapshotHash, hits, reportOnly,
      parserVersion: parser.version, ruleSetHash: ruleSetHash(),
    });
  }

  emit({
    complete: true, reason: null,
    snapshotHash: snapshot.snapshotHash,
    parserVersion: parser.version, parserPath: parser.resolvedPath, ruleSetHash: ruleSetHash(),
    activeRuleIds: activeRules.map((r) => r.ruleId),
    scannedFileCount: scanned.length,
    hits, reportOnly,
    note: 'hits = 落在本次新增/修改行上的确定性命中(机器打回,经 consume-review-output 入台账并驱动 dirty);reportOnly = 既存命中(PR 之前就有,不打回作者,但要写进汇总);complete=false 时消费方必须按 R1 invalid 处理,不得据"无命中"放行。',
  });
} catch (e) {
  fail(e);
}
