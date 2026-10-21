// publish 之后代 resolve 旧 thread 的编排契约(Review-PR #115):什么时候调用 runner、传什么、失败怎么办。
// runner 用替身(记录 stdin 请求、回放预设回执);runner 自己和真实 resolve-threads.mjs 的行为见 lib/resolve-fixed-threads.test.mjs。
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
const OLD = '1'.repeat(12);
const KEY = '123456789abc';
const RUN_URL = 'https://github.com/o/r/actions/runs/42';
const REVIEWER = 'reviewer-bot';
const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'pass —— 没有 P0/P1/P2。'].join('\n');
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');
const AUTHOR = { code: 'independent-approval-required', reason: '当前 viewer 是 PR 作者，未核验到另一位维护者的有效 Approve，不能自批' };
const THREADS = { code: 'threads-unresolved', reason: '仍有 conversation 未 resolve' };
const PASS_GATES = { ok: true, headVerified: true, baseVerified: true, threadsVerified: true, unresolvedThreads: [], ci: { status: 'pass' },
  mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE', canMerge: false, codeScanning: { rules: [], rulesError: null, checks: [] } };

const oldThread = (patch = {}) => ({ id: 'PRRT_1', isResolved: false, path: 'src/a.ts',
  comments: [{ id: 'c1', author: { login: REVIEWER }, body: `[P1] 旧问题\n\n<!-- mivo-finding key=${KEY} round=1 head=${OLD} -->` }], ...patch });

function makeRoot({ runnerSummary }) {
  const root = mkdtempSync(join(tmpdir(), 'mivo-resolve-publish-'));
  for (const dir of [['mivo', 'lib'], ['mivo', 'server'], ['review-pr', 'scripts', 'vendor']]) mkdirSync(join(root, ...dir), { recursive: true });
  for (const file of readdirSync(LIB_DIR).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) copyFileSync(join(LIB_DIR, file), join(root, 'mivo', 'lib', file));
  for (const file of ['review.mjs', 'codex.mjs', 'keys.mjs']) copyFileSync(join(SERVER_DIR, file), join(root, 'mivo', 'server', file));
  const scripts = join(SERVER_DIR, '..', '..', 'review-pr', 'scripts');
  for (const file of ['self-write-receipts.mjs', 'gh-read-route.mjs']) copyFileSync(join(scripts, file), join(root, 'review-pr', 'scripts', file));
  copyFileSync(join(scripts, 'vendor', 'gh-app-classify.mjs'), join(root, 'review-pr', 'scripts', 'vendor', 'gh-app-classify.mjs'));
  writeFileSync(join(root, 'review-pr', 'scripts', 'finish-reviewed-pr.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
const out = JSON.parse(readFileSync(process.env.STUB_FINISH, 'utf8'));
writeFileSync(process.argv[process.argv.indexOf('--result-file') + 1], JSON.stringify(out));
console.log(JSON.stringify(out));
`);
  writeFileSync(join(root, 'review-pr', 'scripts', 'pre-merge-check.mjs'), `console.log(JSON.stringify(${JSON.stringify(PASS_GATES)})); process.exit(2);\n`);
  // runner 替身:把 stdin 请求原样记下来,回放预设回执(或按 runnerSummary 为 'CRASH' 时返回非 JSON)
  writeFileSync(join(root, 'mivo', 'lib', 'resolve-fixed-threads.mjs'), `import { readFileSync, appendFileSync } from 'node:fs';
appendFileSync(process.env.STUB_RUNNER_LOG, readFileSync(0, 'utf8') + '\\n');
if (${JSON.stringify(runnerSummary)} === 'CRASH') { console.error('boom'); process.exit(1); }
console.log(JSON.stringify(${JSON.stringify(runnerSummary)}));
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
if (args.includes('DELETE')) { process.stderr.write('HTTP 404'); process.exit(1); }
if (args.length === 2 && args[0] === 'api' && args[1] === 'repos/o/r/pulls/7') { process.stdout.write(JSON.stringify({ head: { sha: ${JSON.stringify(SHA)} }, labels: [], updated_at: new Date(Date.now() - 1000).toISOString() })); process.exit(0); }
process.stdout.write(JSON.stringify({ id: 5, updated_at: new Date().toISOString() }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin };
}

// 默认场景:作者是审查账号 + 还有未 resolve 的讨论 → 走 advisory 评论(本轮新发的报告评论,id=5)。
function setup({ threads = [oldThread()], mode = 'live', scopeMode = 'full', runnerSummary = { ok: true, status: 'completed', plannedCount: 1, resolvedCount: 1, alreadyResolvedCount: 0, items: [{ id: 'PRRT_1', key: KEY, status: 'resolved' }], warnings: [] },
  receipt = null, pendingGates = [] } = {}) {
  const root = makeRoot({ runnerSummary });
  const work = join(root, 'work');
  for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
  writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {}, approvalPolicy: { viewer: REVIEWER }, history: { reviewThreads: threads } }));
  writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: SHA, base: SHA, tier: 'standard', prevRunId: '',
    roundId: 'round-12345678', attempt: 1, mode, action: 'review', skillSha: SHA, runId: '42', runUrl: RUN_URL };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
    lockToken: 'lock-token', authorityDigest: 'digest',
    context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7', viewer: REVIEWER,
      evidence: { head: SHA, base: SHA, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: true },
    current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
    scope: { mode: scopeMode, reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] }, checkRunId: 99, pendingGates,
    deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] } }));
  writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: REPORT, findings: [] }));
  const approval = { status: 'blocked', code: AUTHOR.code, reason: [AUTHOR, THREADS].map((f) => f.reason).join('; ') };
  const finish = receipt ?? { stage: 'approval-blocked', ok: true, reason: approval.reason, approval, retry: false,
    approvalResult: { ok: true, pr: 7, approved: false, approval, retry: false, failedChecks: [AUTHOR.reason, THREADS.reason], reason: approval.reason, failures: [AUTHOR, THREADS] } };
  writeFileSync(join(work, 'finish-stub.json'), JSON.stringify(finish));
  return { root, work };
}

