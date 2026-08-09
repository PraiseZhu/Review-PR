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
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, realpathSync, readdirSync, copyFileSync, renameSync, lstatSync, constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
// escapedHazards 段的合并与 schema 复验只有一份实现(lib.escaped-hazards 不反向依赖本文件,
// 无循环:它只引 lib.review-profiles / lib.preflight-rules)。
import { mergeHazardPair, validateHazardShape } from './lib.escaped-hazards.mjs';

// NODE_DEBUG 污染防御(复发×5):宿主 shell 可能带 NODE_DEBUG=http,https,net,tls,
// util.debuglog 在 Node 启动早期即捕获该值,进程内 delete 已无法关闭(实测),但
// spawn 子进程继承的是 process.env——此处删除后,本文件所有 spawnSync/spawn 的
// 子进程(gh/git/node 脚本)环境均不含 NODE_DEBUG,纯 JSON stdout 不被调试行污染。
// 只影响本进程及其子进程,不改宿主环境。
delete process.env.NODE_DEBUG;

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
// R1(2026-08-01 二审):对 common-dir 结果额外做 realpathSync 归一——macOS 的
// /var↔/private/var(以及类似的系统级符号链接)会让"相对路径拼出的绝对路径"与
// "git 自己吐出的绝对路径"字符串不同但指向同一个真实目录,字符串级哈希会把同一
// 仓库判成两个不同的 repoStateKey(锁/审计/去重身份分裂)。这是本 skill 多仓库
// 通用安装场景下会自然触发的真实风险,不是测试环境噪音。只加这一层 realpath,
// 不改其它判定逻辑。
function resolveStateAnchor() {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: REPO_ROOT, encoding: 'utf8', shell: isWin, timeout: 10_000,
    });
    const out = r.status === 0 ? (r.stdout ?? '').trim() : '';
    if (out) return realpathSync(resolve(REPO_ROOT, out)); // 主仓库返回相对 ".git",worktree 返回绝对路径,一律归一成绝对再 realpath
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
 * 主 worktree 根目录(F1,经 R7 二审、T2 三审两次重写)。状态根不能拼当前
 * checkout 的 REPO_ROOT——REPO_ROOT 可能是某一轮审查用的 linked worktree,
 * 按它算状态根会让同一仓库的不同 worktree/轮次各自写到不同目录,锁/审计/去重
 * 照样分裂(与上面 stateAnchor 要解决的问题同源)。
 *
 * 不用 `basename(git-common-dir) === '.git'` 判断(一审的实现):这条对
 * submodule 必然失败——submodule 的 common-dir 形如
 * `<父仓库>/.git/modules/<name>`,basename 是 `<name>` 不是 `.git`,会被无条件
 * 打回系统临时目录。改用 `git worktree list --porcelain`:多条记录(真正存在
 * linked worktree)时取**第一条**——git 保证主 worktree 永远排第一(不管从
 * 主 worktree 还是任意 linked worktree 跑这条命令,结果一致);只有一条记录时
 * 改用 `--show-toplevel`——实测(git 2.50.1)对没有任何 `worktree add` 记录
 * 的仓库(包括 submodule),`worktree list --porcelain` 的自报路径存在已知
 * 偏差:submodule 场景下会报成它自己的 git-dir 而不是真实工作目录。
 *
 * T2(2026-08-01 四审):上面这套"多条记录就信第一条"仍不够——submodule 自己
 * 又被 `worktree add` 出一个 linked worktree、或 `git init
 * --separate-git-dir` 配合 linked worktree,porcelain 的**第一条**依然会报
 * 成 git-dir 本身(实测:即使此时确有 2 条记录)。无法只靠"记录数"区分可信/
 * 不可信,必须对拿到的候选路径做两项独立验证,任一不过就 fail-closed(submodule
 * 持久化能力让路给安全,不做更复杂的补救):
 *   ① 候选路径不能等于、也不能落在 `stateAnchor`(REPO_ROOT 的 canonical
 *      common-dir,已在上面 realpath 归一)之内——候选若是 git 元数据目录
 *      本身或其子目录,这里会命中;
 *   ② 对候选路径本身跑 `rev-parse --show-toplevel`,结果必须成功且正好等于
 *      候选路径自己——git-dir 被误当候选时,这条命令要么报错("must be run in
 *      a work tree",separate-git-dir 场景实测如此),要么通过 core.worktree
 *      解析出一个完全不同的路径(submodule 场景实测如此),两种情况都通不过
 *      这个自证检查。
 *
 * 裸仓库的首条记录会带一行 `bare` 标记(没有真正的工作目录)——命中即返回
 * null。命令本身失败(非 git 仓库、git 不可用)也返回 null。调用方回退系统
 * 临时目录。
 */
function resolveMainWorktreeRoot() {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: REPO_ROOT, encoding: 'utf8', shell: isWin, timeout: 10_000,
  });
  if (r.status !== 0) return null;
  const lines = (r.stdout ?? '').split('\n');
  const blocks = [];
  let cur = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);
  if (!blocks.length) return null;

  const firstBlock = blocks[0];
  if (firstBlock.some((l) => l.trim() === 'bare')) return null; // 裸仓库,没有真正的工作目录

  let rawPath;
  if (blocks.length === 1) {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: REPO_ROOT, encoding: 'utf8', shell: isWin, timeout: 10_000,
    });
    rawPath = top.status === 0 ? (top.stdout ?? '').trim() : '';
  } else {
    const worktreeLine = firstBlock.find((l) => l.startsWith('worktree '));
    rawPath = worktreeLine ? worktreeLine.slice('worktree '.length).trim() : '';
  }
  if (!rawPath) return null;

  let candidate;
  try {
    candidate = realpathSync(rawPath); // R1 同款 realpath 归一,消解符号链接身份分裂
  } catch {
    return null;
  }

  // T2 校验①:候选不能等于/落在 common-dir 内(git 元数据本身)。
  if (stateAnchor !== REPO_ROOT) {
    const relToCommonDir = relative(stateAnchor, candidate);
    if (relToCommonDir === '' || (!relToCommonDir.startsWith('..') && !isAbsolute(relToCommonDir))) return null;
  }

  // T2 校验②:候选必须能自证是工作树顶层——对候选本身跑 show-toplevel,结果要
  // 正好等于候选自己。
  const selfCheck = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: candidate, encoding: 'utf8', shell: isWin, timeout: 10_000,
  });
  if (selfCheck.status !== 0) return null;
  let selfTop;
  try {
    selfTop = realpathSync((selfCheck.stdout ?? '').trim());
  } catch {
    return null;
  }
  if (selfTop !== candidate) return null;

  return candidate;
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

/**
 * cwd 相对某个 git 工作树的三态判定(R3,2026-08-01 二审)。一审版本把"git 命令
 * 本身判断不了"(spawn 失败/超时/权限问题/意外退出码)与"确认不在工作树内"
 * 混为一谈,统一按 false(=outside)处理——等价于对"判断不了"的情况 fail-open
 * 放行,与这套改动"宁可回退 tmpdir、绝不冒险"的总原则相反。现在明确三态:
 *   'inside'  — 确认在工作树内(status 0, stdout 'true');
 *   'outside' — 确认不在任何工作树内(git 明确报 "not a git repository",
 *               或 status 0 且 stdout 'false' — 在 .git 目录内但非工作树部分);
 *   'unknown' — 无法判定(spawn 失败/ENOENT/超时/权限问题/其它未预期的退出码
 *               或输出)——调用方必须把 unknown 当不安全处理,不能当 outside。
 */
function probeGitWorkTreeState(cwd) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd, encoding: 'utf8', shell: isWin, timeout: 10_000,
  });
  if (r.error) return 'unknown'; // spawn 层失败(git 不在 PATH、超时等)
  if (r.status === 0) {
    const out = (r.stdout ?? '').trim();
    if (out === 'true') return 'inside';
    if (out === 'false') return 'outside';
    return 'unknown'; // 意外输出,不猜测
  }
  if (r.status === 128 && /not a git repository/i.test(r.stderr ?? '')) return 'outside';
  return 'unknown'; // 其它退出码(权限问题等)一律归 unknown,fail-closed
}

/**
 * F2①:该路径是否可以安全写入而不弄脏某个 git working tree(R3 二审:三态
 * fail-closed)。
 *   - 确认不在任何 git 工作树内('outside')→ 没有"脏树"这个概念,视为安全;
 *   - 确认在工作树内('inside')→ 必须被该仓库的 `.gitignore` 覆盖
 *     (`git check-ignore -q` exit 0)才安全,check-ignore 本身失败(spawn 错误 /
 *     非 0/1 的退出码)一律按不安全处理;
 *   - 无法判定('unknown')→ 直接按不安全处理,回退系统临时目录——判不了就不能
 *     当作"没问题"放行。
 * cwd 用路径本身最近的已存在祖先目录——路径可能尚不存在(如首次落盘前)。
 */
function isSafeFromDirtyWorkingTree(candidatePath) {
  const cwd = nearestExistingAncestor(candidatePath);
  const state = probeGitWorkTreeState(cwd);
  if (state === 'unknown') return false;
  if (state === 'outside') return true;
  const r = spawnSync('git', ['check-ignore', '-q', candidatePath], { cwd, shell: isWin, timeout: 10_000 });
  if (r.error) return false;
  return r.status === 0;
}

/** 拿 cwd 所在仓库的 canonical 身份(git-common-dir 的 realpath);取不到返回 null。 */
function canonicalRepoIdentity(cwd) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd, encoding: 'utf8', shell: isWin, timeout: 10_000,
  });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? '').trim();
  if (!out) return null;
  try {
    return realpathSync(resolve(cwd, out));
  } catch {
    return null;
  }
}

/**
 * F2②:拒绝状态根落在 Skill 自身仓库内(防自写,R2 二审修订)。一审版本比较
 * 的是"worktree 的文件系统根路径"(`git rev-parse --show-toplevel` 的
 * realpath)——Skill 仓库若存在另一个 linked worktree(如本次改动本身就跑在
 * 这样一个 worktree 里),候选路径落在那个 worktree 下时,文件系统根路径比对
 * 完全不同,门形同虚设。现在比较双方的 canonical 仓库身份(git-common-dir 的
 * realpath)——同一仓库的所有 worktree 共享同一个 common-dir,不管候选路径
 * 落在哪个 worktree 下都能正确识别为"同一个 skill 仓库"。
 */
function isInsideSkillRepo(candidatePath) {
  const info = skillRepoInfo();
  if (!info) return false; // Skill 不在任何 git 仓库内,没有"自写"这个风险
  const skillIdentity = canonicalRepoIdentity(info.gitRoot);
  if (!skillIdentity) return false;
  const ancestor = nearestExistingAncestor(resolve(candidatePath));
  const candidateIdentity = canonicalRepoIdentity(ancestor);
  if (!candidateIdentity) return false; // 候选路径不在任何 git 仓库内,不可能是 skill 仓库
  return candidateIdentity === skillIdentity;
}

/**
 * F3/R4:写文件 + 删除的真实探针。mkdir 成功不代表可写(某些只读文件系统对
 * 已存在目录的 mkdir 直接成功,真正写文件才报错);unlink 失败同样必须判定
 * "不可用"——锁文件(`release-lock.mjs`/`cleanup.mjs`)的整个生命周期依赖
 * unlink 成功,一个只能创建/写入但删不掉文件的目录会让锁永久卡死,不是可用
 * 的状态根。
 */
function writeProbeOk(dir) {
  const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, '');
  } catch {
    return false;
  }
  try {
    unlinkSync(probe);
  } catch {
    return false;
  }
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
// 只读模式(REVIEW_PR_LIB_READONLY=1,SC-D 2026-08-04 复审修订):pre-check --probe-only
// 在 import 本模块**之前**置此环境变量。此前模块加载期就有三类写副作用——写探针
// (writeProbeOk)、mkdirSync(STATE_DIR)、legacy 迁移(migrateLegacyStateIfNeeded)——
// "probe-only 零本地状态写"的承诺在 import 层就已破产。只读模式下:
//   - 状态根解析不做写探针/mkdir,只做两条只读安全谓词(工作树/skill 仓);
//   - 不建目录、不迁移;STATE_DIR 只用于**读**(锁文件/scan state),目录不存在时读
//     自然失败 → 调用方按"查不了≠没活"fail-open,方向与 pre-check 既有契约一致;
//   - 解析结果可能与写模式不同(写模式下写探针失败会回退 LEGACY),后果同样只是
//     probe 读不到锁/state → 多放行一轮,不会漏写任何生产状态。
const LIB_READONLY = process.env.REVIEW_PR_LIB_READONLY === '1';

function isStateRootUsableReadOnly(root) {
  return isSafeFromDirtyWorkingTree(root) && !isInsideSkillRepo(root);
}

function resolvePersistentStateRoot() {
  if (LIB_READONLY) {
    if (process.env.REVIEW_PR_STATE_DIR) {
      const envRoot = resolve(process.env.REVIEW_PR_STATE_DIR);
      return isStateRootUsableReadOnly(envRoot) ? envRoot : LEGACY_STATE_ROOT;
    }
    const mainRoot = resolveMainWorktreeRoot();
    if (mainRoot) {
      const repoBased = join(mainRoot, 'history', 'loops', 'review-pr', 'state');
      if (isStateRootUsableReadOnly(repoBased)) return repoBased;
    }
    return LEGACY_STATE_ROOT;
  }
  if (process.env.REVIEW_PR_STATE_DIR) {
    const envRoot = resolve(process.env.REVIEW_PR_STATE_DIR);
    if (isStateRootSafeAndWritable(envRoot)) return envRoot;
    process.stderr.write(
      `[review-pr] REVIEW_PR_STATE_DIR=${envRoot} 未通过校验(工作树状态无法判定 / ` +
      '未被 .gitignore 忽略 / 落在 Skill 自身仓库内 / 写探针失败),回退系统临时目录\n',
    );
    return LEGACY_STATE_ROOT;
  }
  const mainRoot = resolveMainWorktreeRoot();
  if (mainRoot) {
    const repoBased = join(mainRoot, 'history', 'loops', 'review-pr', 'state');
    if (isStateRootSafeAndWritable(repoBased)) return repoBased;
    process.stderr.write(
      `[review-pr] 默认状态根 ${repoBased} 未通过校验(工作树状态无法判定 / ` +
      '未被 .gitignore 忽略 / 落在 Skill 自身仓库内 / 写探针失败),回退系统临时目录\n',
    );
  }
  return LEGACY_STATE_ROOT;
}

const stateRoot = resolvePersistentStateRoot();
export const STATE_DIR = join(stateRoot, repoStateKey);
if (!LIB_READONLY) mkdirSync(STATE_DIR, { recursive: true });

const MIGRATION_MARKER = '.migrated-from-tmp.json';

