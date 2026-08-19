#!/usr/bin/env node
// refresh-lock.mjs — 心跳续期 review-pr 互斥锁(auto 长轮次防 TTL 被接管)。
//
// 背景:prepare.mjs 的锁 stale 判定是纯 TTL(60 分钟,从 startedAt 起算)。auto 批量
// 模式取消了单轮 PR 数量上限后,一轮跑超 60 分钟完全可能;锁一旦超龄,下一轮
// scheduler 的实例会判 stale 并接管,变成两个 auto 会话并发处理同一批 PR(重复评论、
// 竞态合并)。续期由 lock-heartbeat-daemon.mjs 在后台做;本脚本只给守护挂掉时的
// 人工补救,且冷却期内重复调用返回 skipped=cooldown,不再改锁——2026-08-18 巡审
// 把本脚本当等待循环打了 4660 次,每次都是一次 LLM 回合。
//
// 规则(--token 必传,值为 prepare.mjs 输出的 lock.token):
//   - 锁存在且 token 匹配、距上次心跳 ≥ 10 分钟 → 重写 startedAt,refreshed=true;
//   - 锁存在且 token 匹配、距上次心跳 < 10 分钟 → skipped=cooldown,不改锁;
//   - 锁存在但 token 不匹配(含旧格式无 token 的锁)→ 已被别的实例接管,
//     refreshed=false, lost=true:调用方必须立即停止一切 GitHub 写操作并结束本轮,
//     且不要再调 release-lock(那是接管者的锁);
//   - 锁不存在(被误删,或接管者跑完释放了)→ 用原 token 原子重建,recreated=true,
//     本轮可以继续。
//
// 永远 exit 0(结果全在 JSON 字段),脚本自身参数错误才 exit 1。
// 跑:node <skill-root>/scripts/refresh-lock.mjs --token <t>

import { print, fail, LOCK_FILE } from './lib.mjs';
import { refreshOwnedSessionLock } from './lib.session-lock.mjs';

const i = process.argv.indexOf('--token');
const token = i >= 0 ? process.argv[i + 1] : undefined;
if (!token) fail('缺少 --token <prepare.mjs 输出的 lock.token>');

let refreshed = false;
let recreated = false;
let lost = false;
let skipped = null;
let ageMs = null;
let error = null;

try {
  const r = refreshOwnedSessionLock(LOCK_FILE, token);
  refreshed = r.refreshed;
  recreated = r.recreated;
  lost = r.lost;
  skipped = r.skipped;
  ageMs = r.ageMs;
} catch (e) {
  error = String(e && e.message ? e.message : e);
}

print({ ok: true, refreshed, recreated, lost, skipped, ageMs, error });
