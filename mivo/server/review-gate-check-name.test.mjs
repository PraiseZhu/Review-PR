// [MIVO-PATCH gate-bases] 服务器写的检查名按目标分支取:门禁分支(integration/*)写 review-pr (integration),其余写 review-pr。
// 这里跑真实的 review.mjs publish(最小复制根 + PATH 上的 gh 替身,记录每个请求的 body.name),逐条写检查的路径验证;
// prepare 的创建路径用真实函数源码在 vm 里执行。目标分支取不到时不写检查并记原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(SERVER_DIR, '..', 'lib');
const SCRIPTS = join(SERVER_DIR, '..', '..', 'review-pr', 'scripts');
const SHA = 'a'.repeat(40);
const GATE = 'review-pr (integration)';
const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'pass —— 没有 P0/P1/P2。'].join('\n');
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');
const AUTHOR = { code: 'independent-approval-required', reason: '当前 viewer 是 PR 作者，未核验到另一位维护者的有效 Approve，不能自批' };
const THREADS = { code: 'threads-unresolved', reason: '仍有 conversation 未 resolve' };
const PASS_GATES = { ok: true, headVerified: true, baseVerified: true, threadsVerified: true, unresolvedThreads: [], ci: { status: 'pass' },
  mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE', canMerge: false, codeScanning: { rules: [], rulesError: null, checks: [] } };

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mivo-gate-check-name-'));
  for (const dir of [['mivo', 'lib'], ['mivo', 'server'], ['mivo', 'config'], ['review-pr', 'scripts', 'vendor'], ['review-pr', 'config']]) mkdirSync(join(root, ...dir), { recursive: true });
  for (const file of readdirSync(LIB_DIR).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) copyFileSync(join(LIB_DIR, file), join(root, 'mivo', 'lib', file));
  for (const file of ['review.mjs', 'codex.mjs', 'keys.mjs']) copyFileSync(join(SERVER_DIR, file), join(root, 'mivo', 'server', file));
  copyFileSync(join(LIB_DIR, '..', 'config', 'severity.md'), join(root, 'mivo', 'config', 'severity.md'));
  for (const file of ['self-write-receipts.mjs', 'gh-read-route.mjs', 'gate-bases.mjs']) copyFileSync(join(SCRIPTS, file), join(root, 'review-pr', 'scripts', file));
  copyFileSync(join(SCRIPTS, 'vendor', 'gh-app-classify.mjs'), join(root, 'review-pr', 'scripts', 'vendor', 'gh-app-classify.mjs'));
  copyFileSync(join(SCRIPTS, '..', 'config', 'pr-rules.json'), join(root, 'review-pr', 'config', 'pr-rules.json'));
  writeFileSync(join(root, 'review-pr', 'scripts', 'finish-reviewed-pr.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
const out = JSON.parse(readFileSync(process.env.STUB_FINISH, 'utf8'));
writeFileSync(process.argv[process.argv.indexOf('--result-file') + 1], JSON.stringify(out));
console.log(JSON.stringify(out));
`);
  writeFileSync(join(root, 'review-pr', 'scripts', 'pre-merge-check.mjs'), `import { readFileSync } from 'node:fs';
console.log(readFileSync(process.env.STUB_PREMERGE, 'utf8'));
process.exit(2);
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
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input, cwd: process.cwd() }) + '\\n');
if (args.includes('--paginate')) { process.stdout.write('[[]]'); process.exit(0); }
if (args.includes('DELETE')) { process.stderr.write('HTTP 404 Label does not exist'); process.exit(1); }
if (args.length === 4 && args[0] === 'api' && args[1] === '--method' && args[2] === 'GET' && args[3] === 'repos/o/r/pulls/7') {
  if (!process.env.GB_BASE_REF) { process.stderr.write('HTTP 404'); process.exit(1); }
  if (process.env.GB_BASE_REF === 'BADJSON') { process.stdout.write('<html>'); process.exit(0); }
  process.stdout.write(JSON.stringify({ base: { ref: process.env.GB_BASE_REF } })); process.exit(0);
}
if (args.length === 2 && args[0] === 'api' && args[1] === 'repos/o/r/pulls/7') { process.stdout.write(JSON.stringify({ head: { sha: ${JSON.stringify(SHA)} }, labels: [], updated_at: new Date(Date.now() - 1000).toISOString() })); process.exit(0); }
process.stdout.write(JSON.stringify({ id: 5, updated_at: new Date().toISOString() }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

// 检查写入:POST/PATCH repos/o/r/check-runs[/id],返回 [{ method, path, name, status, conclusion }]
const checkWrites = (calls) => calls.filter((c) => c.args.some((a) => /^repos\/o\/r\/check-runs/.test(a))).map((c) => {
  const body = JSON.parse(c.input);
  return { method: c.args.includes('PATCH') ? 'PATCH' : 'POST', name: body.name, status: body.status, conclusion: body.conclusion };
});

function setup({ baseRefName = 'integration/a', input: inputPatch = {}, state: statePatch = {}, withContext = true, answer = true, repoDir = true,
  failures, verified = false, exempt = false, premerge = PASS_GATES } = {}) {
  const root = makeRoot();
  const work = join(root, 'work');
  for (const dir of ['input', 'out', ...(repoDir ? ['repo'] : [])]) mkdirSync(join(work, dir), { recursive: true });
  writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
  writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: SHA, base: SHA, tier: 'standard', prevRunId: '',
    roundId: 'round-12345678', attempt: 1, mode: 'live', action: 'review', skillSha: SHA, runId: '42', runUrl: '', ...inputPatch };
  const context = { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
    evidence: { head: SHA, base: SHA, baseRefName, diffHash: 'd1' }, baseRefName, viewerIsAuthor: !verified, protectedFiles: true };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
    lockToken: 'lock-token', authorityDigest: 'digest', ...(withContext ? { context } : {}),
    current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
    scope: { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] }, checkRunId: 99, pendingGates: [],
    deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] }, ...statePatch }));
  if (answer) writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: REPORT, findings: [] }));
  const approval = { status: 'blocked', code: AUTHOR.code, reason: (failures ?? [AUTHOR]).map((f) => f.reason).join('; ') };
  const approvalResult = { ok: true, pr: 7, approved: false, approval, retry: false,
    failedChecks: (failures ?? [AUTHOR]).map((f) => f.reason), reason: approval.reason, ...(failures ? { failures } : {}) };
  const verifiedApproval = { status: 'verified', reviewId: '9', reviewer: 'reviewer-bot', head: SHA, verifiedAt: new Date().toISOString() };
  const exemptApproval = { status: 'exempt', author: 'praisezhu', head: SHA, authorityDigest: `sha256:${'a'.repeat(64)}`,
    source: 'maintainer-allowlist', reason: '按维护者决定免另一位维护者独立 Approve' };
  const receipt = exempt
    ? { stage: 'reviewed-only', ok: true, approval: exemptApproval, approvalResult: { ok: true, approved: false, approval: exemptApproval }, preMerge: premerge, retry: false }
    : verified
    ? { stage: 'reviewed-only', ok: true, approval: verifiedApproval, approvalResult: { ok: true, approved: true, approval: verifiedApproval }, preMerge: premerge, retry: false }
    : { stage: 'approval-blocked', ok: true, reason: approval.reason, approval, approvalResult, retry: false };
  writeFileSync(join(work, 'finish-stub.json'), JSON.stringify(receipt));
  writeFileSync(join(work, 'premerge-stub.json'), JSON.stringify(premerge));
  return { root, work };
}

