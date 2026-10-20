// branch-protection-cache.test.mjs — branch-protection-cache 补丁:
// 设了 REVIEW_PR_BRANCH_PROTECTION_CACHE_MS 才缓存 probeBranchProtection 的成功结果;没设时每次都读。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK = mkdtempSync(join(tmpdir(), 'bp-cache-'));
process.env.REVIEW_PR_STATE_DIR = join(WORK, 'state');
const { probeBranchProtection, branchProtectionCacheMs } = await import('./lib.mjs');

// 规则读成功(空数组)、经典保护不存在(404):探测会返回一个对象,共 2 次 gh 调用。
function makeGh({ rulesOk = true } = {}) {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args[1]);
    if (args[1].includes('/rules/branches/')) return rulesOk ? { ok: true, stdout: '[]', stderr: '' } : { ok: false, stdout: '', stderr: 'HTTP 500' };
    return { ok: false, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
  };
  return { ghFn, calls };
}
const file = () => join(WORK, `cache-${Math.random().toString(36).slice(2)}.json`);

test('没设缓存变量:每次都读', () => {
  const g = makeGh();
  const cacheFile = file();
  assert.ok(probeBranchProtection('o/r', 'main', { ghFn: g.ghFn, env: {}, cacheFile }));
  assert.ok(probeBranchProtection('o/r', 'main', { ghFn: g.ghFn, env: {}, cacheFile }));
  assert.equal(g.calls.length, 4);
});

test('设了缓存变量:TTL 内第二次不再读,过期后重读', () => {
  const g = makeGh();
  const cacheFile = file();
  const env = { REVIEW_PR_BRANCH_PROTECTION_CACHE_MS: '600000' };
  let now = 1_000_000;
  const first = probeBranchProtection('o/r', 'main', { ghFn: g.ghFn, env, now: () => now, cacheFile });
  now += 599_999;
  const second = probeBranchProtection('o/r', 'main', { ghFn: g.ghFn, env, now: () => now, cacheFile });
  assert.deepEqual(second, first);
  assert.equal(g.calls.length, 2, 'TTL 内只读了一次(2 次 gh 调用)');
  now += 2;
  probeBranchProtection('o/r', 'main', { ghFn: g.ghFn, env, now: () => now, cacheFile });
  assert.equal(g.calls.length, 4, '过期后重读');
});

test('不同分支、不同仓各自缓存;仓名大小写不敏感', () => {
  const g = makeGh();
  const cacheFile = file();
  const env = { REVIEW_PR_BRANCH_PROTECTION_CACHE_MS: '600000' };
  const opts = { ghFn: g.ghFn, env, now: () => 5, cacheFile };
  probeBranchProtection('o/r', 'main', opts);
  probeBranchProtection('o/r', 'release', opts);
  probeBranchProtection('x/y', 'main', opts);
  assert.equal(g.calls.length, 6);
  probeBranchProtection('O/R', 'main', opts);
  assert.equal(g.calls.length, 6, '仓名大小写不同仍命中同一条缓存');
});

test('fresh:做决定的调用方不读缓存,但把新结果写回缓存', () => {
  const g = makeGh();
  const cacheFile = file();
  const env = { REVIEW_PR_BRANCH_PROTECTION_CACHE_MS: '600000' };
  probeBranchProtection('o/r', 'main', { ghFn: g.ghFn, env, now: () => 10, cacheFile });
  assert.equal(g.calls.length, 2);
  probeBranchProtection('o/r', 'main', { ghFn: g.ghFn, env, now: () => 20, cacheFile, fresh: true });
  assert.equal(g.calls.length, 4, 'fresh 一定重读');
  assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8'))['o/r#main'].at, 20, '新结果写回缓存');
  probeBranchProtection('o/r', 'main', { ghFn: g.ghFn, env, now: () => 30, cacheFile });
  assert.equal(g.calls.length, 4, '之后普通调用命中刚写回的缓存');
});

test('失败结果(null)不缓存:下一次照常重读', () => {
  const bad = makeGh({ rulesOk: false });
  const cacheFile = file();
  const env = { REVIEW_PR_BRANCH_PROTECTION_CACHE_MS: '600000' };
  assert.equal(probeBranchProtection('o/r', 'main', { ghFn: bad.ghFn, env, now: () => 1, cacheFile }), null);
  assert.equal(probeBranchProtection('o/r', 'main', { ghFn: bad.ghFn, env, now: () => 2, cacheFile }), null);
  assert.equal(bad.calls.length, 2);
});

test('缓存文件损坏按没有处理;时钟倒退的旧条目不命中', () => {
  const g = makeGh();
  const cacheFile = file();
  writeFileSync(cacheFile, '{not json');
  const env = { REVIEW_PR_BRANCH_PROTECTION_CACHE_MS: '600000' };
  probeBranchProtection('o/r', 'main', { ghFn: g.ghFn, env, now: () => 1000, cacheFile });
  assert.equal(g.calls.length, 2);
  probeBranchProtection('o/r', 'main', { ghFn: g.ghFn, env, now: () => 500, cacheFile });
  assert.equal(g.calls.length, 4, '缓存时间比当前还晚,当作无效');
  assert.ok(JSON.parse(readFileSync(cacheFile, 'utf8'))['o/r#main']);
});

test('没有分支名直接返回 null 且不读缓存', () => {
  const g = makeGh();
  assert.equal(probeBranchProtection('o/r', '', { ghFn: g.ghFn, env: { REVIEW_PR_BRANCH_PROTECTION_CACHE_MS: '1000' }, cacheFile: file() }), null);
  assert.equal(g.calls.length, 0);
});

test('branchProtectionCacheMs:空=0;合法整数通过;不合法抛错', () => {
  assert.equal(branchProtectionCacheMs({}), 0);
  assert.equal(branchProtectionCacheMs({ REVIEW_PR_BRANCH_PROTECTION_CACHE_MS: '  ' }), 0);
  assert.equal(branchProtectionCacheMs({ REVIEW_PR_BRANCH_PROTECTION_CACHE_MS: '600000' }), 600000);
  for (const bad of ['-1', '1.5', 'abc', '3600001']) {
    assert.throws(() => branchProtectionCacheMs({ REVIEW_PR_BRANCH_PROTECTION_CACHE_MS: bad }), /REVIEW_PR_BRANCH_PROTECTION_CACHE_MS/, bad);
  }
});

test.after(() => rmSync(WORK, { recursive: true, force: true }));
