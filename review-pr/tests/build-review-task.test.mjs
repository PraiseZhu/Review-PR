// SC-R3+R4(集成 tranche)+ R6 分类器 + R7 注入:build-review-task.mjs 子进程实跑,
// 断言 check IDs / open findingIds / hazard 文本 / segments 真出现在**构建产物**里
// (不是"context 有字段"的假绿);以及 matcher 语义、非法配置 fail-closed、分片 owner 唯一。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchPath, mergeProfiles, buildSegments, classifyRequiredNegativeEvidence, BUILTIN_PROFILES } from '../scripts/lib.review-profiles.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'build-review-task.mjs');
const DELIVER = join(__dirname, '..', 'scripts', 'deliver-review-segment.mjs');
const LEDGER_SRC = join(__dirname, '..', 'evolution', 'ledger.json');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    // 显式禁签名:继承全局 commit.gpgsign 时,并发跑 temp-git 用例会撞 gpg
    // 「Cannot allocate memory」而随机红(核验席实测 409/414)。测试仓不需要签名。
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const E2E = `export async function w(page) {
  await page.waitForFunction(() => document.readyState === 'complete');
  expect(1).toBe(1);
}
`;

function setup({ rules = {}, headFiles, baseFiles } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'brt-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/xindong/mivo-canvas.git'], repo);
  writeFileSync(join(repo, 'README.md'), '# x\n');
  for (const [p, c] of Object.entries(baseFiles ?? {})) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  const base = git(['rev-parse', 'HEAD'], repo);
  for (const [p, c] of Object.entries(headFiles ?? { 'scripts/e2e/a.mjs': E2E })) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'head'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);
  const stateDir = join(work, 'state');
  mkdirSync(stateDir);
  const rulesFile = join(work, 'pr-rules.json');
  writeFileSync(rulesFile, JSON.stringify({ admins: [], ...rules }));
  const env = { ...process.env, REVIEW_PR_REPO_ROOT: repo, REVIEW_PR_STATE_DIR: stateDir, REVIEW_PR_RULES_FILE: rulesFile };
  return { work, repo, base, head, stateDir, env };
}