/**
 * 一次性迁移(F4,2026-08-01 一审修订;R5 二审补充目标类型冲突检测;T1 四审
 * 补充悬空 symlink 与检查-复制竞态修复)。判据改为"marker 是否存在"而不是
 * "新目录有没有 runs.jsonl"——旧判据在部分失败场景下会永久卡死(第一次迁移
 * 复制完 runs.jsonl 后在其他文件上失败,marker 没写;下一次调用因为 runs.jsonl
 * 已经"看起来存在"而直接跳过,永远补不齐剩下的文件)。现在:
 *   - 触发条件只看 marker 是否存在,marker 不存在就总会重试;
 *   - 逐文件 no-clobber:目标已存在的文件跳过不覆盖——保证即使本轮已经产生了
 *     真实的新数据(如 runs.jsonl 已被新一轮 review 追加过),重试迁移也绝不会
 *     用旧 tmpdir 里更早、更小的版本覆盖回去;
 *   - T1:判断"目标是否已存在"**不用 `existsSync` 前置**——`existsSync` 会跟随
 *     符号链接,对**悬空 symlink**(链接目标不存在)返回 `false`,导致误判成
 *     "目标不存在"从而继续走复制;`copyFileSync` 沿着这个悬空链接写入会把
 *     legacy 内容写到状态根之外的任意路径(实测复现)。直接 `lstatSync`(不
 *     跟随链接):`ENOENT` 才是"确实不存在";只要 lstat 成功,不管是普通文件、
 *     目录、还是(悬空与否的)symlink,都当"已存在"处理,只有普通文件算
 *     "已迁移完成、可跳过",其余(含任何 symlink)一律按类型冲突处理——
 *     和 R5 的判定合一,不再需要先 `existsSync` 短路;
 *   - T1:实际复制用 `COPYFILE_EXCL` 排他创建——`lstatSync` 检查和 `copyFileSync`
 *     复制之间仍有微小窗口,任何东西(并发进程、新出现的符号链接)在这期间
 *     抢先在目标位置落地,`EXCL` 会让复制原子性地失败(`EEXIST`)而不是沿着
 *     新出现的东西写,不依赖"检查时看到的状态在复制时还成立"这个假设;
 *   - 目标存在但不是普通文件(目录/symlink/其它类型),或 lstat/复制本身因
 *     非 `ENOENT` 原因失败,都记 warning、**不写 marker**,保住下次重试的
 *     机会(不会被静默当成"已完成");
 *   - 只有这一轮没有任何类型冲突、且把 legacy 目录里的每个文件都处理完
 *     (拷贝成功或因目标已确认是普通文件而跳过)才写 marker,且 marker 用
 *     临时文件 + rename 落盘(同文件系统下 rename 是原子操作)——marker 存在
 *     ⇔ 迁移已完整跑完,不会出现"半完成但已标记完成"的中间态,迁移失败
 *     (权限/磁盘等)只记 stderr warning、不阻断,下次调用会自动重试补齐。
 */
function migrateLegacyStateIfNeeded() {
  if (stateRoot === LEGACY_STATE_ROOT) return; // 新旧根相同,无需迁移
  const legacyDir = join(LEGACY_STATE_ROOT, repoStateKey);
  const marker = join(STATE_DIR, MIGRATION_MARKER);
  if (existsSync(marker) || !existsSync(legacyDir)) return;
  try {
    let hasConflict = false;
    for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === MIGRATION_MARKER) continue;
      const dest = join(STATE_DIR, entry.name);

      let destStat = null;
      try {
        destStat = lstatSync(dest); // 不跟随符号链接;悬空 symlink 在这里会正常返回(报告的是链接本身)
      } catch (e) {
        if (e.code !== 'ENOENT') {
          hasConflict = true;
          process.stderr.write(`[review-pr] 迁移目标 ${dest} 类型无法确认(${e.message}),按冲突处理,保留重试机会\n`);
          continue;
        }
        // ENOENT = 确实不存在,继续往下走复制路径(destStat 保持 null)
      }
      if (destStat) {
        if (!destStat.isFile()) {
          hasConflict = true;
          const kind = destStat.isDirectory() ? '目录' : destStat.isSymbolicLink() ? 'symlink(可能悬空)' : '其它类型';
          process.stderr.write(`[review-pr] 迁移目标 ${dest} 已存在但不是普通文件(${kind}),视为冲突,跳过并保留重试机会\n`);
        }
        continue; // 无论"已完成"(普通文件)还是"冲突",都不覆盖已存在的目标
      }

      try {
        copyFileSync(join(legacyDir, entry.name), dest, fsConstants.COPYFILE_EXCL);
      } catch (e) {
        hasConflict = true;
        process.stderr.write(`[review-pr] 迁移目标 ${dest} 复制时被抢先占用或失败(${e.message}),视为冲突,跳过并保留重试机会\n`);
      }
    }
    if (hasConflict) return; // R5/T1:冲突未消除就不写 marker,下次调用会重新检查
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
if (!LIB_READONLY) migrateLegacyStateIfNeeded();

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
 * 拉 head commit 上「所有已上报检查」的 isRequired 标注(IO 函数,非纯函数——发 GraphQL
 * 网络请求;只读,best-effort)。gh 的 `--json statusCheckRollup` 模板不带 isRequired
 * 字段(仅 classifyStatusRollup 消费的那份没有),必须单独发一次 GraphQL 查
 * `isRequired(pullRequestNumber:)`——这是 CheckRun / StatusContext 都实现的字段,用来把
 * 「required 检查全绿」与「非 required 检查失败但不阻断」精确区分开(授权快速合并通道
 * 的 CI 口径,见 findApproveMergeAuthorization 与 SKILL 5.1)。只在真的有候选授权评论时
 * 才调用(省 API):批量扫描几十个 PR 时,绝大多数没人发过 `/approve-merge`,不值得每条
 * 都多打一次 GraphQL。
 *
 * P1-3(2026-08-02)完整分页:`contexts` 用 `first:100` 单页曾经只取前 100 条,若某 PR
 * 的已上报检查超过 100 条(大型 monorepo 常见),第 101 条起会静默丢失——若那条恰好是
 * required 且 FAILURE,调用方会误判"没看到失败=全绿"。改用 `pageInfo{hasNextPage
 * endCursor}` 循环取全;**任一页读取异常或声称有下一页却拿不到 cursor,整体返回 null**
 * (fail-closed,不返回"读到一半"的部分结果——部分结果如果被当作"完整集合"消费,后面
 * 没读到的页面里若有失败检查,会被误判为不存在,这与只查 100 条的老问题是同一类风险,
 * 只是边界从 100 挪到了"读取中断的那一页",治标不治本)。
 */
export function fetchHeadCheckContexts({ owner, repo, pr }) {
  const buildQuery = (withCursor) => `
    query($owner:String!,$repo:String!,$num:Int!${withCursor ? ',$cursor:String!' : ''}){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$num){
          commits(last:1){ nodes{ commit{
            statusCheckRollup{
              contexts(first:100${withCursor ? ',after:$cursor' : ''}){
                nodes{
                  __typename
                  ... on CheckRun { name status conclusion isRequired(pullRequestNumber:$num) }
                  ... on StatusContext { context state isRequired(pullRequestNumber:$num) }
                }
                pageInfo{ hasNextPage endCursor }
              }
            }
          }}}
        }
      }
    }`;
  const allNodes = [];
  let cursor = null;
  const MAX_PAGES = 50; // 5000 条检查的硬上限,纯防御性,真实仓库远不会到这个量级
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const vars = { owner, repo, num: pr, ...(cursor ? { cursor } : {}) };
      const data = ghGraphql(buildQuery(cursor != null), vars, { timeoutMs: 30_000 })?.data;
      const contexts = data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
      const nodes = contexts?.nodes;
      if (!Array.isArray(nodes)) return null; // 本页读不出 nodes → 整体判未知,不返回部分结果
      allNodes.push(...nodes);
      if (!contexts?.pageInfo?.hasNextPage) return allNodes; // 正常结束,拿到完整集合
      if (!contexts.pageInfo.endCursor) return null; // 声称还有下一页但给不出 cursor,异常,视为读取失败
      cursor = contexts.pageInfo.endCursor;
    }
    return null; // 超过硬上限仍未结束(真实场景不会发生)——不敢说读全了,fail-closed
  } catch {
    return null;
  }
}

/**
 * 解析 HTTP `Link` header(RFC 5988,GitHub REST 分页用它标 rel="next"/"last")。
 * 纯函数,便于单测。返回 `{ next?, last?, ... }` 的 rel→url 映射,读不出结构时返回
 * 空对象(不抛错——调用方按"没有 next"处理,即视为已到最后一页)。
 */
