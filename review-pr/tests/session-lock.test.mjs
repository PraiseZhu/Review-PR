#!/usr/bin/env node
// session-lock.test.mjs — 主互斥锁冷却 + 后台心跳(2026-08-18 $515 空转续锁)。
//
// 跑:cd review-pr && node --test tests/session-lock.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  parseLockStartedAt,
  refreshOwnedSessionLock,
  sessionLockPayload,
  startLockHeartbeat,
  stopLockHeartbeat,
  heartbeatPidPath,
  isPidAlive,
  tryCreateSessionLock,
  writeOwnedSessionLock,
  SESSION_LOCK_REFRESH_MIN_INTERVAL_MS,
} from '../scripts/lib.session-lock.mjs';
import { freshTempDir } from './helpers.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const REFRESH = join(SCRIPTS, 'refresh-lock.mjs');

function writeLock(dir, token, startedAt) {
  const lockFile = join(dir, 'lock.json');
  writeFileSync(lockFile, sessionLockPayload(token, startedAt));
  return lockFile;
}

test('parseLockStartedAt: JSON / 裸 ISO / 坏数据', () => {
  const iso = '2026-08-18T13:00:00.000Z';
  assert.equal(parseLockStartedAt(JSON.stringify({ startedAt: iso, token: 't' })), Date.parse(iso));
  assert.equal(parseLockStartedAt(iso), Date.parse(iso));
  assert.equal(parseLockStartedAt('{'), null);
  assert.equal(parseLockStartedAt(''), null);
});

test('refreshOwnedSessionLock: 冷却期内同 token 不改锁', () => {
  const dir = freshTempDir('session-lock-');
  const t0 = Date.parse('2026-08-18T13:00:00.000Z');
  const lockFile = writeLock(dir, 'tok-a', t0);
  const before = readFileSync(lockFile, 'utf8');
  const r = refreshOwnedSessionLock(lockFile, 'tok-a', {
    now: t0 + 30_000,
    minIntervalMs: SESSION_LOCK_REFRESH_MIN_INTERVAL_MS,
  });
  assert.equal(r.skipped, 'cooldown');
  assert.equal(r.refreshed, false);
  assert.equal(r.lost, false);
  assert.equal(readFileSync(lockFile, 'utf8'), before);
  rmSync(dir, { recursive: true, force: true });
});

test('refreshOwnedSessionLock: 冷却过后同 token 续期', () => {
  const dir = freshTempDir('session-lock-');
  const t0 = Date.parse('2026-08-18T13:00:00.000Z');
  const later = t0 + SESSION_LOCK_REFRESH_MIN_INTERVAL_MS + 1;
  const lockFile = writeLock(dir, 'tok-a', t0);
  const r = refreshOwnedSessionLock(lockFile, 'tok-a', { now: later });
  assert.equal(r.refreshed, true);
  assert.equal(r.skipped, null);
  const started = JSON.parse(readFileSync(lockFile, 'utf8')).startedAt;
  assert.equal(Date.parse(started), later);
  rmSync(dir, { recursive: true, force: true });
});

test('refreshOwnedSessionLock: 锁已存在时 ENOENT 重建不得覆盖(wx/EEXIST→lost)', () => {
  const dir = freshTempDir('session-lock-');
  const lockFile = join(dir, 'lock.json');
  writeFileSync(lockFile, sessionLockPayload('owner', Date.now()));
  const before = readFileSync(lockFile, 'utf8');
  const r = refreshOwnedSessionLock(lockFile, 'intruder');
  assert.equal(r.lost, true);
  assert.equal(r.recreated, false);
  assert.equal(readFileSync(lockFile, 'utf8'), before);
  rmSync(dir, { recursive: true, force: true });
});

test('stopLockHeartbeat: 锁已不在时带 token 也不得按 sidecar pid 乱杀', () => {
  const dir = freshTempDir('session-lock-');
  const lockFile = join(dir, 'lock.json');
  writeFileSync(heartbeatPidPath(lockFile), `${process.pid}\n`);
  const r = stopLockHeartbeat(lockFile, 'old-owner');
  assert.equal(r.skipped, 'not-owner');
  assert.equal(r.stopped, false);
  assert.equal(existsSync(heartbeatPidPath(lockFile)), true);
  assert.equal(isPidAlive(process.pid), true);
  unlinkSync(heartbeatPidPath(lockFile));
  rmSync(dir, { recursive: true, force: true });
});

test('stopLockHeartbeat: 非 owner token 不得杀掉当前守护', () => {
  const dir = freshTempDir('session-lock-');
  const lockFile = writeLock(dir, 'owner', Date.now());
  writeFileSync(heartbeatPidPath(lockFile), `${process.pid}\n`);
  const r = stopLockHeartbeat(lockFile, 'old-owner');
  assert.equal(r.skipped, 'not-owner');
  assert.equal(r.stopped, false);
  assert.equal(existsSync(heartbeatPidPath(lockFile)), true);
  assert.equal(isPidAlive(process.pid), true);
  unlinkSync(heartbeatPidPath(lockFile));
  rmSync(dir, { recursive: true, force: true });
});

test('refreshOwnedSessionLock: token 不匹配 → lost,不改锁', () => {
  const dir = freshTempDir('session-lock-');
  const lockFile = writeLock(dir, 'owner', Date.now());
  const before = readFileSync(lockFile, 'utf8');
  const r = refreshOwnedSessionLock(lockFile, 'intruder');
  assert.equal(r.lost, true);
  assert.equal(r.refreshed, false);
  assert.equal(readFileSync(lockFile, 'utf8'), before);
  rmSync(dir, { recursive: true, force: true });
});