function publish({ root, work }, gh, extraEnv = {}) {
  const env = { ...process.env, MIVO_REVIEW_WORK: work, STUB_FINISH: join(work, 'finish-stub.json'), STUB_PREMERGE: join(work, 'premerge-stub.json'),
    GH_TOKEN: 'x', CHECKS_TOKEN: 'y', PATH: `${gh.bin}${delimiter}${process.env.PATH}`, ...extraEnv };
  delete env.MIVO_REVIEW_RULES_FILE;
  const r = spawnSync(process.execPath, [join(root, 'mivo', 'server', 'review.mjs'), 'publish'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
}

// 每个写检查的路径:名字 → 驱动方式。bases 的期望名由 expectName 计算。
const PATHS = [
  ['受保护路径作者为维护者自动放行(完成,POST)', { state: { protectedApproval: { by: 'kirozeng', via: 'author-maintainer', at: null, fingerprint: 'fp' } }, input: { action: 'protected-approve' } }, 'success'],
  ['受保护路径人工放行(完成,POST)', { state: { protectedApproval: { by: 'kirozeng', via: 'github-approve', at: null, fingerprint: 'fp' } }, input: { action: 'protected-approve' } }, 'success'],
  ['两次未完成 done-early(failure,有 context)', { input: { attempt: 2 }, state: { phase: 'done-early', early: { outcome: 'error', reason: 'x', retry: true } } }, 'failure'],
  ['收口待补(进行中,PATCH)', { state: { finalFull: { outcome: 'pending-budget' } } }, null],
  ['审查推迟(进行中,PATCH)', { state: { healthHold: { reason: '维护窗口', health: { window: 'closed' } } } }, null],
  ['模型无答卷,第 1 次(进行中)', { answer: false, state: { codex: { attempts: [{ ok: false, error: 'boom' }] } } }, null],
  ['模型无答卷,第 2 次(failure)', { answer: false, input: { attempt: 2 }, state: { codex: { attempts: [{ ok: false, error: 'boom' }] } } }, 'failure'],
  ['reviewed-only + 已核验 Approve(success)', { verified: true }, 'success'],
  ['reviewed-only + 豁免(success)', { exempt: true }, 'success'],
  ['作者自批是唯一拦截项(success)', { failures: [AUTHOR] }, 'success'],
  ['审批被其它项拦住(PATCH)', { failures: [THREADS] }, null],
  ['前置门未过的 advisory(进行中)', { failures: [AUTHOR, THREADS] }, null],
];

for (const [label, options, conclusion] of PATHS) {
  test(`检查名:${label}`, () => {
    for (const [base, expected] of [['main', 'review-pr'], ['release/1.2', 'review-pr'], ['integration/a', GATE], ['integration/a/b', 'review-pr']]) {
      const env = setup({ ...options, baseRefName: base });
      const gh = fakeGh(env.work);
      try {
        publish(env, gh);
        const writes = checkWrites(gh.calls());
        assert.ok(writes.length >= 1, `${base} 应该写了检查`);
        for (const write of writes) assert.equal(write.name, expected, `${label} @ ${base}`);
        if (conclusion) assert.equal(writes.at(-1).conclusion, conclusion, `${label} 的 conclusion`);
        assert.ok(!gh.calls().some((c) => c.args.includes('GET') && c.args.includes('repos/o/r/pulls/7') && c.args.length === 4), '已有 context 不再多读 PR');
      } finally { rmSync(env.root, { recursive: true, force: true }); }
    }
  });
}

test('检查名:没有 context 且没有 repo 目录时,从 WORK 目录读 PR 的 base.ref 再取名', () => {
  for (const [ref, expected] of [['integration/a', GATE], ['main', 'review-pr'], ['integration/a/b', 'review-pr']]) {
    const env = setup({ withContext: false, repoDir: false, input: { attempt: 2 }, state: { phase: 'done-early', early: { outcome: 'error', reason: 'x', retry: true } } });
    const gh = fakeGh(env.work);
    try {
      const result = publish(env, gh, { GB_BASE_REF: ref });
      const writes = checkWrites(gh.calls());
      assert.deepEqual(writes.map((w) => [w.name, w.conclusion]), [[expected, 'failure']], ref);
      const read = gh.calls().filter((c) => c.args.includes('GET') && c.args.at(-1) === 'repos/o/r/pulls/7');
      assert.equal(read.length, 1, '只读一次 base');
      assert.equal(realpathSync(read[0].cwd), realpathSync(env.work), '用 WORK 目录而不是不存在的 repo 目录');
      assert.equal(result.mivo.checkRun.ok, true);
    } finally { rmSync(env.root, { recursive: true, force: true }); }
  }
});

test('检查名:base 取不到(空、失败、坏 JSON)时不写检查,结果记 base-unknown', () => {
  for (const ref of ['', 'BADJSON']) {
    const env = setup({ withContext: false, repoDir: false, input: { action: 'protected-approve' },
      state: { protectedApproval: { by: 'kirozeng', via: 'github-approve', at: null, fingerprint: 'fp' } } });
    const gh = fakeGh(env.work);
    try {
      const result = publish(env, gh, { GB_BASE_REF: ref });
      assert.deepEqual(checkWrites(gh.calls()), [], `ref=${ref || '失败'}`);
      assert.deepEqual(result.mivo.checkRun, { skipped: true, reason: 'base-unknown' });
    } finally { rmSync(env.root, { recursive: true, force: true }); }
  }
});

test('检查名:publish 以 state.context 为准,不被 prepare 缓存的旧检查名带偏', () => {
  const env = setup({ baseRefName: 'integration/a', input: { checkName: 'review-pr', action: 'protected-approve' },
    state: { protectedApproval: { by: 'kirozeng', via: 'github-approve', at: null, fingerprint: 'fp' } } });
  const gh = fakeGh(env.work);
  try {
    publish(env, gh);
    assert.deepEqual(checkWrites(gh.calls()).map((w) => w.name), [GATE]);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('检查名:dry-run 与沙箱镜像不写直连检查,也不为命名多读 PR', () => {
  const env = setup({ withContext: false, input: { mode: 'dry-run', action: 'protected-approve' },
    state: { protectedApproval: { by: 'kirozeng', via: 'github-approve', at: null, fingerprint: 'fp' } } });
  const gh = fakeGh(env.work);
  try {
    publish(env, gh, { GB_BASE_REF: 'integration/a' });
    assert.deepEqual(gh.calls().filter((c) => c.args.at(-1) === 'repos/o/r/pulls/7'), []);
    assert.deepEqual(checkWrites(gh.calls()), []);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

// prepare 的创建路径:真实的 checkNameForInput / createCheckRun / completeCheckRun 源码放进 vm,
// 注入记录请求的 run / gh,验证 POST body.name、取不到 base 的跳过原因,以及 create 返回 null 时记下原因。
function loadCheckFunctions({ baseRef, gateBases = ['integration/*'], token = 'y' }) {
  const source = readFileSync(join(SERVER_DIR, 'review.mjs'), 'utf8');
  const start = source.indexOf('// [MIVO-PATCH gate-bases] 检查名解析');
  const end = source.indexOf('// 派发沙箱仓的检查镜像要审查账号身份');
  assert.ok(start > 0 && end > start, '找不到检查函数源码');
  const posts = [];
  const checkNameFor = (name, list) => (list.some((p) => new RegExp(`^${p.replace('*', '[^/]*')}$`).test(name)) ? GATE : 'review-pr');
  const context = {
    WORK: '/work', process: { env: { CHECKS_TOKEN: token } }, JSON, nowIso: () => 'now',
    checkTarget: () => 'direct', dispatchSandboxCheck: () => ({ ok: true }), gateBases: () => gateBases, checkNameFor,
    gh: (args, options) => { posts.push({ gh: args, cwd: options.cwd }); return baseRef ? { ok: true, stdout: JSON.stringify({ base: { ref: baseRef } }) } : { ok: false, stdout: '', stderr: 'HTTP 404' }; },
    run: (cmd, args, options) => { posts.push({ run: args, body: JSON.parse(options.input) }); return { ok: true, stdout: JSON.stringify({ id: 5 }) }; },
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.fns = { createCheckRun, completeCheckRun, checkNameForInput };`, context);
  return { ...context.fns, posts };
}

test('检查名:prepare 创建检查时按 context 的 base 取名;取不到 base 返回 null 并留下原因', () => {
  const input = { targetRepo: 'o/r', pr: 7, head: SHA, runUrl: '', checkName: GATE };
  const known = loadCheckFunctions({ baseRef: null });
  known.createCheckRun(input, { status: 'in_progress', title: 't', summary: 's' });
  assert.equal(known.posts.at(-1).body.name, GATE);
  assert.equal(known.posts.filter((p) => p.gh).length, 0, '已有检查名不读 PR');
  const unknown = loadCheckFunctions({ baseRef: null });
  const bare = { targetRepo: 'o/r', pr: 7, head: SHA, runUrl: '' };
  assert.equal(unknown.createCheckRun(bare, { status: 'in_progress', title: 't', summary: 's' }), null);
  assert.equal(bare.checkNameUnavailable, 'base-unknown');
  assert.equal(unknown.posts.filter((p) => p.body).length, 0);
  assert.equal(JSON.stringify(unknown.completeCheckRun(bare, null, { conclusion: 'failure', title: 't', summary: 's' })), JSON.stringify({ skipped: true, reason: 'base-unknown' }));
  assert.equal(unknown.posts.filter((p) => p.gh).length, 1, '失败后不重复读');
  const rest = loadCheckFunctions({ baseRef: 'integration/a' });
  const viaRest = { targetRepo: 'o/r', pr: 7, head: SHA, runUrl: '' };
  rest.createCheckRun(viaRest, { status: 'in_progress', title: 't', summary: 's' });
  assert.equal(rest.posts.at(-1).body.name, GATE);
  assert.equal(rest.posts.find((p) => p.gh).cwd, '/work');
});

test('检查名:prepare 先按 context 定名再创建检查,未知原因写进 warnings;所有检查写入都经 createCheckRun/completeCheckRun', () => {
  const source = readFileSync(join(SERVER_DIR, 'review.mjs'), 'utf8');
  const prepare = source.slice(source.indexOf("if (checkTarget(input) === 'direct') {"), source.indexOf("if (checkTarget(input) === 'sandbox-mirror') {\n      const mirrored"));
  assert.ok(prepare.indexOf('input.checkName = checkNameFor(ctx.meta.baseRefName, gateBases())') < prepare.indexOf('createCheckRun(input, pendingCheck)'));
  assert.match(prepare, /input\.checkNameUnavailable\) state\.warnings\.push/);
  assert.equal(source.match(/\/check-runs/g).length, 3, '只有创建、完成(带 id / 不带 id)的路径拼接');
  assert.doesNotMatch(source, /CHECK_NAME/);
  assert.equal(source.match(/completeCheckRun\(/g).length, 14, '13 个调用点 + 函数定义');
});
