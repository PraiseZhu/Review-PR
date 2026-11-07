// fuse-gate.test.mjs — 审查熔断接进判门(PraiseZhu/Review-PR#209):用 round.mjs 里真实的 holdForFuse 等函数源码(vm),
// gh 与本机 reviews.json 换成内存替身。证明:满 10 版不派审、作者再推也不派;熔断 issue 只开一次;「继续审」后恢复并关 issue;
// dry-run 不写 GitHub;作者是维护者也照样熔断。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import * as fuse from '../lib/fuse.mjs';
import { toFuseRecipients, toFuseNotifyText, toFuseRosterRepos, toFuseForwardNote, isBotLogin, selectRosterEmail } from '../lib/feishu-notify.mjs';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
const section = /^\/\/ ── 审查熔断\(#209\)[\s\S]*?(?=^async function executeGateAction)/m.exec(source)?.[0];
assert.ok(section, '找不到 round.mjs 的审查熔断段');
assert.match(source, /return \(await holdForFuse\(ctx, task, live, result\)\) \?\? dispatchReview\(ctx, task, \{ tier: decision\.tier, action: 'review' \}/,
  '判门送审前必须先过 holdForFuse');
assert.match(source, /try \{ await remindRosterGap\(task, live\); \} catch \(error\) \{ log\('roster-check-error'/, '判门读完 context 后要先核对作者在不在名册,出错只记日志');
assert.match(source, /if \(next\.dispatch\) return \(await holdForFuse\(ctx, task, live, result\)\) \?\? dispatchReview\(/, '受保护路径复核派审前也要过 holdForFuse');

const CONFIG_FUSE = { enabled: true, maxVersions: 10, resumeLine: '继续审', maintainers: ['praisezhu', 'aj0928'], notify: { enabled: false } };
const NOTIFY = { enabled: true, appId: 'cli_x', keychainService: 'svc', keychainAccount: 'acct', rosterRepos: ['xindong/org'], fallbackLogin: 'PraiseZhu' };
const ROSTER = '| GitHub | Name | Email | Role |\n|---|---|---|---|\n| [@aj0928](https://github.com/aj0928) | 甲 | aj@example.com | dev |\n| [@PraiseZhu](https://github.com/PraiseZhu) | 乙 | praise@example.com | lead |';
const tenVersions = (prefix = 'h') => Array.from({ length: 10 }, (_, i) => ({ fp: `patch:${prefix}${i}`, head: `${prefix}${i}`, at: `2026-11-07T0${i}:00:00.000Z` }));

function makeWorld({ mode = 'live', record = {}, comments = [], createOk = true, closeOk = true, commentsOk = true, listOk = true, openIssues = [], issueState = 'OPEN', pageSize = 100,
  notify = null, sendResult = { status: 'sent', to: 'aj0928', forwarded: false, reason: null }, secretOk = true, rosterOk = true, sendCrash = false, rosterSource = 'local-clone',
  author = 'aj0928', targetRepo = 'o/r', findResult = (emails) => ({ status: 'ok', found: Object.fromEntries(emails.map((e) => [e, true])) }), stateFiles = {} } = {}) {
  const sends = [];
  const rosterLoads = [];
  const finds = [];
  const store = { prs: { 1704: structuredClone(record) } };
  const calls = [];
  const finished = [];
  const logs = [];
  let issueNo = 900;
  const runGh = (cmd, args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'create') return createOk ? { ok: true, stdout: `https://github.com/o/r/issues/${++issueNo}\n` } : { ok: false, stderr: 'HTTP 403' };
    if (args[0] === 'issue' && args[1] === 'close') return closeOk ? { ok: true, stdout: '' } : { ok: false, stderr: 'HTTP 502' };
    if (args[0] === 'issue' && args[1] === 'comment') return { ok: true, stdout: '' };
    if (cmd === 'security') return secretOk ? { ok: true, stdout: 'app-secret\n' } : { ok: false, stderr: 'not found' };
    return { ok: false, stderr: `unexpected ${args.join(' ')}` };
  };
  const sandbox = {
    CONFIG: { mode, targetRepo, repoRoot: '/repo' }, ENV: {}, join,
    ...fuse,
    fuseConfig: () => (notify ? { ...CONFIG_FUSE, notify } : CONFIG_FUSE),
    toFuseRecipients, toFuseNotifyText, toFuseRosterRepos, toFuseForwardNote, isBotLogin, selectRosterEmail,
    findFeishuUsers: async (args) => { finds.push(args); return findResult(args.emails); },
    loadOrgRosters: (repos) => { rosterLoads.push(repos); return rosterOk ? { rosters: [{ repo: 'xindong/org', source: rosterSource, text: ROSTER }], fetchErrors: [] } : { rosters: [], fetchErrors: [{ repo: 'xindong/org', error: 'x' }] }; },
    stateFile: (name) => `/state/mivo/${name}`,
    readJson: (file, fallback) => (file in stateFiles ? structuredClone(stateFiles[file]) : fallback),
    writeJson: (file, value) => { stateFiles[file] = structuredClone(value); },
    sendFuseNotice: async (args) => { sends.push({ ...args, text: args.message({ forwardedFrom: args.recipients[0]?.forwardedFrom ?? null }) }); if (sendCrash) throw new Error('进程在记结果前退出'); return sendResult; },
    loadStore: () => structuredClone(store),
    bumpOwned: (ctx, task, patch) => { store.prs[task.pr] = { ...(store.prs[task.pr] ?? {}), ...structuredClone(patch) }; },
    finishGate: (ctx, task, result) => { finished.push(structuredClone(result)); return { dispatched: false }; },
    toLiveBlockers: () => [],
    run: runGh,
    ghRead: (args) => {
      calls.push(args);
      if (args.includes('graphql')) {
        if (!commentsOk) return { ok: false, stderr: 'HTTP 502' };
        // 按页从旧到新:after=<下标> 是游标
        const after = args.find((a) => String(a).startsWith('after='));
        const start = after ? Number(after.slice(6)) : 0;
        const nodes = comments.slice(start, start + pageSize);
        const next = start + pageSize < comments.length;
        return { ok: true, stdout: JSON.stringify({ data: { repository: { issue: { state: issueState,
          comments: { pageInfo: { hasNextPage: next, endCursor: next ? String(start + pageSize) : null }, nodes } } } } }) };
      }
      if (args.includes(`repos/${targetRepo}/issues`)) return listOk ? { ok: true, stdout: JSON.stringify([openIssues]) } : { ok: false, stderr: 'HTTP 502' };
      return { ok: false, stderr: `unexpected ${args.join(' ')}` };
    },
    log: (event, detail) => logs.push({ event, ...detail }),
    logOnce: (key, event, detail) => logs.push({ event, ...detail }),
    assertNotFenced: () => {},
    writeText: () => {},
    nowIso: () => '2026-11-07T12:00:00.000Z',
  };
  vm.runInNewContext(`${section}\nglobalThis.hold = holdForFuse;\nglobalThis.remind = remindRosterGap;`, sandbox);
  const live = { meta: { title: '对话出图判定', url: 'https://github.com/o/r/pull/1704', author } };
  const remind = (pr = 1704, who = author) => sandbox.remind({ pr }, { meta: { ...live.meta, author: who } });
  const gate = async (head) => {
    const result = { outcome: 'review', reason: '', errors: [], warnings: [], gate: { stage: 'review', actions: [] } };
    const out = await sandbox.hold({ roundDir: '/round' }, { pr: 1704, head }, live, result);
    return { out, result };
  };
  return { gate, remind, store, calls, finished, logs, comments, sends, rosterLoads, finds, stateFiles };
}

test('SC3 满 10 版:判门不派审,记 maintainer-signoff + gate.fuse;作者再推 3 个提交仍不派审', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } } });
  const first = await world.gate('h9');
  assert.deepEqual(first.out, { dispatched: false }, '返回非 null 即不调 dispatchReview');
  assert.equal(first.result.outcome, 'maintainer-signoff');
  assert.equal(first.result.gate.fuse.count, 10);
  for (const head of ['n1', 'n2', 'n3']) assert.deepEqual((await world.gate(head)).out, { dispatched: false }, head);
  assert.equal(world.finished.length, 4);
  assert.ok(world.finished.every((r) => r.outcome === 'maintainer-signoff' && r.reviewClean !== true));
});

