// #244 任务范围外的发布接线:任务 issue 材料(input/task-issue.json)里计划方写明不做 / 接受的内容,配上答卷里的 beyondTask 声明,
// 服务器核对通过才把 P1/P2 移出阻断、报告单列、结果包带 beyondTask;核对不过、P0、开关不是 enforce、作者陈述级别的 issue 一律照常阻断。
// gh 用 PATH 上的替身;repo/ 是真 git 仓。发布脚本在没有远端的仓里会失败,这里只断言发布前已经算好、写下的东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { previousFromResult, computeReviewScope } from '../lib/scope.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const SKILL_SHA = 'a'.repeat(40);
const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'changes-requested —— 1 条 P0/P1/P2'].join('\n');
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');

function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function setup({ findings, state: extraState = {} }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-beyond-'));
  for (const dir of ['input', 'out', 'repo', 'bin']) mkdirSync(join(work, dir), { recursive: true });
  const repo = join(work, 'repo');
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'keep\nadded\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'head');
  const head = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'bin', 'gh'), '#!/usr/bin/env node\nif (process.argv.includes("--paginate")) { process.stdout.write("[[]]"); process.exit(0); }\nprocess.stdout.write(JSON.stringify({ id: 5 }));\n');
  chmodSync(join(work, 'bin', 'gh'), 0o755);
  writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
  writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head, base: head, tier: 'standard', prevRunId: '', roundId: 'round-12345678',
    attempt: 1, mode: 'live', action: 'review', skillSha: SKILL_SHA, runId: '42', runUrl: '' };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
    lockToken: 't', authorityDigest: 'd',
    context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
      evidence: { head, base: head, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
    current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
    scope: { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] }, checkRunId: 99, pendingGates: [],
    deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] }, ...extraState }));
  writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: REPORT, findings }));
  return { work, head };
}

const finding = (over = {}) => ({ severity: 'P1', title: '空指针', trigger: '未登录', behavior: '抛错', impact: '白屏', fix: '判空', verify: '补测',
  evidence: [{ path: 'src/a.ts', line: 2 }], origin: 'introduced', bugClass: 'null-deref', instances: [], supersedes: null,
  path: 'src/a.ts', line: 2, side: 'RIGHT', deferredTo: null, ...over });

function publish(work) {
  const env = { ...process.env, MIVO_REVIEW_WORK: work, GH_TOKEN: 'x', CHECKS_TOKEN: 'y', PATH: `${join(work, 'bin')}${delimiter}${process.env.PATH}` };
  spawnSync(process.execPath, [REVIEW, 'publish'], { env, encoding: 'utf8', timeout: 120_000 });
  return JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
}


const BEYOND_SECTION = '## 任务范围外的问题（不阻断本 PR）';
const MATERIAL = (over = {}) => ({ version: 1, mode: 'enforce', status: 'read', ref: 'o/r#12', warnings: [], gaps: [],
  issue: { ref: 'o/r#12', trust: 'plan', trustLabel: '计划方验收标准', trustNote: null,
    sections: { 目标: '兜底快照只保留最新一份。', 范围: '- `main.js`:删旧快照;删失败只记诊断,不影响本次回执', 不做: '- 不改面板侧重放与 ACK 逻辑(`persistRetryReplay.ts` 不动)' },
    scList: [{ sc: 'SC3', description: '旧快照删除失败时本次 put 仍回 ok:true 并记一条诊断;下次 put 再删', layer: 'contract' }], decided: [] },
  parent: null, derived: { scopeOutside: [], blackboxSc: [], depsOpen: [] }, truncated: [], ...over });

/** 在 setup 的基础上放进任务 issue 材料,并让 state.taskIssue 指向它。 */
function withTaskIssue(work, material) {
  const file = join(work, 'input', 'task-issue.json');
  writeFileSync(file, JSON.stringify(material));
  const statePath = join(work, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...state, taskIssue: { mode: material.mode, file, summary: { ref: material.ref } } }));
}
const run = (findings, material = MATERIAL()) => {
  const { work } = setup({ findings });
  if (material) withTaskIssue(work, material);
  const result = publish(work);
  const report = readFileSync(join(work, 'out', 'report.md'), 'utf8');
  const comments = existsSync(join(work, 'comments.json')) ? JSON.parse(readFileSync(join(work, 'comments.json'), 'utf8')) : [];
  rmSync(work, { recursive: true, force: true });
  return { result, report, comments };
};
const notDo = (over = {}) => finding({ severity: 'P1', title: '冷启重放按 id 选快照', bugClass: 'replay-order', beyondTask: 'not-do', beyondTaskQuote: '不改面板侧重放与 ACK 逻辑', ...over });

