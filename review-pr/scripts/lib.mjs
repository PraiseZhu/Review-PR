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
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, realpathSync, readdirSync, copyFileSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, basename, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const isWin = process.platform === 'win32';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, '..');

/**
 * Skill 与目标仓库解耦：
 * - 所有 git / gh 命令默认作用于调用方 cwd（scheduler 的 workingDir）。
 * - REVIEW_PR_REPO_ROOT 可显式指定目标仓库，入口脚本应在执行前 chdir 到该目录。
 * - 运行时状态默认落进目标仓库主 worktree 的 `history/loops/review-pr/state/`
 *   （见下方 `resolvePersistentStateRoot`），经 git-ignore/自写/可写三道校验；
 *   任一校验不过或无法判定主 worktree 时才回退系统临时目录，不写 Skill 目录本身。
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
const LEGACY_STATE_ROOT = join(tmpdir(), 'review-pr');

/**
 * 主 worktree 根目录(F1,2026-08-01 审核修订)。状态根不能拼当前 checkout 的
 * REPO_ROOT——REPO_ROOT 可能是某一轮审查用的 linked worktree,按它算状态根会
 * 让同一仓库的不同 worktree/轮次各自写到不同目录,锁/审计/去重照样分裂(与上面
 * stateAnchor 要解决的问题同源)。复用已算好的 `stateAnchor`(git-common-dir 的
 * 绝对路径),不重新发一次 `--git-common-dir`,避免与 repoStateKey 的锚点产生
 * 第二份可能漂移的读数。裸仓库(没有工作树概念)或任何推导失败(非 git 仓库、
 * git 不可用、common-dir 不是 `<root>/.git` 形态)都返回 null,调用方回退系统
 * 临时目录。
 */
function resolveMainWorktreeRoot() {
  if (stateAnchor === REPO_ROOT) return null; // resolveStateAnchor 的非 git/异常回退,没有 common-dir 可用
  if (basename(stateAnchor) !== '.git') return null; // 裸仓库(common-dir 本身就是仓库目录)或非常规形态,不做假设
  const bare = spawnSync('git', ['rev-parse', '--is-bare-repository'], {
    cwd: REPO_ROOT, encoding: 'utf8', shell: isWin, timeout: 10_000,
  });
  if (bare.status === 0 && (bare.stdout ?? '').trim() === 'true') return null; // 裸仓库,没有工作树可落盘
  const mainRoot = dirname(stateAnchor);
  return existsSync(mainRoot) ? mainRoot : null;
}

/** 从某个可能尚不存在的路径向上找最近一个已存在的祖先目录(git 命令与 realpath 都需要真实存在的 cwd)。 */
function nearestExistingAncestor(p) {
  let cur = p;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

/** cwd 是否在某个 git 工作树内(裸仓库、非仓库目录都算"否")。 */
function isInsideAnyGitWorkTree(cwd) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd, encoding: 'utf8', shell: isWin, timeout: 10_000,
  });
  return r.status === 0 && (r.stdout ?? '').trim() === 'true';
}

/**
 * F2①:该路径是否可以安全写入而不弄脏某个 git working tree。
 *   - 路径不在任何 git 工作树内(压根没有 `.git` 祖先,或所在目录本身就不是
 *     仓库)→ 没有"脏树"这个概念,视为安全;
 *   - 在某个工作树内 → 必须被该仓库的 `.gitignore` 覆盖(`git check-ignore -q`
 *     exit 0),否则视为不安全——宁可回退系统临时目录,绝不制造 untracked/dirty
 *     的工作树改动;
 *   - git 命令本身失败(未安装/权限/超时等,与上面两种确定性结果都不同)在
 *     `isInsideAnyGitWorkTree` 里已按"不在工作树内"处理(status!=0 即返回
 *     false),不会误判为"在工作树内但已忽略"。
 * cwd 用路径本身最近的已存在祖先目录——路径可能尚不存在(如首次落盘前)。
 */
function isSafeFromDirtyWorkingTree(candidatePath) {
  const cwd = nearestExistingAncestor(candidatePath);
  if (!isInsideAnyGitWorkTree(cwd)) return true;
  const r = spawnSync('git', ['check-ignore', '-q', candidatePath], { cwd, shell: isWin, timeout: 10_000 });
  return r.status === 0;
}

/**
 * F2②:拒绝状态根落在 Skill 自身仓库内(防自写)。Skill 常以软链接装进目标
 * 项目,真实源码在 skills 仓库里(`skillRepoInfo()` 已按 realpath 解析回真实
 * 仓库)——状态根若落进 skills 仓库本身,会把运行时噪音(锁文件、审计历史)
 * 写进 skill 的源码仓库,和 review-pr 自己的自进化台账搞混。
 */