test('没满 10 版或当前 head 已审查通过:不拦,照常派审', async () => {
  assert.equal((await makeWorld({ record: { fuse: { versions: tenVersions().slice(0, 9) } } }).gate('h9')).out, null);
  assert.equal((await makeWorld({ record: { fuse: { versions: tenVersions() }, cleanHead: 'h9' } }).gate('h9')).out, null);
});

test('SC4 熔断 issue 只开一次:标题前缀与标记正确,issue 号记进本机记录;作者 aj0928 是维护者也照样熔断', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), lastFindings: { P0: 0, P1: 0, P2: 5 } } } });
  await world.gate('h9');
  await world.gate('h9');
  await world.gate('n1');
  const creates = world.calls.filter((args) => args[0] === 'issue' && args[1] === 'create');
  assert.equal(creates.length, 1);
  assert.ok(creates[0][creates[0].indexOf('--title') + 1].startsWith('审查熔断 · PR #1704'));
  assert.equal(world.store.prs[1704].fuse.trip.issue, 901);
  assert.equal(world.finished.at(-1).gate.fuse.issue, 901);
  assert.match(world.finished.at(-1).reason, /#901 回「继续审」/);
});

test('开 issue 失败:记 error 并 retry,不写熔断记录,下一轮再开', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, createOk: false });
  const { result } = await world.gate('h9');
  assert.equal(result.retry, true);
  assert.match(result.errors[0], /熔断 issue 没开出来/);
  assert.equal(world.store.prs[1704].fuse.trip, undefined);
});