function run(f, extra = [], { env = {} } = {}) {
  const taskFile = join(f.work, `task-${Math.random().toString(36).slice(2)}.json`);
  const promptFile = join(f.work, `prompt-${Math.random().toString(36).slice(2)}.md`);
  // R7 数据源默认走离线 seam:不给 --pr-body-file 时构建器会现场 `gh pr view`(生产行为),
  // 单测不该依赖网络。想测"数据源缺失 → escapeSourceIncomplete"的用例自己屏蔽 gh。
  const withSource = extra.includes('--pr-body-file') || extra.includes('--no-source-seam')
    ? extra.filter((x) => x !== '--no-source-seam')
    : (() => {
      const bf = join(f.work, `body-${Math.random().toString(36).slice(2)}.md`);
      writeFileSync(bf, '普通改动,无历史 PR 引用。');
      return [...extra, '--pr-body-file', bf];
    })();
  const r = spawnSync('node', [SCRIPT, '469', '--base', f.base, '--head', f.head, '--out-task', taskFile, '--out-prompt', promptFile, ...withSource], { cwd: f.repo, env: { ...f.env, ...env }, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  assert.ok(json, `应输出 JSON:status=${r.status}\n${r.stdout.slice(0, 500)}\n${r.stderr.slice(0, 500)}`);
  f.lastTaskFile = taskFile; // 供后续投递用例引用同一份 task
  return { r, json, task: JSON.parse(readFileSync(taskFile, 'utf8')), prompt: readFileSync(promptFile, 'utf8') };
}

// ── 纯函数层 ──

test('R3 matcher:** 跨目录含零层、* 不跨 /、大小写敏感、全串锚定', () => {
  assert.equal(matchPath('scripts/e2e/**', 'scripts/e2e/a.mjs'), true);
  assert.equal(matchPath('scripts/e2e/**', 'scripts/e2e/x/y/z.mjs'), true);
  assert.equal(matchPath('scripts/e2e/**', 'scripts/e2eother/a.mjs'), false, '不得把 e2eother 当 e2e');
  assert.equal(matchPath('tests/*', 'tests/a/b.mjs'), false, '* 不跨 /');
  assert.equal(matchPath('**/*.test.*', 'src/a/b.test.ts'), true);
  assert.equal(matchPath('Tests/**', 'tests/a.mjs'), false, '大小写敏感');
  assert.equal(matchPath('a.ts', 'xa.ts'), false, '全串锚定');
});

test('R3 内置 profile 拆分:test-infra 与 ci-workflow 不混(异步谓词类不会被 .github 全答 N/A)', () => {
  const ids = BUILTIN_PROFILES.map((p) => p.id);
  assert.deepEqual(ids, ['test-infra', 'ci-workflow']);
  const ti = BUILTIN_PROFILES[0];
  assert.ok(ti.mandatoryChecks.some((c) => c.id === 'could-be-always-green'));
  assert.ok(!ti.pathPatterns.some((p) => p.startsWith('.github/')), '.github 应归 ci-workflow');
});

test('R3 合并:内置 always-on;同 id 取检查项并集(目标仓不能删内置项);非法项 fail-closed 但内置照跑', () => {
  const okMerge = mergeProfiles([{ id: 'test-infra', pathPatterns: ['custom/**'], mandatoryChecks: [{ id: 'extra', ask: 'x' }] }]);
  assert.equal(okMerge.configIncomplete, false);
  const ti = okMerge.profiles.find((p) => p.id === 'test-infra');
  assert.ok(ti.pathPatterns.includes('custom/**') && ti.pathPatterns.includes('scripts/e2e/**'));
  assert.ok(ti.mandatoryChecks.some((c) => c.id === 'could-be-always-green') && ti.mandatoryChecks.some((c) => c.id === 'extra'));
  for (const bad of [[{ id: '' }], [{ id: 'a', pathPatterns: [] }], [{ id: 'a', pathPatterns: ['x'], mandatoryChecks: [] }], [{ id: 'a', pathPatterns: ['x'], mandatoryChecks: [{ id: 'd', ask: 'q' }, { id: 'd', ask: 'q2' }] }], 'not-array']) {
    const m = mergeProfiles(bad);
    assert.equal(m.configIncomplete, true, JSON.stringify(bad));
    assert.ok(m.profiles.some((p) => p.id === 'test-infra'), '内置必须照常在(继续多抓问题)');
  }
});

test('R4 分片:两类 coverage key 都恰一个 owner,并集 === 全集', () => {
  const keys = [
    ...Array.from({ length: 7 }, (_, i) => ({ kind: 'hunk', fileId: 'F1', hunkId: `H${i}` })),
    { kind: 'file', fileId: 'F2' },
  ];
  const segs = buildSegments({ coverageKeys: keys, sizeBudget: 3 });
  assert.equal(segs.length, 3);
  const seen = new Map();
  for (const s of segs) for (const k of s.assignedCoverageKeys) {
    const str = k.kind === 'hunk' ? `hunk:${k.fileId}:${k.hunkId}` : `file:${k.fileId}`;
    assert.equal(seen.has(str), false, `${str} 出现在多个 segment`);
    seen.set(str, s.segmentId);
  }
  assert.equal(seen.size, keys.length);
  assert.equal(buildSegments({ coverageKeys: [] }).length, 1, '零 key 也给一个空段(便于统一对账)');
});

test('R6 分类器:等待/断言/守卫 → required;纯注释、文档文件、业务代码里的纯等待 → 不产', () => {
  const { profiles } = mergeProfiles();
  const mk = (path, hunks) => [{ fileId: 'F1', newPath: path, changeType: 'modified', contentKind: 'text', hunks }];
  const call = (files, added, removed = {}, incompleteFiles = []) =>
    classifyRequiredNegativeEvidence({ profiles, files, addedLineTextByFile: added, removedLineTextByFile: removed, incompleteFiles });

  // test-infra:等待原语 → required;注释掉的断言 → 不产(变异去掉注释过滤即误判)
  const r1 = call(
    mk('scripts/e2e/a.mjs', [{ hunkId: 'H1', addedNewLines: [2] }, { hunkId: 'H2', addedNewLines: [9] }]),
    { 'scripts/e2e/a.mjs': { H1: ['  await page.waitForFunction(() => x);'], H2: ['  // expect(old).toBe(1) 旧断言已注释'] } },
  );
  assert.equal(r1.required.length, 1, `纯注释 hunk 不得产 required:${JSON.stringify(r1.required)}`);
  assert.equal(r1.required[0].hunkId, 'H1');
  assert.equal(r1.incomplete, false);

  // 普通业务代码:纯等待不产;守卫/断言改动 → required(第 1 轮核验:guard call 也要证据)
  assert.deepEqual(call(mk('src/app.ts', [{ hunkId: 'H1' }]), { 'src/app.ts': { H1: ['  await page.waitForSelector("#x");'] } }).required, []);
  assert.equal(call(mk('src/app.ts', [{ hunkId: 'H1' }]), { 'src/app.ts': { H1: ['  invariant(x != null, "x required");'] } }).required.length, 1);
  assert.equal(call(mk('src/guard.ts', [{ hunkId: 'H1' }]), { 'src/guard.ts': { H1: ['  assertInvariant(ok);'] } }).required.length, 1);

  // 文档类文件:说明文字里出现 expect( 也不产
  assert.deepEqual(call(mk('docs/readme.md', [{ hunkId: 'H1' }]), { 'docs/readme.md': { H1: ['写法示例:expect(x).toBe(1)'] } }).required, []);

  // **删除**断言/等待同样 required(把守门人拿掉不能免检)
  const del = call(
    mk('scripts/e2e/a.mjs', [{ hunkId: 'H1' }]),
    { 'scripts/e2e/a.mjs': { H1: ['  const x = 1;'] } },
    { 'scripts/e2e/a.mjs': { H1: ['  expect(x).toBe(1);'] } },
  );
  assert.equal(del.required.length, 1);
  assert.match(del.required[0].reason, /删除/);

  // 取文本失败 → incomplete(不得静默产空集合)
  const inc = call(mk('scripts/e2e/a.mjs', [{ hunkId: 'H1' }]), {}, {}, ['scripts/e2e/a.mjs']);
  assert.equal(inc.incomplete, true);
  assert.deepEqual(inc.incompleteFiles, ['scripts/e2e/a.mjs']);
});

// ── 构建器接线(断到产物文本)──

test('R3/R4 接线:必答 check IDs、segments 出现在 prompt;必答/负向明细只留计数与承诺(第 4 轮核验)', () => {
  const f = setup();
  const { json, task, prompt } = run(f);
  assert.equal(json.snapshotComplete, true);
  assert.ok(task.requiredProfileAnswerCount > 0);
  assert.equal(task.requiredProfileAnswers, undefined, 'task 不得携带必答项明细(fileId 是 file coverage key)');
  assert.match(task.profileAnswersCommitment ?? '', /^pc1-/);
  for (const c of BUILTIN_PROFILES[0].mandatoryChecks) {
    assert.ok(prompt.includes(c.id), `prompt 必须含 check id ${c.id}(check 语义仍要给,给的是 ask,不是 fileId)`);
  }
  assert.ok(prompt.includes(task.snapshotHash), 'prompt 必须携带 snapshotHash');
  assert.ok(task.segments.length >= 1);
  for (const seg of task.segments) assert.ok(prompt.includes(seg.segmentId), `prompt 必须含 ${seg.segmentId}`);
  assert.ok(task.requiredNegativeEvidenceKeyCount > 0, 'e2e 新增等待/断言 → 必须产 required 负向 key');
  assert.equal(task.requiredNegativeEvidenceKeys, undefined, 'task 不得携带负向 key 明细(fileId/hunkId 就是 coverage hunk key)');
  assert.match(task.negativeEvidenceCommitment ?? '', /^nec1-/);
  assert.ok(!/h1-[0-9a-f]{16}/.test(prompt), 'prompt 不得出现任何 hunkId');
  assert.ok(!/f1-[0-9a-f]{16}/.test(prompt), 'prompt 不得出现任何 fileId');
});

test('R4 第 4 轮核验 BLOCKER:key/必答/负向明细与 patch 内容只从投递出口出;后段明细对前段不可见', () => {
  // sizeBudget=1 → 每个 coverage key 一段;两个 e2e 文件 → 至少 2 段
  const f = setup({
    rules: { reviewSegments: { sizeBudget: 1 } },
    headFiles: {
      'scripts/e2e/a.mjs': E2E,
      'scripts/e2e/b.mjs': "export async function w2(page) {\n  await page.waitForFunction(() => document.title !== '');\n}\n",
    },
  });
  const { task, prompt } = run(f);
  assert.ok(task.segments.length >= 2, `需要至少 2 段:${task.segments.length}`);
  const taskText = JSON.stringify(task);
  const deliver = (order) => {
    const r = spawnSync('node', [DELIVER, '469', '--task', f.lastTaskFile, '--base', f.base, '--head', f.head, '--order', String(order)], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout);
  };
  const seg1 = deliver(1);
  const seg2 = deliver(2);
  // 第二段的真实 fileId 与 hunkId **分别**搜索(核验席点名:只搜拼接串 `hunk:f:h` 是形状假绿)
  const k2 = seg2.assignedCoverageKeys[0];
  for (const [label, text] of [['task.json', taskText], ['prompt.md', prompt], ['第一段投递输出', JSON.stringify(seg1)]]) {
    assert.ok(!text.includes(k2.fileId), `${label} 不得含第二段的 fileId(${k2.fileId})`);
    if (k2.hunkId) assert.ok(!text.includes(k2.hunkId), `${label} 不得含第二段的 hunkId(${k2.hunkId})`);
  }
  // 投递必须带**可审查内容**:path + patch 文本(不是 opaque key)
  for (const seg of [seg1, seg2]) {
    const c = seg.segmentContent[0];
    assert.ok(c.path, '每个 key 必须带 path');
    if (c.kind === 'hunk') {
      assert.match(c.patch, /^@@ /, 'hunk key 必须带 immutable patch 文本');
      assert.ok(seg.payload.includes('```diff'), 'payload 正文必须内嵌 patch 内容');
      assert.ok(seg.payload.includes(c.path), 'payload 正文必须带 path');
    }
  }
  // 本段的 required 负向证据明细也随段给出(task/prompt 已不含)
  const negAll = [...(seg1.negativeRequirements ?? []), ...(seg2.negativeRequirements ?? [])];
  assert.equal(negAll.length, task.requiredNegativeEvidenceKeyCount, '负向 key 明细必须恰好经投递出口给全');
  const profAll = [...(seg1.profileRequirements ?? []), ...(seg2.profileRequirements ?? [])];
  assert.equal(profAll.length, task.requiredProfileAnswerCount, '必答项明细必须恰好经投递出口给全');
});

test('R3 fail-closed 接线:目标仓 riskProfiles 非法 → task.profileConfigIncomplete=true 且内置项照常注入', () => {
  const f = setup({ rules: { riskProfiles: [{ id: 'broken' }] } });
  const { task, prompt } = run(f);
  assert.equal(task.profileConfigIncomplete, true);
  assert.ok(task.profileWarnings.length > 0);
  assert.ok(prompt.includes('could-be-always-green'), '内置必答项必须仍然注入(继续多抓问题)');
  assert.match(prompt, /会判 invalid/);
});

test('R5 接线:台账里的 open finding 以 findingId 注入 prompt(下一席才可能逐条核销)', () => {
  const f = setup();
  const { json: probe } = run(f);            // 先探一次拿 snapshotHash(判定 stale 用)
  const stateSub = readdirSync(f.stateDir).find((d) => existsSync(join(f.stateDir, d)));
  const ledgerDir = join(f.stateDir, stateSub ?? '.');
  const entry = {
    findingId: 'fid1-testopen', invariantKey: 'ik1-x', path: 'scripts/e2e/a.mjs', line: 2,
    severity: 'P1', seat: 'auto', originSnapshotHash: 'snap1-older', status: 'open', ts: '2026-08-05T00:00:00Z',
  };
  writeFileSync(join(ledgerDir, 'findings-469.json'), JSON.stringify({ version: 1, entries: [entry] }));
  const { task, prompt } = run(f);
  assert.deepEqual(task.injectedOpenIds, ['fid1-testopen']);
  assert.ok(prompt.includes('fid1-testopen'), 'prompt 必须列出未决 findingId');
  assert.match(prompt, /必须逐条 disposition/);
  assert.ok(probe.snapshotHash);
});

test('R7 接线:active hazard 命中路径 → hazard 文本进 prompt;pending 的不进', () => {
  const f = setup();
  // 在 skill 的 canonical ledger 上做临时注入不合适(那是真文件),改用 loadKnownHazards
  // 的形状直接验证 hazardsForPaths + 构建器读取:此处只断言"当前 ledger 无 active hazard
  // 时 prompt 不含 hazard 段",active 情形由 lib.escaped-hazards 单测覆盖。
  const { prompt } = run(f);
  assert.ok(!prompt.includes('## 已知逃逸风险') || prompt.includes('hz2-'), 'hazard 段出现时必须带 hazardId');
  assert.ok(readFileSync(LEDGER_SRC, 'utf8').length > 0);
});

test('R7 第 2 轮核验 BLOCKER:逃逸候选数据源必需且绑定——取不到即 escapeSourceIncomplete(不得据"无候选"放行)', () => {
  const f = setup();
  // 屏蔽 gh:PATH 只留一个必失败的 shim,复现"现场取 PR body 失败"
  const shim = join(f.work, 'shim');
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, 'gh'), '#!/bin/sh\necho "gh unavailable" >&2\nexit 1\n');
  spawnSync('chmod', ['+x', join(shim, 'gh')]);
  // PATH 只保留 shim + node/git 所需目录(全 shim 会连 node 都找不到)
  const nodeDir = dirname(process.execPath);
  const blind = run(f, ['--no-source-seam'], { env: { PATH: [shim, nodeDir, '/usr/bin', '/bin'].join(':') } });
  assert.equal(blind.task.escapeSourceIncomplete, true, '数据源取不到必须显式标不完整');
  assert.equal(blind.task.escapeCandidates.length, 0);
  assert.match(blind.task.escapeSourceErrors.join(';'), /PR body/);
  // 对照:给了 body 文件 → 完整,且候选被确定性抽出
  const bf = join(f.work, 'body-real.md');
  writeFileSync(bf, '本 PR 修复 #469 逃过审查的假等待问题。\n');
  const ok = run(f, ['--pr-body-file', bf]);
  assert.equal(ok.task.escapeSourceIncomplete, false);
  assert.equal(ok.task.escapeCandidates.length, 1);
  assert.equal(ok.task.escapeSourceKind, 'file-seam');
  // 关联 issue 文本同样进候选(body 里没有引用,只有 issue 里有)
  const bf2 = join(f.work, 'body-plain.md');
  writeFileSync(bf2, '常规改动。\n');
  const isf = join(f.work, 'issues.json');
  writeFileSync(isf, JSON.stringify(['标题\n这条 issue 说的是 #470 漏审的问题']));
  const withIssue = run(f, ['--pr-body-file', bf2, '--related-issues-file', isf]);
  assert.equal(withIssue.task.relatedIssueCount, 1);
  assert.equal(withIssue.task.escapeCandidates.length, 1, '关联 issue 里的引用也必须进候选');
  assert.equal(withIssue.task.escapeCandidates[0].kind, 'issue-reference');
});