test('refresh-lock.mjs: 冷却期内 CLI 返回 skipped=cooldown', () => {
  const base = freshTempDir('session-lock-cli-');
  const stateDirBase = join(base, 'state-root');
  mkdirSync(stateDirBase, { recursive: true });
  const r = spawnSync(process.execPath, [REFRESH, '--token', 'tok-cli'], {
    cwd: base,
    encoding: 'utf8',
    env: {
      ...process.env,
      REVIEW_PR_REPO_ROOT: base,
      REVIEW_PR_STATE_DIR: stateDirBase,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const first = JSON.parse(r.stdout);
  assert.equal(first.ok, true);
  assert.ok(first.refreshed || first.recreated);

  const again = spawnSync(process.execPath, [REFRESH, '--token', 'tok-cli'], {
    cwd: base,
    encoding: 'utf8',
    env: {
      ...process.env,
      REVIEW_PR_REPO_ROOT: base,
      REVIEW_PR_STATE_DIR: stateDirBase,
    },
  });
  assert.equal(again.status, 0, again.stderr);
  const second = JSON.parse(again.stdout);
  assert.equal(second.skipped, 'cooldown');
  assert.equal(second.refreshed, false);
  rmSync(base, { recursive: true, force: true });
});

test('takeover unlink+wx 后旧 inode 写入不得覆盖新锁', () => {
  const dir = freshTempDir('session-lock-');
  const lockFile = writeLock(dir, 'tok-old', Date.now() - 30_000);
  // 旧 owner 已打开 inode 的等价:先拿到写权,再模拟 takeover 换 inode
  const oldWrite = () => writeOwnedSessionLock(lockFile, 'tok-old', Date.now());
  unlinkSync(lockFile);
  assert.equal(tryCreateSessionLock(lockFile, sessionLockPayload('tok-new', Date.now())), true);
  const r = oldWrite();
  assert.equal(r.lost, true);
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).token, 'tok-new');
  rmSync(dir, { recursive: true, force: true });
});

test('守护自终止①: 锁文件被释放后守护自动退出,绝不重建锁', async () => {
  const dir = freshTempDir('session-lock-daemon-');
  const lockFile = writeLock(dir, 'tok-die', Date.now());
  const started = startLockHeartbeat(lockFile, 'tok-die', { everyMs: 50 });
  await sleep(120);
  rmSync(lockFile); // 模拟 release-lock 释放
  await sleep(200);
  assert.equal(existsSync(lockFile), false, '守护不得重建已释放的锁');
  assert.equal(isPidAlive(started.pid), false, '锁消失后守护必须自杀');
  stopLockHeartbeat(lockFile); // 清 pid 文件
  rmSync(dir, { recursive: true, force: true });
});

test('守护自终止②: 锁被接管(token 换人)后守护自动退出,不覆盖接管者的锁', async () => {
  const dir = freshTempDir('session-lock-daemon-');
  const lockFile = writeLock(dir, 'tok-old', Date.now());
  const started = startLockHeartbeat(lockFile, 'tok-old', { everyMs: 50 });
  await sleep(120);
  const takeoverAt = Date.parse('2026-08-18T13:00:00.000Z');
  writeFileSync(lockFile, sessionLockPayload('tok-new', takeoverAt)); // 模拟接管
  await sleep(200);
  const after = JSON.parse(readFileSync(lockFile, 'utf8'));
  assert.equal(after.token, 'tok-new', '接管者的锁不得被旧守护覆盖');
  assert.equal(Date.parse(after.startedAt), takeoverAt, '接管者的 startedAt 不得被旧守护续期');
  assert.equal(isPidAlive(started.pid), false, '被接管后守护必须自杀');
  stopLockHeartbeat(lockFile);
  rmSync(dir, { recursive: true, force: true });
});

test('守护自终止③: 寿命超过 max-lifetime-ms 后自动退出(cleanup 没跑到的兜底)', async () => {
  const dir = freshTempDir('session-lock-daemon-');
  const lockFile = writeLock(dir, 'tok-ttl', Date.now());
  const started = startLockHeartbeat(lockFile, 'tok-ttl', { everyMs: 50, maxLifetimeMs: 150 });
  assert.equal(isPidAlive(started.pid), true);
  await sleep(400);
  assert.equal(isPidAlive(started.pid), false, '寿命到点守护必须自杀,不留常驻进程');
  stopLockHeartbeat(lockFile);
  rmSync(dir, { recursive: true, force: true });
});

test('startLockHeartbeat / stopLockHeartbeat: 守护续期后能被杀掉', async () => {
  const dir = freshTempDir('session-lock-daemon-');
  const t0 = Date.now() - 30_000;
  const lockFile = writeLock(dir, 'tok-hb', t0);
  const started = startLockHeartbeat(lockFile, 'tok-hb', { everyMs: 50 });
  assert.ok(started.pid > 0);
  assert.equal(isPidAlive(started.pid), true);
  await sleep(180);
  const after = JSON.parse(readFileSync(lockFile, 'utf8'));
  assert.ok(Date.parse(after.startedAt) >= t0);
  const stopped = stopLockHeartbeat(lockFile);
  assert.equal(stopped.stopped, true);
  assert.equal(existsSync(heartbeatPidPath(lockFile)), false);
  await sleep(50);
  assert.equal(isPidAlive(started.pid), false);
  rmSync(dir, { recursive: true, force: true });
});
