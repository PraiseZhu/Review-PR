// feishu-notify.test.mjs — 熔断飞书私聊(PraiseZhu/Review-PR#210):确认文案逐字、按名册选接收人、发送流程与失败原因码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { toFuseNotifyConfig, toFuseNotifyText, selectRosterEmail, toFuseRecipients, sendFuseNotice, FEISHU_TOTAL_TIMEOUT_MS, FEISHU_STEP_TIMEOUT_MS,
  toFuseRosterRepos, isBotLogin, toFuseForwardNote, findFeishuUsers } from './feishu-notify.mjs';

// #210「确认文案」(用户 2026-11-07 确认「语气柔和一点」版),占位符按 #1704 的例子填。
const CONFIRMED = `PR #1704「对话出图判定」已经改到第 10 版了，辛苦啦。我先把自动审查暂停一下，想请你来看看。

最近这一版还有 5 个问题没解决。来回改了这么多轮，可能换个思路会更快，所以先停下来等你拿主意。
https://github.com/xindong/mivo-canvas-plugin/pull/1704

你可以按自己的判断选一种：
· 想接着审：在熔断 issue 里回一行「继续审」就好，我会接着审，版本数从头算
· 剩下的问题不打算修：可以请维护者在对应讨论串回「维护者裁定不改：理由」，或者转成 issue 以后再跟进，然后回「继续审」
· 想换个方案：关掉这个 PR，重新开一个也完全没问题

熔断 issue：https://github.com/xindong/mivo-canvas-plugin/issues/1930

处理好以后：
· 在熔断 issue 里回「继续审」就行，我 3 分钟左右能看到
· 飞书私信回复我这边收不到，回到 issue 里就好

暂停期间这个 PR 先不会放行，等你回来我们再继续 😌`;
const BASE = { pr: 1704, title: '对话出图判定', count: 10, open: 5,
  prUrl: 'https://github.com/xindong/mivo-canvas-plugin/pull/1704', issueUrl: 'https://github.com/xindong/mivo-canvas-plugin/issues/1930' };

test('SC1/SC6 文案逐字等于确认稿;没有未解决问题时第二段改说「还没有放行」;只有句尾一个 😌', () => {
  assert.equal(toFuseNotifyText(BASE), CONFIRMED);
  const noOpen = toFuseNotifyText({ ...BASE, open: 0 });
  assert.match(noOpen, /\n\n最近这一版还没有放行。来回改了这么多轮/);
  assert.equal(toFuseNotifyText({ ...BASE, open: null }), noOpen);
  assert.equal([...CONFIRMED.matchAll(/😌/gu)].length, 1);
  assert.ok(CONFIRMED.endsWith('😌'));
  for (const banned of ['@', 'P0', 'P1', 'P2', 'diff']) assert.ok(!CONFIRMED.includes(banned), banned);
});

test('SC2 转发给兜底人时正文前加一行说明,其余逐字不变', () => {
  const text = toFuseNotifyText({ ...BASE, forwardedFrom: 'someone' });
  assert.equal(text, `PR #1704 的作者 @someone 在名册里没找到对应的飞书账号，这条通知先转给你，麻烦帮忙看一下。\n\n${CONFIRMED}`);
});

const ROSTER = [
  '| GitHub | Name | Email | Role |',
  '|---|---|---|---|',
  '| [@aj0928](https://github.com/aj0928) | 甲 | aj@example.com | dev |',
  '| [@PraiseZhu](https://github.com/PraiseZhu) | 乙 | praise@example.com | lead |',
].join('\n');

test('SC2 名册:按 GitHub 账号精确匹配(不分大小写)取公司邮箱;没有就 null', () => {
  assert.equal(selectRosterEmail([ROSTER], 'AJ0928'), 'aj@example.com');
  assert.equal(selectRosterEmail([ROSTER], 'aj'), null);
  assert.equal(selectRosterEmail([ROSTER], ''), null);
});

