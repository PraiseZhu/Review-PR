// Keep long, read-only planning alive under the same lease as the later queue.
// This never recreates a missing lock or adopts another owner's token.
import { fileURLToPath } from 'node:url';
import { spawnScriptJson } from './lib.mjs';

export async function startReviewHeartbeat(token, {
  intervalMs = 30_000,
  refresh = () => spawnScriptJson(fileURLToPath(new URL('./refresh-lock.mjs', import.meta.url)), ['--token', token], { timeoutMs: 20_000 }),
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (!token) throw new Error('planner 心跳缺少本轮 token');
  let failure = null;
  let inFlight = null;
  let stopped = false;
  const assertHealthy = () => { if (failure) throw failure; };
  const pulse = () => {
    if (stopped || failure) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(refresh).then((result) => {
      if (result?.ok !== true || result.refreshed !== true || result.lost === true || result.error) {
        throw new Error(result?.error || (result?.lost ? 'review 锁已丢失' : 'review 锁续期失败'));
      }
    }).catch((error) => { failure = new Error(`planner 心跳失败: ${error.message}`); })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  await pulse();
  assertHealthy();
  const timer = setTimer(pulse, intervalMs);
  return {
    assertHealthy,
    async stop() {
      stopped = true;
      clearTimer(timer);
      if (inFlight) await inFlight;
      assertHealthy();
    },
  };
}
