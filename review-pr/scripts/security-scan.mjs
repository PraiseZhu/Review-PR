#!/usr/bin/env node
// security-scan.mjs — 阶段二在审查 worktree 内跑的安全扫描(依赖漏洞 + 静态扫描)
//
// 为什么不在 pre-check.mjs 里跑:pre-check 是 scheduler 的「要不要起会话」预检,在 agent
// 会话创建**之前**执行、输出到不了会话(结果会丢)、不下载代码(只 gh pr list)、且有秒级
// 超时预算。audit 与 semgrep 都必须有真实文件树才能跑,所以落在这里 —— 审查 agent 本来
// 每个 PR 一个隔离 worktree(SKILL 第 4 节),跑完即弃。
//
// 与阶段一的分工:
//   阶段一(context.mjs 的 signoff(security 触发))只看 diff 文本,负责**拦不拦**(硬门)。
//   本脚本负责**给证据**:哪个新增依赖有已知漏洞、哪段新增代码命中静态规则。
//   ⚠️ 门的拦截判断不依赖本脚本 —— semgrep 没装、audit 失败都不影响硬门是否拦人。
//
// 两条铁律:
//   1. **只报本 PR 引入的问题**,不报仓库存量。否则一个满是历史告警的仓库会让输出变噪音,
//      审查 agent 只能整体忽略,等于没扫。audit 按 --dep 传入的包名(阶段一算出的新增依赖)
//      过滤;semgrep 用原生 --baseline-commit 只报新增。
//   2. **工具缺失 / 超时 ≠ 通过**。一律输出 available:false + reason,审查 agent 必须在
//      Verification 里如实写「未跑」,不得写成「已扫描无问题」(见 SKILL 第 4 节)。
//
// 跑(在 PR head 的 worktree 里):
//   node <skill-root>/scripts/security-scan.mjs --base <base-sha> [--dep <包名>]... [--skip-semgrep]
// 输出 JSON:{ ok, packageManager, audit:{...}, semgrep:{...}, note }
// 退出码恒 0(除脚本自身出错=1):结论在字段里,不靠退出码分流。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { run, print, fail, loadRules, REPO_ROOT } from './lib.mjs';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const argsOf = (name) => argv.reduce((acc, a, i) => (a === name && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const baseSha = argOf('--base');
// 阶段一算出的新增/升级依赖名(signoff security 触发的 newDependencyNames)。
// 不传 = 本 PR 没动依赖 → audit 整段跳过(不是「没漏洞」,是「没有新引入的依赖要查」)。
const targetDeps = argsOf('--dep');
const skipSemgrep = argv.includes('--skip-semgrep');
const rules = loadRules();
const scanCfg = rules.securityScan ?? {};
const AUDIT_TIMEOUT_MS = Number(scanCfg.auditTimeoutMs) || 60_000;
const SEMGREP_TIMEOUT_MS = Number(scanCfg.semgrepTimeoutMs) || 180_000;
const SEMGREP_CONFIGS = scanCfg.semgrepConfigs?.length ? scanCfg.semgrepConfigs : ['p/javascript', 'p/nodejs'];
const HIT_CAP = 40;

