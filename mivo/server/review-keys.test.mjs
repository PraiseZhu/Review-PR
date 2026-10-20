// review.mjs codex 阶段的主 key / 备用 key 与角色变量(维护者 2026-10-18,规则见 keys.mjs):
// 假 codex 按 CODEX_API_KEY 是哪把 key 决定行为(成功 / 开头 401 / 审到一半 401 / 非 key 失败),每次调用记一行日志。
// 只跑 codex 阶段,看 state.json 里的 codex.attempts 与 codex.credential;不碰 GitHub。06:00–07:00 维护窗口内跳过(同 review-verify)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inBusinessWindow } from '../lib/health.mjs';
import { toKeyStatus, toKeyStatusReason } from '../lib/key-status.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const PRIMARY_KEY = 'sk-primary-PPPPPPPPPPPP';
const BACKUP_KEY = 'sk-backup-BBBBBBBBBBBB';
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' };
const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'approve'].join('\n');
const CLEAN = { report: REPORT, findings: [] };
const P1 = { severity: 'P1', title: '空指针', trigger: '未登录', behavior: '抛错', impact: '白屏', fix: '判空', verify: '补测',
  evidence: [{ path: 'src/a.ts', line: 2 }], origin: 'introduced', bugClass: 'null-deref', instances: [], supersedes: null,
  path: 'src/a.ts', line: 2, side: 'RIGHT', deferredTo: null };
const ONE_P1 = { report: REPORT.replace('approve', 'changes-requested —— 1 条 P0/P1/P2'), findings: [P1] };
const CONFIRMED = { verdict: 'confirmed', evidence: [{ path: 'src/a.ts', line: 2 }], note: '成立' };

// 行为:ok | 401 | mid401 | verify401(主审成功、核对员 401)| blocked(没有状态码的 key 错误)| 500(正文带 rate limit 的网关 5xx)| explode(非 key 失败)。按 key 读 ctl/mode-primary、ctl/mode-backup。
function writeFakeCodex(ctl) {
  const bin = join(ctl, 'fake-codex');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('fake-codex 0.0.0'); process.exit(0); }
const at = (flag) => argv[argv.indexOf(flag) + 1];
const ctl = ${JSON.stringify(ctl)};
const key = process.env.CODEX_API_KEY === ${JSON.stringify(PRIMARY_KEY)} ? 'primary' : process.env.CODEX_API_KEY === ${JSON.stringify(BACKUP_KEY)} ? 'backup' : 'unknown';
const verify = fs.readFileSync(at('--output-schema'), 'utf8').includes('"verdict"');
const mode = fs.readFileSync(path.join(ctl, 'mode-' + key), 'utf8').trim();
fs.appendFileSync(path.join(ctl, 'calls.log'), (verify ? 'verify ' : 'main ') + at('--model') + ' ' + at('-c').replace('model_reasoning_effort=', '') + ' ' + key + '\\n');
const fail401 = () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); // 失败的那次也花时间,核对员预算要算上它
  const msg = 'unexpected status 401 Unauthorized: Authentication Error, Invalid proxy server token passed. Received API Key = sk-...0000';
  console.log(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (' + msg + ')' }));
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: msg } }));
  process.stderr.write('key in stderr: ' + process.env.CODEX_API_KEY + '\\n');
  process.exit(1);
};
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Model metadata not found' } }));
if (mode === '401' || (mode === 'verify401' && verify)) fail401();
if (mode === 'mid401') { console.log(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } })); fail401(); }
if (mode === 'blocked') { console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'Authentication Error, Key is blocked. Update via /key/unblock' } })); process.exit(1); }
if (mode === '500') { console.log(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } })); console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'unexpected status 500 Internal Server Error: rate limit exceeded upstream' } })); process.exit(1); }
if (mode === 'explode') { process.stderr.write('primary exploded'); process.exit(1); }
fs.writeFileSync(at('--output-last-message'), fs.readFileSync(path.join(ctl, verify ? 'verify-answer.json' : 'main-answer.json'), 'utf8'));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  chmodSync(bin, 0o755);
  return bin;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => { const full = join(dir, name); return statSync(full).isDirectory() ? walk(full) : [full]; });
}

