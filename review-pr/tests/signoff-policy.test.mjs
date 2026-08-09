#!/usr/bin/env node
// signoff-policy.test.mjs — 确认门策略判定的回归:UI 测试路径过滤 + 讨论 issue 收尾/复用
// + 三门(security/arch/rules)触发/放行/重入 + signoff-hold 生产动作 + 排他锁语义。
//
// 为什么在 tests/ 并改用 node:test(round3 D5):本仓文档跑法是 `node --test
// "tests/*.test.mjs"`(见 tests/README.md),tests/ 下 46 个文件全是 node:test;
// 旧文件在 scripts/ 下手写 check()/eq() 计数,glob 命中不到——任何人按文档跑全量
// 测试,对 signoff 门得到 0 覆盖,且本仓无 CI 兜底。与其余 46 个文件保持一致。
//
// round3 增补:
//   - D2 陈旧判据:活 pid + 超 LOCK_STALE_MS 的锁可回收;mutation② 探针:死 pid +
//     新鲜 startedAt 的锁必须回收(isPidAlive 恒 true 会转红);
//   - D3 takeover:新鲜 takeover 残留必须阻塞等待(mutation① 探针:移除两阶段 takeover
//     会转红);超 TTL / round2 裸 pid 残留必须自愈;
//   - D5 解耦鉴别:legacy 清理失败不连坐 labelsOk(mutation③ 探针:回退解耦会转红,
//     旧版所有用例都传 current:[] 导致 legacy 分支从未失败过);
//   - #6 releaseHoldLock:非 ENOENT 的 unlink 失败必须带 unlinkError,不伪装
//     alreadyAbsent:true;
//   - #7 入口守卫失败(--preserve-symlinks-main)必须写 stderr,不再静默 fail-open;
//   - D6 stateful fake gh:三次真实子进程运行共享同一状态文件,端到端验证幂等 claim
//     (三次只建一份 issue)、重入复用旧 issue、renotice 按 head 去重。
//
// 跑:cd review-pr && node --test tests/signoff-policy.test.mjs

import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, cpSync,
  readFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCK_STALE_MS,
} from '../scripts/lib.mjs';
import {
  performIssueCreate, performStatusComment, performLabelSync, computeHeld,
  acquireHoldLock, releaseHoldLock, reconcileDuplicateHoldIssues,
  GH_CALL_TIMEOUT_MS, MAX_RECONCILE_DUPS, CRITICAL_SECTION_MAX_CALLS,
  ESSENTIAL_CALLS, DEFERRABLE_BUDGET, GH_CALL_TIMEOUT_CLAMPED,
} from '../scripts/signoff-hold.mjs';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(TESTS_DIR, '..', 'scripts');


// ── ⑦ signoff-hold 生产动作(SC-3:真加载 signoff-hold.mjs 本体;SC-2:三件套 held 判据)──
// fake ghFn:记录每次调用的 args/opts,按 args 内容分发预设响应,不打真实 gh。
function makeFakeGh(handlers) {
  const calls = [];
  const ghFn = (args, opts) => {
    calls.push({ args, opts });
    for (const h of handlers) {
      if (h.match(args)) return h.result;
    }
    return { ok: true, stdout: '', stderr: '', status: 0 };
  };
  ghFn.calls = calls;
  return ghFn;
}
const isIssueCreate = (a) => a[0] === 'issue' && a[1] === 'create';
const isPrComment = (a) => a[0] === 'pr' && a[1] === 'comment';
const isLabelCreate = (a) => a[0] === 'label' && a[1] === 'create';
const isLabelPost = (a) => a[0] === 'api' && a.includes('-X') && a.includes('POST') && a.some((s) => /\/labels$/.test(s));
const isLegacyDelete = (a) => a[0] === 'api' && a.includes('-X') && a[a.indexOf('-X') + 1] === 'DELETE';

test('signoff: performIssueCreate 成功/失败', () => {
  const ghOk = makeFakeGh([{ match: isIssueCreate, result: { ok: true, stdout: 'https://github.com/acme/app/issues/99\n', stderr: '', status: 0 } }]);
  const r = performIssueCreate({ pr: 42, slug: 'acme/app', kind: 'product', author: 'alice', issueTitle: 'T', issueBody: 'B', ghFn: ghOk });
  assert.equal(r.issueCreated, true, 'issueCreated');
  assert.equal(r.issueUrl, 'https://github.com/acme/app/issues/99', 'issueUrl');
  assert.equal(r.issueError, null, 'issueError 为 null');
  assert.ok(ghOk.calls.some((c) => isIssueCreate(c.args)), '确实调用了 gh issue create');

  const ghFail = makeFakeGh([{ match: isIssueCreate, result: { ok: false, stdout: '', stderr: 'boom-create-failed', status: 1 } }]);
  const rf = performIssueCreate({ pr: 42, slug: 'acme/app', kind: 'product', author: 'alice', issueTitle: 'T', issueBody: 'B', ghFn: ghFail });
  assert.equal(rf.issueCreated, false, '失败:issueCreated=false');
  assert.equal(rf.issueUrl, null, '失败:issueUrl=null');
  assert.ok((rf.issueError ?? '').includes('boom-create-failed'), '失败:issueError 带原因');
});

test('signoff: performStatusComment 成功/失败', () => {
  const ghOk = makeFakeGh([{ match: isPrComment, result: { ok: true, stdout: '', stderr: '', status: 0 } }]);
  const r = performStatusComment({ pr: 42, slug: 'acme/app', kind: 'product', issueUrl: 'https://github.com/acme/app/issues/99', commentBody: '请看讨论', ghFn: ghOk });
  assert.equal(r.commented, true, 'commented');
  assert.equal(r.commentError, null, 'commentError 为 null');
  assert.ok(ghOk.calls.some((c) => isPrComment(c.args)), '确实调用了 gh pr comment');

  const ghFail = makeFakeGh([{ match: isPrComment, result: { ok: false, stdout: '', stderr: 'boom-comment-failed', status: 1 } }]);
  const rf = performStatusComment({ pr: 42, slug: 'acme/app', kind: 'product', issueUrl: 'https://github.com/acme/app/issues/99', commentBody: '请看讨论', ghFn: ghFail });
  assert.equal(rf.commented, false, '失败:commented=false');
  assert.ok(rf.commentError.includes('boom-comment-failed'), '失败:commentError 带原因');
});

// -- performLabelSync(SC-2 核心 fixture:issue+评论成功,标签 POST 失败)--
test('signoff: performLabelSync 成功', () => {
  const ghAllOk = makeFakeGh([
    { match: isLabelCreate, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isLabelPost, result: { ok: true, stdout: '', stderr: '', status: 0 } },
  ]);
  const rOk = performLabelSync({ owner: 'acme', repo: 'app', pr: 42, label: 'needs-discussion', current: [], ghFn: ghAllOk });
  assert.equal(rOk.changed, true, 'changed');
  assert.equal((rOk.errors ?? []).length, 0, '无 errors');
  assert.ok(!rOk.warning, '无 warning');
});

test('signoff: performLabelSync 标签 POST 失败 → errors+warning', () => {
  const ghPostFail = makeFakeGh([
    { match: isLabelCreate, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isLabelPost, result: { ok: false, stdout: '', stderr: 'label POST 失败:权限不足', status: 1 } },
  ]);
  const rFail = performLabelSync({ owner: 'acme', repo: 'app', pr: 42, label: 'needs-discussion', current: [], ghFn: ghPostFail });
  assert.equal(rFail.changed, false, 'changed=false');
  assert.ok((rFail.errors ?? []).length > 0, 'errors 非空(明确失败字段,不是只挂 warning)');
  assert.ok(!!rFail.warning, 'warning 也设置(可读提示)');
});

// round3 D5 鉴别:legacy 清理失败与 signoff 标签同步是两件事——legacy 失败只能走
// legacyErrors/legacyWarning,不得进 errors/warning(labelsOk 不被拖累)。
// 旧版三条变异全绿的根因:所有 performLabelSync 用例都传 current:[],legacy 分支
// 从未失败过。这条用例让 legacy 清理真失败。
test('signoff: D5 解耦——legacy 清理失败不连坐 labelsOk(mutation③ 探针)', () => {
  const ghLegacyFail = makeFakeGh([
    { match: isLabelCreate, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isLabelPost, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isLegacyDelete, result: { ok: false, stdout: '', stderr: 'legacy 清理 403', status: 1 } },
  ]);
  const r = performLabelSync({ owner: 'acme', repo: 'app', pr: 42, label: 'needs-discussion', current: ['need-whitelist'], ghFn: ghLegacyFail });
  assert.equal(r.changed, true, 'signoff 标签本身必须挂上');
  assert.equal((r.errors ?? []).length, 0, 'legacy 失败不得进 errors(否则 labelsOk 被拖成 false)');
  assert.ok(!r.warning, 'legacy 失败不得设置 warning');
  assert.ok((r.legacyErrors ?? []).length > 0, 'legacy 失败单独走 legacyErrors');
  assert.ok(!!r.legacyWarning, 'legacy 失败单独走 legacyWarning');
});

