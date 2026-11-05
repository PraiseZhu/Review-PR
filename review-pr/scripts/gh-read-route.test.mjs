// gh-read-route.test.mjs — app-read-route 补丁:服务器 publish 的读请求改用 App 只读令牌。
// 默认(没设 REVIEW_PR_READ_TOKEN / REVIEW_PR_READ_REPOS)必须与之前完全一致;设了以后:
//   只读且目标仓在名单里 → App 令牌;写、身份、管理端点、看不懂的 → 原令牌;App 因权限失败 → 原令牌重试一次。
// REVIEW_PR_READ_ROUTES 只认 adminRead、secretsRead:打开后管理类 / secrets 的只读形状才走 App,其它词忽略;身份字段永远走原令牌。
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
  for (const key of ['REVIEW_PR_READ_TOKEN', 'REVIEW_PR_READ_REPOS', 'REVIEW_PR_READ_ROUTES', 'REVIEW_PR_GH_ROUTE_LOG', 'FAKE_APP_MODE', 'FAKE_USER_FLAKY_FILE']) delete process.env[key];
  process.env.GH_TOKEN = 'user-token';
  process.env.GITHUB_TOKEN = 'user-token';
  Object.assign(process.env, extra);
}
const ENABLED = { REVIEW_PR_READ_TOKEN: 'app-token', REVIEW_PR_READ_REPOS: 'o/r', REVIEW_PR_GH_ROUTE_LOG: ROUTE_LOG };
const READ_QUERY = 'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){number}}}';

// 搬运基准:xindong/mivo-canvas-plugin scripts/ops/gh-app-router/classify.mjs @ adede3eb1(#1751 合入提交)。
const VENDOR_COMMIT = 'adede3eb103c3e26a1d85efbc25c447819552c51';
const VENDOR_SHA256 = '66e466eb7d38eb3f110105ebf0c685466aecbc2220b15e1d94d4a25ee43a6656';
test('搬运的分类器与插件仓原文一致(去掉 4 行来源说明后的 sha256),来源说明写的提交和 sha256 同步', () => {
  const file = fileURLToPath(new URL('./vendor/gh-app-classify.mjs', import.meta.url));
  const lines = readFileSync(file, 'utf8').split('\n');
  const body = lines.slice(4).join('\n');
  assert.equal(createHash('sha256').update(body).digest('hex'), VENDOR_SHA256);
  assert.ok(lines[1].includes(`@ ${VENDOR_COMMIT}`) && lines[1].includes(`sha256 ${VENDOR_SHA256}`), `来源说明要写 ${VENDOR_COMMIT} 和原文 sha256: ${lines[1]}`);
});

