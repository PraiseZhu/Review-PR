#!/usr/bin/env node
// fix-worktree-cleanup.mjs — 回收已合并/关闭 PR 遗留的跟进 worktree 与本地分支
//
// 背景:5.4 fix-handoff 为 selfFixAuthors 的 PR 开跟进会话,宿主用 use_worktree 在托管
// 目录(.cindy-worktrees / .claude/worktrees)下建独立 worktree,跟进会话在里面
// gh pr checkout 出与 PR head 同名的本地分支(git worktree 共享 refs,分支落在共享
// 仓库里)。PR 合并后 fix-session-state.mjs sweep 只清会话绑定,worktree 目录
// (含 node_modules,单个可达 GB 级)和分支没人回收,会随 PR 数量线性膨胀。
// 本脚本做确定性回收,安全边界全部内置:
//   1. 只动「托管 worktree 目录」:路径含 .cindy-worktrees 段、.claude/worktrees 段,
//      或 REVIEW_PR_WORKTREE_ROOTS(逗号/分号分隔的绝对路径前缀)覆盖的位置;
//      其余 worktree 一律视为用户自建,永不触碰。
//   2. 分支对应的 PR 用 gh 实查(--state all),全部非 OPEN 才动;查不到对应 PR 的
//      分支/worktree 不动(来历不明 → 保守)。gh 查询失败同样保守跳过,下轮重试。
//   3. 默认分支与 main/master 永不删;仍被其他 worktree 检出的分支 git 自己会拒删。
//   4. detached、locked、bare、包含当前 cwd 的 worktree 不动;PR 合并/关闭后
//      --grace-minutes(默认 30)宽限期内不动,防跟进会话还在收尾(回 thread/留评论)。
//   5. 分支删除比 worktree 更保守:对应 PR 全部 MERGED 才删;CLOSED 未合并的分支保留
//      (worktree 照收,分支提交仍可从本地 ref 找回)。pr-<N> 型审查残留分支
//      MERGED/CLOSED 都删(它只是 refs/pull/<N>/head 的本地别名,远端永远找得回)。
//
// 用法:
//   node fix-worktree-cleanup.mjs --scan [--dry-run] [--grace-minutes 30]
//     → 全量:扫全部托管 worktree + 孤儿本地分支。auto 每轮阶段 1 sweep 后跑一次;
//       幂等,本轮失败/漏跑下轮自愈(也能消化本机制上线前的历史残留)。
//   node fix-worktree-cleanup.mjs --pr <N> [--dry-run] [--grace-minutes 30]
//     → 定点:只回收该 PR(headRefName 对应的 worktree/分支 + pr-<N> 残留)。
//       PR 仍 open 时拒绝回收。交互模式合并后可即时调用。
//
// 输出 JSON;单项失败进 errors 不炸整趟。--dry-run 只列计划不执行任何写操作。
// 跑:node <skill-root>/scripts/fix-worktree-cleanup.mjs --scan

import { resolve } from 'node:path';
import { parseRepo, parsePR, gh, git, print, fail } from './lib.mjs';

const isWin = process.platform === 'win32';
// lib 的 run() 在 Windows 走 shell 且不自动加引号(既有脚本参数都是无空格 token);
// worktree 路径可能含空格,这里自行包引号。分支名 git 本就禁止空格,无需处理。
const q = (p) => (isWin && /\s/.test(p) ? `"${p}"` : p);

const GH_TIMEOUT = 30_000;
const ORPHAN_LOOKUP_CAP = 30; // 每轮孤儿分支最多实查 30 条,防 gh 调用爆炸;幂等,下轮继续

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}

/** 解析 `git worktree list --porcelain`(路径统一为 git 输出的正斜杠形式)。 */
function listWorktrees() {
  const out = git(['worktree', 'list', '--porcelain']).stdout;
  const entries = [];
  let cur = null;
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null, detached: false, locked: false, bare: false };
      entries.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
  }
  return entries;
}

const norm = (p) => {
  const s = resolve(p).replace(/\\/g, '/');
  return isWin ? s.toLowerCase() : s;
};

/** 托管 worktree 目录判定(见文件头安全边界 1)。 */
function isManagedPath(p) {
  const segs = norm(p).split('/').filter(Boolean);
  if (segs.includes('.cindy-worktrees')) return true;
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] === '.claude' && segs[i + 1] === 'worktrees') return true;
  }
  const extraRoots = (process.env.REVIEW_PR_WORKTREE_ROOTS || '')
    .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const target = norm(p);
  return extraRoots.some((root) => {
    const r = norm(root);
    return target === r || target.startsWith(`${r}/`);
  });
}

