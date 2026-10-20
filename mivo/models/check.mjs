#!/usr/bin/env node
// check.mjs — 服务器上的审查模型验证(Mivo 的 review-model-check.yml 调用;这一步只拿模型网关凭据,没有 GitHub 令牌)。
// 用实际审查 key 做两件事:
//   1. 查网关的模型清单(GET /models),记下有没有目标模型,以及网关上所有模型(给人挑);
//   2. 让 Codex CLI 用目标模型和思考档位跑一次最小任务:必须调用 shell 读出工作目录里的随机数,并按 JSON schema 交卷。
//      交回的随机数对得上,才算「模型存在 + 档位被接受 + 工具调用 + 结构化输出」都成立。
// 主 key 必测;配了备用 key 也测一次。放行规则在 lib/model-switch.mjs 的 toCheckVerdict(由 Mini 的 switch.mjs 判)。
// 输入:INPUT_ROLE / INPUT_MODEL / INPUT_EFFORT / INPUT_REQUEST_ID;输出:$MIVO_MODEL_CHECK_OUT/check.json。退出码恒为 0,结论在文件里。
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { run, writeJson, nowIso } from '../lib/common.mjs';
import { ROLE_EFFORTS, SERVER_MODEL_RE, ROLE_ENV } from '../lib/models.mjs';
import { REQUEST_ID_RE } from '../lib/model-switch.mjs';
import { inBusinessWindow } from '../lib/health.mjs';
import { scrubSecrets } from '../lib/report.mjs';
import { runCodex, readCodexVersion, redact } from '../server/codex.mjs';
import { toKeyRing, keyTexts } from '../server/keys.mjs';

const SMOKE_TIMEOUT_MS = 10 * 60_000;
const SMOKE_SCHEMA = { type: 'object', additionalProperties: false, required: ['nonce'], properties: { nonce: { type: 'string' } } };
const codexBin = () => process.env.CODEX_BIN || '/AIGC_Group/github-actions-runner/mivo-review-tools/bin/codex';

/** 网关模型清单。用 curl(认 runner 的代理变量);key 经 stdin 的 curl 配置传入,不出现在进程参数里。 */
export function listModels(creds, { runCmd = run } = {}) {
  const config = [`url = "${creds.baseUrl}/models"`, `header = "Authorization: Bearer ${creds.apiKey}"`].join('\n');
  const r = runCmd('curl', ['-sS', '--max-time', '30', '-K', '-', '-w', '\n%{http_code}'], { input: config, allowFail: true, timeoutMs: 45_000 });
  const lines = String(r.stdout ?? '').trimEnd().split('\n');
  const status = Number(lines.pop());
  if (!r.ok || status !== 200) return { ok: false, status: Number.isFinite(status) ? status : null, ids: [], error: `模型清单读取失败(HTTP ${status || '未知'})` };
  try {
    const ids = (JSON.parse(lines.join('\n')).data ?? []).map((m) => String(m?.id ?? '')).filter(Boolean);
    return { ok: true, status, ids, error: null };
  } catch { return { ok: false, status, ids: [], error: '模型清单不是合法 JSON' }; }
}

const smokePrompt = () => [
  '这是审查机的模型连通性测试。',
  '在当前工作目录运行 shell 命令 `cat nonce.txt`,把输出原样(去掉首尾空白)填进 JSON 的 nonce 字段。',
  '不要猜,不要修改任何文件。只交一个 JSON 对象:{"nonce": "..."}。',
].join('\n');

async function smoke({ creds, ring, model, effort, tmpRoot, label, runModel }) {
  const workdir = join(tmpRoot, `work-${label}`);
  mkdirSync(workdir, { recursive: true });
  const nonce = randomBytes(12).toString('hex');
  writeFileSync(join(workdir, 'nonce.txt'), `${nonce}\n`);
  const result = await runModel({ codexBin: codexBin(), workdir, prompt: smokePrompt(), schema: SMOKE_SCHEMA, model, effort,
    timeoutMs: SMOKE_TIMEOUT_MS, credentials: creds, redactKeys: keyTexts(ring), tmpRoot, label });
  const answered = String(result.answer?.nonce ?? '').trim();
  const ok = result.ok && answered === nonce;
  return {
    ok, durationMs: result.durationMs, keyFailure: result.keyFailure ?? null, outputStarted: result.outputStarted === true,
    error: ok ? null : result.ok ? '模型交回的随机数对不上(没有真的调用工具)' : result.error,
    usage: result.usage ?? null,
  };
}