function publish({ root, work }, gh) {
  const env = { ...process.env, MIVO_REVIEW_WORK: work, STUB_FINISH: join(work, 'finish-stub.json'), STUB_RUNNER_LOG: join(work, 'runner-calls.jsonl'),
    GH_TOKEN: 'x', CHECKS_TOKEN: 'y', PATH: `${gh.bin}${delimiter}${process.env.PATH}` };
  const r = spawnSync(process.execPath, [join(root, 'mivo', 'server', 'review.mjs'), 'publish'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const log = join(work, 'runner-calls.jsonl');
  return { result: JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8')),
    runnerCalls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [] };
}

const run = (options, check) => {
  const env = setup(options);
  try { check(publish(env, fakeGh(env.work))); } finally { rmSync(env.root, { recursive: true, force: true }); }
};

test('SC1/SC4 本轮结论(报告评论)已发布 → 调用 runner,请求带绑定、排除集合与 prepare 快照路径', () => {
  run({}, ({ result, runnerCalls }) => {
    assert.equal(result.outcome, 'merge-blocked');
    assert.equal(runnerCalls.length, 1);
    const [request] = runnerCalls;
    assert.equal(request.binding.head, SHA);
    assert.equal(request.binding.reviewer, REVIEWER);
    assert.equal(request.binding.lockToken, 'lock-token');
    assert.equal(request.binding.authorityDigest, 'digest');
    assert.equal(request.binding.runUrl, RUN_URL);
    assert.equal(request.binding.mode, 'live');
    assert.equal(request.round.scopeMode, 'full');
    assert.equal(request.round.sourceComplete, true);
    assert.equal(request.round.published, true);
    assert.deepEqual(request.excludedKeys, []);
    assert.match(request.contextFile, /context\.json$/);
    assert.equal(result.mivo.threadResolution.resolvedCount, 1);
    assert.ok(!JSON.stringify(request).includes('"x"'), '令牌不进请求');
  });
});

test('SC4 代 resolve 不改本轮结论:outcome / reviewClean / approval / retry / errors 与不调 runner 时一致', () => {
  let withRunner;
  run({}, ({ result }) => { withRunner = result; });
  run({ threads: [] }, ({ result, runnerCalls }) => {
    assert.equal(runnerCalls.length, 0);
    for (const field of ['outcome', 'reason', 'reviewClean', 'retry']) assert.deepEqual(withRunner[field], result[field], field);
    assert.deepEqual(withRunner.approval, result.approval);
    assert.deepEqual(withRunner.errors, result.errors);
  });
});

test('SC4 dry-run:不调用 runner', () => {
  run({ mode: 'dry-run' }, ({ runnerCalls }) => assert.equal(runnerCalls.length, 0));
});

test('没有旧 thread 候选(prepare 快照里没有 / 已 resolve / 别人发的 / 当前 head 上发的)→ 不调用 runner', () => {
  const other = oldThread(); other.comments[0].author.login = 'someone';
  const resolved = oldThread({ isResolved: true });
  const sameHead = oldThread(); sameHead.comments[0].body = `[P1] x\n\n<!-- mivo-finding key=${KEY} round=1 head=${SHA.slice(0, 12)} -->`;
  run({ threads: [] }, ({ runnerCalls }) => assert.equal(runnerCalls.length, 0));
  run({ threads: [other, resolved, sameHead] }, ({ runnerCalls }) => assert.equal(runnerCalls.length, 0));
});

test('SC4 runner 崩溃 / 返回非 JSON → 只加 warning,本轮结论不变、不进 errors', () => {
  run({ runnerSummary: 'CRASH' }, ({ result, runnerCalls }) => {
    assert.equal(runnerCalls.length, 1);
    assert.equal(result.outcome, 'merge-blocked');
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((w) => w.includes('旧 thread 代 resolve 没有完成')));
    assert.equal(result.mivo.threadResolution.status, 'failed');
  });
});

test('runner 的逐条 warning 进结果 warnings,状态进 mivo.threadResolution', () => {
  const summary = { ok: true, status: 'partial', skippedReason: null, plannedCount: 1, resolvedCount: 0, alreadyResolvedCount: 0,
    items: [{ id: 'PRRT_1', key: KEY, status: 'failed', reason: '回复失败' }], warnings: ['代 resolve 未完成(123456789abc):回复失败'] };
  run({ runnerSummary: summary }, ({ result }) => {
    assert.ok(result.warnings.includes(summary.warnings[0]));
    assert.equal(result.mivo.threadResolution.status, 'partial');
    assert.equal(result.outcome, 'merge-blocked');
  });
});

test('已核验 Approve:只有本轮新提交的(alreadyApproved=false)才算本轮已发布;已有 Approve / 恢复旧写入不调用', () => {
  const approval = { status: 'verified', reviewId: '9', reviewer: REVIEWER, head: SHA, verifiedAt: new Date().toISOString() };
  const receipt = (extra) => ({ stage: 'reviewed-only', ok: true, approval, preMerge: PASS_GATES, retry: false,
    approvalResult: { ok: true, approved: true, approval, ...extra } });
  run({ receipt: receipt({ alreadyApproved: false, reconciled: false }) }, ({ runnerCalls, result }) => {
    assert.equal(result.outcome, 'review-only');
    assert.equal(runnerCalls.length, 1);
  });
  for (const extra of [{ alreadyApproved: true, reconciled: false }, { alreadyApproved: false, reconciled: true }, {}]) {
    run({ receipt: receipt(extra) }, ({ runnerCalls, result }) => {
      assert.equal(result.outcome, 'review-only');
      assert.equal(runnerCalls.length, 0, JSON.stringify(extra));
    });
  }
});