test('SC5「继续审」:有效评论 → 清熔断、记 resumedAt、关 issue,这一轮照常派审;版本数从 0 重新算', async () => {
  const trip = { issue: 901, at: '2026-11-07T11:00:00.000Z', count: 10, head: 'h9' };
  const world = makeWorld({
    record: { fuse: { versions: tenVersions(), trip } },
    comments: [{ author: { login: 'kirozeng' }, body: '继续审', createdAt: '2026-11-07T11:05:00Z', isMinimized: false, databaseId: 5 },
      { author: { login: 'aj0928' }, body: '继续审', createdAt: '2026-11-07T11:30:00Z', isMinimized: false, databaseId: 6 }],
  });
  const { out } = await world.gate('h9');
  assert.equal(out, null, '恢复后这一轮照常派审');
  assert.equal(world.store.prs[1704].fuse.trip, null);
  assert.equal(world.store.prs[1704].fuse.resumedAt, '2026-11-07T11:30:00Z', '作者本人(也是维护者)那条有效;kirozeng 不在本测试的维护者名单里');
  const close = world.calls.find((args) => args[0] === 'issue' && args[1] === 'close');
  assert.equal(close[0], 'issue');
  assert.equal(close[1], 'close');
  assert.equal(close[2], '901');
  assert.equal(fuse.toFuseCount(world.store.prs[1704].fuse), 0);
});

test('SC5 没有有效「继续审」:照旧停审,不关 issue,不重开 issue', async () => {
  const trip = { issue: 901, at: '2026-11-07T11:00:00.000Z', count: 10, head: 'h9' };
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), trip } },
    comments: [{ author: { login: 'aj0928' }, body: '先别继续审', createdAt: '2026-11-07T11:05:00Z', isMinimized: false }] });
  assert.deepEqual((await world.gate('n1')).out, { dispatched: false });
  assert.equal(world.calls.filter((args) => args[0] === 'issue').length, 0);
});

test('SC6 dry-run:熔断只记 dryRunActions,不写 GitHub、不写本机熔断记录', async () => {
  const world = makeWorld({ mode: 'dry-run', record: { fuse: { versions: tenVersions() } } });
  const { result } = await world.gate('h9');
  assert.deepEqual(JSON.parse(JSON.stringify(result.dryRunActions)), ['fuse-issue:create']);
  assert.equal(world.calls.length, 0);
  assert.equal(world.store.prs[1704].fuse.trip, undefined);
});

