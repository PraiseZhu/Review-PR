// codex.mjs — 在隔离工作区里跑 Codex CLI 审查。沿用 Mivo 旧席位已验证的做法:
// 凭据写进 CODEX_HOME、key 只放在 CLI 进程的 CODEX_API_KEY、沙箱子进程排除这些变量;
// 另外整个子进程环境从零构造,GitHub 令牌不可能被继承。产物落盘前把 key 原文替换掉。
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { scrubSecrets } from '../lib/report.mjs';

const PROVIDER_ID = 'company-litellm';
const SHELL_ENV_EXCLUDE = ['CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GH_TOKEN', 'GITHUB_TOKEN'];
export const QUOTA_RE = /\b(?:401|403|429)\b|insufficient_quota|budget|quota|rate.?limit|Unauthorized|Forbidden/i;

/**
 * 一次失败调用的最终错误:取最后一个 turn.failed 的 error.message;没有就取最后一个不是「Reconnecting...」的顶层 error 事件。
 * 只看 CLI 自己的结构化事件,不看 stderr 和模型输出:命令输出、模型文字里出现 401 之类的字样不能触发换 key。
 */
export function toFinalError(stdout) {
  let failed = null;
  let error = null;
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.includes('"type"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'turn.failed' && typeof event.error?.message === 'string') failed = event.error.message;
    else if (event?.type === 'error' && typeof event.message === 'string' && !/^Reconnecting\.\.\./.test(event.message)) error = event.message;
  }
  return failed ?? error;
}

/**
 * 最终错误是不是「key 本身的问题」(维护者 2026-10-18 定的换备用 key 条件):认证失败(401、key 无效/过期/被封)、
 * 额度或预算用完、没有该模型的权限(403)、限流(429,CLI 自己已经退避重试过 5 次)。其余(5xx、断网、参数错、
 * 模型不存在、答卷不合格、超时、卡住)返回 null,不换 key。网关是 LiteLLM:401 样本见 codex.test.mjs(2026-10-18 实测)。
 */
export function toKeyFailure(message) {
  const text = String(message ?? '');
  if (!text) return null;
  const status = Number(text.match(/unexpected status (\d{3})/)?.[1]) || null;
  if (status === 401 || /Authentication Error|token_not_found|invalid[_ ]api[_ ]key|expired[_ ]key|key is blocked/i.test(text)) return { kind: 'auth', status };
  if (/budget_exceeded|budget has been exceeded|ExceededBudget|exceeded (?:the |your )?(?:current )?(?:budget|quota)|insufficient_quota/i.test(text)) return { kind: 'budget', status };
  if (status === 403 || /not allowed to access model|model_access_denied/i.test(text)) return { kind: 'access', status };
  if (status === 429 || /rate.?limit|too many requests|max parallel request/i.test(text)) return { kind: 'rate-limit', status };
  return null;
}

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
    // 不读 PR head 里的 AGENTS.md:规则只认任务书给的 base 版本,PR 改不了审查规则(实测默认会读)
    'project_doc_max_bytes = 0',
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

// 退避重试:每个路径最多重试 3 次,间隔 200/400/600ms(只对 EBUSY/ENOTEMPTY/EPERM 等可重试错误生效)。
const RUN_ARTIFACT_RM = { recursive: true, force: true, maxRetries: 3, retryDelay: 200 };
/**
 * 删掉一次 runCodex 在 tmpRoot 下的全部痕迹(CLI 输出日志、stderr、最后一条消息、CODEX_HOME、HOME、TMPDIR)。
 * 主审交卷并取完计量数据后调用:核对员运行期间,磁盘上不能有主审的答卷和日志(沙箱只限写不限读)。只留 schema 文件(只有 schema,没有答案)。
 * 永不抛错:六个路径各删各的,清不掉的(CLI 退出后仍有孙进程往 TMPDIR 写文件会让 rmdir 报 ENOTEMPTY)不影响别的路径,
 * 也不能让已经审完的结果作废。返回清不掉的 [{name, code}](只带文件名和错误码,不带路径);调用方负责记告警和决定后续。
 * 用异步的 fs.promises.rm:它的 maxRetries 才会真的按 retryDelay 退避;同步 rmSync 在 Node 24 上遇到 ENOTEMPTY 几乎不等待(实测 50ms 内就放弃)。
 */
export async function removeRunArtifacts(tmpRoot, label, remove = rm) {
  const names = [`codex-${label}.stdout`, `codex-${label}.stderr`, `codex-${label}.answer.json`,
    `codex-home-${label}`, `home-${label}`, `tmp-${label}`];
  const settled = await Promise.allSettled(names.map(async (name) => remove(join(tmpRoot, name), RUN_ARTIFACT_RM)));
  return settled.flatMap((result, i) => (result.status === 'rejected'
    ? [{ name: names[i], code: String(result.reason?.code ?? result.reason?.name ?? 'UNKNOWN') }] : []));
}

const sizeOf = (file) => { try { return statSync(file).size; } catch { return 0; } };

/**
 * CLI 的版本串(`codex --version` 输出的第一行,去掉首尾空白),写进结果包好让失败排查不用再去服务器上翻升级日志。
 * 只是记录:CLI 不存在、命令报错或超时都返回 null,绝不能让审查因此中断。
 */