test('SC3/SC5:计划方写明不做的 P1、写明接受的 P2、不比合并前差的 P2 → 不阻断、不开 thread、报告单列、结果包带 beyondTask', () => {
  const { result, report, comments } = run([notDo(),
    finding({ severity: 'P2', title: '读索引失败后分片残留', bugClass: 'orphan', beyondTask: 'accepted', beyondTaskQuote: '删失败只记诊断,不影响本次回执' }),
    finding({ severity: 'P2', title: '连续失败 64 次后台账被淘汰', bugClass: 'eviction', beyondTask: 'no-worse', beyondTaskQuote: '' })]);
  assert.equal(result.reviewClean, true);
  assert.deepEqual(result.mivo.findings, []);
  assert.deepEqual(result.mivo.beyondTask.map((f) => [f.severity, f.beyondTask]), [['P1', 'not-do'], ['P2', 'accepted'], ['P2', 'no-worse']]);
  assert.match(result.mivo.beyondTask[0].key, /^[0-9a-f]{12}$/);
  assert.equal(result.mivo.beyondTask[0].beyondTaskQuote, '不改面板侧重放与 ACK 逻辑');
  assert.equal(result.mivo.beyondTask[0].trigger, undefined, '结果包只存紧凑形状');
  assert.equal(comments.length, 0, '任务范围外的问题不开 thread');
  assert.ok(report.includes(BEYOND_SECTION));
  assert.match(report, /- `src\/a\.ts:2` · \[P1\] 冷启重放按 id 选快照 · 依据:任务 issue 写明不做「不改面板侧重放与 ACK 逻辑」/);
  assert.match(report, /\[P2\] 连续失败 64 次后台账被淘汰 · 依据:最坏结果不比合并前差，任务 issue 没要求$/m);
  assert.match(report, /^pass —— 没有阻断的 P0\/P1\/P2。另有 3 条任务范围外的 P1\/P2/m);
});

test('SC3:范围内的 P1 与范围外的 P2 同轮时,只有范围内的阻断并开 thread', () => {
  const { result, report, comments } = run([finding(), finding({ severity: 'P2', title: '时钟回拨', bugClass: 'clock', beyondTask: 'no-worse', beyondTaskQuote: '' })]);
  assert.equal(result.reviewClean, false);
  assert.deepEqual(result.mivo.findings.map((f) => f.severity), ['P1']);
  assert.equal(result.mivo.beyondTask.length, 1);
  assert.equal(comments.length, 1);
  assert.match(report, /^changes-requested —— 1 条 P0\/P1\/P2.*另有 1 条任务范围外的 P1\/P2/m);
});

test('SC4:编造的引用、引用太短、不比合并前差标在 P1 上、P0、上一轮问题改判 → 照常阻断并记原因', () => {
  const cases = [
    [notDo({ beyondTaskQuote: '本 PR 不需要处理并发重放' }), /引用的原文在计划方写的任务 issue 对应部分里找不到/],
    [notDo({ beyondTaskQuote: '不改面板' }), /引用的任务 issue 原文不足 6 个字/],
    [notDo({ beyondTask: 'not-do', beyondTaskQuote: '删失败只记诊断,不影响本次回执' }), /对应部分里找不到/], // 「接受」的原文不能拿来当「不做」
    [finding({ severity: 'P1', beyondTask: 'no-worse', beyondTaskQuote: '' }), /只适用于 P2/],
    [notDo({ severity: 'P0' }), /P0 不论范围都阻断/],
    [notDo({ supersedes: 'a'.repeat(12) }), /上一轮已经阻断过这条问题/],
    [finding({ severity: 'P2', beyondTask: 'accepted', beyondTaskQuote: '2026-11-10' }), /不足 6 个字/],
    [finding({ severity: 'P2', beyondTask: 'accepted', beyondTaskQuote: '删失败只记诊断' }), /引用太短/],
  ];
  for (const [item, why] of cases) {
    const { result, report } = run([item]);
    assert.equal(result.reviewClean, false, item.beyondTaskQuote);
    assert.equal(result.mivo.findings.length, 1);
    assert.deepEqual(result.mivo.beyondTask, []);
    assert.ok(!report.includes(BEYOND_SECTION));
    assert.ok(result.warnings.some((w) => why.test(w)), `${why}:${JSON.stringify(result.warnings)}`);
  }
});

