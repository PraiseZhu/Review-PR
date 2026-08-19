// lib.session-lock.mjs — review-pr 主互斥锁(lock.json)的确定性协议。
//
// 2026-08-18 Mini 巡审会话把 refresh-lock.mjs 当成等待循环打了 4660 次,
// 每次都是一次 LLM 回合,cache_read 24.5 亿 token,单轮 $515。根因不是锁文件
// 写贵,是「等子 agent 时用 refresh-lock 空转」被模型当心跳协议执行。
//
// 修法:TTL 续期改由后台守护进程做;refresh-lock.mjs 对冷却期内的重复调用
// 返回 skipped=cooldown,不再改锁。主会话没有「再调一次就会有新信息」的激励。
//
// 本文件零依赖 lib.mjs,避免和 STATE_DIR 顶层求值缠在一起;调用方传入 lock 路径。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSION_LOCK_TTL_MS = 60 * 60 * 1000;
export const SESSION_LOCK_REFRESH_EVERY_MS = 20 * 60 * 1000;
export const SESSION_LOCK_REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;
// 单轮硬上限:守护活过这个时长自动退出(不再续期),锁随后最多 60 分钟 TTL 自愈。
// 这是「巡审收尾必然停」的最终兜底——cleanup/release 都没跑到(会话被杀、宿主崩溃)
// 时,常驻进程也活不过它。3h = 观察到的最长正常轮次(~1.5h)× 2。
export const SESSION_LOCK_MAX_ROUND_MS = 3 * 60 * 60 * 1000;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DAEMON = join(SCRIPT_DIR, 'lock-heartbeat-daemon.mjs');

export function parseLockStartedAt(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const t = new Date(JSON.parse(trimmed).startedAt).getTime();
      return Number.isNaN(t) ? null : t;
    } catch {
      return null;
    }
  }
  const t = new Date(trimmed).getTime();
  return Number.isNaN(t) ? null : t;
}

export function readSessionLock(lockFile) {
  let raw;
  try {
    raw = readFileSync(lockFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { present: false, raw: null, token: null, startedAt: null };
    throw e;
  }
  let token = null;
  try { token = JSON.parse(raw).token ?? null; } catch { /* 旧格式无 token */ }
  return { present: true, raw, token, startedAt: parseLockStartedAt(raw) };
}

export function sessionLockPayload(token, startedAt = new Date()) {
  return JSON.stringify({ startedAt: new Date(startedAt).toISOString(), token });
}

export function tryCreateSessionLock(lockFile, payload) {
  try {
    writeFileSync(lockFile, payload, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

export function writeOwnedSessionLock(lockFile, token, startedAt = new Date()) {
  // 同目录 rename 覆盖是 POSIX 原子替换:不会出现半写文件,也不会先 unlink 再 create
  // 给别人留下 wx 窗口。inode 会换,但锁协议认的是路径上的 token,不是 inode。
  const tmp = `${lockFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, sessionLockPayload(token, startedAt));
  renameSync(tmp, lockFile);
}

function rewriteIfOwner(lockFile, token, now) {
  const again = readSessionLock(lockFile);
  if (!again.present || again.token !== token) {
    return { ok: false, lost: true };
  }
  writeOwnedSessionLock(lockFile, token, now);
  const check = readSessionLock(lockFile);
  if (check.token !== token) return { ok: false, lost: true };
  return { ok: true, lost: false };
}

export function refreshOwnedSessionLock(lockFile, token, {
  now = Date.now(),
  minIntervalMs = SESSION_LOCK_REFRESH_MIN_INTERVAL_MS,
} = {}) {
  let raw;
  try {
    raw = readFileSync(lockFile, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // 锁没了只允许 wx 重建;撞 EEXIST = 别人刚建好,视为丢锁,绝不覆盖
    if (!tryCreateSessionLock(lockFile, sessionLockPayload(token, now))) {
      return { refreshed: false, recreated: false, lost: true, skipped: null, ageMs: null };
    }
    return { refreshed: true, recreated: true, lost: false, skipped: null, ageMs: 0 };
  }

  let cur = null;
  try { cur = JSON.parse(raw).token ?? null; } catch { /* 旧格式 → 非本实例 */ }
  if (cur !== token) {
    return { refreshed: false, recreated: false, lost: true, skipped: null, ageMs: null };
  }

  const startedAt = parseLockStartedAt(raw);
  const ageMs = startedAt == null ? null : Math.max(0, now - startedAt);
  if (ageMs != null && ageMs < minIntervalMs) {
    return { refreshed: false, recreated: false, lost: false, skipped: 'cooldown', ageMs };
  }
  const wrote = rewriteIfOwner(lockFile, token, now);
  if (!wrote.ok) {
    return { refreshed: false, recreated: false, lost: true, skipped: null, ageMs };
  }
  return { refreshed: true, recreated: false, lost: false, skipped: null, ageMs };
}

export function heartbeatPidPath(lockFile) {
  return `${lockFile}.heartbeat.pid`;
}

function readHeartbeatPid(lockFile) {
  try {
    const n = Number.parseInt(readFileSync(heartbeatPidPath(lockFile), 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

export function stopLockHeartbeat(lockFile, expectedToken) {
  if (expectedToken) {
    const cur = readSessionLock(lockFile);
    // 锁不在或 token 对不上:都可能是别人的回合,不得按 sidecar pid 乱杀
    if (!cur.present || cur.token !== expectedToken) {
      return { stopped: false, killed: false, pid: null, skipped: 'not-owner' };
    }
  }
  const path = heartbeatPidPath(lockFile);
  const pid = readHeartbeatPid(lockFile);
  let killed = false;
  if (pid && isPidAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); killed = true; } catch { /* 已死 */ }
  }
  try { unlinkSync(path); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { stopped: true, killed, pid };
}

export function startLockHeartbeat(lockFile, token, {
  everyMs = SESSION_LOCK_REFRESH_EVERY_MS,
  maxLifetimeMs = SESSION_LOCK_MAX_ROUND_MS,
  daemonPath = DEFAULT_DAEMON,
  env = process.env,
} = {}) {
  stopLockHeartbeat(lockFile);
  const child = spawn(process.execPath, [
    daemonPath,
    '--lock-file', lockFile,
    '--token', token,
    '--every-ms', String(everyMs),
    '--max-lifetime-ms', String(maxLifetimeMs),
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...env },
  });
  child.unref();
  writeFileSync(heartbeatPidPath(lockFile), `${child.pid}\n`);
  return { started: true, pid: child.pid };
}

export function releaseOwnedSessionLock(lockFile, token) {
  stopLockHeartbeat(lockFile, token);
  if (!existsSync(lockFile)) {
    return { released: false, alreadyAbsent: true, notOwner: false };
  }
  const cur = readSessionLock(lockFile);
  if (token) {
    if (cur.token !== token) return { released: false, alreadyAbsent: false, notOwner: true };
  }
  try { unlinkSync(lockFile); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { released: true, alreadyAbsent: false, notOwner: false };
}
