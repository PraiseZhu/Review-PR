#!/usr/bin/env node
// Owned, detached PR worktrees. No GitHub API calls and no shared FETCH_HEAD.
// create|remove|verify --plan <file> --pr <N> --lock-token <token>
// remove requires --agent-exited; --no-agent-started may record an absent, never-created tree.
// verify defaults to --expect removed.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './runtime-io.mjs';

const norm = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const samePath = (a, b) => norm(a) === norm(b);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stat = (path) => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function git(cwd, args, { allowFail = false, timeout = 120_000 } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal || (result.status !== 0 && !allowFail)) {
    throw new Error(`git ${args[0]} 失败: ${result.error?.message || result.signal || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function commonDir(cwd) {
  return realpathSync(resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']).stdout.trim()));
}

function registrations(cwd) {
  const records = [];
  let entry;
  // -z preserves spaces, Unicode and newlines without Git's quoted-path encoding.
  for (const field of git(cwd, ['worktree', 'list', '--porcelain', '-z']).stdout.split('\0')) {
    if (field.startsWith('worktree ')) { entry = { path: field.slice(9) }; records.push(entry); }
    else if (entry && field.startsWith('HEAD ')) entry.head = field.slice(5).toLowerCase();
    else if (entry && field === 'detached') entry.detached = true;
    else if (entry && (field === 'locked' || field.startsWith('locked '))) entry.locked = true;
    else if (entry && field === 'bare') entry.bare = true;
  }
  return records;
}

function assertPlainDirectory(path) {
  const info = stat(path);
  if (!info || !info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    throw new Error(`worktree 路径不是原位普通目录: ${path}`);
  }
}

function assertTargetPath(context) {
  const { roundDir, worktreeRoot, path, repoRoot, common } = context;
  assertPlainDirectory(roundDir);
  if (!samePath(dirname(worktreeRoot), roundDir) || !samePath(dirname(path), worktreeRoot) || !inside(roundDir, path)) {
    throw new Error('worktree 路径越出本轮固定目录');
  }
  if (stat(worktreeRoot)) assertPlainDirectory(worktreeRoot);
  if (stat(path)) assertPlainDirectory(path);
  if (samePath(path, repoRoot) || inside(path, repoRoot) || samePath(path, common) || inside(path, common)) {
    throw new Error('拒绝将当前仓库或其 git common-dir 作为清理目标');
  }
  const current = realpathSync(process.cwd());
  if (samePath(path, current) || inside(path, current)) throw new Error('主调度进程必须先离开待清理 worktree');
}

async function loadContext(options, dependencies) {
  const planFile = realpathSync(resolve(options.planFile || ''));
  if (!stat(planFile)?.isFile()) throw new Error('plan 必须是普通文件');
  const roundDir = dirname(planFile);
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  if (plan.version !== 1 || !/^[a-zA-Z0-9-]+$/.test(plan.runId || '') || !/^[\w.-]+\/[\w.-]+$/.test(plan.repo || '')) {
    throw new Error('plan 的 version/runId/repo 不完整');
  }
  if (plan.roundDir && !samePath(realpathSync(resolve(plan.roundDir)), roundDir)) throw new Error('plan.roundDir 与计划文件所在目录不符');
  const pr = Number(options.pr);
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('PR 编号无效');
  const items = Array.isArray(plan.queue) ? plan.queue : (plan.groups || []).flatMap((group) => group.prs || []);
  const matches = items.filter((item) => Number(item.pr ?? item.number) === pr);
  if (matches.length !== 1 || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(matches[0].head || '')) {
    throw new Error('PR 不在本轮唯一执行名单中或 head 不完整');
  }
  const lockToken = String(options.lockToken || '').trim();
  if (!lockToken) throw new Error('缺少当前 review lock token');
  const repoRoot = realpathSync(resolve(options.repoRoot || process.env.REVIEW_PR_REPO_ROOT || process.cwd()));
  const common = commonDir(repoRoot);
  const origin = git(repoRoot, ['remote', 'get-url', 'origin']).stdout.trim().replaceAll('\\', '/');
  const parsed = origin.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!parsed || `${parsed[1]}/${parsed[2]}`.toLowerCase() !== plan.repo.toLowerCase()) throw new Error('plan.repo 与所在仓库 origin 不符');
  let assertLock = dependencies.assertLock;
  if (!assertLock) {
    const core = await import('./lib.mjs');
    if (!samePath(commonDir(core.REPO_ROOT), common)) throw new Error('当前 review 锁与目标仓库 common-dir 不符');
    assertLock = core.assertActiveReviewLock;
  }
  assertLock(lockToken);
  const worktreeRoot = join(roundDir, 'worktrees');
  const context = { planFile, roundDir, plan, repoRoot, common, pr, head: matches[0].head.toLowerCase(),
    worktreeRoot, path: join(worktreeRoot, `pr-${pr}`), ownershipFile: join(roundDir, `worktree-pr-${pr}.json`),
    fetchRef: `refs/review-pr-worktrees/${plan.runId}/pr-${pr}`, assertLock: () => assertLock(lockToken),
    lockHash: hash(lockToken) };
  assertTargetPath(context);
  return context;
}

function binding(context) {
  return { version: 1, kind: 'review-pr-worktree', runId: context.plan.runId, repo: context.plan.repo,
    pr: context.pr, head: context.head, path: context.path, commonDir: context.common, fetchRef: context.fetchRef };
}

function owner(context, required = true) {
  const info = stat(context.ownershipFile);
  if (!info) { if (required) throw new Error('缺少本轮 worktree 归属凭据，拒绝接管或清理'); return null; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('worktree 归属文件不能是链接或目录');
  const record = JSON.parse(readFileSync(context.ownershipFile, 'utf8'));
  const expected = binding(context);
  for (const key of Object.keys(expected)) {
    const equal = ['path', 'commonDir'].includes(key) ? typeof record[key] === 'string' && samePath(record[key], expected[key]) : record[key] === expected[key];
    if (!equal) throw new Error(`worktree 归属不符: ${key}`);
  }
  if (!/^[a-f0-9]{64}$/.test(record.creationLockHash || '') || !record.createdAt) throw new Error('worktree 创建凭据不完整');
  return record;
}

function inspect(context, record) {
  assertTargetPath(context);
  const matching = registrations(context.repoRoot).filter((entry) => samePath(entry.path, context.path));
  if (matching.length > 1) throw new Error('同一路径有重复 worktree 注册');
  const physicalPresent = Boolean(stat(context.path));
  const registration = matching[0];
  if (registration && (!registration.detached || registration.bare || registration.locked || registration.head !== context.head)) {
    throw new Error('worktree 必须保持本轮 head 的 detached、未锁定状态');
  }
  let gitDir;
  if (physicalPresent) {
    if (!registration) throw new Error('目录存在但没有匹配的 worktree 注册，拒绝接管或删除');
    const dotGit = stat(join(context.path, '.git'));
    if (!dotGit?.isFile() || dotGit.isSymbolicLink()) throw new Error('目标不是独立 linked worktree');
    if (!samePath(commonDir(context.path), context.common)) throw new Error('worktree 属于其他仓库 common-dir');
    gitDir = realpathSync(git(context.path, ['rev-parse', '--absolute-git-dir']).stdout.trim());
    if (!inside(join(context.common, 'worktrees'), gitDir) || !samePath(dirname(gitDir), join(context.common, 'worktrees'))) {
      throw new Error('worktree git 注册目录越界或指向主工作树');
    }
    const registeredDotGit = resolve(gitDir, readFileSync(join(gitDir, 'gitdir'), 'utf8').trim());
    if (!samePath(registeredDotGit, join(context.path, '.git'))) throw new Error('worktree 注册的反向路径不匹配');
    if (record?.gitDir && !samePath(record.gitDir, gitDir)) throw new Error('worktree git 注册身份与归属凭据不符');
    if (git(context.path, ['rev-parse', 'HEAD']).stdout.trim().toLowerCase() !== context.head) throw new Error('worktree HEAD 与本轮绑定不符');
  }
  return { physicalPresent, registrationPresent: Boolean(registration), gitDir };
}

function receipt(context, extra) {
  return { ok: true, ...binding(context), ownershipFile: context.ownershipFile, ...extra };
}

function exclusive(context, operation) {
  const file = join(context.roundDir, `.worktree-pr-${context.pr}.operation`);
  const id = randomUUID();
  const reservation = { id, pid: process.pid, runId: context.plan.runId, pr: context.pr, head: context.head,
    path: context.path, commonDir: context.common };
  let fd;
  try {
    try { fd = openSync(file, 'wx', 0o600); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previousRaw = readFileSync(file, 'utf8');
      const previous = JSON.parse(previousRaw);
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || previous.runId !== reservation.runId ||
          previous.pr !== reservation.pr || previous.head !== reservation.head ||
          !samePath(previous.path || '', reservation.path) || !samePath(previous.commonDir || '', reservation.commonDir)) {
        throw new Error('worktree 操作锁归属不明，拒绝接管');
      }
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('本 PR worktree 操作仍在运行');
      context.assertLock();
      if (readFileSync(file, 'utf8') !== previousRaw) throw new Error('worktree 操作锁已变化');
      unlinkSync(file);
      fd = openSync(file, 'wx', 0o600);
    }
    writeFileSync(fd, JSON.stringify(reservation));
    closeSync(fd); fd = undefined;
    return operation();
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Never release another process's operation reservation.
    try { if (JSON.parse(readFileSync(file, 'utf8')).id === id) unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function dropFetchRef(context) {
  const ref = git(context.repoRoot, ['rev-parse', '--verify', '--quiet', context.fetchRef], { allowFail: true });
  if (ref.ok) git(context.repoRoot, ['update-ref', '-d', context.fetchRef, ref.stdout.trim()]);
}

export async function createReviewWorktree(options, dependencies = {}) {
  const context = await loadContext(options, dependencies);
  return exclusive(context, () => {
    let record = owner(context, false);
    const state = inspect(context, record);
    if (!record && (state.physicalPresent || state.registrationPresent)) throw new Error('既有 worktree 没有本轮归属凭据，拒绝接管');
    if (record && state.physicalPresent && state.registrationPresent) {
      if (record.removedAt) throw new Error('已清理路径被重新占用，拒绝复用');
      return receipt(context, { created: false, reused: true, verified: true, generation: record.generation || 1 });
    }
    if (state.registrationPresent) throw new Error('旧 worktree 目录缺失但注册仍在，请先 remove');
    context.assertLock();
    mkdirSync(context.worktreeRoot, { recursive: true });
    assertTargetPath(context);
    if (record?.removedAt) {
      if (record.agentExited !== true || !record.physicalAbsent || !record.registrationAbsent) throw new Error('旧 generation 没有完整清理凭据');
      const previous = { generation: record.generation || 1, createdAt: record.createdAt, removedAt: record.removedAt,
        creationLockHash: record.creationLockHash, removalLockHash: record.removalLockHash };
      record = { ...binding(context), generation: (record.generation || 1) + 1,
        previousGenerations: [...(record.previousGenerations || []), previous],
        creationLockHash: context.lockHash, createdAt: new Date().toISOString() };
    }
    record ||= { ...binding(context), generation: 1, creationLockHash: context.lockHash, createdAt: new Date().toISOString() };
    record = { ...record, removedAt: null, agentExited: false, physicalAbsent: false, registrationAbsent: false };
    atomicWriteJson(context.ownershipFile, { ...record, stage: 'creating' });
    try {
      context.assertLock();
      git(context.repoRoot, ['fetch', '--no-write-fetch-head', '--no-tags', 'origin', `+refs/pull/${context.pr}/head:${context.fetchRef}`]);
      const fetched = git(context.repoRoot, ['rev-parse', context.fetchRef]).stdout.trim().toLowerCase();
      if (fetched !== context.head) throw new Error('refs/pull 的 head 已变化，拒绝创建旧名单 worktree');
      context.assertLock();
      assertTargetPath(context);
      git(context.repoRoot, ['worktree', 'add', '--detach', context.path, fetched]);
      const actual = inspect(context, record);
      if (!actual.physicalPresent || !actual.registrationPresent) throw new Error('worktree 创建后未同时取得目录与 git 注册');
      atomicWriteJson(context.ownershipFile, { ...record, stage: 'created', gitDir: actual.gitDir });
      return receipt(context, { created: true, reused: false, verified: true, generation: record.generation || 1 });
    } finally { dropFetchRef(context); }
  });
}

export async function removeReviewWorktree(options, dependencies = {}) {
  if (options.agentExited !== true) throw new Error('只有主 session 确认 PR agent 已退出后才能 remove');
  const context = await loadContext(options, dependencies);
  return exclusive(context, () => {
    let record = owner(context, options.noAgentStarted !== true);
    const before = inspect(context, record);
    if ((!record || record.noWorktree === true) && (before.physicalPresent || before.registrationPresent)) {
      throw new Error('没有已创建 worktree 的归属凭据，不能删除现存目录或 git 注册');
    }
    if (!record) {
      // The coordinator certifies that no PR agent ever started. This receipt records
      // verified absence, not ownership of a physical tree which might appear later.
      record = { ...binding(context), generation: 1, creationLockHash: context.lockHash,
        createdAt: new Date().toISOString(), noWorktree: true, noAgentStarted: true };
    }
    if (before.physicalPresent) {
      if (git(context.path, ['status', '--porcelain=v1', '--untracked-files=no']).stdout.trim()) {
        throw new Error('worktree 有 tracked 改动，拒绝丢弃可能的用户修改');
      }
    }
    if (before.physicalPresent || before.registrationPresent) {
      context.assertLock();
      // Git performs recursive removal; verify the final absolute physical target first,
      // including Windows junctions. --force only permits this owned tree's build output.
      assertTargetPath(context);
      inspect(context, record);
      git(context.repoRoot, ['worktree', 'remove', '--force', '--', context.path]);
    }
    const after = inspect(context, record);
    if (after.physicalPresent || after.registrationPresent) throw new Error('worktree 清理未完成：目录或 git 注册仍存在');
    if (record.noWorktree !== true) dropFetchRef(context);
    const removedAt = record.removedAt || new Date().toISOString();
    atomicWriteJson(context.ownershipFile, { ...record, stage: 'removed', removedAt, removalLockHash: context.lockHash,
      agentExited: true, physicalAbsent: true, registrationAbsent: true });
    return receipt(context, { removed: true, verified: true, alreadyRemoved: !before.physicalPresent && !before.registrationPresent,
      physicalAbsent: true, registrationAbsent: true, removedAt, generation: record.generation || 1,
      ...(record.noWorktree ? { noWorktree: true, noAgentStarted: true } : {}) });
  });
}

export async function verifyReviewWorktree(options, dependencies = {}) {
  const context = await loadContext(options, dependencies);
  if (stat(join(context.roundDir, `.worktree-pr-${context.pr}.operation`))) throw new Error('本 PR worktree 操作尚未结束，不能验证完成');
  const record = owner(context);
  const state = inspect(context, record);
  const expect = options.expect || 'removed';
  if (!['removed', 'present'].includes(expect)) throw new Error('--expect 必须是 removed 或 present');
  if (expect === 'present') {
    if (!state.physicalPresent || !state.registrationPresent || record.removedAt) throw new Error('本轮 worktree 不处于可复用状态');
    return receipt(context, { present: true, removed: false, verified: true, generation: record.generation || 1 });
  }
  if (state.physicalPresent || state.registrationPresent) throw new Error('worktree 尚未清理：目录或 git 注册仍存在');
  if (!record.removedAt || record.agentExited !== true) throw new Error('尚无 agent 已退出并完成清理的回执，请先 remove');
  return receipt(context, { removed: true, verified: true, physicalAbsent: true, registrationAbsent: true,
    removedAt: record.removedAt, generation: record.generation || 1,
    ...(record.noWorktree ? { noWorktree: true, noAgentStarted: true } : {}) });
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  try {
    const [action, ...args] = process.argv.slice(2);
    const get = (flag) => {
      const index = args.indexOf(flag);
      if (index < 0) return undefined;
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} 缺少参数`);
      return args[index + 1];
    };
    const operations = { create: createReviewWorktree, remove: removeReviewWorktree, verify: verifyReviewWorktree };
    if (!operations[action]) throw new Error('操作必须为 create、remove 或 verify');
    const result = await operations[action]({ planFile: get('--plan'), pr: get('--pr'), lockToken: get('--lock-token'),
      repoRoot: get('--repo-root'), agentExited: args.includes('--agent-exited'),
      noAgentStarted: args.includes('--no-agent-started'), expect: get('--expect') });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
