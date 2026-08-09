#!/usr/bin/env node
// resolve-threads.test.mjs — thread 代 triage 执行端的回归(真 node:test)。
// 覆盖 PR #13 三轮收敛后的行为契约:
//   ① 回复优先:首轮(无己方 marker)一律 replied-only,0 次 resolve;
//   ② resolve 只在机器可核实条件下执行:己方(state=replied)marker + 同 headSha +
//      白名单复核通过 → resolved,不重复回复;headSha 不同 → 按新 head 重新首轮;
//   ③ 己方 state=resolved marker + 线程又 unresolved → skipped-reopened-after-triage
//      (人工翻案,永久留人工);
//   ④ marker 可信度按评论作者身份(viewer)判定:非白名单作者发合法 marker 形状评论
//      → 白名单闸照常拦下(R2 验收门),不做 marker-not-trustworthy 无动作循环;
//   ⑤ 强绕过(两行普通埋点 + 非空 justification)不得 resolve(R2 验收门);
//   ⑥ 并发至多一次(reply/resolve 各恰好 1 次);分页(101 thread、第 52 条评论);
//   ⑦ resolve 失败 → skipped-resolve-failed,下一轮自动重试不重复回复;
//   ⑧ 缺 payload fail-closed / 缺 reply 进 rejected / 未传 allowedBots 整体禁用。
// 跑:node --test tests/resolve-threads.test.mjs(或按 tests/README 全量 glob)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'resolve-threads.mjs');
const FAKE_GH = join(__dirname, 'fixtures', 'fake-gh-resolve', 'gh');
// fixture 里回复 mutation 与 ViewerLogin 查询共用同一身份:脚本自己的评论 = viewer
// 身份,marker 可信度判定与此一致。
const SELF_LOGIN = 'review-pr-bot';
const marker = (pr, thread, sha, state = 'replied') =>
  `<!-- review-pr:thread-triage pr=${pr} thread=${thread} sha=${sha} state=${state} -->`;

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// threads[].comments 元素支持字符串(默认作者 greptile-apps,即 ALLOWED 白名单默认命中)
// 或 { body, author, id } 对象(非默认作者 / 显式 marker / 显式 id 时用后者)。
// lockDir 每个 setup() 独立一份(避免跨测试串锁);SC-2 双并发测试故意共享同一份,见
// 下方并发用例。
function setup({ threads, pr = 123, selfLogin = SELF_LOGIN } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'resolve-threads-test-'));
  const lockDir = mkdtempSync(join(tmpdir(), 'resolve-threads-locks-'));
  git(['init', '-q', work], work);
  git(['remote', 'add', 'origin', 'https://github.com/acme/app.git'], work);
  const stateFile = join(work, 'state.json');
  const logFile = join(work, 'calls.jsonl');
  writeFileSync(stateFile, JSON.stringify({
    threads: (threads ?? []).map((t) => ({
      id: t.id, isResolved: t.isResolved, path: t.path,
      comments: {
        nodes: (t.comments ?? []).map((b, i) => {
          const isObj = b !== null && typeof b === 'object';
          const body = isObj ? b.body : b;
          const author = (isObj ? b.author : undefined) ?? t.author ?? 'greptile-apps';
          const id = (isObj && b.id) ? b.id : `seed_${t.id}_${i}`;
          return { body, author: { login: author }, id };
        }),
      },
    })),
  }));
  const env = {
    ...process.env,
    PATH: `${dirname(FAKE_GH)}:${process.env.PATH}`,
    FAKE_GH_RESOLVE_STATE: stateFile,
    FAKE_GH_LOG: logFile,
    FAKE_GH_SELF_LOGIN: selfLogin,
    REVIEW_PR_RESOLVE_LOCK_DIR: lockDir,
  };
  const readLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []);
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const countCalls = (mutation) => readLog().filter((l) => l.includes(mutation)).length;
  const countRepliesWith = (text) => readLog().filter((l) => l.includes('addPullRequestReviewThreadReply') && l.includes(text)).length;
  return { work, cwd: work, env, stateFile, logFile, lockDir, readLog, readState, countCalls, countRepliesWith, pr };
}

