#!/usr/bin/env node
// lock-heartbeat-daemon.mjs — 后台给 review-pr 主锁续期,不经过 LLM。
//
// prepare.mjs 拿到锁后拉起本进程;release-lock / cleanup 用 pid 文件杀掉。
// 自终止三条件(任一满足即退出,保证「巡审收尾后没有任何常驻进程」):
//   1. 锁文件消失 —— 释放即死亡信号,绝不重建(否则会复活刚释放的锁,
//      把后续整点轮次全部挡在 lock-held 外);
//   2. 锁 token 换人 —— 已被别的实例接管;
//   3. 寿命超过 --max-lifetime-ms(默认 3 小时) —— 兜底 cleanup/release 都没
//      跑到的崩溃路径:守护死后锁最多再活 60 分钟 TTL,下一整点自然接管,
//      不会出现"永续锁"把巡审永久锁死。
//
// 跑:node lock-heartbeat-daemon.mjs --lock-file <path> --token <t>
//     [--every-ms N] [--max-lifetime-ms N]

import {
  readSessionLock, writeOwnedSessionLock,
  SESSION_LOCK_REFRESH_EVERY_MS, SESSION_LOCK_MAX_ROUND_MS,
} from './lib.session-lock.mjs';

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const lockFile = flag('--lock-file');
const token = flag('--token');
const everyMs = Number(flag('--every-ms') || SESSION_LOCK_REFRESH_EVERY_MS);
const maxLifetimeMs = Number(flag('--max-lifetime-ms') || SESSION_LOCK_MAX_ROUND_MS);
if (!lockFile || !token) process.exit(1);
if (!Number.isFinite(everyMs) || everyMs < 1000) process.exit(1);
if (!Number.isFinite(maxLifetimeMs) || maxLifetimeMs < everyMs) process.exit(1);

const bornAt = Date.now();

const tick = () => {
  try {
    if (Date.now() - bornAt >= maxLifetimeMs) process.exit(0); // 条件 3:寿命到,停止续期
    const cur = readSessionLock(lockFile);
    if (!cur.present) process.exit(0); // 条件 1:锁已释放,绝不重建
    if (cur.token !== token) process.exit(0); // 条件 2:已被接管
    const again = readSessionLock(lockFile);
    if (!again.present || again.token !== token) process.exit(0);
    writeOwnedSessionLock(lockFile, token);
    const check = readSessionLock(lockFile);
    if (check.token !== token) process.exit(0); // 写入窗口内被接管,停跳不覆盖回去
  } catch {
    process.exit(0); // 任何异常都宁可停跳(锁 60 分钟后自愈),不留常驻进程
  }
};

tick();
setInterval(tick, everyMs);
