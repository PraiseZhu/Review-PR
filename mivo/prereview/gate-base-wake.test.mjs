// [MIVO-PATCH gate-bases] 门禁分支上线后的一次性重判:用真实的 wakeProtectedHoldOnce 源码(vm)+ Map 版读写,
// 连跑两次证明第二次不再唤醒(挡住的是标记文件,不是"第一次已经标过 retry"),并核对两个 protected 唤醒不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { toOutcomeWake } from '../lib/admission.mjs';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
const declaration = /^function wakeProtectedHoldOnce\(markerName[\s\S]*?^\}/m.exec(source)?.[0];
assert.ok(declaration, '找不到 wakeProtectedHoldOnce 源码');

const GATE_OPTIONS = { outcomes: ['dependency', 'retarget'], event: 'wake-gate-base' };

function makeWorld({ roundState, failStateWrite = false } = {}) {
  const files = new Map();
  const logs = [];
  const rsPath = join('/state', 'key', 'round-state.json');
  if (roundState !== undefined) files.set(rsPath, structuredClone(roundState));
  const sandbox = {
    CONFIG: { stateDir: '/state' }, join, toOutcomeWake,
    stateFile: (name) => `/mivo/${name}`, roundStateKey: () => 'key', nowIso: () => '2026-10-27T00:00:00Z',
    log: (event, data) => logs.push({ event, ...data }),
    readJson: (file, fallback) => (files.has(file) ? structuredClone(files.get(file)) : fallback),
    writeJson: (file, value) => {
      if (failStateWrite && file === rsPath) throw new Error('disk full');
      files.set(file, structuredClone(value));
    },
  };
  vm.runInNewContext(`${declaration}\nglobalThis.wake = wakeProtectedHoldOnce;`, sandbox);
  return { files, logs, rsPath, wake: (name, options) => sandbox.wake(name, options), state: () => files.get(rsPath) };
}

const initial = () => ({ version: 1, mode: 'review-only', prs: {
  1: { outcome: 'dependency', fingerprint: 'a' }, 2: { outcome: 'retarget', fingerprint: 'b' },
  3: { outcome: 'protected', fingerprint: 'c' }, 4: { outcome: 'findings', fingerprint: 'd' } } });

test('gate-base 唤醒:第一次只给 dependency/retarget 标 retry 并写标记,第二次(即使又出现新的 dependency)不再唤醒', () => {
  const world = makeWorld({ roundState: initial() });
  world.wake('gate-base-wake.json', GATE_OPTIONS);
  assert.equal(world.state().prs[1].retry, true);
  assert.equal(world.state().prs[2].retry, true);
  assert.equal(world.state().prs[3].retry, undefined, 'protected 不动');
  assert.equal(world.state().prs[4].retry, undefined);
  assert.deepEqual(world.logs, [{ event: 'wake-gate-base', prs: [1, 2] }]);
  const marker = world.files.get('/mivo/gate-base-wake.json');
  assert.equal(marker.done, true);
  assert.deepEqual(marker.wake, [1, 2]);
  // 下一轮出现一个新的 dependency 行:标记已写,不能再唤醒
  world.state().prs[9] = { outcome: 'dependency', fingerprint: 'z' };
  world.files.set(world.rsPath, structuredClone(world.state()));
  world.wake('gate-base-wake.json', GATE_OPTIONS);
  assert.equal(world.state().prs[9].retry, undefined, '第二次不唤醒');
  assert.equal(world.logs.length, 1, '第二次不再记日志');
});

test('gate-base 唤醒:写 round-state 失败时不写完成标记(下次还能重试)', () => {
  const world = makeWorld({ roundState: initial(), failStateWrite: true });
  assert.throws(() => world.wake('gate-base-wake.json', GATE_OPTIONS), /disk full/);
  assert.equal(world.files.has('/mivo/gate-base-wake.json'), false);
});

test('gate-base 唤醒:没有 round-state 时也写标记;三个标记互相独立', () => {
  const world = makeWorld({});
  world.wake('gate-base-wake.json', GATE_OPTIONS);
  assert.deepEqual(world.files.get('/mivo/gate-base-wake.json').wake, []);
  assert.equal(world.files.has(world.rsPath), false);
  const full = makeWorld({ roundState: initial() });
  full.wake('protected-hold-wake.json');
  assert.deepEqual(full.logs, [{ event: 'wake-protected-hold', prs: [3] }], '原 protected 唤醒默认参数不变');
  full.wake('protected-author-release-wake.json');
  assert.equal(full.logs.length, 1, '第二个 protected 标记此时无可唤醒行(3 已标 retry)');
  full.wake('gate-base-wake.json', GATE_OPTIONS);
  assert.deepEqual(full.logs.at(-1), { event: 'wake-gate-base', prs: [1, 2] });
});

test('main 里按固定顺序跑三个标记,门禁标记用 dependency/retarget', () => {
  assert.match(source, /\['protected-hold-wake\.json', \{\}\], \['protected-author-release-wake\.json', \{\}\]/);
  assert.match(source, /\['gate-base-wake\.json', \{ outcomes: \['dependency', 'retarget'\], event: 'wake-gate-base' \}\]/);
});