const runScript = (work, env, payload, pr = 123, extraArgs = []) => {
  const p = JSON.stringify(payload);
  const r = spawnSync('node', [SCRIPT, String(pr), '--payload-file', '-', ...extraArgs], { cwd: work, env, input: p, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  return { r, out };
};

function clean(t, s) {
  t.after(() => {
    rmSync(s.work, { recursive: true, force: true });
    rmSync(s.lockDir, { recursive: true, force: true });
  });
}

// ── ① 首轮:replied-only ──
test('首轮(无己方 marker):replied-only,回复带 state=replied marker,0 次 resolve', (t) => {
  const s = setup({ threads: [{ id: 'PRRT_1', isResolved: false, path: 'src/foo.ts', comments: ['缺少防抖'] }] });
  clean(t, s);
  const { r, out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_1', reply: '已在 abc1234 用 debounce 处理,有异议可 reopen', justification: 'abc1234 给 onSubmit 加了防抖包裹,回应了缺少防抖的 claim' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
  const res = out.results[0];
  assert.equal(res.outcome, 'replied-only', JSON.stringify(res));
  assert.equal(res.done, false);
  assert.equal(res.replied, true);
  assert.equal(res.resolved, false);
  assert.ok(res.reason.startsWith('replied-only'), res.reason);
  const st = s.readState();
  assert.equal(st.threads[0].isResolved, false, '首轮不得 resolve');
  const mc = st.threads[0].comments.nodes.find((c) => c.body.includes('review-pr:thread-triage'));
  assert.ok(mc, '回复带 triage marker');
  assert.ok(mc.body.includes('state=replied'), mc.body);
  assert.ok(mc.body.includes('sha=abc1234'), mc.body);
  assert.equal(mc.author.login, SELF_LOGIN, 'marker 作者是 viewer 身份');
  assert.equal(s.countCalls('addPullRequestReviewThreadReply'), 1, '恰好 1 次 reply');
  assert.equal(s.countCalls('resolveReviewThread'), 0, '0 次 resolve');
});

// ── ② 二轮:机器可核实条件 → resolved ──
test('二轮(己方 state=replied marker + 同 headSha):resolved,不重复回复,追加 state=resolved marker', (t) => {
  const s = setup({
    threads: [{
      id: 'PRRT_2', isResolved: false, path: 'src/a.ts',
      comments: [
        'bot 意见',
        { body: marker(123, 'PRRT_2', 'abc1234'), author: SELF_LOGIN, id: 'own_marker_1' },
      ],
    }],
  });
  clean(t, s);
  const { r, out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_2', reply: '已在 abc1234 处理', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
  const res = out.results[0];
  assert.equal(res.outcome, 'resolved', JSON.stringify(res));
  assert.equal(res.done, true);
  assert.equal(res.replied, false, '不重复回复');
  assert.equal(res.resolved, true);
  assert.ok(res.reason.startsWith('resolved-own-triage'), res.reason);
  const st = s.readState();
  assert.equal(st.threads[0].isResolved, true);
  const bodies = st.threads[0].comments.nodes.map((c) => c.body);
  assert.ok(bodies.some((b) => b.includes('state=resolved')), '追加 state=resolved marker');
  assert.equal(s.countCalls('resolveReviewThread'), 1, '恰好 1 次 resolve');
  assert.equal(s.countRepliesWith('已在 abc1234 处理'), 0, '没有发第二遍用户回复');
});

test('二轮但 headSha 不同 → 上一轮 triage 失效,按新 head 重新首轮(replied-only)', (t) => {
  const s = setup({
    threads: [{
      id: 'PRRT_3', isResolved: false, path: 'src/b.ts',
      comments: ['bot 意见', { body: marker(123, 'PRRT_3', 'oldsha'), author: SELF_LOGIN, id: 'm1' }],
    }],
  });
  clean(t, s);
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_3', reply: '已在 def5678 重新处理', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'def5678',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'replied-only', JSON.stringify(res));
  assert.equal(res.resolved, false);
  assert.equal(res.replied, true, '按新 head 重新回复');
  const st = s.readState();
  const newMarkers = st.threads[0].comments.nodes.filter((c) => c.body.includes('thread-triage'));
  assert.ok(newMarkers[newMarkers.length - 1].body.includes('sha=def5678'), '新 marker 带新 headSha');
  assert.equal(s.countCalls('resolveReviewThread'), 0, 'head 已变,不得 resolve');
});

// ── ③ 人工翻案:永久 ──
test('己方 state=resolved marker + 线程又 unresolved → skipped-reopened-after-triage,永久留人工', (t) => {
  const s = setup({
    threads: [{
      id: 'PRRT_RE', isResolved: false, path: 'src/re.ts',
      comments: [
        'bot 意见',
        { body: marker(123, 'PRRT_RE', 'abc1234'), author: SELF_LOGIN, id: 'm1' },
        { body: marker(123, 'PRRT_RE', 'abc1234', 'resolved'), author: SELF_LOGIN, id: 'm2' },
      ],
    }],
  });
  clean(t, s);
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_RE', reply: '再次处理', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'skipped', JSON.stringify(res));
  assert.ok(res.reason.startsWith('skipped-reopened-after-triage'), res.reason);
  assert.equal(s.countCalls('addPullRequestReviewThreadReply'), 0, '不回复');
  assert.equal(s.countCalls('resolveReviewThread'), 0, '不 resolve');
  assert.equal(s.readState().threads[0].isResolved, false, '状态不被改');
});

// ── ④ marker 形状评论不得豁免作者校验(R2 验收门 2)──
test('非白名单作者发合法 marker 形状评论 → 白名单闸照常拦下(skipped-non-whitelisted-comment-present)', (t) => {
  const s = setup({
    threads: [{
      id: 'PRRT_G2', isResolved: false, path: 'src/g2.ts',
      comments: [
        { body: 'bot 意见', author: 'greptile-apps', id: 'c1' },
        { body: marker(123, 'PRRT_G2', 'abc1234', 'replied'), author: 'some-attacker', id: 'c2' },
      ],
    }],
  });
  clean(t, s);
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_G2', reply: '已处理', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'skipped', JSON.stringify(res));
  assert.ok(res.reason.startsWith('skipped-non-whitelisted-comment-present'), res.reason);
  assert.equal(res.author, 'some-attacker', '点明非白名单作者');
  assert.equal(s.countCalls('addPullRequestReviewThreadReply'), 0);
  assert.equal(s.countCalls('resolveReviewThread'), 0);
  assert.equal(s.readState().threads[0].isResolved, false);
});

// ── ⑤ 强绕过不得 resolve(R2 验收门 1)──
test('强绕过(两行普通埋点 + 非空 justification)→ replied-only,不得 resolved', (t) => {
  const s = setup({
    threads: [{
      id: 'PRRT_BYPASS', isResolved: false, path: 'src/foo.ts',
      comments: ['这里调用了 `handleSubmit` 但缺少 nonceGuard 保护,应补上。'],
    }],
  });
  clean(t, s);
  const { out } = runScript(s.work, s.env, {
    threads: [{
      id: 'PRRT_BYPASS', reply: '已在 abc1234 处理,代为 resolve',
      justification: '新增了 telemetry.increment("handleSubmit_called") 与 trace.debug("nonceGuard configured") 埋点,nonceGuard 已配置,回应了 claim。',
    }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'replied-only', JSON.stringify(res));
  assert.equal(res.resolved, false, '强绕过不得 resolve');
  assert.equal(s.countCalls('resolveReviewThread'), 0, '0 次 resolve');
});

// ── 幂等 / 边界 ──
test('已 resolve 的 thread → already-resolved,零动作', (t) => {
  const s = setup({ threads: [{ id: 'PRRT_4', isResolved: true, path: 'src/c.ts', comments: [] }] });
  clean(t, s);
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_4', reply: '已在处理', justification: 'j' }], allowedBots: ['greptile-apps'] });
  const res = out.results[0];
  assert.equal(res.outcome, 'resolved');
  assert.equal(res.done, true);
  assert.equal(res.reason, 'already-resolved(线程已是 resolved,无需动作)');
  assert.equal(s.countCalls('addPullRequestReviewThreadReply'), 0);
  assert.equal(s.countCalls('resolveReviewThread'), 0);
});

test('真人 thread(首条作者非白名单)→ skipped-author-not-in-whitelist,0 动作', (t) => {
  const s = setup({
    threads: [{ id: 'PRRT_5', isResolved: false, path: 'src/d.ts', comments: [{ body: '这里应该改成异步。', author: 'praisezhu' }] }],
  });
  clean(t, s);
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_5', reply: '已处理', justification: 'j' }], allowedBots: ['greptile-apps'] });
  const res = out.results[0];
  assert.equal(res.outcome, 'skipped');
  assert.ok(res.reason.startsWith('skipped-author-not-in-whitelist'), res.reason);
  assert.equal(s.countCalls('addPullRequestReviewThreadReply'), 0);
  assert.equal(s.countCalls('resolveReviewThread'), 0);
});

test('白名单 bot 首条 + 非白名单 bot 后追加 → skipped-non-whitelisted-comment-present,0 动作', (t) => {
  const s = setup({
    threads: [{
      id: 'PRRT_D2', isResolved: false, path: 'src/d2.ts',
      comments: [
        { body: '这里调用了 `handleSubmit` 但缺少防抖,应改用 `debounce` 包裹。', author: 'greptile-apps', id: 'c_d2_1' },
        { body: '`handleSubmit` 还需防抖,`debounce` 未生效。', author: 'copilot-pull-request-reviewer', id: 'c_d2_2' },
      ],
    }],
  });
  clean(t, s);
  const { r, out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_D2', reply: '已处理,代为 resolve', justification: '已给 onSubmit 加防抖包裹' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
  const res = out.results[0];
  assert.equal(res.outcome, 'skipped');
  assert.ok(res.reason.startsWith('skipped-non-whitelisted-comment-present'), res.reason);
  assert.equal(res.author, 'copilot-pull-request-reviewer');
  assert.equal(s.countCalls('addPullRequestReviewThreadReply'), 0);
  assert.equal(s.countCalls('resolveReviewThread'), 0);
});

test('预存/复制的 marker(pr 对不上)→ 不算己方,走正常首轮 replied-only', (t) => {
  const s = setup({
    threads: [{
      id: 'PRRT_6', isResolved: false, path: 'src/e.ts',
      comments: [
        '这里调用了 `handleSubmit` 但缺少防抖,应改用 `debounce` 包裹。',
        { body: marker(999, 'PRRT_6', 'deadbeef'), author: 'greptile-apps', id: 'fake_marker' },
      ],
    }],
  });
  clean(t, s);
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_6', reply: '已在 abc1234 用 debounce 处理,有异议可 reopen', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'replied-only', JSON.stringify(res));
  assert.equal(res.reason.startsWith('replied-only'), true);
  assert.equal(res.resolved, false);
  assert.equal(s.countCalls('resolveReviewThread'), 0);
});

test('resolve mutation 失败 → skipped-resolve-failed;下一轮重试成功,全程不重复回复', (t) => {
  const s = setup({ threads: [{ id: 'PRRT_RF', isResolved: false, path: 'src/rf.ts', comments: ['bot 意见'] }] });
  clean(t, s);
  const payload = { threads: [{ id: 'PRRT_RF', reply: '已处理', justification: 'j' }], allowedBots: ['greptile-apps'], headSha: 'abc1234' };
  const r1 = runScript(s.work, s.env, payload);
  assert.equal(r1.out.results[0].outcome, 'replied-only', '首轮只回复');
  const envFail = { ...s.env, FAKE_GH_RESOLVE_FAIL_FOR: 'PRRT_RF' };
  const r2 = runScript(s.work, envFail, payload);
  const res2 = r2.out.results[0];
  assert.equal(res2.outcome, 'skipped', JSON.stringify(res2));
  assert.ok(res2.reason.startsWith('skipped-resolve-failed'), res2.reason);
  assert.equal(res2.replied, false, 'resolve 失败不重复回复');
  assert.ok(res2.resolveError, '带 resolveError');
  const r3 = runScript(s.work, s.env, payload);
  const res3 = r3.out.results[0];
  assert.equal(res3.outcome, 'resolved', JSON.stringify(res3));
  assert.equal(res3.replied, false, '重试 resolve 也不重复回复');
  assert.ok(res3.reason.startsWith('resolved-own-triage'), res3.reason);
  assert.equal(s.countRepliesWith('已处理'), 1, '全程用户回复恰好 1 次');
  assert.equal(s.countCalls('resolveReviewThread'), 2, '失败 1 次 + 成功 1 次');
});

test('thread-not-found → skipped-thread-not-found', (t) => {
  const s = setup({ threads: [] });
  clean(t, s);
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_999', reply: '处理', justification: 'j' }], allowedBots: ['greptile-apps'] });
  assert.equal(out.results[0].done, false);
  assert.ok(out.results[0].reason.startsWith('skipped-thread-not-found'), out.results[0].reason);
});

test('缺 --payload-file → fail-closed(exit 1)', (t) => {
  const s = setup({ threads: [{ id: 'PRRT_1', isResolved: false, path: 'src/c.ts', comments: [] }] });
  clean(t, s);
  const r = spawnSync('node', [SCRIPT, '123'], { cwd: s.work, env: s.env, encoding: 'utf8' });
  assert.equal(r.status, 1, `status=${r.status}`);
  assert.ok(/--payload-file 必填/.test(r.stdout), r.stdout.slice(0, 200));
});

test('缺 reply → rejected,零动作', (t) => {
  const s = setup({ threads: [{ id: 'PRRT_7', isResolved: false, path: 'src/f.ts', comments: [] }] });
  clean(t, s);
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_7', reply: '' }] });
  assert.equal(out.rejected.length, 1);
  assert.ok(out.rejected[0].reason.startsWith('missing-id-or-reply'), out.rejected[0].reason);
  assert.equal(out.requested, 0);
});

test('未传 allowedBots → skipped-triage-disabled,即使作者在白名单同名', (t) => {
  const s = setup({ threads: [{ id: 'PRRT_8', isResolved: false, path: 'src/g.ts', comments: ['bot 意见'] }] });
  clean(t, s);
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_8', reply: '已处理', justification: 'j' }] });
  assert.equal(out.results[0].done, false);
  assert.ok(out.results[0].reason.startsWith('skipped-triage-disabled'), out.results[0].reason);
});

test('--dry-run:wouldReply / wouldResolve 预演,零动作', (t) => {
  const s1 = setup({ threads: [{ id: 'PRRT_DR1', isResolved: false, path: 'src/d1.ts', comments: ['bot 意见'] }] });
  const o1 = runScript(s1.work, s1.env, { threads: [{ id: 'PRRT_DR1', reply: 'x', justification: 'j' }], allowedBots: ['greptile-apps'], headSha: 'abc1234' }, 123, ['--dry-run']);
  assert.equal(o1.out.results[0].dryRun, true);
  assert.equal(o1.out.results[0].wouldReply, true);
  assert.equal(o1.out.results[0].wouldResolve, false, '无己方 marker → wouldResolve=false');
  assert.equal(s1.countCalls('addPullRequestReviewThreadReply'), 0);
  assert.equal(s1.countCalls('resolveReviewThread'), 0);
  const s2 = setup({
    threads: [{ id: 'PRRT_DR2', isResolved: false, path: 'src/d2.ts', comments: ['bot', { body: marker(123, 'PRRT_DR2', 'abc1234'), author: SELF_LOGIN }] }],
  });
  const o2 = runScript(s2.work, s2.env, { threads: [{ id: 'PRRT_DR2', reply: 'x', justification: 'j' }], allowedBots: ['greptile-apps'], headSha: 'abc1234' }, 123, ['--dry-run']);
  assert.equal(o2.out.results[0].wouldResolve, true, '己方 marker + 同 sha → wouldResolve=true');
  assert.equal(s2.countCalls('resolveReviewThread'), 0);
  clean(t, s1);
  clean(t, s2);
});

// ── 分页 ──
test('分页:第 100 个 thread 能读到;第 101 个 thread 的 51 条评论全部参与白名单扫描', (t) => {
  const manyThreads = [];
  for (let i = 0; i < 100; i += 1) {
    manyThreads.push({ id: `PRRT_pad_${i}`, isResolved: true, path: `src/pad${i}.ts`, comments: [] });
  }
  const manyComments = [];
  for (let i = 0; i < 50; i += 1) manyComments.push({ body: `占位评论 ${i}`, author: 'someone-else' });
  manyComments.push({ body: '这里调用了 `handleSubmit` 但缺少防抖,应改用 `debounce` 包裹。', author: 'greptile-apps' });
  manyThreads.push({ id: 'PRRT_101', isResolved: false, path: 'src/foo.ts', comments: manyComments });
  const s = setup({ threads: manyThreads });
  clean(t, s);
  const { out: outNotFound } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_pad_99', reply: 'x', justification: 'j' }], allowedBots: ['greptile-apps'] }, s.pr);
  assert.equal(outNotFound.results[0].reason, 'already-resolved(线程已是 resolved,无需动作)', JSON.stringify(outNotFound.results));
  // allowedBots=['someone-else']:若脚本只扫了前 50 条(全是 someone-else)会放行,
  // 扫全 51 条才会发现第 51 条 greptile-apps 不在白名单 → 证明分页取全了。
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_101', reply: '已处理', justification: 'j' }], allowedBots: ['someone-else'] }, s.pr);
  const res = out.results[0];
  assert.equal(res.outcome, 'skipped', JSON.stringify(res));
  assert.ok(res.reason.startsWith('skipped-non-whitelisted-comment-present'), res.reason);
  assert.equal(res.author, 'greptile-apps');
});

test('分页:单 thread 第 52 条评论是己方 marker(超第一页)→ 二轮 resolve 判定仍生效', (t) => {
  const manyComments = [];
  for (let i = 0; i < 50; i += 1) manyComments.push({ body: `占位评论 ${i}`, author: 'greptile-apps' });
  manyComments.push({ body: '第 51 条', author: 'greptile-apps', id: 'c51' });
  manyComments.push({ body: marker(123, 'PRRT_page', 'abc1234'), author: SELF_LOGIN, id: 'marker_c52' });
  const s = setup({ threads: [{ id: 'PRRT_page', isResolved: false, path: 'src/h.ts', comments: manyComments }] });
  clean(t, s);
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_page', reply: '再次处理', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'resolved', JSON.stringify(res));
  assert.equal(res.done, true);
  assert.equal(s.countCalls('resolveReviewThread'), 1);
});

// ── ⑥ marker 按作者身份判定,不按形状:白名单 bot 写的 marker ≠ 己方 triage ──
test('白名单 bot 作者写的 marker 形状评论 ≠ 己方 marker:不算己方 triage,走首轮 replied-only', (t) => {
  // pr/thread/sha 全对上、作者在 allowedBots 内(greptile-apps)——但作者不是 viewer,
  // 文本谁都能写:必须按作者身份判定,不能按形状。若按形状误判成"己方已 triage",
  // 会直接 resolve(把白名单 bot 复制来的文本当我们的动作)。
  const s = setup({
    threads: [{
      id: 'PRRT_OWNAUTH', isResolved: false, path: 'src/oa.ts',
      comments: [
        'bot 意见',
        { body: marker(123, 'PRRT_OWNAUTH', 'abc1234'), author: 'greptile-apps', id: 'bot_marker' },
      ],
    }],
  });
  clean(t, s);
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_OWNAUTH', reply: '已处理,有异议可 reopen', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'replied-only', JSON.stringify(res));
  assert.equal(res.resolved, false, '白名单 bot 的 marker 不得触发 resolve');
  assert.equal(s.countCalls('resolveReviewThread'), 0);
});

// ── D3 跨运行:状态全在 GitHub 侧,本地(tmp/lock)清了也不影响 ──
test('D3 跨运行:换机器(全新 lockDir)+ 清空本地 → 二轮 resolve 仍成立(状态不依赖本地回执)', (t) => {
  // 机器 A:首轮 replied-only,marker 落在 fixture 状态(GitHub 侧)
  const sA = setup({ threads: [{ id: 'PRRT_XRUN', isResolved: false, path: 'src/x.ts', comments: ['bot 意见'] }] });
  const r1 = runScript(sA.work, sA.env, {
    threads: [{ id: 'PRRT_XRUN', reply: '已处理,有异议可 reopen', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  assert.equal(r1.out.results[0].outcome, 'replied-only', JSON.stringify(r1.out.results));
  assert.equal(r1.out.results[0].resolved, false);
  // 机器 B:全新 lockDir(= 换机器 / 无状态 CI runner 全新 tmp),本地无任何上一轮遗留;
  // fixture 状态文件不变(= GitHub 侧状态跨机器可见)。
  const lockDirB = mkdtempSync(join(tmpdir(), 'resolve-threads-xrun-locks-'));
  t.after(() => rmSync(lockDirB, { recursive: true, force: true }));
  const envB = { ...sA.env, REVIEW_PR_RESOLVE_LOCK_DIR: lockDirB };
  const r2 = runScript(sA.work, envB, {
    threads: [{ id: 'PRRT_XRUN', reply: '已处理,有异议可 reopen', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res2 = r2.out.results[0];
  assert.equal(res2.outcome, 'resolved', `换机器后二轮必须仍能 resolve(状态在 GitHub 侧): ${JSON.stringify(res2)}`);
  assert.equal(res2.replied, false, '不重复回复');
  assert.equal(sA.readState().threads[0].isResolved, true);
  clean(t, sA);
});

// ── D4 takeover 残留自愈 ──
test('D4 takeover 残留自愈:预置陈旧 .takeover(超 TTL)+ 陈旧主锁 → 仍能拿锁完成首轮', (t) => {
  const s = setup({ threads: [{ id: 'PRRT_TO', isResolved: false, path: 'src/to.ts', comments: ['bot 意见'] }] });
  clean(t, s);
  // 模拟上一进程 SIGKILL 于创建 takeover 后、finally 前:主锁 + takeover 双双残留。
  const lockPath = join(s.lockDir, '123__PRRT_TO.lock');
  const takeoverPath = `${lockPath}.takeover`;
  writeFileSync(lockPath, JSON.stringify({ token: 'dead', startedAt: Date.now() - 10 * 60 * 1000 }), { flag: 'w' });
  writeFileSync(takeoverPath, JSON.stringify({ token: 'dead', startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() }), { flag: 'w' });
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_TO', reply: '已处理', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'replied-only', `超 TTL 残留必须被回收并完成处理: ${JSON.stringify(res)}`);
  assert.ok(!res.reason.startsWith('skipped-lock-busy'), res.reason);
  assert.equal(s.countCalls('addPullRequestReviewThreadReply'), 1, '首轮回复发出');
  assert.equal(s.countCalls('resolveReviewThread'), 0);
});

test('D4 takeover 未过期(另一实例正在接管)→ 放弃本轮,不抢锁(skipped-lock-busy)', (t) => {
  const s = setup({ threads: [{ id: 'PRRT_TO2', isResolved: false, path: 'src/to2.ts', comments: ['bot 意见'] }] });
  clean(t, s);
  const lockPath = join(s.lockDir, '123__PRRT_TO2.lock');
  const takeoverPath = `${lockPath}.takeover`;
  writeFileSync(lockPath, JSON.stringify({ token: 'dead', startedAt: Date.now() - 10 * 60 * 1000 }), { flag: 'w' });
  // 新鲜的 takeover(未超 60s TTL)= 另一实例正在接管,本进程不得抢
  writeFileSync(takeoverPath, JSON.stringify({ token: 'alive', startedAt: new Date().toISOString() }), { flag: 'w' });
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_TO2', reply: '已处理', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'skipped', JSON.stringify(res));
  assert.ok(res.reason.startsWith('skipped-lock-busy'), res.reason);
  assert.equal(s.countCalls('addPullRequestReviewThreadReply'), 0);
});

// ── 并发:至多一次 ──
function spawnAsync(scriptArgs, opts, input) {
  return new Promise((resolve) => {
    const child = spawn('node', scriptArgs, { cwd: opts.cwd, env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

test('真双进程并发:同一 thread 恰好 1 次用户回复 + 1 次 resolve(文件锁兑双发)', async (t) => {
  const s = setup({ threads: [{ id: 'PRRT_CONC', isResolved: false, path: 'src/conc.ts', comments: ['真实 bot 意见,缺少防抖'] }] });
  clean(t, s);
  const payload = JSON.stringify({
    threads: [{ id: 'PRRT_CONC', reply: '已处理,有异议可 reopen', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const [r1, r2] = await Promise.all([
    spawnAsync([SCRIPT, '123', '--payload-file', '-'], s, payload),
    spawnAsync([SCRIPT, '123', '--payload-file', '-'], s, payload),
  ]);
  assert.equal(r1.code, 0, `stderr1=${r1.stderr.slice(0, 200)}`);
  assert.equal(r2.code, 0, `stderr2=${r2.stderr.slice(0, 200)}`);
  const st = s.readState();
  assert.equal(st.threads[0].isResolved, true, 'thread 最终必须被 resolve');
  // 胜者走首轮发用户回复;败者拿锁后重查看到己方 marker → 走二轮 resolve(不重复回复)
  assert.equal(s.countRepliesWith('已处理,有异议可 reopen'), 1, '用户回复恰好 1 次');
  assert.equal(s.countCalls('resolveReviewThread'), 1, 'resolve 恰好 1 次');
});
