#!/usr/bin/env node
// resolve-threads.test.mjs — thread 代 resolve 的回归:
//   ① assessThreadEvidence(语义绑定判据,lib.mjs):有证据 resolve / 无证据不动 /
//      真人 thread 不动 / 白名单外 bot 不动 / isOutdated 只是线索 / 未配置禁用;
//   ② 脚本级(fake-gh-resolve 可变状态):有证据 → 恰好一次 reply+resolve;重跑幂等;
//      翻案 reopened-after-triage 永不碰;缺 --payload-file fail-closed;双并发模拟
//      无重复动作。
// 跑:node scripts/resolve-threads.test.mjs   退出码 0 = 全过。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessThreadEvidence, extractThreadTokens,
} from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'resolve-threads.mjs');
const FAKE_GH = join(__dirname, '..', 'tests', 'fixtures', 'fake-gh-resolve', 'gh');
const FAKE_GH_LOG = '';

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

// ── ① assessThreadEvidence:语义绑定判据 ──
const BOT_THREAD = {
  id: 'PRRT_1', path: 'src/foo.ts',
  body: '这里调用了 `handleSubmit` 但缺少防抖,快速连点会重复提交。',
  author: 'greptile-apps',
};
const HUMAN_THREAD = { ...BOT_THREAD, author: 'praisezhu' };
const OTHER_BOT = { ...BOT_THREAD, author: 'copilot-pull-request-reviewer' };
const ALLOWED = ['greptile-apps'];
const DIFF = [
  { path: 'src/foo.ts', additions: ['function handleSubmit() {', '+  const debounced = debounce(onSubmit, 300);', '+  return debounced();', '}'], removals: [] },
  { path: 'src/bar.ts', additions: ['// 无关改动'], removals: [] },
];

// 有证据(claim token 在修复新增行中被处理)→ resolve
const bound = assessThreadEvidence({ thread: BOT_THREAD, authorType: 'bot', allowedBots: ALLOWED, diff: DIFF });
eq('有证据 resolve', bound.canResolve, true);
eq('证据类型 semantic-bound', bound.evidence, 'semantic-bound');
check('证据命中 token', bound.matchedToken === 'handleSubmit', `got ${bound.matchedToken}`);
// 无证据:仅同文件被后续 commit 触碰 → 不动(path-touched 只是必要线索)
const onlyPath = assessThreadEvidence({
  thread: { ...BOT_THREAD, body: '这里应该用双引号。' }, // 无针对性 token 命中新增行
  authorType: 'bot', allowedBots: ALLOWED, diff: DIFF,
});
eq('仅同文件触碰不动', onlyPath.canResolve, false);
check('原因 path-touched-only', onlyPath.reason.startsWith('path-touched-only'), onlyPath.reason);
// 无证据:isOutdated 只是线索,不单独构成证据(path 不在 diff 里,避免撞 path-touched 分支;
// path 在 diff 里 + outdated 时按更强的 path-touched-only 报告,同样不动)
const outdatedOnly = assessThreadEvidence({
  thread: { ...BOT_THREAD, path: 'src/zzz.ts', isOutdated: true, body: '这里应该用双引号。' },
  authorType: 'bot', allowedBots: ALLOWED, diff: DIFF,
});
eq('isOutdated 只是线索 → 不动', outdatedOnly.canResolve, false);
check('原因 outdated-only', outdatedOnly.reason.startsWith('outdated-only'), outdatedOnly.reason);
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
check('原因 bot-not-in-whitelist', notInList.reason.startsWith('bot-not-in-whitelist'), notInList.reason);
// 未配置白名单(threadTriage.extraBots 空)→ 整体禁用
const disabled = assessThreadEvidence({ thread: BOT_THREAD, authorType: 'bot', allowedBots: [], diff: DIFF });
eq('未配置白名单 → 禁用', disabled.canResolve, false);
check('原因 triage-disabled', disabled.reason.startsWith('triage-disabled'), disabled.reason);
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

function setup({ threads, pr = 123 } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'resolve-threads-test-'));
  git(['init', '-q', work], work);
  git(['remote', 'add', 'origin', 'https://github.com/acme/app.git'], work);
  const stateFile = join(work, 'state.json');
  const logFile = join(work, 'calls.jsonl');
  // threads 用 GitHub GraphQL 形状(comments.nodes),与 resolve-threads.mjs 的解析一致
  writeFileSync(stateFile, JSON.stringify({
    threads: (threads ?? []).map((t) => ({
      id: t.id, isResolved: t.isResolved, path: t.path,
      comments: { nodes: (t.comments ?? []).map((b) => ({ body: b })) },
    })),
  }));
  const env = {
    ...process.env,
    PATH: `${dirname(FAKE_GH)}:${process.env.PATH}`,
    FAKE_GH_RESOLVE_STATE: stateFile,
    FAKE_GH_LOG: logFile,
  };
  const readLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []);
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  return { work, env, stateFile, logFile, readLog, readState };
}

