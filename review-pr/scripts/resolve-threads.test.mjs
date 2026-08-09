#!/usr/bin/env node
// resolve-threads.test.mjs — thread 代 resolve 的回归:
//   ① assessThreadEvidence(token 共现 + justification 判据,lib.mjs):有证据 resolve /
//      无证据不动 / 真人 thread 不动 / 白名单外 bot 不动 / isOutdated 只是线索 /
//      未配置禁用 / 三条独立"token 命中但无关"绕过反例(SC-1 + SC-9 反例);
//   ② 脚本级(fake-gh-resolve 可变状态,均带 allowedBots 执行层复核):有证据 → 恰好
//      一次 reply+resolve;重跑幂等;翻案 reopened-after-triage 永不碰(身份绑定 marker +
//      本地回执同时存在才采信;仅有 marker 无回执 → marker-not-trustworthy 可重试;
//      预存/复制的假 marker 不采信);缺 --payload-file fail-closed;白名单外真人 thread
//      0 动作;resolve mutation 失败后回执机制区分"我们自己失败"与"人工翻案";分页
//      (101 个 thread、第 51 条 comment)可读到;真双进程并发恰好 1+1。
// 跑:node scripts/resolve-threads.test.mjs   退出码 0 = 全过。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'resolve-threads.mjs');
const FAKE_GH = join(__dirname, '..', 'tests', 'fixtures', 'fake-gh-resolve', 'gh');

// lib.mjs 的 REPO_ROOT 默认取 process.cwd()——测试进程的 cwd 与子进程的 cwd(fixture)
// 不同会让 stateAnchor/repoStateKey 分叉,回执(跨轮次判断依据)落点对不上。固定为
// 本脚本所在 skill 仓库根(与调用 cwd 无关),子进程经 env 继承同一值,两边状态根一致。
// 必须用动态 import:静态 import 先于任何语句求值,设置 env 不会影响 lib.mjs 的
// import 期计算。
process.env.REVIEW_PR_REPO_ROOT ??= join(__dirname, '..', '..');
const { assessThreadEvidence, extractThreadTokens, stateFile } = await import('./lib.mjs');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, `got ${g}, want ${w}`);
}

// ── ① assessThreadEvidence:token 共现(≥2 独立高特异度 token 命中)+ justification 判据 ──
// BOT_THREAD 带两个反引号 token:handleSubmit(claim 本体)+ debounce(claim 里点名的修复
// 手段),DIFF 的新增行两个都命中——这是"确凿"这一侧的基线 fixture。
const BOT_THREAD = {
  id: 'PRRT_1', path: 'src/foo.ts',
  body: '这里调用了 `handleSubmit` 但缺少防抖,应改用 `debounce` 包裹。',
  author: 'greptile-apps',
};
const HUMAN_THREAD = { ...BOT_THREAD, author: 'praisezhu' };
const OTHER_BOT = { ...BOT_THREAD, author: 'copilot-pull-request-reviewer' };
const ALLOWED = ['greptile-apps'];
const DIFF = [
  { path: 'src/foo.ts', additions: ['function handleSubmit() {', '+  const debounced = debounce(onSubmit, 300);', '+  return debounced();', '}'], removals: [] },
  { path: 'src/bar.ts', additions: ['// 无关改动'], removals: [] },
];

// 有证据(≥2 个 claim token 都在修复新增行中被处理)+ 编排层给出 justification → resolve
// (D1:token 共现改为必要不充分条件,canResolve=true 还需非空 justification)
const bound = assessThreadEvidence({
  thread: BOT_THREAD, authorType: 'bot', allowedBots: ALLOWED, diff: DIFF,
  justification: '已在 abc1234 给 onSubmit 加防抖包裹,handleSubmit 内部改用 debounce,针对性回应了 claim。',
});
eq('有证据 resolve', bound.canResolve, true);
eq('证据类型 token-cooccurrence', bound.evidence, 'token-cooccurrence');
check('证据命中 ≥2 个 token', (bound.matchedTokens ?? []).length >= 2, JSON.stringify(bound.matchedTokens));
check('证据命中含 handleSubmit', (bound.matchedTokens ?? []).includes('handleSubmit'), JSON.stringify(bound.matchedTokens));
check('证据命中含 debounce', (bound.matchedTokens ?? []).includes('debounce'), JSON.stringify(bound.matchedTokens));

