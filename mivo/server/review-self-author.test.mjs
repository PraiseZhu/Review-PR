// 作者就是审查账号(PraiseZhu 自己的 PR)时,自批被拒是预期的,审查机改以评论发报告。
// 2026-10-17 #1081:还有未 resolve 的讨论、Greptile 检查失败,却被挂了 review:merge-ready、review-pr 写成 success。
// 现在只有「除了作者不能自批,其它全部通过」才挂标签、写 success;还有别的拦截项时与「送审但不放行」一致。
// finish-reviewed-pr.mjs 用替身脚本:把测试给的回执原样写进 --result-file,不碰 GitHub。gh 用 PATH 上的替身记录调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(SERVER_DIR, '..', 'lib');
const SHA = 'a'.repeat(40);
const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'pass —— 没有 P0/P1。'].join('\n');
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');

const AUTHOR = { code: 'independent-approval-required', reason: '当前 viewer 是 PR 作者，未核验到另一位维护者的有效 Approve，不能自批' };
const THREADS = { code: 'threads-unresolved', reason: '仍有 conversation 未 resolve' };
const THREADS_UNVERIFIED = { code: 'threads-unverified', reason: 'review thread 状态未完整读取' };

// SKILL_ROOT 取自 common.mjs 所在位置:复制一份最小的 mivo/ 到临时根目录,再放一个替身 finish-reviewed-pr.mjs。
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mivo-self-author-'));
  mkdirSync(join(root, 'mivo', 'lib'), { recursive: true });
  mkdirSync(join(root, 'mivo', 'server'), { recursive: true });
  mkdirSync(join(root, 'review-pr', 'scripts'), { recursive: true });
  for (const file of readdirSync(LIB_DIR).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) copyFileSync(join(LIB_DIR, file), join(root, 'mivo', 'lib', file));
  for (const file of ['review.mjs', 'codex.mjs']) copyFileSync(join(SERVER_DIR, file), join(root, 'mivo', 'server', file));
  writeFileSync(join(root, 'review-pr', 'scripts', 'finish-reviewed-pr.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
const out = JSON.parse(readFileSync(process.env.STUB_FINISH, 'utf8'));
writeFileSync(process.argv[process.argv.indexOf('--result-file') + 1], JSON.stringify(out));
console.log(JSON.stringify(out));
`);
  return root;
}

function fakeGh(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'gh-calls.jsonl');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
if (args.includes('--paginate')) { process.stdout.write('[[]]'); process.exit(0); }
if (args.includes('DELETE')) { process.stderr.write('HTTP 404 Label does not exist'); process.exit(1); }
if (args.length === 2 && args[0] === 'api' && args[1] === 'repos/o/r/pulls/7') { process.stdout.write(JSON.stringify({ head: { sha: ${JSON.stringify(SHA)} }, labels: [] })); process.exit(0); }
process.stdout.write(JSON.stringify({ id: 5 }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

// receipt:finish 回执里 approval-blocked 的样子;failures 为 undefined 时模拟旧回执(没有逐项明细)。
function setup({ failures }) {
  const root = makeRoot();
  const work = join(root, 'work');
  for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
  writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
  writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: SHA, base: SHA, tier: 'standard', prevRunId: '',
    roundId: 'round-12345678', attempt: 1, mode: 'live', action: 'review', skillSha: SHA, runId: '42', runUrl: '' };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
    lockToken: 'lock-token', authorityDigest: 'digest',
    context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
      evidence: { head: SHA, base: SHA, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: true },
    current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
    scope: { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] }, checkRunId: 99, pendingGates: [],
    deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] } }));
  writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: REPORT, findings: [] }));
  const approval = { status: 'blocked', code: AUTHOR.code, reason: (failures ?? [AUTHOR]).map((f) => f.reason).join('; ') };
  const approvalResult = { ok: true, pr: 7, approved: false, approval, retry: false,
    failedChecks: (failures ?? [AUTHOR]).map((f) => f.reason), reason: approval.reason, ...(failures ? { failures } : {}) };
  writeFileSync(join(work, 'finish-stub.json'), JSON.stringify({ stage: 'approval-blocked', ok: true, reason: approval.reason, approval, approvalResult, retry: false }));
  return { root, work };
}

function publish({ root, work }, gh) {
  const env = { ...process.env, MIVO_REVIEW_WORK: work, STUB_FINISH: join(work, 'finish-stub.json'), GH_TOKEN: 'x', CHECKS_TOKEN: 'y',
    PATH: `${gh.bin}${delimiter}${process.env.PATH}` };
  const r = spawnSync(process.execPath, [join(root, 'mivo', 'server', 'review.mjs'), 'publish'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
}

const reportComments = (calls) => calls.filter((c) => c.args.includes('repos/o/r/pulls/7/reviews') && c.args.includes('POST')).map((c) => JSON.parse(c.input));
const checkBodies = (calls) => calls.filter((c) => c.args.includes('repos/o/r/check-runs/99')).map((c) => JSON.parse(c.input));
const addedLabel = (calls) => calls.some((c) => c.args.includes('labels[]=review:merge-ready'));
const removedLabel = (calls) => calls.some((c) => c.args.includes('DELETE') && c.args.some((a) => /issues\/7\/labels\//.test(a)));

test('作者自批是唯一拦截项:评论发报告、挂 review:merge-ready、review-pr 写 success(原有行为不变)', () => {
  const env = setup({ failures: [AUTHOR] });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    const calls = gh.calls();
    assert.equal(result.outcome, 'approval');
    assert.equal(result.reviewClean, true);
    assert.match(result.reason, /作者是审查账号本人/);
    assert.ok(addedLabel(calls), '只差另一位维护者 Approve:挂标签');
    const [comment] = reportComments(calls);
    assert.equal(comment.event, 'COMMENT');
    assert.match(comment.body, new RegExp(`<!-- mivo-review:report head=${SHA} -->$`));
    const checks = checkBodies(calls);
    assert.equal(checks.at(-1).conclusion, 'success');
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

// prepare 阶段只算一次 pendingGates(review.mjs prepare):#1081 在 12:49 prepare 时 Greptile 还没发评论,pendingGates 为空;
// publish 时的拦截项来自 approve-reviewed-pr 当场的实时读取(finish 阶段),不是 prepare 的快照。setup() 里 pendingGates 固定为 []。
test('prepare 时没有待办门、publish 时实时读到未 resolve 的讨论(#1081):按「送审但不放行」处理——不挂标签、摘标签、check 留在进行中', () => {
  const env = setup({ failures: [AUTHOR, THREADS] });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    const calls = gh.calls();
    assert.equal(addedLabel(calls), false, '不能挂 review:merge-ready');
    assert.ok(removedLabel(calls), '已有的标签要摘');
    assert.equal(result.outcome, 'merge-blocked');
    assert.equal(result.reviewClean, false, 'Mini 不能把这个 head 记成审查通过');
    assert.equal(result.approval.code, 'gates-pending');
    assert.match(result.reason, /代码审查没有 P0\/P1,但还不能放行:.*仍有 conversation 未 resolve/);
    assert.doesNotMatch(result.reason, /不能自批/, '作者自批不是用户要补齐的东西,不列进待办');
    assert.deepEqual(result.mivo.advisory.blockers, [THREADS.reason]);
    assert.notEqual(result.retry, true, '讨论没 resolve 是确定的拦截,等人处理');
    const [comment] = reportComments(calls);
    assert.equal(comment.event, 'COMMENT');
    assert.match(comment.body, /^> \*\*代码审查没有发现 P0\/P1,但这个 PR 还不能放行\*\*/);
    assert.match(comment.body, new RegExp(`<!-- mivo-review:advisory head=${SHA} -->$`));
    assert.doesNotMatch(comment.body, /mivo-review:report/, '不带干净报告标记,盯梢不会当成放行');
    const last = checkBodies(calls).at(-1);
    assert.equal(last.status, 'in_progress');
    assert.equal(last.conclusion, undefined, '不写 success');
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('作者自批之外的拦截只是读取不确定:同样不放行,但标 retry 等下一轮重读', () => {
  const env = setup({ failures: [THREADS_UNVERIFIED, AUTHOR] });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    const calls = gh.calls();
    assert.equal(addedLabel(calls), false);
    assert.equal(result.outcome, 'merge-blocked');
    assert.equal(result.reviewClean, false);
    assert.equal(result.retry, true);
    assert.equal(checkBodies(calls).at(-1).conclusion, undefined);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('回执没有逐项明细(旧格式):读不到就不放行,不挂标签、不写 success', () => {
  const env = setup({ failures: undefined });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    const calls = gh.calls();
    assert.equal(addedLabel(calls), false);
    assert.equal(result.outcome, 'merge-blocked');
    assert.equal(result.reviewClean, false);
    assert.equal(result.retry, true);
    assert.equal(checkBodies(calls).at(-1).conclusion, undefined);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});
