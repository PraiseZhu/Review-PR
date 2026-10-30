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

test('新装没有配置文件:maxParallel / dailyCap 用默认 3 / 30;非法值报错', () => {
  const fresh = toInstallConfig(null, { ...args, instance: 'sandbox' });
  assert.equal(fresh.maxParallel, 3);
  assert.equal(fresh.dailyCap, 30);
  assert.equal(fresh.pollSeconds, 30);
  assert.equal(fresh.rulesFile, null);
  assert.deepEqual(toInstallConfig(null, { ...args, instance: 'x', maxParallel: '40', dailyCap: '400' }).maxParallel, 40);
  for (const bad of ['0', '-1', 'abc', '2.5']) {
    assert.throws(() => toInstallConfig(null, { ...args, instance: 'x', maxParallel: bad }), /--max-parallel/);
    assert.throws(() => toInstallConfig(null, { ...args, instance: 'x', dailyCap: bad }), /--daily-cap/);
  }
  assert.throws(() => toInstallConfig([], { ...args, instance: 'x' }), /JSON 对象/);
});
