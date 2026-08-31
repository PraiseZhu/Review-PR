#!/usr/bin/env node
// prepare.mjs — review-pr「环境与上下文准备」(只读 + 锁获取)
//
// 输出 repo 坐标 / gh 登录态 / working tree 是否干净 / 当前分支 / 默认分支 / 锁状态。
// 不做任何决策:LLM 读这些字段后自己判断(未登录 → 让用户 gh auth login;
// 脏 working tree → 提示用户处理,不自动 stash;locked → 退出)。
//
// 互斥锁:防止多个 review-pr 实例(scheduler 定时 + 手动)同时跑。
// 锁文件位于 Skill 外部、按目标仓库隔离的状态目录，内容为 JSON `{startedAt, token}`;
// 状态目录锚点按 git-common-dir 归一(见 lib.mjs `resolveStateAnchor`)——同一仓库的
// 主 worktree 与全部 linked worktree 共享同一份状态目录、同一把锁文件,不是各留一份。
// 获取用 flag:'wx'
// 原子独占创建,同一状态目录内两个实例同毫秒启动也只有一个能拿到。
// 锁按"仓库"归一,不是按"checkout"归一:同一仓库的另一个 checkout / worktree 上的
// 实例看到的是同一把锁,会被正常互斥挡住,不会重复拿锁。真正看不到这把锁、需要靠
// 操作约定(而非这把锁本身)避免并发的,只有另一台机器上的实例——见 SKILL.md 里
// 关于开发机 Syncthing 跨机并发的记录段落。
// stale 判定:**纯 TTL**——超过 60 分钟未释放判 stale,强制清除后重新获取。
// 不做 PID 存活判定:本脚本自身秒退,写自己的 PID 进锁文件毫无意义(下一轮
// `kill(pid, 0)` 永远 ESRCH → 永远判 stale → 锁形同虚设,2026-07 实锤);
// 而长命的持有者是上层 agent 进程,脚本拿不到它的 PID(父 shell 同样秒退)。
// TTL 60 分钟按 auto 批处理单轮上限留余量;auto 去掉批量数量上限后单轮可能超时,
// 长轮次由 lock-heartbeat-daemon.mjs 在后台续期(每 20 分钟一次),不要让主会话
// 用 refresh-lock.mjs 空转等待——2026-08-18 巡审把后者打了 4660 次 LLM 回合。
// 代价是异常崩溃后最多阻塞下一轮一小时,scheduler 会自动重试,可接受。
// token:acquire 成功时生成随机 token 写进锁文件并输出(lock.token);后续
// refresh-lock.mjs / release-lock.mjs / cleanup.mjs 都要带 --token,脚本只操作
// token 匹配的锁——防止"自己超时被接管后,又把接管者的新锁误删"造成双实例。
// 释放路径:cleanup.mjs(走完整清理) 或 release-lock.mjs(早退/异常路径)。
//
// 兼容旧格式:历史锁文件可能是 `{pid, startedAt}` JSON 或裸 ISO 时间戳,
// 一律只取 startedAt 做 TTL 判定;完全解析不出时间的直接判 stale(防死锁)。
//
// 跑:node <skill-root>/scripts/prepare.mjs

import { parseRepo, git, gh, print, fail, LOCK_FILE, releaseLockOwned, skillRepoPull } from './lib.mjs';
import { startLockHeartbeat, stopLockHeartbeat, parseLockStartedAt } from './lib.session-lock.mjs';
import { porcelainHasUserDirty } from './lib.gate-paths.mjs';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const LOCK_TTL_MS = 60 * 60 * 1000; // 60 minutes

const TAKEOVER_FILE = LOCK_FILE + '.takeover';
const TAKEOVER_TTL_MS = 60 * 1000; // 接管锁正常只持有毫秒级,60s 足够覆盖进程死在中间的自愈