test('服务器认的开关与 vendor 分类器的 routes 开关集合一致:vendor 多出新开关时要先决定服务器认不认', async () => {
  const { ROUTE_SWITCHES } = await import('./vendor/gh-app-classify.mjs');
  assert.deepEqual([...route.READ_ROUTE_SWITCHES], ROUTE_SWITCHES);
  assert.deepEqual(Object.keys(route.toReadRoutes('adminRead')), ROUTE_SWITCHES);
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

test('readRouteConfig:REVIEW_PR_READ_ROUTES 只认 adminRead、secretsRead,其它词忽略且不报错', () => {
  const base = { REVIEW_PR_READ_TOKEN: 't', REVIEW_PR_READ_REPOS: 'o/r' };
  const routesOf = (value) => route.readRouteConfig(value === undefined ? base : { ...base, REVIEW_PR_READ_ROUTES: value }).routes;
  const OFF = { adminRead: false, secretsRead: false };
  assert.deepEqual(routesOf(undefined), OFF, '没设=全关');
  assert.deepEqual(routesOf(''), OFF);
  assert.deepEqual(routesOf(' , ,'), OFF);
  assert.deepEqual(routesOf('adminRead'), { adminRead: true, secretsRead: false });
  assert.deepEqual(routesOf('secretsRead'), { adminRead: false, secretsRead: true });
  assert.deepEqual(routesOf(' secretsRead , adminRead '), { adminRead: true, secretsRead: true }, '空白和顺序不影响');
  assert.deepEqual(routesOf('adminRead,adminRead'), { adminRead: true, secretsRead: false }, '重复无副作用');
  // 已取消的 mergeState 与任何未知词:忽略,不抛错,也不放行任何东西
  assert.deepEqual(routesOf('mergeState'), OFF);
  assert.deepEqual(routesOf('mergeState,adminRead'), { adminRead: true, secretsRead: false }, 'review-pr.yml 现在传的就是这一串');
  assert.deepEqual(routesOf('merge_state,admin,Secrets,adminread,ADMINREAD,all,*,true'), OFF, '区分大小写,不做模糊匹配');
  assert.deepEqual(Object.keys(routesOf('adminRead,whatever')).sort(), ['adminRead', 'secretsRead'], '结果里只有这两个键');
  // 令牌或仓名单缺一项仍然不分流,与是否配了 routes 无关
  assert.equal(route.readRouteConfig({ REVIEW_PR_READ_REPOS: 'o/r', REVIEW_PR_READ_ROUTES: 'adminRead' }), null);
  assert.equal(route.readRouteConfig({ REVIEW_PR_READ_TOKEN: 't', REVIEW_PR_READ_ROUTES: 'adminRead' }), null);
  assert.deepEqual(route.toReadRoutes(undefined), OFF);
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
  assert.equal(decide(['api', 'repos/o/r/branches/main/protection']), 'user', '没开 adminRead 时分支保护读仍走原令牌');
  assert.equal(decide(['api', 'repos/o/r/rulesets/7']), 'user');
  assert.equal(decide(['api', 'repos/o/r/actions/runners']), 'user');
  // adede3eb1 起不用开关就放行的元数据读(与调用者身份无关;之前搬运的 cc2fd4c6f 判 user)
  assert.equal(decide(['api', 'repos/o/r/rules/branches/main']), 'app');
  assert.equal(decide(['api', 'repos/o/r/collaborators/x/permission']), 'app');
  assert.equal(decide(['pr', 'view', '5', '--json', 'state']), 'user');
  assert.equal(decide(['pr', 'view', '5', '--repo', 'other/repo', '--json', 'state']), 'user');
  assert.equal(decide(['pr', 'comment', '5', '--repo', 'o/r', '--body-file', '-']), 'user');
  assert.equal(decide(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: 'query{viewer{login}}' }) }), 'user');
  assert.equal(decide(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}', variables: { id: 'x' } }) }), 'user');
  assert.equal(decide(['api', 'graphql', '--input', '-']), 'user', '拿不到 stdin 就不分流');
  assert.equal(decide(['api', 'repos/o/r/pulls/5/reviews'], { explicitEnv: true }), 'user', '调用方显式给了 env(身份令牌)');
  assert.equal(decide(['api', 'repos/o/r/pulls/5/reviews'], { noCredFallback: true }), 'user');
  assert.equal(route.decideReadRoute(['api', 'repos/o/r/pulls/5/reviews'], { config: null }).route, 'user');
});

test('decideReadRoute:带 mergeStateStatus / viewer* 等随身份变化字段的读一律走原令牌', () => {
  const config = { token: 't', repos: ['o/r'], logFile: '' };
  const decide = (args, input) => route.decideReadRoute(args, { config, env: {}, input });
  // 路由必须是 user;reason 可能来自分类器(sensitive_json_field / graphql_merge_state),也可能来自本地二次保护(identity_field),不把内部 reason 当公共接口。
  const IDENTITY_REASONS = ['identity_field', 'sensitive_json_field', 'graphql_merge_state'];
  const userWithIdentityReason = (d) => { assert.equal(d.route, 'user'); assert.ok(IDENTITY_REASONS.includes(d.reason), d.reason); };
  userWithIdentityReason(decide(['pr', 'view', '5', '--repo', 'o/r', '--json', 'state,mergeStateStatus']));
  userWithIdentityReason(decide(['pr', 'list', '--repo', 'o/r', '--json', 'number,mergeStateStatus']));
  const gql = (fields) => JSON.stringify({ query: `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){number ${fields}}}}`, variables: { owner: 'o', name: 'r', n: 5 } });
  userWithIdentityReason(decide(['api', 'graphql', '--input', '-'], gql('mergeStateStatus')));
  // viewer* 在分类器里本来就被判给个人账号(原因 graphql_viewer);这里只要求不走 App。
  assert.equal(decide(['api', 'graphql', '--input', '-'], gql('viewerCanMergeAsAdmin')).route, 'user');
  assert.equal(decide(['api', 'graphql', '--input', '-'], gql('viewerLatestReview{state}')).route, 'user');
  // 不带这些字段的照旧走 App
  assert.equal(decide(['pr', 'view', '5', '--repo', 'o/r', '--json', 'state,mergeable,reviewDecision,headRefOid']).route, 'app');
  assert.equal(decide(['api', 'graphql', '--input', '-'], gql('state')).route, 'app');
});

