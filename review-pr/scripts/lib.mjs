#!/usr/bin/env node
// lib.mjs — review-pr skill 脚本的共享底座(gh / git 封装、repo 解析、JSON 输出)
//
// 设计原则:这些脚本只做「采集 + 客观判定 + git 动作」这些确定性的事,
// 不做任何语义判断(段落是否实质、bot 评论是不是个问题等留给 skill 里的 LLM)。
// 跨平台:spawnSync 在 Windows 走 shell(让 cmd.exe 能解析 gh.cmd / git);
// 所有外部命令参数都是简单 token(无空格),长字符串(GraphQL query)走 stdin,
// 因此 Windows 下 shell:true 不会触发引号问题。
//
// 鉴权统一走 gh(本项目 token 由 gh 管理、存系统凭据),脚本绝不打印 token。

import { spawnSync, spawn } from 'node:child_process';
import process from 'node:process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { atomicWriteJson, parseApiJson, parseScriptResult } from './runtime-io.mjs';
export { atomicWriteJson, parseApiJson } from './runtime-io.mjs';

const isWin = process.platform === 'win32';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, '..');

/**
 * Skill 与目标仓库解耦：
 * - 所有 git / gh 命令默认作用于调用方 cwd（scheduler 的 workingDir）。
 * - REVIEW_PR_REPO_ROOT 可显式指定目标仓库，入口脚本应在执行前 chdir 到该目录。
 * - 运行时状态放在系统临时目录并按目标仓库绝对路径隔离，不写 Skill 或项目仓库。
 */
const rawRepoRoot = process.env.REVIEW_PR_REPO_ROOT || process.cwd();
export const REPO_ROOT = resolve(rawRepoRoot);
// 状态目录锚点不能直接用 REPO_ROOT:scheduler useWorktree 轮次与隔离审查 agent 的 cwd
// 是每轮新建的 worktree 路径,按它哈希会让锁/空转指纹/fix-session/催办去重每轮落进
// 不同目录——互斥锁形同虚设(多轮并发)、pre-check 探测的锁目录与会话实际写入目录
// 对不上、last-scan 空转缓存永不命中(2026-07-25 实锤)。用 git-common-dir(同一仓库
// 所有 worktree 共享的主 .git)归一锚点;非 git 仓库 / git 不可用时退回 REPO_ROOT。
function resolveStateAnchor() {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: REPO_ROOT, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000,
    });
    const out = r.status === 0 ? (r.stdout ?? '').trim() : '';
    if (out) return resolve(REPO_ROOT, out); // 主仓库返回相对 ".git",worktree 返回绝对路径,一律归一成绝对
  } catch { /* 回退 REPO_ROOT */ }
  return REPO_ROOT;
}
const stateAnchor = resolveStateAnchor();
const repoStateKey = createHash('sha256')
  .update(isWin ? stateAnchor.toLowerCase() : stateAnchor)
  .digest('hex')
  .slice(0, 20);
const stateRoot = resolve(process.env.REVIEW_PR_STATE_DIR || join(tmpdir(), 'review-pr'));
export const STATE_DIR = join(stateRoot, repoStateKey);
mkdirSync(STATE_DIR, { recursive: true });

export function stateFile(name) {
  return join(STATE_DIR, name);
}

export const LOCK_FILE = stateFile('lock.json');

/**
 * 释放主锁(release-lock.mjs / cleanup.mjs / prepare.mjs 异常回滚共用)。
 * token 提供时只删「内容 token 匹配」的锁——防止误删并发实例刚接管重建的锁
 * (误删的后果是双实例同跑,比漏删严重得多);token 缺省保持旧行为(直接删),
 * 兼容尚未传 token 的老调用方。旧格式锁(无 token 字段 / 裸 ISO)视为他人持有:
 * 带 token 的调用方一定是新版 prepare 建的锁,内容对不上就不是自己的。
 * 返回 { released, alreadyAbsent, notOwner }。
 */
export function releaseLockOwned(token) {
  let raw;
  try {
    raw = readFileSync(LOCK_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (token) {
        try { unlinkSync(authoritySnapshotFile(token)); } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') throw cleanupError;
        }
      }
      return { released: false, alreadyAbsent: true, notOwner: false };
    }
    throw e;
  }
  if (token) {
    let cur = null;
    try { cur = JSON.parse(raw).token ?? null; } catch { /* 旧格式无 token */ }
    if (cur !== token) return { released: false, alreadyAbsent: false, notOwner: true };
  }
  try {
    unlinkSync(LOCK_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // 并发下别人可能已抢先删,等价于已释放
  }
  if (token) {
    try {
      unlinkSync(authoritySnapshotFile(token));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return { released: true, alreadyAbsent: false, notOwner: false };
}

/** 读取 Skill 私有规则；允许安装方用环境变量覆盖配置文件。 */
export function loadRules() {
  const rulesFile = resolve(
    process.env.REVIEW_PR_RULES_FILE || join(SKILL_ROOT, 'config', 'pr-rules.json'),
  );
  const rules = JSON.parse(readFileSync(rulesFile, 'utf8'));
  const legacyKeys = ['maintainers', 'approvalExemptAuthors'].filter((key) =>
    Object.prototype.hasOwnProperty.call(rules, key));
  if (legacyKeys.length) {
    throw new Error(
      `${rulesFile} 仍含旧审批名单 ${legacyKeys.join(' / ')}；请改用 maintainerAllowlist 补充 CODEOWNERS 根 Team`,
    );
  }
  rules.maintainerAllowlist = normalizeMaintainerAllowlist(rules.maintainerAllowlist);
  return rules;
}

function normalizeLoginList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((login) => String(login ?? '').trim().toLowerCase()).filter(Boolean))];
}

/** 审批补充白名单：配置异常必须阻断，不能静默丢掉本应生效或本不应生效的账号。 */
export function normalizeMaintainerAllowlist(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('maintainerAllowlist 必须是 GitHub login 数组');
  for (let index = 0; index < value.length; index += 1) {
    const login = typeof value[index] === 'string' ? value[index].trim() : '';
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)) {
      throw new Error(`maintainerAllowlist[${index}] 不是有效的 GitHub login`);
    }
  }
  return normalizeLoginList(value).sort();
}

export const MAINTAINER_AUTHORITY_VERSION = 2;
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

function authorityError(message) {
  const error = new Error(message);
  error.code = 'MAINTAINER_AUTHORITY_UNAVAILABLE';
  return error;
}

function parseJsonResult(result, label) {
  if (!result?.ok) {
    const detail = String(result?.stderr || result?.stdout || '').trim().split('\n')[0];
    throw authorityError(`${label}失败:${detail || 'GitHub 未返回可用结果'}`);
  }
  try {
    return JSON.parse(result.stdout || 'null');
  } catch (error) {
    throw authorityError(`${label}返回的 JSON 无法解析:${error.message}`);
  }
}

/**
 * 解析 CODEOWNERS 中唯一的全仓维护者 Team。只认精确根规则 `* @org/team-slug`；
 * 局部 owner 不获得 review-pr 的审批权限。
 */
