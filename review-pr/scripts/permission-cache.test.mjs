// permission-cache.test.mjs — permission-cache 与 semgrep-limits 补丁:
// 设了 REVIEW_PR_PERMISSION_CACHE_MS 才缓存白名单维护者的仓库权限;默认分支 commit 的读取与复核照常实时;
// security-scan 调 semgrep 时限 4 路并行、2G 内存。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORK = mkdtempSync(join(tmpdir(), 'perm-cache-'));
process.env.REVIEW_PR_STATE_DIR = join(WORK, 'state');
const { fetchMaintainerAuthority, permissionCacheMs } = await import('./lib.mjs');

const MEMBERS = ['PraiseZhu', 'kirozeng', 'aj0928', 'zhongxingtian-ai'];
const SHA = 'a'.repeat(40);
const ok = (value) => ({ ok: true, stdout: JSON.stringify(value), stderr: '', status: 0 });

// 假 GitHub:默认分支 main,commit 依次取 shas(用完停在最后一个);权限按 roles 给。
function makeGh({ roles = {}, shas = [SHA] } = {}) {
  const calls = [];
  let commitReads = 0;
  const ghFn = (args) => {
    const path = args.find((arg) => arg.startsWith('repos/'));
    calls.push(path);
    if (path === 'repos/o/r') return ok({ default_branch: 'main' });
    if (path.startsWith('repos/o/r/commits/')) return ok({ sha: shas[Math.min(commitReads++, shas.length - 1)] });
    const login = path.match(/collaborators\/([^/]+)\/permission$/)?.[1];
    if (login) return ok({ role_name: roles[login] ?? 'admin' });
    return { ok: false, stdout: '', stderr: 'gh: Not Found (HTTP 404)', status: 1 };
  };
  return { ghFn, calls, permissionCalls: () => calls.filter((p) => p.includes('/collaborators/')).length,
    commitCalls: () => calls.filter((p) => p.includes('/commits/')).length };
}
const cacheFile = () => join(WORK, `cache-${Math.random().toString(36).slice(2)}.json`);
const fetchWith = (g, env, extra = {}) => fetchMaintainerAuthority({ owner: 'o', repo: 'r', ghFn: g.ghFn, env,
  maintainerSource: 'allowlist', maintainerAllowlist: MEMBERS, nowIso: '2026-10-29T00:00:00.000Z', ...extra });

test('SC1 TTL=600000:同一次审查内第二次读维护者权限不再发请求;过期后重读', () => {
  const g = makeGh();
  const file = cacheFile();
  const env = { REVIEW_PR_PERMISSION_CACHE_MS: '600000' };
  let now = 1_000_000;
  fetchWith(g, env, { now: () => now, permissionCacheFile: file });
  assert.equal(g.permissionCalls(), MEMBERS.length);
  now += 599_999;
  fetchWith(g, env, { now: () => now, permissionCacheFile: file });
  assert.equal(g.permissionCalls(), MEMBERS.length, 'TTL 内命中缓存,不再读权限');
  now += 2;
  fetchWith(g, env, { now: () => now, permissionCacheFile: file });
  assert.equal(g.permissionCalls(), MEMBERS.length * 2, '过期后重读');
});

test('SC1 TTL=0 或没设:每次都读,行为与改动前相同', () => {
  for (const env of [{}, { REVIEW_PR_PERMISSION_CACHE_MS: '0' }, { REVIEW_PR_PERMISSION_CACHE_MS: ' ' }]) {
    const g = makeGh();
    const file = cacheFile();
    fetchWith(g, env, { permissionCacheFile: file });
    fetchWith(g, env, { permissionCacheFile: file });
    assert.equal(g.permissionCalls(), MEMBERS.length * 2, JSON.stringify(env));
  }
});