// 风险矩阵:四个新读法走 App;身份相关、单 PR REST、写一律原令牌。白名单只放 o/r,别的仓不分流。
test('decideReadRoute 风险矩阵:新读法 app,身份字段 / 单 PR REST / 写 / 白名单外 user', () => {
  const config = { token: 't', repos: ['o/r'], logFile: '' };
  const gql = (query, variables) => ({ args: ['api', 'graphql', '--input', '-'], input: JSON.stringify({ query, variables }) });
  const rows = [
    ['默认分支 defaultBranchRef', gql('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name}}}', { owner: 'o', name: 'r' }), 'app'],
    ['认证探针 nameWithOwner', gql('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner}}', { owner: 'o', name: 'r' }), 'app'],
    ['readLiveHead pr view headRefOid', { args: ['pr', 'view', '7', '--repo', 'o/r', '--json', 'headRefOid', '--jq', '.headRefOid'] }, 'app'],
    ['reviews 列表 REST', { args: ['api', '--method', 'GET', 'repos/o/r/pulls/7/reviews'] }, 'app'],
    ['单 PR REST 读(mergeStateStatus 随身份变化)', { args: ['api', '--method', 'GET', 'repos/o/r/pulls/7'] }, 'user'],
    ['pr view 带 mergeStateStatus', { args: ['pr', 'view', '7', '--repo', 'o/r', '--json', 'state,mergeStateStatus'] }, 'user'],
    ['重复 --json,敏感字段在前', { args: ['pr', 'view', '7', '--repo', 'o/r', '--json', 'reviewRequests', '--json', 'mergeStateStatus'] }, 'user'],
    ['旧写法 repo view defaultBranchRef', { args: ['repo', 'view', 'o/r', '--json', 'defaultBranchRef'] }, 'user'],
    ['旧写法 repos/<o>/<r> 根 REST', { args: ['api', '--method', 'GET', 'repos/o/r'] }, 'user'],
    ['GraphQL mutation', gql('mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}', { id: 'x' }), 'user'],
    ['REST POST', { args: ['api', '--method', 'POST', 'repos/o/r/pulls/7/reviews', '--input', '-'], input: '{}' }, 'user'],
    ['白名单外的仓', { args: ['pr', 'view', '7', '--repo', 'x/y', '--json', 'headRefOid'] }, 'user'],
  ];
  for (const [name, call, want] of rows) {
    assert.equal(route.decideReadRoute(call.args, { config, env: {}, input: call.input }).route, want, name);
  }
});