// token 命中 ≥2 但编排层未给 justification → 必须 canResolve=false(D1 的核心新增门,
// SC-9 反向变异「挖空 justification 校验」的直接靶子——若被挖空,这条会转绿)
const boundNoJustification = assessThreadEvidence({ thread: BOT_THREAD, authorType: 'bot', allowedBots: ALLOWED, diff: DIFF });
eq('token 命中但缺 justification 不动', boundNoJustification.canResolve, false);
check('原因 justification-required', (boundNoJustification.reason ?? '').startsWith('justification-required'), boundNoJustification.reason);

// ── SC-1 + SC-9:三条独立"token 命中但无关"绕过反例 ——
// 每条都只有 1 个 token 命中(且命中行与 claim 的问题本身无关),必须判 canResolve=false。
// 关键:即使编排层被绕过说服、连 justification 都给了(最强场景),单 token 共现仍
// 不足——单 token 子串命中太容易被无关行(测试断言/日志埋点/转发)碰撞满足,不构成
// 证据;这正是「共现是必要不充分条件」要拦的第一层。
// ①handleSubmit:命中的新增行是"保留导出的 handler"测试断言,不是防抖修复
const bypass1 = assessThreadEvidence({
  thread: { ...BOT_THREAD, path: 'src/foo.ts', body: '这里调用了 `handleSubmit` 但缺少防抖,快速连点会重复提交。' },
  authorType: 'bot', allowedBots: ALLOWED,
  diff: [{ path: 'src/foo.ts', additions: ['it("keeps exported handler", () => expect(handleSubmit).toBeDefined());'], removals: [] }],
  justification: '新增了 handleSubmit 的导出保留断言,防抖已处理。',
});
eq('绕过①handleSubmit 命中但无关不动', bypass1.canResolve, false);
check('绕过①原因 single-token-match-insufficient', (bypass1.reason ?? '').startsWith('single-token-match-insufficient'), bypass1.reason);
// ②chargeCard:命中的新增行是新增的 telemetry 日志埋点,不是幂等键修复
const bypass2 = assessThreadEvidence({
  thread: { path: 'src/pay.ts', body: '`chargeCard` 缺少幂等键,重试会重复扣款。', author: 'greptile-apps' },
  authorType: 'bot', allowedBots: ALLOWED,
  diff: [{ path: 'src/pay.ts', additions: ["telemetry.log('chargeCard invoked', { ts: Date.now() });"], removals: [] }],
  justification: '新增了 chargeCard 调用的 telemetry 日志,幂等键已补。',
});
eq('绕过②chargeCard 命中但无关不动', bypass2.canResolve, false);
check('绕过②原因 single-token-match-insufficient', (bypass2.reason ?? '').startsWith('single-token-match-insufficient'), bypass2.reason);
// ③options:命中的新增行只是把 options 传给了另一个无关函数,不是参数校验修复
const bypass3 = assessThreadEvidence({
  thread: { path: 'src/opts.ts', body: '`options` 参数缺少校验,传 undefined 会崩溃。', author: 'greptile-apps' },
  authorType: 'bot', allowedBots: ALLOWED,
  diff: [{ path: 'src/opts.ts', additions: ['forwardToLogger(options);'], removals: [] }],
  justification: '新增了 options 的转发调用,参数校验已加。',
});
eq('绕过③options 命中但无关不动', bypass3.canResolve, false);
check('绕过③原因 single-token-match-insufficient', (bypass3.reason ?? '').startsWith('single-token-match-insufficient'), bypass3.reason);

