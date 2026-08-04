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
//
// 诚实边界(SC4.3):本脚本只能约束"经它执行"的合并;agent 绕开它直接敲 raw
// `gh pr merge` 不在机器承诺内——那一层靠 SKILL.md 的过程纪律 + tests 的静态
// inventory(scripts/ 内除本文件外零 `pr merge` 调用)收窄,不冒称机器强制。
//
// 用法:
//   node merge-pr.mjs <PR> --strategy squash|merge|rebase --match-head <40hex> \
//     --basis approved|admin-trust|authorized-fast-merge|self-merge|conflict-merged|merge-then-fix \
//     [--admin] [--delete-branch] [--mode auto|interactive] [--dry-run]
//   node merge-pr.mjs --reconcile          # 只读核对孤儿 intent,补 result
//
// 退出码:0=成功(或 dry-run / reconcile 完成);2=拒绝执行(参数缺失/审计不可用/merge 失败);1=脚本自身错误。
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const BASES = new Set(['approved', 'admin-trust', 'authorized-fast-merge', 'self-merge', 'conflict-merged', 'merge-then-fix']);
  if (!['squash', 'merge', 'rebase'].includes(strategy ?? '')) refuse('缺 --strategy squash|merge|rebase');
  if (!/^[0-9a-f]{40}$/.test(matchHead)) refuse('缺 --match-head <完整 40 位 head SHA>(判定与执行之间的原子护栏,必填)');
  if (!BASES.has(basis ?? '')) refuse(`缺 --basis(${[...BASES].join('|')})——审计必须记录凭什么合`);

  const args = ['pr', 'merge', String(pr), '--repo', slug, `--${strategy}`, '--match-head-commit', matchHead];
  if (argvHas('--admin')) args.push('--admin');
  if (argvHas('--delete-branch')) args.push('--delete-branch');

  if (dryRun) {
    print({ ok: true, mode: 'dry-run', wouldRun: ['gh', ...args], note: '未执行任何 GitHub 写操作,也未写审计记录' });
    process.exit(0);
  }

  const opId = randomUUID();
  const viewer = (() => { try { return ghJson(['api', 'user', '--jq', '{login}']).login ?? ''; } catch { return ''; } })();
  // intent 先落盘:写不进去就拒绝合并——审计不可用时宁可不合(fail-closed)。
  try {
    appendRecord({ phase: 'intent', opId, pr, slug, ts: new Date().toISOString(), strategy, matchHead, basis, viewer, mode: argOf('--mode') ?? 'unknown', argv: args });
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
  print({ ok: true, opId, pr, strategy, matchHead, basis, auditFile: mergesPath });
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: `merge-pr 脚本错误:${e.message}` }, null, 2) + '\n');
  process.exit(1);
}