export function parseMaintainerTeamFromCodeowners(codeowners, { repoOwner = '' } = {}) {
  const rootRules = [];
  const lines = String(codeowners ?? '').replace(/^﻿/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens[0] !== '*') continue;
    const commentIndex = tokens.findIndex((token, tokenIndex) => tokenIndex > 0 && token.startsWith('#'));
    const owners = tokens.slice(1, commentIndex < 0 ? tokens.length : commentIndex);
    rootRules.push({ line: index + 1, owners });
  }

  if (rootRules.length !== 1) {
    throw authorityError(
      rootRules.length === 0
        ? 'CODEOWNERS 缺少唯一的全仓根规则 `* @org/team-slug`'
        : `CODEOWNERS 找到 ${rootRules.length} 条 ` + '`*` 根规则，无法唯一确定维护者 Team',
    );
  }
  const [{ line, owners }] = rootRules;
  if (owners.length !== 1) {
    throw authorityError(`CODEOWNERS:${line} 的 ` + '`*` 根规则必须且只能指定一个 GitHub Team');
  }
  const match = owners[0].match(/^@([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/);
  if (!match) {
    throw authorityError(`CODEOWNERS:${line} 的 ` + '`*` 根 owner 必须是 @org/team-slug');
  }
  const org = match[1].toLowerCase();
  const teamSlug = match[2].toLowerCase();
  if (repoOwner && org !== String(repoOwner).trim().toLowerCase()) {
    throw authorityError(`CODEOWNERS:${line} 的 Team @${org}/${teamSlug} 不属于仓库组织 ${repoOwner}`);
  }
  return {
    line,
    org,
    teamSlug,
    teamHandle: `@${org}/${teamSlug}`,
  };
}

// [MIVO-PATCH maintainer-allowlist] maintainerSource=allowlist 的权限材料：不读 CODEOWNERS，
// 只认 maintainerAllowlist，且每个成员必须对仓库有 write/maintain/admin 权限。
export const MAINTAINER_SOURCE_ALLOWLIST = 'allowlist';
const isAllowlistAuthority = (authority) => authority?.source === MAINTAINER_SOURCE_ALLOWLIST;

function computeAllowlistAuthorityDigest(authority) {
  const version = Number(authority?.version);
  const repository = String(authority?.repository ?? '').trim().toLowerCase();
  const allowlistedMembers = normalizeLoginList(authority?.allowlistedMembers).sort();
  const members = normalizeLoginList(authority?.members).sort();
  const permissions = authority?.memberPermissions ?? {};
  if (
    version !== MAINTAINER_AUTHORITY_VERSION || !repository || allowlistedMembers.length === 0 ||
    normalizeLoginList(authority?.teamMembers).length !== 0 ||
    members.length !== allowlistedMembers.length || members.some((member, index) => member !== allowlistedMembers[index]) ||
    members.some((member) => !['push', 'maintain', 'admin'].includes(String(permissions[member] ?? '')))
  ) {
    throw authorityError('维护者白名单权限材料不完整，无法计算 digest');
  }
  const canonical = JSON.stringify({
    version, repository, source: MAINTAINER_SOURCE_ALLOWLIST, allowlistedMembers, members,
    memberPermissions: Object.fromEntries(members.map((member) => [member, permissions[member]])),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** 有效审批权限的稳定指纹；不把抓取时间或无关的默认分支提交纳入。 */
export function computeMaintainerAuthorityDigest(authority) {
  if (isAllowlistAuthority(authority)) return computeAllowlistAuthorityDigest(authority);
  const version = Number(authority?.version);
  const repository = String(authority?.repository ?? '').trim().toLowerCase();
  const path = String(authority?.codeowners?.path ?? '').trim();
  const org = String(authority?.codeowners?.org ?? '').trim().toLowerCase();
  const teamSlug = String(authority?.codeowners?.teamSlug ?? '').trim().toLowerCase();
  const teamPrivacy = String(authority?.codeowners?.teamPrivacy ?? '').trim().toLowerCase();
  const repositoryPermission = String(authority?.codeowners?.repositoryPermission ?? '').trim().toLowerCase();
  const teamMembers = normalizeLoginList(authority?.teamMembers).sort();
  const allowlistedMembers = normalizeLoginList(authority?.allowlistedMembers).sort();
  const members = normalizeLoginList(authority?.members).sort();
  const expectedMembers = normalizeLoginList([...teamMembers, ...allowlistedMembers]).sort();
  if (
    version !== MAINTAINER_AUTHORITY_VERSION || !repository || !path || !org || !teamSlug ||
    teamPrivacy !== 'closed' || !['push', 'maintain', 'admin'].includes(repositoryPermission) ||
    teamMembers.length === 0 || members.length === 0 ||
    members.length !== expectedMembers.length || members.some((member, index) => member !== expectedMembers[index])
  ) {
    throw authorityError('维护者权限材料不完整，无法计算 digest');
  }
  const canonical = JSON.stringify({
    version, repository, path, org, teamSlug, teamPrivacy, repositoryPermission,
    teamMembers, allowlistedMembers, members,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

const TEAM_REPO_MEDIA_TYPE = 'application/vnd.github.v3.repository+json';

/**
 * GitHub 默认 Accept 读 Team 单个仓库权限时常回 HTTP 204 空 body。
 * repository media type 或 Team 仓库列表才会带 permissions / role_name。
 * role_name=write 与 permissions.push 都映射为 digest 使用的 push。
 */
function mapTeamRepositoryPermission(teamRepo) {
  if (!teamRepo || typeof teamRepo !== 'object' || Array.isArray(teamRepo)) return null;
  const permissions = teamRepo.permissions;
  if (permissions?.admin === true) return 'admin';
  if (permissions?.maintain === true) return 'maintain';
  if (permissions?.push === true) return 'push';
  const role = String(teamRepo.role_name ?? '').trim().toLowerCase();
  if (role === 'admin') return 'admin';
  if (role === 'maintain') return 'maintain';
  if (role === 'write' || role === 'push') return 'push';
  return null;
}

function parseTeamRepoPayload(result) {
  if (!result?.ok) {
    const detail = String(result?.stderr || result?.stdout || '').trim().split('\n')[0];
    return { ok: false, value: null, detail: detail || 'GitHub 未返回可用结果' };
  }
  if (!String(result.stdout ?? '').trim()) return { ok: true, value: null, detail: null };
  try {
    return { ok: true, value: JSON.parse(result.stdout), detail: null };
  } catch (error) {
    return { ok: false, value: null, detail: `JSON 无法解析:${error.message}` };
  }
}

function fetchTeamRepositoryPermission({
  org, teamSlug, owner, repo, teamHandle, repository, ghFn,
}) {
  const endpoint = `orgs/${org}/teams/${teamSlug}/repos/${owner}/${repo}`;
  const first = parseTeamRepoPayload(ghFn(
    ['api', '--method', 'GET', endpoint],
    { allowFail: true, timeoutMs: 20_000 },
  ));
  if (!first.ok) {
    throw authorityError(`验证 Team ${teamHandle} 的仓库权限失败:${first.detail}`);
  }
  const firstPermission = mapTeamRepositoryPermission(first.value);
  if (firstPermission) return firstPermission;

  const media = parseTeamRepoPayload(ghFn(
    ['api', '--method', 'GET', endpoint, '-H', `Accept:${TEAM_REPO_MEDIA_TYPE}`],
    { allowFail: true, timeoutMs: 20_000 },
  ));
  if (!media.ok) {
    throw authorityError(`验证 Team ${teamHandle} 的仓库权限失败:${media.detail}`);
  }
  const mediaPermission = mapTeamRepositoryPermission(media.value);
  if (mediaPermission) return mediaPermission;

  const listed = fetchPaginatedRestItems(
    `orgs/${org}/teams/${teamSlug}/repos`,
    { ghFn, fields: [['per_page', '100']] },
  );
  const wanted = `${owner}/${repo}`.toLowerCase();
  const match = listed.find((item) => String(item?.full_name ?? '').toLowerCase() === wanted);
  const listedPermission = mapTeamRepositoryPermission(match);
  if (listedPermission) return listedPermission;

  throw authorityError(`Team ${teamHandle} 对 ${repository} 没有可验证的 write/maintain/admin 权限`);
}

function fetchPaginatedRestItems(endpoint, { ghFn = gh, fields = [] } = {}) {
  const args = ['api', '--method', 'GET', '--paginate', '--slurp', endpoint];
  for (const [key, value] of fields) args.push('-f', `${key}=${value}`);
  const result = ghFn(args, { allowFail: true, timeoutMs: 30_000 });
  const pages = parseJsonResult(result, `GitHub 分页读取 ${endpoint}`);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw authorityError(`GitHub 分页读取 ${endpoint} 的结果形状异常`);
  }
  return pages.flat();
}

/**
 * 从目标仓库默认分支的 CODEOWNERS 根 Team 实时解析成员，再与 Skill 的补充白名单取并集。
 * Team 仍是必需信任锚；任何不完整输入均抛错，白名单不得充当读取失败时的兜底。
 */
export function fetchMaintainerAuthority({
  owner,
  repo,
  ghFn = gh,
  nowIso = new Date().toISOString(),
  maintainerAllowlist = loadRules().maintainerAllowlist,
  maintainerSource = loadRules().maintainerSource,
} = {}) {
  const normalizedOwner = String(owner ?? '').trim();
  const normalizedRepo = String(repo ?? '').trim();
  if (!normalizedOwner || !normalizedRepo) throw authorityError('缺少目标仓库 owner/repo');
  const repository = `${normalizedOwner}/${normalizedRepo}`;

  const repoMeta = parseJsonResult(
    ghFn(['api', `repos/${repository}`], { allowFail: true, timeoutMs: 20_000 }),
    `读取仓库 ${repository}`,
  );
  const baseRef = String(repoMeta?.default_branch ?? '').trim();
  if (!baseRef) throw authorityError(`仓库 ${repository} 没有可验证的默认分支`);
  const commitMeta = parseJsonResult(
    ghFn(['api', '--method', 'GET', `repos/${repository}/commits/${encodeURIComponent(baseRef)}`], {
      allowFail: true,
      timeoutMs: 20_000,
    }),
    `读取 ${repository} 默认分支 commit`,
  );
  const baseSha = String(commitMeta?.sha ?? '').trim();
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
    throw authorityError(`仓库 ${repository} 默认分支 commit SHA 无效`);
  }

  // [MIVO-PATCH maintainer-allowlist] 只认白名单，逐个核实仓库权限；任何一人核不实就从严停止。
  if (maintainerSource === MAINTAINER_SOURCE_ALLOWLIST) {
    const allowlistedMembers = normalizeMaintainerAllowlist(maintainerAllowlist);
    if (allowlistedMembers.length === 0) throw authorityError('maintainerSource=allowlist 但 maintainerAllowlist 为空');
    const memberPermissions = {};
    for (const login of allowlistedMembers) {
      const permission = parseJsonResult(
        ghFn(['api', '--method', 'GET', `repos/${repository}/collaborators/${login}/permission`], {
          allowFail: true,
          timeoutMs: 20_000,
        }),
        `读取 ${login} 对 ${repository} 的权限`,
      );
      const role = String(permission?.role_name ?? permission?.permission ?? '').trim().toLowerCase();
      const mapped = role === 'admin' ? 'admin' : role === 'maintain' ? 'maintain'
        : (role === 'write' || role === 'push') ? 'push' : null;
      if (!mapped) {
        throw authorityError(`maintainerAllowlist 成员 ${login} 对 ${repository} 没有 write 及以上权限(当前 ${role || 'none'})`);
      }
      memberPermissions[login] = mapped;
    }
    const finalBase = parseJsonResult(
      ghFn(['api', '--method', 'GET', `repos/${repository}/commits/${encodeURIComponent(baseRef)}`], {
        allowFail: true,
        timeoutMs: 20_000,
      }),
      `复核 ${repository} 默认分支 commit`,
    );
    if (String(finalBase?.sha ?? '').toLowerCase() !== baseSha.toLowerCase()) {
      throw authorityError(`默认分支在维护者读取期间发生变化:${baseSha} → ${finalBase?.sha ?? '(empty)'}，请重试`);
    }
    const authority = {
      version: MAINTAINER_AUTHORITY_VERSION,
      repository,
      source: MAINTAINER_SOURCE_ALLOWLIST,
      fetchedAt: nowIso,
      base: { ref: baseRef, sha: baseSha },
      codeowners: {
        path: '(maintainerAllowlist)',
        blobSha: null,
        line: null,
        org: null,
        teamSlug: null,
        teamHandle: 'maintainerAllowlist',
        teamPrivacy: null,
        repositoryPermission: null,
      },
      teamMembers: [],
      teamMemberCount: 0,
      allowlistedMembers,
      allowlistedMemberCount: allowlistedMembers.length,
      members: allowlistedMembers,
      memberCount: allowlistedMembers.length,
      memberPermissions,
    };
    return { ...authority, digest: computeMaintainerAuthorityDigest(authority) };
  }

  let codeowners = null;
  const misses = [];
  for (const path of CODEOWNERS_PATHS) {
    const result = ghFn([
      'api', '--method', 'GET', `repos/${repository}/contents/${path}`, '-f', `ref=${baseSha}`,
    ], { allowFail: true, timeoutMs: 20_000 });
    if (!result?.ok) {
      const detail = String(result?.stderr || result?.stdout || '').trim().split('\n')[0];
      if (!/404|not found/i.test(detail)) {
        throw authorityError(`读取 ${path} 失败:${detail || 'GitHub 未返回可用结果'}`);
      }
      misses.push(`${path}:${detail || 'HTTP 404 Not Found'}`);
      continue;
    }
    const file = parseJsonResult(result, `读取 ${path}`);
    if (file?.type !== 'file' || file?.encoding !== 'base64' || typeof file?.content !== 'string') {
      throw authorityError(`${path} 不是可读取的 base64 CODEOWNERS 文件`);
    }
    let text;
    try {
      text = Buffer.from(file.content.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch (error) {
      throw authorityError(`${path} base64 解码失败:${error.message}`);
    }
    codeowners = { path, blobSha: String(file.sha ?? '').trim(), text };
    break;
  }
  if (!codeowners) {
    throw authorityError(`默认分支没有可读取的 CODEOWNERS(${misses.join(' / ')})`);
  }

  const team = parseMaintainerTeamFromCodeowners(codeowners.text, { repoOwner: normalizedOwner });
  const teamMeta = parseJsonResult(
    ghFn(['api', '--method', 'GET', `orgs/${team.org}/teams/${team.teamSlug}`], {
      allowFail: true,
      timeoutMs: 20_000,
    }),
    `读取 Team ${team.teamHandle}`,
  );
  const teamPrivacy = String(teamMeta?.privacy ?? '').trim().toLowerCase();
  if (teamPrivacy !== 'closed') {
    throw authorityError(`Team ${team.teamHandle} 必须是 GitHub 可见 Team(privacy=closed)，当前为 ${teamPrivacy || '(empty)'}`);
  }
  const repositoryPermission = fetchTeamRepositoryPermission({
    org: team.org,
    teamSlug: team.teamSlug,
    owner: normalizedOwner,
    repo: normalizedRepo,
    teamHandle: team.teamHandle,
    repository,
    ghFn,
  });
  const rawMembers = fetchPaginatedRestItems(
    `orgs/${team.org}/teams/${team.teamSlug}/members`,
    { ghFn, fields: [['role', 'all'], ['per_page', '100']] },
  );
  if (rawMembers.some((member) => !member || typeof member.login !== 'string' || !member.login.trim())) {
    throw authorityError(`Team ${team.teamHandle} 成员结果包含无效账号`);
  }
  const teamMembers = normalizeLoginList(rawMembers.map((member) => member.login)).sort();
  if (teamMembers.length === 0) throw authorityError(`Team ${team.teamHandle} 没有可验证的有效成员`);
  const allowlistedMembers = normalizeMaintainerAllowlist(maintainerAllowlist);
  const members = normalizeLoginList([...teamMembers, ...allowlistedMembers]).sort();

  const finalCommitMeta = parseJsonResult(
    ghFn(['api', '--method', 'GET', `repos/${repository}/commits/${encodeURIComponent(baseRef)}`], {
      allowFail: true,
      timeoutMs: 20_000,
    }),
    `复核 ${repository} 默认分支 commit`,
  );
  if (String(finalCommitMeta?.sha ?? '').toLowerCase() !== baseSha.toLowerCase()) {
    throw authorityError(`默认分支在维护者读取期间发生变化:${baseSha} → ${finalCommitMeta?.sha ?? '(empty)'}，请重试`);
  }

  const authority = {
    version: MAINTAINER_AUTHORITY_VERSION,
    repository,
    fetchedAt: nowIso,
    base: { ref: baseRef, sha: baseSha },
    codeowners: {
      path: codeowners.path,
      blobSha: codeowners.blobSha || null,
      line: team.line,
      org: team.org,
      teamSlug: team.teamSlug,
      teamHandle: team.teamHandle,
      teamPrivacy,
      repositoryPermission,
    },
    teamMembers,
    teamMemberCount: teamMembers.length,
    allowlistedMembers,
    allowlistedMemberCount: allowlistedMembers.length,
    members,
    memberCount: members.length,
  };
  return { ...authority, digest: computeMaintainerAuthorityDigest(authority) };
}

function authoritySnapshotFile(lockToken) {
  const token = String(lockToken ?? '').trim();
  if (!/^[A-Za-z0-9-]{8,128}$/.test(token)) throw authorityError('review 锁 token 无效');
  return stateFile(`maintainer-authority-${token}.json`);
}

export function removeMaintainerAuthoritySnapshot(lockToken) {
  try {
    unlinkSync(authoritySnapshotFile(lockToken));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** 将一次 fresh GitHub 读取绑定到本轮 review 锁；token 唯一，所以无需覆盖旧文件。 */
export function writeMaintainerAuthoritySnapshot(authority, { lockToken } = {}) {
  const snapshot = { ...authority, runToken: String(lockToken ?? '').trim() };
  validateMaintainerAuthoritySnapshot(snapshot, {
    owner: String(authority?.repository ?? '').split('/')[0],
    repo: String(authority?.repository ?? '').split('/').slice(1).join('/'),
    lockToken: snapshot.runToken,
    expectedDigest: authority?.digest,
  });
  const file = authoritySnapshotFile(snapshot.runToken);
  writeFileSync(file, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
  return { file, snapshot };
}

export function validateMaintainerAuthoritySnapshot(snapshot, {
  owner = '', repo = '', lockToken = '', expectedDigest = '',
} = {}) {
  if (!snapshot || snapshot.version !== MAINTAINER_AUTHORITY_VERSION) {
    throw authorityError('维护者快照版本缺失或不支持');
  }
  const expectedRepository = `${owner}/${repo}`.toLowerCase();
  if (!owner || !repo || String(snapshot.repository ?? '').toLowerCase() !== expectedRepository) {
    throw authorityError(`维护者快照仓库不匹配:${snapshot.repository ?? '(empty)'} != ${owner}/${repo}`);
  }
  if (!lockToken || snapshot.runToken !== lockToken) throw authorityError('维护者快照不属于当前 review 锁');
  // [MIVO-PATCH maintainer-allowlist] 白名单来源没有 Team 成员，白名单本身必须非空。
  const allowlistSource = isAllowlistAuthority(snapshot);
  const lists = [
    ['Team 成员', snapshot.teamMembers, !allowlistSource],
    ['补充白名单', snapshot.allowlistedMembers, allowlistSource],
    ['最终成员', snapshot.members, true],
  ];
  for (const [label, value, mustBeNonEmpty] of lists) {
    const normalized = normalizeLoginList(value).sort();
    if (
      !Array.isArray(value) || (mustBeNonEmpty && normalized.length === 0) ||
      normalized.length !== value.length || normalized.some((member, index) => member !== value[index])
    ) {
      throw authorityError(`维护者快照${label}必须${mustBeNonEmpty ? '是非空、' : ''}去重、排序的小写 login`);
    }
  }
  const expectedMembers = normalizeLoginList([...snapshot.teamMembers, ...snapshot.allowlistedMembers]).sort();
  if (
    expectedMembers.length !== snapshot.members.length ||
    expectedMembers.some((member, index) => member !== snapshot.members[index])
  ) {
    throw authorityError('维护者快照最终成员不是 Team 与补充白名单的并集');
  }
  if (snapshot.teamMemberCount !== snapshot.teamMembers.length) throw authorityError('维护者快照 teamMemberCount 不匹配');
  if (snapshot.allowlistedMemberCount !== snapshot.allowlistedMembers.length) throw authorityError('维护者快照 allowlistedMemberCount 不匹配');
  if (snapshot.memberCount !== snapshot.members.length) throw authorityError('维护者快照 memberCount 不匹配');
  const digest = computeMaintainerAuthorityDigest(snapshot);
  if (snapshot.digest !== digest) throw authorityError('维护者快照 digest 校验失败');
  if (expectedDigest && expectedDigest !== digest) {
    throw authorityError(`维护者权限已变化:${expectedDigest} → ${digest}`);
  }
  return snapshot;
}

function readActiveLockToken() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
  } catch (error) {
    throw authorityError(`无法读取当前 review 锁:${error.message}`);
  }
  const token = String(lock?.token ?? '').trim();
  if (!token) throw authorityError('当前 review 锁没有 token');
  return token;
}

export function assertActiveReviewLock(lockToken) {
  const expected = String(lockToken ?? '').trim();
  if (!expected) throw authorityError('缺少本轮 prepare.lock.token');
  const active = readActiveLockToken();
  if (active !== expected) {
    throw authorityError('当前活动锁不属于本轮 review，立即停止所有 GitHub 写操作');
  }
  return true;
}

/** 读取 prepare 为当前活动锁写下的 fresh snapshot。 */
export function loadMaintainerAuthoritySnapshot({
  owner, repo, expectedDigest = '', lockToken = '',
} = {}) {
  const expectedLockToken = String(lockToken ?? '').trim();
  if (!expectedLockToken) throw authorityError('缺少本轮 prepare.lock.token');
  const activeLockToken = readActiveLockToken();
  if (activeLockToken !== expectedLockToken) {
    throw authorityError('当前活动锁不属于本轮 review，拒绝借用其它轮次的 authority 快照');
  }
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(authoritySnapshotFile(expectedLockToken), 'utf8'));
  } catch (error) {
    throw authorityError(`无法读取本轮维护者快照:${error.message}`);
  }
  return validateMaintainerAuthoritySnapshot(snapshot, {
    owner,
    repo,
    lockToken: expectedLockToken,
    expectedDigest,
  });
}

/** 当前 viewer/作者相对于 Team + maintainerAllowlist 最终维护者集合的统一审批策略。 */
export function evaluateMaintainerApprovalPolicy({ authorLogin = '', viewerLogin = '', authority = null } = {}) {
  const members = new Set(normalizeLoginList(authority?.members));
  const teamMembers = new Set(normalizeLoginList(authority?.teamMembers));
  const allowlistedMembers = new Set(normalizeLoginList(authority?.allowlistedMembers));
  const author = String(authorLogin ?? '').trim().toLowerCase();
  const viewer = String(viewerLogin ?? '').trim().toLowerCase();
  const authorIsMaintainer = author !== '' && members.has(author);
  const viewerIsMaintainer = viewer !== '' && members.has(viewer);
  const viewerIsAuthor = author !== '' && viewer !== '' && author === viewer;
  const authoritySource = (login, isMaintainer) => {
    if (!isMaintainer) return null;
    if (teamMembers.has(login)) return 'codeowners-root-team';
    if (allowlistedMembers.has(login)) return 'maintainer-allowlist';
    return 'combined-maintainer-authority';
  };
  return {
    author,
    viewer,
    authorIsMaintainer,
    viewerIsMaintainer,
    viewerIsAuthor,
    viewerCanApprove: viewerIsMaintainer && !viewerIsAuthor,
    authorAuthoritySource: authoritySource(author, authorIsMaintainer),
    viewerAuthoritySource: authoritySource(viewer, viewerIsMaintainer),
    approvalRequired: true,
    teamHandle: authority?.codeowners?.teamHandle ?? null,
    authorityDigest: authority?.digest ?? null,
  };
}

/** 兼容现有 route 输出：现行策略不再按作者维护者身份豁免独立 Approve。 */
export function evaluateApprovalExemption({ authorLogin = '', authority = null } = {}) {
  const policy = evaluateMaintainerApprovalPolicy({ authorLogin, authority });
  return {
    exempt: false,
    authorIsMaintainer: policy.authorIsMaintainer,
    author: policy.author,
    source: policy.authorAuthoritySource ?? 'combined-maintainer-authority',
    teamHandle: policy.teamHandle,
    authorityDigest: policy.authorityDigest,
    reason: policy.authorIsMaintainer
      ? (policy.authorAuthoritySource === 'maintainer-allowlist'
        ? `作者 ${policy.author} 在 maintainerAllowlist 补充白名单中，但仍需另一位维护者独立 Approve`
        : `作者 ${policy.author} 是 ${policy.teamHandle ?? '维护者 Team'} 当前成员，但仍需另一位维护者独立 Approve`)
      : policy.author
        ? `作者 ${policy.author} 不是维护者，仍需维护者 Approve`
        : '作者身份为空，仍需维护者 Approve',
  };
}

/** GitHub 缺少 reviewer approval 的聚合状态(null / 空串也按缺 approval 处理)。 */
export function isApprovalPendingReviewDecision(reviewDecision) {
  if (reviewDecision == null) return true;
  const normalized = String(reviewDecision).trim().toUpperCase();
  return normalized === '' || normalized === 'REVIEW_REQUIRED';
}

/** 六类维护者确认门的审查前 blocking 公式；维护者作者改在最终审查后独立 Approve。 */
export function evaluateSignoffBlocking({
  enabled = false,
  authorIsMaintainer = false,
  waitingForAuthor = false,
  released = null,
} = {}) {
  return Boolean(
    enabled &&
    !authorIsMaintainer &&
    !waitingForAuthor &&
    !released
  );
}

/**
 * 跑外部命令。input 作为 stdin;allowFail=true 时不抛错、返回结果对象;
 * timeoutMs 可选(网络类 git 操作务必带上,防 auto 轮被挂死的子进程卡住);
 * cwd 可选(skill 仓库自同步等「不作用于目标仓库」的 git 操作用它,避免把可能
 * 含空格的路径塞进 -C 参数——Windows 下 shell:true 不会自动加引号);
 * env 可选(整份替换子进程环境,给 gh 的凭证 fallback 用——见 credFallbackPlan)。
 * 返回 { ok, stdout, stderr, status }。
 */
export function run(cmd, args, { input, allowFail = false, timeoutMs = 30_000, cwd, env } = {}) {
  const r = spawnSync(cmd, args, {
    input,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    cwd,
    env,
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (r.error) {
    if (allowFail) return { ok: false, stdout: '', stderr: String(r.error.message), status: -1 };
    throw new Error(`${cmd} ${args.join(' ')} 执行失败: ${r.error.message}`);
  }
  const out = { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  if (!out.ok && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}: ${out.stderr.trim()}`);
  }
  return out;
}

export function git(args, opts) {
  return run('git', args, opts);
}

// ── gh 凭证 fallback(GH_TOKEN 环境变量权限不足时换同账号钥匙串凭证重试一次)──
//
// 背景:gh 的凭证优先级是「GH_TOKEN / GITHUB_TOKEN 环境变量 > gh auth login 的钥匙串」。
// 本项目实测两台机器的 GH_TOKEN(都是 fine-grained PAT)各缺一批权限,且**缺的不是同一批**:
//   - 机器 A(2026-07-31 实测):贴/摘标签这个写动作本身被拒 —— gh pr edit 报
//     addLabelsToLabelable 403,换 REST(POST issues/:n/labels)同样 403,只有摘掉
//     GH_TOKEN 用钥匙串凭证(scopes gist/read:org/repo)才成功;
//   - 机器 B(同日实测):标签写权限正常(摘标签成功),但 gh pr edit 会顺带预查
//     reviewRequests.nodes.0.requestedReviewer,该字段被拒 → 整条命令陪葬。
// 所以标签同步同时做两件事:走 REST(绕开 B 的无关预查,见 syncSignoffLabel)+ 本 fallback
// (兜住 A 的写权限缺失)。历史坑:两种坏法的报错都被概括成「token 无标签写权限」,
// 机器 B 据此去查权限查不出问题(见台账 gh-comment-blocked-by-gh-token-pat),所以对外
// 报错一律照抄原文第一行,不替 GitHub 下结论。
//
// 为什么重试安全:403「Resource not accessible」是 GitHub 在执行前拒掉,这次写根本没发生,
// 换凭证重试不会产生重复写入(与网络中断后重试的语义完全不同)。只重试一次;非权限错不重试。
// 用过 fallback 必须让调用方看见(credFallbackStats),不做静默换凭证。
// REVIEW_PR_NO_CRED_FALLBACK=1 关掉(排查凭证问题时用)。
export const CRED_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'];
const CRED_PERM_RE = /Resource not accessible by (?:personal access token|integration)/i;

/** 纯函数:这个 gh 结果是不是「凭证权限不足」。stdout 也查——GraphQL 的错在 stdout 里。 */
export function isCredPermissionError(r) {
  if (!r || r.ok) return false;
  return CRED_PERM_RE.test(`${r.stderr ?? ''}${r.stdout ?? ''}`);
}

/**
 * 纯函数:要不要换凭证重试 + 该摘哪些环境变量。单测覆盖(security-patterns.test.mjs)。
 * 返回 { retry, stripped }。
 */
export function credFallbackPlan({ result, env = process.env, disabled = false } = {}) {
  if (disabled || env.REVIEW_PR_NO_CRED_FALLBACK === '1') return { retry: false, stripped: [] };
  if (!isCredPermissionError(result)) return { retry: false, stripped: [] };
  // 环境变量里没有 token 可摘 = 当前用的已经是钥匙串凭证,重试只会得到同一个 403
  const stripped = CRED_ENV_KEYS.filter((k) => env[k]);
  return { retry: stripped.length > 0, stripped };
}

const CRED_FALLBACKS = [];
const REQUEST_METRICS = { requests: 0, retries: 0, elapsedMs: 0, failures: 0 };
export function requestMetrics() { return { ...REQUEST_METRICS, credentialFallbacks: CRED_FALLBACKS.length }; }
/** 本进程用过几次凭证 fallback(脚本汇总里带出去,不静默换凭证)。 */
export function credFallbackStats() {
  return CRED_FALLBACKS.slice();
}

export function gh(args, opts = {}) {
  const { allowFail = false, noCredFallback = false, readOnly, ...rest } = opts;
  const safeRead = readOnly ?? (
    ['pr', 'issue', 'repo'].includes(args[0]) && ['view', 'list'].includes(args[1]) ||
    args[0] === 'api' && !args.includes('graphql') &&
      !args.some((arg) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(arg)) &&
      (args.includes('GET') || !args.some((arg) => ['-f', '-F', '--input'].includes(arg)))
  );
  const invoke = (extra = {}) => {
    const started = Date.now();
    REQUEST_METRICS.requests++;
    const result = run('gh', args, { ...rest, allowFail: true, ...extra });
    REQUEST_METRICS.elapsedMs += Date.now() - started;
    return result;
  };
  let r = invoke();
  // Only repeat reads. A timeout after a mutation may mean the write already succeeded.
  for (let retry = 0; safeRead && retry < 2; retry++) {
    const transient = /HTTP (?:429|502|503|504)|ETIMEDOUT|ECONNRESET|TLS handshake timeout|connection reset/i.test(r.stderr) ||
      args[0] === 'api' && /^\s*<(?:!DOCTYPE|html)\b/i.test(r.stdout);
    if (!transient) break;
    REQUEST_METRICS.retries++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, [500, 1500][retry]);
    r = invoke();
  }
  const plan = credFallbackPlan({ result: r, disabled: noCredFallback });
  if (plan.retry) {
    const env = { ...process.env };
    for (const k of plan.stripped) delete env[k];
    const retry = invoke({ env });
    CRED_FALLBACKS.push({
      cmd: args.slice(0, 3).join(' '),
      stripped: plan.stripped,
      ok: retry.ok,
    });
    // fallback 也失败:两套凭证的报错都带回去,别只报后者
    r = retry.ok
      ? retry
      : { ...retry, stderr: `${(r.stderr ?? '').trim()}\n[cred-fallback] ${(retry.stderr ?? '').trim()}`.trim() };
  }
  if (!r.ok && !allowFail) {
    throw new Error(`gh ${args.join(' ')} ${r.status === -1 ? '执行失败' : `退出码 ${r.status}`}: ${r.stderr.trim()}`);
  }
  return r;
}

/** gh 命令 + JSON.parse(stdout)。 */
export function ghJson(args, opts = {}) {
  return parseApiJson(gh(args, opts).stdout, `gh ${args.slice(0, 3).join(' ')}`);
}

/**
 * gh api graphql。query 走 stdin(-F query=@-)避免长参数 / 引号地狱;
 * vars 里 number 用 -F(gh 会做类型推断),string 用 -f(raw,防 owner 被误判成数字)。
 * 返回解析后的 JSON(取 .data 之外的完整对象,调用方自行取 .data)。
 */
export function ghGraphql(query, vars = {}, { timeoutMs } = {}) {
  const args = ['api', 'graphql', '--input', '-'];
  // GraphQL「部分成功」容错:当 query 里某个字段无权访问(典型:fine-grained PAT
  // 读不到 statusCheckRollup)时,GitHub 仍会在 stdout 返回
  // { data:{...其余字段已填充}, errors:[FORBIDDEN ...] },但 gh 会以非 0 退出。
  // 此时不能整体丢弃——只要 data 非 null 就把 partial 结果交给调用方按字段容错,
  // errors 一并带回供调用方识别哪个字段被拒。只有 data 真为 null
  // (查询语法错 / 整体鉴权失败)才抛。
  const mutation = /^\s*mutation\b/.test(query);
  const r = gh(args, { input: JSON.stringify({ query, variables: vars }), allowFail: true, timeoutMs,
    noCredFallback: mutation, readOnly: !mutation });
  const parsed = parseApiJson(r.stdout, `gh api graphql (exit ${r.status})`);
  if (mutation && (parsed?.errors?.length || !r.ok || !parsed?.data)) {
    throw new Error(`GraphQL mutation 未完成:${(parsed?.errors ?? []).map((e) => e.message).join('; ') || r.stderr || 'missing data'}`);
  }
  if (!r.ok) REQUEST_METRICS.failures++;
  if (parsed && parsed.data != null) return parsed;
  if (!r.ok) {
    const gqlMsg = (parsed?.errors ?? []).map((e) => e.message).filter(Boolean).join('; ');
    throw new Error(`gh api graphql 失败: ${gqlMsg || r.stderr.trim() || '无 data 返回'}`);
  }
  return parsed;
}

export function fetchGraphqlConnection(query, variables, select, {
  ghGraphqlFn = ghGraphql, timeoutMs = 20_000,
} = {}) {
  const nodes = [];
  const cursors = new Set();
  let cursor;
  let totalCount;
  for (let page = 0; page < 1000; page++) {
    const result = ghGraphqlFn(query, { ...variables, ...(cursor ? { cursor } : {}) }, { timeoutMs });
    if (result?.errors?.length) throw new Error(result.errors.map((e) => e.message).join('; '));
    const connection = select(result?.data);
    if (!connection || !Array.isArray(connection.nodes) || connection.nodes.some((n) => n == null) ||
        typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error('GraphQL connection 缺失、含空节点或缺少完整分页状态');
    }
    if (Number.isInteger(connection.totalCount)) {
      if (totalCount !== undefined && totalCount !== connection.totalCount) throw new Error('分页期间集合数量变化，请重新读取');
      totalCount = connection.totalCount;
    }
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) {
      if (totalCount !== undefined && totalCount !== nodes.length) throw new Error(`分页不完整:${nodes.length}/${totalCount}`);
      return nodes;
    }
    const next = connection.pageInfo.endCursor;
    if (!next || cursors.has(next)) throw new Error('GraphQL 分页游标缺失或重复');
    cursors.add(next);
    cursor = next;
  }
  throw new Error('GraphQL 分页超出 1000 页，拒绝把部分结果视为完整');
}

export function fetchRestPages(endpoint, { ghFn = gh, timeoutMs = 30_000 } = {}) {
  const r = ghFn(['api', '--method', 'GET', '--paginate', '--slurp', endpoint, '-f', 'per_page=100'], { timeoutMs });
  if (r.ok === false) throw new Error(`GET ${endpoint}: ${r.stderr || 'request failed'}`);
  const pages = parseApiJson(r.stdout, `GET ${endpoint}`);
  if (!Array.isArray(pages) || !pages.length || pages.some((p) => !Array.isArray(p))) {
    throw new Error(`GET ${endpoint}: REST 分页结果形状异常`);
  }
  return pages.flat();
}

const REVIEW_THREADS_PAGE_QUERY = `
  query($owner:String!,$repo:String!,$num:Int!,$cursor:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100,after:$cursor){
          pageInfo{ hasNextPage endCursor }
          nodes{
            id isResolved isOutdated path line
            firstComments:comments(first:1){ nodes{ author{ login __typename } body createdAt } }
            lastComments:comments(last:1){ nodes{ author{ login __typename } body createdAt } }
          }
        }
      }
    }
  }`;

/** 完整分页读取 review threads;任何 partial error / 缺页 / 游标不前进都返回 verified=false。 */
export function fetchAllReviewThreads(owner, repo, pr, { ghGraphqlFn = ghGraphql, includeComments = false } = {}) {
  const threads = [];
  const errors = [];
  const seenCursors = new Set();
  let cursor = null;
  while (true) {
    let result;
    try {
      const query = includeComments ? REVIEW_THREADS_PAGE_QUERY.replace(
        /firstComments:comments\(first:1\)\{[^\n]+\}\s*lastComments:comments\(last:1\)\{[^\n]+\}/,
        'comments(first:100){ pageInfo{ hasNextPage endCursor } nodes{ id author{ login __typename } body createdAt updatedAt url } }',
      ) : REVIEW_THREADS_PAGE_QUERY;
      result = ghGraphqlFn(query, {
        owner,
        repo,
        num: pr,
        ...(cursor ? { cursor } : {}),
      }, { timeoutMs: 20_000 });
    } catch (error) {
      errors.push(String(error?.message ?? error));
      return { threads, verified: false, errors };
    }
    if (result?.errors?.length) {
      errors.push(...result.errors.map((error) => error?.message ?? 'GraphQL partial error'));
      return { threads, verified: false, errors };
    }
    const connection = result?.data?.repository?.pullRequest?.reviewThreads;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
      errors.push('reviewThreads 字段缺失或形状异常');
      return { threads, verified: false, errors };
    }
    for (const thread of connection.nodes) {
      if (!thread || typeof thread.isResolved !== 'boolean') {
        return { threads, verified: false, errors: ['review thread 节点缺失或 isResolved 未验证'] };
      }
      if (includeComments) {
        try {
          if (!thread.id || !Array.isArray(thread.comments?.nodes) || !thread.comments?.pageInfo) throw new Error('thread comments 缺失');
          if (thread.comments.pageInfo.hasNextPage) {
            const comments = fetchGraphqlConnection(`query($id:ID!,$cursor:String){
              node(id:$id){ ... on PullRequestReviewThread {
                comments(first:100,after:$cursor){ pageInfo{ hasNextPage endCursor } nodes{ id author{ login __typename } body createdAt updatedAt url } }
              }}
            }`, { id: thread.id }, (data) => data?.node?.comments, { ghGraphqlFn });
            thread.comments = { nodes: comments };
          }
          threads.push(thread);
          continue;
        } catch (error) { return { threads, verified: false, errors: [error.message] }; }
      }
      const first = thread.firstComments?.nodes?.[0] ?? null;
      const last = thread.lastComments?.nodes?.[0] ?? first;
      threads.push({
        id: thread.id,
        line: thread.line,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        path: thread.path,
        comments: { nodes: [first, last].filter(Boolean) },
      });
    }
    if (!connection.pageInfo.hasNextPage) return { threads, verified: true, errors: [] };
    const next = connection.pageInfo.endCursor;
    if (!next || seenCursors.has(next)) {
      errors.push('reviewThreads 分页游标缺失或重复');
      return { threads, verified: false, errors };
    }
    seenCursors.add(next);
    cursor = next;
  }
}

/**
 * 分类 mergeStateStatus=BLOCKED 时 head commit 的 workflow run 状态(只读,best-effort)。
 * 用我们「读得到」的端点(actions/runs;注意 check-runs / commit-status / 分支保护
 * 在本项目 PAT 下常 403,故不依赖它们)区分 BLOCKED 的成因:
 *   - awaiting:fork / 首次贡献者 workflow 等待批准才能跑(status/conclusion=action_required)
 *   - failed:有 workflow run 真失败 → 真 blocker(该打回 / 不合)
 *   - pending:有 workflow run 还在跑 → 等跑完(transient)
 *   - 三者都空但仍 BLOCKED → 多半是「永不上报结果的必需检查门」(见 probeBranchProtection)
 * 按 workflow 名去重、保留最新一条(actions/runs 默认按 created desc)。
 * 任何异常(无 headSha / 权限 / 网络 / 解析失败)降级返回 { ciRuns: null },绝不抛。
 */
export function classifyHeadChecks(slug, headSha) {
  if (!headSha) return { ciRuns: null };
  const r = gh(['api', `repos/${slug}/actions/runs?head_sha=${headSha}&per_page=100`], { allowFail: true });
  if (!r.ok) return { ciRuns: null };
  try {
    // [MIVO-PATCH ci-ignore] 本流程与已退役审查流程的 workflow 不算作者 CI。
    const ignoredPaths = new Set((loadRules().ciIgnoreWorkflows?.paths ?? []).map(String));
    const runs = (JSON.parse(r.stdout || '{}').workflow_runs ?? []).filter((w) => !ignoredPaths.has(String(w.path ?? '')));
    const seen = new Set();
    const latest = [];
    for (const w of runs) {
      if (seen.has(w.name)) continue; // 同名 workflow 只留最新一条(re-run 会有多条)
      seen.add(w.name);
      latest.push(w);
    }
    const FAIL = new Set(['failure', 'startup_failure', 'timed_out', 'cancelled']);
    const PENDING = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
    const awaiting = latest
      .filter((w) => w.status === 'action_required' || w.conclusion === 'action_required')
      .map((w) => ({ id: w.id, name: w.name }));
    const failed = latest
      .filter((w) => w.status === 'completed' && FAIL.has(w.conclusion))
      .map((w) => w.name);
    const pending = latest
      .filter((w) => w.status !== 'completed' && PENDING.has(w.status))
      .map((w) => w.name);
    return {
      ciRuns: {
        failed,
        pending,
        awaiting,
        all: latest.map((w) => ({ name: w.name, status: w.status, conclusion: w.conclusion })),
      },
    };
  } catch {
    return { ciRuns: null };
  }
}

/**
 * 探测某分支的「必需检查门」+ 当前账号能否 bypass(只读,best-effort,失败返 null)。
 * 用于解释「review 都过了、CI 也没失败,但永久 BLOCKED」——多半是 org ruleset 的
 * code_scanning(CodeQL)/ code_quality / required_status_checks 这类要求结果上报、
 * 但本仓库根本没产出结果的门,owner 通常靠 admin bypass 合(current_user_can_bypass)。
 * 端点:GET /repos/{slug}/rules/branches/{branch}(列命中规则,PAT 通常可读)
 *      + GET /repos/{slug}/rulesets/{id}(取 current_user_can_bypass)。
 * 返回 { requiredCheckRules, requiredStatusChecks, requiredStatusChecksKnown,
 *          adminUnverifiedRuleTypes, ruleTypes, canBypass, rulesetIds } | null。
 */
export function probeBranchProtection(slug, branch, { ghFn = gh } = {}) {
  if (!branch) return null;
  const encodedBranch = encodeURIComponent(branch);
  const rr = ghFn(['api', `repos/${slug}/rules/branches/${encodedBranch}`], { allowFail: true });
  if (!rr.ok) return null;
  const classicResult = ghFn(['api', `repos/${slug}/branches/${encodedBranch}/protection`], { allowFail: true });
  const classicMissing = !classicResult.ok && /(?:HTTP 404|Not Found)/i.test(`${classicResult.stderr ?? ''}${classicResult.stdout ?? ''}`);
  if (!classicResult.ok && !classicMissing) return null;
  try {
    const rules = JSON.parse(rr.stdout || '[]');
    if (!Array.isArray(rules)) return null;
    const classic = classicResult.ok ? JSON.parse(classicResult.stdout || '{}') : null;
    const CHECK_RULES = new Set(['required_status_checks', 'code_scanning', 'code_quality']);
    const requiredCheckRules = [...new Set(rules.filter((r) => CHECK_RULES.has(r.type)).map((r) => r.type))];
    const ruleTypes = [...new Set(rules.map((r) => r.type).filter(Boolean))];
    const requiredStatusRules = rules.filter((r) => r.type === 'required_status_checks');
    const rulesetChecksKnown = requiredStatusRules.every(
      (rule) => Array.isArray(rule.parameters?.required_status_checks) &&
        typeof rule.parameters?.strict_required_status_checks_policy === 'boolean',
    );
    const rulesetStrict = requiredStatusRules.some(
      (rule) => rule.parameters?.strict_required_status_checks_policy === true,
    );
    const rulesetChecks = requiredStatusRules.flatMap((rule) =>
      (rule.parameters?.required_status_checks ?? []).map((check) => ({
        context: String(check?.context ?? '').trim(),
        integrationId: check?.integration_id == null ? null : Number(check.integration_id),
        source: 'ruleset',
      }))
    ).filter((check) => check.context);

    const classicStatus = classic?.required_status_checks ?? null;
    const classicChecksKnown = classic == null || classicStatus == null || (
      (Array.isArray(classicStatus.checks) || Array.isArray(classicStatus.contexts)) &&
      typeof classicStatus.strict === 'boolean'
    );
    const classicStrict = classicStatus?.strict === true;
    const classicChecks = classicStatus == null
      ? []
      : Array.isArray(classicStatus.checks)
        ? classicStatus.checks.map((check) => ({
          context: String(check?.context ?? '').trim(),
          integrationId: check?.app_id == null ? null : Number(check.app_id),
          source: 'classic',
        }))
        : (classicStatus.contexts ?? []).map((context) => ({
          context: String(context ?? '').trim(), integrationId: null, source: 'classic',
        }));
    const dedupedChecks = new Map();
    for (const check of [...rulesetChecks, ...classicChecks].filter((item) => item.context)) {
      dedupedChecks.set(`${check.context}|${check.integrationId ?? ''}`, check);
    }
    const requiredStatusChecks = [...dedupedChecks.values()];
    const requiredStatusChecksKnown = rulesetChecksKnown && classicChecksKnown;
    const requiredStatusChecksStrict = rulesetStrict || classicStrict;

    // pull_request 的 approval / thread 由调用方分别证明;required_status_checks 另与
    // check 数据对照。repository_name 是 ruleset 条件投影；creation/deletion/non_fast_forward
    // 不限制已有 base 分支通过 PR 向前移动。update 等其余 active rule 仍从严视为不可验证。
    const ADMIN_LOCALLY_VERIFIABLE = new Set([
      'pull_request', 'required_status_checks', 'repository_name',
      'creation', 'deletion', 'non_fast_forward',
    ]);
    const adminUnverifiedRuleTypes = ruleTypes.filter((type) => !ADMIN_LOCALLY_VERIFIABLE.has(type));
    const classicUnverified = [];
    if (classic?.required_linear_history?.enabled) classicUnverified.push('classic:required_linear_history');
    if (classic?.lock_branch?.enabled) classicUnverified.push('classic:lock_branch');
    if (classic?.restrictions != null) classicUnverified.push('classic:restrictions');
    if (Array.isArray(classic?.required_deployments) && classic.required_deployments.length > 0) {
      classicUnverified.push('classic:required_deployments');
    }
    if (classic != null) {
      const signatureResult = ghFn([
        'api', `repos/${slug}/branches/${encodedBranch}/protection/required_signatures`,
      ], { allowFail: true });
      const signatureMissing = !signatureResult.ok && /(?:HTTP 404|Not Found)/i.test(`${signatureResult.stderr ?? ''}${signatureResult.stdout ?? ''}`);
      if (!signatureResult.ok && !signatureMissing) return null;
      if (signatureResult.ok && JSON.parse(signatureResult.stdout || '{}').enabled === true) {
        classicUnverified.push('classic:required_signatures');
      }
    }
    adminUnverifiedRuleTypes.push(...classicUnverified);

    const rulesetIds = [...new Set(rules.map((r) => r.ruleset_id).filter((x) => typeof x === 'number'))];
    let canBypass = null; // null=未知;'never'/false=不能;'always'/'pull_requests'=能
    for (const id of rulesetIds) {
      const rs = ghFn(['api', `repos/${slug}/rulesets/${id}`], { allowFail: true });
      if (!rs.ok) continue;
      try {
        const cb = JSON.parse(rs.stdout || '{}').current_user_can_bypass;
        if (cb && cb !== 'never') { canBypass = cb; break; }
        if (canBypass == null) canBypass = cb ?? null;
      } catch { /* 单条 ruleset 读失败忽略,继续看下一条 */ }
    }
    return {
      requiredCheckRules,
      requiredStatusChecks,
      requiredStatusChecksKnown,
      requiredStatusChecksStrict,
      adminUnverifiedRuleTypes: [...new Set(adminUnverifiedRuleTypes)],
      ruleTypes,
      classicProtectionKnown: true,
      canBypass,
      rulesetIds,
    };
  } catch {
    return null;
  }
}

/**
 * 读 PR head 的 statusCheckRollup 原始 contexts(只读,best-effort)。
 * 这是覆盖面最全的 CI 来源:GitHub Actions check-run、外部 CI 的 check-run、
 * legacy commit status 全在里面,required 与非 required 一视同仁。
 * fine-grained PAT 可能读不到(见 ghGraphql 注释的 FORBIDDEN partial),失败返 null,
 * 由调用方回退 classifyHeadChecks(只覆盖 Actions)——两个来源都读不到才算 CI 状态未知。
 */
export function fetchCiRollup(slug, pr) {
  const r = gh(['pr', 'view', String(pr), '--repo', slug, '--json', 'statusCheckRollup'], { allowFail: true });
  if (!r.ok) return null;
  try {
    const contexts = JSON.parse(r.stdout || '{}').statusCheckRollup;
    if (!Array.isArray(contexts)) return null;
    return contexts.map((c) => ({
      // CheckRun 有 name+status+conclusion(+workflowName/startedAt/completedAt);
      // StatusContext 只有 context+state(+createdAt)。时间戳留给 classifyRollupContexts
      // 做同名去重(同一 head SHA 上 re-run / concurrency 顶掉会留同名多条),别在这里剥掉。
      name: c.name ?? c.context ?? '(unnamed)',
      workflowName: c.workflowName || null,
      startedAt: c.startedAt ?? null,
      createdAt: c.createdAt ?? null,
      completedAt: c.completedAt ?? null,
      status: c.status ?? null,
      conclusion: c.conclusion ?? c.state ?? null,
    }));
  } catch {
    return null;
  }
}

/** required check 绑定 integration_id 时,用 REST check-runs 保留 app.id 供精确核对。 */
export function fetchCheckRunsWithApps(slug, headSha) {
  if (!headSha) return null;
  const r = gh([
    'api', '--paginate', '--slurp',
    `repos/${slug}/commits/${headSha}/check-runs?per_page=100`,
  ], { allowFail: true, timeoutMs: 20_000 });
  if (!r.ok) return null;
  try {
    const pages = JSON.parse(r.stdout || '[]');
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page?.check_runs))) return null;
    return pages.flatMap((page) => page.check_runs).map((run) => ({
      name: run.name ?? '(unnamed)',
      integrationId: run.app?.id == null ? null : Number(run.app.id),
      startedAt: run.started_at ?? null,
      completedAt: run.completed_at ?? null,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
    }));
  } catch {
    return null;
  }
}

/**
 * 纯函数:把 statusCheckRollup contexts 分成 failed / pending / awaiting(单测 ci-status.test.mjs)。
 * 口径与 classifyHeadChecks 对齐:cancelled / timed_out / startup_failure 都算失败;
 * ACTION_REQUIRED = fork workflow 待批准(单列 awaiting,别当失败打回作者);
 * NEUTRAL / SKIPPED / STALE / SUCCESS 放行;其余(没跑完 / PENDING / EXPECTED)算 pending。
 *
 * 同名 check 先去重、只留最新一条再分类(与 classifyHeadChecks「同名 workflow 只留最新」
 * 同口径,2026-08-16 修,根因台账 ci-cancelled-rollup-masks-success):re-run /
 * concurrency cancel-in-progress 会在同一 head SHA 上留下同名多条——旧的 CANCELLED +
 * 新的 SUCCESS。GitHub 分支保护按「同名最新一条」评估,逐条全算会把被顶掉的旧 run
 * 误判成 CI 失败(PR #2755 / #2621:auto-review 反复贴 status:ci-failed,而 GitHub
 * 侧 mergeStateStatus 一直 CLEAN)。去重键 workflowName+name(不同 workflow 的同名
 * job 互不相干,不能互相顶掉);排序键 startedAt(退 createdAt / completedAt,都没有
 * 视为最新——还没 start 的新 run 本来就是最新的;时间戳全缺时按数组序、靠后当更新)。
 */
export function classifyRollupContexts(contexts) {
  const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'CANCELLED']);
  const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE']);
  // '9999' > 任何 '20xx' ISO 时间戳:没 start 的新 run 排在一切已启动的 run 之后
  const orderKey = (c) => c.startedAt ?? c.createdAt ?? c.completedAt ?? '9999';
  const latest = new Map();
  for (const c of contexts ?? []) {
    const key = `${c.workflowName || ''}/${c.name}`;
    const prev = latest.get(key);
    if (!prev || orderKey(c) >= orderKey(prev)) latest.set(key, c);
  }
  const failed = [];
  const pending = [];
  const awaiting = [];
  for (const c of latest.values()) {
    const concl = (c.conclusion ?? '').toUpperCase();
    const status = (c.status ?? '').toUpperCase();
    if (concl === 'ACTION_REQUIRED' || status === 'ACTION_REQUIRED') awaiting.push(c.name);
    else if (FAIL.has(concl)) failed.push(c.name);
    else if (PASS.has(concl)) continue;
    else pending.push(c.name);
  }
  return { failed, pending, awaiting };
}

/**
 * 纯函数:确认 approval 之外的 branch/ruleset 门都能由本地信号证明已满足。
 * probe 读不到、规则参数不完整、存在无法验证的规则、必需 check 未出现/未通过均 fail closed。
 */
export function evaluateAdminBranchRules({
  probe = null,
  rollupContexts = null,
  checkRunsWithApps = null,
  behindBy = null,
} = {}) {
  const failedChecks = [];
  if (!probe) {
    failedChecks.push('branch/ruleset 规则读不到');
    return { verified: false, failedChecks, requiredStatusChecks: [] };
  }
  if (probe.classicProtectionKnown !== true) failedChecks.push('classic branch protection 状态未确认');
  if (!probe.requiredStatusChecksKnown) failedChecks.push('required_status_checks 参数不完整');
  if (probe.requiredStatusChecksStrict === true) {
    if (typeof behindBy !== 'number' || !Number.isFinite(behindBy)) {
      failedChecks.push('required status checks 要求分支最新,但 behind_by 未验证');
    } else if (behindBy !== 0) {
      failedChecks.push(`required status checks 要求分支最新,当前 behind_by=${behindBy}`);
    }
  }
  if (!Array.isArray(probe.adminUnverifiedRuleTypes)) {
    failedChecks.push('branch rule 类型清单不完整');
  }
  for (const type of probe.adminUnverifiedRuleTypes ?? []) {
    failedChecks.push(`存在无法本地证明通过的 branch rule:${type}`);
  }
  const requiredStatusChecks = (probe.requiredStatusChecks ?? []).map((check) =>
    typeof check === 'string'
      ? { context: check, integrationId: null, source: 'unknown' }
      : check
  );
  const needsRollup = requiredStatusChecks.some((check) => check?.integrationId == null);
  const needsAppChecks = requiredStatusChecks.some((check) => check?.integrationId != null);
  if (needsRollup && !Array.isArray(rollupContexts)) {
    failedChecks.push('statusCheckRollup 读不到,无法核对未绑定 App 的 required checks');
  }
  if (needsAppChecks && !Array.isArray(checkRunsWithApps)) {
    failedChecks.push('check-runs 读不到,无法核对绑定 App 的 required checks');
  }
  const strictPass = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const orderKey = (context, index) => context.startedAt ?? context.createdAt ?? context.completedAt ?? `9999-${index}`;
  for (const required of requiredStatusChecks) {
    const name = String(required?.context ?? '').trim();
    if (!name) {
      failedChecks.push('required check context 为空');
      continue;
    }
    const source = required?.integrationId == null ? rollupContexts : checkRunsWithApps;
    if (!Array.isArray(source)) continue;
    const matching = source.filter((context) =>
      context?.name === name &&
      (required?.integrationId == null || Number(context?.integrationId) === Number(required.integrationId))
    );
    if (matching.length === 0) {
      const appHint = required?.integrationId == null ? '' : `,integration=${required.integrationId}`;
      failedChecks.push(`required check 未上报:${name}${appHint}`);
      continue;
    }
    const latest = matching
      .map((context, index) => ({ context, order: orderKey(context, index) }))
      .sort((a, b) => String(a.order).localeCompare(String(b.order)))
      .at(-1)?.context;
    const conclusion = String(latest?.conclusion ?? '').toUpperCase();
    const status = String(latest?.status ?? '').toUpperCase();
    if (!strictPass.has(conclusion) || (status && status !== 'COMPLETED')) {
      failedChecks.push(`required check 未严格通过:${name}(status=${status || 'n/a'},conclusion=${conclusion || 'n/a'})`);
    }
  }
  return {
    verified: failedChecks.length === 0,
    failedChecks,
    requiredStatusChecks,
  };
}

/**
 * 纯函数:合并前 CI 总判定(单一真相源,pre-merge-check.mjs 与 context.mjs 共用;
 * 单测 ci-status.test.mjs)。口径:**required 与非 required 一视同仁,CI 全绿才算 pass**。
 * 由来(2026-08-04):旧逻辑只在 mergeStateStatus=BLOCKED 时看 CI,而 GitHub 只把
 * required check 失败算进 BLOCKED——非 required 的红 CI 给的是 UNSTABLE,旧判定完全
 * 不设防;selfMerge(--admin)路径更是在 awaiting-approval 分支就提前返回,CI 分类
 * 永远不执行。本函数无条件消费两个来源,堵这两个洞。
 *
 * 输入:rollup = classifyRollupContexts 的结果(读不到 = null,全覆盖来源);
 *      ciRuns = classifyHeadChecks 的结果(读不到 = null,只覆盖 Actions);
 *      mergeStateStatus 仅用于「UNSTABLE 但两个来源都没看到问题」的自洽校验。
 * 返回 { status, failed, pending, awaiting, reason }:
 *   - failed:任一来源见到失败 → 不得合并,把名单提示用户/作者;
 *   - pending:还有 check 没跑完 → 等跑完再合;
 *   - awaiting:workflow 待批准才能跑 → 走 approve-workflows 流程,批完等下轮;
 *   - unknown:两个来源都读不到,或 GitHub 说 UNSTABLE(有 check 非通过)但已读到的
 *     来源全绿(读取不完整)→ **不得视为通过**,如实报告;
 *   - pass:全绿(或该仓库根本没有任何 check)。
 */
export function evaluateCiStatus({ rollup = null, ciRuns = null, mergeStateStatus = null } = {}) {
  const failed = [...new Set([...(rollup?.failed ?? []), ...(ciRuns?.failed ?? [])])];
  const pending = [...new Set([...(rollup?.pending ?? []), ...(ciRuns?.pending ?? [])])];
  const awaiting = [...new Set([
    ...(rollup?.awaiting ?? []),
    ...(ciRuns?.awaiting ?? []).map((w) => (typeof w === 'string' ? w : w.name)),
  ])];
  const base = { failed, pending, awaiting };
  if (failed.length) return { ...base, status: 'failed', reason: `CI 失败:${failed.join(' / ')}` };
  if (pending.length) return { ...base, status: 'pending', reason: `CI 还在跑:${pending.join(' / ')}` };
  if (awaiting.length) return { ...base, status: 'awaiting', reason: `workflow 待批准才能跑 CI:${awaiting.join(' / ')}` };
  if (!rollup && !ciRuns) {
    return { ...base, status: 'unknown', reason: 'CI 状态读不到(statusCheckRollup 与 actions/runs 均不可用)——不得视为通过' };
  }
  if (mergeStateStatus === 'UNSTABLE') {
    return { ...base, status: 'unknown', reason: 'GitHub 报 UNSTABLE(有 check 非通过)但已读到的来源全绿——CI 状态读取不完整,不得视为通过' };
  }
  return { ...base, status: 'pass', reason: 'CI 全绿(或无任何 check)' };
}

/** merge 写入前最后一跳的纯函数守卫；所有会变化的远端身份/状态都重新绑定。 */
export function evaluateFinalMergeAuthorization({
  admin = false,
  approvalExemptAdminAvailable = false,
  structuralBypassAvailable = false,
  expectedHead = '',
  actualHead = '',
  expectedAuthorityDigest = '',
  actualAuthorityDigest = '',
  expectedViewer = '',
  actualViewer = '',
  expectedAuthor = '',
  actualAuthor = '',
  authorIsMaintainer = false,
  approvalRequired = true,
  maintainerReviewsVerified = false,
  effectiveMaintainerApproval = false,
  reviewDecision = null,
  state = '',
} = {}) {
  const failedChecks = [];
  const norm = (value) => String(value ?? '').trim().toLowerCase();
  if (!expectedAuthorityDigest || actualAuthorityDigest !== expectedAuthorityDigest) {
    failedChecks.push(`维护者权限已变化:${expectedAuthorityDigest || '(empty)'} → ${actualAuthorityDigest || '(empty)'}`);
  }
  if (!expectedHead || norm(actualHead) !== norm(expectedHead)) {
    failedChecks.push(`head 已变化:${expectedHead || '(empty)'} → ${actualHead || '(empty)'}`);
  }
  if (!expectedViewer || norm(actualViewer) !== norm(expectedViewer)) {
    failedChecks.push(`GitHub viewer 已变化:${expectedViewer || '(empty)'} → ${actualViewer || '(empty)'}`);
  }
  if (!expectedAuthor || norm(actualAuthor) !== norm(expectedAuthor)) failedChecks.push('PR 作者身份已变化');
  if (state !== 'OPEN') failedChecks.push(`PR state=${state || '(empty)'}`);
  if (reviewDecision === 'CHANGES_REQUESTED') failedChecks.push('写操作前出现 CHANGES_REQUESTED');
  if (approvalRequired) {
    if (!maintainerReviewsVerified) failedChecks.push('写操作前维护者 review 未完整读取');
    else if (!effectiveMaintainerApproval) failedChecks.push('写操作前已无最终维护者集合成员的有效 Approve');
  }
  if (admin && approvalExemptAdminAvailable) {
    if (!authorIsMaintainer) failedChecks.push('approval-exempt admin route 的作者已不是维护者');
    if (reviewDecision !== 'REVIEW_REQUIRED') {
      failedChecks.push(`approval-exempt admin route reviewDecision=${reviewDecision || '(empty)'}(必须 REVIEW_REQUIRED)`);
    }
  }
  if (admin && structuralBypassAvailable && reviewDecision !== 'APPROVED') {
    failedChecks.push(`structural admin route reviewDecision=${reviewDecision || '(empty)'}(必须 APPROVED)`);
  }
  return { available: failedChecks.length === 0, failedChecks };
}

/** 维护者作者普通 merge 也必须绑定已审查 head 并完成 stale-rebase 复核。 */
export function evaluateNormalMergeAvailable({
  canMerge = false,
  blockClass = 'none',
  approvalExempt = false,
  headVerified = false,
  staleRebaseChecked = false,
} = {}) {
  return Boolean(
    canMerge &&
    blockClass !== 'awaiting-approval' &&
    (!approvalExempt || (headVerified && staleRebaseChecked))
  );
}

/**
 * 纯函数:维护者作者的 PR 是否只因缺 approval 而需要 admin merge。
 * --admin 会绕过整套 branch protection,所以每个本地硬门都显式 fail closed;
 * blockers 是调用方已经汇总的其它机械 blocker 数量,必须为 0。
 */
export function evaluateApprovalExemptAdminMerge({
  approvalExempt = false,
  headVerified = false,
  state = '',
  mergeable = '',
  mergeStateStatus = '',
  reviewDecision = null,
  blockClass = 'none',
  blockerCount = 0,
  unresolvedCount = 0,
  threadsVerified = false,
  botSettled = false,
  botSettleVerified = false,
  hasSignoffLabel = false,
  staleRebaseBlocking = false,
  staleRebaseChecked = false,
  protectedFileCount = 0,
  branchRulesVerified = false,
  ciStatus = 'unknown',
} = {}) {
  const failedChecks = [];
  if (!approvalExempt) failedChecks.push('作者不在最终维护者集合中');
  if (!headVerified) failedChecks.push('当前 head 未与已审查 SHA 对齐');
  if (state !== 'OPEN') failedChecks.push(`PR state=${state || '(empty)'}(非 OPEN)`);
  if (mergeable !== 'MERGEABLE') failedChecks.push(`mergeable=${mergeable || '(empty)'}(必须明确为 MERGEABLE)`);
  if (mergeStateStatus !== 'BLOCKED') failedChecks.push(`mergeStateStatus=${mergeStateStatus || '(empty)'}(非 BLOCKED)`);
  if (reviewDecision !== 'REVIEW_REQUIRED') {
    failedChecks.push(`reviewDecision=${reviewDecision || '(empty)'}(必须明确为 REVIEW_REQUIRED)`);
  }
  if (blockClass !== 'awaiting-approval') failedChecks.push(`blockClass=${blockClass}(非 awaiting-approval)`);
  if (Number(blockerCount) !== 0) failedChecks.push(`仍有 ${Number(blockerCount) || 0} 个其它 blocker`);
  if (!threadsVerified) failedChecks.push('review thread 状态未完整验证');
  if (Number(unresolvedCount) !== 0) failedChecks.push(`仍有 ${Number(unresolvedCount) || 0} 条未 resolve thread`);
  if (!botSettleVerified) failedChecks.push('机器人静默期输入未完整验证');
  if (!botSettled) failedChecks.push('机器人静默期未过');
  if (hasSignoffLabel) failedChecks.push('维护者确认标签仍在');
  if (!staleRebaseChecked) failedChecks.push('stale-rebase compare 未完成');
  if (staleRebaseBlocking) failedChecks.push('stale-rebase 仍在阻断');
  if (Number(protectedFileCount) !== 0) failedChecks.push(`命中 ${Number(protectedFileCount) || 0} 个受保护路径`);
  if (!branchRulesVerified) failedChecks.push('approval 之外的 branch/ruleset 门未完整验证');
  if (ciStatus !== 'pass') failedChecks.push(`CI status=${ciStatus}(非 pass)`);
  return {
    available: failedChecks.length === 0,
    failedChecks,
    route: 'approval-exempt-admin',
    reviewDecisionWasEmpty: reviewDecision == null || String(reviewDecision).trim() === '',
  };
}

/** 每个 reviewer 只保留最后一条 APPROVED / CHANGES_REQUESTED，避免历史 CR 冒充当前 blocker。 */
export function latestSubstantiveReviews(reviews) {
  const latest = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const state = String(review?.state ?? '').toUpperCase();
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') continue;
    const login = String(review?.user?.login ?? review?.author?.login ?? review?.login ?? '')
      .trim()
      .toLowerCase();
    if (!login) continue;
    const at = String(review?.submitted_at ?? review?.submittedAt ?? review?.at ?? '');
    const previous = latest.get(login);
    const previousAt = String(previous?.submitted_at ?? previous?.submittedAt ?? previous?.at ?? '');
    if (!previous || at >= previousAt) latest.set(login, review);
  }
  return [...latest.values()];
}

/**
 * 纯函数:维护者作者重审通过后,是否可 dismiss viewer 自己留下的旧 CR。
 * reviews 使用 REST review 形状(id/state/user.login);绝不替别人当前有效的 CR。
 */
export function evaluateOwnReviewDismissal({
  approvalExempt = false,
  reviewClean = false,
  state = '',
  mergeStateStatus = '',
  reviewDecision = null,
  viewerLogin = '',
  reviews = [],
  unresolvedCount = 0,
  threadsVerified = false,
  expectedHead = '',
  actualHead = '',
} = {}) {
  const failedChecks = [];
  const viewer = String(viewerLogin ?? '').trim().toLowerCase();
  const changesRequested = latestSubstantiveReviews(reviews)
    .filter((review) => String(review?.state ?? '').toUpperCase() === 'CHANGES_REQUESTED');
  const ownReviews = changesRequested.filter((review) =>
    String(review?.user?.login ?? review?.author?.login ?? '').trim().toLowerCase() === viewer
  );
  const allOwnReviews = (Array.isArray(reviews) ? reviews : []).filter((review) =>
    String(review?.state ?? '').toUpperCase() === 'CHANGES_REQUESTED' &&
    String(review?.user?.login ?? review?.author?.login ?? '').trim().toLowerCase() === viewer
  );
  const reviewIds = allOwnReviews
    .map((review) => Number(review?.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (!approvalExempt) failedChecks.push('作者不在最终维护者集合中');
  if (!reviewClean) failedChecks.push('调用方未确认最终代码重审通过(--review-clean)');
  if (state !== 'OPEN') failedChecks.push(`PR state=${state || '(empty)'}(非 OPEN)`);
  if (mergeStateStatus !== 'BLOCKED') failedChecks.push(`mergeStateStatus=${mergeStateStatus || '(empty)'}(非 BLOCKED)`);
  if (reviewDecision !== 'CHANGES_REQUESTED') failedChecks.push(`reviewDecision=${reviewDecision || '(empty)'}(非 CHANGES_REQUESTED)`);
  if (!viewer) failedChecks.push('viewer 身份为空');
  if (changesRequested.length === 0) failedChecks.push('没有任何 CHANGES_REQUESTED review');
  if (changesRequested.length > ownReviews.length) failedChecks.push('存在别人留下的 CHANGES_REQUESTED review');
  if (allOwnReviews.length !== reviewIds.length) failedChecks.push('viewer 自己的 review 缺少 REST numeric id');
  if (!threadsVerified) failedChecks.push('review thread 状态未完整验证');
  if (Number(unresolvedCount) !== 0) failedChecks.push(`仍有 ${Number(unresolvedCount) || 0} 条未 resolve thread`);
  const expected = String(expectedHead ?? '').trim().toLowerCase();
  const actual = String(actualHead ?? '').trim().toLowerCase();
  if (!expected) failedChecks.push('缺少被审查的 expected head SHA');
  if (!actual) failedChecks.push('当前 head SHA 为空');
  if (expected && actual && expected !== actual) failedChecks.push(`head 已变化:${expected} → ${actual}`);

  return {
    available: failedChecks.length === 0,
    failedChecks,
    reviewIds,
    viewer,
  };
}

/** compare API 字段解析；null / 字符串 / 负数 / 落后但无有效日期均视为未验证。 */
export function parseStaleRebaseCompare(data = {}) {
  const rawBehindBy = data?.behind_by;
  const behindValid = typeof rawBehindBy === 'number' && Number.isFinite(rawBehindBy) && rawBehindBy >= 0;
  const behindBy = behindValid ? rawBehindBy : 0;
  const mergeBaseDate = String(data?.merge_base_date ?? '').trim();
  const mergeBaseValid = mergeBaseDate !== '' && !Number.isNaN(Date.parse(mergeBaseDate));
  return {
    verified: behindValid && (behindBy === 0 || mergeBaseValid),
    behindBy,
    mergeBaseDate,
  };
}

/** Scan, notification and merge must use the same immutable head and the same age test. */
export function fetchStaleRebase({ slug, baseRef, headSha, cfg = {}, nowIso = new Date().toISOString(), ghFn = gh }) {
  if (!cfg.enabled) return { verified: true, blocking: false, reason: 'stale-rebase 未启用', behindBy: null };
  try {
    if (!baseRef || !/^[0-9a-f]{40,64}$/i.test(headSha ?? '')) throw new Error('缺少 base 或完整 PR head SHA');
    const endpoint = `repos/${slug}/compare/${encodeURIComponent(baseRef)}...${headSha}`;
    const r = ghFn(['api', endpoint], { allowFail: true, timeoutMs: 15_000 });
    if (!r.ok) throw new Error(r.stderr || 'compare request failed');
    const data = parseApiJson(r.stdout, endpoint);
    const parsed = parseStaleRebaseCompare({ behind_by: data.behind_by,
      merge_base_date: data.merge_base_commit?.commit?.committer?.date });
    if (!parsed.verified) throw new Error('compare 的 behind_by / merge base 日期未完整验证');
    return { ...parsed, ...checkStaleRebase({ ...parsed, nowIso, cfg }) };
  } catch (error) {
    return { verified: false, blocking: false, behindBy: null, mergeBaseDate: null,
      reason: `stale-rebase 未验证:${error.message}` };
  }
}

/**
 * 判定 PR 是否因太久没 rebase 而需要重做。
 * 纯函数(输入 merge base 日期、配置,输出判定),不做网络调用。
 *
 * 判据:PR 分支从 main 分叉出来的点(merge base commit)距今超过 maxDaysBehind 天,
 * 说明作者已经这么久没 rebase 过了——旧 CI 是对旧 base 的虚拟 merge commit 跑的,
 * 结果已不再有效(尤其 --admin merge 会绕过「Require branches to be up to date」)。
 * 作者 rebase 后 merge base 自然前移,计时自动归零。
 *
 * @param {{ behindBy: number, mergeBaseDate: string, nowIso: string, cfg: object }}
 * @returns {{ blocking: boolean, reason: string, daysSinceRebase?: number, mergeBaseDate?: string }}
 */
export function checkStaleRebase({ behindBy, mergeBaseDate, nowIso, cfg = {} }) {
  if (!cfg?.enabled) return { blocking: false, reason: 'stale-rebase 未启用' };
  const maxDaysBehind = Number(cfg.maxDaysBehind ?? 3);
  if (maxDaysBehind <= 0) return { blocking: false, reason: 'stale-rebase 阈值无效' };
  if (behindBy <= 0) return { blocking: false, reason: '未落后 base,无需 rebase' };
  if (!mergeBaseDate) return { blocking: false, reason: 'merge base 时间读不到,跳过 stale-rebase 判定' };
  const baseMs = Date.parse(mergeBaseDate);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(baseMs) || Number.isNaN(nowMs)) {
    return { blocking: false, reason: '时间解析失败,跳过 stale-rebase 判定' };
  }
  const daysSinceRebase = (nowMs - baseMs) / (24 * 60 * 60 * 1000);
  if (daysSinceRebase >= maxDaysBehind) {
    return {
      blocking: true,
      daysSinceRebase: Math.round(daysSinceRebase * 10) / 10,
      mergeBaseDate,
      reason: `距上次 rebase 已 ${Math.round(daysSinceRebase)} 天(≥${maxDaysBehind} 天阈值),需要 rebase 以触发最新 CI`,
    };
  }
  return {
    blocking: false,
    daysSinceRebase: Math.round(daysSinceRebase * 10) / 10,
    mergeBaseDate,
    reason: `距上次 rebase ${Math.round(daysSinceRebase)} 天,未超 ${maxDaysBehind} 天阈值`,
  };
}

/**
 * 拉公司 org 名录 README(供 context.mjs 产品门 Slack 同步评论发送者归属使用,
 * 配置键 orgMappingRepos)。读取顺序(fine-grained PAT 读不到跨 org 仓库,
 * 本机 SSH key 读得到):
 *   1. 本地 roster clone(~/.cindy/org-rosters/<owner>-<repo>,仓库工作区之外;老
 *      ~/.xdmaker/org-rosters 副本弃用,首跑自动重新 clone):存在则先
 *      `git pull --ff-only`(30s 超时,拉失败用现存副本并标 stale),读 README.md;
 *   2. 本地没有 → `git clone --depth 1 git@github.com:<slug>.git`(走本机 SSH key);
 *   3. clone 失败 → 兜底 gh api(PAT 授权过的仓库仍可用);
 *   4. 全失败 → 记入 fetchErrors。
 * 返回 { rosters: [{repo, source, text}], fetchErrors: [{repo, error}] }。
 */
export function loadOrgRosters(mappingRepos) {
  const ROSTER_BASE = join(homedir(), '.cindy', 'org-rosters');
  const GIT_TIMEOUT = 30_000; // 网络 git 操作硬超时,绝不挂死 auto 轮
  const rosters = [];
  const fetchErrors = [];
  for (const repoSlug of mappingRepos ?? []) {
    const cloneDir = join(ROSTER_BASE, repoSlug.replace('/', '-'));
    const readmePath = join(cloneDir, 'README.md');
    let stale = false;
    if (existsSync(join(cloneDir, '.git'))) {
      // 已有 clone:先拉最新;拉失败(断网 / 凭证变化)不致命,用现存副本并标 stale
      const pull = git(['-C', cloneDir, 'pull', '--ff-only', '--quiet'], { allowFail: true, timeoutMs: GIT_TIMEOUT });
      stale = !pull.ok;
    } else {
      mkdirSync(ROSTER_BASE, { recursive: true });
      git(['clone', '--depth', '1', '--quiet', `git@github.com:${repoSlug}.git`, cloneDir], { allowFail: true, timeoutMs: GIT_TIMEOUT });
    }
    if (existsSync(readmePath)) {
      rosters.push({ repo: repoSlug, source: stale ? 'local-clone(stale,本次 pull 失败)' : 'local-clone', text: readFileSync(readmePath, 'utf8') });
      continue;
    }
    // 本地路径不可用 → gh api 兜底(仅 PAT 授权过的仓库能走通)
    const rr = gh(['api', `repos/${repoSlug}/contents/README.md`, '-H', 'Accept: application/vnd.github.raw'], { allowFail: true });
    if (rr.ok) rosters.push({ repo: repoSlug, source: 'gh-api', text: rr.stdout });
    else fetchErrors.push({ repo: repoSlug, error: `本地 clone 与 gh api 均不可用: ${(rr.stderr || rr.stdout || '').trim().slice(0, 160)}` });
  }
  return { rosters, fetchErrors };
}

/**
 * 按当前名录表格格式(| [@login](url) | 中文名 | 公司邮箱 | 角色 |)解析一行的结构化字段;
 * 格式对不上返回 null(消费方退回读 line 原文),解析器坏了也不影响行匹配本身。
 */
export function parseRosterLine(line) {
  const cells = line.split('|').map((s) => s.trim()).filter((s) => s !== '');
  const loginCell = cells.find((c) => /\[@[^\]]+\]/.test(c));
  const login = loginCell?.match(/\[@([^\]]+)\]/)?.[1] ?? null;
  const email = cells.find((c) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(c)) ?? null;
  // 中文名取「login 单元格之后、第一个非邮箱」的单元格
  const loginIdx = loginCell ? cells.indexOf(loginCell) : -1;
  const name = loginIdx >= 0
    ? cells.slice(loginIdx + 1).find((c) => c !== email && !/^https?:/.test(c)) ?? null
    : null;
  return email || name ? { githubLogin: login, name, email } : null;
}

// ── 维护者确认门 hold / 通过标记(signoff-hold.mjs 写入 PR 评论;context.mjs 扫描分类、
// signoff-release.mjs 通过校验共用同一份解析,防止多处正则漂移)──

/** hold 标记前缀(隐藏 HTML 注释),用于 includes() 级别的廉价预筛。
 *  沿用旧前缀 review-pr:product-gate —— 存量被 hold 的 PR 评论里就是它,换前缀会丢失
 *  「当初开的哪个讨论 issue」这条确定性记忆。 */
export const PRODUCT_GATE_MARKER_PREFIX = '<!-- review-pr:product-gate';
/** 通过标记前缀(signoff-release.mjs 写入):记录哪些触发类别曾被维护者确认;当前 head 是否有效另判。 */
export const SIGNOFF_RELEASE_MARKER_PREFIX = '<!-- review-pr:signoff-release';
/** 状态回帖标记前缀(signoff-hold.mjs 写入):按 head sha 去重,同一版代码只回帖一次。 */
export const SIGNOFF_RENOTICE_MARKER_PREFIX = '<!-- review-pr:signoff-renotice';
/** 维护者确认标签缺省名(pr-rules.json signoffGate.label 可覆盖)。 */
export const SIGNOFF_LABEL_DEFAULT = 'awaiting-discussion';
/** 上一个标签:只用于迁移和合并前防线,不再创建。 */
export const LEGACY_MAINTAINER_DISCUSSION_LABEL = 'awaiting-maintainer-discussion';
/** 更早的统一标签:只用于迁移和合并前防线,不再创建。 */
export const LEGACY_MAINTAINER_APPROVAL_LABEL = 'needs-maintainer-approval';
/** 更早的旧主标签:只用于迁移和合并前防线,不再创建。 */
export const LEGACY_SIGNOFF_LABEL = 'need-whitelist';

/**
 * 评论作者 login(兼容 GraphQL author.login / REST user.login /字符串 author)。
 * GraphQL Bot 的 __typename=Bot 且 login 不带 [bot];REST bot 的 login 带 [bot]。
 */
export function commentAuthorLogin(comment) {
  if (typeof comment === 'string' || comment == null) return { login: '', typename: '' };
  const login = String(comment?.author?.login ?? (typeof comment?.author === 'string' ? comment.author : '') ?? comment?.user?.login ?? '').trim();
  const typename = String(comment?.author?.__typename ?? comment?.user?.type ?? '').trim();
  return { login, typename };
}

/** github-actions bot:同仓 PR workflow 可以这个身份发评论,不能当审查账号。REST 是 github-actions[bot],GraphQL 是 github-actions + Bot。 */
export function isGithubActionsBot(login, typename = '') {
  const raw = String(login ?? '').trim().toLowerCase();
  if (raw === 'github-actions[bot]') return true;
  return raw === 'github-actions' && /^bot$/i.test(String(typename ?? '').trim());
}

/** [MIVO-PATCH hold-viewer] hold 标记只认当前审查账号(不认 github-actions bot)。viewerLogin 为空时 fail-closed。 */
export function isTrustedHoldMarkerAuthor(comment, viewerLogin) {
  const viewer = String(viewerLogin ?? '').trim();
  if (!viewer) return false;
  const { login, typename } = commentAuthorLogin(comment);
  if (!login || isGithubActionsBot(login, typename)) return false;
  return login.toLowerCase() === viewer.toLowerCase();
}

/**
 * 从一组评论里解析该 PR 最后一条 hold 标记(与 signoff-hold.mjs 的去重口径一致:取最后一条
 * 带 issue= 的标记)。入参可以是 body 字符串数组,也可以是 { body, createdAt, author } 数组
 * (给了 createdAt 才有 heldAt:放行事件要求晚于它)。
 * 兼容旧标记形态(kind=arch),kind 只是历史信息,当前在拦哪些触发以 context.mjs 的
 * signoff.triggers 为准。
 * [MIVO-PATCH hold-viewer] 传了 viewerLogin(含空字符串)时只采信该审查账号写的标记;
 * 没传时保持上游行为(不看作者),给 security-patterns.test.mjs。
 * @returns {{kind:string, issueUrl:string, issueNumber:number|null, heldAt:string|null} | null}
 */
export function parseLastHoldMarker(comments, { viewerLogin } = {}) {
  const filterByViewer = viewerLogin !== undefined;
  let hold = null;
  for (const c of comments ?? []) {
    if (filterByViewer && !isTrustedHoldMarkerAuthor(c, viewerLogin)) continue;
    const body = (typeof c === 'string' ? c : c?.body) ?? '';
    const createdAt = typeof c === 'string' ? null : c?.createdAt ?? null;
    for (const m of body.matchAll(/<!--\s*review-pr:product-gate\b([^>]*?)issue=(\S+?)\s*-->/g)) {
      hold = { kind: /\bkind=arch\b/.test(m[1]) ? 'arch' : 'product', issueUrl: m[2], heldAt: createdAt };
    }
  }
  if (!hold) return null;
  const num = hold.issueUrl.match(/\/issues\/(\d+)/)?.[1] ?? null;
  return { ...hold, issueNumber: num ? Number(num) : null };
}

/**
 * 测试-only 路径判定(product 门的确定性排除;signoff-policy.test.mjs 覆盖)。
 * 与 `.d.ts` 排除同理(见 context.mjs uiPathFiles 注释):测试 / mock / snapshot 文件不可能
 * 产生任何视觉变化,产品门不该因它触发 —— 这是确定事实,不交给每轮的语义判断。
 * 只认边界明确的形态:目录段 __tests__ / __mocks__ / __snapshots__ / test / tests / mocks,
 * 文件名后缀 .test.* / .spec.* / .mock.* / .snap。段边界用 (^|/) 锚定,防子串误伤
 * (latest.ts / testimonials.tsx / contest.tsx 都不得命中)。
 */
export const UI_TEST_PATH_RE = /(?:^|\/)(?:__tests__|__mocks__|__snapshots__|tests?|mocks)\/|\.(?:test|spec|mock)\.[^/]+$|\.snap$/i;
export const isUiTestPath = (p) => UI_TEST_PATH_RE.test(String(p ?? ''));

/**
 * 从 issue URL 解析出本仓库的 issue 编号;跨仓库 / 解析失败返回 null。
 * signoff-hold / close-product-issue 共用:hold 流程只在本仓库开讨论 issue,
 * 跨仓库链接一律视为解析失败,避免误关别的仓库的 issue。
 */
export function issueNumberFromUrl(slug, url) {
  const m = String(url ?? '').match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i);
  if (!m) return null;
  if (m[1].toLowerCase() !== String(slug ?? '').toLowerCase()) return null;
  return Number(m[2]);
}

/**
 * 讨论 issue 复用/新开判定(signoff-hold.mjs 消费;signoff-policy.test.mjs 覆盖)。
 * hold 标记里的旧 issue 只有仍 OPEN 才继续复用;已 CLOSED(如 --no-longer-required 收尾后
 * gate 再触发)视同没开过、新开当前讨论 issue;state 查询失败(null)fail-safe 复用旧链接
 * —— 网络抖动不该制造重复 issue,宁可这一轮少开、下一轮查到 CLOSED 再开。
 * @param {{priorIssueUrl:string|null, issueState:'OPEN'|'CLOSED'|null}} _
 * @returns {{needNewIssue:boolean, reuseUrl:string|null, reason:string}}
 */
export function decideIssueReuse({ priorIssueUrl = null, issueState = null } = {}) {
  if (!priorIssueUrl) return { needNewIssue: true, reuseUrl: null, reason: 'never-held' };
  if (issueState === 'OPEN') return { needNewIssue: false, reuseUrl: priorIssueUrl, reason: 'prior-open' };
  if (issueState === 'CLOSED') return { needNewIssue: true, reuseUrl: null, reason: 'prior-closed' };
  return { needNewIssue: false, reuseUrl: priorIssueUrl, reason: 'state-unknown-failsafe-reuse' };
}

/**
 * 讨论 issue 收尾判定(close-product-issue.mjs --no-longer-required 的触发条件;
 * signoff-policy.test.mjs 覆盖)。只在「hold 过 + 当前 head 一个确认门触发都不剩」时关旧
 * issue;triggers 仍在、只是 Approve / Request Changes 让 blocking=false 的不关 ——
 * issue 仍是当前改动的讨论记录,真正合并后再按普通模式关闭。
 * @param {{held:object|null, triggerCount:number}} _
 */
export function shouldCloseDiscussionIssue({ held = null, triggerCount = 0 } = {}) {
  return held != null && triggerCount === 0;
}

/**
 * 解析维护者确认门的通过标记(signoff-release.mjs 写入,形如
 * `<!-- review-pr:signoff-release gates=security,rules by=dashhuang -->`)。
 * 通过状态按触发类别取最后一次标记;标记只对它之后的当前 head 有效,作者新 push 后要
 * 重新确认(由 `evaluateMaintainerReview` 比较标记时间和最新 commit 时间)。
 * @returns {Map<string, {by:string|null, at:string|null, via:'release-marker'}>} kind → 放行事件
 */
export function parseSignoffReleaseEvents(comments) {
  const events = [];
  for (const c of comments ?? []) {
    const body = (typeof c === 'string' ? c : c?.body) ?? '';
    const createdAt = typeof c === 'string' ? null : c?.createdAt ?? null;
    const commentAuthor = typeof c === 'string'
      ? null
      : String(c?.author?.login ?? c?.author ?? '').trim() || null;
    for (const m of body.matchAll(/<!--\s*review-pr:signoff-release\s+gates=([a-zA-Z,]+)(?:\s+by=(\S+?))?\s*-->/g)) {
      for (const kind of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        events.push({
          kind,
          by: m[2] ?? null,
          commentAuthor,
          at: createdAt,
          via: 'release-marker',
        });
      }
    }
  }
  return events;
}

export function parseSignoffReleases(comments) {
  const released = new Map();
  for (const event of parseSignoffReleaseEvents(comments)) released.set(event.kind, event);
  return released;
}

/** 先验证 marker 的 GitHub 评论作者与最终维护者集合身份，再按 kind 取最后一条可信事件。 */
export function selectTrustedSignoffReleases(events, maintainers) {
  const members = new Set(normalizeLoginList(maintainers));
  const trusted = new Map();
  const untrusted = [];
  for (const event of events ?? []) {
    const by = String(event?.by ?? '').trim().toLowerCase();
    const commentAuthor = String(event?.commentAuthor ?? '').trim().toLowerCase();
    if (by && by === commentAuthor && members.has(by)) trusted.set(event.kind, event);
    else untrusted.push(event);
  }
  return { trusted, untrusted };
}

/**
 * 按维护者每人最后一条实质 review 判定当前 head 的确认状态。
 *
 * Request Changes 的当前 head 交给作者修改,不算「等维护者确认」。
 * Approve 与 signoff-release 标记一旦发生即持久有效:维护者确认过后,作者再推新
 * commit 不会重新触发确认门——门保持 released。最终审查会对照 PR 描述、讨论结果
 * 与 diff 范围复核,夹带私货或未落实讨论要求的仍会拦下。标签只是结论的外部同步。
 */
export function evaluateMaintainerReview({
  reviews = [], maintainers = [], latestCommitDate = '', markerRelease = null, authorLogin = '',
} = {}) {
  const allowed = new Set(maintainers.map((s) => String(s).toLowerCase()));
  const author = String(authorLogin ?? '').trim().toLowerCase();
  const normalizedReviews = [];
  const latestByLogin = new Map();
  for (const review of reviews) {
    const login = String(review?.login ?? review?.author?.login ?? '').toLowerCase();
    if (!allowed.has(login) || (author && login === author)) continue;
    if (review?.state !== 'APPROVED' && review?.state !== 'CHANGES_REQUESTED' && review?.state !== 'DISMISSED') continue;
    const normalized = {
      ...review,
      login,
      at: review.at ?? review.submittedAt ?? '',
    };
    normalizedReviews.push(normalized);
    const previous = latestByLogin.get(login);
    if (!previous || String(normalized.at) >= String(previous.at)) latestByLogin.set(login, normalized);
  }
  const latestReviews = [...latestByLogin.values()];
  const isCurrent = (review) =>
    Boolean(review) && (!latestCommitDate || !review.at || String(review.at) >= String(latestCommitDate));
  const currentChanges = latestReviews
    .filter((review) => review.state === 'CHANGES_REQUESTED' && isCurrent(review))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const currentApprovals = latestReviews
    .filter((review) => review.state === 'APPROVED' && isCurrent(review))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  // 全部未撤销的 Approve(不限当前 head):不能只查 latestReviews——同一维护者后来的 CR
  // 只控制当前 head,不应抹掉此前已经完成的维护者确认。若该维护者最新状态为 DISMISSED,
  // 则从严视为撤销其历史 Approve,避免被撤销的确认在后续提交后复活。
  const dismissedReviewers = new Set(
    latestReviews.filter((review) => review.state === 'DISMISSED').map((review) => review.login),
  );
  const allApprovals = normalizedReviews
    .filter((review) => review.state === 'APPROVED' && !dismissedReviewers.has(review.login))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const waitingForAuthor = currentChanges.length > 0;
  const latestApproval = currentApprovals.at(-1) ?? null;
  const currentApproval = !waitingForAuthor && latestApproval
    ? { by: latestApproval.login, at: latestApproval.at || null, via: 'github-approve' }
    : null;
  // 历史 Approve(不限当前 head):讨论一旦解除,后续新 commit 不再重新亮门。
  const anyHistoricalApproval = allApprovals.at(-1) ?? null;
  const historicalApproval = !waitingForAuthor && !currentApproval && anyHistoricalApproval
    ? { by: anyHistoricalApproval.login, at: anyHistoricalApproval.at || null, via: 'github-approve' }
    : null;
  const latest = latestReviews
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .at(-1) ?? null;
  // 历史 release marker(不限当前 head):同 Approve,维护者通过标记也持久有效。
  const historicalMarker = !waitingForAuthor && !currentApproval && !historicalApproval && markerRelease
    ? markerRelease
    : null;
  const released = waitingForAuthor
    ? null
    : currentApproval ?? historicalApproval ?? historicalMarker ?? markerRelease;
  const needsRecheck = !waitingForAuthor && !released && Boolean(latest);
  return {
    latest,
    latestReviews,
    waitingForAuthor,
    needsRecheck,
    released,
    reviewState: waitingForAuthor
      ? 'waiting-for-author'
      : needsRecheck
        ? 'needs-maintainer-recheck'
        : released?.via ?? null,
  };
}

/**
 * 解析状态回帖标记(signoff-hold.mjs 写入,形如 `<!-- review-pr:signoff-renotice head=<sha> -->`)。
 *
 * 回帖是给**作者**的:门从「放行 / 等作者改」翻回「等维护者确认」时告诉他球已经不在他手里
 * (由来见 signoff-hold.mjs 顶部注释)。按 head sha 去重 —— 作者对同一版代码反复点
 * request review、标签反复摘挂,都只回一次;他再推一版新代码、门又亮起来,才会再回一条。
 * @returns {Set<string>} 已回帖过的 head sha 集合
 */
export function parseSignoffRenotices(comments) {
  const heads = new Set();
  for (const c of comments ?? []) {
    const body = (typeof c === 'string' ? c : c?.body) ?? '';
    for (const m of body.matchAll(/<!--\s*review-pr:signoff-renotice\s+head=([0-9a-fA-F]+)\s*-->/g)) {
      heads.add(m[1].toLowerCase());
    }
  }
  return heads;
}


/**
 * 关闭讨论 issue(先发说明评论、再 close)。供 signoff-release / close-product-issue 共用。
 * @returns {{ closed:boolean, closeError:string|null, commentPosted:boolean, commentError:string|null }}
 */
export function closeDiscussIssue({ slug, issueNumber, commentBody, dryRun, ghFn }) {
  if (dryRun) return { closed: false, wouldClose: true, closeError: null };
  const g = ghFn ?? gh;
  const c = g(
    ['issue', 'comment', String(issueNumber), '--repo', slug, '--body-file', '-'],
    { input: commentBody, allowFail: true },
  );
  const r = g(['issue', 'close', String(issueNumber), '--repo', slug], { allowFail: true });
  return {
    closed: r.ok,
    closeError: r.ok ? null : (r.stderr || r.stdout || '').trim().slice(0, 300),
    commentPosted: c.ok,
    commentError: c.ok ? null : (c.stderr || c.stdout || '').trim().slice(0, 300),
  };
}

// 「维护者亲手摘掉确认标签」曾是确定性通过信号(evaluateLabelRelease),2026-07-30 随
// 「通过统一到 GitHub Approve / Request Changes」下线:摘标签不再构成通过,下一轮
// context 判定仍 blocking 时会把标签重新挂上(labels.stale 同步)。

// ── 机器人静默期(bot review settle)──
//
// 问题(2026-07-28 维护者反馈,PR #716 实锤):本流程从「作者推最后一个 commit」到「合并完」
// 只用 3.2 分钟,而外部 review 机器人要 6~11 分钟才对新 commit 表态(实测 #716 的 13 轮 push:
// Copilot 平均 6.8 分钟 / 最慢 8.7,Codex 平均 8.7 / 最慢 10.9)。于是合并**结构性地**跑在
// 机器人前面:#716 合并后 3 分钟 Copilot 提 1 条、7.7 分钟 Codex 提 4 条,5 条全是真 P1
// (作者随后在 #728 逐条修掉),但代码已经进主干了。
//
// 台账里关于这个 race 有约 20 条记录,全是 tracked/open —— 因为它们只记了「机器人抢在合并前
// 发言导致合并被拦」这半边(对本流程不利的那半边),没人记「本流程赢了竞速导致未审代码进主干」。
//
// 判据(证据优先 + 超时兜底):
//   - 每个配置的机器人只要对**当前 head commit 之后**有过任何 review / thread 发言,就算已表态;
//   - 全部表态 → settled,可以合;
//   - 未全部表态但 head commit 已推送超过 maxWaitMinutes → settled(timedOut),照常合 ——
//     否则某个机器人挂掉 / 被停用会让 PR 永远合不了(方向上宁可偶尔抢跑,不可永久卡死);
//   - 否则 → 未 settled,本轮不合并(下一轮再看;auto 是循环跑的,等一轮成本极低)。
// 注意「表态」只要求时间晚于 head commit,不要求 GitHub 把 review 关联到该 commit ——
// 机器人常把 thread 挂在文件行上而不带 commit 关联,按时间判才不会漏。

/**
 * 需要等其表态的外部 review 机器人默认名单(pr-rules.json 的 botReviewSettle.reviewers 可覆盖)。
 *
 * ⚠️ 只放**响应率高**的机器人。全仓 40 个 PR / 552 次 push 的实测响应率:
 * Copilot 74%、Codex 54%、greptile 仅 16% —— 把 greptile 放进必需名单等于永远等不到它,
 * 每个 PR 都会拖到超时上限,「等证据」这条路形同虚设。响应率低的机器人不进名单:
 * 它们的意见仍可能在合并后才到,这是本门用超时上限换吞吐时接受的已知残留风险。
 */
export const DEFAULT_BOT_REVIEWERS = [
  'copilot-pull-request-reviewer',
  'chatgpt-codex-connector',
];
/**
 * 判「机器人是否都已对当前 head 表态」。纯函数,便于单测(结论直接决定能不能合并)。
 * @param {{headCommittedDate:string, nowIso:string,
 *   activity:Array<{author:string, at:string}>, cfg?:object}} o
 *   activity = 该 PR 上所有 review / thread 评论的 {author, at},调用方拉一次给进来。
 * @returns {{enabled:boolean, settled:boolean, pending:string[], responded:string[],
 *   waitedMinutes:number|null, timedOut:boolean, maxWaitMinutes:number, reason:string}}
 */
/**
 * [MIVO-PATCH bot-check-settle] 机器人在当前 head 上的 check 跑完也算表态(botReviewSettle.checkNames:{机器人: check 名})。
 * Greptile 没有意见时只发总结评论、不提交 review,只看 review / thread 评论认不出它已审完,每次都要等到超时。
 * statusCheckRollup 只含当前 head 的 check,所以跑完就说明它审过这个 head。
 */
export function botCheckActivity(rollupContexts, cfg = {}) {
  if (!Array.isArray(rollupContexts)) return [];
  return Object.entries(cfg.checkNames ?? {}).flatMap(([author, checkName]) => rollupContexts
    .filter((c) => c?.name === checkName && String(c.status ?? '').toUpperCase() === 'COMPLETED' && c.completedAt)
    .map((c) => ({ author, at: c.completedAt })));
}

export function evaluateBotSettle({ headCommittedDate, nowIso, activity = [], cfg = {} }) {
  const maxWaitMinutes = Number(cfg.maxWaitMinutes ?? 20);
  // 静默窗口(维护者 2026-07-30 定的节奏):必等机器人都表态之后,还要「最近 quietMinutes
  // 分钟内所有 quiet 名单机器人都没有新动静」才放行 —— 防止我们的审查/合并跟一波还在
  // 陆续到达的 bot 意见抢跑。quiet 名单 = reviewers ∪ quietExtraBots(greptile 这类响应率
  // 太低、不值得必等的机器人放这里:不说话就是安静,真说话会重置静默计时)。
  const quietMinutes = Number(cfg.quietMinutes ?? 0);
  const reviewers = (cfg.reviewers ?? DEFAULT_BOT_REVIEWERS).map((s) => String(s).toLowerCase());
  const quietBots = [...new Set([...reviewers, ...(cfg.quietExtraBots ?? []).map((s) => String(s).toLowerCase())])];
  const base = { enabled: cfg.enabled !== false, maxWaitMinutes, quietMinutes, pending: [], responded: [], timedOut: false };
  if (cfg.enabled === false || reviewers.length === 0) {
    return { ...base, settled: true, waitedMinutes: null, reason: '机器人静默期未启用' };
  }
  // head commit 时间读不到 → 无法判等了多久。不拦(避免把「查不到」变成永久阻断),如实说明。
  if (!headCommittedDate) {
    return { ...base, settled: true, waitedMinutes: null, reason: 'head commit 时间读不到,跳过静默期判定(未证明机器人已表态)' };
  }
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\[bot\]$/, '');
  const responded = reviewers.filter((r) => activity.some((a) => norm(a.author) === r && a.at > headCommittedDate));
  const pending = reviewers.filter((r) => !responded.includes(r));
  const waitedMs = Date.parse(nowIso) - Date.parse(headCommittedDate);
  const waitedMinutes = Number.isNaN(waitedMs) ? null : waitedMs / 60_000;
  // 超时兜底最优先:总时长(距 head push)到上限即放行,防机器人挂掉 / 静默窗口被反复重置卡死
  if (pending.length > 0 && waitedMinutes != null && waitedMinutes >= maxWaitMinutes) {
    return {
      ...base, settled: true, responded, pending, waitedMinutes, timedOut: true,
      reason: `已等 ${waitedMinutes.toFixed(1)} 分钟(≥${maxWaitMinutes} 上限),${pending.join(' / ')} 仍未表态 —— 按超时放行,汇总要说明这几个机器人的意见可能在合并后才到`,
    };
  }
  if (pending.length > 0) {
    return {
      ...base, settled: false, responded, pending, waitedMinutes,
      reason: `等 ${pending.join(' / ')} 对当前 head 表态(已等 ${waitedMinutes == null ? '?' : waitedMinutes.toFixed(1)} 分钟,上限 ${maxWaitMinutes})—— 本轮不合并,下一轮再看`,
    };
  }
  // 必等机器人都表态了 → 再看静默窗口
  const lastBotAt = activity
    .filter((a) => quietBots.includes(norm(a.author)))
    .map((a) => a.at)
    .sort()
    .pop() ?? '';
  const quietMs = lastBotAt ? Date.parse(nowIso) - Date.parse(lastBotAt) : null;
  const quietSinceMinutes = quietMs == null || Number.isNaN(quietMs) ? null : quietMs / 60_000;
  const quietOk = quietMinutes <= 0 || lastBotAt === '' || (quietSinceMinutes != null && quietSinceMinutes >= quietMinutes);
  if (!quietOk) {
    // 静默没满也受总上限兜底:反复被新动静重置时不至于永远进不了审查
    if (waitedMinutes != null && waitedMinutes >= maxWaitMinutes) {
      return {
        ...base, settled: true, responded, waitedMinutes, quietSinceMinutes, timedOut: true,
        reason: `距 head push 已 ${waitedMinutes.toFixed(1)} 分钟(≥${maxWaitMinutes} 上限)—— 静默窗口未满仍按超时放行`,
      };
    }
    return {
      ...base, settled: false, responded, waitedMinutes, quietSinceMinutes, lastBotActivityAt: lastBotAt,
      reason: `机器人已表态,但最近 ${quietSinceMinutes == null ? '?' : quietSinceMinutes.toFixed(1)} 分钟前还有 bot 动静 —— 等满 ${quietMinutes} 分钟静默再进审查/合并(总上限 ${maxWaitMinutes})`,
    };
  }
  return {
    ...base, settled: true, responded, waitedMinutes, quietSinceMinutes,
    reason: `全部 ${responded.length} 个机器人已对当前 head 表态${quietMinutes > 0 ? `,且已静默 ${quietSinceMinutes == null ? '' : quietSinceMinutes.toFixed(1)} 分钟(≥${quietMinutes})` : ''}`,
  };
}

// ── 待维护者讨论标签(维护者讨论门在 GitHub 侧的筛选入口)──
// 需要先由维护者讨论的 PR 打**唯一**的新标签(缺省 awaiting-discussion,
// signoffGate.label 可配)。一个精确标签即可
// `is:pr is:open label:awaiting-discussion` 一键筛全部待讨论。
// 上两版 awaiting-maintainer-discussion / needs-maintainer-approval、旧主标签与旧门类子标签
// 都只用于迁移:遇到时摘掉,不再创建。

/** 旧标签(仅供迁移时识别摘除,不再创建)。 */
export const LEGACY_GATE_LABELS = [
  LEGACY_MAINTAINER_DISCUSSION_LABEL,
  LEGACY_MAINTAINER_APPROVAL_LABEL,
  LEGACY_SIGNOFF_LABEL,
  ...['product', 'arch', 'security', 'cold', 'coldupdate', 'rules'].map((g) => `${LEGACY_SIGNOFF_LABEL}:${g}`),
];

/**
 * 给 PR / issue 增删单个标签。**必须走 REST 的 issue-label 端点,不许回退到
 * `gh pr edit --add-label/--remove-label`**:后者在改标签前会顺带预查一段较宽的 GraphQL
 * (含 reviewRequests.nodes.N.requestedReviewer),该字段被 fine-grained PAT 拒时整条命令
 * 陪葬 —— 标签写权限明明是好的,报错却长得像「无权限贴标签」(2026-07-31 双机实测,
 * 台账 gh-comment-blocked-by-gh-token-pat)。REST 端点只碰标签本身,PR 在 GitHub API 里
 * 也是 issue,所以 issues/:n/labels 对 PR 同样有效。
 * 删除时 404 = 本来就没挂,属幂等成功,不算错。
 */
function ghIssueLabel(ghFn, { slug, pr, label, add }) {
  const path = add
    ? `repos/${slug}/issues/${pr}/labels`
    : `repos/${slug}/issues/${pr}/labels/${encodeURIComponent(label)}`;
  const args = add
    ? ['api', '-X', 'POST', path, '-f', `labels[]=${label}`]
    : ['api', '-X', 'DELETE', path];
  const r = ghFn(args, { allowFail: true });
  if (!r.ok && !add && /HTTP 404|"status": ?"404"/.test(`${r.stderr ?? ''}${r.stdout ?? ''}`)) {
    return { ...r, ok: true, alreadyAbsent: true };
  }
  return r;
}

/**
 * 把维护者确认标签同步到 want(true=挂着,false=摘掉)。幂等:状态一致时不发请求。
 * 新标签不存在时先 `gh label create`;旧标签不论 want 值都由 removeLegacyGateLabels 另行摘掉。
 * errors 里存**原始报错第一行**,不加「无权限」这类解读——真因可能只是某个无关字段被拒。
 * @param {{owner:string, repo:string, pr:number, want:boolean, label?:string,
 *   current:string[], ghFn:Function, dryRun?:boolean}} o
 * @returns {{changed:boolean, added:string[], removed:string[], errors:string[], warning?:string, dryRun?:boolean}}
 */
export function syncSignoffLabel({ owner, repo, pr, want, label = SIGNOFF_LABEL_DEFAULT, current = [], ghFn, dryRun = false }) {
  const slug = `${owner}/${repo}`;
  const has = (current ?? []).includes(label);
  if (want === has) return { changed: false, added: [], removed: [], errors: [] };
  if (dryRun) return { changed: true, dryRun: true, added: want ? [label] : [], removed: want ? [] : [label], errors: [] };
  const errors = [];
  const firstLine = (r) => ((r.stderr || r.stdout || '').trim().split('\n')[0] ?? '').slice(0, 200);
  // 标签失败必须一眼可见:调用方(signoff-hold / signoff-release)把它顶到输出顶层,
  // SKILL 要求最终报告里照抄。少了标签 = GitHub 后台与待确认面板都筛不到该 PR。
  const withWarning = (result) => (result.errors.length
    ? { ...result, warning: `维护者确认标签${want ? '没挂上' : '没摘掉'}:${result.errors[0]}` }
    : result);
  if (want) {
    // 颜色用紫色(SIGNOFF_LABEL_COLOR=7057FF):这是「等人确认」不是「出错」,红色会被误读成失败
    const cr = ghFn(['label', 'create', label, '--repo', slug, '--description', '等待维护者讨论(review-pr)', '--color', SIGNOFF_LABEL_COLOR], { allowFail: true });
    const createError = cr.ok || /already exists/i.test(`${cr.stderr}${cr.stdout}`) ? null : firstLine(cr);
    const r = ghIssueLabel(ghFn, { slug, pr, label, add: true });
    if (!r.ok) errors.push(`add: ${firstLine(r)}`);
    // 建标签失败只在加标也失败时才算错:加标成功 = 标签本来就在,create 报错只是噪音
    if (createError && !r.ok) errors.push(`create: ${createError}`);
    const out = { changed: r.ok, added: r.ok ? [label] : [], removed: [], errors };
    if (createError && r.ok) out.createNote = createError;
    return withWarning(out);
  }
  const r = ghIssueLabel(ghFn, { slug, pr, label, add: false });
  if (!r.ok) errors.push(`remove: ${firstLine(r)}`);
  return withWarning({ changed: r.ok, added: [], removed: r.ok ? [label] : [], errors });
}

/**
 * 摘掉存量旧标签。逐个走 REST 端点,一个失败不连坐其余。
 * @returns {{legacyRemoved:string[], errors:string[]}}
 */
export function removeLegacyGateLabels({ owner, repo, pr, current = [], ghFn, dryRun = false }) {
  const slug = `${owner}/${repo}`;
  const legacy = (current ?? []).filter((n) => LEGACY_GATE_LABELS.includes(n));
  if (!legacy.length) return { legacyRemoved: [], errors: [] };
  if (dryRun) return { legacyRemoved: legacy, errors: [] };
  const legacyRemoved = [];
  const errors = [];
  for (const label of legacy) {
    const r = ghIssueLabel(ghFn, { slug, pr, label, add: false });
    if (r.ok) legacyRemoved.push(label);
    else errors.push(`legacy ${label}: ${((r.stderr || r.stdout || '').trim().split('\n')[0] ?? '').slice(0, 160)}`);
  }
  return { legacyRemoved, errors };
}

// ── 展示标签(status: / touches:)──
//
// **只做展示,绝不参与任何判定。** 合并前防线(pre-merge-check.mjs)只认维护者确认标签
// awaiting-discussion 与 LEGACY_GATE_LABELS;本组标签贴错、贴不上、被人手工摘掉,都不许
// 改变「能不能合并」的结论。理由:标签写操作实测会因凭证问题失败(台账
// gh-comment-blocked-by-gh-token-pat,两台机器两种坏法),让展示标签参与判定等于把
// 一条易碎的外部状态接进闸门——那会既漏放行也误放行。
//
// 分两组:
//   - status:*  「现在卡在谁身上」,**同一时间最多一个**(互斥),由优先级决定挂哪个。
//     维护者确认门在拦时(signoffLabelDesired=true)本组一律不挂:那条状态由
//     awaiting-discussion 自己表达,再挂一个就是重复。
//   - touches:* 「这个改动碰了什么」,可多挂,来自 diff 事实(确认门六类触发 + 红线路径 +
//     新增依赖 + 纯文档 + 大改动),PR 不变它就不变,几乎无 churn。
//
// 注:touches:* 里 security / plugin-base / cold-update / rules / product-ui / core 这六个
// 与 2026-07-30 删掉的「门类子标签」覆盖同一批信息。差别是那批参与筛选与流程语义
// (need-whitelist:<kind>,进 LEGACY_GATE_LABELS 被合并前防线认),这批只做展示、
// 与判定完全解耦,且反映「diff 碰到了什么」而非「现在是否在拦」(所以豁免 / 已确认的
// 触发照样挂着,不会因为门放行就摘掉)。2026-08-01 维护者拍板加回。

// ── 配色口径(2026-08-01 定稿,维护者拍板「一标一色、不要灰」)──
//
// GitHub 深色模式**不直接用**给定 hex,而是按 Primer 的 .IssueLabel 算法现算:背景取该色
// 18% 透明度,文字取「把该色的 HSL 亮度补到感知亮度 0.6」的结果。由此有三条硬规矩,
// 每条都是踩出来的,改色前必须一起满足(scripts/status-labels.test.mjs 的 palette/* 兜底):
//
//   ① **感知亮度必须落在 0.12~0.60**。本来就浅的 hex(> 0.6)一点都不提亮,在深色底上
//      是灰扑扑一坨 —— 初版的 8ED6E0 / C2E0C6 / E4E669 / FEF2C0 全是这么糊掉的。
//   ② **同色相靠深浅分层 = 白分**。提亮是「补到同一个亮度」,所以深浅会被压平:初版
//      0B4F6C(深)与 8ED6E0(浅)想表达「重 / 轻」,实测提亮后几乎同色。分层只能靠色相。
//   ③ **十个 touches 的感知亮度要彼此拉齐(这里 ≈0.44)**,而不是拉齐 HSL 亮度。不齐的话
//      蓝紫会被提得很淡、黄绿几乎不动,一眼就散。附带好处:0.44 卡在浅色模式「白字 / 黑字」
//      分界(0.453)下方一点,十个色会拿到同一种文字色(全白),看起来才像一套板。
//
// 色相排布不是随手取的,三条约束:
//   - 「几乎每条 PR 都同时出现」的 core / product-ui / rules 互相拉到 ≥23°;
//   - 靠近 awaiting-discussion 靛紫(249°)的槽位只给罕见标签,且 status 的绿从常用的
//     1A7F37(色相 142)挪到 118 —— 142 距 product-ui 的 152 只有 10°,两个绿会天天并排;
//   - 判定「会不会看混」要**同时**看色相差和亮度差:深红 D1242F 与亮玫红 E24D78 色相只差
//     13° 也不会混(亮度差 0.15),而色相差 10° + 亮度相同就一定混。单测按这个口径卡。

/** 展示标签注册表:**名字与分组是逻辑**(判定函数返回它们),放代码里;颜色与描述是
 *  展示,可被 pr-rules.json 的 statusLabels.labels 覆盖或用 enabled:false 单独关掉。
 *  顺序即输出顺序(desired 数组稳定,便于 diff 与单测)。 */
export const DISPLAY_LABELS = {
  // status 组:同一时间只挂一个,所以不必一条一色,颜色只回答「球在谁手里」——
  // 金 = 等作者动手(改代码 / 回评论 / 解冲突);橙 = CI 挂了;红 = 要人插手;
  // 绿 = 有机器在动、你不用管(CI 在跑 / 等机器人 / 自动修中 / 等另一个 PR 先合)。
  // 只用这四色的另一个原因:把整个冷色区 + 品红区腾给 touches 做一标一色。
  'status:awaiting-author': { group: 'status', color: 'BF8700', description: '等作者修改(review-pr 自动维护,仅展示)' },
  'status:conflict': { group: 'status', color: 'BF8700', description: '与目标分支有冲突(review-pr 自动维护,仅展示)' },
  'status:ci-failed': { group: 'status', color: 'BC4C00', description: 'CI 失败(review-pr 自动维护,仅展示)' },
  'status:threads-open': { group: 'status', color: 'BF8700', description: '还有未 resolve 的评审讨论(review-pr 自动维护,仅展示)' },
  'status:blocked-by-pr': { group: 'status', color: '1C9318', description: '等另一个 PR 先合并 / 等 retarget(review-pr 自动维护,仅展示)' },
  'status:needs-human': { group: 'status', color: 'D1242F', description: '需要人工处理(必需检查门 / 要手动批 CI,review-pr 自动维护,仅展示)' },
  'status:auto-fixing': { group: 'status', color: '1C9318', description: '已派跟进会话自动修复中(review-pr 自动维护,仅展示)' },
  'status:awaiting-bot-review': { group: 'status', color: '1C9318', description: '等外部审查机器人表态(review-pr 自动维护,仅展示)' },
  'status:ci-running': { group: 'status', color: '1C9318', description: 'CI 还在跑(review-pr 自动维护,仅展示)' },
  // touches 组:**一标一色**。一行最多挂十个,靠颜色认标签比靠读文字快,所以每条一个色。
  // 十个色是一条连续色相带(玫红 → 品红 → 紫 → 蓝 → 天青 → 青 → 青绿 → 黄绿 → 橄榄),
  // 饱和度与感知亮度全部拉齐 —— 是一套色板,不是十个随机色。色相怎么排见上面那段。
  'touches:security': { group: 'touches', color: 'E24D78', description: '改动碰到安全边界(review-pr 自动维护,仅展示)' },
  'touches:plugin-base': { group: 'touches', color: 'E148AC', description: '改动碰到插件基座(review-pr 自动维护,仅展示)' },
  'touches:cold-update': { group: 'touches', color: '1D82B2', description: '改动影响移动端冷更新(review-pr 自动维护,仅展示)' },
  'touches:redline': { group: 'touches', color: 'DE44E1', description: '改动碰到红线路径(updater / DB schema 等,review-pr 自动维护,仅展示)' },
  'touches:core': { group: 'touches', color: '168A80', description: '改动碰到架构核心路径(review-pr 自动维护,仅展示)' },
  'touches:product-ui': { group: 'touches', color: '178E56', description: '改动碰到产品 / UI 面(review-pr 自动维护,仅展示)' },
  'touches:rules': { group: 'touches', color: 'AC52E3', description: '改动碰到规则 / 规范文档(review-pr 自动维护,仅展示)' },
  'touches:new-dependency': { group: 'touches', color: '4372E0', description: '新增第三方依赖(review-pr 自动维护,仅展示)' },
  'touches:docs-only': { group: 'touches', color: '6D7A14', description: '只改文档 / 文案(review-pr 自动维护,仅展示)' },
  'touches:large-diff': { group: 'touches', color: '498516', description: '改动量较大(review-pr 自动维护,仅展示)' },
};

/** 维护者确认标签的颜色(syncSignoffLabel 建标时用)。放这里是为了让配色单测能把它一起
 *  算进「会不会和某个展示标签看混」——它和 touches:* 会同时出现在一行。 */
export const SIGNOFF_LABEL_COLOR = '7057FF';

/** 展示标签缺省阈值:diff 行数达到它就挂 touches:large-diff(pr-rules.json 可覆盖)。 */
export const DISPLAY_LARGE_DIFF_LINES_DEFAULT = 800;

/**
 * 读展示标签配置(pr-rules.json statusLabels),把颜色 / 描述覆盖合并进注册表,
 * 并算出本次「受管标签全集」——**只有它里面的名字才会被增删**,人工手挂的任何标签永不触碰。
 * @returns {{enabled:boolean, largeDiffLines:number, registry:Record<string,{group:string,color:string,description:string}>, managed:string[], disabled:string[]}}
 */
export function loadDisplayLabelConfig(rules = {}) {
  const cfg = rules.statusLabels ?? {};
  const overrides = cfg.labels ?? {};
  const registry = {};
  const disabled = [];
  for (const [name, base] of Object.entries(DISPLAY_LABELS)) {
    const o = overrides[name] ?? {};
    if (o.enabled === false) { disabled.push(name); continue; }
    registry[name] = {
      group: base.group,
      color: (o.color ?? base.color).replace(/^#/, ''),
      description: o.description ?? base.description,
    };
  }
  return {
    enabled: cfg.enabled !== false,
    largeDiffLines: Number(cfg.largeDiffLines) || DISPLAY_LARGE_DIFF_LINES_DEFAULT,
    registry,
    managed: Object.keys(registry),
    disabled,
  };
}

/**
 * 纯函数:从 context 已经算好的确定性信号推出这个 PR 该挂哪些展示标签。
 * 不读配置、不发请求、不做语义判断 —— 同样的输入永远同样的输出(单测 status-labels.test.mjs)。
 *
 * status 组优先级(第一个命中的就是它,最多一个):
 *   0. 维护者确认门在拦 → 不挂(awaiting-discussion 自己表达这个状态)
 *   1. needs-human:跟进会话已交回给人
 *   2. auto-fixing:卡点在作者侧且已有跟进会话在修(看门狗未超时)
 *   3. awaiting-author:凭证硬命中 / 格式不合规 / 打回后作者未动 / 别人的 CR 未消
 *   4. conflict → 5. ci-failed → 6. threads-open → 7. blocked-by-pr(等别的 PR / retarget)
 *   8. needs-human(结构性必需检查门、改了 CI 配置要手动批)
 *   8. awaiting-bot-review(机器人静默期未过)→ 9. ci-running
 *   都不命中 → 不挂(门全过,本轮就在审 / 要合了,挂了下一秒就要摘,纯噪音)
 *
 * @param {object} i 见下方解构;缺省值都取「最不激进」的一侧
 * @returns {{status:string|null, touches:string[], desired:string[], statusReason:string}}
 */
export function computeDisplayLabels({
  signoffLabelDesired = false,
  securityHardHit = false,
  formatPass = true,
  autoAction = '',
  blockClass = 'none',
  hasStalePushback = false,
  hardPushbackCount = 0,
  botSettled = true,
  needsRetarget = false,
  basePrOpen = false,
  fixSessionActive = false,
  fixNeedsHuman = false,
  fixWatchdogExpired = false,
  triggerKinds = [],
  newDependency = false,
  redline = false,
  docOnly = false,
  totalDiffLines = 0,
  largeDiffLines = DISPLAY_LARGE_DIFF_LINES_DEFAULT,
  managed = Object.keys(DISPLAY_LABELS),
} = {}) {
  const allowed = new Set(managed);
  // 「球在作者手里」:这些卡点只有作者(或代他修的跟进会话)能动
  const authorFix =
    securityHardHit ||
    formatPass === false ||
    autoAction === 'pushback-security' ||
    autoAction === 'pushback-format' ||
    autoAction === 'skip-stale-pushback' ||
    blockClass === 'review-changes-requested' ||
    hardPushbackCount > 0 ||
    // self-resolvable = 只剩本流程账号自己挂的旧 CR、thread 全清,不是作者要改
    (hasStalePushback && blockClass !== 'self-resolvable');
  const authorSide = authorFix || blockClass === 'conflict' || blockClass === 'ci-failed' || blockClass === 'threads-unresolved';

  let status = null;
  let statusReason = '门全过或本轮就在审 / 要合,不挂状态标签(挂了下一秒就摘,纯噪音)';
  if (signoffLabelDesired) {
    statusReason = `维护者确认门在拦,状态由 ${SIGNOFF_LABEL_DEFAULT} 表达,status 组不挂`;
  } else if (fixNeedsHuman && authorSide) {
    status = 'status:needs-human';
    statusReason = '跟进会话已交回维护者,不再自动修';
  } else if (fixSessionActive && authorSide && !fixWatchdogExpired) {
    status = 'status:auto-fixing';
    statusReason = '卡点在作者侧且已有跟进会话在修';
  } else if (authorFix) {
    status = 'status:awaiting-author';
    statusReason = '卡点要作者改(凭证 / 格式 / 已打回未动 / reviewer 要求修改)';
  } else if (blockClass === 'conflict') {
    status = 'status:conflict';
    statusReason = 'mergeStateStatus=DIRTY,有冲突';
  } else if (blockClass === 'ci-failed') {
    status = 'status:ci-failed';
    statusReason = 'CI 有 workflow run 真失败';
  } else if (blockClass === 'threads-unresolved') {
    status = 'status:threads-open';
    statusReason = '还有未 resolve 的 conversation';
  } else if (needsRetarget || basePrOpen) {
    status = 'status:blocked-by-pr';
    statusReason = needsRetarget ? 'base PR 已合并,等 GitHub retarget' : '被依赖的 PR 仍 open,等它先合';
  } else if (autoAction === 'skip-structural-block' || autoAction === 'skip-workflow-ci-change') {
    status = 'status:needs-human';
    statusReason = autoAction === 'skip-structural-block'
      ? '结构性必需检查门未上报结果且当前账号无 bypass 权限'
      : 'fork workflow 待批但 PR 改了 CI 配置,须人工 approve';
  } else if (!botSettled) {
    status = 'status:awaiting-bot-review';
    statusReason = '外部审查机器人静默期未过';
  } else if (blockClass === 'ci-pending' || blockClass === 'workflow-awaiting') {
    status = 'status:ci-running';
    statusReason = blockClass === 'ci-pending' ? 'CI 还在跑' : 'fork workflow 待批准才能跑 CI(本轮会自动放行)';
  }
  if (status && !allowed.has(status)) {
    statusReason = `${statusReason}(${status} 已被配置关掉,不挂)`;
    status = null;
  }

  // touches 组:diff 事实,与门是否在拦无关(豁免 / 已确认的触发照样挂着)
  const kinds = new Set(triggerKinds ?? []);
  const touchCandidates = [
    kinds.has('security') && 'touches:security',
    kinds.has('pluginBase') && 'touches:plugin-base',
    kinds.has('coldUpdate') && 'touches:cold-update',
    redline && 'touches:redline',
    kinds.has('arch') && 'touches:core',
    kinds.has('product') && 'touches:product-ui',
    kinds.has('rules') && 'touches:rules',
    newDependency && 'touches:new-dependency',
    docOnly && 'touches:docs-only',
    Number(totalDiffLines) >= Number(largeDiffLines) && 'touches:large-diff',
  ].filter(Boolean);
  const touches = touchCandidates.filter((n) => allowed.has(n));

  return { status, touches, desired: [...(status ? [status] : []), ...touches], statusReason };
}

/**
 * 把展示标签同步到 desired。只增删 managed 里的名字,其它标签(含 awaiting-discussion
 * 与人工手挂的)一概不碰。加标一次 POST 带全部新标签,摘标逐个 DELETE(404=本来没挂,幂等)。
 * 失败**不抛**:errors 带原始报错第一行给调用方,展示标签失败不影响任何判定。
 * @param {{owner:string, repo:string, pr:number, desired:string[], managed:string[],
 *   current:string[], ghFn:Function, dryRun?:boolean}} o
 * @returns {{changed:boolean, added:string[], removed:string[], kept:string[], errors:string[], warning?:string, dryRun?:boolean}}
 */
export function syncDisplayLabels({ owner, repo, pr, desired = [], managed = [], current = [], ghFn, dryRun = false }) {
  const slug = `${owner}/${repo}`;
  const managedSet = new Set(managed);
  const desiredSet = new Set(desired.filter((n) => managedSet.has(n)));
  const cur = current ?? [];
  const toAdd = [...desiredSet].filter((n) => !cur.includes(n));
  const toRemove = cur.filter((n) => managedSet.has(n) && !desiredSet.has(n));
  const kept = cur.filter((n) => desiredSet.has(n));
  if (!toAdd.length && !toRemove.length) return { changed: false, added: [], removed: [], kept, errors: [] };
  if (dryRun) return { changed: true, dryRun: true, added: toAdd, removed: toRemove, kept, errors: [] };

  const errors = [];
  const firstLine = (r) => ((r.stderr || r.stdout || '').trim().split('\n')[0] ?? '').slice(0, 200);
  const added = [];
  if (toAdd.length) {
    // 一次 POST 带全部新标签(REST issue-label 端点,理由同 ghIssueLabel 的注释)
    const args = ['api', '-X', 'POST', `repos/${slug}/issues/${pr}/labels`];
    for (const n of toAdd) args.push('-f', `labels[]=${n}`);
    const r = ghFn(args, { allowFail: true });
    if (r.ok) added.push(...toAdd);
    else errors.push(`add ${toAdd.join(',')}: ${firstLine(r)}`);
  }
  const removed = [];
  for (const n of toRemove) {
    const r = ghIssueLabel(ghFn, { slug, pr, label: n, add: false });
    if (r.ok) removed.push(n);
    else errors.push(`remove ${n}: ${firstLine(r)}`);
  }
  const out = { changed: added.length > 0 || removed.length > 0, added, removed, kept, errors };
  return errors.length ? { ...out, warning: `展示标签同步不完整:${errors[0]}` } : out;
}

/**
 * 确保受管标签在仓库里存在,**且颜色 / 描述与注册表一致**。
 *
 * 两件事都必须做:
 *   - 缺了要建。直接 POST 加标 GitHub 也会隐式建出来,但颜色是随机的 —— 列表好不好看全靠这步。
 *   - 已经存在的要纠色。改 DISPLAY_LABELS 的 hex 对已建好的标签是**零效果**的:
 *     `gh label create` 撞名即失败,不会改色。所以这里对已存在的标签比一次 color /
 *     description,不一致就 `gh label edit` 改过来 —— 否则「改了配色但线上没变」会被
 *     误当成同步失败去查凭证(实际是这里根本没发请求)。
 *
 * 每个仓库每 ttlHours 只做一次(结果缓存在 STATE_DIR,和锁 / 空转指纹同一套隔离),
 * 免得每条 PR 都多花一次 label list。缓存指纹带上颜色与描述:改了配色 → 指纹变 →
 * 下一条 PR 立刻重跑纠色,不用等 24h 也不用手动 --ensure。失败不抛,errors 带回。
 * @returns {{ensured:boolean, created:string[], recolored:string[], existing:number, cached?:boolean, errors:string[]}}
 */
export function ensureDisplayLabelsExist({
  owner, repo, registry, ghFn, ttlHours = 24, force = false, nowMs = Date.now(),
  cacheFile = stateFile('display-labels-ensured.json'), // 单测传临时路径,别污染真实状态目录
}) {
  const slug = `${owner}/${repo}`;
  // 指纹 = 名字 + 颜色 + 描述:任一项改了都要重跑(只放名字的话改色永远不会被落地)
  const wanted = Object.entries(registry)
    .map(([n, d]) => `${n}:${String(d.color).toLowerCase()}:${d.description ?? ''}`)
    .sort().join('|');
  if (!force) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (c?.slug === slug && c?.wanted === wanted && nowMs - Number(c.at ?? 0) < ttlHours * 3600_000) {
        return { ensured: true, cached: true, created: [], recolored: [], existing: Number(c.existing ?? 0), errors: [] };
      }
    } catch { /* 无缓存 / 损坏 → 正常走一次 */ }
  }
  const errors = [];
  const firstLine = (r) => ((r.stderr || r.stdout || '').trim().split('\n')[0] ?? '').slice(0, 200);
  const list = ghFn(['label', 'list', '--repo', slug, '--limit', '500', '--json', 'name,color,description'], { allowFail: true });
  if (!list.ok) return { ensured: false, created: [], recolored: [], existing: 0, errors: [`list: ${firstLine(list)}`] };
  let rows = [];
  try { rows = JSON.parse(list.stdout || '[]') ?? []; } catch { rows = []; }
  const have = new Map(rows.map((l) => [l.name, l]));
  const created = [];
  const recolored = [];
  for (const [name, def] of Object.entries(registry)) {
    const cur = have.get(name);
    if (!cur) {
      const r = ghFn(['label', 'create', name, '--repo', slug, '--color', def.color, '--description', def.description], { allowFail: true });
      if (r.ok || /already exists/i.test(`${r.stderr}${r.stdout}`)) created.push(name);
      else errors.push(`create ${name}: ${firstLine(r)}`);
      continue;
    }
    // 颜色比较去掉井号并统一小写:gh 返回不带 #,配置可能带
    const curColor = String(cur.color ?? '').replace(/^#/, '').toLowerCase();
    const wantColor = String(def.color ?? '').replace(/^#/, '').toLowerCase();
    if (curColor === wantColor && (cur.description ?? '') === (def.description ?? '')) continue;
    const r = ghFn(['label', 'edit', name, '--repo', slug, '--color', def.color, '--description', def.description], { allowFail: true });
    if (r.ok) recolored.push(name);
    else errors.push(`edit ${name}: ${firstLine(r)}`);
  }
  if (!errors.length) {
    try {
      writeFileSync(cacheFile, `${JSON.stringify({ slug, wanted, existing: have.size, at: nowMs }, null, 2)}\n`);
    } catch { /* 缓存写不进去只是下轮多跑一次,不算错 */ }
  }
  return { ensured: errors.length === 0, created, recolored, existing: have.size, errors };
}

// ── 安全敏感改动门(SKILL 3.4)的判定正则与纯函数 ──
// 放这里的理由与冷更同款(见下一段):本门结论直接决定「能不能合并」,必须可单测
// (scripts/security-patterns.test.mjs),且未来若有第二个消费方(如 pre-merge-check 复核)
// 不能出现第二份正则。配置追加项(riskyPatterns.hard/.soft)与命中样本脱敏留在 context.mjs
// —— 前者要读 pr-rules.json,后者依赖内容门的凭证模式表。

/** 危险写法硬命中基础表:命中即硬拦(转 draft 等 securityApprovers 确认)。 */
export const RISKY_HARD_BASE_PATTERNS = [
  // Electron 进程隔离与网页安全开关被放松(webPreferences / 命令行开关)
  ['electron-isolation-off', /\b(?:nodeIntegration|nodeIntegrationInWorker|nodeIntegrationInSubFrames|experimentalFeatures|allowRunningInsecureContent|enableRemoteModule)\s*:\s*true\b|\b(?:contextIsolation|webSecurity|sandbox)\s*:\s*false\b|--no-sandbox|--disable-web-security|--allow-file-access-from-files/],
  // 动态求值:把数据当代码执行。dynamic import 不抓(现代代码常用且相对可控),只抓 eval / Function / vm / require(变量)
  ['dynamic-eval', /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn|compileFunction)|\brequire\s*\(\s*[^'")\s]/],
  // 拼字符串执行 shell(命令注入主入口)。spawn(cmd, [args]) 这种安全写法不抓。
  // ⚠️ `xxx.exec(` 绝大多数是 RegExp.prototype.exec(正则匹配),与 child_process 无关 ——
  // 实测 PR #526 的 `raw!.exec(`模板串`)` 就是正则,被旧口径误判成 shell 执行。所以这里
  // 只硬拦「确定是 child_process」的形态:前面不带 `.` 的裸 exec / execSync / execFile。
  ['shell-string-exec', /(?<![.\w$])(?:exec|execSync|execFile|execFileSync)\s*\([^)]*(?:\$\{|`|\+)|\bshell\s*:\s*true\b/],
  // `obj.exec(` 里**参数带 shell 命令特征**的:host.exec(`bash -c ...`) 这种远程执行拼接命令
  // 是真危险(实测 PR #715),但形态与正则 exec 相同 —— 靠参数内容区分,不靠调用形态。
  ['shell-cmd-exec', /\.\s*exec\w*\s*\([^)]*(?:bash\s+-c|sh\s+-c|cmd\s*\/c|powershell|\brm\s+-[rf]|&&|\|\|)/i],
  // CSP 放宽:unsafe-inline / unsafe-eval 只会出现在 CSP 上下文;带 * 的 CSP 同样算放宽
  ['csp-relax', /unsafe-(?:inline|eval)|Content-Security-Policy[^\n]*\*/i],
  // 导航与新窗口逃逸点:决定网页能把用户带到哪、能不能开出没有隔离的窗口
  ['navigation-escape', /\bshell\.openExternal\s*\(|\bsetWindowOpenHandler\s*\(|['"]will-navigate['"]|\ballowpopups\b/],
  // 权限与证书校验:关掉证书校验或放开权限请求 = 中间人与越权的直接入口
  ['permission-bypass', /\bsetPermission(?:Request|Check)Handler\s*\(|\bsetCertificateVerifyProc\s*\(|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/],
  // 安装钩子:npm 供应链攻击的经典载荷位置(prepare 不抓 —— husky 等正常用途太多)
  ['install-hook', /"(?:pre|post)install"\s*:/],
];
/** 软命中基础表:不拦,交阶段二审查 agent 逐条定性(正常代码里也大量存在,硬拦会天天误伤)。 */
export const RISKY_SOFT_BASE_PATTERNS = [
  // 新增外发网络请求(字面量外部地址;本地回环不算)
  ['net-egress', /\b(?:fetch|axios(?:\.\w+)?|got|superagent|request)\s*\(\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/],
  // 落盘与删除:用户数据写到哪、删了什么
  ['fs-write', /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/],
  // 读敏感环境变量(普通 process.env.FOO 不抓,太吵)
  ['env-secret-read', /process\.env\.[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i],
  // 新引入子进程能力(本仓到处要跑 agent 进程,所以只软报)
  ['child-process-import', /(?:require\(\s*['"]|from\s+['"])(?:node:)?child_process['"]/],
  // `obj.exec(` 带拼接但看不出 shell 特征:多半是正则 exec,少数是包了一层的命令执行 ——
  // 歧义交给能读上下文的审查 agent 定性,不硬拦(硬拦会把测试里的正则匹配天天拦下来)
  ['obj-exec-interpolated', /\.\s*exec\w*\s*\([^)]*(?:\$\{|`|\+)/],
  // XSS 入口
  ['dangerous-html', /\binnerHTML\s*=|\bouterHTML\s*=|dangerouslySetInnerHTML|\bdocument\.write\s*\(/],
  // 弱哈希(签名 / 校验场景下是真问题)
  ['weak-crypto', /createHash\s*\(\s*['"](?:md5|sha1)['"]/i],
];
/**
 * 「安全保护被移除」:只在**删除行**上判。命中这些标识说明该行涉及安全边界,
 * 整行被删或被改写都要让维护者看一眼(改一行 = 一删一加,删的那行会命中)。
 * 只扫新增行会漏掉「删掉 CSP / 关掉隔离」这一整类降级,所以必须单列。
 */
export const REMOVED_GUARD_RE = /Content-Security-Policy|\b(?:contextIsolation|nodeIntegration|webSecurity|sandbox)\s*:|\bsetPermission(?:Request|Check)Handler\b|\bsetWindowOpenHandler\b|\bvalidateSender\b|\bsetCertificateVerifyProc\b/;
/** 纯注释 / 空行(不构成实质改动)。yaml 的 `#`、html 的 `<!--` 一并盖住。 */
export const COMMENT_ONLY_RE = /^\s*(?:\/\/|\/\*|\*|#|<!--|$)/;
/**
 * 安全边界路径的「实质内容」判据 —— 路径触发的第二个条件。
 *
 * 教训:光按路径拦会大量误报。preload.ts 是单文件、所有 IPC 桥都在里面,于是「加一个新通道」
 * 甚至「改一行 JSDoc 注释」都会命中路径 —— 实测 10 个真实 PR 里 4 个被这样拦下,其中一个只
 * 改了注释。台账里 docs/legal/notices 反复误触发规则文档门是同一个病。所以路径不作为独立
 * 触发器,而是「路径 + 该文件里确实动了安全边界内容」双条件。
 *
 * 兜底没被削弱:REMOVED_GUARD_RE 对**所有文件**生效(删掉 CSP / sender 校验照样硬拦),
 * 且新增字面量通道这类改动仍由审查 agent 按 rule-map 读 electron 规则逐条审(SKILL 第 4 节)。
 */
export const BOUNDARY_FEATURES = [
  {
    label: 'preload 桥接边界',
    pathRe: /(?:^|\/)preload\//,
    // 拦:改 contextBridge 暴露方式、**变量 channel** 的转发(能调任意 handler = 真逃逸)、
    //     把 Node 能力(require / process / webFrame)递给渲染层。
    // 不拦:新增一个**字面量 channel** 的 invoke —— 风险在 main 侧 handler(那儿有 sender 闸),
    //     preload 自身没放松边界。
    // require 的判据不能要求带括号:`nodeRequire: require,` 把整个 require 函数递给渲染层,
    // 是最彻底的逃逸,却没有括号。改成「require 后面不紧跟字符串字面量就算」——
    // preload 里正常的 require('electron') 不命中,把 require 当值传、或 require(变量) 都命中。
    featureRe: /contextBridge|exposeInMainWorld|ipcRenderer\s*\.\s*(?:invoke|send|sendSync|sendTo|on|once|postMessage)\s*\(\s*[^'"`\s)]|\bwebFrame\b|\brequire\b(?!\s*\(\s*['"])|\bprocess\.(?!env\.NODE_ENV)|__dirname|globalThis\s*\./,
  },
  {
    label: 'CI 供应链',
    pathRe: /(?:^|\/)\.github\//,
    // pull_request_target(跑 fork 代码还拿得到 secrets)、改 permissions、用 secrets、
    // 引用移动版本的 action(@main/@master/@latest = 上游随时能换掉你跑的代码)、
    // run 里从网上拉东西执行、把 github.event.* 直接插进 run(脚本注入)。
    // 固定版本的 uses(@v4 / @<sha>)不算 —— 那是推荐写法。
    featureRe: /pull_request_target|^\s*permissions\s*:|secrets\.[A-Za-z_]|uses\s*:\s*[^\s]+@(?:main|master|latest|HEAD)\b|\b(?:curl|wget)\b[^\n]*\|\s*(?:ba)?sh|base64\s+(?:-d|--decode)|\$\{\{\s*github\.event\./,
  },
];
/** 该文件属于哪类安全边界;没有专门特征表的条目(如 updater)返回 null,按「任何实质改动都算」处理。 */
export const boundaryFeatureFor = (file) => BOUNDARY_FEATURES.find((f) => f.pathRe.test(file)) ?? null;
/**
 * 扫一行安全边界文件的改动:命中则说明这次真的动了安全边界内容(而不是改注释 / 加个普通通道)。
 * 有专门特征表的按表判;没有的(如 updater —— 它能给用户推任意代码,风险太高)按「非注释实质行」判。
 * @param sink Set,命中的文件路径会被加进去
 */
export function scanBoundaryLine(line, file, sink) {
  if (COMMENT_ONLY_RE.test(line)) return;
  const feature = boundaryFeatureFor(file);
  if (feature) {
    if (feature.featureRe.test(line)) sink.add(file);
    return;
  }
  sink.add(file);
}
/**
 * package.json 新增第三方依赖(供应链的主要入口)。
 * 只认「版本号形态」的值 —— scripts 字段的命令值(如 "build": "tsc -b")不会命中。
 * workspace: / catalog: / file: / link: 是仓库内部或本地引用,不是第三方,不算。
 */
export const NEW_DEPENDENCY_RE = /^\s*"([^"]+)"\s*:\s*"(?:[\^~>=<]|\d|\*|latest$|next$|npm:|git\+|https?:)/;
/** package.json 里长得像依赖但不是依赖的字段名(顶层元数据 / engines)。 */
export const NON_DEPENDENCY_KEYS = new Set([
  'version', 'name', 'main', 'module', 'browser', 'types', 'typings', 'license', 'description',
  'author', 'homepage', 'packageManager', 'node', 'npm', 'pnpm', 'yarn', 'vscode',
]);
/** 扫 package.json 的一行新增:是新增/升级的第三方依赖则返回包名,否则 null。 */
export function matchNewDependency(line) {
  const m = line.match(NEW_DEPENDENCY_RE);
  if (!m) return null;
  return NON_DEPENDENCY_KEYS.has(m[1]) ? null : m[1];
}

// ── 冷更(mobile runtime fingerprint)判定原料 ──
// 纯函数放这里而不是内联进 context.mjs:冷更门的结论直接决定「能不能合并」,解析必须可单测,
// 且未来若有第二个消费方(如 pre-merge-check 复核)不能出现第二份正则。

/**
 * 解析 PR 上 fingerprint guard 的 sticky comment(取最后一条带 marker 的评论)。
 * 结论优先读机器可读行 `<!-- fingerprint-changed: true|false -->`
 * (apps/mobile/scripts/ci-fingerprint.mjs 的 guardChangedMarker 写入);老版评论没有该行时
 * 退回标题文案判定;两者都读不出 → changed=null(未知,不得当作「没变」放行)。
 * @returns {{changed:boolean|null, source:'marker'|'heading'|'unparsed', createdAt:string|null,
 *   updatedAt:string|null, staleVsHead:boolean|null, url:string|null} | null} 无 guard 评论返回 null
 */
export function parseFingerprintGuard(comments, marker, latestCommitDate) {
  if (!marker) return null;
  const c = (comments ?? []).filter((x) => (x?.body ?? '').includes(marker)).pop();
  if (!c) return null;
  const body = c.body ?? '';
  const machine = body.match(/<!--\s*fingerprint-changed:\s*(true|false)\s*-->/)?.[1] ?? null;
  let changed = machine != null ? machine === 'true' : null;
  let source = machine != null ? 'marker' : 'unparsed';
  if (changed == null) {
    if (/会改变\s*mobile\s*原生\s*runtime\s*fingerprint/.test(body)) { changed = true; source = 'heading'; }
    else if (/不再改变\s*mobile\s*runtime\s*fingerprint/.test(body)) { changed = false; source = 'heading'; }
  }
  return {
    changed,
    source,
    createdAt: c.createdAt ?? null,
    updatedAt: c.updatedAt ?? null,
    // guard 评论是 sticky(原地更新):updatedAt 早于最新 commit = 结论可能没覆盖当前 head
    staleVsHead: latestCommitDate && c.updatedAt ? latestCommitDate > c.updatedAt : null,
    url: c.url ?? null,
  };
}

/**
 * 挑出命中给定路径清单的文件(冷更的「指纹输入路径」coldUpdatePaths、规则文档门的 rulesPaths
 * 共用)。三种 pattern:
 * - `**\/<名字>`:任意目录下的同名文件(含仓库根),按 basename 匹配 —— 本仓规则鼓励把模块专属
 *   规则放进嵌套 `AGENTS.md`,所以规则文档门必须能盖住将来新增的嵌套文件,否则把规则改动塞进
 *   `apps/xxx/AGENTS.md` 就绕过了门;
 * - 以 `/` 结尾:按目录前缀匹配;
 * - 其余:按整路径相等 —— 避免 `apps/mobile/package.json` 误中 `package.json.bak` 这类近邻文件。
 */
export function matchPathPatterns(filePaths, patterns) {
  const list = patterns ?? [];
  return (filePaths ?? []).filter((p) => list.some((pat) => {
    if (pat.startsWith('**/')) {
      const base = pat.slice(3);
      return p === base || p.endsWith(`/${base}`);
    }
    return pat.endsWith('/') ? p.startsWith(pat) : p === pat;
  }));
}

/**
 * 把文案里的 {{ISSUE_URL}} 占位符替换成真实 issue 链接(product-hold.mjs 发 PR 评论 /
 * product-release.mjs 发放行评论共用)。裸占位符一律渲染成 <url> 角括号 autolink——
 * 对外文案是全角标点的中文,GitHub 的裸 URL 自动链接不认全角标点为边界,`{{ISSUE_URL}}，后文`
 * 会把后面整段中文吞进超链接(线上实踩);<url> 形式在 `>` 处确定性截断,渲染效果不变。
 * 占位符已写在 markdown 链接目标位(`]({{ISSUE_URL}})`)时保持裸 URL(目标位本身有边界)。
 */
export function renderIssueUrl(body, issueUrl) {
  return body
    .replaceAll(']({{ISSUE_URL}})', `](${issueUrl})`)
    .replaceAll('{{ISSUE_URL}}', `<${issueUrl}>`);
}

// ── Skill 仓库自同步(pull / commit+push)──
// Skill 常以软链接安装进目标项目;这里一律先 realpath 解析回真实 skills 仓库再做 git 操作。
// 所有函数 best-effort、绝不抛:同步失败只如实报告,不阻塞 review 流程本身。
// 所有 git 操作用 cwd 定位 skill 仓库,与目标仓库(进程 cwd)完全隔离。

/**
 * 解析 skill 的真实安装位置与所属 git 仓库。
 * 返回 { skillRoot, gitRoot, skillRelPath, branch, defaultBranch } | null(不在 git 仓库内)。
 */
export function skillRepoInfo({ timeoutMs = 15_000, skillRoot = SKILL_ROOT } = {}) {
  let real;
  try {
    real = realpathSync(skillRoot);
  } catch {
    return null;
  }
  const top = git(['rev-parse', '--show-toplevel'], { allowFail: true, cwd: real, timeoutMs });
  if (!top.ok || !top.stdout.trim()) return null;
  const gitRoot = resolve(top.stdout.trim());
  const br = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true, cwd: gitRoot, timeoutMs });
  const branch = br.ok ? br.stdout.trim() : null;
  let defaultBranch = 'main';
  const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true, cwd: gitRoot, timeoutMs });
  if (sym.ok && sym.stdout.trim()) defaultBranch = sym.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  let skillRelPath = relative(gitRoot, real).split(sep).join('/');
  if (skillRelPath === '') skillRelPath = '.';
  return { skillRoot: real, gitRoot, skillRelPath, branch, defaultBranch };
}

/**
 * 把 skills 仓库 pull 到最新(--ff-only,不产生 merge commit、diverged 时安全失败)。
 * 每轮执行前调用(pre-check / prepare 已内置)。返回:
 *   { ok, action:'pull', updated, before, after, branch, error } 或 { ok:true, skipped }。
 */
export function skillRepoPull({ timeoutMs = 30_000, skillRoot = SKILL_ROOT } = {}) {
  const info = skillRepoInfo({ skillRoot });
  if (!info) return { ok: true, action: 'pull', skipped: 'not-a-git-repo' };
  if (!info.branch || info.branch === 'HEAD') return { ok: true, action: 'pull', skipped: 'detached-head' };
  const cwd = info.gitRoot;
  const status = git(['status', '--porcelain'], { allowFail: true, cwd });
  if (!status.ok || status.stdout.trim()) return { ok: false, action: 'pull', skipped: 'dirty-or-unreadable-worktree',
    error: 'skill 仓库有本地改动或状态读取失败，保留当前副本' };
  const head = () => git(['rev-parse', '--short', 'HEAD'], { allowFail: true, cwd }).stdout.trim();
  const before = head();
  const pull = git(['pull', '--ff-only', '--quiet'], { allowFail: true, cwd, timeoutMs });
  const after = head();
  return {
    ok: pull.ok,
    action: 'pull',
    branch: info.branch,
    updated: pull.ok && before !== after,
    before,
    after,
    error: pull.ok ? null : ((pull.stderr || pull.stdout).trim().slice(0, 300) || 'git pull 失败'),
  };
}

/**
 * 提交并推送 skill 自身的改动(自进化落地 / 台账更新)。
 *   - paths:相对 skill 根的路径列表,缺省整个核心 skill；includeAuto 同时包括兄弟
 *     review-pr-auto。只提交这些路径，即使共享 index 已暂存其他改动也不能裹入;
 *   - message:commit message(经 stdin 传给 git commit -F -,可含空格换行);
 *   - 推送守卫:只在当前分支 == 默认分支(main)时 push;在别的分支上只 commit 不 push,
 *     防止把维护者的实验分支自动发布出去。
 *   - push 被拒(远端先动了)时自动 pull --rebase 后重推一次;再失败如实返回。
 * 返回 { ok, committed, commit, pushed, branch, error | skipped }。
 */
export function skillRepoCommitPush({ paths, includeAuto = false, message, timeoutMs = 60_000, skillRoot = SKILL_ROOT } = {}) {
  const info = skillRepoInfo({ skillRoot });
  if (!info) return { ok: true, committed: false, pushed: false, skipped: 'not-a-git-repo' };
  const cwd = info.gitRoot;
  const rejected = (step, error) => ({ ok: false, committed: false, pushed: false, step, error });
  if (!info.branch || info.branch === 'HEAD') return rejected('branch', 'detached-head');
  const inside = (root, path) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  };
  const targets = [];
  for (const path of paths?.length ? paths : ['.']) {
    const target = resolve(info.skillRoot, path);
    if (!inside(info.skillRoot, target)) return rejected('paths', '提交路径超出核心 skill');
    let existing = target;
    while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
    if (!inside(info.skillRoot, realpathSync(existing))) return rejected('paths', '提交路径指向 skill 之外');
    targets.push(target);
  }
  if (includeAuto && !paths?.length) {
    const autoRoot = join(dirname(info.skillRoot), 'review-pr-auto');
    if (existsSync(autoRoot)) {
      const autoInfo = skillRepoInfo({ skillRoot: autoRoot });
      if (!autoInfo || autoInfo.gitRoot !== cwd || !inside(cwd, autoInfo.skillRoot)) {
        return rejected('paths', 'review-pr-auto 不属于同一个 skill 仓库');
      }
      targets.push(autoInfo.skillRoot);
    }
  }
  const spec = targets.map((path) => `:(top,literal)${relative(cwd, path).split(sep).join('/') || '.'}`);
  const added = git(['add', '-A', '--', ...spec], { allowFail: true, cwd, timeoutMs: 15_000 });
  if (!added.ok) return rejected('add', (added.stderr || added.stdout).trim().slice(0, 300));
  const staged = git(['diff', '--cached', '--name-only', '--', ...spec], { allowFail: true, cwd });
  if (!staged.ok) return rejected('diff', (staged.stderr || staged.stdout).trim().slice(0, 300));
  let committed = false;
  let commit = null;
  if (staged.stdout.trim()) {
    const c = git(['commit', '--only', '--quiet', '-F', '-', '--', ...spec], {
      input: message || 'evo: sync skill state', allowFail: true, cwd, timeoutMs: 15_000,
    });
    if (!c.ok) {
      return { ok: false, committed: false, pushed: false, step: 'commit', error: (c.stderr || c.stdout).trim().slice(0, 300) };
    }
    committed = true;
    commit = git(['rev-parse', '--short', 'HEAD'], { allowFail: true, cwd }).stdout.trim();
  }

  if (info.branch !== info.defaultBranch) {
    return { ok: true, committed, commit, pushed: false, branch: info.branch, skipped: `not-on-${info.defaultBranch}` };
  }
  const aheadR = git(['rev-list', '--count', `origin/${info.branch}..HEAD`], { allowFail: true, cwd });
  const ahead = aheadR.ok ? Number(aheadR.stdout.trim()) : null;
  if (ahead === 0) return { ok: true, committed, commit, pushed: false, branch: info.branch, reason: 'nothing-to-push' };

  let push = git(['push', '--quiet', 'origin', info.branch], { allowFail: true, cwd, timeoutMs });
  if (!push.ok && /non-fast-forward|fetch first|rejected|stale info/i.test(push.stderr)) {
    const rb = git(['pull', '--rebase', '--quiet'], { allowFail: true, cwd, timeoutMs });
    if (rb.ok) {
      push = git(['push', '--quiet', 'origin', info.branch], { allowFail: true, cwd, timeoutMs });
      if (committed) commit = git(['rev-parse', '--short', 'HEAD'], { allowFail: true, cwd }).stdout.trim();
    } else {
      git(['rebase', '--abort'], { allowFail: true, cwd });
      return { ok: false, committed, commit, pushed: false, branch: info.branch, step: 'rebase',
        error: (rb.stderr || rb.stdout).trim().slice(0, 300) || 'git pull --rebase 失败' };
    }
  }
  return {
    ok: push.ok,
    committed,
    commit,
    pushed: push.ok,
    branch: info.branch,
    error: push.ok ? null : ((push.stderr || push.stdout).trim().slice(0, 300) || 'git push 失败'),
  };
}

/** 从 origin 解析 { owner, repo }(支持 git@ 与 https 两种 URL)。 */
export function parseRepo() {
  const url = git(['remote', 'get-url', 'origin']).stdout.trim();
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`无法从 origin 解析 owner/repo: ${url}`);
  return { owner: m[1], repo: m[2] };
}

/** 从任意输入(#123 / 123 / "PR #456")提取 PR 编号。 */
export function parsePR(arg) {
  const m = String(arg ?? '').match(/\d+/);
  if (!m) throw new Error(`未提供有效 PR 编号: ${arg}`);
  return Number(m[0]);
}

/** 结构化输出:JSON 到 stdout(skill 里的 LLM 解析它做决策)。 */
export function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/** 顶层错误兜底:输出 { ok:false, error } 并 exit 1。 */
export function fail(error) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2) + '\n',
  );
  process.exit(1);
}

// ── open PR 集合快照与空转指纹(context.mjs --scan-all 落盘 + pre-check.mjs 比对共用)──
//
// 语义:指纹回答「自上次扫描以来,open PR 集合有没有**任何**可能改变 auto 分流结论的变化」。
// pre-check 只做指纹比对、绝不重演 auto.action 判定——判定逻辑单一来源在 context.mjs,
// 双份维护漂移的后果是「该审的被 hook 永久拦掉」(审核错误);指纹误敏感的后果只是多跑
// 一轮 session(方向安全)。字段选择按「宁可多放行,不可漏放行」:
//   - headRefOid / updatedAt / isDraft:新 commit、评论、draft 切换等常规变化;
//   - unresolved(未 resolve thread 数):点 Resolve 不一定 bump updatedAt,必须显式包含;
//   - ci(statusCheckRollup 聚合态):CI 完成不 bump updatedAt,必须显式包含;
//   - mergeable / mergeStateStatus / reviewDecision:冲突态与 review 态(GitHub 后台异步
//     重算会短暂出现 UNKNOWN,导致指纹抖动 → 多放行一轮,无害)。

/** 空转指纹状态文件；位于按目标仓库隔离的外部状态目录。 */
export const SCAN_STATE_FILE = stateFile('last-scan.json');

const SNAPSHOT_GQL = `
  query($owner:String!,$repo:String!,$cursor:String){
    repository(owner:$owner,name:$repo){
      pullRequests(states:OPEN, first:30, after:$cursor){
        totalCount pageInfo{ hasNextPage endCursor }
        nodes{
          number title url createdAt author{login} baseRefName baseRefOid headRefName headRepository{ nameWithOwner } headRefOid updatedAt isDraft mergeable mergeStateStatus reviewDecision
          reviewThreads(first:100){ pageInfo{ hasNextPage endCursor } nodes{ isResolved } }
          commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
        }
      }
    }
  }`;

/**
 * 一次 GraphQL 拉全部 open PR(含 draft——draft↔ready 切换必须反映进指纹)的指纹字段。
 * 任何字段拿不到(权限 / partial success)都以 null 参与指纹——两侧同样拿不到时指纹
 * 仍一致,不误触发;时好时坏则多放行,方向安全。
 *
 * settleUnknown(落盘方 context.mjs --scan-all 用):GitHub 的 mergeable/mergeStateStatus
 * 是查询触发的异步重算,首次访问常返回 UNKNOWN、几秒后才稳定;带 UNKNOWN 的指纹落盘会
 * 让下一次 pre-check 必然 mismatch(白放行一轮)。置 true 时快照含 UNKNOWN 就等 3s 重拉
 * (最多 3 次),仍 UNKNOWN 就用当前值(方向安全:只多放行不漏放行)。pre-check 比对侧
 * 不需要它(比对时拿到 UNKNOWN → mismatch → 放行,本就是 fail-open 方向)。
 */
export function fetchOpenPrSnapshot({ owner, repo, timeoutMs, settleUnknown = false, ghGraphqlFn = ghGraphql } = {}) {
  if (!owner || !repo) ({ owner, repo } = parseRepo());
  const fetchOnce = () => {
    const nodes = fetchGraphqlConnection(SNAPSHOT_GQL, { owner, repo },
      (data) => data?.repository?.pullRequests, { timeoutMs, ghGraphqlFn });
    if (new Set(nodes.map((n) => n.number)).size !== nodes.length) throw new Error('open PR 分页出现重复编号，请重新扫描');
    for (const node of nodes) {
      if (!Number.isInteger(node.number) || !node.headRefOid || !node.updatedAt ||
          !Array.isArray(node.reviewThreads?.nodes) || !node.reviewThreads?.pageInfo ||
          node.reviewThreads.nodes.some((t) => typeof t?.isResolved !== 'boolean')) {
        throw new Error('open PR 快照字段未完整读取');
      }
      if (node.reviewThreads.pageInfo.hasNextPage) {
        const all = fetchAllReviewThreads(owner, repo, node.number, { ghGraphqlFn });
        if (!all.verified) throw new Error(all.errors.join('; '));
        node.reviewThreads.nodes = all.threads;
      }
    }
    return nodes
      .map((n) => ({
        number: n.number,
        title: n.title,
        url: n.url,
        createdAt: n.createdAt,
        author: n.author?.login ?? '',
        baseRefName: n.baseRefName,
        headRefName: n.headRefName,
        headRepository: n.headRepository?.nameWithOwner ?? null,
        base: n.baseRefOid,
        head: n.headRefOid ?? null,
        updatedAt: n.updatedAt ?? null,
        isDraft: !!n.isDraft,
        mergeable: n.mergeable ?? null,
        mergeStateStatus: n.mergeStateStatus ?? null,
        reviewDecision: n.reviewDecision ?? null,
        unresolved: (n.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length,
        ci: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
      }))
      .sort((a, b) => a.number - b.number);
  };
  let snapshot = fetchOnce();
  if (settleUnknown) {
    const hasUnknown = (s) => s.some((p) => p.mergeable === 'UNKNOWN' || p.mergeStateStatus === 'UNKNOWN');
    for (let i = 0; i < 3 && hasUnknown(snapshot); i++) {
      // spawnSync 世界里没有 async sleep;Atomics.wait 是标准的同步等待,不烧 CPU
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
      snapshot = fetchOnce();
    }
  }
  return snapshot;
}

/** 快照 → 稳定指纹(按 number 排序后的 canonical JSON 的 sha256)。 */
export function computePrSetFingerprint(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

// ── 自我批量 spawn(scan-all / 催办脚本批量模式共用)──
// 批量模式统一实现为「driver spawn 自身的单 PR 模式」:核心判定逻辑零改动、零重构风险,
// 单 PR 调用形态与输出完全保持兼容。

/**
 * spawn 一个 node 脚本并把 stdout 解析为 JSON。用 process.execPath 复用当前运行时
 * (兼容 xdt-node / ELECTRON_RUN_AS_NODE 场景,env 原样继承)。超时 / 解析失败 / 非 0
 * 退出都不抛,折叠成 { ok:false, error }(单条失败不炸整批,由调用方逐条兜底)。
 */
export function spawnScriptJson(scriptPath, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const child = spawn(process.execPath, [scriptPath, ...args], { windowsHide: true });
    const settle = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      // Error reasons reach round reports/cards; argv can contain the review lock.
      settle({ ok: false, error: `子进程超时(${timeoutMs}ms)，请检查该 PR 的进度文件` });
    }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => settle({ ok: false, error: `spawn 失败: ${e.message}` }));
    child.on('close', (status, signal) => {
      settle(parseScriptResult({ stdout: out, stderr: err, status, signal }));
    });
  });
}

/** 简单并发池:concurrency=1 即严格串行(共享状态文件的脚本必须串行,防读写竞态)。 */
export async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Mivo 补丁区(逐条登记在仓库根 MIVO-PATCHES.md)──────────────────────────────

/** [MIVO-PATCH exempt-authors] 作者是否免审查前的维护者确认门(不给放行权)。 */
export function isSignoffExemptAuthor(authorLogin, rules = loadRules()) {
  const author = String(authorLogin ?? '').trim().toLowerCase();
  return author !== '' && normalizeLoginList(rules.signoffGate?.exemptAuthors).includes(author);
}

/**
 * [MIVO-PATCH ui-evidence] Mivo 不让改界面的 PR 等维护者确认(signoffGate.product.enabled=false),
 * 改为要求作者附界面证据(截图/录屏或 HTML)。requireUiEvidence 取值:
 * 'non-admin' = 对仓库没有 admin 权限的作者缺证据进格式门(维护者 2026-10-15 决定:admin 不需要截图);
 * 'non-exempt' = 维护者与 exemptAuthors 以外的作者缺证据进格式门;'all' = 所有作者;其他 = 不要求(上游行为)。
 */
/**
 * [MIVO-PATCH ui-evidence] PR 正文的「效果展示」段第一行写「不涉及」(可带括号或冒号说明)。
 * 只看这一段:HTML 注释(模板提示)先去掉;段内其他位置出现「不涉及」不算。
 */
export function declaresNoUiChange(body, section = '效果展示') {
  const lines = String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const at = lines.findIndex((line) => /^#{1,6}\s/.test(line) && line.includes(section));
  if (at < 0) return false;
  const first = lines.slice(at + 1).find((line) => line.trim() !== '');
  if (first === undefined || /^#{1,6}\s/.test(first)) return false;
  return /^不涉及(?:$|[\s(（:：,，。;；])/.test(first.trim());
}

export function isProductSignoffEnabled(rules = loadRules()) {
  return rules.signoffGate?.product?.enabled !== false;
}

export function isUiEvidenceRequired({ uiEvidenceMissing, authorExempt, authorIsAdmin = false, declaredNotApplicable = false }, rules = loadRules()) {
  if (!uiEvidenceMissing) return false;
  // 作者在「效果展示」写明「不涉及」(没有界面变化)也算过;是否属实由服务器审查判。
  if (declaredNotApplicable && rules.signoffGate?.product?.acceptNotApplicable === true) return false;
  const mode = rules.signoffGate?.product?.requireUiEvidence;
  if (mode === 'all') return true;
  if (mode === 'non-exempt') return authorExempt !== true;
  if (mode === 'non-admin') return authorIsAdmin !== true;
  return false;
}

/** [MIVO-PATCH ui-evidence] 是否只有在 requireUiEvidence=non-admin 时才需要读作者的仓库权限。 */
export function uiEvidenceNeedsAdminLookup(rules = loadRules()) {
  return rules.signoffGate?.product?.requireUiEvidence === 'non-admin';
}

/** [MIVO-PATCH ui-evidence] `repos/{repo}/collaborators/{login}/permission` 的结果是否是 admin。读不到按不是 admin(要证据)。 */
export function isAdminPermission(permission) {
  const role = String(permission?.role_name ?? permission?.permission ?? '').trim().toLowerCase();
  return role === 'admin' || permission?.user?.permissions?.admin === true;
}

/**
 * [MIVO-PATCH self-review] 审查账号(viewer)由本流程自动提交的 review:门禁打回、审查结论的
 * Approve / Request Changes。它们都带本流程的隐藏标记或「Mivo 自动审查」报告头。Mivo 的审查账号
 * 同时是维护者,而 review-only 下 PR 在自动 Approve 后继续开着,所以这些 review 不能当维护者确认:
 * 自动 Approve 不得放行之后才出现的确认门,自动打回也不得让确认门判「等作者改」。
 * 维护者本人手动提交的 review 没有这些标记,照常计入。
 * 只带 `<!-- review-pr:findings` 的打回不算:交互式 review-pr 由维护者本人操作,带行内评论打回时
 * request-changes-reviewed-pr.mjs 也写这个标记,它是人工打回,不能被审查机的 Approve 盖掉。
 */
const AUTOMATED_REPORT_HEADER_RE = /^>\s*Mivo 自动审查/m;
const AUTOMATED_FLOW_MARKER_RE = /<!--\s*(?:review-pr|mivo-review):(?!findings\b)/;
export function isAutomatedViewerReview(review, viewerLogin) {
  const viewer = String(viewerLogin ?? '').trim().toLowerCase();
  const login = String(review?.login ?? review?.author?.login ?? review?.user?.login ?? '').trim().toLowerCase();
  const body = String(review?.body ?? '');
  return viewer !== '' && login === viewer && (AUTOMATED_REPORT_HEADER_RE.test(body) || AUTOMATED_FLOW_MARKER_RE.test(body));
}

/**
 * [MIVO-PATCH self-review] 审查账号上维护者本人仍有效的 Request Changes。
 * GitHub 与 latestSubstantiveReviews 都按登录名只留最后一条实质 review,审查机后发的
 * CR / Approve 会盖掉更早的人工 CR(#941:人工 CR 5506920945 被审查机 CR 5512930585 盖掉)。
 * 判定按人分开:去掉带审查机标记的 viewer review,剩下的人工 review 里取最后一条
 * APPROVED / CHANGES_REQUESTED / DISMISSED;它是 CHANGES_REQUESTED 才算仍有效。
 * 人工之后 Approve,或该 review 被 dismiss,都不再有效。
 * 兼容 REST(user.login, submitted_at)与 context(author.login, submittedAt)。
 */
export function selectStandingViewerHumanChangesRequest(reviews, viewerLogin) {
  const viewer = String(viewerLogin ?? '').trim().toLowerCase();
  if (!viewer) return null;
  let latest = null;
  let latestAt = '';
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const login = String(review?.login ?? review?.author?.login ?? review?.user?.login ?? '').trim().toLowerCase();
    if (login !== viewer) continue;
    if (isAutomatedViewerReview(review, viewer)) continue;
    const state = String(review?.state ?? '').toUpperCase();
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') continue;
    const at = String(review?.submitted_at ?? review?.submittedAt ?? review?.at ?? '');
    if (!latest || at >= latestAt) {
      latest = review;
      latestAt = at;
    }
  }
  return String(latest?.state ?? '').toUpperCase() === 'CHANGES_REQUESTED' ? latest : null;
}

/**
 * [MIVO-PATCH ci-ignore] 去掉不属于作者 CI 的 check:本流程自己写的(ciIgnoreContexts,如 review-pr),
 * 以及已退役审查流程的 workflow(ciIgnoreWorkflows.names 按 rollup 的 workflowName 匹配)。
 * 评审 bot 的 check(ciIgnoreBotChecks,如 Greptile 的信心阈值检查)也不算:它的具体意见以 thread 出现,由 thread 门拦。
 */
export function filterIgnoredCiContexts(contexts, rules = loadRules()) {
  const ignore = new Set([...(rules.ciIgnoreContexts ?? []), ...(rules.ciIgnoreBotChecks ?? [])].map((name) => String(name)));
  const workflows = new Set((rules.ciIgnoreWorkflows?.names ?? []).map((name) => String(name)));
  if (!Array.isArray(contexts) || (ignore.size === 0 && workflows.size === 0)) return contexts;
  return contexts.filter((context) => !ignore.has(String(context?.name ?? '')) &&
    !workflows.has(String(context?.workflowName ?? '')));
}

/**
 * [MIVO-PATCH ci-ignore] UNSTABLE 只由被忽略的 check 造成时(原始 rollup 读得到,被忽略的 check 里有非通过的),
 * UNSTABLE 已有解释,不再判「CI 状态读取不完整」;剩下的 check 仍由 evaluateCiStatus 照常判 failed/pending。
 */
export function ciMergeStateIgnoring(mergeStateStatus, rawContexts, rules = loadRules()) {
  if (mergeStateStatus !== 'UNSTABLE' || !Array.isArray(rawContexts)) return mergeStateStatus;
  const kept = new Set(filterIgnoredCiContexts(rawContexts, rules));
  const ignored = classifyRollupContexts(rawContexts.filter((context) => !kept.has(context)));
  return ignored.failed.length || ignored.pending.length || ignored.awaiting.length ? 'UNSTABLE_IGNORED_ONLY' : mergeStateStatus;
}

// [MIVO-PATCH slack-release] Slack 讨论串里维护者回复「同意放行」视为放行。
// Slack 同步评论(scripts/loops/slack-issue-inbound/sync.mjs 写入)的形态:
//   来自 Slack #<频道> · @<GitHub login>(<显示名>)\n\n<原文>\n\n<!-- slack-inbound <channel>:<ts> -->
// 发帖人统一是同步 bot,真正的放行人只能从首行署名里认;署名由 Slack 不可变 user id 映射而来。
export const SLACK_INBOUND_MARKER_RE = /<!--\s*slack-inbound\s+(\S+?)\s*-->/;
const SLACK_SIGNATURE_RE = /^来自\s*Slack[^\n]*?·\s*@([A-Za-z0-9][A-Za-z0-9-]*)/;
const SLACK_CONSENT_NEGATION_RE = /不\s*同意|不\s*放行|先别|别放|暂不|不要放行|先不要|不能放行|还不能/;
const SLACK_CONSENT_TRAILING_RE = /[\s。．.!！~～]+$/u;

/** 解析一条 Slack 同步评论;不是同步格式返回 null。 */
export function parseSlackSyncComment(body) {
  const text = String(body ?? '').replace(/\r/g, '');
  const signature = text.match(SLACK_SIGNATURE_RE);
  const marker = text.match(SLACK_INBOUND_MARKER_RE);
  if (!signature || !marker) return null;
  const firstBreak = text.indexOf('\n');
  const message = (firstBreak < 0 ? '' : text.slice(firstBreak + 1)).replace(SLACK_INBOUND_MARKER_RE, '').trim();
  return { login: signature[1], message, fingerprint: marker[1] };
}

/** 回复正文里必须有一整行恰好是同意短语(允许末尾标点),且全文没有否定说法。 */
export function isExplicitSlackConsent(message, consentLine = '同意放行') {
  const text = String(message ?? '');
  const phrase = String(consentLine ?? '').trim();
  if (!phrase || SLACK_CONSENT_NEGATION_RE.test(text)) return false;
  return text.split('\n').some((line) => line.trim().replace(SLACK_CONSENT_TRAILING_RE, '') === phrase);
}

/**
 * 从讨论 issue 的评论里挑出可信的 Slack 放行。三条同时满足才算:
 * 1. 评论作者在 slackSyncBots,正文带 slack-inbound 标记;
 * 2. 署名 @login 在最终维护者集合内,且不是 PR 作者;
 * 3. 回复正文是明确的同意整句。
 * @returns {{ release: {by:string, at:string|null, via:'slack-release', fingerprint:string}|null, rejected: object[] }}
 */
export function selectTrustedSlackReleases({
  comments = [], syncBots = [], maintainers = [], authorLogin = '', consentLine = '同意放行',
  prCreatedAt = null,
} = {}) {
  const bots = new Set(normalizeLoginList(syncBots).map((login) => login.replace(/\[bot\]$/, '')));
  const members = new Set(normalizeLoginList(maintainers));
  const author = String(authorLogin ?? '').trim().toLowerCase();
  const rejected = [];
  let release = null;
  for (const comment of comments ?? []) {
    const poster = String(comment?.author?.login ?? comment?.author ?? '').trim().toLowerCase().replace(/\[bot\]$/, '');
    const parsed = parseSlackSyncComment(comment?.body);
    if (!parsed) continue;
    const at = comment?.createdAt ?? null;
    const by = parsed.login.toLowerCase();
    const reason = !bots.has(poster) ? 'poster-not-sync-bot'
      : !members.has(by) ? 'signer-not-maintainer'
        : by === author ? 'signer-is-author'
          : !isExplicitSlackConsent(parsed.message, consentLine) ? 'not-explicit-consent'
            : null;
    if (reason) {
      if (reason !== 'not-explicit-consent') rejected.push({ by, at, reason });
      continue;
    }
    // [MIVO-PATCH release-after-pr] 放行必须晚于本 PR 创建;同一 PR 后续 push 仍有效。
    if (prCreatedAt != null && String(at ?? '') <= String(prCreatedAt)) {
      rejected.push({ by, at, reason: 'before-pr-created' });
      continue;
    }
    if (!release || String(at ?? '') >= String(release.at ?? '')) {
      release = { by, at, via: 'slack-release', fingerprint: parsed.fingerprint };
    }
  }
  return { release, rejected };
}

// [MIVO-PATCH issue-comment-release] 维护者直接在确认 issue 下评论「同意放行」视为放行(判据同 slack-release:
// 一整行是同意短语、全文无否定词)。评论人必须在维护者集合内且不是 PR 作者;被折叠的评论、带流程标记的
// 自动评论(审查账号也是维护者,它发的流程评论不能算)、Slack 同步评论都不算。
const AUTOMATED_ISSUE_COMMENT_RE = /<!--\s*(?:review-pr:|mivo-|slack-inbound\b)/;
/**
 * @returns {{ release: {by:string, at:string|null, via:'issue-comment', fingerprint:string}|null, rejected: object[] }}
 */
export function selectTrustedIssueCommentReleases({
  comments = [], maintainers = [], authorLogin = '', consentLine = '同意放行',
  prCreatedAt = null,
} = {}) {
  const members = new Set(normalizeLoginList(maintainers));
  const author = String(authorLogin ?? '').trim().toLowerCase();
  const rejected = [];
  let release = null;
  for (const comment of comments ?? []) {
    const by = String(comment?.author?.login ?? comment?.author ?? '').trim().toLowerCase();
    if (!by || !members.has(by)) continue;
    if (comment?.isMinimized === true) continue;
    const body = String(comment?.body ?? '');
    if (AUTOMATED_ISSUE_COMMENT_RE.test(body)) continue;
    if (!isExplicitSlackConsent(body, consentLine)) continue;
    const at = comment?.createdAt ?? null;
    if (by === author) {
      rejected.push({ by, at, reason: 'commenter-is-author' });
      continue;
    }
    // [MIVO-PATCH release-after-pr] 放行必须晚于本 PR 创建;同一 PR 后续 push 仍有效。
    if (prCreatedAt != null && String(at ?? '') <= String(prCreatedAt)) {
      rejected.push({ by, at, reason: 'before-pr-created' });
      continue;
    }
    if (!release || String(at ?? '') >= String(release.at ?? '')) {
      release = { by, at, via: 'issue-comment', fingerprint: String(comment?.id ?? comment?.url ?? at ?? '') };
    }
  }
  return { release, rejected };
}

// [MIVO-PATCH signoff-mode] 确认 issue 的模式标记。契约与 Mivo from-github-event.mjs 一致:
// 只认 footer 流程标记句(最后一次出现)之后、且在正文最末尾的那一个;值不认识或位置不对 = 普通模式。
export const SIGN_OFF_PROCESS_MARKER = '本 issue 由 review-pr 流程自动创建';
export const SIGNOFF_MODE_RE = /<!--\s*review-pr:signoff-mode=([a-z-]+)\s*-->\s*$/;
export const SIGNOFF_MODES = new Set(['protected', 'notice']);
export function parseSignoffMode(body) {
  const text = String(body ?? '');
  const footerAt = text.lastIndexOf(SIGN_OFF_PROCESS_MARKER);
  if (footerAt < 0) return 'normal';
  const m = text.slice(footerAt).match(SIGNOFF_MODE_RE);
  return m && SIGNOFF_MODES.has(m[1]) ? m[1] : 'normal';
}

/** 确认 issue footer 里的「关联 PR:#n」(取最后一处;Mivo parseSignoffIssue 的契约句式,半角冒号)。 */
export function parseSignoffIssueFooterPr(body) {
  const all = [...String(body ?? '').matchAll(/关联\s*PR:#(\d+)/g)];
  return all.length ? Number(all.at(-1)[1]) : null;
}

/**
 * [MIVO-PATCH issue-binding] 确认 issue 必须属于本 PR、且不是通知 issue,它上面的放行才可信。
 * 标记评论(parseLastHoldMarker)任何人都能在自己的 PR 上发,指向别的 PR 的已放行 issue 就能借走放行。
 * 绑定判据:标题以「维护者确认 · PR #<本 PR>」开头(后面不是数字,#97 不匹配 #971),且 footer 的「关联 PR:#n」
 * 也等于本 PR。notice 模式的 issue 只是通知,「同意放行」不算放行。
 * @returns {{mode:string, releaseUntrusted:string|null, slackRelease:object|null, slackReleaseRejected:object[],
 *   issueCommentRelease:object|null, issueCommentReleaseRejected:object[]}}
 */
export function selectDiscussionIssueReleases({
  issue = {}, pr, syncBots = [], maintainers = [], authorLogin = '', consentLine = '同意放行',
  slackEnabled = false, commentEnabled = false, prCreatedAt = null,
} = {}) {
  const mode = parseSignoffMode(issue?.body);
  const titleBound = new RegExp(`^维护者确认 · PR #${Number(pr)}(?!\\d)`).test(String(issue?.title ?? ''));
  const footerBound = parseSignoffIssueFooterPr(issue?.body) === Number(pr);
  const releaseUntrusted = !titleBound || !footerBound ? 'issue-not-bound' : mode === 'notice' ? 'notice-issue' : null;
  const out = {
    mode, releaseUntrusted, slackRelease: null, slackReleaseRejected: [], issueCommentRelease: null, issueCommentReleaseRejected: [],
  };
  if (releaseUntrusted) return out;
  if (slackEnabled) {
    const slack = selectTrustedSlackReleases({ comments: issue.comments ?? [], syncBots, maintainers, authorLogin, consentLine, prCreatedAt });
    out.slackRelease = slack.release;
    out.slackReleaseRejected = slack.rejected;
  }
  if (commentEnabled) {
    const typed = selectTrustedIssueCommentReleases({ comments: issue.comments ?? [], maintainers, authorLogin, consentLine, prCreatedAt });
    out.issueCommentRelease = typed.release;
    out.issueCommentReleaseRejected = typed.rejected;
  }
  return out;
}

/** 多个放行取更晚的一条(at 字符串比较,与 selectTrusted* 同口径);都没有返回 null。 */
export function latestIssueRelease(...releases) {
  let latest = null;
  for (const release of releases) {
    if (release && (!latest || String(release.at ?? '') >= String(latest.at ?? ''))) latest = release;
  }
  return latest;
}

/**
 * [MIVO-PATCH protected-signoff] 受保护路径(.github 等)的人工放行,与确认门同一组信号,不绑 head、持久有效:
 * 维护者(非作者)未撤销的 GitHub Approve,或确认 issue 上的 Slack / GitHub 评论「同意放行」(issueRelease)。
 * reviews 必须是已去掉审查账号自动 review 的 signoffReviews;维护者最新状态是 DISMISSED 视为撤销。
 * 当前 head 上有维护者 Request Changes 时 waitingForAuthor=true,不算放行。没有受保护文件返回 null。
 */
export function evaluateProtectedPathRelease({
  protectedFiles = [], reviews = [], maintainers = [], latestCommitDate = '', issueRelease = null, authorLogin = '', authorExempt = false,
} = {}) {
  if (!protectedFiles.length) return null;
  const review = evaluateMaintainerReview({ reviews, maintainers, latestCommitDate, markerRelease: issueRelease, authorLogin });
  // [MIVO-PATCH protected-author-release] 作者是维护者(authorExempt = context 的 authorSignoffExempt:
  // 维护者集合成员或 exemptAuthors)时放行直接成立,不等 Approve / 「同意放行」。「谁能给别人的 PR 放行」仍只看
  // maintainers(maintainerAllowlist),这里不动;别的维护者在当前 head 上 Request Changes 时照旧交作者。
  const author = String(authorLogin ?? '').trim().toLowerCase();
  const authorRelease = authorExempt === true && author !== '' && !review.waitingForAuthor
    ? { by: author, via: 'author-maintainer', at: null, fingerprint: `author-maintainer:${author}` }
    : null;
  const raw = authorRelease ?? review.released;
  const released = raw
    ? { ...raw, fingerprint: raw.fingerprint ?? `${raw.via}:${raw.by}:${raw.at ?? ''}` }
    : null;
  return {
    files: protectedFiles.slice(0, 30),
    fileCount: protectedFiles.length,
    released,
    waitingForAuthor: review.waitingForAuthor,
    reviewState: authorRelease ? 'author-maintainer' : review.reviewState,
  };
}

/**
 * [MIVO-PATCH protected-author-release] 通知 issue 建完即关时留的那句说明。kind=protected(受保护路径、作者是维护者、
 * 自动放行)单独写准;其余沿用原文。尾部暗记不变,Mivo 侧靠它识别流程评论。
 */
export const NOTICE_CLOSE_MARKER = '<!-- review-pr:signoff-notice-close -->';
export function toNoticeCloseComment(kind = 'product') {
  const text = kind === 'protected'
    ? '本 issue 只是通知：作者是维护者，受保护路径改动按规则自动放行，审查机直接把 `review-pr` 写为通过。流程已自动关闭本 issue，不需要回复。'
    : '本 issue 只是通知:作者在豁免名单内,维护者确认门不拦,PR 照常进入自动审查。流程已自动关闭本 issue,不需要回复。';
  return `${text}\n\n${NOTICE_CLOSE_MARKER}`;
}

/** [MIVO-PATCH protected-author-release] 放行后关讨论 issue 时留的说明:调用方给了文案(如自动放行)就用它,否则沿用原文。 */
export function toDiscussIssueCloseBody({ pr, url, closeCommentBody = '' } = {}) {
  const custom = String(closeCommentBody ?? '').trim();
  return custom !== '' ? custom : `维护者确认已通过,讨论结束,PR 恢复正常推进。关联 PR:#${pr}(${url})。本 issue 由 review-pr 流程自动关闭。`;
}

/** [MIVO-PATCH signoff-mode] 确认 issue footer。句式是 Mivo parseSignoffIssue 的契约,只在末尾追加模式标记。 */
export function buildSignoffIssueFooter({ pr, author, topic, mode = 'normal' }) {
  const base = `\n\n---\n关联 PR:#${pr}(作者 @${author});${SIGN_OFF_PROCESS_MARKER},用于先讨论该 PR 涉及的${topic},维护者确认后 PR 会恢复推进。`;
  return mode === 'protected' || mode === 'notice' ? `${base}\n<!-- review-pr:signoff-mode=${mode} -->` : base;
}

/**
 * [MIVO-PATCH ci-ignore] BLOCKED 只因本流程自己的必需检查(ciIgnoreContexts,如 review-pr)
 * 尚未上报或尚未通过?是则返回 true。probe 读不到、还有别的必需检查未满足,都返回 false(从严)。
 */
export function onlyOwnRequiredChecksPending({ probe = null, rollupContexts = null, rules = loadRules() } = {}) {
  const own = new Set((rules.ciIgnoreContexts ?? []).map((name) => String(name)));
  if (!probe || !Array.isArray(probe.requiredStatusChecks) || own.size === 0 || !Array.isArray(rollupContexts)) return false;
  const pass = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const latest = new Map();
  rollupContexts.forEach((context, index) => {
    const order = context?.startedAt ?? context?.createdAt ?? context?.completedAt ?? `9999-${index}`;
    const prev = latest.get(context?.name);
    if (!prev || String(order) >= String(prev.order)) latest.set(context?.name, { context, order });
  });
  const unmet = probe.requiredStatusChecks
    .map((check) => String(typeof check === 'string' ? check : check?.context ?? '').trim())
    .filter(Boolean)
    .filter((name) => !pass.has(String(latest.get(name)?.context?.conclusion ?? '').toUpperCase()));
  return unmet.length > 0 && unmet.every((name) => own.has(name));
}
