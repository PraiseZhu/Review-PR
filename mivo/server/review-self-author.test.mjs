// 作者就是审查账号(PraiseZhu 自己的 PR)时,自批被拒是预期的,审查机改以评论发报告。
// 2026-10-17 #1081:还有未 resolve 的讨论、Greptile 检查失败,却被挂了 review:merge-ready、review-pr 写成 success。
// 现在只有「除了作者不能自批,其它全部通过」才挂标签、写 success;还有别的拦截项时与「送审但不放行」一致。
// finish-reviewed-pr.mjs 用替身脚本:把测试给的回执原样写进 --result-file,不碰 GitHub。gh 用 PATH 上的替身记录调用。
// 2026-10-17 补审:挂 review:merge-ready 之前还要按实时门禁复核 CI / 讨论 / 冲突——已 Approve 路径用 finish 带回的 preMerge,
// 作者自批路径补跑 pre-merge-check.mjs(替身,调用记录在 premerge-calls.jsonl)。
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
// pre-merge-check / finish 的 preMerge 里挂标要看的字段;canMerge=false + BLOCKED 是 review-only「等维护者 Approve」的常态,不拦。
// codeScanning:2026-10-18 起挂标前还要核代码扫描门(#1025);默认是「目标分支要求 CodeQL,且已 success」。
const SCAN_RULES = [{ type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] } }, { type: 'code_quality', parameters: { severity: 'warnings' } }];
const codeql = (patch = {}) => ({ name: 'CodeQL', appSlug: 'github-advanced-security', status: 'completed', conclusion: 'success',
  title: 'No new alerts in code changed by this pull request', completedAt: new Date().toISOString(), ...patch });