export function parseLinkHeader(headerValue) {
  const links = {};
  if (!headerValue) return links;
  for (const part of headerValue.split(',')) {
    const m = part.trim().match(/^<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (m) links[m[2]] = m[1];
  }
  return links;
}

/**
 * 单页 REST 数组端点拉取(IO,非纯函数——发 `gh api <url> -i` 网络请求,`-i` 带上响应头
 * 才能读到 `Link`)。拆出响应头与 body,解析出 `rel="next"` 的下一页 URL(GitHub 返回的
 * 是绝对 URL,`gh api` 可直接接受,不需要再拼 owner/repo)。任一环节失败(请求失败/找不到
 * 头体分隔符/body 不是 JSON 数组)返回 `null`。
 */
function fetchRestArrayPage(url) {
  const r = gh(['api', url, '-i'], { allowFail: true, timeoutMs: 30_000 });
  if (!r.ok) return null;
  const sepIdx = r.stdout.indexOf('\r\n\r\n');
  if (sepIdx === -1) return null;
  const headerBlock = r.stdout.slice(0, sepIdx);
  const bodyText = r.stdout.slice(sepIdx + 4);
  let body;
  try {
    body = JSON.parse(bodyText || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(body)) return null;
  const linkLine = headerBlock.split('\r\n').find((l) => /^link:/i.test(l));
  const links = linkLine ? parseLinkHeader(linkLine.slice(linkLine.indexOf(':') + 1)) : {};
  return { body, nextUrl: links.next ?? null };
}

/**
 * 完整遍历一个 REST 数组端点的所有分页(Link header 分页;P1-1,2026-08-02 二审修复)。
 * 此前 `fetchExpectedRequiredContexts` / `probeBranchProtection` 都只读第一页——mivo
 * 实测 `GET /repos/{slug}/rules/branches/{branch}` 端点确实会分页(Link `page=9
 * rel="last"`),规则落在第 2 页起就会静默丢失,与刚修的 GraphQL `contexts` 分页
 * (P1-3 首轮)是同一类 bug,只是出现在 REST 侧、上一轮漏改。
 *
 * `fetchPage` 参数供单测注入(构造"规则落在第 N 页"/"中途页失败"场景,不必真的发
 * 网络请求),默认调用真实 `gh api`。**任一页失败(`fetchPage` 返回 null)整体返回
 * null,不返回部分结果**——部分结果如果被当作"读全了"消费,后面没读到的页面里若有
 * 目标规则，会被误判为不存在，这正是本次要修的静默丢失。
 */
export function fetchAllRestPages(startUrl, { fetchPage = fetchRestArrayPage, maxPages = 50 } = {}) {
  const all = [];
  let url = startUrl;
  for (let i = 0; i < maxPages; i++) {
    const page = fetchPage(url);
    if (!page) return null;
    all.push(...page.body);
    if (!page.nextUrl) return all;
    url = page.nextUrl;
  }
  return null; // 超过硬上限仍未结束(真实场景不会发生)，fail-closed，不敢说读全了
}

/**
 * 读取分支保护 `required_status_checks` 规则要求的完整 context 名单(IO 函数,非纯
 * 函数——发 REST 网络请求;只读,best-effort;P1-3,2026-08-02)。用于弥补
 * `classifyRequiredChecks` 单看 `contexts` 的盲区:一条必需检查如果从未开始跑(工作流
 * 触发条件没命中、还没创建 check-run 等),就根本不会出现在 `fetchHeadCheckContexts` 的
 * 结果里——既不在 failed 也不在 pending,单看 contexts 会误判"没有已知问题"=全绿。本
 * 函数给出"这条分支到底要求哪些 context 上报"的权威名单,供调用方与实际观测到的
 * context 集合做差,缺失的一律按 pending(未上报≠绿)处理。分页遍历见
 * `fetchAllRestPages`(P1-1 二审修复:此前只读一页)。
 *
 * 返回 `Set<string>`(可能为空集合——这是唯一允许"没有 required_status_checks 类型规则"
 * 结论的凭证,因为端点确实读到了、只是没有这类规则)或 `null`(端点读取失败/解析失败/
 * 任一分页失败,fail-closed,调用方不得当"无要求"处理)。与 probeBranchProtection 共用
 * 同一个端点(`GET /repos/{slug}/rules/branches/{branch}`),但目的不同:后者判"结构性
 * 门是否已满足"(context 满足即从 requiredCheckRules 剔除该规则,不算 blocker);本函数
 * 只给"要求了哪些 context",不做满足性判断。第三参 `opts`(如 `{ fetchPage }`)供单测
 * 注入,透传给 `fetchAllRestPages`。
 */
export function fetchExpectedRequiredContexts(slug, branch, opts = {}) {
  if (!branch) return null;
  const rules = fetchAllRestPages(`repos/${slug}/rules/branches/${encodeURIComponent(branch)}?per_page=100`, opts);
  if (!Array.isArray(rules)) return null;
  try {
    const names = new Set();
    for (const r of rules) {
      if (r?.type !== 'required_status_checks') continue;
      for (const c of r.parameters?.required_status_checks ?? []) {
        if (typeof c?.context === 'string' && c.context !== '') names.add(c.context);
      }
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * 把 fetchHeadCheckContexts 的原始节点分成 required / 非 required 两条轨,每条再分
 * failed / pending(纯函数,便于单测)。required 检查从不上报(如 structural-check 场景
 * 里真空的 code_scanning/code_quality)时,该检查根本不会出现在 contexts 里——既不在
 * failed 也不在 pending,视为「没有已知问题」,与「required 检查全绿即可合」的口径一致
 * (授权快速合并通道正是为解这类场景设计的,见 SKILL 5.1「授权快速合并通道」)。
 * nodes 非数组(读取失败)返 null——调用方必须按「未知」处理,不得当「全绿」放行。
 *
 * P1-3(2026-08-02)required 完整性:可选第二参 `expectedRequiredNames`
 * (`fetchExpectedRequiredContexts` 的返回值,`Set<string>`)——传入时,任何"要求了但从未
 * 出现在 nodes 里"的 context 名一律追加进 `requiredPending`(未上报≠绿,不能默认放行,
 * 这正是"required 检查从不上报=没有已知问题"这条既有口径的盲区:该检查从未开始跑时,
 * 单看 nodes 同样看不出问题,但它跟 code_scanning/code_quality 这类"结构性地从不产生
 * 结果"不是一回事——它本该跑,只是没跑,必须当"还没绿"处理)。不传(`null`/未提供)时
 * 行为与此前完全一致,不做完整性核验——调用方(context.mjs / pre-merge-check.mjs)必须
 * 显式传入,且 `fetchExpectedRequiredContexts` 返回 `null` 时应把整体结果视为
 * unreadable(参见两处调用点的组合逻辑),不能悄悄跳过完整性核验。
 */
export function classifyRequiredChecks(nodes, expectedRequiredNames = null) {
  if (!Array.isArray(nodes)) return null;
  const FAIL_RUN = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  const OK_RUN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const requiredFailed = [];
  const requiredPending = [];
  const nonRequiredFailed = [];
  const nonRequiredPending = [];
  const requiredSeen = new Set(); // 无论 ok/failed/pending,只要是 required 且真的出现过就记录
  for (const c of nodes ?? []) {
    const name = c?.name ?? c?.context ?? '(unnamed check)';
    const required = c?.isRequired === true;
    if (required) requiredSeen.add(name);
    let bucket;
    if (c?.state != null) {
      if (c.state === 'FAILURE' || c.state === 'ERROR') bucket = 'failed';
      else if (c.state !== 'SUCCESS') bucket = 'pending';
      else bucket = 'ok';
    } else if (c?.status !== 'COMPLETED') {
      bucket = 'pending';
    } else if (FAIL_RUN.has(c?.conclusion)) {
      bucket = 'failed';
    } else if (!OK_RUN.has(c?.conclusion)) {
      bucket = 'pending';
    } else {
      bucket = 'ok';
    }
    if (bucket === 'failed') (required ? requiredFailed : nonRequiredFailed).push(name);
    else if (bucket === 'pending') (required ? requiredPending : nonRequiredPending).push(name);
  }
  if (expectedRequiredNames instanceof Set) {
    for (const name of expectedRequiredNames) {
      if (!requiredSeen.has(name)) requiredPending.push(name); // 要求了但从未出现在 nodes 里 → 未上报,不能当绿
    }
  }
  return { requiredFailed, requiredPending, nonRequiredFailed, nonRequiredPending };
}

/**
 * 规范化配置里的"登录名清单"字段(admins 等;P2-3,2026-08-02):Array.isArray 校验 +
 * 过滤非空字符串 + 统一 trim + 小写。非法形态(整体非数组,或数组内混入非字符串/空
 * 字符串)一律不抛 TypeError——静默按"能用的部分"处理,并显式给出 `invalid=true` 供
 * 调用方在报告里显著告警"admins 配置形态不合法",不能因为配置写错就让脚本崩掉,也
 * 不能悄悄吞掉这个信号让 owner 以为配置是对的。未配置(null/undefined)是正常默认,
 * 不算 invalid。三处消费点(context.mjs 的 ADMINS、pre-merge-check.mjs 的 ADMINS、
 * findApproveMergeAuthorization 内部的 adminSet)都必须走这一份,不许各自重新实现。
 * 返回 { logins: string[], invalid: boolean }。
 */
export function normalizeLoginList(value) {
  if (value == null) return { logins: [], invalid: false };
  if (!Array.isArray(value)) return { logins: [], invalid: true };
  const logins = [];
  let invalid = false;
  for (const v of value) {
    if (typeof v === 'string' && v.trim() !== '') logins.push(v.trim().toLowerCase());
    else invalid = true;
  }
  return { logins, invalid };
}

/**
 * 合并授权策略的单一解析函数(SC-1,2026-08-08):把 `mergeAuthorization` 配置里的两个
 * 新键解析成统一形状,context.mjs 与 pre-merge-check.mjs 共用,防两处判据漂移。
 *
 * 配置 Schema(pr-rules.json 的 mergeAuthorization 对象):
 *   - `requireAutomatedReviewForAutoMerge`(boolean,默认缺失=false):强制自动化审查
 *     策略开关。开启后,除人工 break-glass(/approve-merge)外,每一种自动合并 basis
 *     (ordinary / self-merge / structural approved / admin-trust)都必须绑定当前 head
 *     的 clean 阶段二回执——仅绿 CI 或 GitHub APPROVED 都不能单独放行(SC-2)。
 *   - `breakGlassApprovers`(string[]):人工 `/approve-merge <SHA>` 发令名单——只决定
 *     谁能发这条命令跳过阶段二独立审查,与 PR 作者是否在 `admins`(admin-trust 信任
 *     名单)无关。**拆分自 `admins`**(SC-1):授权快速合并通道不再与 admin-trust 共用
 *     同一份名单;`admins` 保留作结构性 BLOCKED 的 admin-trust 路由。
 *
 * 兼容期规则(未配置新字段的消费仓行为不被静默改变):
 *   - 未配置 `breakGlassApprovers`(null/undefined)→ 明确回退到 `admins` 名单并输出
 *     warning(旧仓 /approve-merge 行为不变;Mivo 显式配置后不再走回退)。
 *   - 已配置但形态非法(非数组 / 混入非字符串 / 空字符串)→ normalizeLoginList
 *     fail-closed 处理能用的部分,并输出 warning 显著告警(不抛错、不静默当空名单)。
 *   - `requireAutomatedReviewForAutoMerge` **键缺失**(mergeAuthorization 对象里没有
 *     这个键,或整个 mergeAuthorization 缺失)→ 兼容 false(旧仓行为不变,不告警);
 *     **键存在但值非 boolean**(null/string/number/object/undefined 等显式 malformed,
 *     null 按「显式写了但写错」算 malformed 而非缺失,因为键在配置里就占了一个位置)
 *     → fail-closed 按 true 处理(从安全方向强制自动化审查,绝不静默放宽成 false)
 *     并输出 warning 显著告警(审 A2,2026-08-08:此前 `'true'` 这类字符串会静默变
 *     false 且无任何 warning,结构性 approved 可免阶段二回执直接合——fail-open)。
 *
 * 容器级规则(审 C1,2026-08-08):`mergeAuthorization` 整体必须是 **plain object**。
 *   - 缺失 / null → 正常兼容默认,视为空对象(旧仓形态,行为不变:require=false;
 *     breakGlass 走回退 admins + warning)。
 *   - string/number/boolean/array/function 等非 plain object = **容器级 malformed**:
 *     此前 `'requireAutomatedReviewForAutoMerge' in <string>` 会抛 TypeError 把
 *     context/pre-merge 脚本整个打崩(exit1 + stack trace);数组虽不抛,却被静默
 *     当成合法对象消费字段、breakGlass 静默回退 admins 扩大发令名单(fail-open)。
 *     修复:必须不抛;整体 fail-closed,不消费畸形容器内任何字段——require 强制
 *     true(宁严勿松)、breakGlassApprovers 置 [] 且**不回退 admins**(回退会扩大
 *     /approve-merge 发令名单)、显著 warning 点名容器必须 object。
 *
 * 返回 `{ requireAutomatedReviewForAutoMerge: boolean, breakGlassApprovers: string[],
 *         warnings: string[] }`。
 */
export function resolveMergeAuthorizationPolicy(rules) {
  const warnings = [];
  const rawMergeAuth = rules?.mergeAuthorization;
  const isPlainObject = rawMergeAuth != null && typeof rawMergeAuth === 'object' && !Array.isArray(rawMergeAuth);
  if (!isPlainObject && rawMergeAuth != null) {
    // 容器级 malformed(整体 fail-closed):不读容器内任何字段,不给 breakGlass 回退
    // admins 的机会。缺失/null 不在这里——那是正常兼容默认,继续走下方字段规则。
    warnings.push(`mergeAuthorization 配置形态不合法(应为 object,实际为 ${Array.isArray(rawMergeAuth) ? 'array' : typeof rawMergeAuth})——容器级 fail-closed:requireAutomatedReviewForAutoMerge 按 true(强制自动化审查)、breakGlassApprovers 按 [] (不回退 admins 扩大权限),请检查配置`);
    return { requireAutomatedReviewForAutoMerge: true, breakGlassApprovers: [], warnings };
  }
  const mergeAuth = isPlainObject ? rawMergeAuth : {};
  // 存在性按 `in` 判(键真在对象里才算「存在」),缺失走兼容 false 不告警;
  // 存在但非 boolean → fail-closed 按 true(宁严勿松)+ 显著告警,禁止静默当 false。
  let requireAutomatedReviewForAutoMerge = false;
  if ('requireAutomatedReviewForAutoMerge' in mergeAuth) {
    const raw = mergeAuth.requireAutomatedReviewForAutoMerge;
    if (typeof raw !== 'boolean') {
      requireAutomatedReviewForAutoMerge = true;
      warnings.push('mergeAuthorization.requireAutomatedReviewForAutoMerge 配置形态不合法(应为 boolean,null/string/number/object 均不接受)——fail-closed 按 true 处理(强制自动化审查开启),请改为显式 true/false');
    } else {
      requireAutomatedReviewForAutoMerge = raw;
    }
  }
  let breakGlassApprovers = [];
  if (mergeAuth.breakGlassApprovers == null) {
    // 兼容期回退:未配置 → 沿用 admins 名单作为 /approve-merge 发令名单,显式告警
    // (SC-1 拆分后仍建议目标仓显式配置,否则发令名单与 admin-trust 名单继续混同)。
    const { logins } = normalizeLoginList(rules?.admins);
    breakGlassApprovers = logins;
    warnings.push('mergeAuthorization.breakGlassApprovers 未配置——兼容期回退到 admins 名单作为 /approve-merge 发令名单(SC-1:建议显式配置拆分,否则发令名单与 admin-trust 名单混同)');
  } else {
    const { logins, invalid } = normalizeLoginList(mergeAuth.breakGlassApprovers);
    breakGlassApprovers = logins;
    if (invalid) {
      warnings.push('mergeAuthorization.breakGlassApprovers 配置形态不合法(应为字符串数组,非法条目被过滤)——已按能用的部分处理,请检查配置');
    }
  }
  return { requireAutomatedReviewForAutoMerge, breakGlassApprovers, warnings };
}

const APPROVE_MERGE_COMMAND = '/approve-merge';

/**
 * 剔除 fenced code block(```/~~~ 围栏,含到文末仍未闭合的情况)、blockquote(`>` 开头)、
 * Markdown 缩进代码块(4 空格或 tab 开头)——这三类都是"展示/引用这条命令长什么样",不是
 * "下达这条命令"。逐行状态机,纯函数,内部用,配合 hasApproveMergeCommand 一起单测。
 *
 * P2-1(三审修复):此前用一次性正则 ```[\s\S]*?``` /~~~[\s\S]*?~~~ 匹配"已闭合"的围栏,
 * 有两个缺口:①未闭合到文末的围栏完全测不到,里面的内容会被当成普通文本继续扫描,
 * `/approve-merge` 写在一段"没写完的代码示例"里仍会被判成真下达;②完全不处理 4 空格/
 * tab 缩进代码块,同样的"展示"语境测不到。
 *
 * 四审修复:三审改成的逐行状态机只查了闭合标记的类型与长度,没查标记之后是否只跟
 * 空白——审核方实测反例:```` ```not-a-close ```` 这种"反引号后紧跟非空白文字"的行
 * 会被误判成有效闭合(CommonMark 规定闭合围栏标记后只能跟空格/tab,否则不构成闭合)。
 * 改为与 CommonMark 一致:围栏识别做类型 + 长度 + 闭合标记后仅空白 三重匹配——反引号
 * 围栏只能被反引号闭合、波浪号围栏只能被波浪号闭合,闭合标记长度必须 >= 开启标记长度,
 * 且闭合标记后除空格/tab 外不能有其它字符;否则不构成闭合,围栏内容会提前"暴露"成
 * 候选命令行(fail-open 风险,不只是正确性瑕疵)。开启标记同样限制前导缩进 0-3 空格
 * (与 CommonMark 一致;4 空格起属缩进代码块,不是围栏,交给下面的缩进代码块分支处理)。
 */
function stripFencedAndQuoted(body) {
  const lines = (body ?? '').split('\n');
  const kept = [];
  let fenceChar = null; // null = 不在围栏内;否则是 '`' 或 '~'
  let fenceLen = 0;
  for (const line of lines) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (m) {
      const [, marker, trailing] = m;
      const char = marker[0];
      const len = marker.length;
      if (fenceChar === null) {
        fenceChar = char;
        fenceLen = len;
        continue;
      }
      const isValidClose = char === fenceChar && len >= fenceLen && /^[ \t]*$/.test(trailing);
      if (isValidClose) {
        fenceChar = null;
        fenceLen = 0;
        continue;
      }
      // 类型/长度不匹配,或闭合标记后还有非空白内容——不构成闭合,仍是围栏内部的一行,
      // 走下面"仍在围栏内"分支跳过。
    }
    if (fenceChar !== null) continue; // 围栏内部(含未闭合到文末),整段跳过
    if (/^\s*>/.test(line)) continue; // blockquote
    if (/^(?: {4}|\t)/.test(line)) continue; // Markdown 缩进代码块
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * 判定一段评论正文是否真的"下达"了 `/approve-merge` 命令(纯函数,便于单测;P1-6,
 * 2026-08-02 owner 裁决收紧,推翻此前"允许行内追加说明"的裁决——被审核方实例证伪:
 * 允许行内文字会把"我觉得可以发 /approve-merge 了,但再看一眼"这类**讨论**命令的句子
 * 误判成**下达**命令)。口径:先剔除 fenced code block 与 blockquote(展示/引用不算
 * 下达),剩余每一行 trim 后必须**精确等于** `/approve-merge`(大小写敏感,不含任何
 * 行内追加说明)才算命中。
 */
export function hasApproveMergeCommand(body) {
  return stripFencedAndQuoted(body)
    .split('\n')
    .some((line) => line.trim() === APPROVE_MERGE_COMMAND);
}

/**
 * head 绑定授权命令的解析(SC-A,2026-08-04):`/approve-merge <完整 40 位 head SHA>`,
 * 独占一行(同 stripFencedAndQuoted 剔除展示语境)。返回命中的 sha(小写)数组。
 *
 * 为什么改 head 绑定、废除 pushedDate 时效判定:旧判定依赖 `Commit.pushedDate` +
 * `HeadRefForcePushedEvent.createdAt` 的"授权须晚于最后真实 push"。实测(2026-08-04,
 * mivo-canvas #469)`Commit.pushedDate` 已被 GitHub schema 标为不再支持、12 个 commit
 * 全部返回 null——无 force-push 的普通 PR 上 latestPushDate 恒为空串,isFresh 恒 false,
 * 全部授权被误判 stale;反之有旧 force-push 后再普通 push,旧 force 时间可能早于授权,
 * 造成"之后又推了代码的旧授权"被误判 fresh。SHA 绑定不依赖任何时间戳:授权只对点名的
 * 那个 head 生效,push 换 head 即天然作废,重发须带新 SHA。
 * 旧裸格式 `/approve-merge`(不带 SHA)不再构成授权(breaking change,owner 2026-08-04
 * 知情拍板),由调用方经 `legacyBare` 报告提醒重发。
 */
export function parseApproveMergeShaCommands(body) {
  return stripFencedAndQuoted(body)
    .split('\n')
    .map((line) => line.trim().match(/^\/approve-merge ([0-9a-fA-F]{40})$/))
    .filter(Boolean)
    .map((m) => m[1].toLowerCase());
}

/**
 * 授权快速合并通道的确定性检测(纯函数,便于单测;见 SKILL 5.1「授权快速合并通道」)。
 * `breakGlassApprovers` 名单成员(大小写不敏感)在 PR 评论里发出 `/approve-merge <完整
 * head SHA>`(判定口径见 `parseApproveMergeShaCommands`)= 人工已过安全与代码审查的明确
 * 授权。
 * 安全边界:
 *   - 机器人自己发的评论不算(comments 数组的 isBot 已由调用方标注);
 *   - `breakGlassApprovers` 缺失/为空/非法形态 → adminsConfigured=false,authorized 恒为
 *     null(fail-closed);
 *   - 已编辑的评论不算(`updatedAt !== createdAt` → `edited`,要求重发);
 *   - **授权绑定 head SHA**(SC-A,2026-08-04):命令里的 SHA 必须精确等于当前 `headRefOid`
 *     才有效;不等(之后又推了新 commit / force-push 换了 head)计入 `stale`,需对新 head
 *     重发。headRefOid 缺失/非法 → 全部判 stale(fail-closed)。不再使用 pushedDate 时效
 *     判定(该数据源已实测失效,见 parseApproveMergeShaCommands 注释);
 *   - 旧裸格式 `/approve-merge` 计入 `legacyBare`,不构成授权,调用方应提醒重发。
 * `comments` 是已映射过的评论数组(`{ author, isBot, createdAt, updatedAt, url, body }`)。
 *
 * SC-1(2026-08-08):授权名单与 `admins`(admin-trust 信任名单)解耦——`breakGlassApprovers`
 * 是紧急通道的唯一授权名单,context.mjs / pre-merge-check.mjs 只传策略解析出的
 * `resolveMergeAuthorizationPolicy().breakGlassApprovers`。兼容期(裁决):`breakGlassApprovers`
 * 未提供(null/undefined)时回退到 `admins` 参数(与策略层"字段缺失回退 admins"同口径),
 * 显式 `[]` 才是"关闭紧急通道"。`adminsConfigured` 字段名保留(表示"授权名单已配置且非空")。
 */
export function findApproveMergeAuthorization({ comments, breakGlassApprovers, admins, headRefOid }) {
  // 兼容期回退:未显式传入授权名单 → 沿用 admins(旧调用点/旧测试不因改名受伤;
  // 与 resolveMergeAuthorizationPolicy 的缺失回退语义一致)。
  const effectiveList = breakGlassApprovers == null ? (admins ?? []) : breakGlassApprovers;
  const { logins: adminLogins } = normalizeLoginList(effectiveList);
  const adminSet = new Set(adminLogins);
  if (adminSet.size === 0) return { adminsConfigured: false, authorized: null, stale: [], edited: [], legacyBare: [] };
  const eligible = (comments ?? []).filter((c) => !c.isBot && adminSet.has((c.author ?? '').toLowerCase()));
  const isEdited = (c) => c.updatedAt != null && c.createdAt != null && c.updatedAt !== c.createdAt;
  // 旧裸格式:仍识别但不授权,单独报告让发令者重发带 SHA 的新格式(不静默吞掉人的意图)。
  const legacyBare = eligible
    .filter((c) => hasApproveMergeCommand(c.body ?? '') && parseApproveMergeShaCommands(c.body ?? '').length === 0)
    .map((c) => ({ author: c.author, createdAt: c.createdAt, url: c.url }));
  const commandHits = eligible
    .map((c) => ({ c, shas: parseApproveMergeShaCommands(c.body ?? '') }))
    .filter(({ shas }) => shas.length > 0);
  const edited = commandHits
    .filter(({ c }) => isEdited(c))
    .map(({ c }) => ({ author: c.author, createdAt: c.createdAt, updatedAt: c.updatedAt, url: c.url }));
  const head = (headRefOid ?? '').toLowerCase();
  // headRefOid 缺失 → fail-closed:没有"当前 head"可比对,任何授权都判 stale,绝不放行。
  const candidates = commandHits
    .filter(({ c }) => !isEdited(c))
    .map(({ c, shas }) => ({ author: c.author, createdAt: c.createdAt, url: c.url, shas }));
  const isFresh = (cand) => head.length === 40 && cand.shas.includes(head);
  const fresh = candidates.filter(isFresh).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const stale = candidates.filter((cand) => !isFresh(cand)).map(({ author, createdAt, url }) => ({ author, createdAt, url }));
  return {
    adminsConfigured: true,
    authorized: fresh.length ? { author: fresh[fresh.length - 1].author, createdAt: fresh[fresh.length - 1].createdAt, url: fresh[fresh.length - 1].url } : null,
    stale,
    edited,
    legacyBare,
  };
}

// computeLatestPushDate 已删除(SC-A,2026-08-04):其唯一消费场景是 /approve-merge 的
// pushedDate 时效判定,该数据源已实测失效(Commit.pushedDate 被 GitHub 废弃、实测恒 null),
// 授权判定改为 head SHA 绑定(见 findApproveMergeAuthorization)。

// ── 安全与隐私内容扫描(P1-1,2026-08-02;context.mjs 与 pre-merge-check.mjs 共用同一份
// 判据,防两处漂移——此前 pre-merge-check.mjs 对"是否有泄密硬命中"恒传 false、完全不
// 扫描,是紧急通道的核心 fail-open 缺口)──
const HARD_SECRET_PATTERNS_BASE = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/],
  // P1-3(三审修复)→ 四审收窄:此前只认 AKIA(长期访问密钥),漏了 ASIA(STS 临时
  // 凭证,和长期凭证一样能直接用来调 API,泄露危害不比 AKIA 低)。三审时误把
  // AROA/AIDA/AGPA/AIPA/ANPA/ANVA 也当成"AWS 凭证前缀"一起加了进来——审核方查证:
  // 这几个是 IAM 资源的唯一 ID(角色/用户/用户组/实例配置/托管策略/托管策略版本),
  // 不能用于签名调用,不是凭证,不该判 hard(误报,而且密钥类硬命中的代价是"打回+
  // 清 git 历史+轮换凭证",误伤成本高)。真正能直接用于签名的只有 AKIA(长期）、
  // ASIA(STS 临时)、以及旧版 A3T 前缀(S3 前端令牌)。这几个 IAM 资源 ID 若确有
  // 审计价值可另立 soft 类型,本次判断价值有限暂不新增,只做移除。
  ['aws-access-key-id', /\b(?:AKIA|ASIA|A3T[A-Z0-9])[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36,}\b/],
  // slack-token 只覆盖 xox[abprs]- 这一族(user/bot/legacy 等 OAuth 令牌),Slack App-Level
  // Token(xapp-,Socket Mode 等场景用)是完全不同的格式(xapp-<版本>-<APP ID>-<请求
  // ID>-<64 位十六进制>),不会被 xox 系列命中,P1-3 补一条独立规则。
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9][A-Za-z0-9-]{8,}\b/],
  ['slack-app-token', /\bxapp-\d-[A-Z0-9]+-\d+-[a-f0-9]{64}\b/],
  // sk-api-key 此前只认连字符分隔(sk-,覆盖 OpenAI/Anthropic sk-ant-...)。三审时
  // 把 Stripe 的下划线形态放宽成任意 `sk[-_]...`,导致普通变量名(如
  // sk_status_configuration_value)也被误判 hard hit——四审收窄:Stripe 只认
  // `sk_live_`/`sk_test_` 这个具体前缀,不做通用 sk_ 分隔符放宽;原连字符分支
  // (sk-...)不受影响,单独保留。
  ['sk-api-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['stripe-api-key', /\bsk_(?:live|test)_[A-Za-z0-9_-]{20,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];
// 核查结论(P1-3,不只补审核方点名的两个样本,把其余条目也核一遍):github-token 的
// gh[pousr]_ 已覆盖 ghp_/gho_/ghu_/ghs_/ghr_ 全部官方前缀 + github_pat_ 细粒度令牌,
// 无遗漏,本轮不改;private-key/gitlab-token/npm-token/google-api-key 格式单一,
// 未发现类似"同族另一变体被漏掉"的明显缺口。
// credential-assignment 的占位符豁免(${VAR}/test/example 等)只给软命中降噪,不影响硬命中
const SENSITIVE_PLACEHOLDER_RE = /\$\{|\$\(|process\.env|<[^>]*>|xxx|your[-_]|placeholder|change[-_]?me|example|sample|dummy|test|fake|mock|stub|redacted|\*{3,}/i;
const SAFE_EMAIL_RE = /@example\.(?:com|org|net)\b|@test\.|\.invalid\b|noreply|no-reply|users\.noreply\.github\.com/i;
const SOFT_SENSITIVE_PATTERNS_BASE = [
  ['credential-assignment', /\b(?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/],
  ['cn-mobile', /(?<!\d)1[3-9]\d{9}(?!\d)/],
  ['cn-id-number', /(?<!\d)\d{17}[\dXx](?!\d)/],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/],
];
const SECURITY_HIT_CAP = 20;
const maskSensitive = (s) => `${s.replace(/\s+/g, ' ').slice(0, 6)}…(共 ${s.length} 字符)`;

/** 组装扫描用的正则清单(含 pr-rules.json 的 extraHardPatterns/extraSoftPatterns/allowPaths)。
 * 纯函数,便于单测。 */
export function buildSensitivePatterns(sensitiveRules) {
  const rules = sensitiveRules ?? {};
  const hard = [
    ...HARD_SECRET_PATTERNS_BASE,
    ...(rules.extraHardPatterns ?? []).map((p, i) => [`custom-hard-${i + 1}`, new RegExp(p)]),
  ];
  const soft = [
    ...SOFT_SENSITIVE_PATTERNS_BASE,
    ...(rules.extraSoftPatterns ?? []).map((p, i) => [`custom-soft-${i + 1}`, new RegExp(p)]),
  ];
  const allowRe = (rules.allowPaths ?? []).length ? new RegExp(rules.allowPaths.join('|')) : null;
  return { hard, soft, allowRe };
}

/** 扫描单行文本,把命中推进 sink.hard/sink.soft(纯函数,便于单测)。patterns 由
 * buildSensitivePatterns 组装。 */
export function scanSensitiveLine(line, location, patterns, sink) {
  for (const [kind, re] of patterns.hard) {
    const m = line.match(re);
    if (m) sink.hard.push({ ...location, kind, sample: maskSensitive(m[0]) });
  }
  for (const [kind, re] of patterns.soft) {
    const m = line.match(re);
    if (!m) continue;
    if (kind === 'credential-assignment' && SENSITIVE_PLACEHOLDER_RE.test(m[0])) continue;
    if (kind === 'email' && SAFE_EMAIL_RE.test(m[0])) continue;
    sink.soft.push({ ...location, kind, sample: maskSensitive(m[0]) });
  }
}

/**
 * 对 PR 标题/body/diff 新增行做安全与隐私内容扫描(IO 函数,非纯函数——发 `gh pr diff`
 * 网络请求;P1-1,2026-08-02)。context.mjs 与 pre-merge-check.mjs 都必须调用本函数,
 * 防两处判据漂移——此前 pre-merge-check.mjs 对"泄密硬命中"恒传 false、完全不扫描,把
 * "没扫到"直接当成了"无命中",而不是"扫描没跑,fail-closed"。
 *
 * 返回 `{ scanned, error, hardHitCount, softHitCount, hardHits, softHits }`。
 * `scanned=false`(diff 拉取失败等)必须让调用方判"未证明无泄露",fail-closed 不放行,
 * **不能**当"无命中"处理——`evaluateAuthorizedFastMerge` 的 `security.scanned` 参数
 * 就是接这个字段,这是 P1-1 修复的核心边界。
 */
// SC-R8(2026-08-05):`snapshotPatch` 是"四方同源"的接入点——调用方若已构建 DiffSnapshot
// (immutable git objects 出的 patch),就把 `snapshot.rawPatch` 传进来,安全扫描与
// preflight/覆盖 manifest/负向证据锚点消费**同一份**快照,不再各自 `gh pr diff` 造出多份
// 跨 head 的快照。未传时保留原有 `gh pr diff` 路径(兼容既有调用方与"拿不到 base oid"的
// 场景),但那条路径不参与 snapshotHash 绑定——如实声明,不冒称已全面同源。
export function scanPrSensitiveContent({ owner, repo, pr, title, body, sensitiveRules, snapshotPatch = null }) {
  const patterns = buildSensitivePatterns(sensitiveRules);
  const sink = { hard: [], soft: [] };
  const scanText = (text, file) => {
    const lines = (text ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) scanSensitiveLine(lines[i], { file, line: i + 1 }, patterns, sink);
  };
  scanText(title, 'PR title');
  scanText(body, 'PR body');
  let error = null;
  try {
    const diffText = typeof snapshotPatch === 'string'
      ? snapshotPatch
      : (gh(['pr', 'diff', String(pr), '--repo', `${owner}/${repo}`], { timeoutMs: 120_000 }).stdout ?? '');
    let curFile = null;
    let curAllowed = false;
    let newLine = 0;
    for (const raw of diffText.split('\n')) {
      if (raw.startsWith('+++ ')) {
        curFile = raw.replace(/^\+\+\+ /, '').replace(/^b\//, '').trim();
        curAllowed = curFile === '/dev/null' || (patterns.allowRe?.test(curFile) ?? false);
        continue;
      }
      const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { newLine = Number(hunk[1]); continue; }
      if (raw.startsWith('+')) {
        if (!curAllowed && curFile) scanSensitiveLine(raw.slice(1), { file: curFile, line: newLine }, patterns, sink);
        newLine += 1;
      } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
        newLine += 1;
      }
    }
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 200);
  }
  return {
    scanned: error == null,
    error,
    hardHitCount: sink.hard.length,
    softHitCount: sink.soft.length,
    hardHits: sink.hard.slice(0, SECURITY_HIT_CAP),
    softHits: sink.soft.slice(0, SECURITY_HIT_CAP),
  };
}

/**
 * 授权快速合并通道的机械前提判定(纯函数,便于单测;见 SKILL 5.1「授权快速合并通道」;
 * context.mjs 与 pre-merge-check.mjs 都必须调用本函数,防两处判据漂移)。只在调用方已
 * 确认存在有效(非 stale、非编辑、admins 成员、非机器人)`/approve-merge` 授权时才调用
 * ——本函数不重复检测授权本身,只判"授权到手后,这次机械上能不能合"。
 *
 * 2026-08-01 owner 拍板收窄阻断面,2026-08-02 补 P1-1 fail-closed 化:紧急通道的语义是
 * "管理员显式授权即自担责任,机器的职责从'拦'变成'留痕'"，因此只有下面几类**任何情况
 * 不可绕过**：
 *   - 安全扫描没跑成(`security.scanned===false`,如 diff 拉取失败)——未证明无泄露,
 *     不能当"无命中"放行,必须重试;
 *   - 泄密硬门(`security.hardHitCount>0`)——授权任何情况压不过;
 *   - 物理不可合(mergeStateStatus='DIRTY',有冲突,GitHub 层面就合不了);
 *   - required 检查未全绿或读取失败(requiredChecks 为 null/requiredFailed/
 *     requiredPending 非空)——CI 口径是硬指标,不因授权而放宽;
 *   - （授权本身失效/过期/被编辑由调用方在调用前处理，本函数不管）。
 * 格式门未过、未 resolve thread、非 required 检查失败**不再阻断**，改为 reportOnly：
 * eligible 仍可为 true，但调用方必须把 `reportOnly` 里非空的项显著写进报告/汇总/合并
 * 致谢，不能悄悄吞掉——这是"留痕代替拦"的落地方式。
 *
 * `security` 参数形状为 `{ scanned, hardHitCount }`(与 `scanPrSensitiveContent` 的返回
 * 值兼容,直接传即可)。
 */
export function evaluateAuthorizedFastMerge({ security, mergeStateStatus, unresolvedThreadCount, formatPass, formatIssues, requiredChecks }) {
  const reportOnly = {
    formatIssues: formatPass ? [] : (formatIssues ?? []),
    unresolvedThreadCount: unresolvedThreadCount ?? 0,
    nonRequiredFailures: requiredChecks?.nonRequiredFailed ?? [],
  };
  if (!security?.scanned) {
    return { eligible: false, blockedReason: '安全与隐私内容扫描未成功完成(如 diff 拉取失败)——未证明无泄露,fail-closed 不放行,需重试', reportOnly };
  }
  if (security.hardHitCount > 0) {
    return { eligible: false, blockedReason: '安全与隐私门硬命中(security.hardHits)——授权通道任何情况不可压过泄密硬门', reportOnly };
  }
  if (mergeStateStatus === 'DIRTY') {
    return { eligible: false, blockedReason: '有冲突(mergeStateStatus=DIRTY),物理不可合,需先 rebase', reportOnly };
  }
  if (!requiredChecks) {
    return { eligible: false, blockedReason: 'head commit 的必需检查 isRequired 状态读取失败——未证明 required 检查全绿,不放行(fail-closed)', reportOnly };
  }
  if (requiredChecks.requiredFailed.length > 0) {
    return { eligible: false, blockedReason: `必需检查失败:${requiredChecks.requiredFailed.join(' / ')}`, reportOnly };
  }
  if (requiredChecks.requiredPending.length > 0) {
    return { eligible: false, blockedReason: `必需检查还在跑:${requiredChecks.requiredPending.join(' / ')},等跑完再合`, reportOnly };
  }
  return { eligible: true, blockedReason: null, reportOnly };
}

/**
 * A2(缴械配套,owner 2026-08-04):loop 托管 PR **无条件**封死授权快速合并通道——
 * loop 的 PR-write token 能发评论,不封则一句 `/approve-merge <sha>` 就能骗巡审替它
 * 代合,整套「review-pr 是唯一合并闸」被一条评论绕穿。从 pre-merge-check.mjs 主流程抽出
 * 为纯函数(2026-08-05,seat②adversarial 复审:原判定内嵌在大函数里,现有测试只能靠源码
 * 字符串/分支存在性断言,测不出"条件被改成语义恒假"这类判定被拆掉的情形),不改变既有行为。
 *
 * 只把「loop 命中就无条件覆盖为 false,不看其余任何条件」这个决策本身收成纯函数——
 * "其余条件是否满足"(evaluateAuthorizedFastMerge + securityGate.pass 的合取)仍由调用方
 * 通过 computeEligibility 回调提供,本函数不重算、也不改这部分的既有表达式。
 * computeEligibility 是回调而非直接传值:非 loop 分支才需要发起 fetchHeadCheckContexts
 * 等网络调用,loop 分支必须保持"完全不发起这些请求"的既有行为——直接传值会强迫调用方
 * 在进这个函数之前就把网络请求都发出去。
 *
 * 输入:
 *   - approveMergeAuth: findApproveMergeAuthorization 的返回值(取其 .authorized)
 *   - loopExclusionForGate: detectLoopExclusion 的返回值(loop 命中即 truthy)
 *   - computeEligibility: () => { authorizedFastMergeAvailable, blockedReason, reportOnly }
 *     (调用方算好的"若不看 loop,是否该放行");仅在"有授权评论且非 loop"时才会被调用
 * 输出: { authorizedFastMergeAvailable, authorizedFastMergeInfo }
 */
export function decideAuthorizedFastMerge({ approveMergeAuth, loopExclusionForGate, computeEligibility }) {
  const authorized = approveMergeAuth?.authorized ?? null;
  if (!authorized) {
    return { authorizedFastMergeAvailable: false, authorizedFastMergeInfo: null };
  }
  if (loopExclusionForGate) {
    return {
      authorizedFastMergeAvailable: false,
      authorizedFastMergeInfo: {
        admin: authorized.author,
        commentUrl: authorized.url,
        commentCreatedAt: authorized.createdAt,
        blockedReason: 'loop-managed-pr-fast-merge-forbidden(loop 托管 PR 不设紧急通道,一律走完整审查)',
        reportOnly: [],
      },
    };
  }
  const { authorizedFastMergeAvailable, blockedReason, reportOnly } = computeEligibility();
  return {
    authorizedFastMergeAvailable,
    authorizedFastMergeInfo: {
      admin: authorized.author,
      commentUrl: authorized.url,
      commentCreatedAt: authorized.createdAt,
      blockedReason,
      reportOnly,
    },
  };
}

/**
 * ApprovalBasis 单一真相源(SC-B,2026-08-04 #469 复盘):把「这个 PR 的 APPROVED 到底
 * 算不算数」收成一个纯函数,context.mjs 与 pre-merge-check.mjs 共用,禁止各写一份。
 *
 * 为什么不能直接用 reviewDecision==='APPROVED':#469 实测,交互会话(与巡审同一 GitHub
 * 账号)approve 后 force-push 换了 head,分支保护 dismiss_stale_reviews=false 下旧 approve
 * 依然把 reviewDecision 顶成 APPROVED,自动化按 5.1 直接合——四个角色(打回/修改/批准/
 * 合并)同账号,零制衡。本函数把两件事拆出来机器判:①approve 绑定的是不是当前 head;
 * ②current-head 的 approve 是不是只来自巡审账号自己(own-account)。
 *
 * 输入(第 3 轮复审修订,2026-08-05):
 *   - reviews: GitHub 原生 `latestOpinionatedReviews` 的已映射节点
 *     [{ author, isBot, state, commitOid }]——服务端已保证"每 reviewer 恰一条最新
 *     opinionated review",本函数不再自算 latest-per-reviewer(上一版手工按 submittedAt
 *     排序,时间并列同 state 不同 commitOid 时结果由返回顺序决定,复审实测可翻转 granted,
 *     属假放行;DISMISSED 的语义也由服务端处理——被 dismiss 的 approve 不再出现为
 *     APPROVED);
 *   - headRefOid: 当前 head SHA
 *   - viewerLogin: 当前 gh 账号(巡审自动化账号)
 *   - reviewsComplete: connection 存在且 pageInfo.hasNextPage === false 才为 true
 *     (调用方判;connection/pageInfo 任一缺失都必须传 false → fail-closed)
 * 输出:
 *   { basis: 'independent'|'own-account'|'stale'|'none',
 *     independentApprovers, ownAccountCurrentHead, staleApprovers, reasons, dataComplete }
 *
 * 判定(fail 方向逐条写死):
 *   - 只有 state==='APPROVED' 的节点构成 approval;
 *   - approval 的 commitOid === headRefOid → current-head;缺 commitOid 或不等 → stale
 *     (fail-closed:缺失不猜"可能是当前的")。
 *   - viewerLogin 缺失 → 无法区分 own-account,所有 current-head approval 保守按 own-account
 *     处理(fail-closed 方向:宁可多要一道授权,不冒认 independent)。
 *   - reviewsComplete=false / headRefOid 缺失 → basis='none' + reason(数据不完整不承认任何
 *     approval basis)。
 *   - bot 的 review 不计入任何 basis;同一 login 出现多条不一致记录(违反原生字段契约)
 *     → 该 reviewer 整体不计入,不排序不猜。
 */
export function evaluateApprovalBasis({ reviews, headRefOid, viewerLogin, reviewsComplete }) {
  const reasons = [];
  const head = (headRefOid ?? '').toLowerCase();
  if (reviewsComplete === false) {
    return { basis: 'none', independentApprovers: [], ownAccountCurrentHead: false, staleApprovers: [], reasons: ['reviews-pagination-incomplete(fail-closed,不承认任何 approval)'], dataComplete: false };
  }
  if (head.length !== 40) {
    return { basis: 'none', independentApprovers: [], ownAccountCurrentHead: false, staleApprovers: [], reasons: ['headRefOid 缺失/非法(fail-closed)'], dataComplete: false };
  }
  const viewer = (viewerLogin ?? '').toLowerCase();
  if (!viewer) reasons.push('viewerLogin 缺失——current-head approval 一律按 own-account 保守处理');
  // 第 3 轮复审修订(2026-08-05):输入改为 GitHub 原生 latestOpinionatedReviews——服务端
  // 保证"每个 reviewer 恰一条最新 opinionated review",本函数**不再自算** latest-per-reviewer
  // (上一版手工按 submittedAt 排序,时间并列同 state 不同 commitOid 时结果由 GraphQL 返回
  // 顺序决定,是复审实测翻转出的假放行)。这里只保留:bot 过滤、login 缺失跳过、以及一条
  // 防数据异常的 fail-closed 守卫——同一 login 出现多条且 state/commitOid 不一致(原生字段
  // 契约下不该发生)时,该 reviewer 整体不计入,不做任何排序猜测。
  const latestByReviewer = new Map();
  const conflicted = new Set();
  for (const r of reviews ?? []) {
    if (!r || r.isBot) continue;
    const login = (r.author ?? '').toLowerCase();
    if (!login || conflicted.has(login)) continue;
    const prev = latestByReviewer.get(login);
    if (prev && (prev.state !== r.state || (prev.commitOid ?? '') !== (r.commitOid ?? ''))) {
      latestByReviewer.delete(login);
      conflicted.add(login);
      reasons.push(`reviewer ${login} 在 latestOpinionatedReviews 里出现多条不一致记录(数据异常),fail-closed 不计入`);
      continue;
    }
    latestByReviewer.set(login, r);
  }
  const independentApprovers = [];
  const staleApprovers = [];
  let ownAccountCurrentHead = false;
  for (const [login, r] of latestByReviewer) {
    if (r.state !== 'APPROVED') continue;
    const atHead = (r.commitOid ?? '').toLowerCase() === head;
    if (!atHead) { staleApprovers.push(login); continue; }
    if (!viewer || login === viewer) ownAccountCurrentHead = true;
    else independentApprovers.push(login);
  }
  const basis = independentApprovers.length > 0 ? 'independent'
    : ownAccountCurrentHead ? 'own-account'
    : staleApprovers.length > 0 ? 'stale'
    : 'none';
  if (basis === 'stale') reasons.push(`APPROVED 存在但均非当前 head(${staleApprovers.join(',')})——approve 之后代码又变过,不作合并依据`);
  return { basis, independentApprovers, ownAccountCurrentHead, staleApprovers, reasons, dataComplete: true };
}

/**
 * approved shortcut 的最终裁决(SC3.2):consume evaluateApprovalBasis + 配置键 + head 绑定
 * 授权,输出「能否把 approve 当作 basis='approved' 直接合」的布尔与理由。
 *
 * 复审修订(2026-08-04):`reviewDecision === 'APPROVED'` 是**必要但不充分**的合取条件。
 * reviewDecision 是 GitHub 对 PR 整体 code-review 状态的聚合裁决(审批数量、Code Owner、
 * dismiss 规则都算在内)——单条 current-head approval 替代不了它:若仓库要求 2 个 approval
 * 或 Code Owner、目前只有 1 条 current-head APPROVED,聚合态仍是 REVIEW_REQUIRED,此时
 * granted 会让调用方用 --admin 绕过尚未满足的 review 规则(复审抓出的假放行)。反过来
 * reviewDecision 单独也不充分——#469 正是 reviewDecision=APPROVED 但 approve 绑定旧 head。
 * 两个条件必须同时成立:聚合态 APPROVED(GitHub 的规则视角)∧ basis 判定通过(head 绑定
 * + own-account 视角)。注意副作用方向:不要求 approve 的仓库 reviewDecision 恒为 null,
 * 此处恒不 granted → 落 admin-trust 路由(要求独立审查回执),fail-closed,符合预期。
 *
 *   - basis='independent'(存在非巡审账号的 current-head APPROVED)→ granted,任何配置下都行;
 *   - basis='own-account':配置 mergeAuthorization.ownAccountApprovalRequiresAck 未开启 →
 *     granted(现状兼容);开启 → 必须另有 head 绑定 /approve-merge(headBoundAuthorized)
 *     才 granted,否则 reason='own-account-approval-needs-explicit-auth'(命名如实:机器只
 *     认账号,分不清同账号下是真人还是自动化会话,同账号一律收紧是意图不是误杀);
 *   - basis='stale'/'none' → 恒不 granted(head 绑定失败/无 approve,走别的路由)。
 */
export function resolveApprovedShortcut({ approvalBasis, ownAckRequired, headBoundAuthorized, reviewDecision }) {
  if (reviewDecision !== 'APPROVED') {
    return { granted: false, reason: `github-review-decision-not-approved(reviewDecision=${reviewDecision ?? 'null'}——GitHub 聚合裁决未达 APPROVED,单条 review 不能替代审批数/Code Owner 等规则)` };
  }
  const b = approvalBasis?.basis ?? 'none';
  if (b === 'independent') return { granted: true, reason: 'independent-current-head-approval' };
  if (b === 'own-account') {
    if (!ownAckRequired) return { granted: true, reason: 'own-account-approval(mergeAuthorization.ownAccountApprovalRequiresAck 未开启,按现状放行)' };
    if (headBoundAuthorized) return { granted: true, reason: 'own-account-approval + head 绑定 /approve-merge 显式授权' };
    return { granted: false, reason: 'own-account-approval-needs-explicit-auth(同账号 approve 不构成无条件合并资格,需 owner 对当前 head 发 /approve-merge <sha>)' };
  }
  if (b === 'stale') return { granted: false, reason: 'stale-approval(approve 非当前 head)' };
  return { granted: false, reason: `no-approval-basis(${(approvalBasis?.reasons ?? []).join(';') || '无 APPROVED'})` };
}

/**
 * 结构性 BLOCKED(blockClass='structural-check')三层分级合并路由的纯判定(便于单测;
 * context.mjs 的 auto 分流与 pre-merge-check.mjs 的 structuralBypassAvailable 都必须
 * 调用本函数,防两处判据漂移 —— 这是 2026-08-01 修复的 fail-open 核心逻辑,历史上两处
 * 各写了一份、都没校验 reviewDecision,PR #342/#366 曾在零 review 下被自动 admin 合入)。
 *
 * 机械前提(canBypass 且 requiredCheckRules 全部命中 structuralBypassAllowlist)由调用方
 * 算好通过 `structuralCanBypass` 传入,本函数只处理"谁来担保没有 APPROVED 也能合"这一层:
 *   - 机械前提不满足 → route='skip-structural-block',basis=null(不看 reviewDecision/admin);
 *   - 机械前提满足 + approvedShortcut=true → route='bypass-structural-block',basis='approved'。
 *     approvedShortcut 是调用方用 evaluateApprovalBasis + resolveApprovedShortcut 算出的布尔
 *     (2026-08-04 #469 复盘:不再直接消费 reviewDecision——它分不清 approve 绑定的是哪个
 *     head、也分不清 approve 是不是巡审账号自己给的)。SC-2(2026-08-08):强制自动化审查
 *     策略开启时(requireAutomatedReviewForAutoMerge=true)此分支改返回
 *     route='review-pending-approved-bypass'(basis 仍是 'approved')——GitHub APPROVED
 *     即便绑定当前 head 也不替代自动化审查,先进独立审查,凭当前 head clean 回执才能合
 *     (pre-merge-check.mjs 的 structuralBypassReady 对这条路同样要求 receiptClean);
 *   - 机械前提满足 + 缺 APPROVED + 作者在 admins 名单 → route='review-pending-admin-bypass',
 *     basis='admin-trust'(典型 ownPr,GitHub 422 禁止自批准;不直接合并,要求本轮先跑一次
 *     独立审查,通过后才能在合并阶段认"审查干净"为 APPROVED 的等价物,调用方负责这一半的
 *     语义核验,本函数只给路由结论);
 *   - 机械前提满足 + 缺 APPROVED + 非 admins 名单 → route='skip-structural-block',
 *     basis=null(2026-08-01 前的默认行为,现在必须显式满足前两条之一才能 bypass)。
 *
 * `requireAutomatedReviewForAutoMerge` 缺省 false(=策略关闭,行为与拆分前一致),保证
 * 未启用强制策略的消费仓与既有单测不受影响。
 */
export function decideStructuralBypassRoute({ structuralCanBypass, approvedShortcut, isAdminAuthor, requireAutomatedReviewForAutoMerge = false }) {
  if (!structuralCanBypass) return { route: 'skip-structural-block', basis: null };
  if (approvedShortcut === true) {
    if (requireAutomatedReviewForAutoMerge) return { route: 'review-pending-approved-bypass', basis: 'approved' };
    return { route: 'bypass-structural-block', basis: 'approved' };
  }
  if (isAdminAuthor) return { route: 'review-pending-admin-bypass', basis: 'admin-trust' };
  return { route: 'skip-structural-block', basis: null };
}

/**
 * `mergeStateStatus=BLOCKED` 的 blockClass 细分(便于单测;context.mjs 与
 * pre-merge-check.mjs 共用同一份判据,防两处判据漂移;P1-4,2026-08-02)。
 *
 * 核心修复(第②层可达性):此前两处代码都在 `reviewDecision==='REVIEW_REQUIRED'||
 * reviewDecision==null` 时**直接短路**判 `blockClass='awaiting-approval'`,从不往下探测
 * 是否存在真实的结构性 blocker(unresolved thread / CI / 永不上报的必需检查)。在**不
 * 要求 approve** 的仓库(如 mivo-canvas,分支保护只挂了 code_scanning/code_quality/
 * copilot_code_review 三个从不上报结果的门,没有 required-approving-review 规则)里,
 * `reviewDecision` 恒为 `REVIEW_REQUIRED`/`null`——短路判定的结果是这类仓库的
 * `blockClass` 永远到不了 `'structural-check'`,`decideStructuralBypassRoute` 的
 * `review-pending-admin-bypass`(admin-trust)路由因此永久不可达,即便作者在 `admins`
 * 名单也没有任何合并出口(`EVOLUTION.md` 的 `own-pr-has-no-merge-path-when-selffix-empty`
 * 根因)。修复方式:approval 维度只影响"最终怎么归类",不再决定"要不要往下探测"——
 * unresolved thread / CI 失败或还在跑 / 结构性探测这几层,不管 `reviewDecision` 是什么
 * 都必须走一遍;唯一的区别是走到最后、什么都排查不出真实问题时,`reviewDecision` 才用来
 * 决定归到 `'awaiting-approval'`(真的只是缺 approve)还是 `'structural-check'`(存在
 * 真实的永不上报门,不管有没有 approve 都要走三层分级合并路由)。
 *
 * 参数:
 *   - `reviewDecision`:调用方已排除 `CHANGES_REQUESTED`(含 self-resolvable 特判,那
 *     两个分支正交于本函数,继续留在调用方判);
 *   - `hasUnresolvedThreads`:boolean;
 *   - `ciRuns`:`{failed:string[], pending:string[]}|null`(`classifyHeadChecks` 返回值,
 *     `null`=读取失败);
 *   - `headRollup`:`{failed:string[], pending:string[], ok:string[]}|null`
 *     (`classifyStatusRollup` 返回值,`null`=读取失败);
 *   - `probeStructuralBlock`:`() => {requiredCheckRules,canBypass,rulesetIds}|null` ——
 *     惰性回调,只有真正走到"其余维度都排查完、要看是否存在结构性门"这一步才调用(避免
 *     每个 BLOCKED 的 PR 都白打一次分支保护规则的 API)。
 *
 * 返回 `{ blockClass, structuralBlock }`(`structuralBlock` 仅
 * `blockClass==='structural-check'` 时非空)。`blockClass` 新增枚举值
 * `'blocked-unexplained'`:走完全部已知维度(review/thread/CI/rollup/结构性探测)都查
 * 不出原因,但 `mergeStateStatus` 仍 `BLOCKED`——这是探测失败或未知规则类型的异常兜底,
 * fail-closed(不当 `awaiting-approval` 或 `structural-check` 处理,不可 bypass、不催办,
 * 下轮再看)。
 */
export function classifyBlockedStatus({ reviewDecision, hasUnresolvedThreads, ciRuns, headRollup, probeStructuralBlock }) {
  if (hasUnresolvedThreads) return { blockClass: 'threads-unresolved', structuralBlock: null };
  if (ciRuns === null) return { blockClass: 'ci-unknown', structuralBlock: null };
  if (ciRuns.failed.length > 0) return { blockClass: 'ci-failed', structuralBlock: null };
  if (ciRuns.pending.length > 0) return { blockClass: 'ci-pending', structuralBlock: null };
  if (headRollup === null) return { blockClass: 'ci-unknown', structuralBlock: null };
  if (headRollup.failed.length > 0) return { blockClass: 'ci-failed', structuralBlock: null };
  if (headRollup.pending.length > 0) return { blockClass: 'ci-pending', structuralBlock: null };
  // 到这里:无未 resolve thread,CI 与 rollup 全干净——不管 reviewDecision 是什么,都必须
  // 先探测是否存在真实的结构性门,才能判"唯一原因是缺 approval"还是"存在永不上报的门"。
  const structuralBlock = probeStructuralBlock();
  if (structuralBlock === null) {
    // 分支保护规则读取失败(权限/网络)——无法证明"没有结构性门",不能默认判
    // awaiting-approval,也不能判 structural-check(没有 requiredCheckRules 细节)。
    return { blockClass: 'ci-unknown', structuralBlock: null };
  }
  if (structuralBlock.requiredCheckRules.length > 0) {
    return { blockClass: 'structural-check', structuralBlock };
  }
  if (reviewDecision === 'REVIEW_REQUIRED' || reviewDecision == null) {
    // 探测证实:没有结构性门,唯一原因就是缺 approval。
    return { blockClass: 'awaiting-approval', structuralBlock: null };
  }
  // reviewDecision===APPROVED,结构性探测也证实无问题,其余维度全干净,但仍 BLOCKED——
  // 排查了全部已知维度查不出根因,fail-closed。
  return { blockClass: 'blocked-unexplained', structuralBlock: null };
}

// ── 阶段二独立审查回执(P1-5,2026-08-02;P1-2 三审修复:并发安全重做存储)──
// 结构性 BLOCKED 的 admin-trust 路由(decideStructuralBypassRoute 的
// review-pending-admin-bypass)只是"路由结论"——它说"作者在 admins 名单、机械前提满足",
// 不代表"这次真的审查过而且干净"。脚本本身判断不了代码好不好,那是 LLM 审查 agent 的
// 语义判断;回执就是这半判断留下的、可核验的凭证。**只用既有 stateFile() 接口定位文件,
// 不新建状态目录结构、不改 STATE_DIR 布局**——只是把"单文件存全部 PR"换成"每个 PR 一个
// 独立文件",布局本身(STATE_DIR 下平铺文件)不变。
//
// 此前是单文件 `review-receipts.json` 存全部 PR、"整份读→改一键→整份写回"的非原子
// read-modify-write:auto 并行审多 PR 时,多个进程同时读到同一份旧内容、各自改自己的
// PR 键、再各自整份写回——后写的进程会用"读的时候还没看到别的 PR 新回执"的旧快照,把
// 别的 PR 刚写入的新回执整个覆盖丢失(不是"数据损坏",是"静默丢了别人的写")。审核方
// 实测 40 并发只有约 12 个 PR 的回执存活,且更危险的是:PR 已有最新 dirty 回执时,另一个
// 早于它、还在用旧快照的进程写回自己的 PR 时会把这份 dirty 一并覆盖回旧的 clean ——
// `isReviewReceiptClean` 随后读到复活的旧 clean,`structuralBypassReady` 被误判为
// 可合并,这是正常并行审查路径下就会踩的 fail-open,不是边界场景。
//
// 改法:每个 PR 一个独立文件 `review-receipt-<pr>.json`,PR 之间物理隔离,不再有"整份
// 读改写"的共享状态,天然消除跨 PR 覆盖;单个 PR 内部的写入通过 writeJsonAtomic 走
// "唯一临时文件 + rename"——rename 在同一文件系统内是原子操作,不会有"写到一半被读到
// 半个文件"或"两个并发写者交错出损坏 JSON"的中间态,最后一个 rename 落地的即为最终态
// (last-write-wins,但每次写的都是完整、自洽的一条回执,不会被"部分覆盖")。

/**
 * 原子写 JSON(唯一临时文件 + renameSync)。`pid + 随机 6 字节十六进制` 保证同一进程内
 * 多次调用、以及不同进程并发调用之间临时文件名互不冲突,避免两个写者的临时文件互相
 * 覆盖后再各自 rename 出现竞态。导出供其它需要同样原子写语义的状态模块复用
 * (如 convergence-state.mjs 的 per-PR 收敛状态)——不重新发明一遍同样的 tmp+rename 逻辑。
 */
export function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmpPath, filePath);
}

/**
 * 定位某 PR 的回执文件路径。`pr` 必须是可转成非负整数的值——回执文件名直接拼进
 * 文件系统路径,防御性拒绝非法值(如意外传入字符串路径片段),不静默拼出奇怪路径。
 */
function reviewReceiptFile(pr) {
  const n = Number(pr);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`回执文件路径要求 pr 是非负整数,收到:${JSON.stringify(pr)}`);
  }
  return stateFile(`review-receipt-${n}.json`);
}

/**
 * 写入一条阶段二独立审查回执(每 PR 一个独立文件,原子写入)。
 * `verdict` 只接受 `'clean'`(0 P0/P1)或 `'dirty'`——不接受自由文本,防止调用方拼错词
 * 导致 `isReviewReceiptClean` 误判。`headRefOid` 必须非空:回执必须绑定到具体的 head
 * commit,否则"回执是不是针对当前 head"这个核心校验就无从谈起。
 */
export function writeReviewReceipt({ pr, headRefOid, verdict, p0p1Count, bindings = null }) {
  if (verdict !== 'clean' && verdict !== 'dirty') {
    throw new Error(`verdict 必须是 'clean' 或 'dirty',收到:${JSON.stringify(verdict)}`);
  }
  if (!headRefOid) throw new Error('headRefOid 不能为空——回执必须绑定到具体的 head commit');
  // SC-R1b(2026-08-05):clean 回执必须携带五项绑定 {source, schemaVersion, outputHash,
  // snapshotHash, ledgerHash}——consume-review-output.mjs 是唯一能算出这五项的调用方,
  // 因此它事实上是唯一 clean writer;public CLI(write-review-receipt.mjs)已直接禁
  // clean。缺任一绑定的 clean 写入在这里(可被 import 的公开函数)也拒绝,不能只指望
  // CLI 层校验。dirty 不强制绑定(撤销/打回场景可能算不出 outputHash)。
  if (verdict === 'clean') {
    // R7 第 4 轮核验:+escapeSourceHash/knownHazardsHash——clean 还要绑逃逸数据源与
    // canonical hazard 的全内容(premerge 现场重算比对)。
    for (const k of ['source', 'schemaVersion', 'outputHash', 'snapshotHash', 'ledgerHash', 'escapeSourceHash', 'knownHazardsHash']) {
      if (typeof bindings?.[k] !== 'string' || !bindings[k]) {
        throw new Error(`clean 回执缺绑定字段 ${k}——clean 只能由 consume-review-output.mjs 依据机器 verdict 写入(SC-R1b)`);
      }
    }
  }
  // P2-2 三审修复:此前 `Number(p0p1Count) || 0` 会把任何非法输入(undefined/NaN/
  // 负数/字符串)静默吞成 0,等价于"没传就当 0 P0/P1",这正是 isReviewReceiptClean
  // 误判的源头之一——写入侧本该拒绝的脏输入,被这里悄悄洗白成合法回执。write-review-
  // receipt.mjs(CLI)已经校验过,但 writeReviewReceipt 是可以被直接 import 调用的公开
  // 函数,校验不能只指望调用方,这里必须自己也守住。
  const p0p1CountNum = Number(p0p1Count);
  if (!Number.isInteger(p0p1CountNum) || p0p1CountNum < 0) {
    throw new Error(`p0p1Count 必须是非负整数,收到:${JSON.stringify(p0p1Count)}`);
  }
  const receipt = {
    headRefOid,
    verdict,
    p0p1Count: p0p1CountNum,
    writtenAt: new Date().toISOString(),
    ...(bindings ? { ...bindings } : {}),
  };
  writeJsonAtomic(reviewReceiptFile(pr), receipt);
  return receipt;
}

/** 读取某 PR 当前的审查回执,无则返回 null(文件不存在/损坏都按"无回执"处理,fail-closed)。 */
export function readReviewReceipt(pr) {
  const file = reviewReceiptFile(pr);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 判定某条审查回执对"当前 head"是否仍然「干净且新鲜」(纯函数,便于单测;P1-5,
 * 2026-08-02;P2-2 三审修复:p0p1Count 校验收紧)。pre-merge-check.mjs 消费它来
 * 决定 admin-trust 路由是否真的 `structuralBypassReady`:
 *   - 无回执 → false(从未写过,或从未针对这个 PR 写过);
 *   - `receipt.headRefOid !== headRefOid` → false(回执针对的是旧 head——审查通过之后
 *     又推了新 commit,旧回执不再覆盖新代码,必须重新审查、重新落回执);
 *   - `verdict !== 'clean'` → false(审查跑完了但没通过);
 *   - `p0p1Count` 不是「严格等于 0 的整数」→ false。此前用 `(p0p1Count ?? 0) > 0`,
 *     字段缺失(undefined)会被 `?? 0` 洗成 0、`-1 > 0` 为假——两种本该判脏的畸形回执
 *     都被误判成 clean。改用 `Number.isInteger(...) && === 0`,只有明确写着"0 个
 *     P0/P1"的回执才算干净,字段缺失/负数/非整数一律 fail-closed 判不干净。
 */
export function isReviewReceiptClean({ receipt, headRefOid, snapshotHash, ledgerHash, escapeSourceHash, knownHazardsHash, expectedPrescanHash }) {
  if (!receipt) return false;
  if (receipt.headRefOid !== headRefOid) return false;
  if (receipt.verdict !== 'clean') return false;
  if (!Number.isInteger(receipt.p0p1Count) || receipt.p0p1Count !== 0) return false;
  // R7 第 4 轮核验:clean 后 PR body/关联 issue/canonical hazard 内容变化必须打 stale。
  // 期望值缺失(undefined)一律判不 clean(fail-closed),与下方 snapshot/ledger 同口径。
  if (typeof escapeSourceHash !== 'string' || !escapeSourceHash || receipt.escapeSourceHash !== escapeSourceHash) return false;
  if (typeof knownHazardsHash !== 'string' || !knownHazardsHash || receipt.knownHazardsHash !== knownHazardsHash) return false;
  // SC-R1b/R5(2026-08-05):clean 的新鲜度不再只看 head——必须同时匹配当前重建的
  // snapshotHash(base 前进 head 不变时旧 clean 即 stale)与当前 ledgerHash("先 clean
  // 后新增 open"会改变 ledgerHash,旧 clean 失效)。调用方不提供这两个期望值(undefined)
  // 时一律判不 clean(fail-closed),不存在"旧签名照常放行"的兼容通道;历史旧格式回执
  // (无绑定字段)同样在此失效,forward-only。
  if (typeof snapshotHash !== 'string' || !snapshotHash || receipt.snapshotHash !== snapshotHash) return false;
  if (typeof ledgerHash !== 'string' || !ledgerHash || receipt.ledgerHash !== ledgerHash) return false;
  // SC-6.2(final SC v2):prescan 条件性绑定,三态期望值——
  //   undefined:调用方未声明 prescan 状态(旧调用点未升级)→ fail-closed;
  //   null:明确声明 prescan disabled → 要求 receipt 不携带 prescanHash(不得偷带旧值);
  //   string:明确声明 prescan enabled → 要求 receipt.prescanHash 严格相等。
  if (expectedPrescanHash === undefined) return false;
  if (expectedPrescanHash === null) {
    if (receipt.prescanHash !== undefined) return false;
  } else {
    if (typeof expectedPrescanHash !== 'string' || !expectedPrescanHash || receipt.prescanHash !== expectedPrescanHash) return false;
  }
  return true;
}

/**
 * 探测某分支的「必需检查门」+ 当前账号能否 bypass(只读,best-effort,失败返 null)。
 * 用于解释「review 都过了、CI 也没失败,但永久 BLOCKED」——多半是 org ruleset 的
 * code_scanning(CodeQL)/ code_quality / required_status_checks 这类要求结果上报、
 * 但本仓库根本没产出结果的门,owner 通常靠 admin bypass 合(current_user_can_bypass)。
 * 端点:GET /repos/{slug}/rules/branches/{branch}(列命中规则,PAT 通常可读,完整分页
 * 遍历见 `fetchAllRestPages`——P1-1 二审修复:此前只读一页,与 fetchExpectedRequiredContexts
 * 同一个 bug,这里此前漏改)+ GET /repos/{slug}/rulesets/{id}(取 current_user_can_bypass)。
 * 第三参 `fetchPage` 供单测注入,透传给 `fetchAllRestPages`。
 * 返回 { requiredCheckRules, canBypass, rulesetIds } | null。
 */
export function probeBranchProtection(slug, branch, { satisfiedContexts = null, fetchPage } = {}) {
  if (!branch) return null;
  const rules = fetchAllRestPages(
    `repos/${slug}/rules/branches/${encodeURIComponent(branch)}?per_page=100`,
    fetchPage ? { fetchPage } : {},
  );
  if (!Array.isArray(rules)) return null;
  try {
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

// normalizeTitlePrefixes 的可信上限(SC-E1-1,2026-08-02):防止误配置(整段贴错 JSON、
// 脚本生成的巨量前缀等)拖成分钟级停顿——20000 项唯一前缀在旧版 O(n²) 实现下实测耗时
// 2775.7ms。取值依据:①MAX_ITEM_BYTES=128,真实 loop 前缀形如 `[bug-doctor] `/`[mivo] `
// 不到 20 字节,128 留出 6 倍以上冗余,同时挡掉误粘贴的整行文本;②MAX_COUNT=32,一个仓库
// 迁移期同时存在的新旧 loop 前缀通常是个位数,32 已是"十几个 loop 并存"都覆盖不到的
// 宽松上限,真配到这个数量基本可判定为误配而非正常迁移;③MAX_TOTAL_BYTES=4096,与前两项
// 自洽(32×128=4096),保证 20000 项级误配在归一化阶段就被判定超限。
const TITLE_PREFIX_MAX_COUNT = 32;
const TITLE_PREFIX_MAX_ITEM_BYTES = 128;
const TITLE_PREFIX_MAX_TOTAL_BYTES = 4096;

/**
 * 归一化 loopPrExclusion 的标题前缀配置:兼容 legacy `titlePrefix`(单值 string)与新
 * `titlePrefixes`(string[])——两者可以同时配置(如目标仓库 loop 改名后新旧前缀并存的
 * 迁移期)。用 Set 做 O(n) 去重(SC-E1-1,2026-08-02:替掉此前 `prefixes.includes(p)` 在
 * 循环内造成的 O(n²))。返回的 prefixes 按长度降序排列供调用方 `.find()` 命中最长前缀
 * (SC-LONGEST-2)——不依赖数组声明顺序,也不假设"数组项在前、legacy 追加末尾"。
 *
 * ⚠️ 配置 titlePrefixes/titlePrefix 时,前缀字面量必须包含标题里实际存在的尾随空格——
 * 写 `"[mivo] "` 而非 `"[mivo]"`。少了这个空格,剥离后 titleForFormat 会带一个前导空格
 * (如 " fix: ..."),TITLE_TYPE_RE 锚定行首 `^(type)` 匹配不到,格式门仍会误判——这不是
 * 本函数的 bug,它只按字面量精确剥离,不做 trim。
 *
 * 非法形态(非数组 / 非字符串 / 空字符串)按同文件 `normalizeLoginList` 的既有约定处理
 * (SC-WARN-3,2026-08-02):过滤掉非法条目、用能过滤到的合法子集继续工作,同时返回
 * `invalid=true`——不再是"静默过滤,不抛错"就完事;调用方(context.mjs)必须在 invalid
 * 时经既有 CONFIG_WARNINGS 通道显著告警,不能悄悄吞掉"配置形态不合法"这个信号。
 *
 * 项数 / 单项长度 / 总字节任一超过上方可信上限时返回 `overLimit=true`、`prefixes=[]`——
 * fail-safe 整体禁用 loop 托管 PR 排除机制,不是"超限的丢弃、没超限的部分继续工作"
 * (调用方 detectLoopExclusion 据此直接返回 null,不能只吞掉超限前缀后用剩下的凑合判定,
 * 否则误配置只会表现为"部分 loop PR 突然被当成人类 PR 审"这种难定位的诡异行为)。
 *
 * rules 为 null/未配置任一字段时返回 `{ prefixes: [], invalid: false, overLimit: false }`。
 * 配置文件本身来自 REVIEW_PR_RULES_FILE 环境变量 / 目标仓库自己的
 * `<REPO_ROOT>/agent-use/docs/pr-rules.json` / 本 Skill 默认配置三者之一(见 loadRules()
 * 的解析优先级),不是"本仓自己的 pr-rules.json"——不同脚本读取到的可能是目标仓库自备的
 * 那份,不能假设就是 Skill 自带默认值。
 *
 * 返回 { prefixes: string[], invalid: boolean, overLimit: boolean }。
 */
export function normalizeTitlePrefixes(rules) {
  const seen = new Set();
  let invalid = false;

  const collect = (value, isArrayField) => {
    if (value === undefined || value === null) return;
    if (isArrayField && !Array.isArray(value)) { invalid = true; return; }
    for (const p of (isArrayField ? value : [value])) {
      if (typeof p !== 'string' || p === '') { invalid = true; continue; }
      seen.add(p); // Set 天然去重,O(1) 均摊,不再是 O(n) 的 includes() 扫描
    }
  };
  collect(rules?.titlePrefixes, true);
  collect(rules?.titlePrefix, false);

  const prefixes = [...seen];
  let totalBytes = 0;
  let overLimit = prefixes.length > TITLE_PREFIX_MAX_COUNT;
  for (const p of prefixes) {
    const bytes = Buffer.byteLength(p, 'utf8');
    if (bytes > TITLE_PREFIX_MAX_ITEM_BYTES) overLimit = true;
    totalBytes += bytes;
  }
  if (totalBytes > TITLE_PREFIX_MAX_TOTAL_BYTES) overLimit = true;
  if (overLimit) return { prefixes: [], invalid, overLimit: true };

  prefixes.sort((a, b) => b.length - a.length); // 最长前缀优先命中(SC-LONGEST-2)
  return { prefixes, invalid, overLimit: false };
}

/**
 * 判定该 PR 是否由目标仓库自有的自动修 bug loop 托管、以及其 T-level。
 * 返回 null(未命中任一 titlePrefix/titlePrefixes,或命中但本地台账没有该 PR 号的
 * 记录——与 loop 无关 / 无法证明托管关系,按普通 PR 处理)或
 * { matched:true, verdict:'t1'|'t2', source, matchedPrefix }。
 * verdict='t1' 时 review-pr 必须跳过(loop 自己合并,不审不合不催,也不重复播报合并致谢);
 * 'skip'(=已确认托管但拿不准 T-level,defaultWhenAmbiguous)按同款处理;'t2' 时正常走 review-pr。
 * source 标注判据来源(body-marker / state.json / default),供排查与飞书汇总措辞用。
 * matchedPrefix 是实际命中的那一个前缀字面量(供调用方剥标题用,如 context.mjs 的
 * titleForFormat——不能假设是 rules.titlePrefix,配置了 titlePrefixes 数组时命中的可能
 * 是数组里的任一项,且总是取归一化后按长度降序排列的最长匹配项,见 normalizeTitlePrefixes)。
 * rules 来自 pr-rules.json 的 loopPrExclusion 字段,调用方自行 JSON.parse 后传入
 * (不同脚本读取 pr-rules.json 的相对路径不同,本函数不做路径假设)。rules 为 null/未配置
 * loopPrExclusion,或 titlePrefix/titlePrefixes 均未配置(目标仓库没有这类 loop),或
 * titlePrefix/titlePrefixes 超过 normalizeTitlePrefixes 的可信上限被 fail-safe 整体禁用
 * (overLimit)时,均恒返回 null——整套机制天然关闭。
 *
 * ⚠️ 身份门槛(反伪造):仅标题前缀**不足以**认定 PR 由 loop 托管——任何贡献者都能在自己
 * PR 的标题前加一句 titlePrefix/titlePrefixes 字面量,冒充 loop 托管来拿到
 * defaultWhenAmbiguous 的默认 skip,让自己的 PR 永久漏审。必须本地台账(`rules.stateFile`,
 * loop 自己写入、贡献者在 GitHub 侧碰不到这份本机文件)里精确命中该 PR 号,才认定为真托管;
 * 命中前缀但台账查不到(文件不存在 / 读不到 / 没有该 PR 号)→ **直接返回 null,按普通 PR
 * 处理**,不再落到 defaultWhenAmbiguous。未来若 loop 加了可信 label / commit 签名等机制,
 * 可以在这里追加作为身份门槛的替代或补充信号,但不能只靠可由 PR 作者自行填写的字段
 * (标题 / body 文本)单独作数。
 */
export function detectLoopExclusion({ title, body, pr, rules }) {
  const { prefixes, overLimit } = normalizeTitlePrefixes(rules);
  if (overLimit) return null; // fail-safe(SC-E1-1):前缀配置超可信上限,整体禁用,不部分工作
  const matchedPrefix = prefixes.find((p) => title.startsWith(p)) ?? null;
  if (!matchedPrefix) return null;
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

  // force-review 强制路由(缴械配套,owner 2026-08-04 决策 mergeAuthority=review-pr-only):
  // 配置了 forceVerdict 时,身份确认后**不再看** body marker 与 cluster.tCap,一律按 t2 进
  // 全套审查——loop 侧数据(body 标记/台账 tCap)漂移回 T1 也不能再造成跳审。唯一有意义的
  // 取值是 't2';为防拼写漂移静默失效(t1/skip 都意味着无人审),任何非空值都收敛为 't2',
  // 绝不产生比 t2 更宽松的结果(fail-safe 朝「进审」方向),coerced 时 source 单独标注供告警。
  if (rules.forceVerdict != null && rules.forceVerdict !== '') {
    const coerced = rules.forceVerdict !== 't2';
    return { matched: true, verdict: 't2', source: coerced ? 'force-config-coerced' : 'force-config', matchedPrefix };
  }

  // 身份确认后再判 T-level:先看 body 里 loop 自己声明的独立 metadata 行(锚定整行、加 m 标志
  // 逐行匹配,避免自然语言正文里偶然出现的"这次不建议合并"之类描述性语句被误当成 T-level 声明);
  // 没写明再退回本地台账的 cluster.tCap(身份门槛已过,这里可信采信)。
  for (const re of rules.t1BodyMarkers ?? []) {
    if (new RegExp(re, 'm').test(body)) return { matched: true, verdict: 't1', source: 'body-marker', matchedPrefix };
  }
  for (const re of rules.t2BodyMarkers ?? []) {
    if (new RegExp(re, 'm').test(body)) return { matched: true, verdict: 't2', source: 'body-marker', matchedPrefix };
  }
  if (cluster.tCap === 'T1') return { matched: true, verdict: 't1', source: 'state.json', matchedPrefix };
  if (cluster.tCap === 'T2') return { matched: true, verdict: 't2', source: 'state.json', matchedPrefix };

  return { matched: true, verdict: rules.defaultWhenAmbiguous ?? 'skip', source: 'default', matchedPrefix };
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

// ── 维护者确认门(signoff)统一标签/标记制 ──
// signoff-hold.mjs / signoff-release.mjs 写入 PR 评论;context.mjs 扫描分类、
// signoff-policy.test.mjs 覆盖。2026-08-09 起由旧 draft 制(product-hold 转 draft /
// product-release 标回 ready)升级为标签制:hold=开讨论 issue + 状态评论 + 挂
// awaiting-discussion 标签(不转 draft);release=admins 名单成员在当前 head 之后的
// GitHub Approve,摘标签由 signoff-release --labels-only 同步。标签只是 GitHub 后台的
// 可筛性入口,真正挡合并的是流程内部判定;摘标签不构成通过。
//
// 与上游(lizi)同源的解析/判定函数全部收在这里,防止 signoff-hold / signoff-release /
// context.mjs 三处正则漂移;缺省标签名走 SIGNOFF_LABEL_DEFAULT,pr-rules.json 的
// signoffGate.label 可覆盖(与上游 signoff-hold.mjs 只读这一个嵌套键的契约一致)。

/** hold 标记前缀沿用 PRODUCT_GATE_MARKER_PREFIX(存量被 hold 的 PR 评论里就是它)。 */
/** 通过标记前缀(signoff-release.mjs 写入):记录哪些触发类别曾被维护者确认;当前 head 是否有效另判。 */
export const SIGNOFF_RELEASE_MARKER_PREFIX = '<!-- review-pr:signoff-release';
/** 状态回帖标记前缀(signoff-hold.mjs 写入):按 head sha 去重,同一版代码只回帖一次。 */
export const SIGNOFF_RENOTICE_MARKER_PREFIX = '<!-- review-pr:signoff-renotice';
/** 维护者确认标签缺省名(pr-rules.json signoffGate.label 可覆盖)。 */
export const SIGNOFF_LABEL_DEFAULT = 'awaiting-discussion';
/** 标签颜色(紫色=「等人确认」不是「出错」,红色会被误读成失败)。 */
export const SIGNOFF_LABEL_COLOR = '7057FF';
/** 上一代标签:只用于迁移和合并前防线,不再创建。 */
export const LEGACY_MAINTAINER_DISCUSSION_LABEL = 'awaiting-maintainer-discussion';
/** 更早的统一标签:只用于迁移,不再创建。 */
export const LEGACY_MAINTAINER_APPROVAL_LABEL = 'needs-maintainer-approval';
/** 更早的旧主标签:只用于迁移,不再创建。 */
export const LEGACY_SIGNOFF_LABEL = 'need-whitelist';
/** 旧标签(仅供迁移时识别摘除,不再创建)。 */
export const LEGACY_GATE_LABELS = [
  LEGACY_MAINTAINER_DISCUSSION_LABEL,
  LEGACY_MAINTAINER_APPROVAL_LABEL,
  LEGACY_SIGNOFF_LABEL,
  ...['product', 'arch', 'security', 'cold', 'coldupdate', 'rules'].map((g) => `${LEGACY_SIGNOFF_LABEL}:${g}`),
];

/**
 * 测试-only 路径判定(product 门的确定性排除;signoff-policy.test.mjs 覆盖)。
 * 与 `.d.ts` 排除同理:测试 / mock / snapshot 文件不可能产生任何视觉变化,产品门不该
 * 因它触发 —— 这是确定事实,不交给每轮的语义判断。
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
 * 重新确认。
 * @returns {Map<string, {by:string|null, at:string|null, via:'release-marker'}>} kind → 放行事件
 */
export function parseSignoffReleases(comments) {
  const released = new Map();
  for (const c of comments ?? []) {
    const body = (typeof c === 'string' ? c : c?.body) ?? '';
    const createdAt = typeof c === 'string' ? null : c?.createdAt ?? null;
    for (const m of body.matchAll(/<!--\s*review-pr:signoff-release\s+gates=([a-zA-Z,]+)(?:\s+by=(\S+?))?\s*-->/g)) {
      for (const kind of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        released.set(kind, { by: m[2] ?? null, at: createdAt, via: 'release-marker' });
      }
    }
  }
  return released;
}

/**
 * 解析状态回帖标记(signoff-hold.mjs 写入,形如 `<!-- review-pr:signoff-renotice head=<sha> -->`)。
 * 回帖是给**作者**的:门从「放行 / 等作者改」翻回「等维护者确认」时告诉他球已经不在他手里。
 * 按 head sha 去重 —— 作者对同一版代码反复点 request review、标签反复摘挂,都只回一次;
 * 他再推一版新代码、门又亮起来,才会再回一条。
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
 * 给 PR / issue 增删单个标签。**必须走 REST 的 issue-label 端点,不许回退到
 * `gh pr edit --add-label/--remove-label`**:后者在改标签前会顺带预查一段较宽的 GraphQL
 * (含 reviewRequests.nodes.N.requestedReviewer),该字段被 fine-grained PAT 拒时整条命令
 * 陪葬 —— 标签写权限明明是好的,报错却长得像「无权限贴标签」。REST 端点只碰标签本身,
 * PR 在 GitHub API 里也是 issue,所以 issues/:n/labels 对 PR 同样有效。
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
    // 颜色用紫色(SIGNOFF_LABEL_COLOR):这是「等人确认」不是「出错」,红色会被误读成失败
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

/**
 * 三门(security / rules / arch-core 路径层)触发判定的纯函数 —— context.mjs 与
 * signoff-policy.test.mjs 共用同一份,防「触发判定」在 context 与测试之间漂移。
 * 只做**路径匹配事实**,不做 hold 决策(hold 判定唯一 owner=signoff-hold.mjs,编排只消费
 * 本函数输出的事实 + context.mjs 的语义定性字段)。arch 门完整判定(白名单 / diff 行数
 * 阈值 / 冷更 guard)留在 context.mjs,本函数只算 archGate.corePaths 的路径层命中。
 * 路径匹配语义与 mivo 既有消费方一致:
 *   - security:securityReviewPaths 为正则片段数组,join('|') 后整体 test(与 context.mjs
 *     SECURITY_REVIEW_RE 同一口径);空数组 = 门关闭,恒不命中;
 *   - rules:ruleFiles.required 为规则文档清单,`/` 结尾按前缀匹配、否则整路径相等
 *     (同 matchColdUpdatePaths 语义,防近邻文件误伤);ruleMap(规则文档 → 管辖路径映射,
 *     value 数组同样按该语义匹配)命中明细单独输出,供编排按目标仓库配置语义消费;
 *   - archCore:archGate.corePaths 前缀命中(目录语义,与 context.mjs ARCH_CORE_PATHS 一致)。
 * @param {{paths:string[], securityReviewPaths:string[], ruleFiles?:object|null,
 *   archCorePaths?:string[]}} o
 * @returns {{security:string[], rules:string[], ruleMapHits:Array<{doc:string, paths:string[]}>,
 *   archCore:string[]}}
 */
export function classifyGateHits({ paths = [], securityReviewPaths = [], ruleFiles = null, archCorePaths = [] } = {}) {
  const list = paths ?? [];
  const security = (securityReviewPaths ?? []).length
    ? list.filter((p) => new RegExp((securityReviewPaths ?? []).join('|')).test(p))
    : [];
  const required = (ruleFiles?.required ?? []).filter(Boolean);
  const matchOne = (p, pats) => (pats ?? []).some((pat) => (pat.endsWith('/') ? p.startsWith(pat) : p === pat));
  const rules = required.length ? list.filter((p) => matchOne(p, required)) : [];
  const ruleMap = (ruleFiles?.ruleMap ?? null) && typeof ruleFiles.ruleMap === 'object'
    ? Object.entries(ruleFiles.ruleMap).filter(([, pats]) => Array.isArray(pats))
    : [];
  const ruleMapHits = ruleMap
    .map(([doc, pats]) => ({ doc, paths: list.filter((p) => matchOne(p, pats)) }))
    .filter((h) => h.paths.length > 0);
  const archCore = (archCorePaths ?? []).length
    ? list.filter((p) => (archCorePaths ?? []).some((c) => p.startsWith(c)))
    : [];
  return { security, rules, ruleMapHits, archCore };
}

// ── thread 代 resolve 的修复证据判定(assessThreadEvidence)──
// resolve-threads.mjs 只执行调用方给定的 payload;「意见是否已被处理」的语义判定在编排层
// (SKILL「thread 清理」),本函数把判定核心做成可单测的纯函数。
// 2026-08-09 二轮对抗复审后降级(D1,不许再声称"语义绑定"):
//   - token 共现(claim 里的高特异度 token 出现在修复新增行里)只是**必要不充分条件**——
//     它只能证明"新增行提到了同一个名字",不能证明"新增行真的解决了 claim 描述的问题";
//     `evidence` 字段已改名 `token-cooccurrence`(原 `semantic-bound` 名不副实,已停用);
//   - 充分条件来自编排层的显式逐 thread 判断:调用方必须传入非空 `justification`
//     (编排层对"这条 diff 为什么回应了这条 claim"的针对性说明),co-occurrence 通过
//     但缺 justification 一律 `canResolve:false`(reason=justification-required),
//     不得只凭 token 命中就自动放行——这是本函数与 resolve-threads.mjs 执行层的双重
//     防线之一(defense-in-depth,执行层还会独立复核 justification 是否存在);
//   - 「同文件被后续 commit 触碰」/ isOutdated 同样只是必要线索,不是充分条件
//     (与上游 ff37d26 降级一致)——只有线索 → fail-closed 不动;
//   - 真人 thread 永不自动 resolve;未配置白名单 → 整体禁用;拿不准一律不动。

/** token 停用词(中英混排的审查意见里,这些词不构成针对性 claim)。 */
const THREAD_TOKEN_STOPWORDS = new Set([
  'the', 'and', 'this', 'that', 'with', 'from', 'have', 'has', 'for', 'not', 'are',
  'was', 'were', 'will', 'would', 'should', 'could', 'your', 'our', 'their', 'been',
  'being', 'when', 'what', 'which', 'there', 'here', 'use', 'using', 'used', 'after',
  'before', 'into', 'over', 'than', 'then', 'them', 'they', 'only', 'also', 'just',
  'still', 'even', 'about', 'because', 'error', 'issue', 'line', 'file', 'code',
  'fix', 'fixed', 'please', 'need', 'needs', 'make', 'sure', 'may', 'might', 'must',
  'add', 'added', 'remove', 'removed', 'change', 'changed', 'check', 'checked',
]);

/**
 * 从 thread 评论文本提取「针对性 token」,按特异度优先级排序:
 * 反引号段 > 双引号段 > 单引号段。**不含裸标识符正则**(2026-08-09 三审后砍掉——
 * 裸标识符对普通英文单词/常见变量名几乎不设特异度门槛,子串命中即可造出"证据",
 * 是 sc-thr-evidence 绕过的根因之一;只认经人手主动加引号/反引号强调过的片段)。
 * 长度 ≥ 3、剔除停用词与纯数字;去重保序。
 * @returns {string[]}
 */
export function extractThreadTokens(body) {
  const tokens = [];
  const seen = new Set();
  const push = (t) => {
    const s = String(t ?? '').trim();
    if (s.length < 3) return;
    if (/^\d+$/.test(s)) return;
    if (THREAD_TOKEN_STOPWORDS.has(s.toLowerCase())) return;
    if (seen.has(s)) return;
    seen.add(s);
    tokens.push(s);
  };
  for (const m of String(body ?? '').matchAll(/`([^`]+)`/g)) push(m[1]);
  for (const m of String(body ?? '').matchAll(/"([^"]+)"/g)) push(m[1]);
  for (const m of String(body ?? '').matchAll(/'([^']+)'/g)) push(m[1]);
  return tokens;
}

/** 判定证据确凿所需的最少独立高特异度 token 命中数(2026-08-09 三审后由 1 改为 2)。
 * 单 token 子串命中太容易被"提到同一个函数/变量名但完全无关"的新增行(如另一处
 * 测试断言、日志埋点)碰撞满足,不构成"针对性对应";要求 ≥2 个各自独立的强调
 * 片段都能在同一份修复新增行里找到落点,才降低到可接受的假阳性率。 */
const MIN_EVIDENCE_TOKEN_MATCHES = 2;

/**
 * 判「这条 thread 是否可以代 resolve」(白名单 bot + token 共现 + 编排层 justification)。
 * @param {{thread?:{path?:string, body?:string, isOutdated?:boolean, author?:string},
 *   authorType?:'bot'|'human', allowedBots?:string[], diff?:Array<{path:string, additions:string[]}>,
 *   justification?:string}} o
 *   diff = 当前 head 相对 base 的变更(按文件分组的新增行);调用方(编排层)从
 *   context.mjs 的 diff 数据 / git diff 派生。justification = 编排层对"这条 diff 为何
 *   回应了这条 claim"的显式针对性说明(必要不充分条件通过后的**充分条件**,缺失一律拒绝)。
 * @returns {{canResolve:boolean, reason:string, evidence?:string, matchedToken?:string,
 *   matchedLine?:string, pathTouched?:boolean, isOutdated?:boolean, justification?:string}}
 *   canResolve=true 仅当 evidence='token-cooccurrence' 且 justification 非空;其余一律
 *   false(不动,留人工)。
 */
export function assessThreadEvidence({
  thread = {}, authorType = 'human', allowedBots = [], diff = [], justification = '',
} = {}) {
  const path = String(thread?.path ?? '');
  const body = String(thread?.body ?? '');
  const isOutdated = thread?.isOutdated === true;
  if (authorType !== 'bot') {
    return { canResolve: false, reason: 'human-thread-never-auto' };
  }
  const botList = (allowedBots ?? []).map((s) => String(s).toLowerCase()).filter(Boolean);
  if (!botList.length) {
    return { canResolve: false, reason: 'triage-disabled(未配置 threadTriage.extraBots)' };
  }
  const threadAuthor = String(thread?.author ?? '').toLowerCase();
  if (!threadAuthor || !botList.includes(threadAuthor)) {
    return { canResolve: false, reason: 'bot-not-in-whitelist', author: thread?.author ?? null };
  }
  const tokens = extractThreadTokens(body);
  const fileDiff = (diff ?? []).find((d) => d.path === path);
  const changedPaths = (diff ?? []).map((d) => d.path);
  const pathTouched = changedPaths.includes(path);
  // token 共现(必要不充分条件,D1):claim 里每个高特异度 token(反引号/引号段)
  // 各自独立在修复 diff 的**新增行**里找落点,要求 ≥MIN_EVIDENCE_TOKEN_MATCHES 个
  // *不同* token 都命中,才算这一层通过——单 token 子串命中太容易被无关行
  // (如另一处测试断言、日志埋点恰好提到同一个函数名)碰撞满足,不构成证据。
  // token 提取不到、或命中数不足 → fail-closed 不动。
  const matchedTokens = [];
  for (const tok of tokens) {
    for (const line of fileDiff?.additions ?? []) {
      if (line.includes(tok)) {
        matchedTokens.push({ token: tok, line: line.slice(0, 200) });
        break; // 同一 token 只记一次命中,不重复计数
      }
    }
  }
  if (matchedTokens.length >= MIN_EVIDENCE_TOKEN_MATCHES) {
    const hasJustification = String(justification ?? '').trim().length > 0;
    if (!hasJustification) {
      return {
        canResolve: false,
        reason: `justification-required(token 共现只命中 ${matchedTokens.length} 个独立 token,只是必要不充分条件——不代表已核实新增行确实解决了 claim 描述的问题;必须由编排层给出非空 justification 才可能判定证据确凿)`,
        matchedTokens: matchedTokens.map((m) => m.token),
        matchedToken: matchedTokens[0].token, matchedLine: matchedTokens[0].line,
        pathTouched, isOutdated,
      };
    }
    return {
      canResolve: true, evidence: 'token-cooccurrence',
      matchedTokens: matchedTokens.map((m) => m.token),
      matchedToken: matchedTokens[0].token, matchedLine: matchedTokens[0].line,
      justification: String(justification).trim(),
      pathTouched, isOutdated,
    };
  }
  if (matchedTokens.length > 0) {
    return {
      canResolve: false,
      reason: `single-token-match-insufficient(仅命中 ${matchedTokens.length} 个独立 token「${matchedTokens.map((m) => m.token).join('、')}」,要求 ≥${MIN_EVIDENCE_TOKEN_MATCHES} 个才判定证据确凿——单 token 子串命中可能只是无关行碰巧提到同一个名字)`,
      matchedToken: matchedTokens[0].token, matchedLine: matchedTokens[0].line,
      pathTouched, isOutdated,
    };
  }
  if (pathTouched) return { canResolve: false, reason: 'path-touched-only(同文件被触碰≠问题已处理)', pathTouched, isOutdated };
  if (isOutdated) return { canResolve: false, reason: 'outdated-only(isOutdated 只是线索,不单独构成证据)', pathTouched, isOutdated };
  return { canResolve: false, reason: 'no-evidence(拿不准,留人工)', pathTouched, isOutdated };
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
    // REVIEW_PR_SKILL_ROOT_OVERRIDE:测试专用缝(SC-D 复审修订)——让 skillRepoPull 在
    // 测试里指向 fixture 仓库,使"probe-only 不 pull / 正常轮会 pull"成为可实测的行为
    // (此前测试环境里 pull 天然 no-op,守卫删了测试照样绿)。生产不设置;误设的后果
    // 只是 best-effort 自更新指错地方,不触及任何 review/merge 判定。
    real = realpathSync(process.env.REVIEW_PR_SKILL_ROOT_OVERRIDE || SKILL_ROOT);
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
 * 读**远端**(origin/<defaultBranch>)上的 skill 仓文件并交给 predicate 判定。
 * 用途:push 成功但进程在 ack 前崩溃时,重放拿到 `nothing-to-push`,必须凭远端内容确认
 * 事实已落地才安全 ack(SC-R7 第 2 轮核验)。fail-closed:读不到即 { ok:false }。
 * @returns {{ ok: boolean, present?: boolean, error?: string }}
 */
export function readRemoteSkillFile(relPath, predicate, { timeoutMs = 20_000 } = {}) {
  const info = skillRepoInfo();
  if (!info) return { ok: false, error: 'not-a-git-repo' };
  const spec = info.skillRelPath === '.' ? relPath : `${info.skillRelPath}/${relPath}`;
  const fetched = git(['fetch', 'origin', info.defaultBranch, '--quiet'], { allowFail: true, cwd: info.gitRoot, timeoutMs });
  if (!fetched.ok) return { ok: false, error: `fetch 失败:${(fetched.stderr || '').trim().slice(0, 200)}` };
  const show = git(['show', `origin/${info.defaultBranch}:${spec}`], { allowFail: true, cwd: info.gitRoot, timeoutMs });
  if (!show.ok) return { ok: false, error: `远端读不到 ${spec}` };
  try {
    return { ok: true, present: predicate(show.stdout) === true };
  } catch (e) {
    return { ok: false, error: `远端内容解析失败:${String(e.message ?? e).slice(0, 160)}` };
  }
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
  // SC-R7(2026-08-05 核验):escapedHazards 段也必须合并——此前只合 entries,rebase 时
  // 会把远端或本地新登记的 hazard 整段丢掉。按 (repo, hazardId) 取并集,**不增条、不降级**
  // (active 不回退 pending-fix-merge;landed 不回退 pending),与 upsertHazard 同口径。
  // 第 2 轮核验:合并必须**方向无关**且状态与其附属元数据原子同源——一方 landed+target、
  // 另一方 pending+显式 promotionTarget:null 时,旧实现一个方向得 landed+null、反向得
  // landed+target(状态升级却被低态 payload 覆盖)。逻辑收敛到 mergeHazardPair 唯一实现,
  // 合完再走完整 schema 复验:形状不合就返回 null(交人工处理,不写出半坏的 ledger)。
  const hazards = new Map();
  for (const h of [...(Array.isArray(ours?.escapedHazards) ? ours.escapedHazards : []),
    ...(Array.isArray(theirs?.escapedHazards) ? theirs.escapedHazards : [])]) {
    if (!h?.hazardId) return null; // 结构不符预期,不冒险
    const key = `${h.repo ?? '(no-repo)'}|${h.hazardId}`;
    const cur = hazards.get(key);
    try {
      hazards.set(key, cur ? mergeHazardPair(cur, h) : { ...h });
    } catch { return null; } // 身份不一致等异常 → 整体 abort 转人工,不写半坏的 ledger
  }
  for (const h of hazards.values()) {
    const v = validateHazardShape(h);
    if (!v.ok) return null;
  }
  const out = { ...ours, entries: [...merged.values()] };
  if (hazards.size > 0 || ours?.escapedHazards !== undefined || theirs?.escapedHazards !== undefined) {
    out.escapedHazards = [...hazards.values()];
  }
  return `${JSON.stringify(out, null, 2)}\n`;
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

/** preview 分发版:写回主仓的能力已剥离;返回既有 skipped 形状,消费方按未提交处理。 */
export function skillRepoCommitPush() {
  return { ok: true, committed: false, pushed: false, skipped: 'dist-readonly' };
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
    const child = spawn(process.execPath, [scriptPath, ...args], {
      windowsHide: true,
      // 显式快照 env(顶部已 delete NODE_DEBUG):即使未来有人恢复 process.env,
      // 批量 spawn 的子脚本环境也保证剥离,纯 JSON stdout 不被调试行污染
      env: { ...process.env },
    });
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