// 无证据:仅同文件被后续 commit 触碰 → 不动(path-touched-only 只是必要线索)
const onlyPath = assessThreadEvidence({
  thread: { ...BOT_THREAD, body: '这里应该用双引号。' }, // 无针对性 token 命中新增行,也无引号/反引号 token
  authorType: 'bot', allowedBots: ALLOWED, diff: DIFF,
});
eq('仅同文件触碰不动', onlyPath.canResolve, false);
check('原因 path-touched-only', (onlyPath.reason ?? '').startsWith('path-touched-only'), onlyPath.reason);
// 无证据:isOutdated 只是线索,不单独构成证据(path 不在 diff 里,避免撞 path-touched 分支;
// path 在 diff 里 + outdated 时按更强的 path-touched-only 报告,同样不动)
const outdatedOnly = assessThreadEvidence({
  thread: { ...BOT_THREAD, path: 'src/zzz.ts', isOutdated: true, body: '这里应该用双引号。' },
  authorType: 'bot', allowedBots: ALLOWED, diff: DIFF,
});
eq('isOutdated 只是线索 → 不动', outdatedOnly.canResolve, false);
check('原因 outdated-only', (outdatedOnly.reason ?? '').startsWith('outdated-only'), outdatedOnly.reason);
const outdatedWithTouch = assessThreadEvidence({
  thread: { ...BOT_THREAD, isOutdated: true, body: '这里应该用双引号。' },
  authorType: 'bot', allowedBots: ALLOWED, diff: DIFF,
});
eq('outdated + path-touched → 仍不动', outdatedWithTouch.canResolve, false);
// 真人 thread:永不自动 resolve(即使 token 命中)
const human = assessThreadEvidence({ thread: HUMAN_THREAD, authorType: 'human', allowedBots: ALLOWED, diff: DIFF });
eq('真人 thread 永不自动', human.canResolve, false);
check('原因 human-thread-never-auto', human.reason === 'human-thread-never-auto', human.reason);
// 白名单外 bot:token 命中也不动
const notInList = assessThreadEvidence({ thread: OTHER_BOT, authorType: 'bot', allowedBots: ALLOWED, diff: DIFF });
eq('白名单外 bot 不动', notInList.canResolve, false);
check('原因 bot-not-in-whitelist', (notInList.reason ?? '').startsWith('bot-not-in-whitelist'), notInList.reason);
// 未配置白名单(threadTriage.extraBots 空)→ 整体禁用
const disabled = assessThreadEvidence({ thread: BOT_THREAD, authorType: 'bot', allowedBots: [], diff: DIFF });
eq('未配置白名单 → 禁用', disabled.canResolve, false);
check('原因 triage-disabled', (disabled.reason ?? '').startsWith('triage-disabled'), disabled.reason);
// 无 diff 输入(fail-closed:读不到当前 head diff 就不动)
const noDiff = assessThreadEvidence({ thread: BOT_THREAD, authorType: 'bot', allowedBots: ALLOWED, diff: [] });
eq('无 diff → 不动', noDiff.canResolve, false);
// token 提取:反引号段优先、停用词剔除
const toks = extractThreadTokens('请把 `handleSubmit` 改为防抖调用;the and issue 不算。');
check('token 提取含 handleSubmit', toks.includes('handleSubmit'), JSON.stringify(toks));
check('token 提取剔除停用词', !toks.some((t) => ['the', 'and', 'issue'].includes(t)), JSON.stringify(toks));

