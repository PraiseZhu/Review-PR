import test from 'node:test';
import assert from 'node:assert/strict';
import { startReviewHeartbeat } from './review-heartbeat.mjs';

test('planner heartbeat waits for in-flight refresh and refuses completion after lock loss', async () => {
  let tick;
  let finish;
  let calls = 0;
  let cleared = 0;
  const heartbeat = await startReviewHeartbeat('round-owner', {
    refresh: async () => ++calls === 1 ? { ok: true, refreshed: true } : new Promise(resolve => { finish = resolve; }),
    setTimer: (callback, interval) => { tick = callback; assert.equal(interval, 30_000); return 123; },
    clearTimer: timer => { assert.equal(timer, 123); cleared++; },
  });
  heartbeat.assertHealthy();
  const pending = tick();
  assert.equal(tick(), pending); // A slow refresh never overlaps a second writer.
  await Promise.resolve();
  assert.equal(calls, 2);
  let stopped = false;
  const stop = heartbeat.stop().finally(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish({ ok: true, refreshed: false, lost: true });
  await assert.rejects(stop, /锁已丢失/);
  assert.equal(cleared, 1);
  assert.throws(() => heartbeat.assertHealthy(), /心跳失败/);
  await tick();
  assert.equal(calls, 2); // Lost/stopped leases are never recreated or retried.
});

test('an initial refresh failure prevents starting the timer or any collection', async () => {
  let scheduled = false;
  await assert.rejects(startReviewHeartbeat('round-owner', {
    refresh: async () => ({ ok: true, refreshed: false, error: 'disk error' }),
    setTimer: () => { scheduled = true; },
  }), /disk error/);
  assert.equal(scheduled, false);
});
