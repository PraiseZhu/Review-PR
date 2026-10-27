// [MIVO-PATCH gate-bases] 服务器写的检查名按目标分支取:门禁分支(integration/*)写 review-pr (integration),其余写 review-pr。
// 这里跑真实的 review.mjs publish(最小复制根 + PATH 上的 gh 替身,记录每个请求的 body.name),逐条写检查的路径验证;
// prepare 的创建路径用 review.mjs 里的真实源码(prepare 的建检查段 + createCheckRun 等)在 vm 里执行,命名函数用真实的 gate-bases.mjs。目标分支取不到时不写检查并记原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkNameFor } from '../../review-pr/scripts/gate-bases.mjs';
import { checkTarget } from '../lib/checks.mjs';

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
  failures, verified = false, exempt = false, premerge = PASS_GATES, viewerIsAuthor, blockedCode } = {}) {
  const root = makeRoot();
  const work = join(root, 'work');
  for (const dir of ['input', 'out', ...(repoDir ? ['repo'] : [])]) mkdirSync(join(work, dir), { recursive: true });
  writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
  writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: SHA, base: SHA, tier: 'standard', prevRunId: '',
    roundId: 'round-12345678', attempt: 1, mode: 'live', action: 'review', skillSha: SHA, runId: '42', runUrl: '', ...inputPatch };
  const context = { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
    evidence: { head: SHA, base: SHA, baseRefName, diffHash: 'd1' }, baseRefName, viewerIsAuthor: viewerIsAuthor ?? !verified, protectedFiles: true };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
    lockToken: 'lock-token', authorityDigest: 'digest', ...(withContext ? { context } : {}),
    current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
    scope: { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] }, checkRunId: 99, pendingGates: [],
    deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] }, ...statePatch }));
  if (answer) writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: REPORT, findings: [] }));
  const approval = { status: 'blocked', code: blockedCode ?? AUTHOR.code, reason: (failures ?? [AUTHOR]).map((f) => f.reason).join('; ') };
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
  // viewer 不是作者、Approve 被非"自批"原因拦住:走 publishClean 末尾 `approval.status === 'blocked'` 且未 headMoved 那一处(原先没有用例到达)。
  ['Approve 被非自批原因拦住且 viewer 不是作者(success)', { failures: [THREADS], viewerIsAuthor: false, blockedCode: THREADS.code }, 'success'],
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