// -- computeHeld(SC-2:三件套全成功才 held;任一失败必须点名 heldBlockedBy,不是只挂侧信道)--
test('signoff: computeHeld 三件套全成功 → held', () => {
  const allGood = computeHeld({ issueCreated: true, priorIssueUrl: null, needIssue: true, commented: true, alreadyHeld: false, labelsOk: true });
  assert.equal(allGood.held, true);
  assert.deepEqual(allGood.heldBlockedBy, []);
});

test('signoff: computeHeld 标签失败 → held=false 点名 labels', () => {
  const labelFail = computeHeld({ issueCreated: true, priorIssueUrl: null, needIssue: true, commented: true, alreadyHeld: false, labelsOk: false });
  assert.equal(labelFail.held, false, 'held=false(不再是「失败不连坐」)');
  assert.ok(labelFail.heldBlockedBy.includes('labels'), 'heldBlockedBy 点名 labels');
  assert.ok(!labelFail.heldBlockedBy.includes('issue') && !labelFail.heldBlockedBy.includes('comment'),
    'heldBlockedBy 不误报 issue/comment');
});

test('signoff: computeHeld issue+评论都失败 → held=false 点名 issue+comment', () => {
  const issueAndCommentFail = computeHeld({ issueCreated: false, priorIssueUrl: null, needIssue: true, commented: false, alreadyHeld: false, labelsOk: true });
  assert.equal(issueAndCommentFail.held, false);
  assert.ok(issueAndCommentFail.heldBlockedBy.includes('issue'));
  assert.ok(issueAndCommentFail.heldBlockedBy.includes('comment'));
});

test('signoff: computeHeld 复用旧 issue(未新建/未新评论但曾 hold 过)→ held=true', () => {
  const reuseCase = computeHeld({ issueCreated: false, priorIssueUrl: 'https://github.com/acme/app/issues/7', needIssue: false, commented: false, alreadyHeld: true, labelsOk: true });
  assert.equal(reuseCase.held, true);
});


// ── ⑨ stateful fake gh(round3 D6)──
// 共享状态文件 $FAKE_GH_STATE:第二个进程能看到第一个进程写下的 issue/评论/标签。
// 无状态 fake gh 的 pr view 恒返回空,测试分不清「锁生效所以只建一份」与「锁失效
// 但 fake gh 看不见」;幂等 claim / 重入复用旧 issue / renotice 去重必须靠共享状态
// 才拿得到端到端真覆盖。
const FAKE_GH_STATEFUL_SRC = `#!/usr/bin/env node
// stateful fake gh(round3 D6):状态存 $FAKE_GH_STATE 共享 JSON——第二个进程能看到
// 第一个进程写下的 issue/评论/标签。FAKE_GH_FAIL_LABEL_ADD=1 时标签添加恒失败,
// 用于 labelsOk 判别。
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const STATE = process.env.FAKE_GH_STATE;
const load = () => {
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    return { issueSeq: 0, issues: {}, comments: [], labels: [], headOid: 'deadbeef', ...s };
  }
  catch { return { issueSeq: 0, issues: {}, comments: [], labels: [], headOid: 'deadbeef' }; }
};
const save = (s) => writeFileSync(STATE, JSON.stringify(s));
if (args[0] === 'pr' && args[1] === 'view') {
  const s = load();
  const num = Number(args[2]);
  process.stdout.write(JSON.stringify({
    number: num, state: 'OPEN', mergedAt: null,
    author: { login: 'tester' }, url: 'https://github.com/acme/app/pull/' + num,
    comments: s.comments.filter((c) => c.pr === num).map((c) => ({ body: c.body })),
    labels: s.labels.filter((l) => l.pr === num).map((l) => ({ name: l.name })),
    headRefOid: s.headOid,
  }));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'create') {
  // round4 D3:竞态屏障(仅 FAKE_GH_RACE_BARRIER 设置时)——两个并发进程都到 create 点
  // 后一起放行,用于真并发 e2e:无锁(mutation 删掉 acquireHoldLock 接线)时双方都到达
  // → 必然双写(测试转红);有锁时第二个进程根本到不了 create(锁互斥),第一个进程
  // 等满短超时(1200ms)放行,只增加少量测试时长。
  if (process.env.FAKE_GH_RACE_BARRIER) {
    appendFileSync(process.env.FAKE_GH_RACE_BARRIER + '/arrivals', process.pid + '\\n');
    const deadline = Date.now() + 1200;
    while (true) {
      const arrivals = readFileSync(process.env.FAKE_GH_RACE_BARRIER + '/arrivals', 'utf8')
        .trim().split('\\n').filter(Boolean).length;
      if (arrivals >= 2 || Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const s = load();
  s.issueSeq += 1;
  s.issues[s.issueSeq] = { state: 'OPEN' };
  save(s);
  process.stdout.write('https://github.com/acme/app/issues/' + s.issueSeq + '\\n');
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'list') {
  // round6 R6-3:reconcile 一次拿 open 集合(不再逐个 view)。
  const s = load();
  const stIdx = args.indexOf('--state');
  const state = (stIdx >= 0 ? args[stIdx + 1] : 'all').toUpperCase();
  const out = Object.entries(s.issues)
    .filter(([, v]) => state === 'ALL' || (v && String(v.state).toUpperCase() === state))
    .map(([num]) => ({ number: Number(num) }));
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') {
  const s = load();
  const num = Number(args[2]);
  const st = s.issues[num] ? s.issues[num].state : (process.env.FAKE_GH_ISSUE_STATE || 'OPEN');
  process.stdout.write(JSON.stringify({ state: st }));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'close') {
  const s = load();
  const num = Number(args[2]);
  if (s.issues[num]) s.issues[num].state = 'CLOSED';
  save(s);
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'comment') {
  const s = load();
  const bodyIdx = args.indexOf('--body');
  const body = bodyIdx >= 0 ? args[bodyIdx + 1] : readFileSync(0, 'utf8');
  s.comments.push({ pr: Number(args[2]), body });
  save(s);
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  const s = load();
  s.comments.push({ pr: Number(args[2]), body: readFileSync(0, 'utf8') });
  save(s);
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'create') process.exit(0);
if (args[0] === 'api' && args.includes('-X')) {
  const x = args.indexOf('-X');
  const method = args[x + 1];
  const m = (args[x + 2] || '').match(/issues\\/(\\d+)\\/labels(?:\\/([^/]+))?$/);
  if (!m) { process.stderr.write('unexpected api call: ' + args.join(' ')); process.exit(1); }
  const num = Number(m[1]);
  if (method === 'POST') {
    if (process.env.FAKE_GH_FAIL_LABEL_ADD === '1') {
      process.stderr.write('HTTP 403: mock label-add failure'); process.exit(1);
    }
    const s = load();
    const f = args[args.indexOf('-f') + 1] || '';
    const name = m[2] || f.replace(/^labels\\[\\]=/, '');
    s.labels.push({ pr: num, name });
    save(s);
    process.exit(0);
  }
  if (method === 'DELETE') {
    const s = load();
    s.labels = s.labels.filter((l) => !(l.pr === num && l.name === m[2]));
    save(s);
    process.exit(0);
  }
}
process.stderr.write('unexpected gh call: ' + args.join(' '));
process.exit(1);
`;

// signoff-hold.mjs 的完整本地依赖闭包(递归解析 `from '...'`,便于带空格/中文路径场景
// 复制到新目录时不缺文件而 ERR_MODULE_NOT_FOUND):
//   signoff-hold.mjs -> lib.mjs -> lib.escaped-hazards.mjs -> lib.review-profiles.mjs,
//   lib.preflight-rules.mjs
const LOCAL_DEPS = [
  'signoff-hold.mjs', 'lib.mjs', 'lib.escaped-hazards.mjs',
  'lib.review-profiles.mjs', 'lib.preflight-rules.mjs',
];

function makeStatefulShimDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-stateful-'));
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, FAKE_GH_STATEFUL_SRC);
  chmodSync(ghPath, 0o755);
  return dir;
}