test('SC1/SC4:开关 observe 或 off、子 issue 是作者陈述、没有任务 issue 材料时,整个分桶不启用,结果与改动前相同', () => {
  for (const material of [MATERIAL({ mode: 'observe' }), MATERIAL({ mode: 'off' }), null,
    MATERIAL({ status: 'unreadable', issue: null }),
    MATERIAL({ issue: { ...MATERIAL().issue, trust: 'author', trustLabel: '作者陈述', trustNote: '开 PR 后非维护者改过' } })]) {
    const { result, report } = run([notDo(), finding({ severity: 'P2', title: '时钟回拨', bugClass: 'clock', beyondTask: 'no-worse', beyondTaskQuote: '' })], material);
    assert.equal(result.reviewClean, false, JSON.stringify(material?.mode));
    assert.equal(result.mivo.findings.length, 2);
    assert.deepEqual(result.mivo.beyondTask, []);
    assert.ok(!report.includes(BEYOND_SECTION));
  }
});

test('SC1:答卷没有 beyondTask 字段(旧答卷)或写 none 时照常阻断', () => {
  const plain = finding();
  const { result } = run([plain, finding({ title: '另一条', bugClass: 'x', beyondTask: 'none', beyondTaskQuote: '不改面板侧重放与 ACK 逻辑' })]);
  assert.equal(result.mivo.findings.length, 2);
  assert.deepEqual(result.mivo.beyondTask, []);
});

