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
import { readFileSync, existsSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
      cwd: REPO_ROOT, encoding: 'utf8', shell: isWin, timeout: 10_000,
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
    if (e.code === 'ENOENT') return { released: false, alreadyAbsent: true, notOwner: false };
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
  return { released: true, alreadyAbsent: false, notOwner: false };
}

/** 读取 Skill 私有规则；允许安装方用环境变量覆盖配置文件。 */
export function loadRules() {
  const rulesFile = resolve(
    process.env.REVIEW_PR_RULES_FILE || join(SKILL_ROOT, 'config', 'pr-rules.json'),
  );
  return JSON.parse(readFileSync(rulesFile, 'utf8'));
}

/**
 * 跑外部命令。input 作为 stdin;allowFail=true 时不抛错、返回结果对象;
 * timeoutMs 可选(网络类 git 操作务必带上,防 auto 轮被挂死的子进程卡住);
 * cwd 可选(skill 仓库自同步等「不作用于目标仓库」的 git 操作用它,避免把可能
 * 含空格的路径塞进 -C 参数——Windows 下 shell:true 不会自动加引号)。
 * 返回 { ok, stdout, stderr, status }。
 */
export function run(cmd, args, { input, allowFail = false, timeoutMs, cwd } = {}) {
  const r = spawnSync(cmd, args, {
    input,
    encoding: 'utf8',
    shell: isWin,
    cwd,
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

export function gh(args, opts) {
  return run('gh', args, opts);
}

/** gh 命令 + JSON.parse(stdout)。 */
export function ghJson(args) {
  return JSON.parse(gh(args).stdout || 'null');
}

/**
 * gh api graphql。query 走 stdin(-F query=@-)避免长参数 / 引号地狱;
 * vars 里 number 用 -F(gh 会做类型推断),string 用 -f(raw,防 owner 被误判成数字)。
 * 返回解析后的 JSON(取 .data 之外的完整对象,调用方自行取 .data)。
 */
export function ghGraphql(query, vars = {}, { timeoutMs } = {}) {
  const args = ['api', 'graphql', '-F', 'query=@-'];
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'number') args.push('-F', `${k}=${v}`);
    else args.push('-f', `${k}=${v}`);
  }
  // GraphQL「部分成功」容错:当 query 里某个字段无权访问(典型:fine-grained PAT
  // 读不到 statusCheckRollup)时,GitHub 仍会在 stdout 返回
  // { data:{...其余字段已填充}, errors:[FORBIDDEN ...] },但 gh 会以非 0 退出。
  // 此时不能整体丢弃——只要 data 非 null 就把 partial 结果交给调用方按字段容错,
  // errors 一并带回供调用方识别哪个字段被拒。只有 data 真为 null
  // (查询语法错 / 整体鉴权失败)才抛。
  const r = gh(args, { input: query, allowFail: true, timeoutMs });
  const parsed = JSON.parse(r.stdout || 'null');
  if (parsed && parsed.data != null) return parsed;
  if (!r.ok) {
    const gqlMsg = (parsed?.errors ?? []).map((e) => e.message).filter(Boolean).join('; ');
    throw new Error(`gh api graphql 失败: ${gqlMsg || r.stderr.trim() || '无 data 返回'}`);
  }
  return parsed;
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
    const runs = JSON.parse(r.stdout || '{}').workflow_runs ?? [];
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
 * 返回 { requiredCheckRules, canBypass, rulesetIds } | null。
 */
export function probeBranchProtection(slug, branch) {
  if (!branch) return null;
  const rr = gh(['api', `repos/${slug}/rules/branches/${encodeURIComponent(branch)}`], { allowFail: true });
  if (!rr.ok) return null;
  try {
    const rules = JSON.parse(rr.stdout || '[]');
    if (!Array.isArray(rules)) return null;
    const CHECK_RULES = new Set(['required_status_checks', 'code_scanning', 'code_quality']);
    const requiredCheckRules = [...new Set(rules.filter((r) => CHECK_RULES.has(r.type)).map((r) => r.type))];
    const rulesetIds = [...new Set(rules.map((r) => r.ruleset_id).filter((x) => typeof x === 'number'))];
    let canBypass = null; // null=未知;'never'/false=不能;'always'/'pull_requests'=能
    for (const id of rulesetIds) {
      const rs = gh(['api', `repos/${slug}/rulesets/${id}`], { allowFail: true });
      if (!rs.ok) continue;
      try {
        const cb = JSON.parse(rs.stdout || '{}').current_user_can_bypass;
        if (cb && cb !== 'never') { canBypass = cb; break; } // 任一 ruleset 可 bypass 即可
        if (canBypass == null) canBypass = cb ?? null;
      } catch { /* 单条 ruleset 读失败忽略,继续看下一条 */ }
    }
    return { requiredCheckRules, canBypass, rulesetIds };
  } catch {
    return null;
  }
}

/**
 * 拉公司 org 名录 README(共享底座:resolve-author-feishu.mjs 私聊映射、context.mjs
 * 产品门 Slack 同步评论发送者归属都用它)。读取顺序(fine-grained PAT 读不到跨 org 仓库,
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

// ── 产品/架构门 hold 标记(product-hold.mjs 写入 PR 评论;context.mjs 扫描分类、
// product-release.mjs 放行校验共用同一份解析,防止三处正则漂移)──

/** hold 标记前缀(隐藏 HTML 注释),用于 includes() 级别的廉价预筛。 */
export const PRODUCT_GATE_MARKER_PREFIX = '<!-- review-pr:product-gate';

/**
 * 从一组评论 body 里解析「最后一条」product-hold 标记(与 product-hold.mjs 的去重口径
 * 一致:取最后一条带 issue= 的标记)。返回 { kind:'product'|'arch', issueUrl, issueNumber }
 * | null(从未被 hold 过,或只有无 issue= 的旧版标记)。
 */
export function parseLastHoldMarker(bodies) {
  let last = null;
  for (const body of bodies ?? []) {
    for (const m of (body ?? '').matchAll(/<!--\s*review-pr:product-gate\b([^>]*?)issue=(\S+?)\s*-->/g)) {
      last = { kind: /\bkind=arch\b/.test(m[1]) ? 'arch' : 'product', issueUrl: m[2] };
    }
  }
  if (!last) return null;
  const num = last.issueUrl.match(/\/issues\/(\d+)/)?.[1] ?? null;
  return { ...last, issueNumber: num ? Number(num) : null };
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
 * 挑出命中「指纹输入路径」的文件。pattern 以 `/` 结尾按前缀匹配(目录),否则按整路径相等
 * (避免 `apps/mobile/package.json` 误中 `apps/mobile/package.json.bak` 这类近邻文件)。
 */
export function matchColdUpdatePaths(filePaths, patterns) {
  const list = patterns ?? [];
  return (filePaths ?? []).filter((p) => list.some((pat) => (pat.endsWith('/') ? p.startsWith(pat) : p === pat)));
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
export function skillRepoInfo({ timeoutMs = 15_000 } = {}) {
  let real;
  try {
    real = realpathSync(SKILL_ROOT);
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
export function skillRepoPull({ timeoutMs = 30_000 } = {}) {
  const info = skillRepoInfo();
  if (!info) return { ok: true, action: 'pull', skipped: 'not-a-git-repo' };
  if (!info.branch || info.branch === 'HEAD') return { ok: true, action: 'pull', skipped: 'detached-head' };
  const cwd = info.gitRoot;
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
 *   - paths:相对 skill 根的 pathspec 列表,缺省整个 skill 目录——只 add 这些路径,
 *     绝不把 skills 仓库里其他 skill 的本地改动裹进来;
 *   - message:commit message(经 stdin 传给 git commit -F -,可含空格换行);
 *   - 推送守卫:只在当前分支 == 默认分支(main)时 push;在别的分支上只 commit 不 push,
 *     防止把维护者的实验分支自动发布出去。
 *   - push 被拒(远端先动了)时自动 pull --rebase 后重推一次;再失败如实返回。
 * 返回 { ok, committed, commit, pushed, branch, error | skipped }。
 */
export function skillRepoCommitPush({ paths, message, timeoutMs = 60_000 } = {}) {
  const info = skillRepoInfo();
  if (!info) return { ok: true, committed: false, pushed: false, skipped: 'not-a-git-repo' };
  const cwd = info.gitRoot;
  const joinSpec = (p) => (info.skillRelPath === '.' ? p : `${info.skillRelPath}/${p}`);
  const spec = paths?.length ? paths.map(joinSpec) : [info.skillRelPath];

  git(['add', '-A', '--', ...spec], { allowFail: true, cwd, timeoutMs: 15_000 });
  const staged = git(['diff', '--cached', '--name-only'], { allowFail: true, cwd }).stdout.trim();
  let committed = false;
  let commit = null;
  if (staged) {
    const c = git(['commit', '--quiet', '-F', '-'], {
      input: message || 'evo: sync skill state', allowFail: true, cwd, timeoutMs: 15_000,
    });
    if (!c.ok) {
      return { ok: false, committed: false, pushed: false, step: 'commit', error: (c.stderr || c.stdout).trim().slice(0, 300) };
    }
    committed = true;
    commit = git(['rev-parse', '--short', 'HEAD'], { allowFail: true, cwd }).stdout.trim();
  }

  if (!info.branch || info.branch === 'HEAD') {
    return { ok: false, committed, commit, pushed: false, skipped: 'detached-head' };
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
    if (rb.ok) push = git(['push', '--quiet', 'origin', info.branch], { allowFail: true, cwd, timeoutMs });
    else git(['rebase', '--abort'], { allowFail: true, cwd }); // 回到 rebase 前状态,留给下轮/人工
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
  query($owner:String!,$repo:String!){
    repository(owner:$owner,name:$repo){
      pullRequests(states:OPEN, first:100){
        nodes{
          number headRefOid updatedAt isDraft mergeable mergeStateStatus reviewDecision
          reviewThreads(first:100){ nodes{ isResolved } }
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
export function fetchOpenPrSnapshot({ owner, repo, timeoutMs, settleUnknown = false } = {}) {
  if (!owner || !repo) ({ owner, repo } = parseRepo());
  const fetchOnce = () => {
    const nodes =
      ghGraphql(SNAPSHOT_GQL, { owner, repo }, { timeoutMs })?.data?.repository?.pullRequests?.nodes ?? [];
    return nodes
      .map((n) => ({
        number: n.number,
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
      settle({ ok: false, error: `子进程超时(${timeoutMs}ms): ${args.join(' ')}` });
    }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => settle({ ok: false, error: `spawn 失败: ${e.message}` }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        settle(parsed && typeof parsed === 'object' ? parsed : { ok: false, error: '子进程输出非 JSON 对象' });
      } catch {
        settle({ ok: false, error: `子进程输出解析失败: ${(err || out).trim().slice(0, 300)}` });
      }
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