function isInsideSkillRepo(candidatePath) {
  const info = skillRepoInfo();
  if (!info) return false; // Skill 不在任何 git 仓库内,没有"自写"这个风险
  let skillRepoReal;
  try {
    skillRepoReal = realpathSync(info.gitRoot);
  } catch {
    return false;
  }
  let ancestorReal;
  try {
    ancestorReal = realpathSync(nearestExistingAncestor(resolve(candidatePath)));
  } catch {
    return false;
  }
  const rel = relative(skillRepoReal, ancestorReal);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** F3:写文件 + 删除的真实探针。mkdir 成功不代表可写(某些只读文件系统对已存在目录的 mkdir 直接成功,真正写文件才报错)。 */
function writeProbeOk(dir) {
  const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, '');
  } catch {
    return false;
  }
  try {
    unlinkSync(probe);
  } catch { /* 探针删不掉不影响"可写"结论 */ }
  return true;
}

/**
 * 某候选根目录是否可以安全、可靠地作为状态根(F1-F3 三道校验合一):
 * 不在未忽略的工作树内(F2①)、不在 Skill 自身仓库内(F2②)、且最终叶子目录
 * `root/repoStateKey` 通过真实写探针(F3)。三者全过才返回 true。
 */
function isStateRootSafeAndWritable(root) {
  if (!isSafeFromDirtyWorkingTree(root)) return false;
  if (isInsideSkillRepo(root)) return false;
  const dir = join(root, repoStateKey);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }
  return writeProbeOk(dir);
}

/**
 * 状态根目录优先级(SC2-1,经 2026-08-01 审核 F1/F2/F3 修订)。此前恒为系统
 * 临时目录,mac mini 实测:scheduler 停摆超过 3 天,macOS dirhelper 的
 * `CLEAN_FILES_OLDER_THAN_DAYS=3` 清理策略会把 runs.jsonl / last-scan.json /
 * fix-sessions.json 等审计历史整个清空。当前优先级:
 *   ① `REVIEW_PR_STATE_DIR` 环境变量——显式覆盖,但仍须过 F2①/F2②/F3 三道
 *      校验(文档已声称"不能指向受 Git 跟踪的项目目录或 Skill 目录",这里是
 *      真正执行,不再只是文档承诺);校验不过直接回退系统临时目录,不静默
 *      改用仓库默认(用户的显式选择不该被 skill 偷偷换掉);
 *   ② `<主 worktree>/history/loops/review-pr/state`——锚定同仓库所有 worktree
 *      共享的主 checkout(见 `resolveMainWorktreeRoot`,不是当前 REPO_ROOT),
 *      随该 checkout 常驻;同样须过 F2①/F2②/F3;
 *   ③ 系统临时目录(旧默认)——裸仓库、非 git 仓库、或以上两层任一校验不过时
 *      的最终回退,好于直接抛错崩溃。
 * `repoStateKey` 子目录隔离保持不变:三层优先级只决定"根在哪",同一仓库的
 * 不同 worktree/轮次仍共享同一个 `<根>/<repoStateKey>/`(见上方 stateAnchor
 * 注释——这层由 git-common-dir 锚定,与本次改动无关,不受影响)。
 */
function resolvePersistentStateRoot() {
  if (process.env.REVIEW_PR_STATE_DIR) {
    const envRoot = resolve(process.env.REVIEW_PR_STATE_DIR);
    if (isStateRootSafeAndWritable(envRoot)) return envRoot;
    process.stderr.write(
      `[review-pr] REVIEW_PR_STATE_DIR=${envRoot} 未通过校验(工作树未忽略该路径 / ` +
      '落在 Skill 自身仓库内 / 写探针失败),回退系统临时目录\n',
    );
    return LEGACY_STATE_ROOT;
  }
  const mainRoot = resolveMainWorktreeRoot();
  if (mainRoot) {
    const repoBased = join(mainRoot, 'history', 'loops', 'review-pr', 'state');
    if (isStateRootSafeAndWritable(repoBased)) return repoBased;
  }
  return LEGACY_STATE_ROOT;
}

const stateRoot = resolvePersistentStateRoot();
export const STATE_DIR = join(stateRoot, repoStateKey);
mkdirSync(STATE_DIR, { recursive: true });

const MIGRATION_MARKER = '.migrated-from-tmp.json';

