// 逐条核验器:纯函数(开关解析、选择、模型挑选、预算)每次都跑;集成部分用假 codex 脚本,在 06:00–07:00 维护窗口内跳过
// (codex() 的 checkHealth 没有测试旁路,不为测试新增生产旁路)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inBusinessWindow } from '../lib/health.mjs';
import { loadFeatures, selectForVerification, pickVerifierModel, runVerification, buildVerifyPrompt, VERIFY_SCHEMA, DEFAULT_FEATURES } from '../lib/verify.mjs';
import { buildSpecManifest, specDigestOf, loadReviewSpec } from '../lib/prompt.mjs';
import { SKILL_ROOT } from '../lib/common.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const FEATURES_JSON = fileURLToPath(new URL('../config/review-features.json', import.meta.url));
const MIN = 60_000;
const feat = (over = {}) => JSON.stringify({ verify: { ...DEFAULT_FEATURES.verify, ...over } });
const loadText = (text) => loadFeatures('f.json', () => text);

test('features:默认文件是 off;缺失、JSON 非法、字段非法都按 off 并给出 warning', () => {
  assert.equal(JSON.parse(readFileSync(FEATURES_JSON, 'utf8')).verify.mode, 'off');
  assert.deepEqual(loadFeatures(FEATURES_JSON).warnings, []);
  assert.equal(loadFeatures(FEATURES_JSON).verify.mode, 'off');
  const missing = loadFeatures('/nonexistent/features.json');
  assert.equal(missing.verify.mode, 'off');
  assert.match(missing.warnings[0], /review-features\.json 读不到或不合法\(.*\),核验器按 off 处理/);
  for (const bad of ['{not json', feat({ mode: 'sometimes' }), feat({ model: 'bad model!' }), feat({ effort: 'ultra' }), feat({ tiers: ['huge'] }),
    feat({ maxFindings: 11 }), feat({ perCallTimeoutMin: 0 }), feat({ budgetMin: 999 }), JSON.stringify({})]) {
    const r = loadText(bad);
    assert.equal(r.verify.mode, 'off', bad);
    assert.equal(r.warnings.length, 1, bad);
  }
  assert.equal(loadText(feat({ mode: 'shadow' })).verify.mode, 'shadow');
  const enforce = loadText(feat({ mode: 'enforce' }));
  assert.equal(enforce.verify.mode, 'shadow');
  assert.deepEqual(enforce.warnings, ['enforce 未实现,按 shadow 处理']);
});