/** 按 lockfile 判包管理器 —— monorepo 用什么装的就用什么 audit,混用会给出错误结论。 */
function detectPackageManager() {
  if (existsSync(join(REPO_ROOT, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(REPO_ROOT, 'package-lock.json'))) return 'npm';
  if (existsSync(join(REPO_ROOT, 'yarn.lock'))) return 'yarn';
  return null;
}

/** 命令是否可用(--version 探测)。返回 { available, reason }。 */
function probe(cmd, versionArgs = ['--version']) {
  const r = run(cmd, versionArgs, { allowFail: true, timeoutMs: 15_000, cwd: REPO_ROOT });
  if (!r.ok) {
    const why = (r.stderr || r.stdout || '').trim().slice(0, 200);
    return { available: false, reason: why || `${cmd} 不可用(未安装或不在 PATH)` };
  }
  return { available: true, version: (r.stdout || '').trim().split('\n')[0].slice(0, 60) };
}

/**
 * 依赖漏洞:跑包管理器的 audit,再**只留与本 PR 新增依赖相关**的条目。
 * 相关 = advisory 的包名本身就是新增包,或新增包出现在该 advisory 的依赖路径里
 * (传递依赖引入的漏洞同样算本 PR 带进来的)。
 */
function runAudit(pm) {
  if (!pm) return { available: false, reason: '未找到 pnpm-lock.yaml / package-lock.json / yarn.lock,无法确定包管理器' };
  if (targetDeps.length === 0) {
    return { available: true, skipped: true, reason: '本 PR 未新增/升级第三方依赖(未传 --dep),无需 audit', advisories: [] };
  }
  const probed = probe(pm);
  if (!probed.available) return probed;
  // pnpm/npm audit 有漏洞时退出码非 0,所以一律 allowFail,靠能否解析 JSON 判成败
  const args = pm === 'yarn'
    ? ['npm', 'audit', '--json', '--all']
    : ['audit', '--json'];
  const r = run(pm, args, { allowFail: true, timeoutMs: AUDIT_TIMEOUT_MS, cwd: REPO_ROOT });
  const raw = (r.stdout || '').trim();
  if (!raw) {
    return { available: false, reason: `${pm} audit 无输出(可能超时或需要先安装依赖): ${(r.stderr || '').trim().slice(0, 200)}` };
  }
  let advisories = [];
  try {
    advisories = parseAudit(pm, raw);
  } catch (e) {
    return { available: false, reason: `${pm} audit 输出解析失败: ${String(e?.message ?? e).slice(0, 200)}` };
  }
  const wanted = new Set(targetDeps.map((d) => d.toLowerCase()));
  const related = advisories.filter((a) => {
    if (wanted.has((a.module ?? '').toLowerCase())) return true;
    return (a.paths ?? []).some((p) => String(p).split(/[>\s]+/).some((seg) => wanted.has(seg.trim().toLowerCase())));
  });
  return {
    available: true,
    packageManager: pm,
    version: probed.version,
    scannedDeps: targetDeps,
    totalAdvisories: advisories.length,
    relatedCount: related.length,
    advisories: related.slice(0, HIT_CAP),
    note: '只列与本 PR 新增/升级依赖相关的条目(含它们带进来的传递依赖);totalAdvisories 是全仓库总数,仓库存量漏洞不是本 PR 的问题,不要写进打回意见',
  };
}

/** 各家 audit 的 JSON 形状不同,统一成 { module, severity, title, url, range, paths }。 */
function parseAudit(pm, raw) {
  const out = [];
  if (pm === 'yarn') {
    // yarn npm audit --json:每行一个 JSON 对象
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      const j = JSON.parse(t);
      const v = j.value ?? j.module_name;
      const d = j.children ?? {};
      if (!v) continue;
      out.push({
        module: v,
        severity: d.Severity ?? j.severity ?? 'unknown',
        title: d.Issue ?? j.title ?? '',
        url: d.URL ?? j.url ?? '',
        range: d['Vulnerable Versions'] ?? '',
        paths: d['Tree Versions'] ?? [],
      });
    }
    return out;
  }
  const j = JSON.parse(raw);
  // npm v7+ / pnpm:{ vulnerabilities: { <name>: { severity, via[], range, effects[] } } }
  if (j.vulnerabilities && !Array.isArray(j.vulnerabilities)) {
    for (const [name, v] of Object.entries(j.vulnerabilities)) {
      const via = (v.via ?? []).filter((x) => typeof x === 'object');
      out.push({
        module: name,
        severity: v.severity ?? 'unknown',
        title: via.map((x) => x.title).filter(Boolean).join('; ').slice(0, 300),
        url: via.map((x) => x.url).filter(Boolean)[0] ?? '',
        range: v.range ?? '',
        // effects = 谁受它影响;把它当依赖路径线索用于「是不是本 PR 引入的」过滤
        paths: [...(v.effects ?? []), ...(v.nodes ?? [])].slice(0, 20),
      });
    }
    return out;
  }
  // npm v6 风格:{ advisories: { <id>: { module_name, severity, ... } } }
  if (j.advisories) {
    for (const a of Object.values(j.advisories)) {
      out.push({
        module: a.module_name,
        severity: a.severity ?? 'unknown',
        title: (a.title ?? '').slice(0, 300),
        url: a.url ?? '',
        range: a.vulnerable_versions ?? '',
        paths: (a.findings ?? []).flatMap((f) => f.paths ?? []).slice(0, 20),
      });
    }
    return out;
  }
  return out;
}