test('SC2 接收人:作者在名册里先发作者,兜底在后;机器人账号、名册没有的直接转兜底并带原因码;作者就是兜底人时只有一项', () => {
  assert.deepEqual(toFuseRecipients({ rosterTexts: [ROSTER], author: 'aj0928', fallbackLogin: 'PraiseZhu' }), [
    { login: 'aj0928', email: 'aj@example.com', forwardedFrom: null, reason: null },
    { login: 'PraiseZhu', email: 'praise@example.com', forwardedFrom: 'aj0928', reason: 'feishu-user-not-found' },
  ]);
  assert.deepEqual(toFuseRecipients({ rosterTexts: [ROSTER], author: 'praisebuild[bot]', fallbackLogin: 'PraiseZhu' }),
    [{ login: 'PraiseZhu', email: 'praise@example.com', forwardedFrom: 'praisebuild[bot]', reason: 'bot-author' }]);
  assert.deepEqual(toFuseRecipients({ rosterTexts: [ROSTER], author: 'stranger', fallbackLogin: 'PraiseZhu' }),
    [{ login: 'PraiseZhu', email: 'praise@example.com', forwardedFrom: 'stranger', reason: 'not-in-roster' }]);
  assert.deepEqual(toFuseRecipients({ rosterTexts: [ROSTER], author: 'PraiseZhu', fallbackLogin: 'PraiseZhu' }),
    [{ login: 'PraiseZhu', email: 'praise@example.com', forwardedFrom: null, reason: null }]);
});

// 假的飞书接口:按 URL 分派,记录请求。
function fakeFeishu({ token = { code: 0, tenant_access_token: 't-1' }, users = {}, send = { code: 0 }, throwName = null, lookupCode = {} } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.Authorization ?? null, hasSignal: Boolean(init.signal) });
    if (throwName) { const e = new Error('x'); e.name = throwName; throw e; }
    const json = url.includes('tenant_access_token') ? token
      : url.includes('batch_get_id') ? (body.emails[0] in lookupCode ? { code: lookupCode[body.emails[0]], msg: 'rate limited' }
        : { code: 0, data: { user_list: [{ email: body.emails[0], user_id: users[body.emails[0]] }] } })
        : send;
    return { status: 200, json: async () => json };
  };
  return { calls, fetchFn };
}
const RECIPIENTS = toFuseRecipients({ rosterTexts: [ROSTER], author: 'aj0928', fallbackLogin: 'PraiseZhu' });
const message = ({ forwardedFrom }) => toFuseNotifyText({ ...BASE, forwardedFrom });

test('SC1/SC6 发送:取 token → 按邮箱查 open_id → 以 Mivo 应用纯文本私聊作者;每步都带超时', async () => {
  const feishu = fakeFeishu({ users: { 'aj@example.com': 'ou_aj' } });
  const out = await sendFuseNotice({ fetchFn: feishu.fetchFn, appId: 'cli_a9496e1ca2799bb3', appSecret: 's', recipients: RECIPIENTS, message });
  assert.deepEqual(out, { status: 'sent', to: 'aj0928', forwarded: false, reason: null });
  assert.deepEqual(feishu.calls[0].body, { app_id: 'cli_a9496e1ca2799bb3', app_secret: 's' });
  assert.deepEqual(feishu.calls[1].body, { emails: ['aj@example.com'] });
  assert.match(feishu.calls[2].url, /im\/v1\/messages\?receive_id_type=open_id$/);
  assert.equal(feishu.calls[2].body.receive_id, 'ou_aj');
  assert.equal(feishu.calls[2].body.msg_type, 'text');
  assert.equal(JSON.parse(feishu.calls[2].body.content).text, CONFIRMED);
  assert.equal(feishu.calls[2].auth, 'Bearer t-1');
  assert.ok(feishu.calls.every((c) => c.hasSignal));
});

test('SC2 作者在名册里但飞书查不到:转发给兜底人,正文带转发说明', async () => {
  const feishu = fakeFeishu({ users: { 'praise@example.com': 'ou_praise' } });
  const out = await sendFuseNotice({ fetchFn: feishu.fetchFn, appId: 'a', appSecret: 's', recipients: RECIPIENTS, message });
  assert.deepEqual(out, { status: 'sent', to: 'PraiseZhu', forwarded: true, reason: 'feishu-user-not-found' });
  assert.ok(JSON.parse(feishu.calls.at(-1).body.content).text.startsWith('PR #1704 的作者 @aj0928 在名册里没找到对应的飞书账号'));
});

test('SC4 失败给固定原因码,不含飞书返回原文:没凭证、没接收人、token 失败、谁都查不到、发送失败、超时、网络错误', async () => {
  const send = (opts, feishu = fakeFeishu()) => sendFuseNotice({ fetchFn: feishu.fetchFn, appId: 'a', appSecret: 's', recipients: RECIPIENTS, message, ...opts });
  assert.deepEqual(await send({ appSecret: '' }), { status: 'failed', code: 'no-credential' });
  assert.deepEqual(await send({ recipients: [] }), { status: 'failed', code: 'no-recipient' });
  assert.deepEqual(await send({}, fakeFeishu({ token: { code: 10014, msg: 'app secret invalid' } })), { status: 'failed', code: 'token-10014' });
  assert.deepEqual(await send({}, fakeFeishu()), { status: 'failed', code: 'feishu-user-not-found' });
  assert.deepEqual(await send({}, fakeFeishu({ users: { 'aj@example.com': 'ou_aj' }, send: { code: 230002 } })), { status: 'failed', code: 'send-230002' });
  assert.deepEqual(await send({}, fakeFeishu({ throwName: 'TimeoutError' })), { status: 'failed', code: 'timeout' });
  assert.deepEqual(await send({}, fakeFeishu({ throwName: 'TypeError' })), { status: 'failed', code: 'network' });
});

