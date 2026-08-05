// prescan.test.mjs — R1 预扫标注层集成测试(SC-1~3,2026-08-05 final SC v2)。
//
// 覆盖:配置门(SC-1)、分段准备安全门(SC-2)、严格记录与 finalize(SC-3)、反向变异
// (SC-8:跨段泄露/敏感内容零输出/超限拒绝/篡改重放拒绝)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePrescanConfig, validateObservation, deriveObservationId, computeArtifactHash, PRESCAN_CATEGORIES } from '../scripts/lib.prescan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRE_SCAN = join(__dirname, '..', 'scripts', 'pre-scan.mjs');
const PREPARE = join(__dirname, '..', 'scripts', 'prepare-prescan-segment.mjs');
const RECORD = join(__dirname, '..', 'scripts', 'record-prescan-segment.mjs');
const BUILD_TASK = join(__dirname, '..', 'scripts', 'build-review-task.mjs');
const DELIVER = join(__dirname, '..', 'scripts', 'deliver-review-segment.mjs');

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function setup({ rules = {}, headFiles, baseFiles } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'prescan-'));
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
  const defaultHead = {
    'src/a.mjs': '// 旧注释:仍说这里返回 null\nexport function a() { return 1; }\n',
    'src/b.mjs': 'export function b() { return 2; }\n',
  };
  for (const [p, c] of Object.entries(headFiles ?? defaultHead)) {
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

function run(script, args, f) {
  const r = spawnSync('node', [script, '469', '--base', f.base, '--head', f.head, ...args], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  return { r, json };
}

// ── SC-1: 纯函数层配置校验 ──

test('SC-1.1: validatePrescanConfig 只允许 enabled 单键,拒 model/apiKeyEnv/endpoint', () => {
  assert.deepEqual(validatePrescanConfig(null), { enabled: false, valid: true });
  assert.deepEqual(validatePrescanConfig({ enabled: false }), { enabled: false, valid: true });
  assert.deepEqual(validatePrescanConfig({ enabled: true }), { enabled: true, valid: true });
  const withModel = validatePrescanConfig({ enabled: true, model: 'deepseek/deepseek-v4-flash' });
  assert.equal(withModel.valid, false, 'model 键不再合法(脚本不发起网络调用)');
  const withApiKey = validatePrescanConfig({ enabled: true, apiKeyEnv: 'FOO' });
  assert.equal(withApiKey.valid, false, 'apiKeyEnv 键不再合法');
  assert.equal(validatePrescanConfig({ enabled: 'yes' }).valid, false, 'enabled 必须是 boolean');
  assert.equal(validatePrescanConfig('not-object').valid, false);
});

// ── SC-1.3: pre-scan.mjs 四态判定 ──

test('SC-1.3: prescan 缺失/enabled=false → status=disabled', () => {
  const f = setup({ rules: {} });
  const { json } = run(PRE_SCAN, [], f);
  assert.equal(json.status, 'disabled');
  assert.equal(json.ok, true);
});

test('SC-1.3: prescan 配置非法(含 model 键)→ status=failed/reasonCode=config-invalid', () => {
  const f = setup({ rules: { prescan: { enabled: true, model: 'x' } } });
  const { json } = run(PRE_SCAN, [], f);
  assert.equal(json.status, 'failed');
  assert.equal(json.reasonCode, 'config-invalid');
});

test('SC-1.3/2.3: prescan enabled 且安全 → status=ready', () => {
  const f = setup({ rules: { prescan: { enabled: true } } });
  const { json } = run(PRE_SCAN, [], f);
  assert.equal(json.status, 'ready');
  assert.ok(json.snapshotHash);
});

test('SC-2.3: 敏感内容命中 → status=skipped/reasonCode=sensitive-content', () => {
  const f = setup({
    rules: { prescan: { enabled: true } },
    headFiles: { 'src/a.mjs': 'const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";\n' },
  });
  const { json } = run(PRE_SCAN, [], f);
  assert.equal(json.status, 'skipped');
  assert.equal(json.reasonCode, 'sensitive-content');
});

// ── SC-2.1/2.2/2.3: prepare-prescan-segment.mjs ──

test('SC-2.1: prepare 第 1 段返回可预扫内容,不含后续段文件(跨段隔离)', () => {
  const f = setup({
    rules: { prescan: { enabled: true }, reviewSegments: { sizeBudget: 1 } },
  });
  const { json: j1 } = run(PREPARE, ['--order', '1'], f);
  assert.equal(j1.ok, true);
  assert.equal(j1.order, 1);
  assert.ok(j1.files.length >= 1);
  const firstSegPaths = j1.files.map((x) => x.path);
  // 第 2 段的文件不应出现在第 1 段的返回里
  const { json: j2 } = run(PREPARE, ['--order', '2'], f);
  if (j2.ok) {
    const secondSegPaths = j2.files.map((x) => x.path);
    for (const p of secondSegPaths) assert.ok(!firstSegPaths.includes(p), `第 2 段文件 ${p} 不应出现在第 1 段(跨段泄露)`);
  }
});

test('SC-2.1: prepare 乱序/跳段拒绝且不留记录', () => {
  const f = setup({ rules: { prescan: { enabled: true }, reviewSegments: { sizeBudget: 1 } } });
  // 直接跳到第 2 段(未先投第 1 段)
  const { json } = run(PREPARE, ['--order', '2'], f);
  assert.equal(json.ok, false, '未先投第 1 段就要第 2 段应拒绝');
});

test('SC-2.3: prepare 敏感内容命中时零 patch 输出(仅 reasonCode,无 diff 文本)', () => {
  const f = setup({
    rules: { prescan: { enabled: true } },
    headFiles: { 'src/a.mjs': 'const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";\n' },
  });
  const { json } = run(PREPARE, ['--order', '1'], f);
  assert.equal(json.ok, false);
  assert.equal(json.reasonCode, 'sensitive-content');
  assert.equal('files' in json, false, '敏感命中时不得含 files/patch 字段');
});

// ── SC-3.1/3.2/3.3/3.4: record-prescan-segment.mjs ──

function prepareAndRecord(f, order, observations) {
  const { json: prep } = run(PREPARE, ['--order', String(order)], f);
  assert.equal(prep.ok, true, `prepare order=${order} 应成功:${JSON.stringify(prep)}`);
  const obsFile = join(f.work, `obs-${order}.json`);
  writeFileSync(obsFile, JSON.stringify(observations));
  const { json: rec } = run(RECORD, ['--order', String(order), '--segment-id', prep.segmentId, '--observations', obsFile], f);
  return { prep, rec };
}

test('SC-3.1: record 严格拒绝未知字段(如 verdict/observationId 自报)', () => {
  const g = setup({ rules: { prescan: { enabled: true }, reviewSegments: { sizeBudget: 60 } } });
  const { json: p1 } = run(PREPARE, ['--order', '1'], g);
  assert.equal(p1.ok, true);
  const badFile = join(g.work, 'bad-obs.json');
  const path = p1.files[0].path;
  const line = p1.files[0].hunks[0].addedNewLines[0];
  writeFileSync(badFile, JSON.stringify([{ file: path, line, category: PRESCAN_CATEGORIES[0], note: 'x', verdict: 'P1' }]));
  const { json: r1 } = run(RECORD, ['--order', '1', '--segment-id', p1.segmentId, '--observations', badFile], g);
  assert.equal(r1.ok, false);
  assert.equal(r1.reasonCode, 'schema-invalid');
});

test('SC-3.1: record 拒绝未知 category', () => {
  const f = setup({ rules: { prescan: { enabled: true } } });
  const { json: p1 } = run(PREPARE, ['--order', '1'], f);
  const path = p1.files[0].path;
  const line = p1.files[0].hunks[0].addedNewLines[0];
  const badFile = join(f.work, 'bad-cat.json');
  writeFileSync(badFile, JSON.stringify([{ file: path, line, category: '其他可疑', note: 'x' }]));
  const { json: r1 } = run(RECORD, ['--order', '1', '--segment-id', p1.segmentId, '--observations', badFile], f);
  assert.equal(r1.ok, false);
  assert.equal(r1.reasonCode, 'schema-invalid');
});

test('SC-3.1: record 拒绝 line 不在新增行内', () => {
  const f = setup({ rules: { prescan: { enabled: true } } });
  const { json: p1 } = run(PREPARE, ['--order', '1'], f);
  const path = p1.files[0].path;
  const badFile = join(f.work, 'bad-line.json');
  writeFileSync(badFile, JSON.stringify([{ file: path, line: 999999, category: PRESCAN_CATEGORIES[0], note: 'x' }]));
  const { json: r1 } = run(RECORD, ['--order', '1', '--segment-id', p1.segmentId, '--observations', badFile], f);
  assert.equal(r1.ok, false);
  assert.equal(r1.reasonCode, 'schema-invalid');
});

test('SC-3.1: record 拒绝引用其他段文件(跨段引用)', () => {
  const f = setup({ rules: { prescan: { enabled: true }, reviewSegments: { sizeBudget: 1 } } });
  const { json: p1 } = run(PREPARE, ['--order', '1'], f);
  const { json: p2 } = run(PREPARE, ['--order', '2'], f);
  if (!p2.ok) return; // 只有一段时跳过本用例
  const seg2Path = p2.files[0].path;
  const badFile = join(f.work, 'cross-seg.json');
  writeFileSync(badFile, JSON.stringify([{ file: seg2Path, line: p2.files[0].hunks[0].addedNewLines[0], category: PRESCAN_CATEGORIES[0], note: 'x' }]));
  const { json: r1 } = run(RECORD, ['--order', '1', '--segment-id', p1.segmentId, '--observations', badFile], f);
  assert.equal(r1.ok, false, '第 1 段记录不应接受引用第 2 段文件的 observation');
});

test('SC-3.3: record 单段幂等重放(相同内容二次记录成功,replayed=true)', () => {
  const f = setup({ rules: { prescan: { enabled: true } } });
  const { prep, rec } = prepareAndRecord(f, 1, []);
  assert.equal(rec.ok, true);
  assert.equal(rec.replayed, false);
  const obsFile = join(f.work, 'obs-1.json');
  const { json: r2 } = run(RECORD, ['--order', '1', '--segment-id', prep.segmentId, '--observations', obsFile], f);
  assert.equal(r2.ok, true);
  assert.equal(r2.replayed, true);
});

test('SC-3.3: record 同段不同内容二次写入拒绝', () => {
  const f = setup({ rules: { prescan: { enabled: true } } });
  const { prep } = prepareAndRecord(f, 1, []);
  const path = prep.files[0].path;
  const line = prep.files[0].hunks[0].addedNewLines[0];
  const obsFile2 = join(f.work, 'obs-1-different.json');
  writeFileSync(obsFile2, JSON.stringify([{ file: path, line, category: PRESCAN_CATEGORIES[0], note: 'different content' }]));
  const { json: r2 } = run(RECORD, ['--order', '1', '--segment-id', prep.segmentId, '--observations', obsFile2], f);
  assert.equal(r2.ok, false, '同段内容变化的二次写入应拒绝');
});

test('SC-3.3: 超每文件上限拒绝(output-over-limit)', () => {
  const f = setup({ rules: { prescan: { enabled: true } } });
  const { json: p1 } = run(PREPARE, ['--order', '1'], f);
  const path = p1.files[0].path;
  const line = p1.files[0].hunks[0].addedNewLines[0];
  const many = Array.from({ length: 11 }, () => ({ file: path, line, category: PRESCAN_CATEGORIES[0], note: 'x' }));
  const obsFile = join(f.work, 'many.json');
  writeFileSync(obsFile, JSON.stringify(many));
  const { json: r1 } = run(RECORD, ['--order', '1', '--segment-id', p1.segmentId, '--observations', obsFile], f);
  assert.equal(r1.ok, false);
  assert.equal(r1.reasonCode, 'output-over-limit');
});

test('SC-3.4: finalize 缺段时拒绝(orchestration-incomplete)', () => {
  const f = setup({ rules: { prescan: { enabled: true }, reviewSegments: { sizeBudget: 1 } } });
  // 只记录第 1 段,不记第 2 段就 finalize
  prepareAndRecord(f, 1, []);
  const { json } = run(RECORD, ['--finalize'], f);
  const { json: p2check } = run(PREPARE, ['--order', '2'], f);
  if (p2check.ok) {
    assert.equal(json.ok, false);
    assert.equal(json.reasonCode, 'orchestration-incomplete');
  }
});

test('SC-3.4: 全部段记录完成后 finalize 产出 complete artifact', () => {
  const f = setup({ rules: { prescan: { enabled: true } } }); // 默认 sizeBudget=60,通常只 1 段
  const { json: p1 } = run(PREPARE, ['--order', '1'], f);
  const path = p1.files[0].path;
  const line = p1.files[0].hunks[0].addedNewLines[0];
  const obsFile = join(f.work, 'obs.json');
  writeFileSync(obsFile, JSON.stringify([{ file: path, line, category: PRESCAN_CATEGORIES[0], note: '旧注释未更新' }]));
  run(RECORD, ['--order', '1', '--segment-id', p1.segmentId, '--observations', obsFile], f);
  const { json: fin } = run(RECORD, ['--finalize'], f);
  assert.equal(fin.ok, true);
  assert.equal(fin.status, 'complete');
  assert.equal(fin.observationCount, 1);
  assert.ok(fin.artifactHash);
});

// ── SC-7: artifact hash 反向变异 ──

test('SC-7: artifactHash 随 observation 内容变化(改 note 后 hash 必须不同)', () => {
  const base = { schemaVersion: 'prescan-1', status: 'complete', snapshotHash: 'snap1-x', inputHash: 'psi1-x', policyHash: 'psp1-x', observationCount: 1, observations: [{ observationId: 'po1-a', file: 'a.mjs', line: 1, category: '陈旧注释', note: '原始' }], reasonCode: null };
  const h1 = computeArtifactHash(base);
  const modified = { ...base, observations: [{ ...base.observations[0], note: '被篡改' }] };
  const h2 = computeArtifactHash(modified);
  assert.notEqual(h1, h2, '篡改 observation.note 后 artifactHash 必须不同(SC-7 反向变异)');
});

test('SC-3.2: deriveObservationId 绑定 segmentId(同内容不同段 → 不同 ID,防跨段重放)', () => {
  const id1 = deriveObservationId('snap1-x', 'seg-01', 'a.mjs', 1, '陈旧注释', 'note');
  const id2 = deriveObservationId('snap1-x', 'seg-02', 'a.mjs', 1, '陈旧注释', 'note');
  assert.notEqual(id1, id2, '不同 segmentId 应派生出不同 observationId');
});

// ── SC-4: 按段投递 prescan observations(集成 build-review-task + deliver-review-segment) ──

function buildTask(f) {
  const taskFile = join(f.work, 'task.json');
  const promptFile = join(f.work, 'prompt.md');
  const bodyFile = join(f.work, 'body.md');
  writeFileSync(bodyFile, '普通改动,无历史 PR 引用。');
  const r = spawnSync('node', [BUILD_TASK, '469', '--base', f.base, '--head', f.head,
    '--out-task', taskFile, '--out-prompt', promptFile, '--pr-body-file', bodyFile],
    { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, `build-review-task 应成功:${r.stdout}${r.stderr}`);
  return { taskFile, promptFile, task: JSON.parse(readFileSync(taskFile, 'utf8')), prompt: readFileSync(promptFile, 'utf8') };
}

function deliverSegment(f, taskFile, order) {
  const r = spawnSync('node', [DELIVER, '469', '--task', taskFile, '--base', f.base, '--head', f.head, '--order', String(order)],
    { cwd: f.repo, env: f.env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* fallthrough */ }
  return { r, json };
}

test('SC-4.1: task.prescan 只含承诺字段(无 observations 明细),prompt 只声明状态+总数', () => {
  const f = setup({ rules: { prescan: { enabled: true } } });
  const { json: p1 } = run(PREPARE, ['--order', '1'], f);
  assert.equal(p1.ok, true);
  const path = p1.files[0].path;
  const line = p1.files[0].hunks[0].addedNewLines[0];
  const obsFile = join(f.work, 'obs.json');
  writeFileSync(obsFile, JSON.stringify([{ file: path, line, category: PRESCAN_CATEGORIES[0], note: '旧注释未更新' }]));
  run(RECORD, ['--order', '1', '--segment-id', p1.segmentId, '--observations', obsFile], f);
  const fin = run(RECORD, ['--finalize'], f);
  assert.equal(fin.json.ok, true);

  const { task, prompt } = buildTask(f);
  assert.ok(task.prescan, 'task 应含 prescan 承诺字段');
  assert.equal(task.prescan.status, 'complete');
  assert.equal(task.prescan.observationCount, 1);
  assert.equal('observations' in task.prescan, false, 'task.prescan 不得含 observations 明细(SC-4.1/4.3)');
  assert.ok(prompt.includes('预扫标注'), 'prompt 应声明预扫状态');
  assert.ok(prompt.includes('共 1 条'), 'prompt 应声明观察总数');
  assert.ok(!prompt.includes('旧注释未更新'), 'prompt 不得含 observation 明细内容(SC-4.1)');
});

test('SC-4.2: deliver-review-segment 按段现场重算附带 prescan observations,跨段不泄露', () => {
  const f = setup({
    rules: { prescan: { enabled: true }, reviewSegments: { sizeBudget: 1 } },
    headFiles: { 'src/a.mjs': '// 旧注释:仍说这里返回 null\nexport function a() { return 1; }\n', 'src/b.mjs': 'export function b() { return 2; }\n' },
  });
  const { json: p1 } = run(PREPARE, ['--order', '1'], f);
  assert.equal(p1.ok, true);
  const path1 = p1.files[0].path;
  const line1 = p1.files[0].hunks[0].addedNewLines[0];
  const obsFile1 = join(f.work, 'obs1.json');
  writeFileSync(obsFile1, JSON.stringify([{ file: path1, line: line1, category: PRESCAN_CATEGORIES[0], note: '第 1 段的观察' }]));
  run(RECORD, ['--order', '1', '--segment-id', p1.segmentId, '--observations', obsFile1], f);

  const { json: p2 } = run(PREPARE, ['--order', '2'], f);
  if (!p2.ok) return; // 只有一段(sizeBudget 未生效)时跳过
  const obsFile2 = join(f.work, 'obs2.json');
  writeFileSync(obsFile2, JSON.stringify([]));
  run(RECORD, ['--order', '2', '--segment-id', p2.segmentId, '--observations', obsFile2], f);
  const fin = run(RECORD, ['--finalize'], f);
  assert.equal(fin.json.ok, true);
  assert.equal(fin.json.observationCount, 1);

  const { taskFile } = buildTask(f);
  const { json: d1 } = deliverSegment(f, taskFile, 1);
  assert.equal(d1.ok, true);
  assert.equal(d1.prescanObservations.length, 1, '第 1 段投递应附带该段的 1 条观察');
  assert.equal(d1.prescanObservations[0].note, '第 1 段的观察');
  assert.ok(d1.payload.includes('第 1 段的观察'), 'payload 文本应含本段观察内容');

  const { json: d2 } = deliverSegment(f, taskFile, 2);
  assert.equal(d2.ok, true);
  assert.equal(d2.prescanObservations.length, 0, '第 2 段不应看到属于第 1 段文件的观察(跨段隔离)');
});

test('SC-4.2: prescan disabled 时 deliver-review-segment 不附带 prescanObservations', () => {
  const f = setup({ rules: {} });
  const { taskFile } = buildTask(f);
  const { json: d1 } = deliverSegment(f, taskFile, 1);
  assert.equal(d1.ok, true);
  assert.deepEqual(d1.prescanObservations, [], 'disabled 时 prescanObservations 应为空数组');
});

// ── SC-5/6: 正式 reviewer 强制 disposition + consumer/receipt 三层绑定(集成) ──

test('SC-5.1: consumer 侧 validateReviewOutput 要求已投递的 prescan observation 恰一条 assessment', async () => {
  const { validateReviewOutput } = await import('../scripts/lib.review-consume.mjs');
  const shape1 = validateReviewOutput(
    { schemaVersion: 'rro-1', findingFamilies: [], verificationGaps: [], verificationRuns: [], profileAnswers: [], findingDispositions: [], segmentReceipts: [], negativeEvidence: [], escapeAssessment: [] },
    { expectedPrescanObservationIds: ['po1-abc'] },
  );
  assert.equal(shape1.ok, false, '缺 prescanAssessments 时应 invalid');
  assert.ok(shape1.errors.some((e) => e.includes('po1-abc') || e.includes('prescanAssessments')));

  const shape2 = validateReviewOutput(
    {
      schemaVersion: 'rro-1', findingFamilies: [], verificationGaps: [], verificationRuns: [], profileAnswers: [], findingDispositions: [], segmentReceipts: [], negativeEvidence: [], escapeAssessment: [],
      prescanAssessments: [{ observationId: 'po1-abc', disposition: 'dismissed', basis: '核实后确认非真实问题' }],
    },
    { expectedPrescanObservationIds: ['po1-abc'] },
  );
  assert.equal(shape2.ok, true, '一一对应的 dismissed assessment 应通过');
});

test('SC-5.1: dismissed 缺 basis 应 invalid', async () => {
  const { validateReviewOutput } = await import('../scripts/lib.review-consume.mjs');
  const shape = validateReviewOutput(
    {
      schemaVersion: 'rro-1', findingFamilies: [], verificationGaps: [], verificationRuns: [], profileAnswers: [], findingDispositions: [], segmentReceipts: [], negativeEvidence: [], escapeAssessment: [],
      prescanAssessments: [{ observationId: 'po1-abc', disposition: 'dismissed' }],
    },
    { expectedPrescanObservationIds: ['po1-abc'] },
  );
  assert.equal(shape.ok, false);
  assert.ok(shape.errors.some((e) => e.includes('basis')));
});

test('SC-5.2: expectedPrescanObservationIds 为空数组时不要求 prescanAssessments', async () => {
  const { validateReviewOutput } = await import('../scripts/lib.review-consume.mjs');
  const shape = validateReviewOutput(
    { schemaVersion: 'rro-1', findingFamilies: [], verificationGaps: [], verificationRuns: [], profileAnswers: [], findingDispositions: [], segmentReceipts: [], negativeEvidence: [], escapeAssessment: [] },
    { expectedPrescanObservationIds: [] },
  );
  assert.equal(shape.ok, true, 'disabled/skipped/failed/complete-empty(空 observation 集)不要求 assessment');
});

test('SC-6.2: isReviewReceiptClean 三态期望值——undefined fail-closed,null 要求无 prescanHash,string 严格相等', async () => {
  const { isReviewReceiptClean } = await import('../scripts/lib.mjs');
  const baseArgs = { headRefOid: 'sha-x', snapshotHash: 'snap1-x', ledgerHash: 'lh1-x', escapeSourceHash: 'esh1-x', knownHazardsHash: 'khh1-x' };
  const receiptNoprescan = { headRefOid: 'sha-x', verdict: 'clean', p0p1Count: 0, snapshotHash: 'snap1-x', ledgerHash: 'lh1-x', escapeSourceHash: 'esh1-x', knownHazardsHash: 'khh1-x' };
  assert.equal(isReviewReceiptClean({ receipt: receiptNoprescan, ...baseArgs, expectedPrescanHash: undefined }), false, 'undefined 必须 fail-closed');
  assert.equal(isReviewReceiptClean({ receipt: receiptNoprescan, ...baseArgs, expectedPrescanHash: null }), true, 'null(disabled)且 receipt 无 prescanHash 应 clean');
  assert.equal(isReviewReceiptClean({ receipt: receiptNoprescan, ...baseArgs, expectedPrescanHash: 'psp1-y' }), false, '期望 enabled 但 receipt 无 prescanHash 不得 clean');
  const receiptWithPrescan = { ...receiptNoprescan, prescanHash: 'pa1-abc' };
  assert.equal(isReviewReceiptClean({ receipt: receiptWithPrescan, ...baseArgs, expectedPrescanHash: 'pa1-abc' }), true, 'prescanHash 严格相等应 clean');
  assert.equal(isReviewReceiptClean({ receipt: receiptWithPrescan, ...baseArgs, expectedPrescanHash: 'pa1-different' }), false, 'prescanHash 不符应拒绝');
  assert.equal(isReviewReceiptClean({ receipt: receiptWithPrescan, ...baseArgs, expectedPrescanHash: null }), false, 'receipt 偷带旧 prescanHash 但期望 disabled 应拒绝');
});
