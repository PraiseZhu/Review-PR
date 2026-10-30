import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toInstallConfig } from './install-config.mjs';

const CLI = fileURLToPath(new URL('./install-config.mjs', import.meta.url));
const args = { repoRoot: '/m/repos/mivo', stateDir: '/m/state/mivo', target: 'xindong/mivo-canvas-plugin', mode: 'live', ref: 'main',
  logDir: '/m/logs/mivo', rules: '', maxParallel: '', dailyCap: '' };
// 和 Mini 现网配置同一组字段(2026-10-30 只读核对)
const live = { instance: 'mivo', repoRoot: '/m/repos/mivo', stateDir: '/m/state/mivo', targetRepo: 'xindong/mivo-canvas-plugin', mode: 'live',
  workflowRepo: 'xindong/mivo-canvas-plugin', workflowRef: 'main', logDir: '/m/logs/mivo', rulesFile: null,
  maxParallel: 10, dailyCap: 1000000, pollSeconds: 30, viewerLogin: 'PraiseZhu', branchProtectionCacheMs: 600000 };

test('SC6 已有配置时重跑 install-mini:原有字段的值不变,命令行没给的 maxParallel / dailyCap 保留(#142)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-config-'));
  try {
    const file = join(dir, 'mivo.json');
    writeFileSync(file, `${JSON.stringify(live, null, 2)}\n`);
    const r = spawnSync(process.execPath, [CLI, file, JSON.stringify(args)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), live);
    // 显式给了才改
    const again = spawnSync(process.execPath, [CLI, file, JSON.stringify({ ...args, maxParallel: '20' })], { encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...live, maxParallel: 20 });
    // 已有文件读不懂:报错退出,不覆盖
    writeFileSync(file, '{broken');
    const broken = spawnSync(process.execPath, [CLI, file, JSON.stringify(args)], { encoding: 'utf8' });
    assert.notEqual(broken.status, 0);
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SC6 sandbox 已有规则文件时重跑不带 --rules:rulesFile 保留;带了才改(#142 独立审查 P2)', () => {
  const sandbox = { ...live, instance: 'sandbox', mode: 'sandbox', rulesFile: '/m/skill/mivo/config/sandbox-pr-rules.json' };
  assert.equal(toInstallConfig(sandbox, { ...args, instance: 'sandbox', mode: 'sandbox' }).rulesFile, sandbox.rulesFile);
  assert.equal(toInstallConfig(sandbox, { ...args, instance: 'sandbox', mode: 'sandbox', rules: '/other.json' }).rulesFile, '/other.json');
  assert.equal(toInstallConfig(null, { ...args, instance: 'sandbox' }).rulesFile, null);
});

test('新装没有配置文件:maxParallel / dailyCap 用默认 3 / 30;非法值报错', () => {
  const fresh = toInstallConfig(null, { ...args, instance: 'sandbox' });
  assert.equal(fresh.maxParallel, 3);
  assert.equal(fresh.dailyCap, 30);
  assert.equal(fresh.pollSeconds, 30);
  assert.equal(fresh.rulesFile, null);
  assert.deepEqual(toInstallConfig(null, { ...args, instance: 'x', maxParallel: '40', dailyCap: '400' }).maxParallel, 40);
  for (const bad of ['0', '-1', 'abc', '2.5', 0, -1]) {
    assert.throws(() => toInstallConfig(null, { ...args, instance: 'x', maxParallel: bad }), /--max-parallel/);
    assert.throws(() => toInstallConfig(null, { ...args, instance: 'x', dailyCap: bad }), /--daily-cap/);
  }
  assert.throws(() => toInstallConfig([], { ...args, instance: 'x' }), /JSON 对象/);
  // 和 round.mjs 启动校验同一范围:写出的配置一定能启动
  assert.throws(() => toInstallConfig(null, { ...args, instance: 'x', maxParallel: '41' }), /--max-parallel 须是1–40 的整数:"41"/);
  assert.throws(() => toInstallConfig(null, { ...args, instance: 'x', dailyCap: '9007199254740993' }), /--daily-cap/);
  assert.throws(() => toInstallConfig({ ...live, maxParallel: 41 }, { ...args, instance: 'mivo' }), /已有配置的 maxParallel/);
  assert.throws(() => toInstallConfig({ ...live, dailyCap: 0 }, { ...args, instance: 'mivo' }), /已有配置的 dailyCap/);
  // null 不当「没给」:已有配置里的 null、显式传 null 都报错,不悄悄改成默认值(复审 P2)
  assert.throws(() => toInstallConfig({ ...live, maxParallel: null }, { ...args, instance: 'mivo' }), /已有配置的 maxParallel/);
  assert.throws(() => toInstallConfig({ ...live, dailyCap: null }, { ...args, instance: 'mivo' }), /已有配置的 dailyCap/);
  assert.throws(() => toInstallConfig(null, { ...args, instance: 'x', maxParallel: null }), /--max-parallel/);
  assert.throws(() => toInstallConfig(null, { ...args, instance: 'x', dailyCap: null }), /--daily-cap/);
});