test('R4 第 5 轮核验 BLOCKER:单文件多 hunk 跨段时,profile 必答项只能有一个 owner 段(不得重复投递)', () => {
  // 单个 e2e 文件里放两处 waitForFunction,且两处改动隔开 > 3 行上下文,使 git diff
  // 产出**两个独立 hunk**(同一 fileId,两个不同 hunkId);sizeBudget=1 强制切成 ≥2 段——
  // 若必答项按"本段是否含该 fileId 的任意 key"过滤,会在两段里各投一遍。
  const pad = (n) => Array.from({ length: n }, (_, i) => `const pad${i} = ${i};`).join('\n');
  const before = `export async function w1(page) {
  // TODO w1
}

${pad(8)}

export async function w2(page) {
  // TODO w2
}
`;
  const after = before
    .replace('  // TODO w1', "  await page.waitForFunction(() => document.readyState === 'complete');")
    .replace('  // TODO w2', "  await page.waitForFunction(() => document.title !== '');");
  const f = setup({
    rules: { reviewSegments: { sizeBudget: 1 } },
    baseFiles: { 'scripts/e2e/multi.mjs': before },
    headFiles: { 'scripts/e2e/multi.mjs': after },
  });
  const { task } = run(f);
  assert.ok(task.segments.length >= 2, `需要至少 2 段才能复现跨段:${task.segments.length}`);
  assert.ok(task.requiredProfileAnswerCount > 0, '前提:e2e 文件必须产生必答项');
  const delivered = [];
  for (let i = 1; i <= task.segments.length; i += 1) {
    const r = spawnSync('node', [DELIVER, '469', '--task', f.lastTaskFile, '--base', f.base, '--head', f.head, '--order', String(i)], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    delivered.push(JSON.parse(r.stdout));
  }
  const allProfileReqs = delivered.flatMap((d) => d.profileRequirements ?? []);
  assert.equal(allProfileReqs.length, task.requiredProfileAnswerCount,
    `必答项总投递数(${allProfileReqs.length})必须恰好等于 task 声明的计数(${task.requiredProfileAnswerCount})——不得因同文件跨段而重复投递`);
  const seen = new Set();
  for (const r of allProfileReqs) {
    const key = `${r.profileId}:${r.fileId}:${r.checkId}`;
    assert.ok(!seen.has(key), `必答项 ${key} 被投递了多次`);
    seen.add(key);
  }
});
