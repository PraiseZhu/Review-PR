// 核对员(enforce 为默认):纯函数(开关解析、选择、模型挑选、预算、应用、报告小节)每次都跑;
// 集成部分用假 codex 脚本,在 06:00–07:00 维护窗口内跳过(codex() 的 checkHealth 没有测试旁路,不为测试新增生产旁路)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inBusinessWindow } from '../lib/health.mjs';
import { loadFeatures, selectForVerification, pickVerifierModel, runVerification, applyVerification, buildVerifyPrompt, VERIFY_SCHEMA, DEFAULT_FEATURES } from '../lib/verify.mjs';
import { finalizeReport, VERIFIER_REFUTED_SECTION, VERIFIER_DOWNGRADED_SECTION } from '../lib/report.mjs';
import { buildSpecManifest, specDigestOf, loadReviewSpec } from '../lib/prompt.mjs';
import { SKILL_ROOT } from '../lib/common.mjs';
import { removeRunArtifacts } from './codex.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const FEATURES_JSON = fileURLToPath(new URL('../config/review-features.json', import.meta.url));
const MIN = 60_000;
const feat = (over = {}) => JSON.stringify({ verify: { ...DEFAULT_FEATURES.verify, ...over } });
const loadText = (text) => loadFeatures('f.json', () => text);

test('features:默认文件是 enforce;缺失、JSON 非法、字段非法都按 off 并给出 warning;enforce 不再降级', () => {
  assert.equal(JSON.parse(readFileSync(FEATURES_JSON, 'utf8')).verify.mode, 'enforce');
  assert.deepEqual(loadFeatures(FEATURES_JSON), { verify: { ...DEFAULT_FEATURES.verify }, warnings: [] });
  const missing = loadFeatures('/nonexistent/features.json');
  assert.equal(missing.verify.mode, 'off');
  assert.match(missing.warnings[0], /review-features\.json 读不到或不合法\(.*\),核对员按 off 处理/);
  for (const bad of ['{not json', feat({ mode: 'sometimes' }), feat({ model: 'bad model!' }), feat({ effort: 'ultra' }), feat({ tiers: ['huge'] }),
    feat({ maxFindings: 11 }), feat({ perCallTimeoutMin: 0 }), feat({ budgetMin: 999 }), JSON.stringify({})]) {
    const r = loadText(bad);
    assert.equal(r.verify.mode, 'off', bad);
    assert.equal(r.warnings.length, 1, bad);
  }
  assert.equal(loadText(feat({ mode: 'shadow' })).verify.mode, 'shadow');
  assert.deepEqual(loadText(feat({ mode: 'enforce' })).warnings, []);
  assert.equal(loadText(feat({ mode: 'enforce' })).verify.mode, 'enforce');
});