/**
 * 一次性迁移(F4,2026-08-01 审核修订)。判据改为"marker 是否存在"而不是
 * "新目录有没有 runs.jsonl"——旧判据在部分失败场景下会永久卡死(第一次迁移
 * 复制完 runs.jsonl 后在其他文件上失败,marker 没写;下一次调用因为 runs.jsonl
 * 已经"看起来存在"而直接跳过,永远补不齐剩下的文件)。现在:
 *   - 触发条件只看 marker 是否存在,marker 不存在就总会重试;
 *   - 逐文件 no-clobber:目标已存在的文件跳过不覆盖——保证即使本轮已经产生了
 *     真实的新数据(如 runs.jsonl 已被新一轮 review 追加过),重试迁移也绝不会
 *     用旧 tmpdir 里更早、更小的版本覆盖回去;
 *   - 只有这一轮把 legacy 目录里的每个文件都处理完(拷贝成功或因目标已存在
 *     而跳过)才写 marker,且 marker 用临时文件 + rename 落盘(同文件系统下
 *     rename 是原子操作)——marker 存在 ⇔ 迁移已完整跑完,不会出现"半完成但
 *     已标记完成"的中间态,迁移失败(权限/磁盘等)只记 stderr warning、不阻断,
 *     下次调用会自动重试补齐。
 */
function migrateLegacyStateIfNeeded() {
  if (stateRoot === LEGACY_STATE_ROOT) return; // 新旧根相同,无需迁移
  const legacyDir = join(LEGACY_STATE_ROOT, repoStateKey);
  const marker = join(STATE_DIR, MIGRATION_MARKER);
  if (existsSync(marker) || !existsSync(legacyDir)) return;
  try {
    for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === MIGRATION_MARKER) continue;
      const dest = join(STATE_DIR, entry.name);
      if (existsSync(dest)) continue; // no-clobber:目标已存在(可能是新数据)一律不覆盖
      copyFileSync(join(legacyDir, entry.name), dest);
    }
    const tmpMarker = `${marker}.tmp-${process.pid}`;
    writeFileSync(
      tmpMarker,
      JSON.stringify({ migratedAt: new Date().toISOString(), from: legacyDir, to: STATE_DIR }, null, 2),
    );
    renameSync(tmpMarker, marker); // 同文件系统 rename 是原子操作,marker 不会以"半写"状态出现
  } catch (e) {
    process.stderr.write(`[review-pr] 状态目录一次性迁移未完成(不阻断,下次调用会重试补齐): ${e.message}\n`);
  }
}
migrateLegacyStateIfNeeded();

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

/**
 * 读取 review-pr 私有规则 + 实际采用的配置文件绝对路径,解析顺序(先命中先用):
 *   ① 环境变量 REVIEW_PR_RULES_FILE ——安装方显式指向别的配置文件,优先级最高;
 *   ② 目标仓库自己的 <REPO_ROOT>/agent-use/docs/pr-rules.json ——存在即用,让接入仓库
 *      不改 Skill 本体就能装配自己的全套规则(白名单、门控开关等),这是多仓库共用同一份
 *      Skill 源码的关键机制;
 *   ③ Skill 自带的 config/pr-rules.json(中性默认,不含任何具体仓库的白名单/路径)。
 *
 * 一次 IO 同时拿到内容与来源路径,保证「解析用的是哪份、报告说的是哪份」不漂移
 * (SKILL 6 节 auto provenance 行、context.mjs 等需要如实报告来源路径的消费方都应
 * 用这个,不要自己重演三层优先级去猜——猜错的后果是 provenance 报告与实际读取的
 * 配置文件不一致)。`loadRules()` 是本函数的薄包装,只取 `.rules`,保持原有签名与
 * 返回值不变,兼容所有既有消费方。
 */
export function loadRulesWithSource() {
  if (process.env.REVIEW_PR_RULES_FILE) {
    const rulesFile = resolve(process.env.REVIEW_PR_RULES_FILE);
    return { rules: JSON.parse(readFileSync(rulesFile, 'utf8')), rulesFile };
  }
  const repoRulesFile = join(REPO_ROOT, 'agent-use', 'docs', 'pr-rules.json');
  if (existsSync(repoRulesFile)) {
    return { rules: JSON.parse(readFileSync(repoRulesFile, 'utf8')), rulesFile: repoRulesFile };
  }
  const skillRulesFile = join(SKILL_ROOT, 'config', 'pr-rules.json');
  return { rules: JSON.parse(readFileSync(skillRulesFile, 'utf8')), rulesFile: skillRulesFile };
}

/** 薄包装,见 `loadRulesWithSource()`——只取规则内容,签名与返回值与此前完全一致。 */
export function loadRules() {
  return loadRulesWithSource().rules;
}