function makeTempRepoDir() {
  const dir = mkdtempSync(join(tmpdir(), 'signoff-hold-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: dir });
  mkdirSync(join(dir, 'agent-use', 'docs'), { recursive: true });
  writeFileSync(join(dir, 'agent-use', 'docs', 'pr-rules.json'), '{}');
  return dir;
}

// 以真实子进程跑 `node <scriptPath> <args>`,fake gh 走 stateful shim,记录调用到
// logPath。返回 { status, stdout, stderr, calls, parsed }。
function runSignoff({ scriptPath, args, repoDir, shimDir, logPath, statePath, extraEnv = {}, timeout = 15000 }) {
  const r = spawnSync('node', [scriptPath, ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      FAKE_GH_LOG: logPath,
      FAKE_GH_STATE: statePath,
      ...extraEnv,
    },
    timeout,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON,parsed 保持 null 交调用方判失败 */ }
  const calls = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, parsed };
}

// ── ⑩ 入口守卫(D1/mutation②:isMainModule 必须用 realpathSync 归一化比较,不是
//     import.meta.url 与 argv[1] 的裸字符串比较)——
//     symlink / 带空格路径 / 中文路径三种变体下,脚本都必须真正跑到主流程并调用 gh,
//     而不是静默 fail-open(退出码 0、零 gh 调用、空输出)。--
function runEntryGuardVariant(scriptPath) {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  try {
    return runSignoff({ scriptPath, args: ['42', '--dry-run'], repoDir, shimDir, logPath: join(shimDir, 'gh-calls.log'), statePath });
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
}

function assertEntryGuardRan(r, label) {
  assert.equal(r.status, 0, `${label}:退出码 0(非 fail-open) stderr=${r.stderr}`);
  assert.ok(r.calls.some((c) => c[0] === 'pr' && c[1] === 'view'), `${label}:确实调用了 gh pr view`);
  assert.equal(r.parsed?.ok, true, `${label}:stdout 是合法 JSON 且 ok=true`);
}

test('signoff: 入口守卫-直接调用(基线)', () => {
  assertEntryGuardRan(runEntryGuardVariant(join(SCRIPTS_DIR, 'signoff-hold.mjs')), '直接调用');
});

test('signoff: 入口守卫-symlink 调用(realpathSync 穿透符号链接)', () => {
  const linkDir = mkdtempSync(join(tmpdir(), 'signoff-hold-symlink-'));
  const linkPath = join(linkDir, 'signoff-hold-link.mjs');
  symlinkSync(join(SCRIPTS_DIR, 'signoff-hold.mjs'), linkPath);
  try {
    assertEntryGuardRan(runEntryGuardVariant(linkPath), 'symlink 调用');
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
});

test('signoff: 入口守卫-带空格路径(percent-encode 归一)', () => {
  const spaceDir = mkdtempSync(join(tmpdir(), 'signoff hold space '));
  for (const f of LOCAL_DEPS) cpSync(join(SCRIPTS_DIR, f), join(spaceDir, f));
  try {
    assertEntryGuardRan(runEntryGuardVariant(join(spaceDir, 'signoff-hold.mjs')), '带空格路径');
  } finally {
    rmSync(spaceDir, { recursive: true, force: true });
  }
});

test('signoff: 入口守卫-中文路径(percent-encode 归一)', () => {
  const cjkDir = mkdtempSync(join(tmpdir(), 'signoff-hold-cjk-'));
  const cjkTarget = join(cjkDir, '签收保持中文目录');
  mkdirSync(cjkTarget, { recursive: true });
  for (const f of LOCAL_DEPS) cpSync(join(SCRIPTS_DIR, f), join(cjkTarget, f));
  try {
    assertEntryGuardRan(runEntryGuardVariant(join(cjkTarget, 'signoff-hold.mjs')), '中文路径');
  } finally {
    rmSync(cjkDir, { recursive: true, force: true });
  }
});

test('signoff: D4 入口守卫误判(--preserve-symlinks-main)必须 stdout JSON 错误 + 非零退出,不再静默 fail-open', () => {
  // round3 实测:该场景 exit=0、零 gh 调用、stdout 空——自动化消费方按脚本自声明的
  // 「stdout 输出 JSON」契约,会把空 stdout 当成「成功但无结果」,hold 动作从未执行
  // 却没人知道。round4 修复:守卫误判 → stdout 输出 {ok:false, error:...} + 退出码 1。
  const plDir = mkdtempSync(join(tmpdir(), 'signoff-hold-preserve-symlinks-'));
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  const logPath = join(shimDir, 'gh-calls.log');
  try {
    // 依赖闭包放在 symlink 旁边:--preserve-symlinks-main 下相对 import 按 symlink 目录解析
    for (const f of LOCAL_DEPS.filter((x) => x !== 'signoff-hold.mjs')) cpSync(join(SCRIPTS_DIR, f), join(plDir, f));
    symlinkSync(join(SCRIPTS_DIR, 'signoff-hold.mjs'), join(plDir, 'signoff-hold.mjs'));
    const r = spawnSync('node', ['--preserve-symlinks-main', join(plDir, 'signoff-hold.mjs'), '42', '--dry-run'], {
      cwd: repoDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, FAKE_GH_LOG: logPath, FAKE_GH_STATE: statePath },
      timeout: 15000,
    });
    assert.notEqual(r.status, 0, `守卫误判必须非零退出,实际 status=${r.status} stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON */ }
    assert.ok(parsed && parsed.ok === false, `stdout 必须是 {ok:false} JSON,实际:${JSON.stringify(r.stdout)}`);
    assert.equal(parsed.error, 'entry-guard-misclassified', `error 字段点明误判,实际:${JSON.stringify(r.stdout)}`);
    const ghCalls = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : [];
    assert.equal(ghCalls.length, 0, '守卫误判时不得发起任何 gh 调用(没有静默执行半套流程)');
  } finally {
    rmSync(plDir, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('signoff: D4 合法 import 路径完全静默(不输出任何东西)', () => {
  // 被 import(如测试运行器 / 调用方脚本)时 argv[1] 是别的文件,守卫分支不报警、
  // 无输出——这是正常形态,输出任何东西都会污染消费方的 stdout 契约。
  const importDir = mkdtempSync(join(tmpdir(), 'signoff-import-silent-'));
  try {
    for (const f of LOCAL_DEPS) cpSync(join(SCRIPTS_DIR, f), join(importDir, f));
    writeFileSync(join(importDir, 'importer.mjs'),
      "import { acquireHoldLock } from './signoff-hold.mjs';\nconsole.log(typeof acquireHoldLock);\n");
    const r = spawnSync(process.execPath, [join(importDir, 'importer.mjs')], {
      cwd: importDir, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal((r.stdout ?? '').trim(), 'function',
      `import 路径必须静默加载成功(无守卫噪音/无主流程输出),实际 stdout=${JSON.stringify(r.stdout)}`);
  } finally {
    rmSync(importDir, { recursive: true, force: true });
  }
});

// ── ⑪ labelsOk 判别(mutation③:main() 里 labelsOk 不能被写死成 true)──
// 真实子进程 + stateful fake gh:pr view / issue create / pr comment / label create 全
// 放行,只让 label add(api POST .../labels)失败 → labels.warning 为真、held=false、
// heldBlockedBy 点名 labels。
test('signoff: labelsOk 判别——标签 POST 失败 → held=false 点名 labels(mutation③ 探针)', () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-lock-labelfail-'));
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  const logPath = join(shimDir, 'gh-calls.log');
  const payloadPath = join(repoDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify({
    issueTitle: '讨论:labelsOk 判别测试专用 issue',
    issueBody: '本 issue 由 signoff-policy.test.mjs 的 labelsOk 判别测试自动创建。',
    commentBody: '本 PR 待维护者确认,详情见关联 issue。',
  }));
  try {
    const r = runSignoff({
      scriptPath: join(SCRIPTS_DIR, 'signoff-hold.mjs'),
      args: ['42', '--payload-file', payloadPath],
      repoDir, shimDir, logPath, statePath,
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, FAKE_GH_FAIL_LABEL_ADD: '1' },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const labelAddCalled = r.calls.some((c) => c[0] === 'api' && c.includes('-X') && c[c.indexOf('-X') + 1] === 'POST');
    assert.ok(labelAddCalled, '标签失败不是没发生调用(否则断言是真空)', JSON.stringify(r.calls));
    assert.ok(Boolean(r.parsed?.labels?.warning), `labels.warning 为真(标签同步真的失败了) stdout=${r.stdout}`);
    assert.equal(r.parsed?.held, false, 'held 必须为 false(非写死 true——mutation③ 探针)');
    assert.ok(Array.isArray(r.parsed?.heldBlockedBy) && r.parsed.heldBlockedBy.includes('labels'),
      `heldBlockedBy 点名 labels stdout=${r.stdout}`);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

// ── ⑫ D6 端到端幂等(round3 核心:本 PR 头号目标「幂等 claim / 重入不重复开 issue」
//     在共享状态 fake gh 下拿到真覆盖)──
// 三次真实子进程运行共享同一状态文件:
//   运行 1(全新状态):完整模式 → 建 issue + 首发评论 + 挂标签,held=true;
//   运行 2(维护者摘了标签):重入 → 复用旧 issue(不新开)、补状态回帖,held=true;
//   运行 3(标签又被摘 + 标签写入失败):held=false 点名 labels,回帖按 head 去重不再发。
test('signoff: D6 幂等 claim——三次运行只建一份 issue、重入复用、renotice 按 head 去重', () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-multirun-lock-'));
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  const payloadPath = join(repoDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify({
    issueTitle: '讨论:幂等 claim 端到端测试专用 issue',
    issueBody: '本 issue 由 signoff-policy.test.mjs 的 D6 端到端测试自动创建。',
    commentBody: '本 PR 待维护者确认,详情见关联 issue。',
  }));
  const scriptPath = join(SCRIPTS_DIR, 'signoff-hold.mjs');
  const base = { scriptPath, args: ['42', '--payload-file', payloadPath], repoDir, shimDir, statePath, extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir } };
  try {
    // 运行 1:全新状态,完整模式
    const r1 = runSignoff({ ...base, logPath: join(shimDir, 'r1.log') });
    assert.equal(r1.status, 0, `r1 stderr=${r1.stderr}`);
    assert.equal(r1.parsed?.ok, true, `r1 stdout=${r1.stdout}`);
    assert.equal(r1.parsed?.held, true, 'r1 三件套全成功必须 held');
    assert.equal(r1.parsed?.issueCreated, true, 'r1 必须新建 issue');
    assert.equal(r1.parsed?.alreadyHeld, false, 'r1 首次 hold');
    assert.equal(r1.parsed?.issueUrl, 'https://github.com/acme/app/issues/1', 'r1 建出第一份 issue');
    assert.equal(r1.calls.filter((c) => c[0] === 'issue' && c[1] === 'create').length, 1, 'r1 恰好建一份 issue');
    const state1 = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state1.comments.length, 1, 'r1 首发评论只有一条');
    assert.ok(state1.labels.some((l) => l.pr === 42), 'r1 标签已挂上');

    // 运行 2:维护者摘了标签(状态里删掉)→ 重入复用旧 issue,不新开;补状态回帖
    const s2 = JSON.parse(readFileSync(statePath, 'utf8'));
    s2.labels = s2.labels.filter((l) => l.pr !== 42);
    writeFileSync(statePath, JSON.stringify(s2));
    const r2 = runSignoff({ ...base, logPath: join(shimDir, 'r2.log') });
    assert.equal(r2.status, 0, `r2 stderr=${r2.stderr}`);
    assert.equal(r2.parsed?.held, true, `r2 复用路径三件套仍须 held stdout=${r2.stdout}`);
    assert.equal(r2.parsed?.issueCreated, false, 'r2 重入不得再建 issue');
    assert.equal(r2.parsed?.alreadyHeld, true, 'r2 必须看到既有标记评论');
    assert.equal(r2.parsed?.issueUrl, 'https://github.com/acme/app/issues/1', 'r2 复用同一讨论 issue');
    assert.equal(r2.parsed?.renoticed, true, 'r2 标签不在 → 补状态回帖');
    assert.equal(r2.calls.filter((c) => c[0] === 'issue' && c[1] === 'create').length, 0, 'r2 不得再建 issue');

    // 运行 3:标签又被摘 + 标签写入失败 → held=false 点名 labels;回帖按 head 去重不再发
    const s3 = JSON.parse(readFileSync(statePath, 'utf8'));
    s3.labels = s3.labels.filter((l) => l.pr !== 42);
    writeFileSync(statePath, JSON.stringify(s3));
    const r3 = runSignoff({
      ...base,
      logPath: join(shimDir, 'r3.log'),
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, FAKE_GH_FAIL_LABEL_ADD: '1' },
    });
    assert.equal(r3.status, 0, `r3 stderr=${r3.stderr}`);
    assert.equal(r3.parsed?.held, false, `r3 标签失败 → held 必须 false stdout=${r3.stdout}`);
    assert.ok(Array.isArray(r3.parsed?.heldBlockedBy) && r3.parsed.heldBlockedBy.includes('labels'),
      `r3 heldBlockedBy 点名 labels stdout=${r3.stdout}`);
    assert.equal(r3.parsed?.renoticed, false, 'r3 不再补回帖');
    assert.equal(r3.parsed?.renoticeSkipped, 'already-noticed-for-head', 'r3 同一 head 只回一次帖');
    assert.equal(r3.calls.filter((c) => c[0] === 'issue' && c[1] === 'create').length, 0, 'r3 不得再建 issue');
    assert.equal(r3.calls.filter((c) => c[0] === 'pr' && c[1] === 'comment').length, 0, 'r3 回帖去重后不得再发评论');
    const state3 = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state3.comments.length, 2, '三次运行总共只有首发 + 一次回帖两条评论');
    assert.equal(Object.keys(state3.issues ?? {}).length, 1, '三次运行总共只建一份 issue');
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});


// ── round5 R5-1(blocker):有界临界区——上界由代码强制,断言绑实际调用数 ──
// round4 的「最坏 11 次 = 165s < 300s」被复审席实测否掉:对账是 O(重复数),10 个唯一
// hold URL 实测 27 次调用(9 view + 9 close + 9 comment),27×15s=405s 已超租约。
// 本轮:对账每轮最多 MAX_RECONCILE_DUPS 个重复(结构性上界,超出进 unprocessed 报出),
// 临界区总调用数由 ghB 预算强制(超过 CRITICAL_SECTION_MAX_CALLS 不再发出,剩余工作
// 放弃并 fail-visible)。下面第一条只保留租约不等式守恒;真正验收是「对账上界」用例
// 对 10 个重复的**实测调用数**断言(对账数量变化时它会转红,round4 的算术测试不会)。
test('signoff: D2 临界区租约不等式——上界 × 单次超时 < LOCK_STALE_MS(常量守恒)', () => {
  // 推导值:CRITICAL_SECTION_MAX_CALLS = 固定部分 8 + 对账 3×3(见 signoff-hold.mjs
  // 模块注释,固定部分为数据无关调用点枚举口径)。实际调用数由「D2 对账上界」实测绑定。
  assert.ok(CRITICAL_SECTION_MAX_CALLS * GH_CALL_TIMEOUT_MS < LOCK_STALE_MS,
    `最坏总耗时 ${CRITICAL_SECTION_MAX_CALLS * GH_CALL_TIMEOUT_MS}ms 必须 < 租约 ${LOCK_STALE_MS}ms`);
});

test('signoff: D2 对账上界——导出函数层:喂 10 个重复,实际调用 = 1+2×K,剩余进 unprocessed', () => {
  const gh = makeFakeGh([
    { match: (a) => a[0] === 'issue' && a[1] === 'list', result: { ok: true, stdout: JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ number: i + 1 }))), stderr: '', status: 0 } },
    { match: isIssueClose, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isIssueComment, result: { ok: true, stdout: '', stderr: '', status: 0 } },
  ]);
  const urls = Array.from({ length: 10 }, (_, i) => `https://github.com/acme/app/issues/${i + 1}`);
  const r = reconcileDuplicateHoldIssues({ slug: 'acme/app', urls, ghFn: gh });
  // 10 个唯一 URL → 9 个重复;每轮最多处理 MAX_RECONCILE_DUPS 个
  assert.equal(r.closed.length, MAX_RECONCILE_DUPS, `每轮最多关闭 ${MAX_RECONCILE_DUPS} 个重复`);
  assert.equal(r.unprocessed.length, 9 - MAX_RECONCILE_DUPS, '其余重复必须进 unprocessed(数量)');
  assert.ok(r.unprocessed.every((u) => typeof u.url === 'string' && u.url.includes('/issues/')), 'unprocessed 必须带 URL');
  // 断言绑实际调用数:round6 R6-3 后 = 1 次 issue list + 2×K(close+comment),不再逐个 view
  assert.equal(gh.calls.length, 1 + 2 * MAX_RECONCILE_DUPS,
    `实际调用数 = 1 + 2×K(实测 ${gh.calls.length} 次;旧实现 3×K=9 次/轮,已关闭重复零消耗)`);
  assert.ok(gh.calls.length <= 1 + 2 * MAX_RECONCILE_DUPS, '实际调用必须 ≤ 1 + 2×MAX_RECONCILE_DUPS');
});

test('signoff: D2 对账上界——主流程接线:10 个重复,实际调用 ≤ 上界,未处理项报出', () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-bound-lock-'));
  const statePath = join(shimDir, 'state.json');
  const MARKER = '<!-- review-pr:product-gate';
  const N = 10;
  const PRE = {
    issueSeq: N,
    issues: Object.fromEntries(Array.from({ length: N }, (_, i) => [i + 1, { state: 'OPEN' }])),
    comments: Array.from({ length: N }, (_, i) => ({ pr: 42, body: `${MARKER} issue=https://github.com/acme/app/issues/${i + 1} -->` })),
    labels: [],
    headOid: 'deadbeef',
  };
  writeFileSync(statePath, JSON.stringify(PRE));
  const logPath = join(shimDir, 'b.log');
  try {
    const r = runSignoff({
      scriptPath: join(SCRIPTS_DIR, 'signoff-hold.mjs'),
      args: ['42'],
      repoDir, shimDir, logPath, statePath,
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const recon = r.parsed?.reconciliation;
    assert.ok(recon, `输出必须带 reconciliation(含 unprocessed) stdout=${r.stdout}`);
    // 10 个唯一 → 9 个重复:处理 K 个,剩余 9-K 个进 unprocessed(数量 + URL 可见)
    assert.equal(recon.closed.length, MAX_RECONCILE_DUPS, `只处理前 ${MAX_RECONCILE_DUPS} 个重复`);
    assert.equal(recon.unprocessed.length, 9 - MAX_RECONCILE_DUPS, '剩余重复必须报出(数量)');
    assert.ok(recon.unprocessed.every((u) => u.url.startsWith('https://github.com/acme/app/issues/')),
      `unprocessed 必须带未处理 URL,实际:${JSON.stringify(recon.unprocessed)}`);
    assert.ok(r.stdout.includes('"unprocessed"'), '「主动放弃剩余工作」必须可见:输出含 unprocessed 字段');
    // 断言绑实际调用数:去掉上界时 10 个重复 = 27 次对账 + 固定部分 ≈32 次 > 上界;
    // 上界约束下实测调用必须 ≤ CRITICAL_SECTION_MAX_CALLS(反向变异时本断言转红)
    assert.ok(r.calls.length <= CRITICAL_SECTION_MAX_CALLS,
      `实际 gh 调用 ${r.calls.length} 次必须 ≤ 上界 ${CRITICAL_SECTION_MAX_CALLS}(无上界时 10 个重复实测 32 次)`);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const closedCount = Object.values(state.issues ?? {}).filter((i) => i.state === 'CLOSED').length;
    assert.equal(closedCount, MAX_RECONCILE_DUPS, `恰好关闭前 ${MAX_RECONCILE_DUPS} 个重复`);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

// 挂住 fake gh:pr view 卡死 10s(模拟无超时的 gh 调用),其余调用照常快速返回。
const HANGING_GH_SRC = `#!/usr/bin/env node
// round4 D2:挂住 fake gh——pr view 卡死 10s,其余快速返回。
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
}
process.exit(0);
`;

test('signoff: D2 挂住的 gh 调用被超时杀掉——临界区不可能无限挂住', () => {
  const hangDir = mkdtempSync(join(tmpdir(), 'fake-gh-hang-'));
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-hanglock-'));
  const logPath = join(hangDir, 'gh-calls.log');
  writeFileSync(logPath, '');
  const ghPath = join(hangDir, 'gh');
  writeFileSync(ghPath, HANGING_GH_SRC);
  chmodSync(ghPath, 0o755);
  const payloadPath = join(repoDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify({ issueTitle: 'T', issueBody: 'B', commentBody: 'C' }));
  try {
    const t0 = Date.now();
    const r = runSignoff({
      scriptPath: join(SCRIPTS_DIR, 'signoff-hold.mjs'),
      args: ['42', '--payload-file', payloadPath],
      repoDir, shimDir: hangDir, logPath, statePath: join(hangDir, 'state.json'),
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, SIGNOFF_HOLD_GH_TIMEOUT_MS: '500' },
      timeout: 15000,
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `挂住调用必须被超时杀掉(实测 ${elapsed}ms),不允许卡满 10s`);
    assert.notEqual(r.status, 0, `pr view 挂住超时 → fail-closed 非零退出,status=${r.status}`);
    assert.ok((r.stdout ?? '').includes('"ok": false'), `stdout 输出 JSON 错误,实际:${JSON.stringify(r.stdout)}`);
  } finally {
    rmSync(hangDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

// ── round4 D2:GitHub 侧对账(双写自愈)──
const isIssueClose = (a) => a[0] === 'issue' && a[1] === 'close';
const isIssueComment = (a) => a[0] === 'issue' && a[1] === 'comment';

test('signoff: D2 对账——多份 hold issue 保留最早(number 最小),关闭其余并留说明', () => {
  const gh = makeFakeGh([
    { match: (a) => a[0] === 'issue' && a[1] === 'list', result: { ok: true, stdout: JSON.stringify([{ number: 3 }, { number: 5 }]), stderr: '', status: 0 } },
    { match: isIssueClose, result: { ok: true, stdout: '', stderr: '', status: 0 } },
    { match: isIssueComment, result: { ok: true, stdout: '', stderr: '', status: 0 } },
  ]);
  const r = reconcileDuplicateHoldIssues({
    slug: 'acme/app',
    urls: ['https://github.com/acme/app/issues/5', 'https://github.com/acme/app/issues/3', 'https://github.com/acme/app/issues/5'],
    ghFn: gh,
  });
  assert.equal(r.keptUrl, 'https://github.com/acme/app/issues/3', '保留 number 最小(最早创建)的 issue');
  assert.deepEqual(r.closed.map((c) => c.number), [5], '关闭其余(去重后只有 #5)');
  assert.deepEqual(r.errors, [], '无错误');
  const closes = gh.calls.filter((c) => isIssueClose(c.args));
  assert.equal(closes.length, 1, '恰好关一份重复 issue');
  assert.ok(closes[0].args.includes('5'), '关闭的是 #5');
  const comments = gh.calls.filter((c) => isIssueComment(c.args));
  assert.equal(comments.length, 1, '留一条说明');
  assert.ok(comments[0].args.some((a) => a.includes('#3')), '说明指向保留的 #3');
});

test('signoff: D2 对账——单份 / 无 / 跨仓库 URL 都不动作(零 gh 调用)', () => {
  const gh = makeFakeGh([]);
  const r1 = reconcileDuplicateHoldIssues({ slug: 'acme/app', urls: ['https://github.com/acme/app/issues/3'], ghFn: gh });
  assert.equal(r1.keptUrl, 'https://github.com/acme/app/issues/3', '单份保留');
  assert.equal(r1.closed.length, 0, '单份不动作');
  const r2 = reconcileDuplicateHoldIssues({ slug: 'acme/app', urls: [], ghFn: gh });
  assert.equal(r2.keptUrl, null, '无 issue → keptUrl null');
  assert.equal(r2.closed.length, 0);
  const r3 = reconcileDuplicateHoldIssues({
    slug: 'acme/app',
    urls: ['https://github.com/other/repo/issues/9', 'https://github.com/acme/app/issues/2'],
    ghFn: gh,
  });
  assert.equal(r3.keptUrl, 'https://github.com/acme/app/issues/2', '跨仓库 URL 不参与对账');
  assert.equal(r3.closed.length, 0, '跨仓库 URL 不得动作');
  assert.equal(gh.calls.length, 0, '全程零 gh 调用');
});

test('signoff: D2 对账——open 集合查询失败 → errors 点名,不误关', () => {
  const gh = makeFakeGh([
    { match: (a) => a[0] === 'issue' && a[1] === 'list', result: { ok: false, stdout: '', stderr: '403', status: 1 } },
  ]);
  const r = reconcileDuplicateHoldIssues({
    slug: 'acme/app',
    urls: ['https://github.com/acme/app/issues/3', 'https://github.com/acme/app/issues/7'],
    ghFn: gh,
  });
  assert.equal(r.keptUrl, 'https://github.com/acme/app/issues/3', '仍保留最早');
  assert.equal(r.closed.length, 0, '查询失败不误关');
  assert.ok(r.errors.length > 0 && r.errors[0].includes('duplicate-open-state-query-failed'),
    `错误点名 open 集合查询失败,实际:${JSON.stringify(r.errors)}`);
});

// ── round4 D3(blocker):原子 claim 绑定 main()——真并发双子进程 e2e ──
// 两个真实子进程**同时**对同一 PR 跑完整模式,共享锁目录与 fake gh 状态。有锁时
// 恰好 1 个 issue + 1 条评论;竞态屏障(FAKE_GH_RACE_BARRIER,见 stateful shim)在
// mutation(删掉 main() 的 acquireHoldLock 接线)下让两个进程都到 create 点 →
// 必然双写 → 测试转红。
function runSignoffAsync({ scriptPath, args, repoDir, shimDir, logPath, statePath, extraEnv = {}, timeout = 30000 }) {
  return new Promise((resolve) => {
    const r = spawn('node', [scriptPath, ...args], {
      cwd: repoDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, FAKE_GH_LOG: logPath, FAKE_GH_STATE: statePath, ...extraEnv },
      timeout,
    });
    let stdout = '';
    let stderr = '';
    r.stdout.on('data', (d) => { stdout += d; });
    r.stderr.on('data', (d) => { stderr += d; });
    r.on('close', (code, signal) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* 非 JSON */ }
      const calls = existsSync(logPath)
        ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
      resolve({ status: code, signal, stdout, stderr, calls, parsed });
    });
  });
}

test('signoff: D3 真并发双子进程——恰好 1 issue + 1 评论(锁串行化)', async () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-concurrent-lock-'));
  const barrierDir = mkdtempSync(join(tmpdir(), 'signoff-hold-barrier-'));
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  const payloadPath = join(repoDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify({
    issueTitle: '讨论:真并发 e2e 专用 issue',
    issueBody: '本 issue 由 signoff-policy.test.mjs 的真并发测试自动创建。',
    commentBody: '本 PR 待维护者确认,详情见关联 issue。',
  }));
  const scriptPath = join(SCRIPTS_DIR, 'signoff-hold.mjs');
  try {
    const [p1, p2] = await Promise.all([
      runSignoffAsync({
        scriptPath, args: ['42', '--payload-file', payloadPath], repoDir, shimDir,
        logPath: join(shimDir, 'c1.log'), statePath,
        extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, FAKE_GH_RACE_BARRIER: barrierDir },
      }),
      runSignoffAsync({
        scriptPath, args: ['42', '--payload-file', payloadPath], repoDir, shimDir,
        logPath: join(shimDir, 'c2.log'), statePath,
        extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, FAKE_GH_RACE_BARRIER: barrierDir },
      }),
    ]);
    assert.equal(p1.status, 0, `p1 stderr=${p1.stderr}`);
    assert.equal(p2.status, 0, `p2 stderr=${p2.stderr}`);
    assert.equal(p1.parsed?.ok, true, `p1 stdout=${p1.stdout}`);
    assert.equal(p2.parsed?.ok, true, `p2 stdout=${p2.stdout}`);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(Object.keys(state.issues ?? {}).length, 1, `两个并发进程总共只建一份 issue,实际:${JSON.stringify(state.issues)}`);
    assert.equal((state.comments ?? []).length, 1, `两个并发进程总共只发一条评论,实际:${state.comments.length}`);
    const allCreates = [...p1.calls, ...p2.calls].filter((c) => c[0] === 'issue' && c[1] === 'create');
    assert.equal(allCreates.length, 1, `issue create 调用合计 1 次,实际 ${allCreates.length}`);
    // 锁串行化的直接证据:一个进程新建,另一个进程拿锁后看到已 hold → 复用
    assert.ok(p1.parsed?.issueCreated === true || p2.parsed?.issueCreated === true, '至少一个进程新建');
    assert.ok(p1.parsed?.issueCreated === false || p2.parsed?.issueCreated === false, '至少一个进程复用(串行化生效)');
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
    rmSync(barrierDir, { recursive: true, force: true });
  }
});

// ── round4 D2:对账在主流程的接线(删掉 main() 的 reconcile 调用必须转红)──
// 预置两份不同 hold issue 的标记评论 + 两个 OPEN issue → 跑完整模式 → 必须出现
// reconciliation 字段、关闭 #2 保留 #1,且后续复用路径指向保留的 #1。
test('signoff: D2 对账主流程接线——双写残留自愈,保留最早 issue', () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-reconcile-lock-'));
  const statePath = join(shimDir, 'state.json');
  const MARKER = '<!-- review-pr:product-gate';
  const PRE = {
    issueSeq: 2,
    issues: { 1: { state: 'OPEN' }, 2: { state: 'OPEN' } },
    comments: [
      { pr: 42, body: `${MARKER} issue=https://github.com/acme/app/issues/1 -->` },
      { pr: 42, body: `${MARKER} issue=https://github.com/acme/app/issues/2 -->` },
    ],
    labels: [],
    headOid: 'deadbeef',
  };
  writeFileSync(statePath, JSON.stringify(PRE));
  const logPath = join(shimDir, 'r.log');
  try {
    const r = runSignoff({
      scriptPath: join(SCRIPTS_DIR, 'signoff-hold.mjs'),
      args: ['42'],
      repoDir, shimDir, logPath, statePath,
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.parsed?.ok, true, `stdout=${r.stdout}`);
    assert.ok(r.parsed?.reconciliation, `输出必须带 reconciliation 字段,实际:${r.stdout}`);
    assert.equal(r.parsed.reconciliation.keptUrl, 'https://github.com/acme/app/issues/1', '保留最早 issue #1');
    assert.deepEqual(r.parsed.reconciliation.closed.map((c) => c.number), [2], '关闭重复 issue #2');
    assert.equal(r.parsed.issueUrl, 'https://github.com/acme/app/issues/1', '复用路径指向保留的 #1,不再把作者引到已关闭的 #2');
    assert.equal(r.parsed.issueCreated, false, '对账后不新开 issue');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.issues['1'].state, 'OPEN', '#1 保持 OPEN');
    assert.equal(state.issues['2'].state, 'CLOSED', '#2 已关闭');
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// round6 R6-1 / R6-2 / R6-3(三处结构问题 + 三项反向变异探针)
// ══════════════════════════════════════════════════════════════════════════
// R6-1:租约不等式由构造成立(模块顶部公式:T 钳位 + 预算派生)。常量在模块加载时
// 求值,所以按 env 动态 reload 模块本体(带 query 破缓存),断言**生效后的派生量**
// 而不是常量算术。反向变异 = 去掉钳位(退回 Number(env||15000)),T=300000 的
// expectedT 断言必须转红(AssertionError,非崩溃)。
// R7-1 扩充:补上复审实测过的 8 个数值形态(1000/7000/44999/45001/1/0/-1/1e12);
// 0/-1 在 R7-1 后不再是「钳到 1ms」而是「回落默认 15000」(非数值/≤0 一律回落,
// 预算回到 18 次量级,不因单次超时形同虚设而放大);每形态同时断言
// GH_CALL_TIMEOUT_STATE 三态(none/clamped/fallback),钳位与回落可分辨。
const HOLD_MODULE_URL = pathToFileURL(join(SCRIPTS_DIR, 'signoff-hold.mjs')).href;
test('signoff: R6-1 租约耦合——T 钳位/回落默认与派生预算,断言生效后的派生量(unset+8 数值形态+300000)', async () => {
  const clampCap = Math.floor(0.9 * LOCK_STALE_MS / ESSENTIAL_CALLS);
  const cases = [
    { env: undefined, expectedT: 15000, expectClamped: false, state: 'none' },
    { env: '1000', expectedT: 1000, expectClamped: false, state: 'none' },
    { env: '7000', expectedT: 7000, expectClamped: false, state: 'none' },
    { env: '44999', expectedT: 44999, expectClamped: false, state: 'none' },
    { env: '45001', expectedT: clampCap, expectClamped: true, state: 'clamped' },
    { env: '1', expectedT: 1, expectClamped: false, state: 'none' },
    { env: '0', expectedT: 15000, expectClamped: false, state: 'fallback' },
    { env: '-1', expectedT: 15000, expectClamped: false, state: 'fallback' },
    { env: '1e12', expectedT: clampCap, expectClamped: true, state: 'clamped' },
    { env: '300000', expectedT: clampCap, expectClamped: true, state: 'clamped' },
  ];
  const prev = process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS;
  let seq = 0;
  try {
    for (const c of cases) {
      if (c.env === undefined) delete process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS;
      else process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS = c.env;
      const m = await import(`${HOLD_MODULE_URL}?r6-1&n=${seq++}`);
      assert.equal(m.GH_CALL_TIMEOUT_MS, c.expectedT, `T(${c.env ?? 'unset'}) 生效值(钳位/回落后)`);
      assert.equal(m.GH_CALL_TIMEOUT_CLAMPED, c.expectClamped, `clamped 标志(${c.env ?? 'unset'})`);
      assert.equal(m.GH_CALL_TIMEOUT_STATE, c.state, `state(${c.env ?? 'unset'}) 三态可分辨(none/clamped/fallback)`);
      // 断言生效后的派生量(不是常量算术):派生预算 × 钳后 T < 租约
      assert.ok(m.CRITICAL_SECTION_MAX_CALLS * m.GH_CALL_TIMEOUT_MS < m.LOCK_STALE_MS,
        `预算(${m.CRITICAL_SECTION_MAX_CALLS}) × T(${m.GH_CALL_TIMEOUT_MS}) = ${m.CRITICAL_SECTION_MAX_CALLS * m.GH_CALL_TIMEOUT_MS}ms 必须 < 租约 ${m.LOCK_STALE_MS}ms`);
      assert.ok(Number.isInteger(m.CRITICAL_SECTION_MAX_CALLS) && m.CRITICAL_SECTION_MAX_CALLS >= m.ESSENTIAL_CALLS,
        `派生预算 ${m.CRITICAL_SECTION_MAX_CALLS} 必须 ≥ ESSENTIAL_CALLS ${m.ESSENTIAL_CALLS}(必要路径装得进租约)`);
      if (c.state === 'fallback') {
        assert.ok(m.GH_TIMEOUT_WARNINGS.some((w) => w.includes('回落默认')),
          `回落形态(${c.env}) warnings 必须带回落文案,实际:${JSON.stringify(m.GH_TIMEOUT_WARNINGS)}`);
      }
    }
  } finally {
    if (prev === undefined) delete process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS;
    else process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS = prev;
  }
});

// ── round7 R7-1(major):非数值 env 让整套派生量变成 NaN(修复)──
// 反例:SIGNOFF_HOLD_GH_TIMEOUT_MS=abc → Number('abc')=NaN → Math.max(NaN,1)=NaN →
// Math.min(NaN,CLAMP_CAP_MS)=NaN → spawnSync timeout 收到 NaN 越界崩溃(exit=1,
// stdout {"ok":false,"error":"The value of \"timeout\" is out of range..."}),且
// GH_CALL_TIMEOUT_CLAMPED 在 NaN 时报 false 说谎。
// 修法抄 resolve-threads.mjs 的 resolveMinMarkerAgeMs:显式 Number.isFinite 校验,
// 非有限数(NaN/±Infinity)/ ≤0 一律回落默认 15000(不是钳到 1ms)+ 双通道警告
// (stderr 文本 + JSON 顶层 warnings);GH_CALL_TIMEOUT_STATE 三态让「钳位」与
// 「回落」可分辨。反向变异 = 去掉 Number.isFinite 校验 → 下列 finite 断言转红。
// R7-1 收口裁定(lead 2026-08-10):空串 '' 等同未设——CI 模板展开/容器编排/.env
// 产出的空串是「事实上没设」,出警告是给没做错事的运维制造噪音;纯空格 ' ' 是
// 打错,保持 fallback+警告。所以 '' 断言 state=none 且 **必无 warnings**(反向
// 断言静默,不是删断言——将来有人把 '' 改回警告会被这里抓住)。
const R7_FORMS = [
  { raw: 'abc', state: 'fallback' },
  { raw: 'Infinity', state: 'fallback' },
  { raw: '-Infinity', state: 'fallback' },
  { raw: ' ', state: 'fallback' },
  { raw: '', state: 'none' }, // 空串等同未设:静默
];
test('signoff: R7-1 非数值 env——回落默认 15000,派生量全有限,三态可分辨(abc/Infinity/-Infinity/纯空格警告/空串静默)', async () => {
  const prev = process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS;
  let seq = 0;
  try {
    for (const c of R7_FORMS) {
      process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS = c.raw;
      const m = await import(`${HOLD_MODULE_URL}?r7-1&n=${seq++}`);
      const label = JSON.stringify(c.raw);
      // ① 生效 T 是有限正整数(旧实现这里会是 NaN)
      assert.ok(Number.isInteger(m.GH_CALL_TIMEOUT_MS) && m.GH_CALL_TIMEOUT_MS > 0,
        `T(${label}) 必须为有限正整数,实际 ${m.GH_CALL_TIMEOUT_MS}`);
      assert.equal(m.GH_CALL_TIMEOUT_MS, 15000, `T(${label}) 生效默认 15000(不是钳到 1ms)`);
      // ② 派生预算/可延后池都是有限整数(旧实现全 NaN)
      assert.ok(Number.isInteger(m.CRITICAL_SECTION_MAX_CALLS) && m.CRITICAL_SECTION_MAX_CALLS > 0,
        `派生预算(${label}) 必须为有限正整数,实际 ${m.CRITICAL_SECTION_MAX_CALLS}`);
      assert.ok(Number.isInteger(m.DEFERRABLE_BUDGET) && m.DEFERRABLE_BUDGET > 0,
        `可延后池(${label}) 必须为有限正整数,实际 ${m.DEFERRABLE_BUDGET}`);
      // ③ 租约不等式仍成立(预算 × T < 租约)
      assert.ok(m.CRITICAL_SECTION_MAX_CALLS * m.GH_CALL_TIMEOUT_MS < m.LOCK_STALE_MS,
        `预算(${m.CRITICAL_SECTION_MAX_CALLS}) × T(${m.GH_CALL_TIMEOUT_MS}) = ${m.CRITICAL_SECTION_MAX_CALLS * m.GH_CALL_TIMEOUT_MS}ms 必须 < 租约 ${m.LOCK_STALE_MS}ms`);
      // ④ 三态与警告:state 按形态断言;clamped 布尔不说谎;fallback 必须带回落
      //    文案;none(空串/未设)必须静默——反向断言无 warnings
      assert.equal(m.GH_CALL_TIMEOUT_STATE, c.state, `state(${label}) 必须为 ${c.state}`);
      assert.equal(m.GH_CALL_TIMEOUT_CLAMPED, false, `clamped(${label}) 必须为 false——回落/默认不是钳位,布尔不得说谎`);
      if (c.state === 'fallback') {
        assert.ok(m.GH_TIMEOUT_WARNINGS.some((w) => w.includes('回落默认')),
          `warnings(${label}) 必须带回落文案,实际:${JSON.stringify(m.GH_TIMEOUT_WARNINGS)}`);
      } else {
        assert.equal(m.GH_TIMEOUT_WARNINGS.length, 0,
          `warnings(${label}) 必须为空(空串等同未设,静默默认),实际:${JSON.stringify(m.GH_TIMEOUT_WARNINGS)}`);
      }
    }
  } finally {
    if (prev === undefined) delete process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS;
    else process.env.SIGNOFF_HOLD_GH_TIMEOUT_MS = prev;
  }
});

test('signoff: R7-1 主流程——非数值 env 不再崩溃,回落默认 + 双通道警告(stderr + JSON warnings)', () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const statePath = join(shimDir, 'state.json');
  writeFileSync(statePath, '{}');
  try {
    const r = runSignoff({
      scriptPath: join(SCRIPTS_DIR, 'signoff-hold.mjs'),
      args: ['42', '--dry-run'],
      repoDir, shimDir, logPath: join(shimDir, 'gh-calls.log'), statePath,
      extraEnv: { SIGNOFF_HOLD_GH_TIMEOUT_MS: 'abc' },
    });
    // 旧实现:exit=1 + {"ok":false,"error":"The value of \"timeout\" is out of range..."}
    assert.equal(r.status, 0, `非数值 env 必须不再崩溃(旧实现 spawnSync timeout=NaN 越界),stderr=${r.stderr}`);
    assert.equal(r.parsed?.ok, true, `stdout 必须 ok=true(回落默认后正常执行),stdout=${r.stdout}`);
    assert.ok(r.stderr.includes('回落默认'), `stderr 必须带回落警告,实际:${r.stderr.slice(0, 300)}`);
    assert.ok(r.parsed?.warnings?.length > 0 && r.parsed.warnings.some((w) => w.includes('回落默认')),
      `JSON 顶层 warnings 必须带回落警告,实际:${JSON.stringify(r.parsed?.warnings)}`);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// R6-2 饿死防护(主流程级实测):可延后工作(10 个重复对账 + 9 个 legacy 标签)在
// T=300000(被钳)下池被收窄到 0——reconcile 循环排在 issue create **之前**,若共享
// 同一池会吃光预算让真正的 hold 发不出去;双池后 ghE 额度纹丝不动,essential 调用
// 必须全部发出且成功,可延后部分报出未处理项。
test('signoff: R6-2 预算分层——可延后吃光额度不影响必要路径(issue create 仍发出,饿死不可达)', () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-starve-lock-'));
  const statePath = join(shimDir, 'state.json');
  const logPath = join(shimDir, 's.log');
  const MARKER = '<!-- review-pr:product-gate';
  // kept #1 已 CLOSED(复用判定 → 需要新开 issue),#2..#10 全 OPEN(对账可延后工作),
  // labels 挂满 9 个 legacy(legacy 清理也是可延后工作)
  const LEGACY_NAMES = ['awaiting-maintainer-discussion', 'needs-maintainer-approval', 'need-whitelist',
    'need-whitelist:product', 'need-whitelist:arch', 'need-whitelist:security',
    'need-whitelist:cold', 'need-whitelist:coldupdate', 'need-whitelist:rules'];
  const PRE = {
    issueSeq: 10,
    issues: { 1: { state: 'CLOSED' }, ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 2, { state: 'OPEN' }])) },
    comments: Array.from({ length: 10 }, (_, i) => ({ pr: 42, body: `${MARKER} issue=https://github.com/acme/app/issues/${i + 1} -->` })),
    labels: LEGACY_NAMES.map((name) => ({ pr: 42, name })),
    headOid: 'deadbeef',
  };
  writeFileSync(statePath, JSON.stringify(PRE));
  const payloadPath = join(repoDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify({ issueTitle: 'T', issueBody: 'B', commentBody: 'C' }));
  try {
    const r = runSignoff({
      scriptPath: join(SCRIPTS_DIR, 'signoff-hold.mjs'),
      args: ['42', '--payload-file', payloadPath],
      repoDir, shimDir, logPath, statePath,
      extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir, SIGNOFF_HOLD_GH_TIMEOUT_MS: '300000' },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    // 钳位警告必须输出(运行者看得见生效值)
    assert.ok(r.stderr.includes('已钳为'), `被钳时 stderr 必须有钳位警告,实际:${r.stderr.slice(0, 200)}`);
    // 不可延后的调用全部发出且成功:真正的 hold 挂上了
    assert.equal(r.parsed?.issueCreated, true, `issue create 必须发出(可延后循环排在它前面也吃不到 ghE 额度),stdout=${r.stdout}`);
    assert.equal(r.parsed?.commented, true, 'status comment 必须发出');
    assert.equal(r.parsed?.held, true, `三件套全成功 → held=true,实际 heldBlockedBy=${JSON.stringify(r.parsed?.heldBlockedBy)}`);
    // 可延后部分报出未处理项:对账 9 个全 unprocessed,legacy 清理全 legacyErrors
    assert.equal(r.parsed?.reconciliation?.unprocessed.length, 9, `对账未处理项必须报出,实际:${JSON.stringify(r.parsed?.reconciliation)}`);
    assert.equal(r.parsed?.reconciliation?.closed.length, 0, '池收窄时本轮一个重复都不关(全交下轮)');
    assert.ok(r.parsed?.labels?.legacyWarning, `legacy 清理预算耗尽必须报 legacyWarning,实际:${JSON.stringify(r.parsed?.labels)}`);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});

// R6-3 多轮收敛(导出函数层):10 个重复(9 个 dup),cap=3 → 恰好 3 轮收敛到 0;
// 每轮剩余 open 严格递减;已关闭的重复第 2/3 轮零 close/comment 消耗。
// 反向变异 = 退回固定切片(不看 state)时「严格递减」断言必须转红。
test('signoff: R6-3 多轮收敛——10 个重复连续跑到 0,每轮剩余严格递减,已关的不再消耗', () => {
  const state = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, 'OPEN']));
  const calls = [];
  const ghFn = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') {
      const open = [...state.entries()].filter(([, s]) => s === 'OPEN').map(([n]) => ({ number: n }));
      return { ok: true, stdout: JSON.stringify(open), stderr: '', status: 0 };
    }
    if (args[0] === 'issue' && args[1] === 'close') { state.set(Number(args[2]), 'CLOSED'); return { ok: true, stdout: '', stderr: '', status: 0 }; }
    if (args[0] === 'issue' && args[1] === 'comment') return { ok: true, stdout: '', stderr: '', status: 0 };
    throw new Error('unexpected gh call: ' + args.join(' '));
  };
  const urls = Array.from({ length: 10 }, (_, i) => `https://github.com/acme/app/issues/${i + 1}`);
  const rounds = [];
  let prevOpen = 9;
  for (let round = 1; round <= 5; round++) {
    const r = reconcileDuplicateHoldIssues({ slug: 'acme/app', urls, ghFn });
    const remaining = [...state.entries()].filter(([n, s]) => s === 'OPEN' && n > 1).length;
    rounds.push({
      round,
      closed: r.closed.map((c) => c.number),
      unprocessed: r.unprocessed.map((u) => u.number),
      remaining_open: remaining,
    });
    assert.ok(remaining < prevOpen, `第 ${round} 轮剩余 open 重复 ${remaining} 必须严格递减(上轮 ${prevOpen})——固定切片会每轮取同一段,永远不前进`);
    prevOpen = remaining;
    if (remaining === 0) break;
  }
  assert.equal(prevOpen, 0, '连续多轮后剩余 open 重复必须为 0');
  assert.equal(rounds.length, 3, `cap=${MAX_RECONCILE_DUPS},9 个 open 重复 → 恰好 3 轮收敛,实际 ${rounds.length} 轮`);
  assert.deepEqual(rounds[0].closed, [2, 3, 4], '第 1 轮关最小的 3 个 open 重复');
  assert.deepEqual(rounds[1].closed, [5, 6, 7], '第 2 轮跳过已关闭的 #2-#4,关下一批');
  assert.deepEqual(rounds[2].closed, [8, 9, 10], '第 3 轮收敛');
  assert.deepEqual(rounds[0].unprocessed, [5, 6, 7, 8, 9, 10], '第 1 轮未处理项报出');
  assert.deepEqual(rounds[1].unprocessed, [8, 9, 10], '第 2 轮未处理项报出');
  // 已关闭的重复不再消耗额度:总计恰好 9 次 close(kept #1 不关、每重复只关一次)
  const closeCalls = calls.filter((a) => a[0] === 'issue' && a[1] === 'close');
  assert.equal(closeCalls.length, 9, `已关闭的重复不得再次消耗 close,实际 ${closeCalls.length} 次`);
});

// R6-3 主流程级多轮收敛:同一 stateful shim 状态连跑 3 轮真实子进程,每轮输出
// closed/unprocessed/剩余 open,断言严格递减且最终 0(「下一轮会 Y」类时序声称必须
// 跑多轮——单轮绿是这类声称的典型假象)。
test('signoff: R6-3 主流程多轮收敛——10 个重复 3 轮跑完,每轮 closed/unprocessed/剩余 open 实测', () => {
  const shimDir = makeStatefulShimDir();
  const repoDir = makeTempRepoDir();
  const lockDir = mkdtempSync(join(tmpdir(), 'signoff-hold-converge-lock-'));
  const statePath = join(shimDir, 'state.json');
  const MARKER = '<!-- review-pr:product-gate';
  const N = 10;
  const PRE = {
    issueSeq: N,
    issues: Object.fromEntries(Array.from({ length: N }, (_, i) => [i + 1, { state: 'OPEN' }])),
    comments: Array.from({ length: N }, (_, i) => ({ pr: 42, body: `${MARKER} issue=https://github.com/acme/app/issues/${i + 1} -->` })),
    labels: [],
    headOid: 'deadbeef',
  };
  writeFileSync(statePath, JSON.stringify(PRE));
  const seen = [];
  try {
    for (let round = 1; round <= 4; round++) {
      const r = runSignoff({
        scriptPath: join(SCRIPTS_DIR, 'signoff-hold.mjs'),
        args: ['42'],
        repoDir, shimDir, logPath: join(shimDir, `conv-${round}.log`), statePath,
        extraEnv: { SIGNOFF_HOLD_LOCK_DIR: lockDir },
      });
      assert.equal(r.status, 0, `第 ${round} 轮 stderr=${r.stderr}`);
      const recon = r.parsed?.reconciliation ?? {};
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      const remaining = Object.entries(state.issues ?? {}).filter(([n, v]) => v.state === 'OPEN' && Number(n) > 1).length;
      seen.push({
        round,
        closed: (recon.closed ?? []).map((c) => c.number),
        unprocessed: (recon.unprocessed ?? []).map((u) => u.number),
        remaining_open: remaining,
      });
      if (remaining === 0) break;
    }
    assert.ok(seen.length >= 2 && seen.length <= 3,
      `cap=${MAX_RECONCILE_DUPS} 时 9 个 open 重复应 3 轮收敛,实际 ${seen.length} 轮:${JSON.stringify(seen)}`);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i].remaining_open < seen[i - 1].remaining_open,
        `第 ${seen[i].round} 轮剩余 ${seen[i].remaining_open} 必须 < 上轮 ${seen[i - 1].remaining_open}(固定切片永不前进)`);
    }
    assert.equal(seen[seen.length - 1].remaining_open, 0, `最终收敛到 0,实际轮次:${JSON.stringify(seen)}`);
    // 已关闭的重复不再消耗 close/comment:第 2 轮的调用日志里不得出现 #2-#4 的 close
    const round2Calls = existsSync(join(shimDir, 'conv-2.log'))
      ? readFileSync(join(shimDir, 'conv-2.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const round2Closed = round2Calls.filter((a) => a[0] === 'issue' && a[1] === 'close').map((a) => Number(a[2]));
    assert.ok(!round2Closed.some((n) => n <= 4), `第 2 轮不得再关已关闭的 #2-#4,实际:${JSON.stringify(round2Closed)}`);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  }
});
