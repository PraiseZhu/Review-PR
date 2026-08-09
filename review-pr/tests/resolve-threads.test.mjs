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
// 陈旧 marker 评论(年龄 ≥ 反对窗口):预置己方 marker 且需 resolve 的测试用。
// ageMs 默认 30 分钟,远超 MIN_MARKER_AGE_MS(10 分钟)。
const staleComment = (body, ageMs = 30 * 60 * 1000) => ({ body, createdAt: new Date(Date.now() - ageMs).toISOString() });
// 连跑两轮的测试(首轮真实 reply 落 marker=新鲜,第二轮需 resolve)→ 模拟时间流逝:
// 把 state 里该 thread 的 marker 评论 createdAt 改成陈旧。这不是测试后门开关——正是
// lead 要求的行为:「崩溃后过了一段时间的下一轮巡审」。
const ageAllMarkers = (stateFile, threadId, ageMs = 30 * 60 * 1000) => {
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  for (const th of st.threads) {
    if (th.id !== threadId) continue;
    for (const c of th.comments.nodes) {
      if (c.body.includes('review-pr:thread-triage')) c.createdAt = new Date(Date.now() - ageMs).toISOString();
    }
  }
  writeFileSync(stateFile, JSON.stringify(st));
};

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
          const createdAt = isObj ? b.createdAt : undefined;
          return { body, author: { login: author }, id, ...(createdAt ? { createdAt } : {}) };
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
        { ...staleComment(marker(123, 'PRRT_2', 'abc1234')), author: SELF_LOGIN, id: 'own_marker_1' },
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
  // 模拟时间流逝:marker 变陈旧,下一轮才进入 resolve 判定
  ageAllMarkers(s.stateFile, 'PRRT_RF');
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
    threads: [{ id: 'PRRT_DR2', isResolved: false, path: 'src/d2.ts', comments: ['bot', { ...staleComment(marker(123, 'PRRT_DR2', 'abc1234')), author: SELF_LOGIN }] }],
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
  manyComments.push({ ...staleComment(marker(123, 'PRRT_page', 'abc1234')), author: SELF_LOGIN, id: 'marker_c52' });
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
  // 换机器 = 下一轮巡审(距首轮 reply 已过反对窗口):marker 时间戳改陈旧
  ageAllMarkers(sA.stateFile, 'PRRT_XRUN');
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