const scanning = (checks, rules = SCAN_RULES) => ({ rules, rulesError: null, checks });
const PASS_GATES = { ok: true, headVerified: true, baseVerified: true, threadsVerified: true, unresolvedThreads: [], ci: { status: 'pass' },
  mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE', canMerge: false, codeScanning: scanning([codeql()]) };
const premergeCalls = (work) => existsSync(join(work, 'premerge-calls.jsonl'))
  ? readFileSync(join(work, 'premerge-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];

// SKILL_ROOT 取自 common.mjs 所在位置:复制一份最小的 mivo/ 到临时根目录,再放一个替身 finish-reviewed-pr.mjs。
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mivo-self-author-'));
  mkdirSync(join(root, 'mivo', 'lib'), { recursive: true });
  mkdirSync(join(root, 'mivo', 'server'), { recursive: true });
  mkdirSync(join(root, 'review-pr', 'scripts'), { recursive: true });
  for (const file of readdirSync(LIB_DIR).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) copyFileSync(join(LIB_DIR, file), join(root, 'mivo', 'lib', file));
  for (const file of ['review.mjs', 'codex.mjs', 'keys.mjs']) copyFileSync(join(SERVER_DIR, file), join(root, 'mivo', 'server', file));
  copyFileSync(join(SERVER_DIR, '..', '..', 'review-pr', 'scripts', 'self-write-receipts.mjs'),
    join(root, 'review-pr', 'scripts', 'self-write-receipts.mjs'));
  // review.mjs 读分流日志汇总用的 gh-read-route.mjs(及它搬运的分类器)。
  mkdirSync(join(root, 'review-pr', 'scripts', 'vendor'), { recursive: true });
  copyFileSync(join(SERVER_DIR, '..', '..', 'review-pr', 'scripts', 'gh-read-route.mjs'), join(root, 'review-pr', 'scripts', 'gh-read-route.mjs'));
  copyFileSync(join(SERVER_DIR, '..', '..', 'review-pr', 'scripts', 'vendor', 'gh-app-classify.mjs'),
    join(root, 'review-pr', 'scripts', 'vendor', 'gh-app-classify.mjs'));
  writeFileSync(join(root, 'review-pr', 'scripts', 'finish-reviewed-pr.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
const out = JSON.parse(readFileSync(process.env.STUB_FINISH, 'utf8'));
writeFileSync(process.argv[process.argv.indexOf('--result-file') + 1], JSON.stringify(out));
console.log(JSON.stringify(out));
`);
  writeFileSync(join(root, 'review-pr', 'scripts', 'pre-merge-check.mjs'), `import { readFileSync, appendFileSync } from 'node:fs';
appendFileSync(process.env.STUB_PREMERGE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const raw = readFileSync(process.env.STUB_PREMERGE, 'utf8');
if (raw === 'CRASH') { console.error('boom'); process.exit(1); }
console.log(raw);
process.exit(2);
`);
  return root;
}

function fakeGh(dir, { failSnapshot = false } = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'gh-calls.jsonl');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
if (${JSON.stringify(failSnapshot)} && args[1] === 'repos/o/r/pulls/7' && fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').filter((line) => JSON.parse(line).args[1] === 'repos/o/r/pulls/7').length === 1) { process.stderr.write('snapshot read failed'); process.exit(1); }
if (args.includes('--paginate')) { process.stdout.write('[[]]'); process.exit(0); }
if (args.includes('DELETE')) { process.stderr.write('HTTP 404 Label does not exist'); process.exit(1); }
if (args.length === 2 && args[0] === 'api' && args[1] === 'repos/o/r/pulls/7') { process.stdout.write(JSON.stringify({ head: { sha: ${JSON.stringify(SHA)} }, labels: [], updated_at: new Date(Date.now() - 1000).toISOString() })); process.exit(0); }
process.stdout.write(JSON.stringify({ id: 5, updated_at: new Date().toISOString() }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

// receipt:finish 回执里 approval-blocked 的样子;failures 为 undefined 时模拟旧回执(没有逐项明细)。
function setup({ failures, verified = false, preMerge = PASS_GATES, premergeRaw = null }) {
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
      evidence: { head: SHA, base: SHA, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: !verified },
    current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
    scope: { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] }, checkRunId: 99, pendingGates: [],
    deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] } }));
  writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: REPORT, findings: [] }));
  const approval = { status: 'blocked', code: AUTHOR.code, reason: (failures ?? [AUTHOR]).map((f) => f.reason).join('; ') };
  const approvalResult = { ok: true, pr: 7, approved: false, approval, retry: false,
    failedChecks: (failures ?? [AUTHOR]).map((f) => f.reason), reason: approval.reason, ...(failures ? { failures } : {}) };
  // 已 Approve 路径:finish 回 reviewed-only + 已核验的 Approve,preMerge 是它实时读到的门禁(preMerge=null 表示回执里没有;不能用 undefined,会触发默认参数)
  const verifiedApproval = { status: 'verified', reviewId: '9', reviewer: 'reviewer-bot', head: SHA, verifiedAt: new Date().toISOString() };
  const receipt = verified
    ? { stage: 'reviewed-only', ok: true, approval: verifiedApproval, approvalResult: { ok: true, approved: true, approval: verifiedApproval },
      ...(preMerge === null ? {} : { preMerge }), retry: false }
    : { stage: 'approval-blocked', ok: true, reason: approval.reason, approval, approvalResult, retry: false };
  writeFileSync(join(work, 'finish-stub.json'), JSON.stringify(receipt));
  // 作者自批路径补跑 pre-merge-check 的替身输出(premergeRaw='CRASH' 表示脚本崩溃)
  writeFileSync(join(work, 'premerge-stub.json'), premergeRaw ?? JSON.stringify(preMerge ?? {}));
  return { root, work };
}

function publish({ root, work }, gh) {
  const env = { ...process.env, MIVO_REVIEW_WORK: work, STUB_FINISH: join(work, 'finish-stub.json'), STUB_PREMERGE: join(work, 'premerge-stub.json'),
    STUB_PREMERGE_LOG: join(work, 'premerge-calls.jsonl'), GH_TOKEN: 'x', CHECKS_TOKEN: 'y',
    PATH: `${gh.bin}${delimiter}${process.env.PATH}` };
  const r = spawnSync(process.execPath, [join(root, 'mivo', 'server', 'review.mjs'), 'publish'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
}

const reportComments = (calls) => calls.filter((c) => c.args.includes('repos/o/r/pulls/7/reviews') && c.args.includes('POST')).map((c) => JSON.parse(c.input));
const checkBodies = (calls) => calls.filter((c) => c.args.includes('repos/o/r/check-runs/99')).map((c) => JSON.parse(c.input));
const addedLabel = (calls) => calls.some((c) => c.args.includes('labels[]=review:merge-ready'));
const removedLabel = (calls) => calls.some((c) => c.args.includes('DELETE') && c.args.some((a) => /issues\/7\/labels\//.test(a)));

test('自写前 REST GET 失败不拦原本发布,但不生成该次自写回执', () => {
  const env = setup({ failures: [AUTHOR, THREADS] });
  const gh = fakeGh(env.work, { failSnapshot: true });
  try {
    const result = publish(env, gh);
    assert.equal(reportComments(gh.calls()).length, 1);
    assert.equal(result.outcome, 'merge-blocked');
    assert.deepEqual(result.selfWriteReceipts, []);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('作者自批是唯一拦截项:评论发报告、挂 review:merge-ready、review-pr 写 success(原有行为不变)', () => {
  const env = setup({ failures: [AUTHOR] });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    const calls = gh.calls();
    assert.equal(result.outcome, 'approval');
    assert.equal(result.reviewClean, true);
    assert.ok(result.selfWriteReceipts.length >= 1, '服务器发布回执随现有结果文件传回');
    assert.ok(result.selfWriteReceipts.every((receipt) => receipt.repo === 'o/r' && receipt.pr === 7 && receipt.head === SHA));
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

// ── 挂标前按实时门禁复核(2026-10-17 补审)──
test('已 Approve 路径:preMerge 全过(含 canMerge=false 的等维护者常态)照常挂标签、写 success', () => {
  const env = setup({ verified: true });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    const calls = gh.calls();
    assert.equal(result.outcome, 'review-only');
    assert.ok(addedLabel(calls));
    assert.equal(checkBodies(calls).at(-1).conclusion, 'success');
    assert.equal(premergeCalls(env.work).length, 0, '已 Approve 路径用 finish 带回的 preMerge,不再补跑');
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('已 Approve 路径:CI 失败 / 讨论未 resolve / 冲突不挂标签(并摘掉已有的),原因写进 warnings 与 labelWithheld', () => {
  for (const [name, patch, code, retry] of [
    ['CI 失败', { ci: { status: 'failed', reason: 'verify 失败' } }, 'ci-failed', false],
    ['讨论未 resolve', { unresolvedThreads: [{}, {}] }, 'threads-unresolved', false],
    ['冲突', { mergeStateStatus: 'DIRTY' }, 'conflict', false],
    ['head 变了', { headVerified: false }, 'head-or-base-changed', true],
  ]) {
    const env = setup({ verified: true, preMerge: { ...PASS_GATES, ...patch } });
    const gh = fakeGh(env.work);
    try {
      const result = publish(env, gh);
      const calls = gh.calls();
      assert.equal(addedLabel(calls), false, name);
      assert.ok(removedLabel(calls), `${name}:摘掉已有标签`);
      assert.equal(result.outcome, 'review-only', name);
      assert.deepEqual(result.mivo.labelWithheld.map((b) => b.code), [code], name);
      assert.ok(result.warnings.some((w) => /review:merge-ready 没挂/.test(w)), name);
      assert.equal(result.retry === true, retry, name);
      assert.equal(checkBodies(calls).at(-1).conclusion, 'success', `${name}:Approve 已发出,check 仍如实写 success`);
    } finally { rmSync(env.root, { recursive: true, force: true }); }
  }
});

test('已 Approve 路径:CI 在跑等瞬态照常挂标;回执里没有 preMerge 一律不挂并重试', () => {
  for (const status of ['pending', 'awaiting', 'unknown']) {
    const env = setup({ verified: true, preMerge: { ...PASS_GATES, ci: { status } } });
    const gh = fakeGh(env.work);
    try { publish(env, gh); assert.ok(addedLabel(gh.calls()), `CI ${status}`); } finally { rmSync(env.root, { recursive: true, force: true }); }
  }
  const env = setup({ verified: true, preMerge: null });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    assert.equal(addedLabel(gh.calls()), false);
    assert.deepEqual(result.mivo.labelWithheld.map((b) => b.code), ['pre-merge-missing']);
    assert.equal(result.retry, true);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('作者自批路径:补跑 pre-merge-check 复核,全过才发报告评论并挂标签', () => {
  const env = setup({ failures: [AUTHOR], preMerge: PASS_GATES });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    const calls = gh.calls();
    const pm = premergeCalls(env.work);
    assert.equal(pm.length, 1, '补跑了一次');
    assert.equal(pm[0][0], '7');
    assert.ok(pm[0].includes('--expected-head') && pm[0].includes(SHA), '绑定已审查的 head');
    assert.ok(pm[0].includes('--expected-authority-digest'));
    assert.equal(result.outcome, 'approval');
    assert.ok(addedLabel(calls));
    assert.equal(checkBodies(calls).at(-1).conclusion, 'success');
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('作者自批路径:prepare 之后 CI 才失败 / 冲突 / 出现讨论:走 advisory——不发干净报告标记、不挂标签、check 留在进行中', () => {
  for (const [name, patch, text] of [
    ['CI 失败', { ci: { status: 'failed', reason: 'verify 失败' } }, /CI 失败/],
    ['冲突', { mergeStateStatus: 'DIRTY' }, /与 base 有冲突/],
    ['讨论', { unresolvedThreads: [{}] }, /仍有 1 条 conversation 未 resolve/],
  ]) {
    const env = setup({ failures: [AUTHOR], preMerge: { ...PASS_GATES, ...patch } });
    const gh = fakeGh(env.work);
    try {
      const result = publish(env, gh);
      const calls = gh.calls();
      assert.equal(addedLabel(calls), false, name);
      assert.ok(removedLabel(calls), name);
      assert.equal(result.outcome, 'merge-blocked', name);
      assert.equal(result.reviewClean, false, name);
      assert.match(result.reason, text, name);
      assert.match(result.mivo.advisory.blockers.join(';'), text, name);
      const comments = reportComments(calls);
      assert.equal(comments.length, 1, `${name}:只发一条评论(advisory),没有先发干净报告`);
      assert.match(comments[0].body, new RegExp(`<!-- mivo-review:advisory head=${SHA} -->$`), name);
      assert.doesNotMatch(comments[0].body, /mivo-review:report/, name);
      assert.equal(checkBodies(calls).at(-1).conclusion, undefined, name);
    } finally { rmSync(env.root, { recursive: true, force: true }); }
  }
});

test('作者自批路径:pre-merge-check 崩溃或没有 JSON:不放行,标 retry', () => {
  const env = setup({ failures: [AUTHOR], premergeRaw: 'CRASH' });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    const calls = gh.calls();
    assert.equal(addedLabel(calls), false);
    assert.equal(result.outcome, 'merge-blocked');
    assert.equal(result.retry, true);
    assert.match(result.mivo.advisory.blockers.join(';'), /合并前门禁复核没有完成/);
    assert.equal(reportComments(calls).filter((c) => /mivo-review:report/.test(c.body)).length, 0);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

// ── 代码扫描门(2026-10-18,#1025:CodeQL neutral「1 configuration not found」,GitHub 挡合并,审查机却挂了标签)──
const NEUTRAL = codeql({ conclusion: 'neutral', title: '1 configuration not found' });

test('#1025 已 Approve 路径:CodeQL neutral 不挂 review:merge-ready(摘掉已有的),不标 retry;review-pr 仍写 success', () => {
  const env = setup({ verified: true, preMerge: { ...PASS_GATES, codeScanning: scanning([NEUTRAL]) } });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    const calls = gh.calls();
    assert.equal(addedLabel(calls), false);
    assert.ok(removedLabel(calls));
    assert.equal(result.outcome, 'review-only');
    assert.deepEqual(result.mivo.labelWithheld.map((b) => b.code), ['code-scanning-neutral']);
    assert.match(result.mivo.labelWithheld[0].reason, /1 configuration not found/);
    assert.ok(result.warnings.some((w) => /review:merge-ready 没挂.*1 configuration not found/.test(w)));
    assert.notEqual(result.retry, true, '要人重跑 CodeQL:标 retry 会让 Mini 每轮重新派发,dailyCap 很快用完');
    assert.equal(checkBodies(calls).at(-1).conclusion, 'success', 'review-pr 代表审查结论,这次不动');
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('已 Approve 路径:CodeQL success 照常挂;分支不受代码扫描规则约束(功能分支)不受影响', () => {
  for (const [name, codeScanning] of [['success', scanning([codeql()])], ['不受约束', scanning([], [])]]) {
    const env = setup({ verified: true, preMerge: { ...PASS_GATES, codeScanning } });
    const gh = fakeGh(env.work);
    try {
      const result = publish(env, gh);
      assert.ok(addedLabel(gh.calls()), name);
      assert.equal(result.mivo.labelWithheld, undefined, name);
    } finally { rmSync(env.root, { recursive: true, force: true }); }
  }
});

test('已 Approve 路径:CodeQL 进行中 / 读不到规则 / failure / 回执没有 codeScanning:都不挂,都不标 retry(靠 mivo.codeScan 三态让 Mini 唤醒)', () => {
  const running = codeql({ status: 'in_progress', conclusion: null, completedAt: null });
  for (const [name, codeScanning, code] of [
    ['进行中', scanning([running]), 'code-scanning-pending'],
    ['规则读不到', { rules: null, rulesError: 'HTTP 502', checks: [codeql()] }, 'code-scanning-unverified'],
    ['failure', scanning([codeql({ conclusion: 'failure', title: '2 new alerts' })]), 'code-scanning-failed'],
    ['没有字段', undefined, 'code-scanning-not-reported'],
  ]) {
    const { codeScanning: _drop, ...rest } = PASS_GATES;
    const env = setup({ verified: true, preMerge: codeScanning === undefined ? rest : { ...rest, codeScanning } });
    const gh = fakeGh(env.work);
    try {
      const result = publish(env, gh);
      assert.equal(addedLabel(gh.calls()), false, name);
      assert.deepEqual(result.mivo.labelWithheld.map((b) => b.code), [code], name);
      assert.notEqual(result.retry, true, `${name}:代码扫描门不标 retry`);
    } finally { rmSync(env.root, { recursive: true, force: true }); }
  }
});

test('作者自批路径:CodeQL neutral 走 advisory——不发干净报告标记、不挂标签、check 留在进行中,原因写进待办', () => {
  const env = setup({ failures: [AUTHOR], preMerge: { ...PASS_GATES, codeScanning: scanning([NEUTRAL]) } });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    const calls = gh.calls();
    assert.equal(addedLabel(calls), false);
    assert.ok(removedLabel(calls));
    assert.equal(result.outcome, 'merge-blocked');
    assert.equal(result.reviewClean, false);
    assert.match(result.mivo.advisory.blockers.join(';'), /代码扫描\(CodeQL\).*1 configuration not found/);
    assert.notEqual(result.retry, true);
    const comments = reportComments(calls);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, new RegExp(`<!-- mivo-review:advisory head=${SHA} -->$`));
    assert.doesNotMatch(comments[0].body, /mivo-review:report/);
    assert.equal(checkBodies(calls).at(-1).conclusion, undefined);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('作者自批路径:CodeQL success 照常发报告评论、挂标签、写 success', () => {
  const env = setup({ failures: [AUTHOR], preMerge: { ...PASS_GATES, codeScanning: scanning([codeql()]) } });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh);
    assert.equal(result.outcome, 'approval');
    assert.ok(addedLabel(gh.calls()));
    assert.equal(checkBodies(gh.calls()).at(-1).conclusion, 'success');
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

// 代码扫描三态随结果回传:Mini 用它做唤醒基线——CodeQL 在 success / neutral 之间变化不改 PR 指纹(ci 是聚合状态),没有它已挂的标签不会被摘,修好的 PR 也停在原地。
test('服务器结果带 mivo.codeScan 三态:已 Approve 路径与作者自批路径都记;不受约束不记', () => {
  const running = codeql({ status: 'in_progress', conclusion: null, completedAt: null });
  for (const [name, options, checks, expected] of [
    ['已 Approve / success', { verified: true }, [codeql()], { required: true, state: 'pass' }],
    ['已 Approve / neutral', { verified: true }, [NEUTRAL], { required: true, state: 'fail' }],
    ['已 Approve / 进行中', { verified: true }, [running], { required: true, state: 'transient' }],
    ['作者自批 / success', { failures: [AUTHOR] }, [codeql()], { required: true, state: 'pass' }],
    ['作者自批 / neutral(advisory)', { failures: [AUTHOR] }, [NEUTRAL], { required: true, state: 'fail' }],
  ]) {
    const env = setup({ ...options, preMerge: { ...PASS_GATES, codeScanning: scanning(checks) } });
    const gh = fakeGh(env.work);
    try { assert.deepEqual(publish(env, gh).mivo.codeScan, expected, name); } finally { rmSync(env.root, { recursive: true, force: true }); }
  }
  for (const options of [{ verified: true }, { failures: [AUTHOR] }]) {
    const env = setup({ ...options, preMerge: { ...PASS_GATES, codeScanning: scanning([], []) } });
    const gh = fakeGh(env.work);
    try { assert.equal(publish(env, gh).mivo.codeScan, undefined); } finally { rmSync(env.root, { recursive: true, force: true }); }
  }
});