// ── ② 脚本级(fake-gh-resolve 可变状态)──
const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// threads[].comments 元素支持字符串(默认作者 greptile-apps,即 ALLOWED 白名单默认命中)
// 或 { body, author, id } 对象(SC-3/SC-4 需要非默认作者 / 显式 marker 时用后者)。
// lockDir 默认每个 setup() 独立一份(避免跨测试串锁);SC-2 双并发测试需要故意共享同一份,
// 见下方专用测试块。
function setup({ threads, pr = 123 } = {}) {
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
    REVIEW_PR_RESOLVE_LOCK_DIR: lockDir,
  };
  const readLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []);
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  // cwd 与 work 同值:spawnAsync 的子进程必须真正 cd 进该 fixture 目录才能让
  // parseRepo() 读到 fixture 自己的 origin(而不是误读调用者进程碰巧所在的
  // 那个目录的 git 状态)。
  // 注(2026-08-09 二轮修复,git 历史归因):早期版本(commit f9acc6f)的"双并发"
  // 用例是假的——fixture 预置 isResolved:true + 单次 spawnSync,压根没有第二个进程,
  // 也根本没有 spawnAsync;cwd 缺失是本次把并发用例改写为真双进程(spawnAsync)时
  // 才引入的新接线要求:spawnAsync({ cwd: opts.cwd }) 若拿到 undefined 会让子进程
  // 继承父进程 cwd,只是因为在仓库内运行才没暴露,一旦从非 git 目录(如临时变异副本)
  // 运行就会 "not a git repository" 假死。不要把 cwd 接线说成旧假并发用例失败的原因。
  return { work, cwd: work, env, stateFile, logFile, lockDir, readLog, readState, pr };
}

