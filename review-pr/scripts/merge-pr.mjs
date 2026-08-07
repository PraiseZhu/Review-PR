#!/usr/bin/env node
// merge-pr.mjs — review-pr 的**唯一**合并出口(SC-C,2026-08-04 #469 复盘)。
//
// 为什么存在:此前 skill 没有"合并出口"这个东西——SKILL.md 让 agent 直接敲
// `gh pr merge`,于是 ①任何合并都可能不留审计记录(#469 的合并者事后考古三轮才定位,
// schedule_runs 与 runs.jsonl 均无记录);②"判定用的 head"与"执行合并的 head"之间
// 没有强制的原子护栏(--match-head-commit 靠 agent 自觉带上)。本脚本把两件事变成
// 机器行为:
//   1. **审计两相**:执行前先 append 一条 intent 到状态目录 merges.jsonl(写不进去就
//      拒绝合并——审计不可用时宁可不合),执行后 append 一条 result(共用 opId)。
//      merge 成功但进程在写 result 前崩溃 → 留下孤儿 intent,下轮 --reconcile 只读核
//      PR 实际状态补齐 result(reconciled:true),不会丢"合并发生过"这个事实。
//   2. **强制 --match-head-commit**:--match-head 是必填参数,不带就拒绝执行。
//   3. **basis 现场复核(SC-5,2026-08-08)**:非 dry-run / 非 reconcile 的真实合并前,自跑
//      pre-merge-check.mjs 按 basis 精确核对现场资格(approved / admin-trust / self-merge
//      都要求 current-head clean 阶段二回执相关的资格;authorized-fast-merge 由现场 GitHub
//      评论复核 break-glass),且 precheck 的 headRefOid 必须等于 --match-head——调用方不能
//      只传 --basis 绕过阶段二回执;复核失败一律 fail-closed 拒绝合并(无旁路参数)。
//
// 诚实边界(SC4.3):本脚本只能约束"经它执行"的合并;agent 绕开它直接敲 raw
// `gh pr merge` 不在机器承诺内——那一层靠 SKILL.md 的过程纪律 + tests 的静态
// inventory(scripts/ 内除本文件外零 `pr merge` 调用)收窄,不冒称机器强制。
//
// 用法:
//   node merge-pr.mjs <PR> --strategy squash|merge|rebase --match-head <40hex> \
//     --basis approved|admin-trust|authorized-fast-merge|self-merge \
//     [--admin] [--delete-branch] [--mode auto|interactive] [--dry-run]
//   (admin-trust / authorized-fast-merge / self-merge 三条 admin 路径必须显式带 --admin)
//   node merge-pr.mjs --reconcile          # 只读核对孤儿 intent,补 result
//
// 退出码:0=成功(或 dry-run / reconcile 完成);2=拒绝执行(参数缺失/审计不可用/merge 失败);1=脚本自身错误。
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gh, ghJson, parseRepo, parsePR, STATE_DIR, print } from './lib.mjs';

/** 拒绝执行(exit 2,与 pre-merge-check 的"有 blocker"退出码同义):输出 { ok:false, error }。 */
function refuse(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
  process.exit(2);
}

const MERGES_FILE = 'merges.jsonl';

