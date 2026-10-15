// codex.mjs — 在隔离工作区里跑 Codex CLI 审查。沿用 Mivo 旧席位已验证的做法:
// 凭据写进 CODEX_HOME、key 只放在 CLI 进程的 CODEX_API_KEY、沙箱子进程排除这些变量;
// 另外整个子进程环境从零构造,GitHub 令牌不可能被继承。产物落盘前把 key 原文替换掉。
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { scrubSecrets } from '../lib/report.mjs';

const PROVIDER_ID = 'company-litellm';
const SHELL_ENV_EXCLUDE = ['CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GH_TOKEN', 'GITHUB_TOKEN'];
export const QUOTA_RE = /\b(?:401|403|429)\b|insufficient_quota|budget|quota|rate.?limit|Unauthorized|Forbidden/i;

export function parseCredentials(raw) {
  let value;
  try { value = JSON.parse(String(raw ?? '')); } catch { throw new Error('LiteLLM 凭据不是合法 JSON'); }
  const apiKey = String(value?.api_key ?? '').trim();
  const baseUrl = String(value?.base_url ?? '').trim();
  if (!apiKey || !baseUrl) throw new Error('LiteLLM 凭据缺少 api_key 或 base_url');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') throw new Error('LiteLLM base_url 必须是 https');
  if (url.hostname === 'api.openai.com') throw new Error('LiteLLM base_url 必须是公司网关');
  if (url.search || url.hash) throw new Error('LiteLLM base_url 不能带 query 或 fragment');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  return { apiKey, baseUrl: url.toString().replace(/\/$/, '') };
}

const toml = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function renderCodexConfig(baseUrl) {
  return [
    `model_provider = ${toml(PROVIDER_ID)}`,
    `[model_providers.${PROVIDER_ID}]`,
    `name = ${toml(PROVIDER_ID)}`,
    `base_url = ${toml(baseUrl)}`,
    'env_key = "CODEX_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[shell_environment_policy]',
    `exclude = [${SHELL_ENV_EXCLUDE.map(toml).join(', ')}]`,
    '',
  ].join('\n');
}

export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets.filter((s) => s && s.length >= 8)) out = out.split(secret).join('***');
  return out;
}

const sizeOf = (file) => { try { return statSync(file).size; } catch { return 0; } };

/**
 * 按完整 JSONL 事件统计一次调用的节奏:一个事件可能分几块写入,换行到达才算一个事件,时间取换行到达那一刻。
 * 时间都相对调用开始,单位秒;maxGapSec 包括「开始到第一个事件」和「最后一个事件到退出」两段空白。
 * usage 取 turn.completed 事件的 usage,没有记 null。只是记录,不能单独当作变慢原因的证据。
 */
export function createEventMeter(startedMs) {
  let pending = '';
  let count = 0;
  let firstMs = null;
  let lastMs = null;
  let maxGapMs = 0;
  let usage = null;
  const take = (line, atMs) => {
    const text = line.trim();
    if (!text) return;
    let event;
    try { event = JSON.parse(text); } catch { return; }
    count += 1;
    maxGapMs = Math.max(maxGapMs, atMs - (lastMs ?? startedMs));
    if (firstMs === null) firstMs = atMs;
    lastMs = atMs;
    if (event?.type === 'turn.completed') usage = event.usage ?? null;
  };
  const sec = (ms) => Math.round(ms / 100) / 10;
  return {
    feed(text, atMs) {
      pending += text;
      for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
        take(pending.slice(0, at), atMs);
        pending = pending.slice(at + 1);
      }
    },
    finish(exitMs) {
      take(pending, exitMs);
      pending = '';
      maxGapMs = Math.max(maxGapMs, exitMs - (lastMs ?? startedMs));
      return {
        firstEventSec: firstMs === null ? null : sec(firstMs - startedMs),
        lastEventSec: lastMs === null ? null : sec(lastMs - startedMs),
        eventCount: count, maxGapSec: sec(maxGapMs), usage,
      };
    },
  };
}

const STDERR_TAIL_LINES = 50;
const STDERR_TAIL_BYTES = 8192;
/** 失败时给人看的 stderr 末尾:先去掉 key 原文和通用凭证格式,再取最后 50 行,最多 8 KB。只进 result.json,不进 PR 评论。 */
export function toStderrTail(stderr, secrets = []) {
  const clean = scrubSecrets(redact(stderr, secrets)).text.trimEnd();
  if (!clean) return '';
  const tail = clean.split('\n').slice(-STDERR_TAIL_LINES).join('\n');
  const bytes = Buffer.from(tail, 'utf8');
  if (bytes.length <= STDERR_TAIL_BYTES) return tail;
  return bytes.subarray(bytes.length - STDERR_TAIL_BYTES).toString('utf8').replace(/^\uFFFD+/, '');
}

/**
 * @returns {Promise<{ok:boolean, answer:object|null, exitCode:number|null, timedOut:boolean, idleKilled:boolean,
 *   quota:boolean, durationMs:number, error:string|null, model:string, effort:string,
 *   firstEventSec:number|null, lastEventSec:number|null, eventCount:number, maxGapSec:number, usage:object|null,
 *   stderrTail?:string}>}  stderrTail 只在失败时有
 */