const runScript = (work, env, payload, pr = 123) => {
  const p = JSON.stringify(payload);
  const r = spawnSync('node', [SCRIPT, String(pr), '--payload-file', '-'], { cwd: work, env, input: p, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  return { r, out };
};

// 有证据 → 恰好一次 reply+resolve(payload 带执行层白名单 allowedBots,与 fixture 默认作者一致)
{
  const s = setup({ threads: [{ id: 'PRRT_1', isResolved: false, path: 'src/foo.ts', comments: ['缺少防抖'] }] });
  const { r, out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_1', reply: '已在 abc1234 用 debounce 处理,代为 resolve;有异议可 reopen', justification: 'abc1234 给 onSubmit 加了防抖包裹,回应了缺少防抖的 claim' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  check('有证据:退出码 0', r.status === 0, `status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
  check('有证据:done=true', out?.results?.[0]?.done === true, JSON.stringify(out?.results));
  check('有证据:replied=true', out?.results?.[0]?.replied === true);
  check('有证据:resolved=true', out?.results?.[0]?.resolved === true);
  const st = s.readState();
  check('有证据:状态已 resolve', st.threads[0].isResolved === true);
  check('有证据:回复带 triage 标记', st.threads[0].comments.nodes.some((c) => c.body.includes('review-pr:thread-triage')));
  const calls = s.readLog();
  const replyCalls = calls.filter((l) => l.includes('addPullRequestReviewThreadReply')).length;
  const resolveCalls = calls.filter((l) => l.includes('resolveReviewThread')).length;
  check('有证据:reply 恰好 1 次', replyCalls === 1, `got ${replyCalls}`);
  check('有证据:resolve 恰好 1 次', resolveCalls === 1, `got ${resolveCalls}`);
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// 幂等:已 resolve 的 thread 重跑 → already-resolved,零新增动作
{
  const s = setup({ threads: [{ id: 'PRRT_2', isResolved: true, path: 'src/a.ts', comments: [] }] });
  const { r, out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_2', reply: '已在处理', justification: 'j' }], allowedBots: ['greptile-apps'] });
  check('已 resolve:退出码 0', r.status === 0);
  check('已 resolve:done=true 且 reason=already-resolved', out?.results?.[0]?.done === true && out?.results?.[0]?.reason === 'already-resolved', JSON.stringify(out?.results));
  const calls = s.readLog();
  check('已 resolve:零 reply/resolve 调用', !calls.some((l) => l.includes('ReviewThreadReply') || l.includes('resolveReviewThread')), JSON.stringify(calls));
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// D6:身份绑定 marker(pr=123 thread=PRRT_3 与当前上下文一致)存在但**没有本地回执** →
// marker-not-trustworthy(marker 来源不可信,可能是伪造/复制——pr 号与 thread id 都是
// 公开信息,任何有评论权限的账号都能定向伪造),进入可重试路径,不判永久 reopened。
// (SC-4:预存/复制的假 marker pr/thread 对不上连采信都不构成,见下一测试块)
{
  const s = setup({
    threads: [{
      id: 'PRRT_3', isResolved: false, path: 'src/b.ts',
      comments: ['bot 意见\n\n<!-- review-pr:thread-triage pr=123 thread=PRRT_3 sha=abc1234 -->'],
    }],
  });
  const { r, out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_3', reply: '再次处理', justification: 'j' }], allowedBots: ['greptile-apps'] });
  check('marker 无回执:退出码 0(结果在字段里)', r.status === 0);
  check('marker 无回执:done=false 且 reason=marker-not-trustworthy', out?.results?.[0]?.done === false && out?.results?.[0]?.reason?.startsWith('marker-not-trustworthy'), JSON.stringify(out?.results));
  const st = s.readState();
  check('marker 无回执:状态未被改', st.threads[0].isResolved === false);
  const calls = s.readLog();
  check('marker 无回执:零新增动作', !calls.some((l) => l.includes('addPullRequestReviewThreadReply') || l.includes('resolveReviewThread')), JSON.stringify(calls));
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// D6:marker + 本地回执同时存在,但回执指向的不是这一次 marker(非我们自己失败的
// resolve)→ 采信为「己方已 triage」且被人工翻案 → reopened-after-triage,永久留人工。
{
  const s = setup({
    threads: [{
      id: 'PRRT_9', isResolved: false, path: 'src/j.ts',
      comments: ['bot 意见\n\n<!-- review-pr:thread-triage pr=123 thread=PRRT_9 sha=abc1234 -->'],
    }],
  });
  // 预置一张回执(markerCommentId 对不上本次 marker 的评论 id = 不是"我们自己 resolve
  // 失败待重试"的形态)——路径与子进程一致(stateFile 同一套 lib.mjs 状态根)。
  writeFileSync(stateFile('resolve-thread-receipt-123__PRRT_9.json'), JSON.stringify({
    resolveOutcome: 'error', markerCommentId: 'some-other-comment-id', at: Date.now(),
  }));
  const { r, out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_9', reply: '再次处理', justification: 'j' }], allowedBots: ['greptile-apps'] });
  check('marker+回执:退出码 0(结果在字段里)', r.status === 0);
  check('marker+回执:done=false 且 reason=reopened-after-triage', out?.results?.[0]?.done === false && out?.results?.[0]?.reason?.startsWith('reopened-after-triage'), JSON.stringify(out?.results));
  const st = s.readState();
  check('marker+回执:状态未被改', st.threads[0].isResolved === false);
  const calls = s.readLog();
  check('marker+回执:零新增动作', !calls.some((l) => l.includes('addPullRequestReviewThreadReply') || l.includes('resolveReviewThread')), JSON.stringify(calls));
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// SC-4:预存 / 从别的 thread 复制过来的 marker(pr 或 thread 字段对不上当前上下文)不采信为
// "我们自己处理过"——必须走正常首轮流程(reply+resolve),不得被误判 reopened-after-triage。
{
  const s = setup({
    threads: [{
      id: 'PRRT_5', isResolved: false, path: 'src/e.ts',
      comments: [
        '这里调用了 `handleSubmit` 但缺少防抖,应改用 `debounce` 包裹。',
        // 伪造/复制的 marker:pr 对不上(999)—— 不应被当作"本 pr 本 thread 已处理过"
        '<!-- review-pr:thread-triage pr=999 thread=PRRT_5 sha=deadbeef -->',
      ],
    }],
  });
  const { r, out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_5', reply: '已在 abc1234 用 debounce 处理,代为 resolve;有异议可 reopen', justification: 'j' }],
    allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  check('伪 marker:退出码 0', r.status === 0, `stderr=${r.stderr.slice(0, 200)}`);
  check('伪 marker:未被误判翻案,正常 resolve', out?.results?.[0]?.done === true && out?.results?.[0]?.reason !== 'reopened-after-triage', JSON.stringify(out?.results));
  const st = s.readState();
  check('伪 marker:确实被 resolve', st.threads[0].isResolved === true);
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// thread-not-found:payload 里的 id 不在当前 PR 列表 → 明确拒绝
{
  const s = setup({ threads: [] });
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_999', reply: '处理', justification: 'j' }], allowedBots: ['greptile-apps'] });
  check('not-found:done=false', out?.results?.[0]?.done === false && out?.results?.[0]?.reason?.startsWith('thread-not-found'), JSON.stringify(out?.results));
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// 缺 --payload-file → fail-closed(exit 1)
{
  const s = setup({ threads: [{ id: 'PRRT_1', isResolved: false, path: 'src/c.ts', comments: [] }] });
  const r = spawnSync('node', [SCRIPT, '123'], { cwd: s.work, env: s.env, encoding: 'utf8' });
  check('缺 payload:exit 1', r.status === 1, `status=${r.status}`);
  check('缺 payload:error 指明必填', /--payload-file 必填/.test(r.stdout), r.stdout.slice(0, 200));
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// 静默 resolve 拒绝:缺 reply 的条目进 rejected,不动作
{
  const s = setup({ threads: [{ id: 'PRRT_4', isResolved: false, path: 'src/d.ts', comments: [] }] });
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_4', reply: '' }] });
  check('缺 reply:rejected 明示', out?.rejected?.length === 1 && out?.rejected?.[0]?.reason?.startsWith('missing-id-or-reply'), JSON.stringify(out?.rejected));
  check('缺 reply:零动作', out?.requested === 0);
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// SC-3:执行层白名单复核,fail-closed —— 真人 thread(首条评论作者不在 allowedBots)
// 即使 payload 声称有证据,也 0 reply / 0 resolve。
{
  const s = setup({
    threads: [{
      id: 'PRRT_6', isResolved: false, path: 'src/f.ts',
      comments: [{ body: '这里应该改成异步。', author: 'praisezhu' }],
    }],
  });
  const { out } = runScript(s.work, s.env, {
    threads: [{ id: 'PRRT_6', reply: '已处理', justification: 'j' }], allowedBots: ['greptile-apps'],
  });
  check('真人 thread:done=false 且拒绝原因指明白名单', out?.results?.[0]?.done === false && out?.results?.[0]?.reason?.startsWith('author-not-in-whitelist'), JSON.stringify(out?.results));
  const calls = s.readLog();
  check('真人 thread:零 reply/resolve 调用', !calls.some((l) => l.includes('addPullRequestReviewThreadReply') || l.includes('resolveReviewThread')), JSON.stringify(calls));
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// 未传 allowedBots(或传空数组)→ 执行层整体 fail-closed,即使作者其实在白名单同名
{
  const s = setup({ threads: [{ id: 'PRRT_7', isResolved: false, path: 'src/g.ts', comments: ['bot 意见'] }] });
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_7', reply: '已处理', justification: 'j' }] });
  check('未传白名单:triage-disabled', out?.results?.[0]?.done === false && out?.results?.[0]?.reason?.startsWith('triage-disabled'), JSON.stringify(out?.results));
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// SC-5:分页 —— 第 101 个 thread、第 51 条带 marker 的 comment 都必须能读到。
{
  const manyThreads = [];
  for (let i = 0; i < 100; i += 1) {
    manyThreads.push({ id: `PRRT_pad_${i}`, isResolved: true, path: `src/pad${i}.ts`, comments: [] });
  }
  // 第 101 个 thread(索引 100),带 51 条 comment,第 51 条(索引 50)才是真正的 bot claim。
  const manyComments = [];
  for (let i = 0; i < 50; i += 1) manyComments.push({ body: `占位评论 ${i}`, author: 'someone-else' });
  manyComments.push({ body: '这里调用了 `handleSubmit` 但缺少防抖,应改用 `debounce` 包裹。', author: 'greptile-apps' });
  manyThreads.push({ id: 'PRRT_101', isResolved: false, path: 'src/foo.ts', comments: manyComments });
  const s = setup({ threads: manyThreads });
  // 白名单按第 51 条评论的作者算(执行层只看首条评论作者,这里首条是 someone-else,不在白名单——
  // 用这个反证「分页确实取全了 51 条」,而不是脚本恰好只读到前 50 条就漏了第 51 条真身份)。
  // 换用一个「首条即 bot」的独立分页 fixture,直接验证"能读到第 101 个 thread"这件事本身:
  const { out: outNotFound } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_pad_99', reply: 'x', justification: 'j' }], allowedBots: ['greptile-apps'] }, s.pr);
  check('分页:第 100 个(索引 99)thread 能读到', outNotFound?.results?.[0]?.reason === 'already-resolved', JSON.stringify(outNotFound?.results));
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_101', reply: '已处理', justification: 'j' }], allowedBots: ['someone-else'] }, s.pr);
  check('分页:第 101 个 thread 能读到(不是 thread-not-found)', !out?.results?.[0]?.reason?.startsWith('thread-not-found'), JSON.stringify(out?.results));
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}
// 分页:单 thread 内第 51 条评论(带 marker)必须能通过 ThreadCommentsPage 查询读到,
// 用于翻案判定——只在 comments 分页完整时才可能命中 own marker(D6 要求 marker+回执
// 同时存在才判 reopened-after-triage,这里预置一张对不上本次 marker 的回执,保证走
// 永久翻案分支;若分页没读到第 52 条 marker,findOwnMarkerComment 命中不了,只会得到
// marker-not-trustworthy 之外的正常首轮行为,断言转红)。
{
  const manyComments = [];
  for (let i = 0; i < 50; i += 1) manyComments.push({ body: `占位评论 ${i}`, author: 'greptile-apps' });
  manyComments.push({ body: '第 51 条', author: 'greptile-apps', id: 'marker_c51' });
  manyComments.push({ body: '<!-- review-pr:thread-triage pr=123 thread=PRRT_page sha=abc1234 -->', author: 'review-pr-bot' });
  const s = setup({ threads: [{ id: 'PRRT_page', isResolved: false, path: 'src/h.ts', comments: manyComments }] });
  writeFileSync(stateFile('resolve-thread-receipt-123__PRRT_page.json'), JSON.stringify({
    resolveOutcome: 'error', markerCommentId: 'not-this-marker', at: Date.now(),
  }));
  const { out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_page', reply: '再次处理', justification: 'j' }], allowedBots: ['greptile-apps'] });
  check('分页:第 52 条(marker,超第 1 页)仍能被读到并判翻案', out?.results?.[0]?.reason?.startsWith('reopened-after-triage'), JSON.stringify(out?.results));
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

// SC-6:reply 成功但 resolve mutation 失败 → 留回执;下一轮看到「own marker + 回执」只
// 重试 resolve,不重复回复,也不误判 reopened-after-triage(人工翻案)。
{
  const s = setup({ threads: [{ id: 'PRRT_8', isResolved: false, path: 'src/i.ts', comments: ['bot 意见'] }] });
  const envFail = { ...s.env, FAKE_GH_RESOLVE_FAIL_FOR: 'PRRT_8' };
  const payload = { threads: [{ id: 'PRRT_8', reply: '已处理', justification: 'j' }], allowedBots: ['greptile-apps'], headSha: 'abc1234' };
  // 回执现在落在共享状态根(跨 fixture 同 key),先清掉历史残留,避免上一轮失败留下的
  // 陈旧回执污染本轮「marker+回执」判定。
  rmSync(stateFile('resolve-thread-receipt-123__PRRT_8.json'), { force: true });
  const first = runScript(s.work, envFail, payload);
  check('部分失败:首轮 replied=true 但 resolved=false', first.out?.results?.[0]?.replied === true && first.out?.results?.[0]?.resolved === false, JSON.stringify(first.out?.results));
  const st1 = s.readState();
  check('部分失败:状态仍未 resolve', st1.threads[0].isResolved === false);
  const calls1 = s.readLog();
  const replyCalls1 = calls1.filter((l) => l.includes('addPullRequestReviewThreadReply')).length;
  check('部分失败:reply 恰好 1 次', replyCalls1 === 1, `got ${replyCalls1}`);
  // 下一轮(不再注入失败)→ 应识别为「我们自己失败」,只重试 resolve,不重复 reply
  const second = runScript(s.work, s.env, payload);
  check('部分失败下一轮:reason=resolve-retry-succeeded', second.out?.results?.[0]?.reason?.startsWith('resolve-retry-succeeded'), JSON.stringify(second.out?.results));
  check('部分失败下一轮:done=true', second.out?.results?.[0]?.done === true);
  const st2 = s.readState();
  check('部分失败下一轮:最终已 resolve', st2.threads[0].isResolved === true);
  const calls2 = s.readLog();
  const replyCalls2 = calls2.filter((l) => l.includes('addPullRequestReviewThreadReply')).length;
  check('部分失败下一轮:未重复 reply(仍恰好 1 次)', replyCalls2 === 1, `got ${replyCalls2}`);
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} 个用例失败(同步用例小计,下方还有真并发异步用例)`);
}

// ── SC-2:真双进程并发 —— 两个子进程几乎同时对同一 thread 发起代 resolve,靠
// resolve-threads.mjs 自己的文件锁保证「至多一次」,不是靠 fixture 预置已完成状态模拟
// (那是假并发)。两个子进程必须共享同一个 lockDir(故意不用 setup() 各自默认的隔离锁)。
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

async function runConcurrencyTest() {
  const s = setup({ threads: [{ id: 'PRRT_CONC', isResolved: false, path: 'src/conc.ts', comments: ['真实 bot 意见,缺少防抖'] }] });
  const payload = JSON.stringify({
    threads: [{ id: 'PRRT_CONC', reply: '已处理,代为 resolve', justification: 'j' }], allowedBots: ['greptile-apps'], headSha: 'abc1234',
  });
  const [r1, r2] = await Promise.all([
    spawnAsync([SCRIPT, '123', '--payload-file', '-'], s, payload),
    spawnAsync([SCRIPT, '123', '--payload-file', '-'], s, payload),
  ]);
  const out1 = (() => { try { return JSON.parse(r1.stdout); } catch { return null; } })();
  const out2 = (() => { try { return JSON.parse(r2.stdout); } catch { return null; } })();
  check('并发:两个进程都退出码 0', r1.code === 0 && r2.code === 0, `code1=${r1.code} code2=${r2.code} stderr1=${r1.stderr.slice(0, 200)} stderr2=${r2.stderr.slice(0, 200)}`);
  const st = s.readState();
  check('并发:thread 最终确实被 resolve', st.threads[0].isResolved === true);
  const calls = s.readLog();
  const replyCalls = calls.filter((l) => l.includes('addPullRequestReviewThreadReply')).length;
  const resolveCalls = calls.filter((l) => l.includes('resolveReviewThread')).length;
  check('并发:reply 恰好 1 次(不是 2 次)', replyCalls === 1, `got ${replyCalls}`);
  check('并发:resolve 恰好 1 次(不是 2 次)', resolveCalls === 1, `got ${resolveCalls}`);
  check('并发:两个进程结果都标 done(一个真做,一个看到已完成)', out1?.results?.[0]?.done === true && out2?.results?.[0]?.done === true, `${JSON.stringify(out1?.results)} / ${JSON.stringify(out2?.results)}`);
  rmSync(s.work, { recursive: true, force: true });
  rmSync(s.lockDir, { recursive: true, force: true });
}

await runConcurrencyTest();

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('resolve-threads.test.mjs: 全部用例通过');