export function readCodexVersion(bin, exec = execFileSync) {
  try {
    const first = String(exec(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })).split('\n')[0].trim();
    return first || null;
  } catch {
    return null;
  }
}

/**
 * 按完整 JSONL 事件统计一次调用的节奏:一个事件可能分几块写入,换行到达才算一个事件,时间取换行到达那一刻。
 * 时间都相对调用开始,单位秒;maxGapSec 包括「开始到第一个事件」和「最后一个事件到退出」两段空白。
 * usage 取 turn.completed 事件的 usage,没有记 null。只是记录,不能单独当作变慢原因的证据。
 * outputItems 是模型真正产出的条目数(item.* 事件,不算 type=error 的条目):CLI 开场就会发一条
 * 「Model metadata ... not found」的 error 条目(0.146 实测),那不是模型输出。换备用 key 时据此判断这次调用有没有开始干活。
 */
export function createEventMeter(startedMs) {
  let pending = '';
  let count = 0;
  let outputItems = 0;
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
    if (String(event?.type ?? '').startsWith('item.') && event?.item?.type !== 'error') outputItems += 1;
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
        eventCount: count, outputItems, maxGapSec: sec(maxGapMs), usage,
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
 * credentials 可以是 LiteLLM 凭据 JSON 文本,也可以是 parseCredentials 的结果 {apiKey, baseUrl}(备用 key 由 keys.mjs 组装)。
 * redactKeys:除本次用的 key 外还要从产物里抹掉的 key(主备两把都抹,产物里不能出现任何一把)。
 * keyFailure 只在失败、非超时/卡住时有值:toKeyFailure(最终错误);outputStarted 表示模型已经产出过条目。
 * @returns {Promise<{ok:boolean, answer:object|null, exitCode:number|null, timedOut:boolean, idleKilled:boolean,
 *   quota:boolean, keyFailure:{kind:string,status:number|null}|null, outputStarted:boolean, durationMs:number, error:string|null, model:string, effort:string,
 *   firstEventSec:number|null, lastEventSec:number|null, eventCount:number, outputItems:number, maxGapSec:number, usage:object|null,
 *   stderrTail?:string}>}  stderrTail 只在失败时有
 */
// 多久没有任何输出算卡住。原来是 12 分钟:2026-10-15 前后的运行记录里,正常跑完的 luna/max 最长停顿 666 秒(#991)、
// 592 秒(#990),#992 停顿 734 秒就被判卡住、换备用模型重跑。max 档长时间思考不出事件,12 分钟落在正常停顿的尾部,放宽到 20 分钟。
export const CODEX_IDLE_MS = 20 * 60_000;
export async function runCodex({ codexBin, workdir, prompt, schema, model, effort, timeoutMs, idleMs = CODEX_IDLE_MS,
  credentials, redactKeys = [], tmpRoot, label, pathEnv = process.env.PATH }) {
  const started = Date.now();
  if (!existsSync(codexBin)) return fail(`Codex CLI 不存在:${codexBin}`);
  const creds = credentials && typeof credentials === 'object' && credentials.apiKey ? credentials : parseCredentials(credentials);
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
  const secrets = [creds.apiKey, ...redactKeys];
  for (const file of [stdoutFile, stderrFile, answerFile]) writeFileSync(file, redact(readFileSync(file, 'utf8'), secrets));
  const stderr = readFileSync(stderrFile, 'utf8');
  const stdout = readFileSync(stdoutFile, 'utf8');
  const rawAnswer = readFileSync(answerFile, 'utf8').trim();
  const errorEvents = stdout.split('\n').filter((line) => /"type"\s*:\s*"(?:error|turn\.failed)"/.test(line)).join('\n');
  const quota = QUOTA_RE.test(`${stderr.slice(-4000)}\n${errorEvents.slice(-4000)}`) && exitCode !== 0;
  const keyFailure = exitCode !== 0 && !timedOut && !idleKilled ? toKeyFailure(toFinalError(stdout)) : null;
  const outputStarted = events.outputItems > 0;
  let answer = null;
  if (rawAnswer) {
    try { answer = JSON.parse(rawAnswer); } catch {
      const fenced = rawAnswer.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      try { answer = fenced ? JSON.parse(fenced[1]) : null; } catch { answer = null; }
    }
  }
  const base = { exitCode, timedOut, idleKilled, quota, keyFailure, outputStarted, durationMs: Date.now() - started, model, effort, stdoutFile, stderrFile, answerFile, ...events };
  const failed = (extra) => ({ ...base, ok: false, stderrTail: toStderrTail(stderr, secrets), ...extra });
  if (timedOut) return failed({ answer: null, error: `审查超时(${Math.round(timeoutMs / 60000)} 分钟)` });
  if (idleKilled) return failed({ answer: null, error: `审查 ${Math.round(idleMs / 60000)} 分钟没有任何输出,判定卡住` });
  if (exitCode !== 0) return failed({ answer, error: `codex exec 退出码 ${exitCode}:${tail(stderr) || tail(errorEvents) || '无错误输出'}` });
  if (!answer) return failed({ answer: null, error: '模型没有交出可解析的最终答卷' });
  return { ...base, ok: true, answer, error: null };

  function fail(error) {
    return { ok: false, answer: null, exitCode: null, timedOut: false, idleKilled: false, quota: false, keyFailure: null, outputStarted: false, durationMs: Date.now() - started, error, model, effort };
  }
}

const tail = (text) => String(text ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 400);