test('检查名:dry-run 不写直连检查,也不为命名多读 PR', () => {
  const env = setup({ withContext: false, input: { mode: 'dry-run', action: 'protected-approve' },
    state: { protectedApproval: { by: 'kirozeng', via: 'github-approve', at: null, fingerprint: 'fp' } } });
  const gh = fakeGh(env.work);
  try {
    publish(env, gh, { GB_BASE_REF: 'integration/a' });
    assert.deepEqual(gh.calls().filter((c) => c.args.at(-1) === 'repos/o/r/pulls/7'), []);
    assert.deepEqual(checkWrites(gh.calls()), []);
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

// 沙箱镜像:mode=sandbox 且审查对象不是本仓。走受保护路径放行的 publish,不写直连检查、不为命名读 PR,改为派发沙箱仓的检查镜像 workflow。
test('检查名:沙箱镜像不写直连检查、不读 PR,只派发沙箱仓的检查镜像', () => {
  const env = setup({ withContext: false, input: { mode: 'sandbox', targetRepo: 'o/sbx', workflowRepo: 'o/r', action: 'protected-approve' },
    state: { protectedApproval: { by: 'kirozeng', via: 'github-approve', at: null, fingerprint: 'fp' } } });
  const gh = fakeGh(env.work);
  try {
    const result = publish(env, gh, { GB_BASE_REF: 'integration/a' });
    const calls = gh.calls();
    assert.deepEqual(checkWrites(calls), [], '没有任何 check-runs 的 POST/PATCH');
    assert.deepEqual(calls.filter((c) => c.args.some((a) => /\/check-runs/.test(a))), []);
    assert.deepEqual(calls.filter((c) => c.args.some((a) => /pulls\/7$/.test(a))), [], '不为命名读 PR');
    const dispatch = calls.filter((c) => c.args[0] === 'workflow' && c.args[1] === 'run' && c.args[2] === 'review-pr.yml');
    assert.equal(dispatch.length, 1, '派发一次检查镜像');
    assert.deepEqual(dispatch[0].args.slice(3, 5), ['-R', 'o/sbx']);
    assert.ok(dispatch[0].args.includes('conclusion=success'));
    assert.deepEqual(result.mivo.checkRun, { ok: true, mirrored: true });
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

// ── publishFindings / publishOverruled 的写检查路径(真实 publish)─────────────────────────────────────
const BASES = [['main', 'review-pr'], ['release/1.2', 'review-pr'], ['integration/a', GATE], ['integration/a/b', 'review-pr']];
const FINDING = { severity: 'P1', title: '空指针', trigger: '未登录', behavior: '抛错', impact: '白屏', fix: '判空', verify: '补测',
  evidence: [{ path: 'src/a.ts', line: 2 }], origin: 'introduced', bugClass: 'null-deref', instances: [], supersedes: null,
  path: 'src/a.ts', line: 2, side: 'RIGHT', deferredTo: null };
const OLD_FINDING = { path: 'src/a.ts', line: 2, side: 'RIGHT', body: '[P1] 旧问题\n细节', key: 'aaaaaaaaaaaa', uid: 'u1', severity: 'P1', seenRounds: 1 };
const OLD_REPORT = ['## Findings', '[P1] src/a.ts:2 — 旧问题', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'changes-requested —— 1 条 P0/P1/P2'].join('\n');
const SUBMITTED = { ok: true, submitted: true, reviewId: 77, reviewUrl: 'https://github.com/o/r/pull/7#pullrequestreview-77', action: 'REQUEST_CHANGES', threadUrls: [], alreadySubmitted: false };

// kind: 'submitted'(新发 Request Changes)| 'overruled'(核对员全部推翻)| 'reuse'(沿用上一轮已发的 review)。
function findingsSetup({ baseRefName, kind, verification = null }) {
  const env = setup({ baseRefName });
  const { root, work } = env;
  const statePath = join(work, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.context.viewerIsAuthor = false;
  if (kind === 'reuse') {
    mkdirSync(join(work, 'prev'), { recursive: true });
    state.scope = { mode: 'reuse', reason: '同一版本已审过,沿用上次结论', files: [], previousFindings: [OLD_FINDING], basedOn: SHA };
    state.previous = { head: SHA, runId: '41', lastFullReviewAt: '2026-10-10T12:00:00Z' };
    writeFileSync(join(work, 'prev', 'result.json'), JSON.stringify({ head: SHA, threadUrls: [], reviewEvidence: { diffHash: 'd1', baseRefName },
      mivo: { findings: [OLD_FINDING], deferred: [], review: { id: 3, url: 'https://github.com/o/r/pull/7#pullrequestreview-3', action: 'REQUEST_CHANGES' }, lastFullReviewAt: '2026-10-10T12:00:00Z' } }));
    writeFileSync(join(work, 'prev', 'report.md'), OLD_REPORT);
  } else {
    // 答卷里的问题要在 head 上找得到证据:放一个真实的 git 仓。
    const git = (...args) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', ...args], { cwd: join(work, 'repo'), encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    git('init', '-q');
    mkdirSync(join(work, 'repo', 'src'));
    writeFileSync(join(work, 'repo', 'src', 'a.ts'), 'keep\nadded\n');
    git('add', '.');
    git('commit', '-q', '-m', 'head');
    const head = git('rev-parse', 'HEAD');
    state.input.head = head; state.input.base = head;
    state.context.evidence = { ...state.context.evidence, head, base: head };
    if (verification) state.verification = verification;
    writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: REPORT.replace('无', '见下'), findings: [FINDING] }));
    writeFileSync(join(root, 'review-pr', 'scripts', 'request-changes-reviewed-pr.mjs'), `console.log(JSON.stringify(${JSON.stringify(SUBMITTED)}));\n`);
  }
  writeFileSync(statePath, JSON.stringify(state));
  return env;
}

for (const [label, kind, conclusion, outcome] of [
  ['publishFindings 新发 Request Changes(posted.submitted)', 'submitted', 'failure', 'findings'],
  ['publishFindings 沿用上一轮已发的 review(reusedReview)', 'reuse', 'failure', 'findings'],
]) {
  test(`检查名:${label}按目标分支取名`, () => {
    for (const [base, expected] of BASES) {
      const env = findingsSetup({ baseRefName: base, kind });
      const gh = fakeGh(env.work);
      try {
        const result = publish(env, gh);
        assert.equal(result.outcome, outcome, `${base}: ${JSON.stringify(result.errors)}`);
        const writes = checkWrites(gh.calls());
        assert.ok(writes.length >= 1, `${base} 应该写了检查`);
        for (const write of writes) assert.equal(write.name, expected, `${label} @ ${base}`);
        assert.equal(writes.at(-1).conclusion, conclusion);
        assert.equal(writes.at(-1).method, 'PATCH', '完成已创建的检查(checkRunId=99)');
      } finally { rmSync(env.root, { recursive: true, force: true }); }
    }
  });
}

test('检查名:publishOverruled(核对员全部推翻)按目标分支取名', () => {
  // 第一轮不带核对结论,取出真实流水线给这条问题算的 uid;第二轮带上"推翻"的核对结论。
  const probe = findingsSetup({ baseRefName: 'main', kind: 'overruled' });
  let uid;
  try { uid = publish(probe, fakeGh(probe.work)).mivo.findings[0].uid; } finally { rmSync(probe.root, { recursive: true, force: true }); }
  assert.ok(uid, '拿到 finding 的 uid');
  const verification = { mode: 'enforce', skipped: [], items: [{ key: 'k', uid, ok: true, applied: 'refuted', verdict: 'refuted', severity: 'P1',
    evidence: [{ path: 'src/a.ts', line: 1 }], note: '调用方已判空' }] };
  for (const [base, expected] of BASES) {
    const env = findingsSetup({ baseRefName: base, kind: 'overruled', verification });
    const gh = fakeGh(env.work);
    try {
      const result = publish(env, gh);
      assert.equal(result.mivo.verifierOverruledAll, true, `${base}: 走到 publishOverruled`);
      assert.equal(result.outcome, 'merge-blocked');
      const writes = checkWrites(gh.calls());
      assert.ok(writes.length >= 1, `${base} 应该写了检查`);
      for (const write of writes) assert.equal(write.name, expected, `publishOverruled @ ${base}`);
      assert.equal(writes.at(-1).conclusion, 'success');
    } finally { rmSync(env.root, { recursive: true, force: true }); }
  }
});

// ── prepare 的建检查段:review.mjs 里的真实源码在 vm 里执行 ───────────────────────────────────────────────
// 抽取 prepare 里 `const pendingCheck = …` 到沙箱镜像分支之前那一段,连同真实的 checkNameForInput / createCheckRun / completeCheckRun,
// 命名函数用 import 来的真实 gate-bases.mjs;run 是记录 POST body 的替身,gh 是读 PR base.ref 的替身。
const REVIEW_SOURCE = readFileSync(join(SERVER_DIR, 'review.mjs'), 'utf8');
const PREPARE_ASSIGN = 'input.checkName = checkNameFor(ctx.meta.baseRefName, gateBases());';

function loadPrepare({ source = REVIEW_SOURCE, restBaseRef = null, gateBasesList = ['integration/*'] } = {}) {
  const fnStart = source.indexOf('// [MIVO-PATCH gate-bases] 检查名解析');
  const fnEnd = source.indexOf('// 派发沙箱仓的检查镜像要审查账号身份');
  const prepStart = source.indexOf('const pendingCheck = ');
  const prepEnd = source.indexOf("if (checkTarget(input) === 'sandbox-mirror') {\n      const mirrored");
  assert.ok(fnStart > 0 && fnEnd > fnStart, '找不到检查函数源码');
  assert.ok(prepStart > 0 && prepEnd > prepStart, '找不到 prepare 的建检查段');
  const log = [];
  const sandbox = {
    WORK: '/work', process: { env: { CHECKS_TOKEN: 'y' } }, nowIso: () => 'now',
    checkTarget, checkNameFor, gateBases: () => gateBasesList, dispatchSandboxCheck: () => { throw new Error('direct 模式不该派发镜像'); },
    gh: (args, options) => { log.push({ gh: args, cwd: options.cwd }); return restBaseRef ? { ok: true, stdout: JSON.stringify({ base: { ref: restBaseRef } }) } : { ok: false, stdout: '', stderr: 'HTTP 404' }; },
    run: (cmd, args, options) => { log.push({ run: args, body: JSON.parse(options.input) }); return { ok: true, stdout: JSON.stringify({ id: 5 }) }; },
  };
  vm.runInNewContext(`${source.slice(fnStart, fnEnd)}
    globalThis.fns = { createCheckRun, completeCheckRun,
      prepareCheck(input, state, ctx, scope, tier) {\n${source.slice(prepStart, prepEnd)}\n} };`, sandbox);
  const posts = () => log.filter((entry) => entry.body);
  return { ...sandbox.fns, log, posts };
}

const prepareInput = () => ({ targetRepo: 'o/r', workflowRepo: 'o/r', mode: 'live', pr: 7, head: SHA, runUrl: '' });
const SCOPE = { mode: 'full', reason: '没有上一轮审查记录' };

// 对一份 review.mjs 源码跑 4 个 base 的 prepare 建检查段,返回 [base, 期望名, 实际 POST 名] 里对不上的项。
function prepareNameMismatches(source) {
  const mismatches = [];
  for (const [base, expected] of [['main', 'review-pr'], ['release/1.2', 'review-pr'], ['integration/a', GATE], ['integration/a/b', 'review-pr']]) {
    const h = loadPrepare({ source });
    const state = { warnings: [], checkRunId: null };
    h.prepareCheck(prepareInput(), state, { meta: { baseRefName: base } }, SCOPE, 'standard');
    assert.equal(h.posts().length, 1, base);
    assert.equal(h.posts()[0].body.status, 'in_progress');
    assert.equal(state.checkRunId, 5);
    assert.deepEqual(state.warnings, []);
    assert.equal(h.log.filter((entry) => entry.gh).length, 0, 'context 里有 base 就不再读 PR');
    if (h.posts()[0].body.name !== expected) mismatches.push([base, expected, h.posts()[0].body.name]);
  }
  return mismatches;
}

test('检查名:prepare 的建检查段按 context 的 base 取名(真实源码 + 真实 gate-bases)', () => {
  assert.deepEqual(prepareNameMismatches(REVIEW_SOURCE), []);
});

test('检查名:prepare 的 context 没有 base 时读 PR 的 base.ref;还取不到就不写检查并在 warnings 记 base-unknown', () => {
  const viaRest = loadPrepare({ restBaseRef: 'integration/a' });
  const input = prepareInput();
  viaRest.prepareCheck(input, { warnings: [], checkRunId: null }, { meta: {} }, SCOPE, 'standard');
  assert.equal(viaRest.posts().at(-1).body.name, GATE);
  assert.equal(viaRest.log.find((entry) => entry.gh).cwd, '/work');

  const unknown = loadPrepare({ restBaseRef: null });
  const bare = prepareInput();
  const state = { warnings: [], checkRunId: null };
  unknown.prepareCheck(bare, state, { meta: {} }, SCOPE, 'standard');
  assert.equal(unknown.posts().length, 0, '没有 POST');
  assert.equal(state.checkRunId, null);
  assert.equal(bare.checkNameUnavailable, 'base-unknown');
  assert.ok(state.warnings.some((w) => /base-unknown/.test(w)), JSON.stringify(state.warnings));
  assert.deepEqual(JSON.parse(JSON.stringify(unknown.completeCheckRun(bare, null, { conclusion: 'failure', title: 't', summary: 's' }))), { skipped: true, reason: 'base-unknown' }); // vm 里的对象跨 realm,先过一遍 JSON
  assert.equal(unknown.log.filter((entry) => entry.gh).length, 1, '失败后不重复读');
});

test('检查名(变异守卫):把 prepare 的命名赋值改成固定 review-pr,上面的 prepare 命名测试会失败', () => {
  assert.equal(REVIEW_SOURCE.split(PREPARE_ASSIGN).length - 1, 1, '赋值行在 review.mjs 里恰好出现一次');
  const mutated = REVIEW_SOURCE.replace(PREPARE_ASSIGN, "input.checkName = 'review-pr';");
  assert.notEqual(mutated, REVIEW_SOURCE, '替换必须命中');
  assert.deepEqual(prepareNameMismatches(mutated), [['integration/a', GATE, 'review-pr']], '变异后只有 integration/a 写错,命名测试能看出来');
});

test('检查名:所有检查写入都经 createCheckRun/completeCheckRun,源码里没有旧的固定检查名常量', () => {
  assert.equal(REVIEW_SOURCE.match(/\/check-runs/g).length, 3, '只有创建、完成(带 id / 不带 id)的路径拼接');
  assert.doesNotMatch(REVIEW_SOURCE, /CHECK_NAME/);
  assert.equal(REVIEW_SOURCE.match(/completeCheckRun\(/g).length, 14, '13 个调用点 + 函数定义');
});
