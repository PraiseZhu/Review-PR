// #167 上线后的一次性重判:此前只剩机器人 thread、静默期没过的 PR 被记成 threads-unresolved(不重试),指纹没变就一直是 unchanged。
// 用真实的 wakeProtectedHoldOnce 源码(vm)+ Map 版读写:首次运行给每个 threads-unresolved 行标 retry,标记写 done 后不再唤醒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { toOutcomeWake } from '../lib/admission.mjs';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
const declaration = /^function wakeProtectedHoldOnce\(markerName[\s\S]*?^\}/m.exec(source)?.[0];
assert.ok(declaration, '找不到 wakeProtectedHoldOnce 源码');

const MARKER = 'threads-unresolved-wake.json';
const OPTIONS = { outcomes: ['threads-unresolved'], event: 'wake-threads-unresolved' };

function makeWorld(roundState) {
  const files = new Map();
  const logs = [];
  const rsPath = join('/state', 'key', 'round-state.json');
  files.set(rsPath, structuredClone(roundState));
  const sandbox = {
    CONFIG: { stateDir: '/state' }, join, toOutcomeWake,
    stateFile: (name) => `/mivo/${name}`, roundStateKey: () => 'key', nowIso: () => '2026-11-03T00:00:00Z',
    log: (event, data) => logs.push({ event, ...data }),
    readJson: (file, fallback) => (files.has(file) ? structuredClone(files.get(file)) : fallback),
    writeJson: (file, value) => { files.set(file, structuredClone(value)); },
  };
  vm.runInNewContext(`${declaration}\nglobalThis.wake = wakeProtectedHoldOnce;`, sandbox);
  return { files, logs, rsPath, wake: () => sandbox.wake(MARKER, OPTIONS), state: () => files.get(rsPath) };
}

const initial = () => ({ version: 1, mode: 'review-only', prs: {
  1: { outcome: 'threads-unresolved', fingerprint: 'a' }, 2: { outcome: 'threads-unresolved', fingerprint: 'b', retry: true },
  3: { outcome: 'bot-pending', fingerprint: 'c' }, 4: { outcome: 'ci-failed', fingerprint: 'd' }, 5: { outcome: 'findings', fingerprint: 'e' } } });

test('threads-unresolved 唤醒:首次运行给每个 threads-unresolved 行标 retry,其它 outcome 不动;写 done 后再次运行唤醒列表为空', () => {
  const world = makeWorld(initial());
  world.wake();
  assert.equal(world.state().prs[1].retry, true);
  assert.equal(world.state().prs[2].retry, true);
  for (const pr of [3, 4, 5]) assert.equal(world.state().prs[pr].retry, undefined, `PR ${pr} 不动`);
  assert.deepEqual(world.logs, [{ event: 'wake-threads-unresolved', prs: [1] }], '已带 retry 的行不重复计入');
  const marker = world.files.get(`/mivo/${MARKER}`);
  assert.equal(marker.done, true);
  assert.deepEqual(marker.wake, [1]);
  // 下一轮又出现 threads-unresolved 行:标记已 done,唤醒列表为空。
  world.state().prs[9] = { outcome: 'threads-unresolved', fingerprint: 'z' };
  world.files.set(world.rsPath, structuredClone(world.state()));
  world.wake();
  assert.equal(world.state().prs[9].retry, undefined);
  assert.deepEqual(world.files.get(`/mivo/${MARKER}`).wake, []);
  assert.equal(world.logs.length, 1);
});

test('main 按固定顺序加跑第四个标记,用 threads-unresolved', () => {
  assert.match(source, /\['gate-base-wake\.json', \{ outcomes: \['dependency', 'retarget'\], event: 'wake-gate-base' \}\],\s*\['threads-unresolved-wake\.json', \{ outcomes: \['threads-unresolved'\], event: 'wake-threads-unresolved' \}\]/);
});