// 开关矩阵:每行 [名字, 调用, 全关, 只开 adminRead, 只开 secretsRead, 两个都开]。开关经 readRouteConfig 从 REVIEW_PR_READ_ROUTES 解析,
// 与服务器真实走法一致。管理类读只有对应开关打开才走 App;rulesets/<id>、含 %2F 的分支保护、branches/<ref>、写方法、身份字段在任何开关下都是 user。
const ROUTE_VALUES = ['', 'adminRead', 'secretsRead', 'adminRead,secretsRead'];
const gqlInput = (fields) => JSON.stringify({ query: `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){number ${fields}}}}`, variables: { owner: 'o', name: 'r', n: 5 } });
const SWITCH_ROWS = [
  ['branches/<ref>/protection', ['api', 'repos/o/r/branches/main/protection'], 'user', 'app', 'user', 'app'],
  ['…/protection/required_signatures', ['api', '--method', 'GET', 'repos/o/r/branches/main/protection/required_signatures'], 'user', 'app', 'user', 'app'],
  ['rulesets/rule-suites', ['api', 'repos/o/r/rulesets/rule-suites?ref=refs/heads/main&per_page=100'], 'user', 'app', 'user', 'app'],
  ['actions/runners', ['api', 'repos/o/r/actions/runners?per_page=100'], 'user', 'app', 'user', 'app'],
  ['actions/secrets/<name>', ['api', 'repos/o/r/actions/secrets/LITELLM_CREDENTIALS_JSON', '--jq', '.updated_at'], 'user', 'user', 'app', 'app'],
  // 开关也放不进来的:单个规则集(current_user_can_bypass 按调用者算)、含 %2F 的分支保护、分支对象、其它子资源、列表
  ['rulesets/<id>', ['api', 'repos/o/r/rulesets/7'], 'user', 'user', 'user', 'user'],
  ['rulesets 列表', ['api', 'repos/o/r/rulesets'], 'user', 'user', 'user', 'user'],
  ['branches/<含 %2F 的 ref>/protection', ['api', 'repos/o/r/branches/release%2F1.0/protection'], 'user', 'user', 'user', 'user'],
  ['branches/<含 %2F 的 ref>/protection/required_signatures', ['api', 'repos/o/r/branches/release%2F1.0/protection/required_signatures'], 'user', 'user', 'user', 'user'],
  ['branches/<ref> 分支对象', ['api', 'repos/o/r/branches/main'], 'user', 'user', 'user', 'user'],
  ['branches 列表', ['api', 'repos/o/r/branches'], 'user', 'user', 'user', 'user'],
  ['protection 的其它子资源', ['api', 'repos/o/r/branches/main/protection/enforce_admins'], 'user', 'user', 'user', 'user'],
  ['actions/secrets 列表', ['api', 'repos/o/r/actions/secrets'], 'user', 'user', 'user', 'user'],
  ['actions/runners/<id>', ['api', 'repos/o/r/actions/runners/5'], 'user', 'user', 'user', 'user'],
  ['写方法 DELETE protection', ['api', '--method', 'DELETE', 'repos/o/r/branches/main/protection'], 'user', 'user', 'user', 'user'],
  ['写方法 PUT secrets', ['api', '--method', 'PUT', 'repos/o/r/actions/secrets/X'], 'user', 'user', 'user', 'user'],
  ['白名单外的仓', ['api', 'repos/x/y/branches/main/protection'], 'user', 'user', 'user', 'user'],
  // 身份字段:任何开关下都走原令牌
  ['单个 PR REST(mergeable_state)', ['api', 'repos/o/r/pulls/5'], 'user', 'user', 'user', 'user'],
  ['pr view 带 mergeStateStatus', ['pr', 'view', '5', '--repo', 'o/r', '--json', 'state,mergeStateStatus'], 'user', 'user', 'user', 'user'],
  ['GraphQL 带 mergeStateStatus', { args: ['api', 'graphql', '--input', '-'], input: gqlInput('mergeStateStatus') }, 'user', 'user', 'user', 'user'],
  ['jq 表达式里带 viewerCan*(本地二次保护)', ['api', 'repos/o/r/pulls/5/reviews', '--jq', '.[] | .viewerCanReact'], 'user', 'user', 'user', 'user'],
  // 不受开关影响的读
  ['reviews 列表', ['api', 'repos/o/r/pulls/5/reviews'], 'app', 'app', 'app', 'app'],
  ['pr view headRefOid', ['pr', 'view', '5', '--repo', 'o/r', '--json', 'headRefOid'], 'app', 'app', 'app', 'app'],
  ['rules/branches/<含 %2F 的 ref>', ['api', 'repos/o/r/rules/branches/release%2F1.0?per_page=100'], 'app', 'app', 'app', 'app'],
];
const rowCall = (call) => (Array.isArray(call) ? { args: call } : call);
const decideWith = (routesValue, call) => {
  const config = route.readRouteConfig({ REVIEW_PR_READ_TOKEN: 't', REVIEW_PR_READ_REPOS: 'o/r', ...(routesValue ? { REVIEW_PR_READ_ROUTES: routesValue } : {}) });
  const { args, input } = rowCall(call);
  return route.decideReadRoute(args, { config, env: {}, input });
};