/**
 * 把 pr-rules.json 里配置的仓库相对路径解析成绝对路径,并做 containment 校验(校验结果
 * 确实落在 REPO_ROOT 内),供 detectLoopExclusion 的 stateFile、notify-merge-ack.mjs 的
 * dedupFile/stateDir/notifyModule 等消费,避免每处各写一份校验逐渐漂移。
 *
 * 用 `realpath` + `path.relative` 而不是 `resolved.startsWith(REPO_ROOT)`——后者是纯字符串
 * 前缀比较,有两个绕过口子:①同级前缀目录(仓库叫 `foo`,配置写 `../foo-evil/x`,拼出来的
 * 字符串仍以 `.../foo` 开头,`startsWith` 误判为"在仓库内");②symlink(仓库内某祖先目录
 * 若是指向仓库外的软链接,字符串层面看着在仓库内,`realpath` 消解后其实不在)。`path.relative`
 * 算出的相对路径以 `..` 开头,才是"确实跳出了仓库根"的准确判据。
 *
 * 目标路径可能还不存在(如去重指纹文件首次写入前)——从 `naive` 开始向上找最深的已存在
 * 祖先目录做 `realpathSync`(消解该祖先链路上的 symlink),再把还不存在的尾部路径段原样
 * 拼回去参与 containment 判断(尾部本身没有内容、不存在 symlink 风险)。
 */
export function resolveInRepoRoot(relPath) {
  const repoRootReal = realpathSync(REPO_ROOT);
  const naive = join(REPO_ROOT, relPath);
  let existingAncestor = naive;
  const restSegments = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break; // 已到文件系统根仍不存在,极端情况,交给下面 relative 判断兜底
    restSegments.unshift(existingAncestor.slice(parent.length + 1));
    existingAncestor = parent;
  }
  const ancestorReal = realpathSync(existingAncestor);
  const resolved = restSegments.length ? join(ancestorReal, ...restSegments) : ancestorReal;
  const rel = relative(repoRootReal, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`配置路径跳出仓库根:${relPath}(resolve 后 ${resolved})`);
  }
  return resolved;
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
 * 分类 PR statusCheckRollup(gh pr view --json statusCheckRollup)为 failed / pending。
 * 与 classifyHeadChecks 互补:actions/runs 只看得到 GitHub Actions 的 workflow run,
 * 看不到第三方 App 的 check-run(Greptile 等)与 commit status;rollup 两者都含,
 * 是「head commit 上所有已上报检查」的全集。主要消费方是 mergeStateStatus=UNSTABLE
 * 分支——UNSTABLE = 可合并但有非 required 检查失败/未完成,GitHub 不拦、我们必须拦
 * (典型:PG smoke 这类跑在 PR 上但未升门的检查挂了,不拦就会自动合并带病 PR)。
 * rollup 为 null/非数组(字段没取 / 权限异常)返 null——调用方须按「未知」保守处理,
 * 不得当「无失败」放行。CANCELLED 计入 failed:rollup 只看 head commit,头上挂着
 * 被取消的 run 说明该检查没跑完整,方向安全(最多多跳过一轮,不会漏拦)。
 */