test('熔断关闭时不读 store、不拦', async () => {
  const sandbox = { fuseConfig: () => ({ enabled: false }), loadStore: () => { throw new Error('不该读'); } };
  vm.runInNewContext(`${section}\nglobalThis.hold = holdForFuse;`, sandbox);
  assert.equal(await sandbox.hold({}, { pr: 1, head: 'h' }, {}, {}), null);
});

// #211 单审的三条 P2:评论读不到要 retry;开 issue 前查重、沿用已开的;恢复时先关 issue,关失败不清熔断。
const TRIP = { issue: 901, at: '2026-11-07T11:00:00.000Z', count: 10, head: 'h9' };
const RESUME = [{ author: { login: 'aj0928' }, body: '继续审', createdAt: '2026-11-07T11:30:00Z', isMinimized: false, databaseId: 6 }];

test('评论读不到:照旧停审,记 retry(同一条「继续审」只唤醒一次,不 retry 就会一直停着)', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), trip: TRIP } }, comments: RESUME, commentsOk: false });
  const { out, result } = await world.gate('h9');
  assert.deepEqual(out, { dispatched: false });
  assert.equal(result.retry, true);
  assert.match(result.warnings.at(-1), /评论读不到,照旧停审,下一轮再读/);
  assert.deepEqual(world.store.prs[1704].fuse.trip, TRIP);
});

test('开 issue 前查重:开着的 issue 里已有这个 PR 的熔断 issue(上一轮开成功、本机没记上)就沿用,不重开', async () => {
  const marker = (pr) => `<!-- mivo-fuse pr=${pr} -->\n正文`;
  const openIssues = [
    { number: 950, title: '审查熔断 · PR #17040：审到第 10 版还没放行', body: marker(17040) },
    { number: 951, title: '审查熔断 · PR #1704：审到第 10 版还没放行', body: marker(1704), pull_request: { url: 'x' } },
    { number: 952, title: '审查熔断 · PR #1704：审到第 10 版还没放行', body: marker(1704) },
  ];
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, openIssues });
  const { result } = await world.gate('h9');
  assert.equal(world.calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length, 0);
  assert.equal(world.store.prs[1704].fuse.trip.issue, 952);
  assert.equal(result.gate.fuse.issue, 952);
});

test('开 issue 前读不到开着的 issue 列表:不开、记 error 并 retry,不写熔断记录', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, listOk: false });
  const { out, result } = await world.gate('h9');
  assert.deepEqual(out, { dispatched: false }, '照旧停审');
  assert.equal(world.calls.filter((args) => args[0] === 'issue').length, 0);
  assert.equal(result.retry, true);
  assert.match(result.errors[0], /读不到开着的 issue 列表/);
  assert.equal(world.store.prs[1704].fuse.trip, undefined);
});

test('恢复时关 issue 失败:不清熔断、不派审,记 error 并 retry;下一轮关成功才恢复', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), trip: TRIP } }, comments: RESUME, closeOk: false });
  const first = await world.gate('h9');
  assert.deepEqual(first.out, { dispatched: false });
  assert.equal(first.result.retry, true);
  assert.match(first.result.errors[0], /没关掉,先不恢复送审/);
  assert.deepEqual(world.store.prs[1704].fuse.trip, TRIP);
  const retried = makeWorld({ record: structuredClone(world.store.prs[1704]), comments: RESUME });
  assert.equal((await retried.gate('h9')).out, null);
  assert.equal(retried.store.prs[1704].fuse.trip, null);
});