test('features:开关文件不进 specDigest,也不在 prompt.mjs 里出现;loadFeatures 只在 codex 阶段调用', () => {
  const manifest = () => buildSpecManifest({ spec: loadReviewSpec(SKILL_ROOT), tier: 'standard', files: ['src/a.ts'], readFile: () => null, config: '{}' });
  assert.equal(specDigestOf(manifest()), specDigestOf(manifest()));
  assert.ok(!JSON.stringify(manifest()).includes('review-features'));
  assert.ok(!readFileSync(fileURLToPath(new URL('../lib/prompt.mjs', import.meta.url)), 'utf8').includes('review-features'));
  const source = readFileSync(REVIEW, 'utf8');
  const codexSection = source.slice(source.indexOf('async function codex()'), source.indexOf('// ── 答卷分类'));
  const calls = (text) => (text.match(/loadFeatures\(/g) ?? []).length;
  assert.equal(calls(source), 1);
  assert.equal(calls(codexSection), 1);
});

test('选择与模型:只核 P1(P0 永不核),超出上限的不核;配置模型与主审相同时换模型,再相同就不核', () => {
  const f = (severity, key) => ({ severity, key });
  const { selected, overflow } = selectForVerification([f('P1', 'a'), f('P0', 'b'), f('P1', 'c'), f('P1', 'd')], { maxFindings: 2 });
  assert.deepEqual(selected.map((x) => x.key), ['a', 'c']);
  assert.deepEqual(overflow.map((x) => x.key), ['d']);
  const configured = { model: 'openai/gpt-6.1-sol', effort: 'medium' };
  const primary = { model: 'openai/gpt-6-luna', effort: 'max' };
  assert.deepEqual(pickVerifierModel({ configured, answeredBy: 'openai/gpt-6-luna', primary }), configured);
  assert.deepEqual(pickVerifierModel({ configured, answeredBy: 'openai/gpt-6.1-sol', primary }), { model: 'openai/gpt-6-luna', effort: 'medium' }, '主审 fallback 到 sol 时核对员改用 luna');
  assert.equal(pickVerifierModel({ configured, answeredBy: 'openai/gpt-6.1-sol', primary: { model: 'openai/gpt-6.1-sol' } }), null);
  assert.doesNotMatch(JSON.stringify(VERIFY_SCHEMA), /maxLength|minItems|maxItems/);
  assert.deepEqual(VERIFY_SCHEMA.properties.verdict.enum, ['confirmed', 'refuted', 'downgraded', 'unknown']);
  const prompt = buildVerifyPrompt({ finding: { severity: 'P1', title: '空指针', path: 'a.ts', line: 3, trigger: 't', behavior: 'b', impact: 'i', evidence: [{ path: 'a.ts', line: 3 }] }, workdir: '/w' });
  assert.match(prompt, /## 核对任务/);
  assert.match(prompt, /尝试驳倒/);
  assert.match(prompt, /verdict=refuted/);
  assert.match(prompt, /verdict=downgraded/);
  assert.doesNotMatch(prompt, /## Findings|主审报告内容/);
});

const P1S = [{ severity: 'P1', key: 'a' }, { severity: 'P1', key: 'b' }, { severity: 'P1', key: 'c' }];
const CFG = { ...DEFAULT_FEATURES.verify, mode: 'enforce', maxFindings: 5 };
const same = { answeredBy: 'openai/gpt-6-luna', primary: { model: 'openai/gpt-6-luna' } };
const ok = (answer, durationMs = MIN) => ({ ok: true, durationMs, answer });

test('预算不足 skipped(该条照常阻断):作业剩余时间不够一次调用、累计用时超过 budgetMin 都跳过;runOne 抛错记失败', async () => {
  const none = await runVerification({ findings: P1S, config: CFG, ...same, remainingMs: () => 5 * MIN, runOne: () => assert.fail('不该调用') });
  assert.deepEqual(none.skipped, P1S.map((f) => ({ key: f.key, uid: null, reason: 'budget' })));
  const ran = [];
  const result = await runVerification({ findings: P1S, config: CFG, ...same, remainingMs: () => 90 * MIN,
    runOne: async (finding) => { ran.push(finding.key); if (finding.key === 'a') throw new Error('boom'); return ok({ verdict: 'confirmed', evidence: [], note: 'n'.repeat(900) }, 6 * MIN); } });
  assert.deepEqual(ran, ['a', 'b'], '累计 6 分钟后再加一次 15 分钟超过 20 分钟预算,第三条跳过');
  assert.equal(result.items[0].ok, false);
  assert.equal(result.items[0].applied, null);
  assert.match(result.items[0].error, /boom/);
  assert.equal(result.items[1].verdict, 'confirmed');
  assert.equal(result.items[1].note.length, 600);
  assert.equal(result.items[1].applied, null);
  assert.deepEqual(result.skipped, [{ key: 'c', uid: null, reason: 'budget' }]);
  const nomodel = await runVerification({ findings: P1S, config: CFG, answeredBy: CFG.model, primary: { model: CFG.model }, remainingMs: () => 90 * MIN, runOne: () => assert.fail('同模型不核对') });
  assert.deepEqual(nomodel.skipped.map((s) => s.reason), ['same-model', 'same-model', 'same-model']);
});

test('enforce 下 refuted 要有真实证据、downgraded 要有理由才生效;其余记结论但不生效', async () => {
  const answers = [
    { verdict: 'refuted', evidence: [{ path: 'src/a.ts', line: 1 }], note: '调用方已判空' },
    { verdict: 'refuted', evidence: [], note: '凭印象' },
    { verdict: 'downgraded', evidence: [], note: '只影响提示文案,没有数据后果' },
  ];
  const run = (config, checkEvidence = null) => runVerification({ findings: P1S, config, ...same, remainingMs: () => 90 * MIN, checkEvidence,
    runOne: async (finding, index) => ok(answers[index], 1000) });
  const enforced = await run(CFG);
  assert.deepEqual(enforced.items.map((i) => i.applied), ['refuted', null, 'downgraded']);
  assert.equal(enforced.items[1].rejected, '推翻没有给出证据');
  assert.equal(enforced.mode, 'enforce');
  assert.ok(enforced.items.every((i) => i.model === 'openai/gpt-6.1-sol' && i.durationMs === 1000), '每条带模型与耗时');
  const noEvidenceOnHead = await run(CFG, () => ({ complete: false }));
  assert.equal(noEvidenceOnHead.items[0].applied, null);
  assert.equal(noEvidenceOnHead.items[0].rejected, '推翻的证据在 head 上找不到');
  const noReason = await runVerification({ findings: [P1S[0]], config: CFG, ...same, remainingMs: () => 90 * MIN, runOne: async () => ok({ verdict: 'downgraded', evidence: [], note: '  ' }) });
  assert.equal(noReason.items[0].applied, null);
  assert.equal(noReason.items[0].rejected, '降级没有写理由');
  const shadow = await run({ ...CFG, mode: 'shadow' });
  assert.deepEqual(shadow.items.map((i) => i.applied), [null, null, null], 'shadow 只记录');
  assert.deepEqual(shadow.items.map((i) => i.verdict), ['refuted', 'refuted', 'downgraded']);
  const bad = await runVerification({ findings: [P1S[0]], config: CFG, ...same, remainingMs: () => 90 * MIN, runOne: async () => ok({ verdict: 'maybe', evidence: [], note: '' }) });
  assert.equal(bad.items[0].ok, false);
  assert.equal(bad.items[0].applied, null);
});

test('applyVerification:按单条 finding 的 uid 应用;推翻/降级的 P1 移出阻断;P0、confirmed、出错、没核到的照常阻断;shadow 与 off 不动', () => {
  const findings = [
    { severity: 'P1', key: 'a', uid: 'ua', path: 'a.ts', line: 1, title: '被推翻' },
    { severity: 'P1', key: 'b', uid: 'ub', path: 'b.ts', line: 2, title: '被降级' },
    { severity: 'P1', key: 'c', uid: 'uc', path: 'c.ts', title: '被确认' },
    { severity: 'P0', key: 'a', uid: 'ua0', path: 'a.ts', line: 1, title: '同 key 的 P0' },
    { severity: 'P1', key: 'a', uid: 'ua2', path: 'a.ts', line: 7, title: '同 key 的另一条 P1(没核到)' },
    { severity: 'P1', key: 'd', uid: 'ud', path: 'd.ts', title: '核对出错' },
    { severity: 'P1', key: 'e', uid: 'ue', path: 'e.ts', title: '没核到' },
    { severity: 'P1', key: 'f', path: 'f.ts', title: '没有 uid' },
  ];
  const item = (uid, applied, extra = {}) => ({ key: uid.slice(1), uid, ok: true, applied, verdict: applied ?? 'confirmed', evidence: [{ path: 'x.ts', line: 3 }], note: '依据', ...extra });
  const verification = { mode: 'enforce', items: [item('ua', 'refuted'), item('ub', 'downgraded'), item('uc', null), { key: 'd', uid: 'ud', ok: false, applied: null, error: 'x' }, item('uf', 'refuted', { key: 'f' })],
    skipped: [{ key: 'e', uid: 'ue', reason: 'budget' }, { key: 'a', uid: 'ua2', reason: 'max-findings' }] };
  const out = applyVerification({ findings, verification });
  assert.deepEqual(out.findings.map((f) => f.title), ['被确认', '同 key 的 P0', '同 key 的另一条 P1(没核到)', '核对出错', '没核到', '没有 uid']);
  assert.deepEqual(out.refuted, [{ key: 'a', uid: 'ua', severity: 'P1', path: 'a.ts', line: 1, title: '被推翻', evidence: [{ path: 'x.ts', line: 3 }], note: '依据' }]);
  assert.deepEqual(out.downgraded.map((f) => f.title), ['被降级']);
  for (const mode of ['shadow', 'off']) assert.deepEqual(applyVerification({ findings, verification: { ...verification, mode } }), { findings, refuted: [], downgraded: [] });
  assert.deepEqual(applyVerification({ findings, verification: null }).findings, findings);
});

test('报告:核对员推翻/降级各单列一节(公开标题与证据/理由);全部卡点被推翻/降级时提示人工看一眼', () => {
  const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'changes-requested —— 2 条 P0/P1'].join('\n');
  const args = { report: REPORT, pr: 1, url: 'https://github.com/o/r/pull/1', head: 'a'.repeat(40), base: 'b'.repeat(40), tier: 'standard', scope: { mode: 'full', reason: '首次' } };
  const refuted = [{ severity: 'P1', title: '空指针', path: 'src/a.ts', line: 2, evidence: [{ path: 'src/b.ts', line: 9 }], note: '调用方已判空' }];
  const downgraded = [{ severity: 'P1', title: '提示文案', path: 'src/c.ts', line: null, note: '只影响文案' }];
  const all = finalizeReport({ ...args, findings: [], verifierRefuted: refuted, verifierDowngraded: downgraded });
  assert.match(all, /## Overall\npass —— 没有阻断的 P0\/P1。核对员推翻\/降级了全部卡点（2 条），请人工看一眼再合。/);
  assert.ok(all.includes(`${VERIFIER_REFUTED_SECTION}\n\n- \`src/a.ts:2\` · [P1] 空指针 · 推翻证据：\`src/b.ts:9\` · 依据：调用方已判空`));
  assert.ok(all.includes(`${VERIFIER_DOWNGRADED_SECTION}\n\n- \`src/c.ts\` · [P1] 提示文案 · 降级理由：只影响文案`));
  assert.ok(all.indexOf(VERIFIER_REFUTED_SECTION) < all.indexOf('## Rule coverage'));
  const partial = finalizeReport({ ...args, findings: [{ path: 'src/d.ts', line: 1, body: '[P1] 还在' }], verifierRefuted: refuted });
  assert.match(partial, /changes-requested —— 1 条 P0\/P1，已在对应位置开 review thread。另有 1 条 P1 被核对员推翻\/降级，不阻断。/);
  const none = finalizeReport({ ...args, findings: [] });
  assert.ok(!none.includes(VERIFIER_REFUTED_SECTION) && !none.includes('核对员'));
});

test('removeRunArtifacts:删掉一次调用留在 tmpRoot 下的日志、答卷和 CODEX_HOME,只留 schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'mivo-artifacts-'));
  try {
    for (const dir of ['codex-home-1', 'home-1', 'tmp-1', 'codex-home-2']) mkdirSync(join(root, dir));
    for (const file of ['codex-1.stdout', 'codex-1.stderr', 'codex-1.answer.json', 'schema-1.json', 'codex-home-1/log.txt', 'codex-2.stdout']) writeFileSync(join(root, file), 'x');
    removeRunArtifacts(root, '1');
    assert.deepEqual(['codex-1.stdout', 'codex-1.stderr', 'codex-1.answer.json', 'codex-home-1', 'home-1', 'tmp-1'].filter((f) => existsSync(join(root, f))), []);
    assert.ok(existsSync(join(root, 'schema-1.json')) && existsSync(join(root, 'codex-2.stdout')) && existsSync(join(root, 'codex-home-2')), '别的调用的东西不动');
    removeRunArtifacts(root, '1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 集成:假 codex ─────────────────────────────────────────────────────────
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' };
const SENTINEL = 'MAIN-ANSWER-SENTINEL';
const FAKE_KEY = 'sk-test-FAKEKEY-0123456789abcdef'; // 假的网关凭据,只给假 codex 脚本用
const REPORT = ['## Findings', SENTINEL, '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'changes-requested —— 2 条 P0/P1'].join('\n');
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');
const finding = (over = {}) => ({ severity: 'P1', title: '空指针', trigger: '未登录', behavior: '抛错', impact: '白屏', fix: '判空', verify: '补测',
  evidence: [{ path: 'src/a.ts', line: 2 }], origin: 'introduced', bugClass: 'null-deref', instances: [], supersedes: null,
  path: 'src/a.ts', line: 2, side: 'RIGHT', deferredTo: null, ...over });
const TWO_P1 = { report: REPORT, findings: [finding(), finding({ title: '另一个问题', bugClass: 'race', line: null })] };
const REFUTED = { verdict: 'refuted', evidence: [{ path: 'src/a.ts', line: 1 }], note: '调用方已判空' };
const DOWNGRADED = { verdict: 'downgraded', evidence: [], note: '只影响提示文案,没有数据后果' };
const CONFIRMED = { verdict: 'confirmed', evidence: [{ path: 'src/a.ts', line: 2 }], note: '成立' };

// 假 codex:按 --output-schema 文件里有没有 verdict 区分主审和核对员;每次调用写一行日志(带 --model);
// 核对员运行时扫描 WORK 目录,磁盘上只要还有主审的哨兵就记 leak;verify-seq 是按调用次序消费的核对员行为('fail' 表示 exit 3);
// main-fail-first 存在时主审第一次调用失败(逼出 fallback 模型)。
function writeFakeCodex(ctl, work) {
  const bin = join(ctl, 'fake-codex');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('fake-codex 0.0.0'); process.exit(0); }
const at = (flag) => argv[argv.indexOf(flag) + 1];
const ctl = ${JSON.stringify(ctl)};
const work = ${JSON.stringify(work)};
const model = at('--model');
const log = (line) => fs.appendFileSync(path.join(ctl, 'calls.log'), line + '\\n');
const verify = fs.readFileSync(at('--output-schema'), 'utf8').includes('"verdict"');
const scan = (dir) => { let hit = false; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) hit = scan(full) || hit; else if (fs.readFileSync(full, 'utf8').includes(${JSON.stringify(SENTINEL)})) hit = true; } return hit; };
if (verify) {
  const seq = JSON.parse(fs.readFileSync(path.join(ctl, 'verify-seq.json'), 'utf8'));
  const index = fs.readFileSync(path.join(ctl, 'calls.log'), 'utf8').split('\\n').filter((l) => l.startsWith('verify')).length;
  log('verify ' + model + ' ' + (scan(work) ? 'leak' : 'clean'));
  const step = seq[Math.min(index, seq.length - 1)];
  if (step === 'fail') { process.stderr.write('verifier exploded'); process.exit(3); }
  fs.writeFileSync(at('--output-last-message'), JSON.stringify(step));
} else {
  const mains = fs.readFileSync(path.join(ctl, 'calls.log'), 'utf8').split('\\n').filter((l) => l.startsWith('main')).length;
  log('main ' + model);
  if (fs.existsSync(path.join(ctl, 'main-fail-first')) && mains === 0) { process.stderr.write('primary exploded'); process.exit(1); }
  fs.writeFileSync(at('--output-last-message'), fs.readFileSync(path.join(ctl, 'main-answer.json'), 'utf8'));
  console.log(JSON.stringify({ type: 'item.completed', text: ${JSON.stringify(SENTINEL)} }));
}
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  chmodSync(bin, 0o755);
  return bin;
}

function runCase({ features = feat({ mode: 'enforce' }), mode = 'live', main = TWO_P1, seq = [CONFIRMED], mainFailFirst = false }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-verify-'));
  const ctl = mkdtempSync(join(tmpdir(), 'mivo-review-verify-ctl-'));
  try {
    for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
    const gitRun = (...args) => { const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: join(work, 'repo'), encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    gitRun('init', '-q');
    mkdirSync(join(work, 'repo', 'src'));
    writeFileSync(join(work, 'repo', 'src', 'a.ts'), 'keep\nadded\n');
    gitRun('add', '.');
    gitRun('commit', '-q', '-m', 'head');
    const head = gitRun('rev-parse', 'HEAD');
    mkdirSync(join(ctl, 'bin'));
    writeFileSync(join(ctl, 'bin', 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(join(ctl, 'gh.log'))}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
if (process.argv.includes('--paginate')) { process.stdout.write('[[]]'); process.exit(0); }
process.stdout.write(JSON.stringify({ id: 5 }));
`);
    chmodSync(join(ctl, 'bin', 'gh'), 0o755);
    const codexBin = writeFakeCodex(ctl, work);
    writeFileSync(join(ctl, 'calls.log'), '');
    writeFileSync(join(ctl, 'main-answer.json'), JSON.stringify(main));
    writeFileSync(join(ctl, 'verify-seq.json'), JSON.stringify(seq));
    if (mainFailFirst) writeFileSync(join(ctl, 'main-fail-first'), '1');
    writeFileSync(join(ctl, 'features.json'), features);
    writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: { title: 't' } }));
    writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
    writeFileSync(join(work, 'input', 'scope.json'), '{}');
    const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head, base: head, tier: 'standard', prevRunId: '', roundId: 'round-12345678',
      attempt: 1, mode, action: 'review', skillSha: 'a'.repeat(40), runId: '42', runUrl: '' };
    writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
      jobStart: { at: new Date().toISOString(), from: 'job' }, lockToken: 't', authorityDigest: 'd',
      context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
        evidence: { head, base: head, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
      current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
      scope: { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] }, checkRunId: 99, pendingGates: [],
      deferrals: { verified: [], rejected: [] }, checkRunExists: true }));
    const env = { ...process.env, MIVO_REVIEW_WORK: work, MIVO_REVIEW_HEALTH_MARKER: join(work, 'no-marker'), MIVO_REVIEW_FEATURES_FILE: join(ctl, 'features.json'),
      LITELLM_CREDENTIALS_JSON: JSON.stringify({ api_key: FAKE_KEY, base_url: 'https://gw.example.com/v1' }), CODEX_BIN: codexBin,
      GH_TOKEN: 'x', CHECKS_TOKEN: 'y', PATH: `${join(ctl, 'bin')}${delimiter}${process.env.PATH}` };
    for (const phase of ['codex', 'publish']) {
      const r = spawnSync(process.execPath, [REVIEW, phase], { env, encoding: 'utf8', timeout: 240_000 });
      assert.equal(r.status, 0, `${phase}:${r.stderr}`);
    }
    const read = (base, file) => (existsSync(join(base, file)) ? readFileSync(join(base, file), 'utf8') : null);
    return { calls: read(ctl, 'calls.log').trim().split('\n').filter(Boolean), result: JSON.parse(read(work, 'out/result.json')),
      comments: read(work, 'comments.json') ? JSON.parse(read(work, 'comments.json')) : null, report: read(work, 'out/report.md'),
      answerOnDisk: read(work, 'answer.json'), finishFile: existsSync(join(work, 'out', 'finish.json')),
      gh: (read(ctl, 'gh.log') ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
  } finally { rmSync(work, { recursive: true, force: true }); rmSync(ctl, { recursive: true, force: true }); }
}

const skip = !inBusinessWindow() && '06:00–07:00 维护窗口内服务器本来就不审';

test('enforce:核对期间磁盘上没有主审答卷和日志;核对完才写 answer.json', { skip }, () => {
  const r = runCase({ seq: [CONFIRMED] });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna', 'verify openai/gpt-6.1-sol clean', 'verify openai/gpt-6.1-sol clean']);
  assert.ok(r.answerOnDisk?.includes(SENTINEL), '核对完之后 answer.json 才落盘(也证明哨兵扫描是有效的)');
});

test('enforce:全部 P1 被推翻/降级 → 不卡、不开 thread、不 Approve;只发 COMMENT,check 为绿,报告写明', { skip }, () => {
  const r = runCase({ seq: [REFUTED, DOWNGRADED] });
  assert.equal(r.comments, null, '不开讨论串');
  assert.equal(r.result.outcome, 'merge-blocked');
  assert.equal(r.result.reviewClean, false, '同一 head 再来不会被沿用成通过');
  assert.equal(r.result.approval.code, 'verifier-overruled');
  assert.match(r.result.reason, /全部被核对员推翻\/降级,不 Approve/);
  assert.equal(r.finishFile, false, '没有走 Approve 的 finish 脚本');
  const review = r.gh.find((c) => c.args.includes('repos/o/r/pulls/7/reviews') && c.args.includes('POST'));
  const body = JSON.parse(review.input);
  assert.equal(body.event, 'COMMENT');
  assert.match(body.body, /核对员全部推翻或降级/);
  assert.match(body.body, /<!-- mivo-review:verifier-overruled head=[0-9a-f]{40} -->$/);
  assert.ok(!r.gh.some((c) => /APPROVE/.test(c.input)), '没有 Approve');
  assert.ok(!r.gh.some((c) => c.args.includes('labels[]=review:merge-ready')), '不挂 merge-ready');
  const check = JSON.parse(r.gh.find((c) => c.args.includes('repos/o/r/check-runs/99')).input);
  assert.equal(check.conclusion, 'success');
  assert.ok(r.report.includes('## 核对员认为不成立（不阻断本 PR）') && r.report.includes('## 核对员降级（不阻断本 PR）'));
  assert.match(r.report, /核对员推翻\/降级了全部卡点（2 条），请人工看一眼再合/);
  assert.ok(r.report.includes('推翻证据：`src/a.ts:1`') && r.report.includes('降级理由：只影响提示文案'));
  assert.equal(r.result.mivo.verifierOverruled.length, 2);
  assert.deepEqual(r.result.mivo.findings, []);
  const v = r.result.mivo.verification;
  assert.equal(v.mode, 'enforce');
  assert.deepEqual(v.items.map((i) => [i.verdict, i.applied, i.model]), [['refuted', 'refuted', 'openai/gpt-6.1-sol'], ['downgraded', 'downgraded', 'openai/gpt-6.1-sol']]);
  assert.ok(v.items.every((i) => Number.isFinite(i.durationMs)));
});

test('enforce:confirmed / 核对员出错 / 推翻没有证据 → 照原样卡;推翻的那条不开 thread', { skip }, () => {
  const mixed = runCase({ seq: [REFUTED, CONFIRMED] });
  assert.equal(mixed.comments.length, 1, '只剩被确认的那条');
  assert.match(mixed.comments[0].body, /^\[P1\] 另一个问题/);
  assert.ok(mixed.report.includes('## 核对员认为不成立（不阻断本 PR）'));
  assert.match(mixed.report, /changes-requested —— 1 条 P0\/P1.*另有 1 条 P1 被核对员推翻\/降级，不阻断。/);
  assert.equal(mixed.result.reviewClean, false);
  const failing = runCase({ seq: ['fail'], mode: 'dry-run' });
  assert.equal(failing.result.outcome, 'findings');
  assert.equal(failing.result.mivo.findings.length, 2, '核对员出错,两条照常卡');
  assert.ok(failing.result.mivo.verification.items.every((item) => item.ok === false && item.applied === null && /退出码 3/.test(item.error)));
  const bluff = runCase({ seq: [{ verdict: 'refuted', evidence: [], note: '凭印象' }], mode: 'dry-run' });
  assert.equal(bluff.result.mivo.findings.length, 2, '推翻没有证据不生效');
  assert.equal(bluff.result.mivo.verification.items[0].rejected, '推翻没有给出证据');
  const notOnHead = runCase({ seq: [{ verdict: 'refuted', evidence: [{ path: 'nope.ts', line: 1 }], note: '假证据' }], mode: 'dry-run' });
  assert.equal(notOnHead.result.mivo.findings.length, 2, '证据在 head 上不存在,推翻不生效');
});

test('enforce:P0 不核、永远卡;只有 P1 进核对员', { skip }, () => {
  const r = runCase({ main: { report: REPORT, findings: [finding({ severity: 'P0', title: '严重事故' }), finding({ title: '普通 P1', bugClass: 'race', line: null })] }, seq: [REFUTED], mode: 'dry-run' });
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['main', 'verify'], '只核了一条 P1');
  assert.equal(r.result.outcome, 'findings');
  assert.deepEqual(r.result.mivo.findings.map((f) => f.severity), ['P0']);
  assert.equal(r.result.mivo.verifierOverruled.length, 1);
});

test('enforce:主审 fallback 到 sol 时核对员改用 luna', { skip }, () => {
  const r = runCase({ seq: [CONFIRMED], mainFailFirst: true, mode: 'dry-run' });
  assert.deepEqual(r.calls.slice(0, 2), ['main openai/gpt-6-luna', 'main openai/gpt-6.1-sol']);
  assert.ok(r.calls.slice(2).every((c) => c === 'verify openai/gpt-6-luna clean'), r.calls.join('|'));
  assert.equal(r.calls.length, 4);
});

test('原本就零 P1 的 PR:不起核对员,行为不变', { skip }, () => {
  const r = runCase({ main: { report: REPORT.replace('changes-requested —— 2 条 P0/P1', 'pass —— 没有 P0/P1。'), findings: [] }, mode: 'dry-run' });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna']);
  assert.equal(r.result.outcome, 'approval');
  assert.equal(r.result.reviewClean, true);
  assert.deepEqual(r.result.mivo.verifierOverruled, []);
});

test('off 只调 1 次模型;shadow 逐条核对但不改发布(comments.json 与 report.md 和 off 逐字节相同)', { skip }, () => {
  const off = runCase({ features: feat({ mode: 'off' }) });
  assert.deepEqual(off.calls, ['main openai/gpt-6-luna']);
  assert.equal(off.result.mivo.verification.mode, 'off');
  const shadow = runCase({ features: feat({ mode: 'shadow' }), seq: [REFUTED, DOWNGRADED] });
  assert.equal(shadow.calls.length, 3);
  assert.deepEqual(shadow.result.mivo.verification.items.map((i) => [i.verdict, i.applied]), [['refuted', null], ['downgraded', null]]);
  assert.ok(off.comments && off.report, '确认 live 模式真的写了 comments.json');
  assert.deepEqual(shadow.comments, off.comments);
  assert.equal(shadow.report, off.report);
  assert.equal(shadow.result.outcome, off.result.outcome);
});

test('非法开关按 off 并写 warning;档位不在名单里也不核对', { skip }, () => {
  const bad = runCase({ features: '{oops', mode: 'dry-run' });
  assert.deepEqual(bad.calls, ['main openai/gpt-6-luna']);
  assert.ok(bad.result.warnings.some((w) => /review-features\.json 读不到或不合法/.test(w)));
  const tier = runCase({ features: feat({ mode: 'enforce', tiers: ['heavy'] }), mode: 'dry-run' });
  assert.deepEqual(tier.calls, ['main openai/gpt-6-luna']);
  assert.deepEqual(tier.result.mivo.verification.skipped, [{ key: null, reason: 'tier' }]);
});

// ── GPT 单审 3 项 P1 的回归 ─────────────────────────────────────────────────
test('同 key 的两条 P1:一条 refuted、一条 confirmed 时,confirmed 的那条仍然阻断', () => {
  const twin = [finding({ title: '同名问题' }), finding({ title: '同名问题', line: null, trigger: '另一个调用方', evidence: [{ path: 'src/a.ts', line: 1 }] })];
  const r = runCase({ main: { report: REPORT, findings: twin }, seq: [REFUTED, CONFIRMED], mode: 'dry-run' });
  assert.equal(r.result.mivo.findings.length, 1, 'confirmed 的那条不能被另一条的推翻带走');
  assert.equal(r.result.mivo.findings[0].trigger, undefined, '结果包只存紧凑形状');
  assert.equal(r.result.mivo.verifierOverruled.length, 1);
  assert.equal(r.result.outcome, 'findings');
});

test('同 key 的两条 P1:超出 maxFindings 没核的那条,不会因另一条被推翻而放行', () => {
  const twin = [finding({ title: '同名问题' }), finding({ title: '同名问题', line: null, trigger: '另一个调用方', evidence: [{ path: 'src/a.ts', line: 1 }] })];
  const r = runCase({ features: feat({ mode: 'enforce', maxFindings: 1 }), main: { report: REPORT, findings: twin }, seq: [REFUTED], mode: 'dry-run' });
  assert.equal(r.calls.filter((c) => c.startsWith('verify')).length, 1);
  assert.deepEqual(r.result.mivo.verification.skipped.map((s) => s.reason), ['max-findings']);
  assert.equal(r.result.mivo.findings.length, 1, '没核到的那条照常阻断');
  assert.equal(r.result.outcome, 'findings');
});

test('同类合并的 pre-existing 问题:任一实例在本 PR 新增行上就照卡,并交给核对员', () => {
  const merged = finding({ origin: 'pre-existing', line: 1, evidence: [{ path: 'src/a.ts', line: 1 }], instances: [{ path: 'src/a.ts', line: 2 }] });
  const r = runCase({ main: { report: REPORT, findings: [merged] }, seq: [CONFIRMED], mode: 'dry-run' });
  assert.equal(r.result.mivo.preexisting.length, 0);
  assert.equal(r.result.mivo.findings.length, 1, '新增行上的实例不能随旧代表位置免责');
  assert.equal(r.result.outcome, 'findings');
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['main', 'verify']);
});

test('核对任务书带上全部位置(instances),并要求全部位置都不成立才能写 refuted', () => {
  const prompt = buildVerifyPrompt({ finding: { severity: 'P1', title: '空指针', path: 'a.ts', line: 3, trigger: 't', behavior: 'b', impact: 'i',
    evidence: [{ path: 'a.ts', line: 3 }], instances: [{ path: 'src/admin.ts', line: 50 }, { path: 'src/b.ts', line: null }] }, workdir: '/w' });
  assert.ok(prompt.includes('`src/admin.ts:50`') && prompt.includes('`src/b.ts`'));
  assert.match(prompt, /同类位置/);
  assert.match(prompt, /全部位置都不成立才能写 refuted/);
  assert.ok(!buildVerifyPrompt({ finding: { severity: 'P1', title: 't', path: 'a.ts' }, workdir: '/w' }).includes('同类位置：'), '没有 instances 时不写这一行');
});

test('全部卡点被推翻/降级的状态写进结果包(verifierOverruledAll),供下一轮保留', { skip }, () => {
  const r = runCase({ seq: [REFUTED, DOWNGRADED] });
  assert.equal(r.result.mivo.verifierOverruledAll, true);
  const partial = runCase({ seq: [REFUTED, CONFIRMED], mode: 'dry-run' });
  assert.equal(partial.result.mivo.verifierOverruledAll, false);
});