function runCodexPhase({ primary = 'ok', backup = 'ok', withBackup = true, main = CLEAN, verifyMode = 'off', env: extraEnv = {} }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-keys-'));
  const ctl = mkdtempSync(join(tmpdir(), 'mivo-review-keys-ctl-'));
  try {
    for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
    const gitRun = (...args) => { const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: join(work, 'repo'), encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    gitRun('init', '-q');
    mkdirSync(join(work, 'repo', 'src'));
    writeFileSync(join(work, 'repo', 'src', 'a.ts'), 'keep\nadded\n');
    gitRun('add', '.');
    gitRun('commit', '-q', '-m', 'head');
    const head = gitRun('rev-parse', 'HEAD');
    writeFileSync(join(ctl, 'calls.log'), '');
    writeFileSync(join(ctl, 'mode-primary'), primary);
    writeFileSync(join(ctl, 'mode-backup'), backup);
    writeFileSync(join(ctl, 'mode-unknown'), 'explode');
    writeFileSync(join(ctl, 'main-answer.json'), JSON.stringify(main));
    writeFileSync(join(ctl, 'verify-answer.json'), JSON.stringify(CONFIRMED));
    writeFileSync(join(ctl, 'features.json'), JSON.stringify({ verify: { mode: verifyMode, model: 'openai/gpt-6.1-sol', effort: 'medium', tiers: ['standard', 'heavy'], maxFindings: 3, perCallTimeoutMin: 15, budgetMin: 20 } }));
    writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: { title: 't' } }));
    writeFileSync(join(work, 'input', 'pr.diff'), ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n'));
    writeFileSync(join(work, 'input', 'scope.json'), '{}');
    const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head, base: head, tier: 'standard', prevRunId: '', roundId: 'round-12345678',
      attempt: 1, mode: 'dry-run', action: 'review', skillSha: 'a'.repeat(40), runId: '42', runUrl: '' };
    writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
      jobStart: { at: new Date().toISOString(), from: 'job' },
      context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
        evidence: { head, base: head, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
      current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
      scope: { mode: 'full', reason: '没有上一轮审查记录', files: ['src/a.ts'], previousFindings: [] }, pendingGates: [],
      deferrals: { verified: [], rejected: [] } }));
    const env = { ...process.env, MIVO_REVIEW_WORK: work, MIVO_REVIEW_HEALTH_MARKER: join(work, 'no-marker'), MIVO_REVIEW_FEATURES_FILE: join(ctl, 'features.json'),
      LITELLM_CREDENTIALS_JSON: JSON.stringify({ api_key: PRIMARY_KEY, base_url: 'https://gw.example.com/v1' }), CODEX_BIN: writeFakeCodex(ctl),
      LITELLM_BACKUP_API_KEY: withBackup ? BACKUP_KEY : '', LITELLM_BACKUP_BASE_URL: '', MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL: '',
      MIVO_REVIEW_ROLE_PRIMARY: '', MIVO_REVIEW_ROLE_FALLBACK: '', MIVO_REVIEW_ROLE_VERIFIER: '', ...extraEnv };
    const r = spawnSync(process.execPath, [REVIEW, 'codex'], { env, encoding: 'utf8', timeout: 240_000 });
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(readFileSync(join(work, 'state.json'), 'utf8'));
    const leaked = walk(work).filter((file) => { const text = readFileSync(file, 'utf8'); return text.includes(PRIMARY_KEY) || text.includes(BACKUP_KEY); });
    return { calls: readFileSync(join(ctl, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean), codex: state.codex, verification: state.verification, warnings: state.warnings, leaked };
  } finally {
    spawnSync('chmod', ['-R', 'u+rwx', work]);
    rmSync(work, { recursive: true, force: true });
    rmSync(ctl, { recursive: true, force: true });
  }
}

const skip = !inBusinessWindow() && '06:00–07:00 维护窗口内服务器本来就不审';

test('正常情况不换 key:主 key 成功,只调一次', { skip }, () => {
  const r = runCodexPhase({});
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary']);
  assert.equal(r.codex.attempts.length, 1);
  assert.equal(r.codex.attempts[0].credential, 'primary');
  assert.equal(r.codex.credential.switched, null);
  assert.equal(r.codex.credential.primaryOk, true);
  assert.deepEqual(r.leaked, []);
});

test('主 key 开头就 401:同模型同档位换备用 key 重跑一次,不占备用模型名额;产物里没有任何一把 key', { skip }, () => {
  const r = runCodexPhase({ primary: '401' });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary', 'main openai/gpt-6-luna max backup']);
  assert.equal(r.codex.attempts.length, 1);
  const [attempt] = r.codex.attempts;
  assert.equal(attempt.ok, true);
  assert.equal(attempt.credential, 'backup');
  assert.equal(attempt.quota, false);
  assert.deepEqual({ kind: attempt.keySwitch.kind, status: attempt.keySwitch.status, midRun: attempt.keySwitch.midRun, retried: attempt.keySwitch.retried },
    { kind: 'auth', status: 401, midRun: false, retried: true });
  assert.equal(r.codex.credential.active, 'backup');
  assert.equal(r.codex.credential.primaryFailedMidRun, false);
  assert.deepEqual(r.leaked, []);
});

test('主 key 审到一半 401:换备用 key 重跑并记 primaryFailedMidRun(Mini 据此进冷却期)', { skip }, () => {
  const r = runCodexPhase({ primary: 'mid401' });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary', 'main openai/gpt-6-luna max backup']);
  assert.equal(r.codex.attempts[0].ok, true);
  assert.equal(r.codex.credential.primaryFailedMidRun, true);
});

test('两把 key 都 401:按额度类处理(quota,Mini 暂停 60 分钟),不再换备用模型', { skip }, () => {
  const r = runCodexPhase({ primary: '401', backup: '401' });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary', 'main openai/gpt-6-luna max backup']);
  assert.equal(r.codex.attempts.length, 1);
  assert.equal(r.codex.attempts[0].quota, true);
  assert.deepEqual(r.codex.attempts[0].keyFailure, { kind: 'auth', status: 401 });
  assert.deepEqual(r.leaked, []);
});