test('配置:没配或 enabled 不是 true 就不发;配了缺项启动即报错', () => {
  assert.deepEqual(toFuseNotifyConfig({}), { enabled: false });
  assert.deepEqual(toFuseNotifyConfig({ convergeFuse: { notify: { enabled: false } } }), { enabled: false });
  const ok = { enabled: true, appId: 'cli_x', keychainService: 'svc', keychainAccount: 'acct', rosterRepos: ['xindong/org'], fallbackLogin: 'PraiseZhu' };
  assert.deepEqual(toFuseNotifyConfig({ convergeFuse: { notify: ok } }), ok);
  assert.throws(() => toFuseNotifyConfig({ convergeFuse: { notify: { ...ok, appId: '' } } }), /appId/);
  assert.throws(() => toFuseNotifyConfig({ convergeFuse: { notify: { ...ok, rosterRepos: ['bad'] } } }), /rosterRepos/);
  // #219:rosterRepos 只是追加,可省略或为空
  assert.deepEqual(toFuseNotifyConfig({ convergeFuse: { notify: { ...ok, rosterRepos: [] } } }).rosterRepos, []);
  const { rosterRepos, ...noRepos } = ok;
  assert.deepEqual(toFuseNotifyConfig({ convergeFuse: { notify: noRepos } }).rosterRepos, []);
});

test('SC4 整个发送过程有总时限:每步都没到 10 秒上限,但合计超时也会中断并记 timeout', async () => {
  assert.equal(FEISHU_TOTAL_TIMEOUT_MS, 30_000);
  assert.equal(FEISHU_STEP_TIMEOUT_MS, 10_000);
  // 每个请求都要 40ms 才回,单步远低于 10 秒;总时限设成 100ms,第三步之前就该被打断
  const calls = [];
  const slowFetch = (url, init) => new Promise((resolve, reject) => {
    calls.push(url);
    const timer = setTimeout(() => resolve({ status: 200, json: async () => (url.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 't' } : { code: 0, data: { user_list: [{ user_id: null }] } }) }), 40);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
  });
  const startedAt = Date.now();
  const out = await sendFuseNotice({ fetchFn: slowFetch, appId: 'a', appSecret: 's', recipients: RECIPIENTS, message, totalTimeoutMs: 100 });
  assert.deepEqual(out, { status: 'failed', code: 'timeout' });
  assert.ok(Date.now() - startedAt < 1_000);
  assert.ok(calls.length >= 2 && calls.length <= 3, `被总时限打断前发了 ${calls.length} 个请求`);
});

// #219 名册对照
test('#219 SC1 名册仓:目标仓组织的 <owner>/org 在前,配置的 rosterRepos 追加、不分大小写去重;配置为空时只有 <owner>/org', () => {
  assert.deepEqual(toFuseRosterRepos({ targetRepo: 'xindong/mivo-canvas-plugin', rosterRepos: [] }), ['xindong/org']);
  assert.deepEqual(toFuseRosterRepos({ targetRepo: 'xindong/mivo-canvas-plugin' }), ['xindong/org']);
  assert.deepEqual(toFuseRosterRepos({ targetRepo: 'xindong/mivo-canvas-plugin', rosterRepos: ['Xindong/Org', 'XDGame/org', 'xdgame/ORG'] }), ['xindong/org', 'XDGame/org']);
  assert.deepEqual(toFuseRosterRepos({ targetRepo: 'PraiseZhu/sandbox', rosterRepos: ['xindong/org'] }), ['PraiseZhu/org', 'xindong/org']);
});