test('SC2 缓存命中时,默认分支 commit 的读取和复核仍每次实时读;复核发现变化照常报错', () => {
  const g = makeGh({ shas: [SHA, SHA, SHA, SHA, SHA, 'b'.repeat(40)] });
  const file = cacheFile();
  const env = { REVIEW_PR_PERMISSION_CACHE_MS: '600000' };
  fetchWith(g, env, { now: () => 5, permissionCacheFile: file });
  fetchWith(g, env, { now: () => 6, permissionCacheFile: file });
  assert.equal(g.permissionCalls(), MEMBERS.length, '第二次权限全部命中缓存');
  assert.equal(g.commitCalls(), 4, '两次各读一次默认分支、复核一次');
  assert.throws(() => fetchWith(g, env, { now: () => 7, permissionCacheFile: file }), /默认分支在维护者读取期间发生变化/);
});

test('SC5 缓存命中与不用缓存时,权限摘要逐字段相同', () => {
  const roles = { kirozeng: 'maintain', aj0928: 'write' };
  const plain = fetchWith(makeGh({ roles }), {});
  const g = makeGh({ roles });
  const file = cacheFile();
  const env = { REVIEW_PR_PERMISSION_CACHE_MS: '600000' };
  fetchWith(g, env, { now: () => 1, permissionCacheFile: file });
  const cached = fetchWith(g, env, { now: () => 2, permissionCacheFile: file });
  assert.equal(g.permissionCalls(), MEMBERS.length, '第二次确实来自缓存');
  assert.deepEqual(cached, plain);
  assert.deepEqual(cached.memberPermissions, { aj0928: 'push', kirozeng: 'maintain', praisezhu: 'admin', 'zhongxingtian-ai': 'admin' });
  assert.equal(cached.digest, plain.digest);
});

test('权限不够不缓存:下一次照常实时读,仍从严停止', () => {
  // 名单按小写排序后依次读:aj0928、kirozeng、praisezhu、zhongxingtian-ai,最后一人权限不够。
  const g = makeGh({ roles: { 'zhongxingtian-ai': 'read' } });
  const file = cacheFile();
  const env = { REVIEW_PR_PERMISSION_CACHE_MS: '600000' };
  assert.throws(() => fetchWith(g, env, { now: () => 1, permissionCacheFile: file }), /zhongxingtian-ai.*没有 write 及以上权限/);
  const before = g.permissionCalls();
  assert.throws(() => fetchWith(g, env, { now: () => 2, permissionCacheFile: file }), /zhongxingtian-ai.*没有 write 及以上权限/);
  assert.equal(g.permissionCalls() - before, 1, '前三人命中缓存,zhongxingtian-ai 重新读');
  assert.match(readFileSync(file, 'utf8'), /praisezhu/, '读成功的人照常缓存');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /zhongxingtian-ai/);
});

test('REVIEW_PR_PERMISSION_CACHE_MS 不合法时直接报错,不悄悄退回不缓存', () => {
  assert.equal(permissionCacheMs({ REVIEW_PR_PERMISSION_CACHE_MS: '600000' }), 600000);
  for (const raw of ['-1', '1.5', 'abc', '3600001']) {
    assert.throws(() => permissionCacheMs({ REVIEW_PR_PERMISSION_CACHE_MS: raw }), /REVIEW_PR_PERMISSION_CACHE_MS 不合法/, raw);
  }
});

test('SC3 security-scan 调 semgrep 时带 --jobs 4 和 --max-memory 2048', () => {
  const bin = join(WORK, 'bin');
  const repo = join(WORK, 'repo');
  const argsFile = join(WORK, 'semgrep-args.txt');
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(bin, 'semgrep'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi
printf '%s\\n' "$@" > "${argsFile}"
echo '{"results":[],"errors":[]}'
`);
  chmodSync(join(bin, 'semgrep'), 0o755);
  const script = join(dirname(fileURLToPath(import.meta.url)), 'security-scan.mjs');
  const r = spawnSync(process.execPath, [script, '--base', SHA], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REVIEW_PR_REPO_ROOT: repo } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).semgrep.available, true, r.stdout);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  assert.equal(args[args.indexOf('--jobs') + 1], '4');
  assert.equal(args[args.indexOf('--max-memory') + 1], '2048');
});