// 多久没有任何输出算卡住。原来是 12 分钟:2026-10-15 前后的运行记录里,正常跑完的 luna/max 最长停顿 666 秒(#991)、
// 592 秒(#990),#992 停顿 734 秒就被判卡住、换备用模型重跑。max 档长时间思考不出事件,12 分钟落在正常停顿的尾部,放宽到 20 分钟。
export const CODEX_IDLE_MS = 20 * 60_000;
export async function runCodex({ codexBin, workdir, prompt, schema, model, effort, timeoutMs, idleMs = CODEX_IDLE_MS,
  credentials, tmpRoot, label, pathEnv = process.env.PATH }) {
  const started = Date.now();
  if (!existsSync(codexBin)) return fail(`Codex CLI 不存在:${codexBin}`);
  const creds = parseCredentials(credentials);
  const home = join(tmpRoot, `codex-home-${label}`);
  const fakeHome = join(tmpRoot, `home-${label}`);
  const tmp = join(tmpRoot, `tmp-${label}`);
  for (const dir of [home, fakeHome, tmp]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
  writeFileSync(join(home, 'config.toml'), renderCodexConfig(creds.baseUrl), { mode: 0o600 });
  const schemaFile = join(tmpRoot, `schema-${label}.json`);
  writeFileSync(schemaFile, JSON.stringify(schema));
  const stdoutFile = join(tmpRoot, `codex-${label}.stdout`);
  const stderrFile = join(tmpRoot, `codex-${label}.stderr`);
  const answerFile = join(tmpRoot, `codex-${label}.answer.json`);
  for (const file of [stdoutFile, stderrFile, answerFile]) writeFileSync(file, '');
  const env = {
    PATH: pathEnv,
    HOME: fakeHome,
    CODEX_HOME: home,
    CODEX_API_KEY: creds.apiKey,
    TMPDIR: tmp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    GH_CONFIG_DIR: join(fakeHome, '.config', 'gh'),
    npm_config_cache: process.env.npm_config_cache || join(tmp, 'npm-cache'),
  };
  // 审查服务器出网走 runner 服务单元注入的代理;只带代理变量,不带别的。
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY', 'all_proxy', 'ALL_PROXY']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const args = [
    '--ask-for-approval', 'never', 'exec',
    '--sandbox', 'workspace-write',
    '--skip-git-repo-check',
    '--ephemeral',
    '--cd', workdir,
    '--output-schema', schemaFile,
    '--json',
    '--output-last-message', answerFile,
    '--model', model,
    '-c', `model_reasoning_effort=${effort}`,
    '-c', `shell_environment_policy.exclude=${JSON.stringify(SHELL_ENV_EXCLUDE)}`,
    '--', prompt,
  ];
  const { createWriteStream } = await import('node:fs');
  const out = createWriteStream(stdoutFile);
  const err = createWriteStream(stderrFile);
  const child = spawn(codexBin, args, { cwd: workdir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  const meter = createEventMeter(started);
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', (chunk) => meter.feed(decoder.write(chunk), Date.now()));
  let timedOut = false;
  let idleKilled = false;
  let lastGrowth = Date.now();
  let lastSize = 0;
  const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ } setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, 10_000).unref(); };
  const watchdog = setInterval(() => {
    const size = sizeOf(stdoutFile) + sizeOf(answerFile);
    if (size !== lastSize) { lastSize = size; lastGrowth = Date.now(); }
    if (Date.now() - started > timeoutMs) { timedOut = true; kill(); }
    else if (Date.now() - lastGrowth > idleMs) { idleKilled = true; kill(); }
  }, 15_000);
  const exitCode = await new Promise((resolve) => child.on('close', (code) => resolve(code)));
  clearInterval(watchdog);
  meter.feed(decoder.end(), Date.now());
  const events = meter.finish(Date.now());
  await Promise.all([new Promise((r) => out.end(r)), new Promise((r) => err.end(r))]);
  const secrets = [creds.apiKey];
  for (const file of [stdoutFile, stderrFile, answerFile]) writeFileSync(file, redact(readFileSync(file, 'utf8'), secrets));
  const stderr = readFileSync(stderrFile, 'utf8');
  const stdout = readFileSync(stdoutFile, 'utf8');
  const rawAnswer = readFileSync(answerFile, 'utf8').trim();
  const errorEvents = stdout.split('\n').filter((line) => /"type"\s*:\s*"(?:error|turn\.failed)"/.test(line)).join('\n');
  const quota = QUOTA_RE.test(`${stderr.slice(-4000)}\n${errorEvents.slice(-4000)}`) && exitCode !== 0;
  let answer = null;
  if (rawAnswer) {
    try { answer = JSON.parse(rawAnswer); } catch {
      const fenced = rawAnswer.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      try { answer = fenced ? JSON.parse(fenced[1]) : null; } catch { answer = null; }
    }
  }
  const base = { exitCode, timedOut, idleKilled, quota, durationMs: Date.now() - started, model, effort, stdoutFile, stderrFile, answerFile, ...events };
  const failed = (extra) => ({ ...base, ok: false, stderrTail: toStderrTail(stderr, secrets), ...extra });
  if (timedOut) return failed({ answer: null, error: `审查超时(${Math.round(timeoutMs / 60000)} 分钟)` });
  if (idleKilled) return failed({ answer: null, error: `审查 ${Math.round(idleMs / 60000)} 分钟没有任何输出,判定卡住` });
  if (exitCode !== 0) return failed({ answer, error: `codex exec 退出码 ${exitCode}:${tail(stderr) || tail(errorEvents) || '无错误输出'}` });
  if (!answer) return failed({ answer: null, error: '模型没有交出可解析的最终答卷' });
  return { ...base, ok: true, answer, error: null };

  function fail(error) {
    return { ok: false, answer: null, exitCode: null, timedOut: false, idleKilled: false, quota: false, durationMs: Date.now() - started, error, model, effort };
  }
}

const tail = (text) => String(text ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 400);