async function checkKey({ name, creds, ring, model, effort, tmpRoot, runModel, runCmd }) {
  if (!creds) return { configured: false };
  const listed = listModels(creds, { runCmd });
  const models = { ok: listed.ok, status: listed.status, error: listed.error, count: listed.ids.length,
    present: listed.ok ? listed.ids.includes(model) : null, available: [...listed.ids].sort().slice(0, 200) };
  return { configured: true, models, smoke: await smoke({ creds, ring, model, effort, tmpRoot, label: `check-${name}`, runModel }) };
}

/** 主流程(可注入 runModel / runCmd 做测试)。 */
export async function runCheck({ env = process.env, runModel = runCodex, runCmd = run, now = () => new Date() } = {}) {
  const role = String(env.INPUT_ROLE ?? '').trim();
  const model = String(env.INPUT_MODEL ?? '').trim();
  const effort = String(env.INPUT_EFFORT ?? '').trim();
  const requestId = String(env.INPUT_REQUEST_ID ?? '').trim();
  const base = { version: 1, requestId, role, model, effort, runId: env.GITHUB_RUN_ID || null, at: nowIso(), ok: false, reason: '', keys: {}, warnings: [] };
  const problem = !ROLE_ENV[role] ? '角色不合法' : !SERVER_MODEL_RE.test(model) ? '模型 id 不合法' : !ROLE_EFFORTS.includes(effort) ? '思考档位不合法'
    : !REQUEST_ID_RE.test(requestId) ? 'request_id 不合法' : null;
  if (problem) return { ...base, reason: problem };
  if (!inBusinessWindow(now())) return { ...base, reason: '北京时间 06:00–07:00 是审查机维护窗口(Codex CLI 可能正在升级),请 07:00 以后再试' };
  const ring = toKeyRing(env, now().getTime());
  if (!ring.primary && !ring.backup) return { ...base, reason: '服务器上没有可用的模型网关凭据', warnings: ring.warnings };
  const tmpRoot = mkdtempSync(join(env.RUNNER_TEMP || '/tmp', 'mivo-model-check-'));
  try {
    const args = { ring, model, effort, tmpRoot, runModel, runCmd };
    const primary = await checkKey({ ...args, name: 'primary', creds: ring.primary });
    const backup = await checkKey({ ...args, name: 'backup', creds: ring.backup });
    const ok = primary.smoke?.ok === true || (Boolean(primary.smoke?.keyFailure || !primary.configured) && backup.smoke?.ok === true);
    const reason = ok ? '验证通过' : (primary.smoke?.error || backup.smoke?.error || '验证没有通过');
    const clean = (value) => JSON.parse(scrubSecrets(redact(JSON.stringify(value), keyTexts(ring))).text);
    return clean({ ...base, ok, reason, keys: { primary, backup }, warnings: ring.warnings, codexVersion: readCodexVersion(codexBin()) });
  } finally { rmSync(tmpRoot, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const out = process.env.MIVO_MODEL_CHECK_OUT;
  if (!out) { console.error('缺少 MIVO_MODEL_CHECK_OUT'); process.exit(1); }
  mkdirSync(out, { recursive: true });
  let result;
  try { result = await runCheck(); } catch (error) {
    result = { version: 1, ok: false, reason: `验证脚本异常:${String(error?.message ?? error).slice(0, 300)}`, requestId: process.env.INPUT_REQUEST_ID ?? '' };
  }
  writeJson(join(out, 'check.json'), result);
  console.log(`${result.ok ? 'ok' : 'failed'}: ${result.reason}`);
}