test('没有备用 key:主 key 401 照旧按额度类处理,不重跑', { skip }, () => {
  const r = runCodexPhase({ primary: '401', withBackup: false });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary']);
  assert.equal(r.codex.attempts[0].quota, true);
  assert.equal(r.codex.credential.backupConfigured, false);
});

test('非 key 失败不换 key:照旧换备用模型,仍用主 key', { skip }, () => {
  const r = runCodexPhase({ primary: 'explode', backup: 'ok' });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary', 'main openai/gpt-6.1-sol medium primary']);
  assert.equal(r.codex.attempts.length, 2);
  assert.equal(r.codex.credential.switched, null);
});

test('冷却期内直接用备用 key;角色变量决定主审和备用模型', { skip }, () => {
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  const r = runCodexPhase({ primary: 'explode', backup: 'explode', env: { MIVO_REVIEW_KEY_PREFER_BACKUP_UNTIL: until,
    MIVO_REVIEW_ROLE_PRIMARY: JSON.stringify({ model: 'openai/gpt-7', effort: 'ultra' }), MIVO_REVIEW_ROLE_FALLBACK: JSON.stringify({ model: 'openai/gpt-7-mini', effort: 'low' }) } });
  assert.deepEqual(r.calls, ['main openai/gpt-7 ultra backup', 'main openai/gpt-7-mini low backup']);
  assert.equal(r.codex.credential.startedOn, 'backup');
  assert.equal(r.codex.credential.preferBackup, true);
});

test('角色变量格式不对:用默认模型并写告警', { skip }, () => {
  const r = runCodexPhase({ env: { MIVO_REVIEW_ROLE_PRIMARY: '{oops' } });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary']);
  assert.match(r.warnings.join('\n'), /MIVO_REVIEW_ROLE_PRIMARY 不是合法 JSON/);
});

test('核对员:角色变量覆盖开关文件的模型;主审换过 key 后核对员也用备用 key', { skip }, () => {
  const r = runCodexPhase({ primary: '401', main: ONE_P1, verifyMode: 'enforce',
    env: { MIVO_REVIEW_ROLE_VERIFIER: JSON.stringify({ model: 'openai/gpt-7-verify', effort: 'high' }) } });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary', 'main openai/gpt-6-luna max backup', 'verify openai/gpt-7-verify high backup']);
  assert.deepEqual(r.leaked, []);
});

test('两把 key 都报没有状态码的 key 错误(key is blocked):也按额度类处理,不再换备用模型', { skip }, () => {
  const r = runCodexPhase({ primary: 'blocked', backup: 'blocked' });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary', 'main openai/gpt-6-luna max backup']);
  assert.equal(r.codex.attempts.length, 1);
  assert.equal(r.codex.attempts[0].quota, true);
});

test('网关 5xx 即使正文带 rate limit 也不换 key、不进冷却期(是否换备用模型照旧由 QUOTA_RE 决定)', { skip }, () => {
  const r = runCodexPhase({ primary: '500' });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary']);
  assert.equal(r.codex.attempts[0].keyFailure, null);
  assert.equal(r.codex.credential.switched, null);
  assert.equal(r.codex.credential.primaryFailedMidRun, false);
});

test('核对员调用时两把 key 都报 key 错误:key 状态是 down(不是 backup),原因写明是核对员', { skip }, () => {
  const r = runCodexPhase({ primary: 'verify401', backup: 'verify401', main: ONE_P1, verifyMode: 'enforce' });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary', 'verify openai/gpt-6.1-sol medium primary', 'verify openai/gpt-6.1-sol medium backup']);
  assert.equal(r.codex.attempts.length, 1);
  assert.equal(r.codex.attempts[0].ok, true);
  assert.deepEqual(r.codex.credential.down, { kind: 'auth', status: 401, credential: 'backup', phase: 'verify' });
  const status = toKeyStatus(r.codex.credential, r.codex.attempts);
  assert.equal(status, 'down');
  assert.match(toKeyStatusReason(status, r.codex.credential, r.codex.attempts), /核对员调用时备用 key 也报 key 错误/);
  assert.deepEqual(r.leaked, []);
});

test('核对员换 key 重跑:被换掉的那次时长也算进核对员预算', { skip }, () => {
  const r = runCodexPhase({ primary: 'verify401', backup: 'ok', main: ONE_P1, verifyMode: 'enforce' });
  assert.deepEqual(r.calls, ['main openai/gpt-6-luna max primary', 'verify openai/gpt-6.1-sol medium primary', 'verify openai/gpt-6.1-sol medium backup']);
  assert.equal(r.verification.items.length, 1);
  assert.equal(r.verification.items[0].ok, true);
  assert.ok(r.verification.items[0].durationMs >= 400, `durationMs=${r.verification.items[0].durationMs}`);
  assert.equal(r.codex.credential.down, null);
  assert.equal(toKeyStatus(r.codex.credential, r.codex.attempts), 'backup');
});
