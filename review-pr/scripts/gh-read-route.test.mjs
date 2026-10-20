// gh-read-route.test.mjs — app-read-route 补丁:服务器 publish 的读请求改用 App 只读令牌。
// 默认(没设 REVIEW_PR_READ_TOKEN / REVIEW_PR_READ_REPOS)必须与之前完全一致;设了以后:
//   只读且目标仓在名单里 → App 令牌;写、身份、管理端点、看不懂的 → 原令牌;App 因权限失败 → 原令牌重试一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORK = mkdtempSync(join(tmpdir(), 'gh-read-route-'));
const BIN = join(WORK, 'bin');
const CALLS = join(WORK, 'calls.jsonl');
const ROUTE_LOG = join(WORK, 'route.jsonl');
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const token = process.env.GH_TOKEN ?? null;
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, token, github: process.env.GITHUB_TOKEN ?? null }) + '\\n');
const mode = process.env.FAKE_APP_MODE || 'ok';
if (token === 'app-token' && mode === '403') { process.stderr.write('gh: Resource not accessible by integration (HTTP 403)\\n'); process.exit(1); }
if (token === 'app-token' && mode === '404') { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
if (token === 'app-token' && mode === '500') { process.stderr.write('gh: Internal Server Error (HTTP 500)\\n'); process.exit(1); }
if (token !== 'app-token' && process.env.FAKE_USER_FLAKY_FILE) {
  const n = Number(fs.existsSync(process.env.FAKE_USER_FLAKY_FILE) ? fs.readFileSync(process.env.FAKE_USER_FLAKY_FILE, 'utf8') : '0');
  fs.writeFileSync(process.env.FAKE_USER_FLAKY_FILE, String(n + 1));
  if (n === 0) { process.stderr.write('gh: Service Unavailable (HTTP 503)\\n'); process.exit(1); }
}
process.stdout.write(JSON.stringify({ data: { by: token }, by: token }));
`);
chmodSync(join(BIN, 'gh'), 0o755);

process.env.REVIEW_PR_STATE_DIR = join(WORK, 'state');
process.env.PATH = `${BIN}${delimiter}${process.env.PATH}`;
const { gh, ghGraphql } = await import('./lib.mjs');
const route = await import('./gh-read-route.mjs');

const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function setup(extra = {}) {
  rmSync(CALLS, { force: true });
  rmSync(ROUTE_LOG, { force: true });
  route.resetRouteMetrics();
  for (const key of ['REVIEW_PR_READ_TOKEN', 'REVIEW_PR_READ_REPOS', 'REVIEW_PR_GH_ROUTE_LOG', 'FAKE_APP_MODE', 'FAKE_USER_FLAKY_FILE']) delete process.env[key];
  process.env.GH_TOKEN = 'user-token';
  process.env.GITHUB_TOKEN = 'user-token';
  Object.assign(process.env, extra);
}
const ENABLED = { REVIEW_PR_READ_TOKEN: 'app-token', REVIEW_PR_READ_REPOS: 'o/r', REVIEW_PR_GH_ROUTE_LOG: ROUTE_LOG };
const READ_QUERY = 'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){number}}}';

test('搬运的分类器与插件仓原文一致(去掉 4 行来源说明后的 sha256)', () => {
  const file = fileURLToPath(new URL('./vendor/gh-app-classify.mjs', import.meta.url));
  const body = readFileSync(file, 'utf8').split('\n').slice(4).join('\n');
  assert.equal(createHash('sha256').update(body).digest('hex'), '12dd0e7f9f7082d1c650424f66d40ca972c9e575d5a7771178d533110cb09245');
});

test('readRouteConfig:令牌和仓名单缺一项都不分流;仓名不合法抛错', () => {
  assert.equal(route.readRouteConfig({}), null);
  assert.equal(route.readRouteConfig({ REVIEW_PR_READ_TOKEN: 'x' }), null);
  assert.equal(route.readRouteConfig({ REVIEW_PR_READ_REPOS: 'o/r' }), null);
  assert.equal(route.readRouteConfig({ REVIEW_PR_READ_TOKEN: '  ', REVIEW_PR_READ_REPOS: 'o/r' }), null);
  const cfg = route.readRouteConfig({ REVIEW_PR_READ_TOKEN: ' t ', REVIEW_PR_READ_REPOS: ' O/R , a/b ' });
  assert.deepEqual({ token: cfg.token, repos: cfg.repos }, { token: 't', repos: ['o/r', 'a/b'] });
  assert.throws(() => route.readRouteConfig({ REVIEW_PR_READ_TOKEN: 't', REVIEW_PR_READ_REPOS: 'o/r,not a repo' }), /REVIEW_PR_READ_REPOS/);
});

test('decideReadRoute:读走 App,写/身份/管理/没写仓/不在名单走原令牌', () => {
  const config = { token: 't', repos: ['o/r'], logFile: '' };
  const decide = (args, extra = {}) => route.decideReadRoute(args, { config, env: {}, ...extra }).route;
  assert.equal(decide(['api', '--method', 'GET', '--paginate', '--slurp', 'repos/o/r/pulls/5/reviews']), 'app');
  assert.equal(decide(['api', 'repos/o/r/pulls/5/comments?per_page=100']), 'app');
  assert.equal(decide(['pr', 'view', '5', '--repo', 'o/r', '--json', 'state,headRefOid']), 'app');
  assert.equal(decide(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: READ_QUERY, variables: { owner: 'o', name: 'r', n: 5 } }) }), 'app');
  assert.equal(decide(['api', 'user', '--jq', '.login']), 'user');
  assert.equal(decide(['api', '--method', 'POST', 'repos/o/r/pulls/5/reviews', '--input', '-']), 'user');
  assert.equal(decide(['api', 'repos/o/r/rules/branches/main']), 'user');
  assert.equal(decide(['api', 'repos/o/r/branches/main/protection']), 'user');
  assert.equal(decide(['api', 'repos/o/r/collaborators/x/permission']), 'user');
  assert.equal(decide(['pr', 'view', '5', '--json', 'state']), 'user');
  assert.equal(decide(['pr', 'view', '5', '--repo', 'other/repo', '--json', 'state']), 'user');
  assert.equal(decide(['pr', 'comment', '5', '--repo', 'o/r', '--body-file', '-']), 'user');
  assert.equal(decide(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: 'query{viewer{login}}' }) }), 'user');
  assert.equal(decide(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}', variables: { id: 'x' } }) }), 'user');
  assert.equal(decide(['api', 'graphql', '--input', '-']), 'user', '拿不到 stdin 就不分流');
  assert.equal(decide(['api', 'repos/o/r/pulls/5'], { explicitEnv: true }), 'user', '调用方显式给了 env(身份令牌)');
  assert.equal(decide(['api', 'repos/o/r/pulls/5'], { noCredFallback: true }), 'user');
  assert.equal(route.decideReadRoute(['api', 'repos/o/r/pulls/5'], { config: null }).route, 'user');
});

test('shouldFallbackToUser:只认权限/不存在/令牌失效', () => {
  const bad = (stderr, extra = {}) => ({ ok: false, stdout: '', stderr, status: 1, ...extra });
  assert.equal(route.shouldFallbackToUser({ ok: true, stdout: '', stderr: '', status: 0 }), false);
  assert.equal(route.shouldFallbackToUser(bad('gh: Resource not accessible by integration (HTTP 403)')), true);
  assert.equal(route.shouldFallbackToUser(bad('gh: Not Found (HTTP 404)')), true);
  assert.equal(route.shouldFallbackToUser(bad('gh: Bad credentials (HTTP 401)')), true);
  assert.equal(route.shouldFallbackToUser(bad('', { status: 4 })), true);
  assert.equal(route.shouldFallbackToUser(bad('', { stdout: '{"errors":[{"type":"FORBIDDEN"}]}' })), true);
  assert.equal(route.shouldFallbackToUser(bad('gh: Internal Server Error (HTTP 500)')), false);
  assert.equal(route.shouldFallbackToUser(bad('gh: Validation Failed (HTTP 422)')), false);
  assert.equal(route.shouldFallbackToUser(bad('gh: API rate limit exceeded (HTTP 403)')), false, '限流换账号也没用,原样返回');
  assert.equal(route.shouldFallbackToUser(bad('ETIMEDOUT')), false);
});

test('appReadEnv:摘掉调用方的令牌,只留 App 令牌', () => {
  const env = route.appReadEnv({ GH_TOKEN: 'u', GITHUB_TOKEN: 'u', GH_ENTERPRISE_TOKEN: 'u', PATH: '/bin' }, 'a');
  assert.equal(env.GH_TOKEN, 'a');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(env.PATH, '/bin');
});

test('gh():没设开关 → 所有调用都用原令牌,不写分流日志', () => {
  setup();
  gh(['api', '--method', 'GET', 'repos/o/r/pulls/5']);
  gh(['api', '--method', 'POST', 'repos/o/r/pulls/5/reviews', '--input', '-'], { input: '{}' });
  assert.deepEqual(calls().map((c) => c.token), ['user-token', 'user-token']);
  assert.equal(existsSync(ROUTE_LOG), false);
});

test('gh():设了开关 → 读用 App 令牌(且看不到原令牌),写和身份用原令牌', () => {
  setup(ENABLED);
  const read = gh(['api', '--method', 'GET', 'repos/o/r/pulls/5']);
  gh(['api', '--method', 'POST', 'repos/o/r/pulls/5/reviews', '--input', '-'], { input: '{}' });
  gh(['api', 'user', '--jq', '.login']);
  gh(['api', 'repos/o/r/rules/branches/main']);
  const seen = calls();
  assert.deepEqual(seen.map((c) => c.token), ['app-token', 'user-token', 'user-token', 'user-token']);
  assert.equal(seen[0].github, null, 'App 那次不能带原令牌的 GITHUB_TOKEN');
  assert.equal(JSON.parse(read.stdout).by, 'app-token');
  const summary = route.summarizeRouteLog(ROUTE_LOG);
  assert.deepEqual({ app: summary.app, appFallback: summary.appFallback, user: summary.user }, { app: 1, appFallback: 0, user: 3 });
  assert.ok(!readFileSync(ROUTE_LOG, 'utf8').includes('token'), '日志里不能有令牌字样');
});

test('gh():调用方显式给了 env(身份令牌)时不分流', () => {
  setup(ENABLED);
  gh(['api', 'repos/o/r/pulls/5'], { env: { ...process.env, GH_TOKEN: 'identity-token' } });
  assert.deepEqual(calls().map((c) => c.token), ['identity-token']);
});

test('gh():GraphQL 只读查询走 App;带 viewer 或 mutation 走原令牌', () => {
  setup(ENABLED);
  const ok = ghGraphql(READ_QUERY, { owner: 'o', name: 'r', n: 5 });
  assert.equal(ok.data.by, 'app-token');
  ghGraphql('query{viewer{login}}');
  ghGraphql('mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}', { id: 'x' });
  assert.deepEqual(calls().map((c) => c.token), ['app-token', 'user-token', 'user-token']);
});

test('gh():App 返回 403/404 → 换原令牌重试一次并记为 app-fallback', () => {
  for (const mode of ['403', '404']) {
    setup({ ...ENABLED, FAKE_APP_MODE: mode });
    const r = gh(['api', '--method', 'GET', 'repos/o/r/pulls/5']);
    assert.equal(r.ok, true);
    assert.deepEqual(calls().map((c) => c.token), ['app-token', 'user-token']);
    assert.equal(JSON.parse(r.stdout).by, 'user-token');
    assert.equal(route.summarizeRouteLog(ROUTE_LOG).appFallback, 1);
    assert.deepEqual(route.routeMetrics(), { app: 0, appFallback: 1, user: 0 });
  }
});

test('gh():App 被拒后改用原令牌那次遇到 503,照常做瞬时错误重试', () => {
  const flaky = join(WORK, 'flaky-count');
  rmSync(flaky, { force: true });
  setup({ ...ENABLED, FAKE_APP_MODE: '403', FAKE_USER_FLAKY_FILE: flaky });
  const r = gh(['api', '--method', 'GET', 'repos/o/r/pulls/5']);
  assert.equal(r.ok, true);
  assert.deepEqual(calls().map((c) => c.token), ['app-token', 'user-token', 'user-token']);
  assert.equal(JSON.parse(r.stdout).by, 'user-token');
});

test('gh():App 返回 500 → 不换原令牌,失败原样交给调用方', () => {
  setup({ ...ENABLED, FAKE_APP_MODE: '500' });
  const r = gh(['api', '--method', 'GET', 'repos/o/r/pulls/5'], { allowFail: true });
  assert.equal(r.ok, false);
  assert.deepEqual(calls().map((c) => c.token), ['app-token']);
});

test('summarizeRouteLog:文件不存在返回 null,坏行跳过', () => {
  assert.equal(route.summarizeRouteLog(join(WORK, 'nope.jsonl')), null);
  writeFileSync(ROUTE_LOG, `${JSON.stringify({ route: 'app', reason: 'rest_get' })}\nnot json\n${JSON.stringify({ route: 'user', reason: 'write_method' })}\n`);
  const s = route.summarizeRouteLog(ROUTE_LOG);
  assert.deepEqual({ app: s.app, user: s.user }, { app: 1, user: 1 });
  assert.equal(s.reasons['user:write_method'], 1);
});

test.after(() => rmSync(WORK, { recursive: true, force: true }));