test('features:开关文件不进 specDigest,也不在 prompt.mjs 里出现;loadFeatures 只在 codex 阶段调用', () => {
  const manifest = () => buildSpecManifest({ spec: loadReviewSpec(SKILL_ROOT), tier: 'standard', files: ['src/a.ts'], readFile: () => null, config: '{}' });
  assert.equal(specDigestOf(manifest()), specDigestOf(manifest()));
  assert.ok(!JSON.stringify(manifest()).includes('review-features'));
  assert.ok(!readFileSync(fileURLToPath(new URL('../lib/prompt.mjs', import.meta.url)), 'utf8').includes('review-features'));
  const source = readFileSync(REVIEW, 'utf8');
  const codexSection = source.slice(source.indexOf('async function codex()'), source.indexOf('// ── publish'));
  const calls = (text) => (text.match(/loadFeatures\(/g) ?? []).length;
  assert.equal(calls(source), 1);
  assert.equal(calls(codexSection), 1);
});

test('选择与模型:P0 在前、超出上限算 overflow;配置模型与主审相同时换主模型配置,再相同就不核验', () => {
  const f = (severity, key) => ({ severity, key });
  const { selected, overflow } = selectForVerification([f('P1', 'a'), f('P0', 'b'), f('P1', 'c'), f('P1', 'd')], { maxFindings: 2 });
  assert.deepEqual(selected.map((x) => x.key), ['b', 'a']);
  assert.deepEqual(overflow.map((x) => x.key), ['c', 'd']);
  const configured = { model: 'openai/gpt-6.1-sol', effort: 'medium' };
  const primary = { model: 'openai/gpt-6-luna', effort: 'max' };
  assert.deepEqual(pickVerifierModel({ configured, answeredBy: 'openai/gpt-6-luna', primary }), configured);
  assert.deepEqual(pickVerifierModel({ configured, answeredBy: 'openai/gpt-6.1-sol', primary }), { model: 'openai/gpt-6-luna', effort: 'medium' });
  assert.equal(pickVerifierModel({ configured, answeredBy: 'openai/gpt-6.1-sol', primary: { model: 'openai/gpt-6.1-sol' } }), null);
  assert.doesNotMatch(JSON.stringify(VERIFY_SCHEMA), /maxLength|minItems|maxItems/);
  const prompt = buildVerifyPrompt({ finding: { severity: 'P1', title: '空指针', path: 'a.ts', line: 3, trigger: 't', behavior: 'b', impact: 'i', evidence: [{ path: 'a.ts', line: 3 }] }, workdir: '/w' });
  assert.match(prompt, /## 核验任务/);
  assert.match(prompt, /尝试驳倒/);
  assert.doesNotMatch(prompt, /## Findings|主审报告内容/);
});

test('预算不足 skipped:作业剩余时间不够一次调用、累计用时超过 budgetMin 都跳过;runOne 抛错记失败', async () => {
  const config = { ...DEFAULT_FEATURES.verify, mode: 'shadow', maxFindings: 5 };
  const findings = [{ severity: 'P1', key: 'a' }, { severity: 'P1', key: 'b' }, { severity: 'P1', key: 'c' }];
  const none = await runVerification({ findings, config, answeredBy: 'openai/gpt-6-luna', primary: { model: 'openai/gpt-6-luna' }, remainingMs: () => 5 * MIN, runOne: () => assert.fail('不该调用') });
  assert.deepEqual(none.skipped, findings.map((f) => ({ key: f.key, reason: 'budget' })));
  const ran = [];
  const result = await runVerification({ findings, config, answeredBy: 'openai/gpt-6-luna', primary: { model: 'openai/gpt-6-luna' }, remainingMs: () => 90 * MIN,
    runOne: async (finding) => { ran.push(finding.key); if (finding.key === 'a') throw new Error('boom'); return { ok: true, durationMs: 6 * MIN, answer: { verdict: 'refuted', severityCheck: 'over', evidence: [{ path: 'x.ts', line: 1 }], note: 'n'.repeat(900) } }; } });
  assert.deepEqual(ran, ['a', 'b'], '累计 6 分钟后再加一次 15 分钟超过 20 分钟预算,第三条跳过');
  assert.equal(result.items[0].ok, false);
  assert.match(result.items[0].error, /boom/);
  assert.equal(result.items[1].verdict, 'refuted');
  assert.equal(result.items[1].note.length, 600);
  assert.deepEqual(result.skipped, [{ key: 'c', reason: 'budget' }]);
  const same = await runVerification({ findings, config, answeredBy: config.model, primary: { model: config.model }, remainingMs: () => 90 * MIN, runOne: () => assert.fail('同模型不核验') });
  assert.deepEqual(same.skipped.map((s) => s.reason), ['same-model', 'same-model', 'same-model']);
});

// ── 集成:假 codex ─────────────────────────────────────────────────────────
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' };
const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'changes-requested —— 2 条 P0/P1'].join('\n');
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');
const finding = (over = {}) => ({ severity: 'P1', title: '空指针', trigger: '未登录', behavior: '抛错', impact: '白屏', fix: '判空', verify: '补测',
  evidence: [{ path: 'src/a.ts', line: 2 }], origin: 'introduced', bugClass: 'null-deref', instances: [], supersedes: null,
  path: 'src/a.ts', line: 2, side: 'RIGHT', deferredTo: null, ...over });
const MAIN_ANSWER = { report: REPORT, findings: [finding(), finding({ title: '另一个问题', bugClass: 'race', line: null })] };

// 假 codex:按 --output-schema 文件里有没有 verdict 区分主审和核验;每次调用写一行日志;verify-mode 决定核验成功还是 exit 3。
function writeFakeCodex(dir) {
  const bin = join(dir, 'fake-codex');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('fake-codex 0.0.0'); process.exit(0); }
const at = (flag) => argv[argv.indexOf(flag) + 1];
const schema = fs.readFileSync(at('--output-schema'), 'utf8');
const verify = schema.includes('"verdict"');
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, (verify ? 'verify' : 'main') + '\\n');
if (verify) {
  if (fs.readFileSync(${JSON.stringify(join(dir, 'verify-mode'))}, 'utf8').trim() === 'fail') { process.stderr.write('verifier exploded'); process.exit(3); }
  fs.writeFileSync(at('--output-last-message'), JSON.stringify({ verdict: 'confirmed', severityCheck: 'agree', evidence: [{ path: 'src/a.ts', line: 2 }], note: 'ok' }));
} else {
  fs.writeFileSync(at('--output-last-message'), fs.readFileSync(${JSON.stringify(join(dir, 'main-answer.json'))}, 'utf8'));
}
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  chmodSync(bin, 0o755);
  return bin;
}

