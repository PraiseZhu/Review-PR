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
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync, closeSync, readSync, writeSync, ftruncateSync } from 'node:fs';
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

function readFdUtf8(fd) {
  const chunks = [];
  const buf = Buffer.alloc(4096);
  let pos = 0;
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, pos);
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    pos += n;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function tokenFromRaw(raw) {
  try { return JSON.parse(raw).token ?? null; } catch { return null; }
}

// 打开当前路径上的 inode,核验 token 后再写这个 fd。
// takeover 是 unlink+wx create,新锁是新 inode;旧 fd 再写只污染已被 unlink 的旧文件,
// 路径上的新锁不受影响。这是「按路径 truncate/write 会盖掉接管者」的根治。
export function writeOwnedSessionLock(lockFile, token, startedAt = new Date()) {
  let fd;
  try {
    fd = openSync(lockFile, 'r+');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, lost: true };
    throw e;
  }
  try {
    const raw = readFdUtf8(fd);
    if (tokenFromRaw(raw) !== token) return { ok: false, lost: true };
    const payload = sessionLockPayload(token, startedAt);
    ftruncateSync(fd, 0);
    writeSync(fd, payload, 0, 'utf8');
    return { ok: true, lost: false };
  } finally {
    try { closeSync(fd); } catch { /* 已关 */ }
  }
}

function rewriteIfOwner(lockFile, token, now) {
  return writeOwnedSessionLock(lockFile, token, now);
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

// sidecar pid 文件的内容格式:{pid, token} JSON。token 是这条心跳记录自证的归属,
// 判断"能不能杀它"只认这个字段,不借道锁文件当前 token 做代理判断——那样会在
// "读锁文件 token"和"读 pid 文件"这两次独立读之间留出窗口:旧 owner 的检查刚通过,
// 接管者的新心跳就把同一份 pid 文件覆盖成自己的,旧 owner 随后按"检查已通过"直接
// 杀掉读到的 pid,实际杀的是接管者刚起的新守护(2026-08-18 review 发现的 P1)。
// legacy 纯 pid 格式(无 token)一律当"不知道归属",带 expectedToken 校验时永远不匹配,
// 拒绝动手——比"猜它是谁的"更安全。
function readHeartbeatRecord(lockFile) {
  let raw;
  try {
    raw = readFileSync(heartbeatPidPath(lockFile), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { pid: null, token: null };
    throw e;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const pid = Number.parseInt(parsed.pid, 10);
      return {
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        token: typeof parsed.token === 'string' ? parsed.token : null,
      };
    } catch {
      return { pid: null, token: null }; // 坏 JSON,一律当无主
    }
  }
  const pid = Number.parseInt(trimmed, 10); // legacy 裸 pid 格式
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, token: null };
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
  const path = heartbeatPidPath(lockFile);
  // 一次读取,pid 与 token 同源同时刻——不再分两步查两个不同文件(锁文件 token / pid 文件),
  // 那种两步查法在两次读之间留出窗口:旧 owner 的检查刚通过,接管者的新心跳就把同一份
  // pid 文件覆盖成自己的,旧 owner 随后按"检查已通过"直接杀掉读到的 pid,实际杀的是接管者
  // 刚起的新守护(2026-08-18 review 发现的 P1)。给了 expectedToken 就只信任这条记录自带的
  // token,不再借道锁文件当前 token 做代理判断。
  const rec = readHeartbeatRecord(lockFile);
  if (expectedToken && rec.token !== expectedToken) {
    return { stopped: false, killed: false, pid: null, skipped: 'not-owner' };
  }
  const pid = rec.pid;
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
  writeFileSync(heartbeatPidPath(lockFile), JSON.stringify({ pid: child.pid, token }));
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