/**
 * 静态扫描:semgrep --baseline-commit 只报「相对 base 新增」的问题,存量告警自动排除。
 * base 读不到时不退化成全仓扫描 —— 那会输出成百条存量告警,反而让审查 agent 忽略整段。
 */
function runSemgrep() {
  if (skipSemgrep) return { available: false, reason: '调用方传了 --skip-semgrep' };
  const probed = probe('semgrep');
  if (!probed.available) {
    return {
      available: false,
      reason: `${probed.reason};装法:brew install semgrep 或 pipx install semgrep`,
    };
  }
  if (!baseSha) {
    return { available: false, reason: '未传 --base <base-sha>,无法只报新增问题(不退化成全仓扫描:存量告警会淹没本 PR 的问题)' };
  }
  const args = ['scan', '--json', '--quiet', '--baseline-commit', baseSha, '--metrics', 'off'];
  for (const c of SEMGREP_CONFIGS) args.push('--config', c);
  const r = run('semgrep', args, { allowFail: true, timeoutMs: SEMGREP_TIMEOUT_MS, cwd: REPO_ROOT });
  const raw = (r.stdout || '').trim();
  if (!raw.startsWith('{')) {
    return { available: false, reason: `semgrep 无可解析输出(可能超时 / 规则集拉取失败): ${(r.stderr || raw || '').trim().slice(0, 250)}` };
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return { available: false, reason: `semgrep 输出解析失败: ${String(e?.message ?? e).slice(0, 200)}` };
  }
  const findings = (j.results ?? []).map((f) => ({
    check: f.check_id,
    severity: f.extra?.severity ?? 'unknown',
    file: f.path,
    line: f.start?.line ?? null,
    message: (f.extra?.message ?? '').slice(0, 400),
  }));
  const errors = (j.errors ?? []).map((e) => String(e?.message ?? e).slice(0, 200));
  return {
    available: true,
    version: probed.version,
    configs: SEMGREP_CONFIGS,
    baselineCommit: baseSha,
    findingCount: findings.length,
    findings: findings.slice(0, HIT_CAP),
    ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
    note: '只含相对 --base 新增的问题(semgrep --baseline-commit);errors 非空 = 部分文件/规则没跑成,不得当作「那部分没问题」',
  };
}

try {
  const pm = detectPackageManager();
  const audit = runAudit(pm);
  const semgrep = runSemgrep();
  const bothUnavailable = !audit.available && !semgrep.available;
  print({
    ok: true,
    repoRoot: REPO_ROOT,
    packageManager: pm,
    baseSha: baseSha ?? null,
    audit,
    semgrep,
    // 供审查 agent 直接抄进 Verification 的一句话结论,避免把「没跑」写成「没问题」
    verificationLine: [
      audit.available
        ? (audit.skipped ? '依赖漏洞扫描:本 PR 未新增依赖,无需扫描' : `依赖漏洞扫描(${pm} audit):与本 PR 新增依赖相关 ${audit.relatedCount} 条`)
        : `依赖漏洞扫描:未执行(${audit.reason})`,
      semgrep.available
        ? `静态扫描(semgrep,仅新增):${semgrep.findingCount} 条`
        : `静态扫描:未执行(${semgrep.reason})`,
    ].join(';'),
    note: `重档安全扫描(SKILL「分档审查」heavy 档)。⚠️ available:false ≠ 通过 —— 必须在审查报告 Verification 里如实写「未执行」及原因,不得写成「已扫描无问题」;${bothUnavailable ? '本次两项都没跑成,该 PR 的依赖与静态扫描证据为空,审查结论里必须说明;' : ''}本脚本只给证据,不决定 gate 是否拦人(硬门判定在阶段一 context.mjs 的 signoff(security 触发),与本脚本是否可用无关)。审查 agent 拿到 findings 后仍要自己判是否真问题(semgrep 有误报),真问题按 SKILL 严重度口径定级`,
  });
} catch (e) {
  fail(e);
}