const argvHas = (f) => process.argv.includes(f);
const argOf = (f) => {
  const i = process.argv.indexOf(f);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

const mergesPath = join(STATE_DIR, MERGES_FILE);

function appendRecord(rec) {
  appendFileSync(mergesPath, `${JSON.stringify(rec)}\n`);
}

function readRecords() {
  if (!existsSync(mergesPath)) return [];
  return readFileSync(mergesPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

try {
  const { owner, repo } = parseRepo();
  const slug = `${owner}/${repo}`;

  // ── reconcile 模式:只读核对孤儿 intent(有 intent 无 result),按 PR 实际状态补 result ──
  if (argvHas('--reconcile')) {
    const records = readRecords();
    const resultOps = new Set(records.filter((r) => r.phase === 'result').map((r) => r.opId));
    const orphans = records.filter((r) => r.phase === 'intent' && !resultOps.has(r.opId));
    const reconciled = [];
    for (const o of orphans) {
      let state = null;
      try {
        state = ghJson(['pr', 'view', String(o.pr), '--repo', o.slug ?? slug, '--json', 'state,mergedAt']);
      } catch { /* 查不到就留着下轮再试,不编造 */ }
      if (state === null) continue;
      // 复审修订(2026-08-04):只认三种已知 PR state——命令"成功"但返回空对象/未知 state
      // (API 形状漂移等)时若照写 result 会把 ok:false 永久封口这条 orphan,以后再也不会
      // 重试核对。未知一律保持 orphan,留待下轮。
      if (!['OPEN', 'MERGED', 'CLOSED'].includes(state.state)) continue;
      const rec = {
        phase: 'result', opId: o.opId, pr: o.pr, ts: new Date().toISOString(),
        ok: state.state === 'MERGED', prState: state.state, mergedAt: state.mergedAt ?? null,
        reconciled: true,
      };
      appendRecord(rec);
      reconciled.push(rec);
    }
    print({ ok: true, mode: 'reconcile', orphanCount: orphans.length, reconciled });
    process.exit(0);
  }

  // ── 正常合并模式 ──
  const pr = parsePR(process.argv[2]);
  const strategy = argOf('--strategy');
  const matchHead = (argOf('--match-head') ?? '').toLowerCase();
  const basis = argOf('--basis');
  const dryRun = argvHas('--dry-run');
  // 复审修订(2026-08-04):basis 只保留四条共识合并路径——5.5(冲突处理)/5.6(先合后修)
  // 是本地 merge+push,根本不经 gh pr merge,给它们留 basis 只会让审计出现不可达的假枚举。
  const BASES = new Set(['approved', 'admin-trust', 'authorized-fast-merge', 'self-merge']);
  // 三条 admin 路径的语义就是 admin bypass,不带 --admin 的调用要么必然失败、要么审计
  // basis 与真实命令不一致——一律拒绝,保证审计如实(approved 两可:普通合/结构性 bypass)。
  const ADMIN_BASES = new Set(['admin-trust', 'authorized-fast-merge', 'self-merge']);
  if (!['squash', 'merge', 'rebase'].includes(strategy ?? '')) refuse('缺 --strategy squash|merge|rebase');
  if (!/^[0-9a-f]{40}$/.test(matchHead)) refuse('缺 --match-head <完整 40 位 head SHA>(判定与执行之间的原子护栏,必填)');
  if (!BASES.has(basis ?? '')) refuse(`缺 --basis(${[...BASES].join('|')})——审计必须记录凭什么合`);
  if (ADMIN_BASES.has(basis) && !argvHas('--admin')) refuse(`--basis ${basis} 是 admin bypass 路径,必须显式带 --admin(审计 basis 与真实命令必须一致)`);

  const args = ['pr', 'merge', String(pr), '--repo', slug, `--${strategy}`, '--match-head-commit', matchHead];
  if (argvHas('--admin')) args.push('--admin');
  if (argvHas('--delete-branch')) args.push('--delete-branch');

  if (dryRun) {
    print({ ok: true, mode: 'dry-run', wouldRun: ['gh', ...args], note: '未执行任何 GitHub 写操作,也未写审计记录' });
    process.exit(0);
  }

  const opId = randomUUID();
  // 复审修订(2026-08-04):viewer 查不到就拒绝执行——审计的"谁在合"字段不允许为空
  // (#469 的教训正是合并者身份事后无从考证),身份不明时宁可不合,fail-closed。
  let viewer = '';
  try { viewer = ghJson(['api', 'user', '--jq', '{login}']).login ?? ''; } catch { /* fallthrough */ }
  if (!viewer) refuse('无法确认当前 gh 账号身份(gh api user 失败)——审计身份字段不允许为空,拒绝执行合并');

  // ── SC-5(2026-08-08):basis-aware pre-merge gate 现场复核 ──
  // 唯一合并出口不信任调用方口头声称的 basis——真实合并前自跑 pre-merge-check.mjs 现场
  // 复核(TOCTOU:判定与执行之间 head / 回执 / 授权评论可能已变)。四种 basis 的现场资格:
  //   approved              → standardMergeAvailable,或 structuralBypassReady 且
  //                           structuralBypassBasis==='approved'(强制自动化审查策略
  //                           requireAutomatedReviewForAutoMerge 下该路径已含 current-head
  //                           clean 阶段二回执门,见 pre-merge-check.mjs);
  //   admin-trust           → structuralBypassReady 且 structuralBypassBasis==='admin-trust'
  //                           (本身已要求 current-head clean 回执);
  //   self-merge            → selfMergeAvailable;
  //   authorized-fast-merge → authorizedFastMergeAvailable(人工 /approve-merge break-glass,
  //                           由现场 GitHub 评论复核证明;唯一免阶段二例外)。
  // 任何 basis 都要求 precheck 的 headRefOid 精确等于 --match-head(判定与执行同一 head);
  // 复核失败/不可用一律 fail-closed 拒绝合并,不新增 --skip-precheck / --force-review-bypass
  // 之类旁路参数(SC-5:调用方不能只传 --basis 绕过阶段二回执)。
  //
  // 退出码语义(2026-08-08 复审修复):pre-merge-check 的 exit 0 只表示「普通合并
  // (canMerge/selfMerge/authorized-fast)可用」;结构性 BLOCKED(blockClass=structural-check)
  // 下即便 structuralBypassReady=true,canMerge 仍 false → 恒 exit 2——structural
  // approved/admin-trust 两条 bypass 路径的生产契约就是 status=2 + 输出里
  // structuralBypassReady=true。因此 status 0 **与** 2 都允许进入 JSON 解析,由下方
  // basisGranted 按 basis 精确裁决;status 1(脚本自身错误)/信号终止/输出不可解析仍
  // fail-closed 拒绝。不要把 structuralBypassReady 并入 pre-merge 顶层 canMerge/exit 0
  // ——那会让其他调用方把「有某 basis 资格」误读成普通合并资格。
  const precheckScript = join(dirname(fileURLToPath(import.meta.url)), 'pre-merge-check.mjs');
  const precheck = spawnSync(process.execPath, [precheckScript, String(pr)], { encoding: 'utf8', timeout: 180_000 });
  if (precheck.error) {
    refuse(`合并前 basis 现场复核无法执行(${precheck.error.message})——fail-closed,不合并,下轮重试`);
  }
  if (precheck.status !== 0 && precheck.status !== 2) {
    refuse(`合并前 basis 现场复核脚本自身失败(exit ${precheck.status})——fail-closed,不合并,下轮重试;precheck 输出:${(precheck.stdout || precheck.stderr || '').slice(0, 400)}`);
  }
  let precheckOut = null;
  try { precheckOut = JSON.parse(precheck.stdout); } catch { /* fallthrough */ }
  if (!precheckOut || typeof precheckOut !== 'object') {
    refuse('合并前 basis 现场复核输出不可解析——fail-closed,不合并');
  }
  if ((precheckOut.headRefOid ?? '').toLowerCase() !== matchHead) {
    refuse(`合并前 basis 现场复核针对的 head(${precheckOut.headRefOid ?? '(空)'})与 --match-head(${matchHead})不一致——拒绝合并,需对当前 head 重新复核`);
  }
  const basisGranted = (() => {
    switch (basis) {
      case 'approved':
        return precheckOut.standardMergeAvailable === true ||
          (precheckOut.structuralBypassReady === true && precheckOut.structuralBypassBasis === 'approved');
      case 'admin-trust':
        return precheckOut.structuralBypassReady === true && precheckOut.structuralBypassBasis === 'admin-trust';
      case 'self-merge':
        return precheckOut.selfMergeAvailable === true;
      case 'authorized-fast-merge':
        return precheckOut.authorizedFastMergeAvailable === true;
      default:
        return false;
    }
  })();
  if (!basisGranted) {
    const hint = basis === 'authorized-fast-merge'
      ? ';authorized-fast-merge 只认 breakGlassApprovers 名单成员人工发出的 /approve-merge <当前 head 完整 40 位 SHA> 现场授权评论(break-glass)——无有效授权评论即拒绝'
      : '';
    refuse(`basis=${basis} 未获得合并前现场复核的资格(读 precheck 输出:standardMergeAvailable=${precheckOut.standardMergeAvailable},structuralBypassReady=${precheckOut.structuralBypassReady},structuralBypassBasis=${precheckOut.structuralBypassBasis},selfMergeAvailable=${precheckOut.selfMergeAvailable},authorizedFastMergeAvailable=${precheckOut.authorizedFastMergeAvailable})${hint}——拒绝合并`);
  }
  // SC-1(2026-08-08)审计增强:break-glass 合并把授权评论 URL / 发令者从 precheck 结果
  // 带进 intent 记录,事后可确认人工触发来源(自动轮询无法制造该字段)。
  const breakGlass = basis === 'authorized-fast-merge' && precheckOut.authorizedFastMergeInfo
    ? {
      authorizer: precheckOut.authorizedFastMergeInfo.admin ?? null,
      authorizationUrl: precheckOut.authorizedFastMergeInfo.commentUrl ?? null,
      commentCreatedAt: precheckOut.authorizedFastMergeInfo.commentCreatedAt ?? null,
    }
    : null;
  // intent 先落盘:写不进去就拒绝合并——审计不可用时宁可不合(fail-closed)。
  // SC-5(2026-08-08):intent 额外记录 basis 已通过现场复核(basisVerified),break-glass
  // 再带授权评论 URL / 发令者(breakGlass,见上方现场复核段)——审计可回溯"凭什么合"。
  try {
    appendRecord({
      phase: 'intent', opId, pr, slug, ts: new Date().toISOString(), strategy, matchHead, basis, viewer,
      mode: argOf('--mode') ?? 'unknown', argv: args,
      basisVerified: true,
      ...(breakGlass ? { breakGlass } : {}),
    });
  } catch (e) {
    refuse(`审计 intent 写入失败(${e.message})——拒绝执行合并:审计不可用时不合`);
  }

  let ok = false; let error = null;
  try {
    gh(args);
    ok = true;
  } catch (e) {
    error = (e.message ?? String(e)).slice(0, 500);
  }
  // result 落盘失败不阻断(合并已是既成事实),stderr 告警,孤儿 intent 由 --reconcile 兜底。
  try {
    appendRecord({ phase: 'result', opId, pr, ts: new Date().toISOString(), ok, ...(error ? { error } : {}) });
  } catch (e) {
    console.error(`[merge-pr] 警告:result 写入失败(${e.message}),留待 --reconcile 补齐`);
  }
  if (!ok) refuse(`gh pr merge 失败:${error}`);
  // ── SC-R7 生产触发链(第 2 轮核验:pending→activation 此前只有 SKILL 里的手工命令,
  // 仓内零 production caller)。合并成功**就是** hazard 激活的触发事实:本 PR 若是某条
  // pending hazard 的 fix PR,此刻它的 fixHead 才可核验。幂等 + 失败留 inbox 重放,所以
  // best-effort 调用不会丢事实;它也不改变本次合并结果(合并已既成),只把结果带出去。
  let hazardActivation = null;
  try {
    // process.execPath 而不是裸 'node':mini 的非交互 PATH 里没有 node,裸名字会 ENOENT
    // 而静默丢掉激活(第 3 轮核验点名)。error/status/stdout 三者都要查。
    const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'record-escaped-finding.mjs'), '--activate'], { encoding: 'utf8', timeout: 120_000 });
    if (r.error) throw r.error;
    if (!r.stdout || !r.stdout.trim()) throw new Error(`激活子进程无输出(status=${r.status}, stderr=${(r.stderr ?? '').slice(0, 160)})`);
    hazardActivation = JSON.parse(r.stdout);
  } catch (e) {
    hazardActivation = { ok: false, error: `激活调用失败:${String(e.message ?? e).slice(0, 200)}(条目留在 inbox 下轮重放)` };
  }
  print({ ok: true, opId, pr, strategy, matchHead, basis, auditFile: mergesPath, hazardActivation });
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: `merge-pr 脚本错误:${e.message}` }, null, 2) + '\n');
  process.exit(1);
}
