#!/usr/bin/env node
// refresh-lock.mjs — 心跳续期 review-pr 互斥锁(auto 长轮次防 TTL 被接管)。
//
// 背景:prepare.mjs 的锁 stale 判定是纯 TTL(60 分钟,从 startedAt 起算)。auto 批量
// 模式取消了单轮 PR 数量上限后,一轮跑超 60 分钟完全可能;锁一旦超龄,下一轮
// scheduler 的实例会判 stale 并接管,变成两个 auto 会话并发处理同一批 PR(重复评论、
// 竞态合并)。auto 模式每处理完一个 PR 调一次本脚本,把 startedAt 滚动到当前时间,
// TTL 语义就从「开轮起 60 分钟」变成「距最后一次心跳 60 分钟」;崩溃自愈上限不变。
//
// 规则(--token 必传,值为 prepare.mjs 输出的 lock.token):
//   - 锁存在且 token 匹配 → 重写 startedAt(token 不变),refreshed=true;
//   - 锁存在但 token 不匹配(含旧格式无 token 的锁)→ 已被别的实例接管,
//     refreshed=false, lost=true:调用方必须立即停止一切 GitHub 写操作并结束本轮,
//     且不要再调 release-lock(那是接管者的锁);
//   - 锁不存在(被误删,或接管者跑完释放了)→ 用原 token 原子重建,recreated=true,
//     本轮可以继续;重建撞上并发 create → lost=true,同上处理。
//
// 永远 exit 0(结果全在 JSON 字段),脚本自身参数错误才 exit 1。
// 跑:node <skill-root>/scripts/refresh-lock.mjs --token <t>

import { readFileSync, writeFileSync } from 'node:fs';
import { print, fail, LOCK_FILE } from './lib.mjs';

const i = process.argv.indexOf('--token');
const token = i >= 0 ? process.argv[i + 1] : undefined;
if (!token) fail('缺少 --token <prepare.mjs 输出的 lock.token>');

const payload = JSON.stringify({ startedAt: new Date().toISOString(), token });

let refreshed = false;
let recreated = false;
let lost = false;
let error = null;

try {
  let raw = null;
  try {
    raw = readFileSync(LOCK_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (raw == null) {
    // 锁没了:原子重建。撞 EEXIST 说明有并发实例刚建锁 → 我们已丢锁
    try {
      writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
      refreshed = true;
      recreated = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      lost = true;
    }
  } else {
    let cur = null;
    try { cur = JSON.parse(raw).token ?? null; } catch { /* 旧格式 → 非本实例 */ }
    if (cur === token) {
      writeFileSync(LOCK_FILE, payload);
      refreshed = true;
    } else {
      lost = true;
    }
  }
} catch (e) {
  error = String(e && e.message ? e.message : e);
}

print({ ok: true, refreshed, recreated, lost, error });