test('decideReadRoute 开关矩阵:adminRead / secretsRead 只放行各自的只读形状,rulesets/<id>、%2F 分支保护、写、身份字段永远 user', () => {
  for (const [name, call, ...want] of SWITCH_ROWS) {
    ROUTE_VALUES.forEach((value, i) => assert.equal(decideWith(value, call).route, want[i], `${name} [REVIEW_PR_READ_ROUTES=${value || '(空)'}]`));
  }
});

test('decideReadRoute:REVIEW_PR_READ_ROUTES 里的未知词(含 mergeState)不放行任何东西,也不影响已认的开关', () => {
  for (const [name, call] of SWITCH_ROWS) {
    const off = decideWith('', call);
    for (const junk of ['mergeState', 'merge_state,all,*', 'adminread,ADMINREAD,Admin']) assert.deepEqual(decideWith(junk, call), off, `${name} [${junk}]`);
    assert.deepEqual(decideWith('mergeState,adminRead', call), decideWith('adminRead', call), `${name} [review-pr.yml 现在传的 mergeState,adminRead]`);
  }
  // mergeState 被忽略后,带 mergeStateStatus 的读仍判 user,且 reason 是身份字段(分类器的 sensitive/graphql_merge_state 或本地的 identity_field)
  const IDENTITY_REASONS = ['identity_field', 'sensitive_json_field', 'graphql_merge_state'];
  for (const call of [['pr', 'view', '5', '--repo', 'o/r', '--json', 'state,mergeStateStatus'], ['pr', 'list', '--repo', 'o/r', '--json', 'number,mergeStateStatus'], { args: ['api', 'graphql', '--input', '-'], input: gqlInput('mergeStateStatus') }]) {
    const d = decideWith('mergeState,adminRead,secretsRead', call);
    assert.equal(d.route, 'user');
    assert.ok(IDENTITY_REASONS.includes(d.reason), d.reason);
  }
  // 单个 PR REST 读(mergeable_state)同样 user
  assert.equal(decideWith('mergeState,adminRead', ['api', 'repos/o/r/pulls/5']).route, 'user');
  assert.equal(decideWith('mergeState,adminRead', ['api', 'repos/o/r/pulls/5.']).route, 'user');
});

test('decideReadRoute:没配 REVIEW_PR_READ_ROUTES 时,config 里没有 routes(老写法)、routes 全 false、只有未知词,三者逐条一致', () => {
  const bare = { token: 't', repos: ['o/r'], logFile: '' };
  for (const [name, call] of SWITCH_ROWS) {
    const { args, input } = rowCall(call);
    const old = route.decideReadRoute(args, { config: bare, env: {}, input });
    assert.deepEqual(route.decideReadRoute(args, { config: { ...bare, routes: { adminRead: false, secretsRead: false } }, env: {}, input }), old, name);
    assert.deepEqual(decideWith('', call), old, name);
    assert.deepEqual(decideWith('mergeState', call), old, name);
  }
});

test('decideReadRoute:IDENTITY_FIELD_RE 在开关全开时仍拦住 viewer* 与 mergeStateStatus 的各种出现位置', () => {
  const on = (call) => decideWith('adminRead,secretsRead', call);
  for (const field of ['viewerCanMergeAsAdmin', 'viewerDidAuthor', 'viewerHasStarred', 'viewerIsAuthor', 'viewerLatestReview', 'viewerPermission', 'viewerSubscription', 'viewerThumbsUp', 'mergeStateStatus', 'MERGESTATESTATUS']) {
    const d = on(['api', 'repos/o/r/pulls/5/reviews', '--jq', `.[] | .${field}`]);
    assert.deepEqual({ route: d.route, reason: d.reason }, { route: 'user', reason: 'identity_field' }, field);
  }
  // 管理类读的 jq 里带身份字段也走原令牌:开关放行的是端点形状,不是身份字段
  const d = on(['api', 'repos/o/r/branches/main/protection', '--jq', '.viewerPermission']);
  assert.equal(d.route, 'user');
  assert.equal(on(['api', 'repos/o/r/branches/main/protection', '--jq', '.required_status_checks']).route, 'app');
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
  gh(['api', '--method', 'GET', 'repos/o/r/pulls/5/reviews']);
  gh(['api', '--method', 'POST', 'repos/o/r/pulls/5/reviews', '--input', '-'], { input: '{}' });
  assert.deepEqual(calls().map((c) => c.token), ['user-token', 'user-token']);
  assert.equal(existsSync(ROUTE_LOG), false);
});