function runCase({ features, mode, verifyMode = 'ok' }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-verify-'));
  try {
    for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
    const gitRun = (...args) => { const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: join(work, 'repo'), encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    gitRun('init', '-q');
    mkdirSync(join(work, 'repo', 'src'));
    writeFileSync(join(work, 'repo', 'src', 'a.ts'), 'keep\nadded\n');
    gitRun('add', '.');
    gitRun('commit', '-q', '-m', 'head');
    const head = gitRun('rev-parse', 'HEAD');
    mkdirSync(join(work, 'bin'));
    writeFileSync(join(work, 'bin', 'gh'), '#!/usr/bin/env node\nif (process.argv.includes("--paginate")) { process.stdout.write("[[]]"); process.exit(0); }\nprocess.stdout.write(JSON.stringify({ id: 5 }));\n');
    chmodSync(join(work, 'bin', 'gh'), 0o755);
    const codexBin = writeFakeCodex(work);
    writeFileSync(join(work, 'main-answer.json'), JSON.stringify(MAIN_ANSWER));
    writeFileSync(join(work, 'verify-mode'), verifyMode);
    writeFileSync(join(work, 'features.json'), features);
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
      deferrals: { verified: [], rejected: [] } }));
    const env = { ...process.env, MIVO_REVIEW_WORK: work, MIVO_REVIEW_HEALTH_MARKER: join(work, 'no-marker'), MIVO_REVIEW_FEATURES_FILE: join(work, 'features.json'),
      LITELLM_CREDENTIALS_JSON: JSON.stringify({ api_key: 'xxxxxxxxxxxxxxxx', base_url: 'https://gw.example.com/v1' }), CODEX_BIN: codexBin,
      GH_TOKEN: 'x', CHECKS_TOKEN: 'y', PATH: `${join(work, 'bin')}${delimiter}${process.env.PATH}` };
    for (const phase of ['codex', 'publish']) {
      const r = spawnSync(process.execPath, [REVIEW, phase], { env, encoding: 'utf8', timeout: 240_000 });
      assert.equal(r.status, 0, `${phase}:${r.stderr}`);
    }
    const read = (file) => (existsSync(join(work, file)) ? readFileSync(join(work, file), 'utf8') : null);
    return { calls: (read('calls.log') ?? '').trim().split('\n').filter(Boolean), result: JSON.parse(read('out/result.json')),
      comments: read('comments.json'), report: read('out/report.md') };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

const skip = !inBusinessWindow() && '06:00–07:00 维护窗口内服务器本来就不审';

test('核验器 off 只调 1 次模型;shadow 逐条核验,comments.json 与 report.md 和 off 逐字节相同', { skip }, () => {
  const off = runCase({ features: feat({ mode: 'off' }), mode: 'live' });
  assert.deepEqual(off.calls, ['main']);
  assert.equal(off.result.mivo.verification.mode, 'off');
  const shadow = runCase({ features: feat({ mode: 'shadow' }), mode: 'live' });
  assert.deepEqual(shadow.calls, ['main', 'verify', 'verify']);
  assert.equal(shadow.result.mivo.verification.mode, 'shadow');
  assert.equal(shadow.result.mivo.verification.items.length, 2);
  assert.ok(shadow.result.mivo.verification.items.every((item) => item.ok && item.verdict === 'confirmed' && /^[0-9a-f]{12}$/.test(item.key)));
  assert.ok(off.comments && off.report, '确认 live 模式真的写了 comments.json');
  assert.equal(shadow.comments, off.comments);
  assert.equal(shadow.report, off.report);
  assert.equal(shadow.result.outcome, off.result.outcome);
});

test('核验失败不改 outcome:核验器 exit 3 时 outcome / reason / reviewClean / findings 和 off 相同', { skip }, () => {
  const off = runCase({ features: feat({ mode: 'off' }), mode: 'dry-run' });
  const failing = runCase({ features: feat({ mode: 'shadow' }), mode: 'dry-run', verifyMode: 'fail' });
  assert.deepEqual(failing.calls, ['main', 'verify', 'verify']);
  assert.equal(failing.result.outcome, 'findings');
  for (const key of ['outcome', 'reason', 'reviewClean']) assert.equal(failing.result[key], off.result[key], key);
  assert.deepEqual(failing.result.mivo.findings, off.result.mivo.findings);
  assert.ok(failing.result.mivo.verification.items.every((item) => item.ok === false && /退出码 3/.test(item.error)));
});

test('非法开关按 off 并写 warning;档位不在名单里 shadow 也不核验', { skip }, () => {
  const bad = runCase({ features: '{oops', mode: 'dry-run' });
  assert.deepEqual(bad.calls, ['main']);
  assert.ok(bad.result.warnings.some((w) => /review-features\.json 读不到或不合法/.test(w)));
  const tier = runCase({ features: feat({ mode: 'shadow', tiers: ['heavy'] }), mode: 'dry-run' });
  assert.deepEqual(tier.calls, ['main']);
  assert.deepEqual(tier.result.mivo.verification.skipped, [{ key: null, reason: 'tier' }]);
});