/** 删除文件,不存在时静默(并发下别人可能已抢先删)。 */
function tryUnlink(file) {
  try {
    unlinkSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/** 读主锁当前内容;不存在返回 {present:false}。 */
function readLock() {
  let raw;
  try {
    raw = readFileSync(LOCK_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { present: false, raw: null, startedAt: null };
  }
  return { present: true, raw, startedAt: parseLockStartedAt(raw) };
}

/** 以 flag:'wx' 原子独占创建主锁;成功返回 true,已存在返回 false。 */
function tryCreateLock(payload) {
  try {
    writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

function acquireLock() {
  const token = randomUUID();
  const payload = JSON.stringify({ startedAt: new Date().toISOString(), token });

  // 快路径:原子独占创建。内核保证并发下只有一个实例 create 成功,
  // 消除旧实现 existsSync→write 的检查-写入竞态。
  if (tryCreateLock(payload)) return { acquired: true, stale: false, holder: null, token };

  const cur = readLock();
  if (!cur.present) {
    // 读的瞬间刚被持有者释放 → 再试一次;仍失败说明有人同时抢到,让锁
    if (tryCreateLock(payload)) return { acquired: true, stale: false, holder: null, token };
    return { acquired: false, stale: false, holder: null };
  }
  // 解析不出时间(损坏/未知格式)→ 判 stale,防止永久死锁
  const isStale = cur.startedAt == null || Date.now() - cur.startedAt >= LOCK_TTL_MS;
  if (!isStale) {
    return {
      acquired: false,
      stale: false,
      holder: cur.raw.trim(),
      holderStartedAt: new Date(cur.startedAt).toISOString(),
    };
  }

  // stale 接管走两段式:先独占"接管锁",再复核主锁、清除、重建。
  // 不能直接 unlink+create——两个实例同时判 stale 时,后动手的会把先动手的
  // 刚写入的新锁误删掉,变成双持有(并发实测踩过)。
  const takeover = (() => {
    try {
      const raw = readFileSync(TAKEOVER_FILE, 'utf8');
      const startedAt = parseLockStartedAt(raw);
      if (startedAt != null && Date.now() - startedAt < TAKEOVER_TTL_MS) return false; // 别人正在接管
      tryUnlink(TAKEOVER_FILE); // 接管锁本身 stale(进程死在中间)→ 清掉再抢
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    try {
      writeFileSync(TAKEOVER_FILE, payload, { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      return false;
    }
    // wx 成功后复核内容确为本实例写入:上面「stale 接管锁 → unlink → create」不是
    // 原子抢占,另一实例可能基于更早的 stale 读把我们刚建的接管锁误删重建
    // (与主锁当年踩过的 unlink+create 竞态同款)。内容不是自己的就退出竞争,
    // 避免两个实例同时自认持有接管锁 → 双持有主锁。
    try {
      return JSON.parse(readFileSync(TAKEOVER_FILE, 'utf8')).token === token;
    } catch {
      return false;
    }
  })();
  if (!takeover) return { acquired: false, stale: true, holder: cur.raw.trim() };

  try {
    // 持有接管锁后复核:主锁可能已被别的实例接管重建(变新),那就不是我们的了
    const again = readLock();
    if (again.present) {
      const stillStale = again.startedAt == null || Date.now() - again.startedAt >= LOCK_TTL_MS;
      if (!stillStale) {
        return {
          acquired: false,
          stale: false,
          holder: again.raw.trim(),
          holderStartedAt: new Date(again.startedAt).toISOString(),
        };
      }
      tryUnlink(LOCK_FILE);
    }
    // 空档期可能被快路径的新实例抢先 create,抢不到就让锁
    if (tryCreateLock(payload)) return { acquired: true, stale: true, holder: null, token };
    return { acquired: false, stale: false, holder: null };
  } finally {
    tryUnlink(TAKEOVER_FILE);
  }
}

let lock = null;
try {
  lock = acquireLock();

  // Skill 自更新:交互模式不经过 pre-check 的 pull,这里兜底一次。只在拿到锁后 pull
  // (没拿到锁 = 别的实例在跑,不换它脚下的脚本);失败不阻塞,结果放进输出让 LLM 汇总。
  let skillSync = null;
  if (lock.acquired) {
    try { skillSync = skillRepoPull({ timeoutMs: 30_000 }); } catch { /* best-effort */ }
    try { startLockHeartbeat(LOCK_FILE, lock.token); } catch { /* 守护挂了仍可靠 refresh-lock 冷却补救 */ }
  }

  const repo = parseRepo();
  const ghAuth = gh(['auth', 'status'], { allowFail: true }).ok;
  const porcelain = git(['status', '--porcelain']).stdout.trim();
  const worktreeClean = !porcelainHasUserDirty(porcelain);
  let currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();

  // 默认分支:origin/HEAD → refs/remotes/origin/<branch>;解析不到兜底 main
  let defaultBranch = 'main';
  const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (sym.ok && sym.stdout.trim()) {
    defaultBranch = sym.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  }

  // tracking 分支远端已删时,ff-only pull 会整轮 sync-failed。工作区干净才切到
  // origin/<default>(不审不写 GitHub);脏树或切不过仍标 syncFailed,由上层 fail-closed。
  let trackingRecovered = false;
  let syncFailed = null;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFail: true });
  if (upstream.ok) {
    const remoteRef = upstream.stdout.trim(); // 如 origin/fix/foo
    const ls = git(['ls-remote', '--heads', 'origin', remoteRef.replace(/^origin\//, '')], { allowFail: true });
    const remoteGone = !ls.ok || !ls.stdout.trim();
    if (remoteGone && currentBranch !== defaultBranch && currentBranch !== 'HEAD') {
      if (!worktreeClean) {
        syncFailed = `tracking 分支远端已消失(${remoteRef}),工作区不干净,不自动切 ${defaultBranch}`;
      } else {
        const named = git(['checkout', '-q', defaultBranch], { allowFail: true });
        if (!named.ok) {
          const detached = git(['checkout', '-q', '--detach', `origin/${defaultBranch}`], { allowFail: true });
          if (!detached.ok) {
            syncFailed = `tracking 分支远端已消失(${remoteRef}),切 ${defaultBranch} 失败`;
          } else {
            trackingRecovered = true;
            currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
          }
        } else {
          trackingRecovered = true;
          currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
        }
      }
    }
  }

  print({
    ok: true,
    lock,
    skillSync,
    repo,
    ghAuth,
    worktreeClean,
    dirtyFiles: worktreeClean ? [] : porcelain.split('\n').filter((line) => porcelainHasUserDirty(line)),
    currentBranch,
    defaultBranch,
    trackingRecovered,
    syncFailed,
  });
} catch (e) {
  // 拿到锁之后才失败(不是 git 仓库 / origin 缺失…)必须回滚自己的锁,
  // 否则这一轮啥也没干却让后续 60 分钟内的所有轮次全被 lock-held 拦掉。
  if (lock?.acquired && lock.token) {
    try { stopLockHeartbeat(LOCK_FILE, lock.token); } catch { /* 回滚失败只能等 TTL,不掩盖原始错误 */ }
    try { releaseLockOwned(lock.token); } catch { /* 回滚失败只能等 TTL,不掩盖原始错误 */ }
  }
  fail(e);
}
