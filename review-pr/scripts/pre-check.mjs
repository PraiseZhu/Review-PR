#!/usr/bin/env node
// pre-check.mjs — review-maker-pr 定时任务的前置检查(scheduler pre-run hook,只读)
//
// 被 scheduler 的 preRunHook 以 Skill 安装目录下的绝对路径引用，在 agent 会话创建
// **之前**由桌面端主进程执行；目标仓库来自 scheduler workingDir，或显式
// --repo-root / REVIEW_PR_REPO_ROOT。
//
// 协议(apps/desktop/src/main/scheduler-host/pre-run-hook.ts):
//   exit 2 = 跳过本轮(不创建会话,零 token);exit 0 = 放行;
//   其它退出码 / 超时 / spawn 失败 → 宿主 **fail-open** 仍会创建会话(平台设计契约,
//   非本 skill 可控;pre-run-hook.ts 的 executePreRunHook() 只把「明确 exit 2」判为
//   skip,其余(含超时树杀、spawn error、任意非 0/2 退出码)一律 decision:'run',理由
//   见其注释「fail-closed 会让脚本一坏任务就无声停摆」)。但 hook 异常不会绕过任何
//   review/merge gate:会话内 prepare.mjs 会重新获取统一锁并复查仓库 / gh / 工作树,
//   context.mjs / pick.mjs 会重算候选而不是复用 hook 的判断,因此本脚本挂掉最多只是
//   多起一轮空转会话(token 成本),不会让不该合并的 PR 绕过审查被合并。
//
// 只在「确定没活」时 exit 2:
//   1. review-pr 互斥锁被占(上一轮 auto 还在跑,TTL 60min 内)——对齐 skill auto
//      模式「锁被占 → 静默结束」的既定行为;只读探测,绝不获取 / 释放;
//   2. 仓库完全没有 open PR(连 draft 都没有)——判定与 pick.mjs 同源。⚠️ 只剩 draft 时
//      **不能**直接 skip:被产品/架构门 hold 的 PR 就是 draft,白名单在讨论 issue 里同意后
//      要靠 auto 轮自动放行(product-release.mjs),此时必须走下面的指纹判据而不是一票跳过;
//   3. 空转指纹一致:上轮 auto 扫描结论是「全 skip」(context.mjs --scan-all 落盘的
//      .last-scan.json),且当前 open PR 集合的状态指纹与落盘时逐字节一致(指纹算法与
//      落盘方共用 lib.mjs 的 fetchOpenPrSnapshot/computePrSetFingerprint,单一来源),
//      且落盘的 heldIssues(被 hold PR 的讨论 issue)逐条 updatedAt 未变——白名单同意
//      发生在 issue 上、不改 PR 自身状态,不显式比对 issue 会把「同意 → 自动放行」饿死。
//      即「上轮就没活干,之后又没有任何变化」。本脚本**只比对指纹、绝不重演 auto 分流
//      判定**:判定逻辑双份维护漂移的后果是漏审(不可接受),指纹误敏感的后果只是多跑
//      一轮(方向安全)。
//      强制心跳:state 落盘超过 HEARTBEAT_MS(6h)一律放行——停滞催办(≥24h 阈值)、
//      产品 issue sweep 这些**时间驱动**的动作恰恰在「PR 状态不变」时才触发,纯指纹
//      skip 会把它们饿死;它同时兜底「会话在扫描落盘后、放行动作前挂掉」的极端窗口。
//      ⚠️ 心跳基准只能用 state.savedAt(真 session 内落盘),不能用
//      宿主 stdin 的 lastFinishedAt——skip 轮次也会刷新它(见 pre-run-hook.ts 注释),
//      用它会永久自锁。
// 本脚本对“无法证明没活”的情况(有候选且指纹变了 / 无 state、gh 缺失 / 未登录、
// 网络失败、lib.mjs 异常…)显式 exit 0:「查不了」≠「没活」,让会话内 prepare.mjs /
// pick.mjs 复核并走飞书异常汇总。这是本业务脚本主动给出的“需要运行”结论——与宿主
// 对非零退出码 / 超时 / spawn 失败的 fail-open 兜底是同一个方向(都是「不确定就
// 放行」),只是触发路径不同:本脚本能跑到就自己判断该不该 exit 0;真跑不起来(语法
// 错误、文件不存在、spawn 失败等未形成任何正常退出的故障)时,交给宿主的 fail-open
// 兜底继续放行,不会被当成“阻止任务”处理。
//
// 会话内的 pick.mjs / prepare.mjs 照旧执行(hook 输出到不了会话,且 hook 通过到会话
// 启动之间 PR 集合可能变化);本脚本只省掉「起一个 agent 会话才发现没活」的空转成本。
// 建议 schedule 配置显式 preRunHook.timeoutMs(如 60000)双保险——宿主协议「未配置 =
// 不限时」,本脚本虽自带 gh 超时,宿主侧超时兜底可防任何意外挂死拖着这次 fire 不放
// (超时后宿主树杀进程、fail-open 放行创建会话，不是「阻止本轮」；本脚本内部的 gh
// 超时则是自己捕获并显式 exit 0,两者是不同层级的兜底,不要混为一谈)。

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

