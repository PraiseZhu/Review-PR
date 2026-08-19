#!/usr/bin/env node
// release-lock.mjs — 幂等释放 review-pr 互斥锁。
//
// 用途:任何不走 cleanup.mjs 的早退路径(prepare 失败、no-PR、auto 模式 prepare 异常、
// 候选全跳后异常退出等)都调它来主动释放锁,避免死锁等 60 分钟 TTL 才被清。
// --token <t>:prepare.mjs 输出的 lock.token。带 token 时只释放归属匹配的锁——
// 自己超时被别的实例接管后再调本脚本,不会误删接管者的新锁(notOwner=true)。
// 不带 token 保持旧行为(存在就删),仅兼容老调用方;新流程一律带 token。
// 行为:存在就删、不存在就 no-op,永远 exit 0(失败也只在字段里报告,不阻断流程)。
//
// 跑:node <skill-root>/scripts/release-lock.mjs [--token <t>]

import { print, releaseLockOwned, LOCK_FILE } from './lib.mjs';
import { stopLockHeartbeat } from './lib.session-lock.mjs';

const i = process.argv.indexOf('--token');
const token = i >= 0 ? process.argv[i + 1] : undefined;

let result;
try {
  stopLockHeartbeat(LOCK_FILE);
  result = releaseLockOwned(token);
} catch (e) {
  result = { released: false, alreadyAbsent: false, notOwner: false, error: String(e && e.message ? e.message : e) };
}

print({ ok: true, error: null, ...result });