try {
  const scan = process.argv.includes('--scan');
  const prArg = argAfter('--pr');
  const dryRun = process.argv.includes('--dry-run');
  const graceMinutes = Number(argAfter('--grace-minutes')) || 30;
  const graceMs = graceMinutes * 60_000;
  const now = Date.now();
  if (scan === Boolean(prArg)) {
    throw new Error('用法:fix-worktree-cleanup.mjs <--scan | --pr <N>> [--dry-run] [--grace-minutes 30]');
  }

  const { owner, repo } = parseRepo();
  const slug = `${owner}/${repo}`;
  const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
  const defaultBranch = sym.ok && sym.stdout.trim()
    ? sym.stdout.trim().replace(/^refs\/remotes\/origin\//, '')
    : 'main';
  const protectedBranches = new Set([defaultBranch, 'main', 'master']);

  // ── PR 状态实查(按分支缓存,一轮内同分支只查一次)──
  const prCache = new Map();
  function prsForBranch(branch) {
    if (!prCache.has(branch)) {
      const r = gh(
        ['pr', 'list', '--repo', slug, '--head', branch, '--state', 'all',
          '--limit', '20', '--json', 'number,state,mergedAt,closedAt'],
        { allowFail: true, timeoutMs: GH_TIMEOUT },
      );
      let prs = null; // null = 查询失败(区别于「查到 0 条」)
      if (r.ok) {
        try { prs = JSON.parse(r.stdout || '[]'); } catch { prs = null; }
      }
      prCache.set(branch, prs);
    }
    return prCache.get(branch);
  }

  /** 分支可否回收:{ removable, allMerged, prs, reason }。 */
  function judge(branch) {
    const prs = prsForBranch(branch);
    if (prs === null) return { removable: false, reason: 'gh 查询失败,保守跳过(下轮重试)' };
    if (!prs.length) return { removable: false, reason: '查不到对应 PR,来历不明不动' };
    if (prs.some((p) => p.state === 'OPEN')) return { removable: false, reason: 'PR 仍 open' };
    const latest = Math.max(0, ...prs.map((p) => Date.parse(p.mergedAt || p.closedAt || '') || 0));
    if (latest && now - latest < graceMs) {
      const left = Math.ceil((graceMs - (now - latest)) / 60_000);
      return { removable: false, reason: `宽限期内(还剩约 ${left} 分钟),防跟进会话还在收尾` };
    }
    return {
      removable: true,
      allMerged: prs.every((p) => p.state === 'MERGED'),
      prs: prs.map((p) => ({ number: p.number, state: p.state })),
    };
  }

  // ── 定点模式:先取 PR 元数据,确定目标分支集合;OPEN 直接拒绝 ──
  let targetBranches = null;
  let prNumber = null;
  if (prArg) {
    prNumber = parsePR(prArg);
    const v = gh(
      ['pr', 'view', String(prNumber), '--repo', slug, '--json', 'state,headRefName'],
      { allowFail: true, timeoutMs: GH_TIMEOUT },
    );
    if (!v.ok) fail(`gh pr view #${prNumber} 失败: ${v.stderr.trim().slice(0, 200)}`);
    const info = JSON.parse(v.stdout);
    if (info.state === 'OPEN') {
      print({ ok: true, mode: 'pr', pr: prNumber, state: 'OPEN', removedWorktrees: [], deletedBranches: [], skipped: [{ reason: 'PR 仍 open,不回收' }] });
      process.exit(0);
    }
    targetBranches = new Set([info.headRefName, `pr-${prNumber}`]);
  }

  const worktrees = listWorktrees();
  const cwd = norm(process.cwd());
  const removedWorktrees = [];
  const deletedBranches = [];
  const skipped = [];
  const errors = [];
  const detachedManaged = [];
  const branchDeleteWanted = new Map(); // branch → prs(阶段 A 判定过的直接复用)

  // ── 阶段 A:回收 worktree(首条是主工作树,永不参与)──
  const removedPaths = new Set();
  for (const w of worktrees.slice(1)) {
    if (w.bare) continue;
    if (targetBranches && !(w.branch && targetBranches.has(w.branch))) continue;
    if (!isManagedPath(w.path)) {
      // scan 模式对用户自建 worktree 保持静默(每轮报告是噪音);定点模式命中同名分支要说明白
      if (targetBranches) skipped.push({ path: w.path, branch: w.branch, reason: '不在托管 worktree 目录,视为用户自建,不动' });
      continue;
    }
    if (w.detached) { detachedManaged.push(w.path); continue; }
    if (protectedBranches.has(w.branch)) { skipped.push({ path: w.path, branch: w.branch, reason: '默认/保护分支' }); continue; }
    if (w.locked) { skipped.push({ path: w.path, branch: w.branch, reason: 'worktree 被 lock,宿主可能仍在用' }); continue; }
    if (cwd === norm(w.path) || cwd.startsWith(`${norm(w.path)}/`)) {
      skipped.push({ path: w.path, branch: w.branch, reason: '包含当前 cwd' });
      continue;
    }
    const j = judge(w.branch);
    if (!j.removable) { skipped.push({ path: w.path, branch: w.branch, reason: j.reason }); continue; }
    if (!dryRun) {
      const r = git(['worktree', 'remove', '--force', q(w.path)], { allowFail: true, timeoutMs: 120_000 });
      if (!r.ok) { errors.push({ target: w.path, error: r.stderr.trim().slice(0, 200) }); continue; }
    }
    removedWorktrees.push({ path: w.path, branch: w.branch, prs: j.prs });
    removedPaths.add(w.path);
    if (j.allMerged) branchDeleteWanted.set(w.branch, j.prs);
  }

  // ── 阶段 B:删本地分支(刚释放的 + 孤儿)──
  const stillCheckedOut = new Set(
    worktrees.filter((w) => !removedPaths.has(w.path) && w.branch).map((w) => w.branch),
  );
  const localBranches = git(['for-each-ref', 'refs/heads', '--format=%(refname:short)'])
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  let orphanLookups = 0;
  for (const branch of localBranches) {
    if (protectedBranches.has(branch)) continue;
    if (stillCheckedOut.has(branch)) continue;
    if (targetBranches && !targetBranches.has(branch)) continue;
    if (!branchDeleteWanted.has(branch)) {
      // 孤儿分支:worktree 早没了(或本就没建过)但分支残留。pr-<N> 是我们自己的审查/
      // 检出命名,MERGED/CLOSED 都删;其他名字按 judge 从严(全 MERGED 才删)。
      const prMatch = branch.match(/^pr-(\d+)$/);
      if (!prCache.has(branch) && ++orphanLookups > ORPHAN_LOOKUP_CAP) {
        skipped.push({ branch, reason: `本轮孤儿分支实查已达 ${ORPHAN_LOOKUP_CAP} 条上限,下轮继续` });
        continue;
      }
      if (prMatch) {
        const v = gh(
          ['pr', 'view', prMatch[1], '--repo', slug, '--json', 'state'],
          { allowFail: true, timeoutMs: GH_TIMEOUT },
        );
        let state = null;
        if (v.ok) { try { state = JSON.parse(v.stdout).state; } catch { state = null; } }
        if (state !== 'MERGED' && state !== 'CLOSED') {
          skipped.push({ branch, reason: state === 'OPEN' ? 'PR 仍 open' : 'PR 状态未知,保守跳过' });
          continue;
        }
        branchDeleteWanted.set(branch, [{ number: Number(prMatch[1]), state }]);
      } else {
        const j = judge(branch);
        if (!j.removable) { skipped.push({ branch, reason: j.reason }); continue; }
        if (!j.allMerged) { skipped.push({ branch, reason: '含 CLOSED 未合并的 PR,分支保留' }); continue; }
        branchDeleteWanted.set(branch, j.prs);
      }
    }
    const prs = branchDeleteWanted.get(branch);
    if (!dryRun) {
      const r = git(['branch', '-D', branch], { allowFail: true });
      if (!r.ok) { errors.push({ target: `branch ${branch}`, error: r.stderr.trim().slice(0, 200) }); continue; }
    }
    deletedBranches.push({ branch, prs });
  }

  if (!dryRun && (removedWorktrees.length || removedPaths.size)) {
    git(['worktree', 'prune'], { allowFail: true });
  }

  print({
    ok: true,
    mode: prArg ? 'pr' : 'scan',
    ...(prNumber != null ? { pr: prNumber } : {}),
    dryRun,
    repo: slug,
    defaultBranch,
    graceMinutes,
    removedWorktrees,
    deletedBranches,
    skipped,
    ...(detachedManaged.length ? { detachedManaged, detachedNote: 'detached worktree 无法映射到 PR,只报告不回收' } : {}),
    errors,
  });
  process.exit(errors.length ? 1 : 0);
} catch (e) {
  fail(e);
}