const repoRootIndex = process.argv.indexOf('--repo-root');
const repoRootArg = repoRootIndex >= 0 ? process.argv[repoRootIndex + 1] : '';
const repoRoot = resolve(repoRootArg || process.env.REVIEW_PR_REPO_ROOT || process.cwd());

// Electron 主进程 spawn 出来的环境可能没有 shell profile 的 PATH(Finder 启动的 app),
// gh 常在 Homebrew 路径下;补齐后再跑,补了仍找不到就按“无法证明没活”显式放行。
if (process.platform !== 'win32') {
  process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin']
    .filter(Boolean)
    .join(delimiter);
}

const LOCK_TTL_MS = 60 * 60 * 1000; // 与 prepare.mjs 的 TTL 一致
const HEARTBEAT_MS = 6 * 60 * 60 * 1000; // 指纹 skip 的强制心跳:state 超龄一律放行(见文件头)

/** 把锁文件里的 startedAt 解成 ms。实际写入格式是 JSON {startedAt: ISO 字符串}
 *  (prepare.mjs 写入);兼容 number(ms)与历史裸 ISO。解析不出返 null。 */
function parseStartedAt(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const v = JSON.parse(trimmed).startedAt;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const ms = Date.parse(v);
        return Number.isNaN(ms) ? null : ms;
      }
    } catch {
      /* 解析失败 → null */
    }
    return null;
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/** 锁是否被有效持有。解析不出时间 / 超 TTL = stale = 视为未持有
 *  (放行,由会话内 prepare 清理重取)。 */
function lockHeld(lockFile) {
  let raw;
  try {
    raw = readFileSync(lockFile, 'utf8');
  } catch {
    return false; // 锁文件不存在 = 没人在跑
  }
  const startedAt = parseStartedAt(raw);
  if (startedAt == null) return false;
  return Date.now() - startedAt < LOCK_TTL_MS;
}

/** 输出 skip 决策并 exit 2。 */
// skill 仓自同步的诊断,skip / run 两条出口都要带上——分叉这类「不会自愈」的故障若只在
// run 分支上报,恰好赶上没有 open PR 的空转轮就永远没人知道(2026-07-31 实测:分叉静默
// 一天多才被人翻仓发现)。
let skillSyncReport = null;
// 分叉时强制放行一轮,让会话内流程把它写进 6.1 汇总并经播报出口推给 owner。
// 同一分叉状态只强制一次(按 本地 HEAD:远端 HEAD 去重),避免每轮(1h 网格)空转烧 token。
let forceRunReason = null;
// --probe-only(SC-D,2026-08-04 #469 复盘):真只读探测模式,给"验证调度/改频"场景用。
// 为什么需要:本脚本自称 precheck,实际有三类副作用——skillRepoPull(改 skill 仓工作区)、
// notify-merge-backfill(可能对外发合并致谢)、.skill-diverged 状态写入。#469 当天,mini 上
// 按验收清单"手动触发一轮验证"的操作正是撞上了这些副作用的同类问题(计划外实例做了
// 不可逆写操作)。--probe-only 下:跳过 skill pull、跳过 backfill、跳过一切本地状态写,
// 只跑候选/指纹判定并输出 decision JSON(附 probeOnly:true 标记)。
const PROBE_ONLY = process.argv.includes('--probe-only');
// 轮次开始的 pending hazard 重放结果(第 4 轮核验:重放先于持久 skip,skip 输出也要带上)
let hazardReplay = null;