const runScript = (work, env, payload) => {
  const p = JSON.stringify(payload);
  const r = spawnSync('node', [SCRIPT, '123', '--payload-file', '-'], { cwd: work, env, input: p, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  return { r, out };
};

// 有证据 → 恰好一次 reply+resolve
{
  const s = setup({ threads: [{ id: 'PRRT_1', isResolved: false, path: 'src/foo.ts', comments: ['缺少防抖'] }] });
  const { r, out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_1', reply: '已在 abc1234 用 debounce 处理,代为 resolve;有异议可 reopen' }] });
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
}

// 幂等 + 双并发:已 resolve 的 thread 重跑 → already-resolved,零新增动作(第二实例看到第一实例结果)
{
  const s = setup({ threads: [{ id: 'PRRT_2', isResolved: true, path: 'src/a.ts', comments: [] }] });
  const { r, out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_2', reply: '已在处理' }] });
  check('已 resolve:退出码 0', r.status === 0);
  check('已 resolve:done=true 且 reason=already-resolved', out?.results?.[0]?.done === true && out?.results?.[0]?.reason === 'already-resolved', JSON.stringify(out?.results));
  const calls = s.readLog();
  check('已 resolve:零 reply/resolve 调用', !calls.some((l) => l.includes('ReviewThreadReply') || l.includes('resolveReviewThread')), JSON.stringify(calls));
  rmSync(s.work, { recursive: true, force: true });
}

// 翻案保护:带 triage 标记回复却未 resolve → reopened-after-triage,永不碰
{
  const s = setup({ threads: [{ id: 'PRRT_3', isResolved: false, path: 'src/b.ts', comments: ['bot 意见<!-- review-pr:thread-triage -->'] }] });
  const { r, out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_3', reply: '再次处理' }] });
  check('翻案:退出码 0(结果在字段里)', r.status === 0);
  check('翻案:done=false 且 reason=reopened-after-triage', out?.results?.[0]?.done === false && out?.results?.[0]?.reason?.startsWith('reopened-after-triage'), JSON.stringify(out?.results));
  const st = s.readState();
  check('翻案:状态未被改', st.threads[0].isResolved === false);
  const calls = s.readLog();
  check('翻案:零动作', !calls.some((l) => l.includes('ReviewThreadReply') || l.includes('resolveReviewThread')), JSON.stringify(calls));
  rmSync(s.work, { recursive: true, force: true });
}

// thread-not-found:payload 里的 id 不在当前 PR 列表 → 明确拒绝
{
  const s = setup({ threads: [] });
  const { r, out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_999', reply: '处理' }] });
  check('not-found:done=false', out?.results?.[0]?.done === false && out?.results?.[0]?.reason?.startsWith('thread-not-found'), JSON.stringify(out?.results));
  rmSync(s.work, { recursive: true, force: true });
}

// 缺 --payload-file → fail-closed(exit 1)
{
  const s = setup({ threads: [{ id: 'PRRT_1', isResolved: false, path: 'src/c.ts', comments: [] }] });
  const r = spawnSync('node', [SCRIPT, '123'], { cwd: s.work, env: s.env, encoding: 'utf8' });
  check('缺 payload:exit 1', r.status === 1, `status=${r.status}`);
  check('缺 payload:error 指明必填', /--payload-file 必填/.test(r.stdout), r.stdout.slice(0, 200));
  rmSync(s.work, { recursive: true, force: true });
}

// 静默 resolve 拒绝:缺 reply 的条目进 rejected,不动作
{
  const s = setup({ threads: [{ id: 'PRRT_4', isResolved: false, path: 'src/d.ts', comments: [] }] });
  const { r, out } = runScript(s.work, s.env, { threads: [{ id: 'PRRT_4', reply: '' }] });
  check('缺 reply:rejected 明示', out?.rejected?.length === 1 && out?.rejected?.[0]?.reason?.startsWith('missing-id-or-reply'), JSON.stringify(out?.rejected));
  check('缺 reply:零动作', out?.requested === 0);
  rmSync(s.work, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('resolve-threads.test.mjs: 全部用例通过');