// SC6 在沿用路径上也成立:任务范围起作用时产生只含范围外问题的干净结果,同 head 把开关改回 observe 重跑,不能沿用成「不阻断」。
test('SC6:只含任务范围外问题的干净结果,同 head 任务范围不再起作用 → 不沿用、全量重审,旧问题清单带上它', () => {
  const { work } = setup({ findings: [notDo()] });
  try {
    withTaskIssue(work, MATERIAL());
    const result = publish(work);
    assert.equal(result.reviewClean, true);
    const key = result.mivo.beyondTask[0].key;
    const previous = previousFromResult(result, readFileSync(join(work, 'out', 'report.md'), 'utf8'));
    const ev = result.reviewEvidence;
    const current = { head: result.head, baseRefName: ev.baseRefName, diffHash: ev.diffHash, filePatchHashes: result.mivo.filePatchHashes,
      filePatchHashesV2: result.mivo.filePatchHashesV2, totalDiffLines: 1, tier: 'standard', triggerKinds: [], specDigest: result.mivo.specDigest, now: Date.now() };
    const args = { previous, current, headIsDescendant: true };
    assert.equal(computeReviewScope({ ...args, taskBoundaryActive: true }).mode, 'reuse', '任务范围仍起作用时同 head 照常沿用');
    for (const off of [{ taskBoundaryActive: false }, {}]) {
      const scope = computeReviewScope({ ...args, ...off });
      assert.equal(scope.mode, 'full');
      assert.match(scope.reason, /任务范围本轮不起作用/);
      assert.deepEqual(scope.previousFindings.map((f) => f.key), [key]);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// 复审(PR #245)确认的绕过:上一轮挡过的 P1 换个标题重报并标成范围外,原来会放行。
test('SC4:上一轮挡过的问题换标题重报 → 照常阻断;上一轮结果读不到而 PR 上有审查机 thread → 照常阻断', () => {
  const first = setup({ findings: [finding({ severity: 'P1', title: '冷启重放按 id 选快照', bugClass: 'replay-order' })] });
  const again = setup({ findings: [notDo({ title: '重放顺序在乱序队列下会应用旧内容', bugClass: 'snapshot-ordering' })] });
  const lost = setup({ findings: [notDo()] });
  try {
    withTaskIssue(first.work, MATERIAL());
    const round1 = publish(first.work);
    assert.equal(round1.mivo.findings.length, 1);
    // 第二轮:带上一轮的结果链(prepare 写进 state.previousRound 的形状)
    withTaskIssue(again.work, MATERIAL());
    const statePath = join(again.work, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const f = round1.mivo.findings[0];
    writeFileSync(statePath, JSON.stringify({ ...state, previous: { head: 'x' }, previousRound: { roundIndex: 1, keys: [f.key],
      findings: [{ key: f.key, seenRounds: 1, severity: f.severity, path: f.path, line: f.line ?? null, bugClass: f.bugClass, title: f.title, locationFiles: f.locationFiles }] } }));
    const round2 = publish(again.work);
    assert.equal(round2.reviewClean, false);
    assert.equal(round2.mivo.findings.length, 1);
    assert.deepEqual(round2.mivo.beyondTask, []);
    assert.ok(round2.warnings.some((w) => /修复轮按文件从严,照常阻断/.test(w)), JSON.stringify(round2.warnings));
    // 上一轮结果读不到(没有 previousRound),但 state 记着有上一轮
    withTaskIssue(lost.work, MATERIAL());
    const lostPath = join(lost.work, 'state.json');
    writeFileSync(lostPath, JSON.stringify({ ...JSON.parse(readFileSync(lostPath, 'utf8')), previous: { head: 'x' } }));
    const round3 = publish(lost.work);
    assert.equal(round3.mivo.findings.length, 1);
    assert.ok(round3.warnings.some((w) => /上一轮的审查结果读不到/.test(w)));
  } finally { for (const s of [first, again, lost]) rmSync(s.work, { recursive: true, force: true }); }
});

// 第二轮复审(PR #245)确认的绕过:上一轮结果和 state.previous 都没有,但 PR 上有当前版本的审查机 thread(同版本重跑、结果包丢了)。
test('SC4:上一轮结果读不到、PR 上有当前版本的审查机 thread → 照常阻断;没有任何 thread 的首轮不受影响', () => {
  const marker = (head) => `<!-- mivo-finding key=${'a'.repeat(12)} round=1 head=${head.slice(0, 12)} class=replay-order -->`;
  for (const [withThread, expectBeyond] of [[true, 0], [false, 1]]) {
    const { work, head } = setup({ findings: [notDo()] });
    try {
      withTaskIssue(work, MATERIAL());
      const ctxFile = join(work, 'input', 'context.json');
      const viewer = { login: 'reviewer' };
      writeFileSync(ctxFile, JSON.stringify({ pr: 7, meta: {}, approvalPolicy: { viewer: 'reviewer' },
        history: { reviewThreads: withThread ? [{ id: 'T1', isResolved: false, comments: [{ id: 'C1', author: viewer, body: `[P1] 冷启重放按 id 选快照\n\n${marker(head)}` }] }] : [] } }));
      const result = publish(work);
      assert.equal(result.mivo.beyondTask.length, expectBeyond, `withThread=${withThread} warnings=${JSON.stringify(result.warnings)}`);
      if (withThread) assert.ok(result.warnings.some((w) => /上一轮的审查结果读不到/.test(w)));
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
});

// 第三轮复审(PR #245):文件改名后旧问题换到新文件名下重报;上一轮记录满 100 条;结果包记下受保护的文件。
test('SC4:上一轮问题所在文件在本轮版本上已不存在 → 照常阻断;上一轮记录满 100 条 → 按读不到处理;结果包的问题带 locationFiles', () => {
  const cases = [
    [[{ key: 'a'.repeat(12), seenRounds: 1, severity: 'P1', path: 'src/old.ts', locationFiles: ['src/old.ts'] }], /文件在本轮版本上已不存在/],
    [Array.from({ length: 100 }, (_, n) => ({ key: n.toString(16).padStart(12, '0'), seenRounds: 1, severity: 'P2', path: 'src/z.ts', locationFiles: ['src/z.ts'] })), /上一轮的审查结果读不到/],
  ];
  for (const [findings, why] of cases) {
    const { work } = setup({ findings: [notDo()] });
    try {
      withTaskIssue(work, MATERIAL());
      const statePath = join(work, 'state.json');
      writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), previous: { head: 'x' }, previousRound: { roundIndex: 1, keys: findings.map((f) => f.key), findings } }));
      const result = publish(work);
      assert.deepEqual(result.mivo.beyondTask, []);
      assert.equal(result.mivo.findings.length, 1);
      assert.deepEqual(result.mivo.findings[0].locationFiles, ['src/a.ts'], '结果包的问题记下它的位置所在文件,下一轮用来从严');
      assert.ok(result.warnings.some((w) => why.test(w)), JSON.stringify(result.warnings));
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
});

// 第四轮复审(PR #245):目录、符号链接、子模块被当成普通文件——能当证据,也能顶替已删除的受保护文件。
test('SC4:证据指向目录或符号链接 → 证据不完整照常阻断;受保护文件被换成目录、符号链接、子模块 → 整轮照常阻断', () => {
  const addTree = (repo) => {
    mkdirSync(join(repo, 'src', 'dir'), { recursive: true });
    writeFileSync(join(repo, 'src', 'dir', 'x.ts'), 'x\n');
    symlinkSync('a.ts', join(repo, 'src', 'link.ts'));
    git(repo, 'add', '.');
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${'e'.repeat(40)},src/sub`);
    git(repo, 'commit', '-q', '-m', 'tree');
    return git(repo, 'rev-parse', 'HEAD');
  };
  const prepare = (work, previous) => {
    const head = addTree(join(work, 'repo'));
    withTaskIssue(work, MATERIAL());
    const statePath = join(work, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({ ...state, input: { ...state.input, head }, context: { ...state.context, evidence: { ...state.context.evidence, head } },
      ...(previous ? { previous: { head: 'x' }, previousRound: { roundIndex: 1, keys: [previous.key], findings: [previous] } } : {}) }));
  };
  // 证据指向目录 / 符号链接
  for (const path of ['src/dir', 'src/link.ts', 'src/sub']) {
    const { work } = setup({ findings: [notDo({ evidence: [{ path: 'src/a.ts', line: 2 }, { path, line: null }] })] });
    try {
      prepare(work, null);
      const result = publish(work);
      assert.deepEqual(result.mivo.beyondTask, [], path);
      assert.ok(result.warnings.some((w) => /证据不完整/.test(w)), `${path}:${JSON.stringify(result.warnings)}`);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  // 普通文件做证据、上一轮没有问题:照常可以分到范围外(确认读文件类型没有误伤)
  {
    const { work } = setup({ findings: [notDo()] });
    try { prepare(work, null); assert.equal(publish(work).mivo.beyondTask.length, 1); } finally { rmSync(work, { recursive: true, force: true }); }
  }
  // 受保护的文件现在是目录 / 符号链接 / 子模块
  for (const path of ['src/dir', 'src/link.ts', 'src/sub']) {
    const { work } = setup({ findings: [notDo()] });
    try {
      prepare(work, { key: 'f'.repeat(12), seenRounds: 1, severity: 'P1', path, locationFiles: [path] });
      const result = publish(work);
      assert.deepEqual(result.mivo.beyondTask, [], path);
      assert.ok(result.warnings.some((w) => /不再是普通文件/.test(w)), `${path}:${JSON.stringify(result.warnings)}`);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
});

// 第五轮复审(PR #245):本 PR 早期版本沿用旧结果时写过只含 path 的 files;两轮 publish 走一遍,确认它不被当成完整清单,
// 而本版本写的 locationFiles 在沿用(reuse)后原样保留。
test('SC4:旧字段 files 下的清单不认;本版本写的 locationFiles 经沿用仍保留', () => {
  const { work } = setup({ findings: [finding({ path: 'src/a.ts', evidence: [{ path: 'src/a.ts', line: 2 }] })] });
  try {
    withTaskIssue(work, MATERIAL());
    const round1 = publish(work);
    assert.deepEqual(round1.mivo.findings[0].locationFiles, ['src/a.ts']);
    assert.equal(round1.mivo.findings[0].files, undefined, '不再写旧字段');
  } finally { rmSync(work, { recursive: true, force: true }); }
  const legacy = setup({ findings: [notDo()] });
  try {
    withTaskIssue(legacy.work, MATERIAL());
    const statePath = join(legacy.work, 'state.json');
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), previous: { head: 'x' },
      previousRound: { roundIndex: 1, keys: ['f'.repeat(12)], findings: [{ key: 'f'.repeat(12), seenRounds: 1, severity: 'P1', path: 'src/zz.ts', files: ['src/zz.ts'] }] } }));
    const result = publish(legacy.work);
    assert.deepEqual(result.mivo.beyondTask, []);
    assert.ok(result.warnings.some((w) => /文件清单缺失/.test(w)), JSON.stringify(result.warnings));
  } finally { rmSync(legacy.work, { recursive: true, force: true }); }
});