test('gh():设了开关 → 读用 App 令牌(且看不到原令牌),写和身份用原令牌', () => {
  setup(ENABLED);
  const read = gh(['api', '--method', 'GET', 'repos/o/r/pulls/5/reviews']);
  gh(['api', '--method', 'POST', 'repos/o/r/pulls/5/reviews', '--input', '-'], { input: '{}' });
  gh(['api', 'user', '--jq', '.login']);
  gh(['api', 'repos/o/r/rulesets/7']);
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
  gh(['api', 'repos/o/r/pulls/5/reviews'], { env: { ...process.env, GH_TOKEN: 'identity-token' } });
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
    const r = gh(['api', '--method', 'GET', 'repos/o/r/pulls/5/reviews']);
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
  const r = gh(['api', '--method', 'GET', 'repos/o/r/pulls/5/reviews']);
  assert.equal(r.ok, true);
  assert.deepEqual(calls().map((c) => c.token), ['app-token', 'user-token', 'user-token']);
  assert.equal(JSON.parse(r.stdout).by, 'user-token');
});

test('gh():REVIEW_PR_READ_ROUTES=adminRead → 分支保护读走 App 令牌;没配或只配 secretsRead 走原令牌;rulesets/<id> 永远原令牌', () => {
  const protection = ['api', 'repos/o/r/branches/main/protection'];
  setup(ENABLED);
  gh(protection);
  setup({ ...ENABLED, REVIEW_PR_READ_ROUTES: 'secretsRead' });
  gh(protection);
  setup({ ...ENABLED, REVIEW_PR_READ_ROUTES: 'mergeState,adminRead' });
  const read = gh(protection);
  gh(['api', 'repos/o/r/rulesets/7']);
  gh(['api', 'repos/o/r/pulls/5']);
  assert.equal(JSON.parse(read.stdout).by, 'app-token');
  assert.deepEqual(calls().map((c) => c.token), ['app-token', 'user-token', 'user-token']);
  assert.deepEqual(route.routeMetrics(), { app: 1, appFallback: 0, user: 2 });
  assert.equal(route.summarizeRouteLog(ROUTE_LOG).reasons['app:rest_admin_read'], 1, '分流日志里记 rest_admin_read');
});

test('gh():adminRead 打开的读被 App 拒(401/403/404:权限没授到)→ 原令牌重试一次;5xx 不重试', () => {
  for (const mode of ['403', '404']) {
    setup({ ...ENABLED, REVIEW_PR_READ_ROUTES: 'adminRead', FAKE_APP_MODE: mode });
    const r = gh(['api', 'repos/o/r/branches/main/protection']);
    assert.deepEqual(calls().map((c) => c.token), ['app-token', 'user-token'], mode);
    assert.equal(JSON.parse(r.stdout).by, 'user-token');
    assert.deepEqual(route.routeMetrics(), { app: 0, appFallback: 1, user: 0 });
  }
  setup({ ...ENABLED, REVIEW_PR_READ_ROUTES: 'adminRead', FAKE_APP_MODE: '500' });
  const r = gh(['api', 'repos/o/r/branches/main/protection'], { allowFail: true });
  assert.equal(r.ok, false);
  assert.deepEqual(calls().map((c) => c.token), ['app-token']);
});

test('gh():App 返回 500 → 不换原令牌,失败原样交给调用方', () => {
  setup({ ...ENABLED, FAKE_APP_MODE: '500' });
  const r = gh(['api', '--method', 'GET', 'repos/o/r/pulls/5/reviews'], { allowFail: true });
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