test('#219 SC2 机器人:app/<name>(gh 的 PR 作者写法)和 <name>[bot] 都算,转发原因记 bot-author;真人账号不算', () => {
  for (const login of ['app/dependabot', 'app/praise-qa', 'App/Renovate', 'dependabot[bot]', '', null]) assert.equal(isBotLogin(login), true, String(login));
  for (const login of ['aj0928', 'jackiezxt', 'appleseed', 'bot-maker']) assert.equal(isBotLogin(login), false, login);
  // 名册里恰好有同名行也不当真人发
  const withApp = `${ROSTER}\n| [@app/praise-qa](https://github.com/apps/praise-qa) | 机器人 | qa@example.com | bot |`;
  for (const author of ['app/dependabot', 'app/praise-qa']) {
    assert.deepEqual(toFuseRecipients({ rosterTexts: [withApp], author, fallbackLogin: 'PraiseZhu' }),
      [{ login: 'PraiseZhu', email: 'praise@example.com', forwardedFrom: author, reason: 'bot-author' }]);
  }
});

test('#219 SC3 转发说明:写明作者、原因、要补的名册仓;机器人和发给本人时没有说明', () => {
  assert.equal(toFuseForwardNote({ author: 'jackiezxt', reason: 'not-in-roster', to: 'PraiseZhu', rosterRepo: 'xindong/org' }),
    '飞书通知已转给 @PraiseZhu：作者 @jackiezxt 不在名册里，请补 xindong/org 名册。');
  assert.equal(toFuseForwardNote({ author: 'aj0928', reason: 'feishu-user-not-found', to: 'PraiseZhu', rosterRepo: 'xindong/org' }),
    '飞书通知已转给 @PraiseZhu：作者 @aj0928 在名册里的邮箱飞书查不到，请核对 xindong/org 名册。');
  assert.equal(toFuseForwardNote({ author: 'app/dependabot', reason: 'bot-author', to: 'PraiseZhu', rosterRepo: 'xindong/org' }), null);
  assert.equal(toFuseForwardNote({ author: 'aj0928', reason: null, to: 'aj0928', rosterRepo: 'xindong/org' }), null);
});

test('#219 只查不发:findFeishuUsers 只调取 token 与 batch_get_id,从不调发消息接口;失败给固定原因码', async () => {
  const feishu = fakeFeishu({ users: { 'aj@example.com': 'ou_aj' } });
  const out = await findFeishuUsers({ fetchFn: feishu.fetchFn, appId: 'a', appSecret: 's', emails: ['aj@example.com', 'nobody@example.com'] });
  assert.deepEqual(out, { status: 'ok', found: { 'aj@example.com': true, 'nobody@example.com': false } });
  assert.ok(feishu.calls.every((c) => !c.url.includes('/im/v1/messages')), '不调发消息接口');
  assert.ok(feishu.calls.every((c) => c.hasSignal));
  assert.deepEqual(await findFeishuUsers({ fetchFn: feishu.fetchFn, appId: 'a', appSecret: '', emails: ['x'] }), { status: 'failed', code: 'no-credential' });
  assert.deepEqual(await findFeishuUsers({ fetchFn: fakeFeishu({ token: { code: 10014 } }).fetchFn, appId: 'a', appSecret: 's', emails: ['x'] }), { status: 'failed', code: 'token-10014' });
  assert.deepEqual(await findFeishuUsers({ fetchFn: fakeFeishu({ throwName: 'TimeoutError' }).fetchFn, appId: 'a', appSecret: 's', emails: ['x'] }), { status: 'failed', code: 'timeout' });
});

test('#219 自检 batch_get_id 返回非零 code(限流、权限)是查询失败,不是「查不到」', async () => {
  const limited = fakeFeishu({ users: { 'praise@example.com': 'ou_praise' }, lookupCode: { 'aj@example.com': 99991400 } });
  assert.deepEqual(await findFeishuUsers({ fetchFn: limited.fetchFn, appId: 'a', appSecret: 's', emails: ['aj@example.com'] }), { status: 'failed', code: 'lookup-99991400' });
  // 发送时照旧转给兜底人(通知不能丢),但原因记查询失败码,不记 feishu-user-not-found
  assert.deepEqual(await sendFuseNotice({ fetchFn: limited.fetchFn, appId: 'a', appSecret: 's', recipients: RECIPIENTS, message }),
    { status: 'sent', to: 'PraiseZhu', forwarded: true, reason: 'lookup-99991400' });
  const allDown = fakeFeishu({ lookupCode: { 'aj@example.com': 99991400, 'praise@example.com': 99991400 } });
  assert.deepEqual(await sendFuseNotice({ fetchFn: allDown.fetchFn, appId: 'a', appSecret: 's', recipients: RECIPIENTS, message }), { status: 'failed', code: 'lookup-99991400' });
  assert.equal(toFuseForwardNote({ author: 'aj0928', reason: 'lookup-99991400', to: 'PraiseZhu', rosterRepo: 'xindong/org' }), null);
});