export function classifyStatusRollup(rollup) {
  if (!Array.isArray(rollup)) return null;
  const FAIL_RUN = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  const OK_RUN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const failed = [];
  const pending = [];
  const ok = []; // 已上报且通过(SUCCESS/NEUTRAL/SKIPPED)的检查名——probeBranchProtection 用它判 required_status_checks 规则是否已满足
  for (const c of rollup) {
    // CheckRun(name/status/conclusion)与 StatusContext(context/state)字段形状不同,统一归一
    const name = c?.name ?? c?.context ?? '(unnamed check)';
    if (c?.state != null) {
      // StatusContext:state = SUCCESS / FAILURE / ERROR / PENDING / EXPECTED
      if (c.state === 'FAILURE' || c.state === 'ERROR') failed.push(name);
      else if (c.state !== 'SUCCESS') pending.push(name);
      else ok.push(name);
    } else if (c?.status !== 'COMPLETED') {
      pending.push(name);
    } else if (FAIL_RUN.has(c?.conclusion)) {
      failed.push(name);
    } else if (!OK_RUN.has(c?.conclusion)) {
      // 未知 conclusion(GitHub 新增枚举等)按未完成处理,方向安全
      pending.push(name);
    } else {
      ok.push(name);
    }
  }
  return { failed, pending, ok };
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
export function probeBranchProtection(slug, branch, { satisfiedContexts = null } = {}) {
  if (!branch) return null;
  const rr = gh(['api', `repos/${slug}/rules/branches/${encodeURIComponent(branch)}`], { allowFail: true });
  if (!rr.ok) return null;
  try {
    const rules = JSON.parse(rr.stdout || '[]');
    if (!Array.isArray(rules)) return null;
    const CHECK_RULES = new Set(['required_status_checks', 'code_scanning', 'code_quality']);
    // required_status_checks 与 code_scanning/code_quality 本质不同:后两者在 GHAS 未接线的仓
    // 永不上报(真·结构性门,structuralBypassAllowlist 管的就是它们);前者要求的是具体 CI
    // context,head commit 的 rollup 里全绿即为「已满足」——已满足的规则不是 blocker,必须
    // 从 requiredCheckRules 剔除,否则 allowlist 的 every() 永远差这一项,自动 bypass 被
    // 永久锁死(实测:ci-required-checks ruleset 上线后所有 PR 卡死在 skip-structural-block)。
    // fail-closed:调用方没给 satisfiedContexts(rollup 读不到)、或规则里读不出 context 清单、
    // 或有任一 context 不在已通过集合里 → 一律保留该规则(宁可不 bypass,不可误 bypass)。
    const satisfied = satisfiedContexts instanceof Set ? satisfiedContexts : null;
    const missingRequiredContexts = [];
    const activeCheckRules = rules.filter((r) => {
      if (!CHECK_RULES.has(r.type)) return false;
      if (r.type !== 'required_status_checks' || satisfied === null) return true;
      const wanted = (r.parameters?.required_status_checks ?? [])
        .map((c) => c?.context)
        .filter((c) => typeof c === 'string' && c !== '');
      if (wanted.length === 0) return true; // 读不出要求的 context → 保守保留
      const missing = wanted.filter((c) => !satisfied.has(c));
      if (missing.length === 0) return false; // 全部已上报且通过 → 规则已满足,不是 blocker
      missingRequiredContexts.push(...missing);
      return true;
    });
    const requiredCheckRules = [...new Set(activeCheckRules.map((r) => r.type))];
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
    return { requiredCheckRules, canBypass, rulesetIds, missingRequiredContexts };
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

// ── Loop 托管 PR 排除(与目标仓库自有的自动修 bug loop 共存;context.mjs 扫描分类、
// notify-merge-ack.mjs 判断是否要发合并致谢共用同一份判定,防止两处判据漂移)──

/**
 * 判定该 PR 是否由目标仓库自有的自动修 bug loop 托管、以及其 T-level。
 * 返回 null(未命中 titlePrefix,或命中但本地台账没有该 PR 号的记录——与 loop 无关 /
 * 无法证明托管关系,按普通 PR 处理)或 { matched:true, verdict:'t1'|'t2', source }。
 * verdict='t1' 时 review-pr 必须跳过(loop 自己合并,不审不合不催,也不重复播报合并致谢);
 * 'skip'(=已确认托管但拿不准 T-level,defaultWhenAmbiguous)按同款处理;'t2' 时正常走 review-pr。
 * source 标注判据来源(body-marker / state.json / default),供排查与飞书汇总措辞用。
 * rules 来自 pr-rules.json 的 loopPrExclusion 字段,调用方自行 JSON.parse 后传入
 * (不同脚本读取 pr-rules.json 的相对路径不同,本函数不做路径假设)。rules 为 null/未配置
 * loopPrExclusion 时(目标仓库没有这类 loop)恒返回 null——整套机制天然关闭。
 *
 * ⚠️ 身份门槛(反伪造):仅标题前缀**不足以**认定 PR 由 loop 托管——任何贡献者都能在自己
 * PR 的标题前加一句 titlePrefix 字面量,冒充 loop 托管来拿到 defaultWhenAmbiguous 的默认
 * skip,让自己的 PR 永久漏审。必须本地台账(`rules.stateFile`,loop 自己写入、贡献者在
 * GitHub 侧碰不到这份本机文件)里精确命中该 PR 号,才认定为真托管;命中前缀但台账查不到
 * (文件不存在 / 读不到 / 没有该 PR 号)→ **直接返回 null,按普通 PR 处理**,不再落到
 * defaultWhenAmbiguous。未来若 loop 加了可信 label / commit 签名等机制,可以在这里追加
 * 作为身份门槛的替代或补充信号,但不能只靠可由 PR 作者自行填写的字段(标题 / body 文本)
 * 单独作数。
 */
export function detectLoopExclusion({ title, body, pr, rules }) {
  if (!rules?.titlePrefix || !title.startsWith(rules.titlePrefix)) return null;
  if (!rules.stateFile) return null; // 没配台账路径 = 没有身份门槛可验,不认定托管

  let cluster = null;
  try {
    // containment 校验(见 resolveInRepoRoot):stateFile 来自本仓自己的 pr-rules.json
    // (非 PR 可控),风险很低,但配置写错(如误填 `../../../etc/passwd`)时该显式报错
    // 而不是静默读到仓库外的文件——校验成本几乎为零。
    const statePath = resolveInRepoRoot(rules.stateFile);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    // state.json 里 pr 字段的历史写法不保证是 number(曾见过字符串),统一 Number 归一化再比较。
    cluster = Object.values(state.clusters ?? {}).find((c) => Number(c.pr) === Number(pr)) ?? null;
  } catch {
    cluster = null; // 台账不存在 / 读不到 / 配置跳出仓库根,身份门槛过不了
  }
  if (!cluster) return null; // 台账没有这个 PR 号——无法证明托管关系,按普通 PR 走全套 review-pr 流程

  // 身份确认后再判 T-level:先看 body 里 loop 自己声明的独立 metadata 行(锚定整行、加 m 标志
  // 逐行匹配,避免自然语言正文里偶然出现的"这次不建议合并"之类描述性语句被误当成 T-level 声明);
  // 没写明再退回本地台账的 cluster.tCap(身份门槛已过,这里可信采信)。
  for (const re of rules.t1BodyMarkers ?? []) {
    if (new RegExp(re, 'm').test(body)) return { matched: true, verdict: 't1', source: 'body-marker' };
  }
  for (const re of rules.t2BodyMarkers ?? []) {
    if (new RegExp(re, 'm').test(body)) return { matched: true, verdict: 't2', source: 'body-marker' };
  }
  if (cluster.tCap === 'T1') return { matched: true, verdict: 't1', source: 'state.json' };
  if (cluster.tCap === 'T2') return { matched: true, verdict: 't2', source: 'state.json' };

  return { matched: true, verdict: rules.defaultWhenAmbiguous ?? 'skip', source: 'default' };
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
 * 只追加类台账文件的白名单 —— 唯一允许自动解冲突的文件。
 *
 * 背景(2026-07-31 实测):本机交互式轮次与 mini 定时轮次都会往 skills 仓写 evo 台账,
 * 两个写者并发时 push 必然撞 non-fast-forward。下方 skillRepoCommitPush 早就有
 * 「被拒 → pull --rebase → 重推」的重试,但 rebase **每次都在这两个文件上冲突**
 * (两边各自往同一段尾部追加),于是 rebase --abort 回到分叉态;后续每轮 ff-pull 与
 * push 双向死锁,永久不自愈——18 个 evo commit 因此积压一天多。
 *
 * 只对这两个文件自动收敛,理由(与 8.1「扩权类不自动落地」的边界划清):
 *   - 语义是纯追加,合并规则确定(md 取行并集、ledger 按 fingerprint 并集),不需要语义判断;
 *   - 被 rebase 改写的只是**本地尚未推送**的 evo commit,没有第三方持有该历史,改写无副作用;
 *   - 任何其他文件(脚本 / SKILL.md / config)一旦冲突,一律 abort 转人工——那类冲突
 *     是真的代码分歧,自动合并会静默丢改动,风险确实大于收益。
 */
const APPEND_ONLY_CONFLICT_FILES = [
  /(^|\/)EVOLUTION\.md$/,
  /(^|\/)evolution\/ledger\.json$/,
];

const isAppendOnlyConflictFile = (p) => APPEND_ONLY_CONFLICT_FILES.some((re) => re.test(p));

/** 当前处于冲突态(unmerged)的文件列表。 */
function conflictedPaths(cwd) {
  const r = git(['diff', '--name-only', '--diff-filter=U'], { allowFail: true, cwd });
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/** 取冲突文件的某一 stage 内容(1=base, 2=ours/upstream, 3=theirs/被重放的提交);缺失返回 null。 */
function conflictStage(cwd, stage, path) {
  const r = git(['show', `:${stage}:${path}`], { allowFail: true, cwd });
  return r.ok ? r.stdout : null;
}

/**
 * evo 台账 JSON 的确定性合并:按 fingerprint 取并集。
 * 同指纹:occurrences 取大、firstSeen 取早、lastSeen 取晚,其余字段以 lastSeen 更新的一侧为准
 * (时间戳对称比较,与哪边是 ours/theirs 无关,合并结果不受 rebase 方向影响)。
 * 解析失败返回 null(交由调用方 abort 转人工,绝不猜测)。
 */
export function mergeLedgerJson(oursText, theirsText) {
  let ours;
  let theirs;
  try {
    ours = JSON.parse(oursText);
    theirs = JSON.parse(theirsText);
  } catch {
    return null;
  }
  if (!Array.isArray(ours?.entries) || !Array.isArray(theirs?.entries)) return null;
  const CARRY = ['status', 'commit', 'note', 'detail', 'proposal', 'title', 'tier'];
  const merged = new Map();
  for (const e of [...ours.entries, ...theirs.entries]) {
    const fp = e?.fingerprint;
    if (!fp) return null; // 结构不符预期,不冒险
    const cur = merged.get(fp);
    if (!cur) {
      merged.set(fp, { ...e });
      continue;
    }
    cur.occurrences = Math.max(cur.occurrences || 0, e.occurrences || 0);
    if (e.firstSeen && (!cur.firstSeen || e.firstSeen < cur.firstSeen)) cur.firstSeen = e.firstSeen;
    if (e.lastSeen && (!cur.lastSeen || e.lastSeen > cur.lastSeen)) {
      cur.lastSeen = e.lastSeen;
      for (const f of CARRY) if (e[f] !== undefined && e[f] !== null) cur[f] = e[f];
    }
  }
  return `${JSON.stringify({ ...ours, entries: [...merged.values()] }, null, 2)}\n`;
}

/** Markdown 台账的确定性合并:交给 git merge-file --union 做逐 hunk 行并集(不留冲突标记)。 */
function mergeMarkdownUnion(cwd, base, ours, theirs) {
  const dir = mkdtempSync(join(tmpdir(), 'review-pr-union-'));
  try {
    const f = (n, c) => {
      const p = join(dir, n);
      writeFileSync(p, c ?? '');
      return p;
    };
    const r = git(['merge-file', '--union', '-p', f('ours', ours), f('base', base), f('theirs', theirs)], {
      allowFail: true, cwd,
    });
    return r.ok ? r.stdout : null; // --union 下不应有冲突;非 0 视为异常,转人工
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 尝试把当前 rebase 的全部冲突用确定性规则解掉。
 * 返回 { resolved:true } 或 { resolved:false, blockedBy:[非白名单或解不了的文件] }。
 */
function resolveAppendOnlyConflicts(cwd) {
  const paths = conflictedPaths(cwd);
  if (!paths.length) return { resolved: true };
  const blockedBy = paths.filter((p) => !isAppendOnlyConflictFile(p));
  if (blockedBy.length) return { resolved: false, blockedBy };

  for (const p of paths) {
    const base = conflictStage(cwd, 1, p);
    const ours = conflictStage(cwd, 2, p);
    const theirs = conflictStage(cwd, 3, p);
    if (ours == null || theirs == null) return { resolved: false, blockedBy: [p] }; // 增删类冲突不自动处理
    const out = p.endsWith('.json')
      ? mergeLedgerJson(ours, theirs)
      : mergeMarkdownUnion(cwd, base, ours, theirs);
    if (out == null) return { resolved: false, blockedBy: [p] };
    writeFileSync(join(cwd, p), out);
    const add = git(['add', '--', p], { allowFail: true, cwd });
    if (!add.ok) return { resolved: false, blockedBy: [p] };
  }
  return { resolved: true };
}

/** rebase 是否仍在进行中。 */
function rebaseInProgress(cwd) {
  const gd = git(['rev-parse', '--git-path', 'rebase-merge'], { allowFail: true, cwd }).stdout.trim();
  const ga = git(['rev-parse', '--git-path', 'rebase-apply'], { allowFail: true, cwd }).stdout.trim();
  const abs = (p) => (p && isAbsolute(p) ? p : join(cwd, p || ''));
  return Boolean((gd && existsSync(abs(gd))) || (ga && existsSync(abs(ga))));
}

/**
 * 把 skills 仓库 pull 到最新(--ff-only,不产生 merge commit、diverged 时安全失败)。
 * 每轮执行前调用(pre-check / prepare 已内置)。返回:
 *   { ok, action:'pull', updated, before, after, branch, diverged, ahead, behind, error }
 *   或 { ok:true, skipped }。
 * diverged=true(ahead>0 且 behind>0)是「自同步已停摆」的明确信号,调用方应显著上报而非
 * 当作普通网络抖动——它不会自愈,每轮都会重现,直到 push 侧收敛或人工 reconcile。
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

  // ff-only 失败时区分「分叉」与其他原因(网络 / 认证):分叉需要人看,别的下轮自愈。
  let ahead = null;
  let behind = null;
  let remoteHead = null;
  if (!pull.ok) {
    const c = git(['rev-list', '--left-right', '--count', `origin/${info.branch}...HEAD`], { allowFail: true, cwd });
    if (c.ok) {
      const [b, a] = c.stdout.trim().split(/\s+/).map(Number);
      behind = Number.isFinite(b) ? b : null;
      ahead = Number.isFinite(a) ? a : null;
    }
    remoteHead = git(['rev-parse', '--short', `origin/${info.branch}`], { allowFail: true, cwd }).stdout.trim() || null;
  }
  return {
    ok: pull.ok,
    action: 'pull',
    branch: info.branch,
    updated: pull.ok && before !== after,
    before,
    after,
    ...(pull.ok ? {} : { diverged: ahead > 0 && behind > 0, ahead, behind, head: after, remoteHead }),
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
  const converge = [];
  // 被拒(远端先动了)→ rebase 本地未推 commit 后重推。最多试 REBASE_ROUNDS 轮:每轮之间
  // 远端可能又被另一个写者推进(本机交互式轮次 vs mini 定时轮次),重来一次即可收敛。
  const REBASE_ROUNDS = 3;
  for (let round = 0; round < REBASE_ROUNDS && !push.ok
       && /non-fast-forward|fetch first|rejected|stale info/i.test(push.stderr); round++) {
    // 安全网:rebase 会改写本地未推 commit,先留一个可恢复的 ref(不占分支名空间、不会被 push)。
    // 只保留最近 5 个:转人工的失败路径会故意留下 backup ref,每轮失败一个,不设上限会无限堆积
    // (ref 名内嵌 Date.now(),定长同宽,refname 逆序即时间逆序)。
    const olds = git(['for-each-ref', '--format=%(refname)', '--sort=-refname', 'refs/skill-sync/'], { allowFail: true, cwd });
    if (olds.ok) {
      for (const ref of olds.stdout.split('\n').map((s) => s.trim()).filter(Boolean).slice(5)) {
        git(['update-ref', '-d', ref], { allowFail: true, cwd });
      }
    }
    const backupRef = `refs/skill-sync/pre-rebase-${Date.now()}`;
    git(['update-ref', backupRef, 'HEAD'], { allowFail: true, cwd });

    const rb = git(['pull', '--rebase', '--quiet'], { allowFail: true, cwd, timeoutMs });
    if (!rb.ok) {
      // 冲突:只有台账类(只追加)文件才自动收敛,其余一律 abort 转人工。
      const res = resolveAppendOnlyConflicts(cwd);
      if (!res.resolved) {
        git(['rebase', '--abort'], { allowFail: true, cwd });
        return {
          ok: false,
          committed,
          commit,
          pushed: false,
          branch: info.branch,
          converge,
          reason: 'diverged-code-change-needs-human',
          conflictFiles: res.blockedBy,
          backupRef,
          error: `skills 仓分叉且冲突文件不是只追加台账,已 abort 保持原状,需人工 reconcile:${res.blockedBy.join(', ')}`,
        };
      }
      // 逐个 commit 继续重放,每一步都可能再冲突;core.editor=true 防 --continue 打开编辑器挂死。
      let guard = 0;
      while (rebaseInProgress(cwd) && guard++ < 50) {
        const cont = git(['-c', 'core.editor=true', 'rebase', '--continue'], { allowFail: true, cwd, timeoutMs: 30_000 });
        if (cont.ok) continue;
        const again = resolveAppendOnlyConflicts(cwd);
        if (!again.resolved) {
          git(['rebase', '--abort'], { allowFail: true, cwd });
          return {
            ok: false,
            committed,
            commit,
            pushed: false,
            branch: info.branch,
            converge,
            reason: 'diverged-code-change-needs-human',
            conflictFiles: again.blockedBy,
            backupRef,
            error: `rebase 重放中出现非台账冲突,已 abort:${again.blockedBy.join(', ')}`,
          };
        }
      }
      if (rebaseInProgress(cwd)) { // 兜底:没在上限内收完,不留半吊子状态
        git(['rebase', '--abort'], { allowFail: true, cwd });
        return {
          ok: false, committed, commit, pushed: false, branch: info.branch, converge,
          reason: 'rebase-did-not-finish', backupRef, error: 'rebase 未在重试上限内完成,已 abort',
        };
      }
      converge.push({ round: round + 1, resolvedLedgerConflict: true });
    } else {
      converge.push({ round: round + 1, resolvedLedgerConflict: false });
    }
    push = git(['push', '--quiet', 'origin', info.branch], { allowFail: true, cwd, timeoutMs });
    // 推成功后备份 ref 已无用,清掉,避免 refs/skill-sync/* 无限堆积。
    if (push.ok) git(['update-ref', '-d', backupRef], { allowFail: true, cwd });
  }
  return {
    ok: push.ok,
    committed,
    commit,
    pushed: push.ok,
    branch: info.branch,
    ...(converge.length ? { converge } : {}),
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
