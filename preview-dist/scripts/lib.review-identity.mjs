import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const SKILL_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function currentReviewIdentity({ explicitRoot, worktree = process.cwd() } = {}) {
  const repoRoot = resolveReviewRepoRoot({ explicitRoot });
  if (repoRoot !== resolveReviewRepoRoot()) throw new Error('显式仓根与脚本实际使用仓根不一致');
  return buildReviewIdentity({ repoRoot, skillRoot: SKILL_ROOT, worktree });
}

const real = (p) => realpathSync(resolve(p));
function worktreeRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('仓根必须是绝对路径');
  const canonical = real(path);
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: canonical, encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0 || real(r.stdout.trim()) !== canonical) throw new Error('必须使用 Git worktree 根目录');
  return canonical;
}
function gitCommonDir(repoRoot) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) throw new Error(`无法解析 git common-dir:${r.stderr?.trim() || r.status}`);
  return real(resolve(repoRoot, r.stdout.trim()));
}

export function buildReviewIdentity({ repoRoot, skillRoot, worktree = null } = {}) {
  if (!repoRoot || !skillRoot) throw new Error('缺 repoRoot 或 skillRoot');
  const repo = worktreeRoot(repoRoot);
  const skill = real(skillRoot);
  const identity = { repoRoot: repo, gitCommonDir: gitCommonDir(repo), skillRoot: skill };
  if (worktree) {
    const wt = worktreeRoot(worktree);
    const wtCommon = gitCommonDir(wt);
    const rel = relative(skill, wt);
    const insideSkill = rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    if (wtCommon !== identity.gitCommonDir) throw new Error('审查 worktree 与目标仓 git common-dir 不一致');
    if (insideSkill) throw new Error('审查 worktree 不得位于 Skill 根内');
    identity.worktree = wt;
    identity.worktreeGitCommonDir = wtCommon;
  }
  return identity;
}

export function assertReviewIdentity(expected, actual) {
  if (!expected || !actual) throw new Error('缺审查执行身份');
  const fields = ['repoRoot', 'gitCommonDir', 'skillRoot', 'worktree', 'worktreeGitCommonDir'];
  for (const field of fields) {
    if ((expected?.[field] ?? null) !== (actual?.[field] ?? null)) {
      throw new Error(`审查执行身份不一致:${field}`);
    }
  }
  return true;
}

export function assertReviewArtifactPaths(identity, paths) {
  const worktree = real(identity.worktree);
  for (const path of paths.filter(Boolean)) {
    const absolute = resolve(path);
    // New outputs have no realpath yet; resolve their parent. Existing symlinks,
    // including dangling links, must resolve successfully before any I/O.
    const entry = lstatSync(absolute, { throwIfNoEntry: false });
    const canonical = entry ? real(absolute) : resolve(real(dirname(absolute)), basename(absolute));
    const rel = relative(worktree, canonical);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('审查输入输出文件必须位于绑定的 review worktree 内');
    }
  }
  return true;
}

export function resolveReviewRepoRoot({ explicitRoot, envRoot = process.env.REVIEW_PR_REPO_ROOT, cwd = process.cwd() } = {}) {
  const root = worktreeRoot(explicitRoot || envRoot || cwd);
  for (const candidate of [explicitRoot, envRoot].filter(Boolean)) {
    if (worktreeRoot(candidate) !== root) throw new Error('显式仓根与 REVIEW_PR_REPO_ROOT 不一致');
  }
  if (gitCommonDir(worktreeRoot(cwd)) !== gitCommonDir(root)) throw new Error('cwd 与目标仓不是同一 Git 仓库');
  return root;
}

export function validateReviewDispatch({ agent, provider, isolation, worktree, expectedWorktree, repoRoot, skillRoot } = {}) {
  if (typeof agent !== 'string' || !agent.trim() || typeof provider !== 'string' || !provider.trim() || isolation !== 'worktree' || !worktree || !expectedWorktree || !repoRoot || !skillRoot) {
    return { ok: false, reason: '阶段二派工字段不完整' };
  }
  if (/typescript-reviewer/i.test(`${agent} ${provider}`)) return { ok: false, reason: '禁止使用 typescript-reviewer 审查席' };
  if (agent !== 'general-purpose') return { ok: false, reason: '阶段二只允许 general-purpose 审查席' };
  try {
    if (!isAbsolute(expectedWorktree)) throw new Error('已准备 worktree 必须是绝对路径');
    const identity = buildReviewIdentity({ repoRoot, skillRoot, worktree });
    if (identity.worktree !== real(expectedWorktree)) return { ok: false, reason: '派工 worktree 与已准备 worktree 不一致' };
    return { ok: true, identity };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

export function createDispatchReceipt({ pr, snapshotHash, identity, agent = 'general-purpose', provider = 'claude-code', isolation = 'worktree' } = {}) {
  const request = { pr, snapshotHash, identity, agent, provider, isolation };
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return { schemaVersion: 'review-dispatch/1', receiptId: requestHash.slice(0, 32), requestHash, ...request };
}

export function dispatchReview({ pr, snapshotHash, identity, agent = 'general-purpose', provider = 'claude-code', isolation = 'worktree' } = {}) {
  const checked = validateReviewDispatch({ agent, provider, isolation, worktree: identity?.worktree, expectedWorktree: identity?.worktree, repoRoot: identity?.repoRoot, skillRoot: identity?.skillRoot });
  if (!checked.ok) throw new Error(checked.reason);
  return createDispatchReceipt({ pr, snapshotHash, identity: checked.identity, agent, provider, isolation });
}

export function assertDispatchReceipt(receipt, { pr, snapshotHash, identity } = {}) {
  if (!receipt || receipt.schemaVersion !== 'review-dispatch/1' || receipt.pr !== pr || receipt.snapshotHash !== snapshotHash) {
    throw new Error('缺少或过期的阶段二派工凭据');
  }
  assertReviewIdentity(receipt.identity, identity);
  const request = {
    pr: receipt.pr, snapshotHash: receipt.snapshotHash, identity: receipt.identity,
    agent: receipt.agent, provider: receipt.provider, isolation: receipt.isolation,
  };
  const expected = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  if (receipt.requestHash !== expected || receipt.receiptId !== expected.slice(0, 32)) throw new Error('阶段二派工凭据校验失败');
  const dispatch = validateReviewDispatch({ ...request, worktree: identity.worktree, expectedWorktree: identity.worktree, repoRoot: identity.repoRoot, skillRoot: identity.skillRoot });
  if (!dispatch.ok) throw new Error(dispatch.reason);
  return true;
}