// #211 复审的两条 P2:评论按页读全(唤醒被推迟、期间又讨论了一百多条时不漏);issue 已关(上一轮关成功、本机没清记录)就不再关。
test('「继续审」之后又有 150 条讨论:按页读全,仍能恢复', async () => {
  const chatter = Array.from({ length: 150 }, (_, i) => ({ author: { login: 'aj0928' }, body: `讨论 ${i}`, createdAt: `2026-11-07T11:${String(31 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, isMinimized: false }));
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), trip: TRIP } }, comments: [...RESUME, ...chatter] });
  assert.equal((await world.gate('h9')).out, null, '恢复派审');
  assert.equal(world.calls.filter((args) => args.includes('graphql')).length, 2, '100 + 50 两页');
  assert.ok(world.calls.filter((args) => args.includes('graphql'))[1].includes('after=100'));
  assert.equal(world.store.prs[1704].fuse.trip, null);
});

test('issue 已经关了(上一轮关成功、本机清记录前崩溃):不再调用关闭,直接清熔断并恢复派审', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), trip: TRIP } }, comments: RESUME, issueState: 'CLOSED', closeOk: false });
  assert.equal((await world.gate('h9')).out, null);
  assert.equal(world.calls.filter((args) => args[0] === 'issue').length, 0, '不再关已关的 issue');
  assert.equal(world.store.prs[1704].fuse.trip, null);
});

test('issue 被人关了但没有有效「继续审」:照旧停审,不清熔断', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), trip: TRIP } }, comments: [], issueState: 'CLOSED' });
  assert.deepEqual((await world.gate('h9')).out, { dispatched: false });
  assert.deepEqual(world.store.prs[1704].fuse.trip, TRIP);
});

// #210 熔断时的飞书私聊:开出熔断 issue 后发一次,结果记进 fuse.trip.notify;失败在 issue 下留一行原因码;dry-run 只记动作。
test('SC1/SC3 熔断开出 issue 后给作者发 1 次私聊,文案带 PR 链接与 issue 链接;之后每轮重判都不再发', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions(), lastFindings: { P0: 0, P1: 1, P2: 4 } } }, notify: NOTIFY });
  await world.gate('h9');
  await world.gate('h9');
  await world.gate('n1');
  assert.equal(world.sends.length, 1);
  const [send] = world.sends;
  assert.equal(send.appId, 'cli_x');
  assert.equal(send.appSecret, 'app-secret');
  assert.deepEqual(JSON.parse(JSON.stringify(send.recipients.map((r) => r.login))), ['aj0928', 'PraiseZhu']);
  assert.equal(send.text, toFuseNotifyText({ pr: 1704, title: '对话出图判定', count: 10, open: 5, prUrl: 'https://github.com/o/r/pull/1704', issueUrl: 'https://github.com/o/r/issues/901' }));
  assert.equal(world.store.prs[1704].fuse.trip.notify.status, 'sent');
  assert.equal(world.store.prs[1704].fuse.trip.notify.to, 'aj0928');
  assert.ok(!JSON.stringify(world.store.prs[1704].fuse.trip.notify).includes('@example.com'), '本机记录不写邮箱');
  assert.ok(!JSON.stringify(world.logs).includes('@example.com') && !JSON.stringify(world.logs).includes('app-secret'), '日志不写邮箱和凭证');
});

test('SC3 Mini 重启后(本机记录已有 notify)不重发;「继续审」恢复后再次熔断是新的一次,会再发', async () => {
  const sentTrip = { issue: 901, at: '2026-11-07T11:00:00.000Z', count: 10, head: 'h9', notify: { status: 'sent', at: 'x', to: 'aj0928' } };
  const restarted = makeWorld({ record: { fuse: { versions: tenVersions(), trip: sentTrip } }, notify: NOTIFY });
  await restarted.gate('n1');
  assert.equal(restarted.sends.length, 0);
  const resumedAt = '2026-11-07T11:30:00.000Z';
  const later = Array.from({ length: 10 }, (_, i) => ({ fp: `patch:new${i}`, head: `m${i}`, at: `2026-11-07T12:0${i}:00.000Z` }));
  const again = makeWorld({ record: { fuse: { versions: [...tenVersions(), ...later], trip: null, resumedAt } }, notify: NOTIFY });
  await again.gate('m9');
  assert.equal(again.sends.length, 1);
});

test('SC4 发送失败:记 warning、在熔断 issue 下留一行「飞书通知未送达:原因码」,熔断照常、不重发', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, notify: NOTIFY, sendResult: { status: 'failed', code: 'timeout' } });
  const first = await world.gate('h9');
  assert.deepEqual(first.out, { dispatched: false }, '熔断照常');
  assert.match(first.result.warnings.join('\n'), /熔断飞书通知未送达:timeout/);
  const comment = world.calls.find((args) => args[0] === 'issue' && args[1] === 'comment');
  assert.equal(comment[2], '901');
  assert.equal(comment[comment.indexOf('--body') + 1], '飞书通知未送达：timeout');
  assert.equal(world.store.prs[1704].fuse.trip.notify.status, 'failed');
  await world.gate('h9');
  assert.equal(world.sends.length, 1, '失败也不循环重发');
  assert.equal(world.calls.filter((args) => args[1] === 'comment').length, 1);
});

test('SC4 名册读不到:不调用发送,直接记 roster-unavailable 并留说明', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, notify: NOTIFY, rosterOk: false });
  await world.gate('h9');
  assert.equal(world.sends.length, 0);
  assert.equal(world.store.prs[1704].fuse.trip.notify.code, 'roster-unavailable');
});

test('钥匙串里没有密钥:把空密钥交给发送函数(它返回 no-credential),不会读到别的地方', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, notify: NOTIFY, secretOk: false, sendResult: { status: 'failed', code: 'no-credential' } });
  await world.gate('h9');
  assert.equal(world.sends[0].appSecret, '');
  assert.equal(world.store.prs[1704].fuse.trip.notify.code, 'no-credential');
});

test('SC5 dry-run:不真发,只在 dryRunActions 记「发飞书私聊」与接收人', async () => {
  const world = makeWorld({ mode: 'dry-run', record: { fuse: { versions: tenVersions() } }, notify: NOTIFY });
  const { result } = await world.gate('h9');
  assert.deepEqual(JSON.parse(JSON.stringify(result.dryRunActions)), ['fuse-issue:create', 'fuse-notify:feishu:@aj0928']);
  assert.equal(world.sends.length, 0);
  assert.equal(world.calls.length, 0);
});

test('沙箱配置关闭通知:熔断照常,不发私聊', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } } });
  await world.gate('h9');
  assert.equal(world.sends.length, 0);
  assert.equal(world.store.prs[1704].fuse.trip.notify, undefined);
});

test('SC3 发出去以后、记结果之前进程崩溃:本机已记「正在发」,重启后不补发,不会重复私聊', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, notify: NOTIFY, sendCrash: true });
  await assert.rejects(world.gate('h9'), /进程在记结果前退出/);
  assert.equal(world.sends.length, 1);
  assert.equal(world.store.prs[1704].fuse.trip.notify.status, 'sending');
  const restarted = makeWorld({ record: structuredClone(world.store.prs[1704]), notify: NOTIFY });
  await restarted.gate('h9');
  assert.equal(restarted.sends.length, 0);
  assert.equal(restarted.calls.filter((args) => args[0] === 'issue').length, 0, '也不重开 issue、不留言');
});

test('SC2 转发时私聊只用确认文案的转发说明,具体原因码记在本机记录里', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, notify: NOTIFY,
    sendResult: { status: 'sent', to: 'PraiseZhu', forwarded: true, reason: 'feishu-user-not-found' } });
  await world.gate('h9');
  assert.deepEqual(JSON.parse(JSON.stringify(world.store.prs[1704].fuse.trip.notify)).reason, 'feishu-user-not-found');
  assert.equal(world.store.prs[1704].fuse.trip.notify.forwarded, true);
});

// #219 名册对照:名册仓按目标仓组织推导;转给兜底人时在熔断 issue 下留一行说明;不在名册的新作者提前提醒一次。
const forwardNotes = (world) => world.calls.filter((args) => args[0] === 'issue' && args[1] === 'comment').map((args) => args[args.indexOf('--body') + 1]);

test('#219 SC1 熔断通知读的名册仓 = 目标仓组织的 <owner>/org + 配置追加(去重);配置为空也照样对照', async () => {
  const world = makeWorld({ targetRepo: 'xindong/mivo-canvas-plugin', record: { fuse: { versions: tenVersions() } }, notify: { ...NOTIFY, rosterRepos: ['XDGame/org', 'xindong/org'] } });
  await world.gate('h9');
  assert.deepEqual(JSON.parse(JSON.stringify(world.rosterLoads)), [['xindong/org', 'XDGame/org']]);
  const empty = makeWorld({ targetRepo: 'xindong/mivo-canvas-plugin', record: { fuse: { versions: tenVersions() } }, notify: { ...NOTIFY, rosterRepos: [] } });
  await empty.gate('h9');
  assert.deepEqual(JSON.parse(JSON.stringify(empty.rosterLoads)), [['xindong/org']]);
  assert.equal(empty.sends.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(empty.sends[0].recipients.map((r) => r.login))), ['aj0928', 'PraiseZhu'], '配置为空也按推导出的名册对到作者');
});

test('#219 SC3 转给兜底人(作者不在名册 / 飞书查不到)时熔断 issue 下留一行说明:作者、原因、要补的名册仓;发给作者本人时不留', async () => {
  const notInRoster = makeWorld({ targetRepo: 'xindong/mivo-canvas-plugin', author: 'jackiezxt', record: { fuse: { versions: tenVersions() } }, notify: NOTIFY,
    sendResult: { status: 'sent', to: 'PraiseZhu', forwarded: true, reason: 'not-in-roster' } });
  const { result } = await notInRoster.gate('h9');
  assert.deepEqual(forwardNotes(notInRoster), ['飞书通知已转给 @PraiseZhu：作者 @jackiezxt 不在名册里，请补 xindong/org 名册。']);
  assert.match(result.warnings.join('\n'), /转给了 @PraiseZhu\(not-in-roster\),请核对 xindong\/org 名册/);
  const notFound = makeWorld({ targetRepo: 'xindong/mivo-canvas-plugin', record: { fuse: { versions: tenVersions() } }, notify: NOTIFY,
    sendResult: { status: 'sent', to: 'PraiseZhu', forwarded: true, reason: 'feishu-user-not-found' } });
  await notFound.gate('h9');
  assert.deepEqual(forwardNotes(notFound), ['飞书通知已转给 @PraiseZhu：作者 @aj0928 在名册里的邮箱飞书查不到，请核对 xindong/org 名册。']);
  const direct = makeWorld({ targetRepo: 'xindong/mivo-canvas-plugin', record: { fuse: { versions: tenVersions() } }, notify: NOTIFY });
  await direct.gate('h9');
  assert.deepEqual(forwardNotes(direct), [], '发给作者本人不留说明');
  const bot = makeWorld({ targetRepo: 'xindong/mivo-canvas-plugin', author: 'app/dependabot', record: { fuse: { versions: tenVersions() } }, notify: NOTIFY,
    sendResult: { status: 'sent', to: 'PraiseZhu', forwarded: true, reason: 'bot-author' } });
  await bot.gate('h9');
  assert.deepEqual(forwardNotes(bot), [], '机器人作者没法补名册,不留说明');
  for (const w of [notInRoster, notFound]) assert.ok(!forwardNotes(w).join('').includes('@example.com'), '说明里不写邮箱');
});

test('#219 SC4 不在名册的真人作者第一次判门记一条 roster-missing,同一账号不再提醒;机器人作者、名册里对得上的不提醒', async () => {
  const stateFiles = {};
  const world = makeWorld({ targetRepo: 'xindong/mivo-canvas-plugin', notify: NOTIFY, stateFiles });
  await world.remind(1704, 'jackiezxt');
  await world.remind(1705, 'JackieZXT');
  await world.remind(1706, 'app/praise-qa');
  await world.remind(1707, 'dependabot[bot]');
  await world.remind(1708, 'aj0928');
  await world.remind(1709, 'aj0928');
  const missing = world.logs.filter((e) => e.event === 'roster-missing');
  assert.deepEqual(JSON.parse(JSON.stringify(missing)), [{ event: 'roster-missing', pr: 1704, author: 'jackiezxt', reason: 'not-in-roster', rosterRepo: 'xindong/org' }]);
  assert.equal(world.finds.length, 1, '名册里对得上的账号只查一次飞书,核对结果记账');
  const logins = stateFiles['/state/mivo/roster-check.json'].logins;
  assert.deepEqual(Object.keys(logins).sort(), ['aj0928', 'jackiezxt']);
  assert.equal(logins.jackiezxt.status, 'missing');
  assert.equal(logins.aj0928.status, 'ok');
  assert.ok(!JSON.stringify(stateFiles).includes('@example.com') && !JSON.stringify(world.logs).includes('@example.com'), '状态文件和日志不写邮箱');
  assert.equal(world.calls.filter((args) => args[0] === 'issue' || args[0] === 'pr').length, 0, '不在 PR 或 issue 上评论');
  // Mini 重启:状态文件还在,不重复提醒
  const restarted = makeWorld({ targetRepo: 'xindong/mivo-canvas-plugin', notify: NOTIFY, stateFiles });
  await restarted.remind(1710, 'jackiezxt');
  assert.equal(restarted.logs.filter((e) => e.event === 'roster-missing').length, 0);
});

test('#219 SC4 名册里有邮箱但飞书查不到也提醒;名册读不到、飞书查询失败时不下结论、不记账,下次再查;dry-run 与通知关闭时不做', async () => {
  const notFound = makeWorld({ notify: NOTIFY, findResult: (emails) => ({ status: 'ok', found: Object.fromEntries(emails.map((e) => [e, false])) }) });
  await notFound.remind(1704, 'aj0928');
  assert.deepEqual(notFound.logs.filter((e) => e.event === 'roster-missing').map((e) => e.reason), ['feishu-user-not-found']);
  const stateFiles = {};
  const down = makeWorld({ notify: NOTIFY, rosterOk: false, stateFiles });
  await down.remind(1704, 'jackiezxt');
  assert.deepEqual(down.logs.map((e) => e.event), ['roster-check-skip']);
  assert.deepEqual(stateFiles, {}, '名册读不到不记账');
  const feishuDown = makeWorld({ notify: NOTIFY, stateFiles, findResult: () => ({ status: 'failed', code: 'timeout' }) });
  await feishuDown.remind(1704, 'aj0928');
  assert.deepEqual(feishuDown.logs.map((e) => [e.event, e.reason]), [['roster-check-skip', 'timeout']]);
  assert.deepEqual(stateFiles, {}, '飞书查询失败不记账');
  for (const world of [makeWorld({ mode: 'dry-run', notify: NOTIFY }), makeWorld({})]) {
    await world.remind(1704, 'jackiezxt');
    assert.deepEqual(world.logs, []);
    assert.deepEqual(world.rosterLoads, []);
  }
});

test('#219 自检 名册只拿到本机旧副本(pull 失败):新作者提醒不下结论、不记账;熔断转发说明改说「请核对」,不断定作者不在名册', async () => {
  const stateFiles = {};
  const stale = makeWorld({ notify: NOTIFY, stateFiles, rosterSource: 'local-clone(stale,本次 pull 失败)' });
  await stale.remind(1704, 'jackiezxt');
  assert.deepEqual(stale.logs.map((e) => [e.event, e.reason]), [['roster-check-skip', 'roster-unavailable']]);
  assert.deepEqual(stateFiles, {}, '旧副本不记账');
  const fused = makeWorld({ targetRepo: 'xindong/mivo-canvas-plugin', author: 'jackiezxt', record: { fuse: { versions: tenVersions() } }, notify: NOTIFY,
    rosterSource: 'local-clone(stale,本次 pull 失败)', sendResult: { status: 'sent', to: 'PraiseZhu', forwarded: true, reason: 'not-in-roster' } });
  await fused.gate('h9');
  assert.deepEqual(forwardNotes(fused), ['飞书通知已转给 @PraiseZhu：作者 @jackiezxt 不在名册的本机旧副本里（这次没拉到最新名册），请核对 xindong/org 名册。']);
});

test('#219 自检 飞书查询本身失败(lookup-<code>)而转给兜底人时,不在熔断 issue 留「请补名册」', async () => {
  const world = makeWorld({ record: { fuse: { versions: tenVersions() } }, notify: NOTIFY,
    sendResult: { status: 'sent', to: 'PraiseZhu', forwarded: true, reason: 'lookup-99991400' } });
  await world.gate('h9');
  assert.deepEqual(forwardNotes(world), []);
  assert.equal(world.store.prs[1704].fuse.trip.notify.reason, 'lookup-99991400');
});