function skip(reason, extra = {}) {
  if (forceRunReason) {
    process.stdout.write(JSON.stringify({ decision: 'run', reason: forceRunReason, skipReason: reason, skillSync: skillSyncReport }) + '\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ decision: 'skip', reason, ...(skillSyncReport ? { skillSync: skillSyncReport } : {}), ...(hazardReplay ? { hazardReplay } : {}), ...(process.argv.includes('--probe-only') ? { probeOnly: true } : {}), ...extra }) + '\n');
  process.exit(2);
}

try {
  // 候选判定与 pick.mjs 同源:复用 lib.mjs 的 gh / parseRepo。动态 import——
  // lib.mjs 异常时进 catch 给出显式 run 结论,而不是模块加载期炸成 exit 1。
  process.env.REVIEW_PR_REPO_ROOT = repoRoot;
  process.chdir(repoRoot);
  // 复审修订(2026-08-04):probe-only 必须在 **import lib.mjs 之前**声明只读——lib 模块
  // 加载期有写探针/mkdir/legacy 迁移三类副作用,"业务层跳过写"挡不住 import 层
  // (REVIEW_PR_LIB_READONLY 的语义见 lib.mjs resolvePersistentStateRoot 注释)。
  if (PROBE_ONLY) process.env.REVIEW_PR_LIB_READONLY = '1';
  else delete process.env.REVIEW_PR_LIB_READONLY; // 防父环境残留把生产轮误拖进只读初始化
  const { gh, run, parseRepo, fetchOpenPrSnapshot, computePrSetFingerprint, SCAN_STATE_FILE, LOCK_FILE, skillRepoPull } =
    await import(new URL('./lib.mjs', import.meta.url));
  if (lockHeld(LOCK_FILE)) skip('lock-held');
  // Skill 自更新:会话创建之前 pull,新会话读到的 SKILL.md / 脚本就是最新版。
  // 放在 lock-held 之后——有轮次正在跑时不换它脚下的脚本。失败不拦本轮(best-effort)。
  let skillSync = null;
  if (!PROBE_ONLY) {
    try { skillSync = skillRepoPull({ timeoutMs: 30_000 }); } catch { /* 自更新异常不影响调度判定 */ }
  }
  skillSyncReport = skillSync;
  // 分叉 = 自同步双向停摆,不会自愈(ff-pull 拉不动、push 非 ff 被拒)。台账类冲突已由
  // skillRepoCommitPush 自动收敛,走到这里的基本是真代码分歧,必须让人知道。
  if (skillSync?.diverged) {
    const sig = `${skillSync.head ?? skillSync.after ?? '?'}:${skillSync.remoteHead ?? '?'}`;
    const alertFile = `${SCAN_STATE_FILE}.skill-diverged`;
    let alerted = null;
    try { alerted = readFileSync(alertFile, 'utf8').trim(); } catch { /* 首次 */ }
    if (alerted !== sig) {
      try { writeFileSync(alertFile, `${sig}\n`); } catch { /* 写不了就每轮都报,宁吵不哑 */ }
      forceRunReason = 'skill-repo-diverged';
    }
  }
  // 合并致谢补发:**必须在这里跑,不能只挂在 auto 轮内**。本脚本每次调度都执行,而 auto 轮
  // 在「没有 open PR」时会 exit 2 跳过——可一批 PR 刚全部合完、open 清零,正是最该发致谢的
  // 时刻(2026-07-31 实测:16:00 那轮因 open PR 归零被跳过,5 个已合并 PR 一条致谢都没发)。
  // 把它放在跳过判定之前,与「有没有审查活」彻底解耦。
  // best-effort:脚本自身退出码恒 0、自带台账去重,异常也不影响本轮 run/skip 判定。
  if (!PROBE_ONLY) {
    try {
      run('node', [new URL('./notify-merge-backfill.mjs', import.meta.url).pathname], {
        allowFail: true, timeoutMs: 60_000,
      });
    } catch { /* 致谢发不出去绝不影响调度判定 */ }
  }

  // SC-R7 第 4 轮核验 BLOCKER:pending hazard 重放必须在 no-candidates /
  // unchanged-since-last-scan 两个**持久 skip 之前**跑——真实事故窗口恰是"fix merge 后
  // activation/push 失败,随后 open PR 归零":此前重放挂在 decision:'run' 出口上,这个
  // 窗口里每轮都 exit 2,inbox 永远没有生产重放时机(饿死)。lock-held 仍在其前(有轮次
  // 正跑时不并发动 canonical);幂等、失败留 inbox,不改变本脚本的 decision。
  // probe-only 零副作用契约不变:只在非 probe-only 跑。
  if (!PROBE_ONLY) {
    try {
      const r = spawnSync(process.execPath, [resolve(SCRIPTS_DIR, 'record-escaped-finding.mjs'), '--activate'], { encoding: 'utf8', timeout: 120_000 });
      if (r.error) throw r.error;
      if (!r.stdout || !r.stdout.trim()) throw new Error(`无输出(status=${r.status})`);
      const j = JSON.parse(r.stdout);
      hazardReplay = { activated: j.activated ?? [], pendingCount: (j.pending ?? []).length };
    } catch (e) {
      hazardReplay = { error: String(e.message ?? e).slice(0, 200), note: '条目留在 inbox,下轮再重放' };
    }
  }

  const { owner, repo } = parseRepo();
  const raw = JSON.parse(
    gh(
      ['pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'open', '--limit', '100', '--json', 'number,isDraft'],
      { timeoutMs: 30_000 }, // 网络卡死时自己超时进 fail-open,不等宿主树杀
    ).stdout || '[]',
  );
  const candidateCount = raw.filter((p) => !p.isDraft).length;
  // 只有「一个 open PR 都没有」才算确定没活;只剩 draft 时可能有被 hold 待放行的 PR,
  // 交给下面的指纹判据(含 heldIssues 比对)决定 skip 还是 run(文件头第 2 条)。
  if (raw.length === 0) skip('no-candidates');

  // 空转指纹比对(文件头第 3 条):内层独立 try——state 缺失 / 损坏 / 快照拉取失败都只是
  // 放弃这条判据继续放行,不影响外层「有候选 → run」的既有行为。
  try {
    const state = JSON.parse(readFileSync(SCAN_STATE_FILE, 'utf8'));
    if (
      state?.version === 1 && state.allSkip === true && typeof state.fingerprint === 'string' &&
      Array.isArray(state.heldIssues) // 旧格式 state 没有 heldIssues → 无法证明 issue 未变 → 放行
    ) {
      const savedAtMs = Date.parse(state.savedAt);
      if (!Number.isNaN(savedAtMs) && Date.now() - savedAtMs < HEARTBEAT_MS) {
        const fp = computePrSetFingerprint(fetchOpenPrSnapshot({ owner, repo, timeoutMs: 30_000 }));
        // heldIssues 逐条比对 updatedAt:白名单同意留言只动 issue、不动 PR 指纹,必须显式查。
        // 任何一条读不到 / 落盘值缺失 / 时间不一致 → 视为「有变化」并显式放行。
        const heldIssuesUnchanged = state.heldIssues.every((h) => {
          if (!h || typeof h.number !== 'number' || typeof h.updatedAt !== 'string') return false;
          const r = gh(['api', `repos/${owner}/${repo}/issues/${h.number}`], { allowFail: true, timeoutMs: 30_000 });
          if (!r.ok) return false;
          try {
            const cur = Date.parse(JSON.parse(r.stdout || '{}').updated_at ?? '');
            const saved = Date.parse(h.updatedAt);
            return !Number.isNaN(cur) && !Number.isNaN(saved) && cur === saved;
          } catch {
            return false;
          }
        });
        if (fp === state.fingerprint && heldIssuesUnchanged) {
          skip('unchanged-since-last-scan', { savedAt: state.savedAt, candidateCount, heldIssueCount: state.heldIssues.length });
        }
      }
    }
  } catch {
    /* 指纹判据不可用 → 无法证明没活，显式放行 */
  }

  process.stdout.write(JSON.stringify({ decision: 'run', candidateCount, skillSync, ...(hazardReplay ? { hazardReplay } : {}), ...(PROBE_ONLY ? { probeOnly: true } : {}) }) + '\n');
  process.exit(0);
} catch (e) {
  // 业务策略:无法证明没活时显式请求运行，让会话内流程复核并汇总异常。
  // 复审修订(2026-08-04):故障出口同样输出 decision JSON——probe-only 的契约是"总能拿到
  // 带 probeOnly:true 的 decision 结论",只写 stderr 会让手动验证者在最需要结论的故障
  // 场景反而拿不到承诺的输出。
  const msg = e && e.message ? e.message : String(e);
  console.error(`[pre-check] fallback-run: ${msg}`);
  process.stdout.write(JSON.stringify({ decision: 'run', reason: 'fallback-run', error: msg.slice(0, 300), ...(PROBE_ONLY ? { probeOnly: true } : {}) }) + '\n');
  process.exit(0);
}