// ── 年龄门(人工反对窗口,lead 必加两条断言)──
// 新鲜 marker(年龄 < MIN_MARKER_AGE_MS)+ 同 headSha + 白名单通过 → 必须 replied-only,
// resolveReviewThread 调用数 = 0。直接锁住并发塌窗(双实例重叠时窗口不得塌成 0)。
test('年龄门:新鲜己方 marker(< 反对窗口)+ 同 headSha + 白名单通过 → replied-only,0 次 resolve', (t) => {
  const s = setup({
    threads: [{
      id: 'PRRT_FRESH', isResolved: false, path: 'src/fresh.ts',
      comments: [
        'bot 意见',
        // 新鲜 marker:createdAt = 30 秒前(< 10 分钟窗口)
        { body: marker(123, 'PRRT_FRESH', 'abc1234'), author: SELF_LOGIN, id: 'fresh_marker', createdAt: new Date(Date.now() - 30 * 1000).toISOString() },
      ],
    }],
  });
  clean(t, s);
  const { r, out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_FRESH', reply: '已处理,有异议可 reopen', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
  const res = out.results[0];
  assert.equal(res.outcome, 'replied-only', JSON.stringify(res));
  assert.equal(res.resolved, false, '新鲜 marker 不得 resolve');
  assert.equal(res.replied, false, '不重复回复(已回复过,只是窗口未过)');
  assert.ok(res.markerAgeMs !== undefined && res.markerAgeMs < 10 * 60 * 1000, `带 markerAgeMs 实值: ${res.markerAgeMs}`);
  assert.ok(res.reason.startsWith('replied-only'), res.reason);
  assert.equal(s.countCalls('resolveReviewThread'), 0, 'resolveReviewThread 调用数必须为 0');
  assert.equal(s.readState().threads[0].isResolved, false);
});

// 陈旧 marker(年龄 ≥ MIN_MARKER_AGE_MS)→ 仍能 resolved(证明年龄条件没堵死正常路径)。
test('年龄门:陈旧己方 marker(≥ 反对窗口)+ 同 headSha + 白名单通过 → resolved', (t) => {
  const s = setup({
    threads: [{
      id: 'PRRT_STALE', isResolved: false, path: 'src/stale.ts',
      comments: [
        'bot 意见',
        { ...staleComment(marker(123, 'PRRT_STALE', 'abc1234')), author: SELF_LOGIN, id: 'stale_marker' },
      ],
    }],
  });
  clean(t, s);
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_STALE', reply: '已处理,有异议可 reopen', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'resolved', JSON.stringify(res));
  assert.equal(res.done, true);
  assert.equal(res.replied, false);
  assert.equal(s.readState().threads[0].isResolved, true);
});

// ── env 校验:REVIEW_PR_MIN_MARKER_AGE_MS 不许成为隐蔽的安全旋钮(R4)──
// `Number(env || default)` 会让 -1 悄悄关掉年龄门、'0' 直接生效 0ms、NaN 靠巧合保守
// (同 #11 SIGNOFF_HOLD_GH_TIMEOUT_MS 未校验模式)。规则:解析失败 / 负值 / 低于下限
// (1 分钟 = "人来得及看见"的最小可感知窗口)→ 一律回落默认 600000ms,并双通道警告
// (stderr + JSON warnings 字段)。每种输入形态断言「实际生效的窗口」+「该窗口下的
// resolve 行为」——只断言常量值可能常量对了行为不对:
//   - 45s 新鲜 marker:生效窗口 600000 时必须 replied-only;若 -1/0/30000 这类错误值
//     生效(45s ≥ 错误值)会放行 resolve → 行为断言转红;
//   - 30min 陈旧 marker:回落默认后必须仍能 resolved(证明门没被卡死/没被永久关闭)。
const freshMarkerAt = (threadId, ageMs) => ({
  id: threadId, isResolved: false, path: `src/${threadId.toLowerCase()}.ts`,
  comments: [
    'bot 意见',
    { body: marker(123, threadId, 'abc1234'), author: SELF_LOGIN, id: `m_${threadId}`, createdAt: new Date(Date.now() - ageMs).toISOString() },
  ],
});

const envFallbackCases = [['负值', '-1'], ['零', '0'], ['非数字', 'abc'], ['低于下限的正值', '30000']];
for (const [label, raw] of envFallbackCases) {
  test(`env 校验:REVIEW_PR_MIN_MARKER_AGE_MS=${JSON.stringify(raw)}(${label}) → 回落默认 600000 + 双通道警告,resolve 行为=默认窗口`, (t) => {
    const s = setup({ threads: [freshMarkerAt('PRRT_ENV_FRESH', 45 * 1000), freshMarkerAt('PRRT_ENV_STALE', 30 * 60 * 1000)] });
    clean(t, s);
    const env = { ...s.env, REVIEW_PR_MIN_MARKER_AGE_MS: raw };
    const { r, out } = runScript(s.work, env, {
      threads: [
        { id: 'PRRT_ENV_FRESH', reply: '已处理', justification: 'j' },
        { id: 'PRRT_ENV_STALE', reply: '已处理', justification: 'j' },
      ],
      allowedBots: ['greptile-apps'], headSha: 'abc1234',
    });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    const fresh = out.results.find((x) => x.id === 'PRRT_ENV_FRESH');
    const stale = out.results.find((x) => x.id === 'PRRT_ENV_STALE');
    assert.equal(fresh.outcome, 'replied-only', `${label}不得放行 45s 新鲜 marker(实际生效的窗口必须仍是默认 600000): ${JSON.stringify(fresh)}`);
    assert.equal(fresh.resolved, false, `${label}不得悄悄关掉年龄门`);
    assert.equal(stale.outcome, 'resolved', `回落默认后 30min 陈旧 marker 必须仍能 resolve(门没被卡死): ${JSON.stringify(stale)}`);
    assert.ok(r.stderr.includes('回落默认'), `stderr 必须带回落警告: ${r.stderr.slice(0, 300)}`);
    assert.ok(out.warnings?.length > 0 && out.warnings.some((w) => w.includes('回落默认')), `JSON warnings 必须带回落警告: ${JSON.stringify(out.warnings)}`);
  });
}

test('env 校验:REVIEW_PR_MIN_MARKER_AGE_MS=120000(正常值)→ 生效 120s:180s marker resolve / 45s marker 不 resolve,无警告', (t) => {
  const s = setup({ threads: [freshMarkerAt('PRRT_ENV120_OLD', 180 * 1000), freshMarkerAt('PRRT_ENV120_FRESH', 45 * 1000)] });
  clean(t, s);
  const env = { ...s.env, REVIEW_PR_MIN_MARKER_AGE_MS: '120000' };
  const { r, out } = runScript(s.work, env, {
    threads: [
      { id: 'PRRT_ENV120_OLD', reply: '已处理', justification: 'j' },
      { id: 'PRRT_ENV120_FRESH', reply: '已处理', justification: 'j' },
    ],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
  const oldM = out.results.find((x) => x.id === 'PRRT_ENV120_OLD');
  const fresh = out.results.find((x) => x.id === 'PRRT_ENV120_FRESH');
  assert.equal(oldM.outcome, 'resolved', `180s ≥ 生效窗口 120s 必须 resolve(证明生效值真是 120000 而非回落默认 600000): ${JSON.stringify(oldM)}`);
  assert.equal(fresh.outcome, 'replied-only', `45s < 120s 不得 resolve: ${JSON.stringify(fresh)}`);
  assert.ok(!r.stderr.includes('回落默认'), `合法值不得触发回落警告: ${r.stderr.slice(0, 300)}`);
  assert.equal(out.warnings, undefined, '合法值 JSON 无 warnings 字段');
});

test('env 校验:REVIEW_PR_DISABLE_MARKER_AGE_GATE=1 → 年龄门显式关闭,30s marker 直接 resolve,stderr 大声警告;无 createdAt 仍保守', (t) => {
  const s = setup({
    threads: [
      freshMarkerAt('PRRT_ENV_GATE_30S', 30 * 1000),
      {
        id: 'PRRT_ENV_GATE_NOCA', isResolved: false, path: 'src/prrt_env_gate_noca.ts',
        comments: ['bot 意见', { body: marker(123, 'PRRT_ENV_GATE_NOCA', 'abc1234'), author: SELF_LOGIN, id: 'm_noca' }], // 无 createdAt
      },
    ],
  });
  clean(t, s);
  const env = { ...s.env, REVIEW_PR_DISABLE_MARKER_AGE_GATE: '1' };
  const { r, out } = runScript(s.work, env, {
    threads: [
      { id: 'PRRT_ENV_GATE_30S', reply: '已处理', justification: 'j' },
      { id: 'PRRT_ENV_GATE_NOCA', reply: '已处理', justification: 'j' },
    ],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
  const g30 = out.results.find((x) => x.id === 'PRRT_ENV_GATE_30S');
  const gNoca = out.results.find((x) => x.id === 'PRRT_ENV_GATE_NOCA');
  assert.equal(g30.outcome, 'resolved', `门关闭后 30s 新鲜 marker 必须 resolve(年龄条件豁免): ${JSON.stringify(g30)}`);
  assert.equal(gNoca.outcome, 'replied-only', '门关闭不豁免"无 createdAt 保守不 resolve"');
  assert.ok(gNoca.reason.includes('无 createdAt'), gNoca.reason);
  assert.ok(r.stderr.includes('年龄门已关闭'), `stderr 必须大声说明年龄门已关闭: ${r.stderr.slice(0, 300)}`);
  assert.ok(out.warnings?.length > 0 && out.warnings.some((w) => w.includes('年龄门已关闭')), `JSON warnings 必须含门关闭声明: ${JSON.stringify(out.warnings)}`);
});

test('env 校验:未设置 env → 无警告输出,默认窗口行为不变', (t) => {
  const s = setup({ threads: [freshMarkerAt('PRRT_ENV_DFLT', 45 * 1000)] });
  clean(t, s);
  const { r, out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_ENV_DFLT', reply: '已处理', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
  assert.equal(out.results[0].outcome, 'replied-only', '默认窗口下 45s marker 不 resolve');
  assert.ok(!r.stderr.includes('[resolve-threads] 警告'), `默认路径不得有警告: ${r.stderr.slice(0, 300)}`);
  assert.equal(out.warnings, undefined, 'JSON 无 warnings 字段');
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

// ── P1-a 复审探针复刻:lead 的探针用 startedAt:0 预置 primary+takeover 两个锁,
// 旧版(常量存在但从不判龄)在 10.7s 后返回 lock-busy 且 stale takeover 仍在、bot thread
// 永久不被处理。当前实现必须读取/判龄/清理 takeover:同一输入应能回收并完成首轮。
test('D4 P1-a 探针复刻:startedAt:0 的 primary+takeover 双残留 → 判龄清理后完成首轮(replied-only,非 lock-busy)', (t) => {
  const s = setup({ threads: [{ id: 'PRRT_P1A', isResolved: false, path: 'src/p1a.ts', comments: ['bot 意见'] }] });
  clean(t, s);
  const lockPath = join(s.lockDir, '123__PRRT_P1A.lock');
  const takeoverPath = `${lockPath}.takeover`;
  // 逐字复刻 lead 探针输入:startedAt:0(epoch 1970,远超任何 TTL)
  writeFileSync(lockPath, JSON.stringify({ token: 'dead', startedAt: 0 }), { flag: 'w' });
  writeFileSync(takeoverPath, JSON.stringify({ token: 'dead', startedAt: '1970-01-01T00:00:00.000Z' }), { flag: 'w' });
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_P1A', reply: '已处理', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const res = out.results[0];
  assert.equal(res.outcome, 'replied-only', `超 TTL 双残留必须被回收并完成处理: ${JSON.stringify(res)}`);
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

// ── P1-b 显式验收:reply 成功、resolve 前崩溃 → 下一轮必须从 marker 文本恢复推进 ──
// 旧版(带回执时代)缺陷:reply 成功 → 写回执之前崩溃 → 留下"有效 marker + 无回执" →
// marker-not-trustworthy 每轮原地返回,永不前进("可重试"被实现成字符串不是行为)。
// D3 删回执后该状态不存在;此处显式构造"reply 成功、resolve 未发生"的崩溃落盘状态,
// 证明下一轮从 marker 文本读出待处理状态并真的推进(不重复回复、不原地返回)。
test('P1-b 崩溃恢复:reply 成功、resolve 前崩溃 → 下一轮 resolved,全程用户回复恰好 1 次', (t) => {
  const s = setup({ threads: [{ id: 'PRRT_CRASH', isResolved: false, path: 'src/crash.ts', comments: ['bot 意见'] }] });
  clean(t, s);
  const payload = {
    threads: [{ id: 'PRRT_CRASH', reply: '已处理,有异议可 reopen', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  };
  // 第 1 轮:reply 成功(状态里留下 viewer 作者、state=replied 的 marker),resolve 未发生
  // (= 进程在 reply 与 resolve 之间崩溃的落盘形态)。
  const r1 = runScript(s.work, s.env, payload);
  assert.equal(r1.out.results[0].outcome, 'replied-only', JSON.stringify(r1.out.results));
  assert.equal(r1.out.results[0].resolved, false);
  const st1 = s.readState();
  assert.equal(st1.threads[0].isResolved, false);
  assert.ok(st1.threads[0].comments.nodes.some((c) => c.body.includes('state=replied') && c.author.login === SELF_LOGIN), 'marker 文本已落(崩溃点之后)');
  // 第 2 轮:同 headSha 重跑 → 机器可核实条件成立(含 marker 年龄 ≥ 反对窗口)。
  // 模拟"崩溃后过了一段时间的下一轮巡审":marker 时间戳改陈旧(不是测试后门,是行为本身)。
  ageAllMarkers(s.stateFile, 'PRRT_CRASH');
  const r2 = runScript(s.work, s.env, payload);
  const res2 = r2.out.results[0];
  assert.equal(res2.outcome, 'resolved', `崩溃后下一轮必须继续推进,不得原地返回: ${JSON.stringify(res2)}`);
  assert.equal(res2.replied, false, '不重复回复');
  assert.ok(res2.reason.startsWith('resolved-own-triage'), res2.reason);
  assert.equal(s.readState().threads[0].isResolved, true);
  assert.equal(s.countRepliesWith('已处理,有异议可 reopen'), 1, '全程用户回复恰好 1 次(无死循环)');
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

test('真双进程并发:reply 恰好 1 次,年龄门挡同轮 resolve(窗口不塌 0);陈旧后下一轮 resolve', async (t) => {
  const s = setup({ threads: [{ id: 'PRRT_CONC', isResolved: false, path: 'src/conc.ts', comments: ['真实 bot 意见,缺少防抖'] }] });
  clean(t, s);
  const payload = {
    threads: [{ id: 'PRRT_CONC', reply: '已处理,有异议可 reopen', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  };
  const [r1, r2] = await Promise.all([
    spawnAsync([SCRIPT, '123', '--payload-file', '-'], s, JSON.stringify(payload)),
    spawnAsync([SCRIPT, '123', '--payload-file', '-'], s, JSON.stringify(payload)),
  ]);
  assert.equal(r1.code, 0, `stderr1=${r1.stderr.slice(0, 200)}`);
  assert.equal(r2.code, 0, `stderr2=${r2.stderr.slice(0, 200)}`);
  // 胜者走首轮发用户回复;败者拿锁后重查看到**新鲜**己方 marker(age < 反对窗口)→
  // 不 resolve(replied-only)——并发重叠不再导致人工反对窗口塌成 0。
  assert.equal(s.countRepliesWith('已处理,有异议可 reopen'), 1, '用户回复恰好 1 次');
  assert.equal(s.countCalls('resolveReviewThread'), 0, '窗口内 resolve 调用数必须为 0');
  assert.equal(s.readState().threads[0].isResolved, false, '窗口内不得被自动 resolve');
  // 时间流逝后下一轮巡审 → 机器可核实条件成立,resolve 恰好 1 次
  ageAllMarkers(s.stateFile, 'PRRT_CONC');
  const r3 = runScript(s.work, s.env, payload);
  assert.equal(r3.out.results[0].outcome, 'resolved', JSON.stringify(r3.out.results));
  assert.equal(s.readState().threads[0].isResolved, true);
  assert.equal(s.countCalls('resolveReviewThread'), 1, 'resolve 恰好 1 次');
});
