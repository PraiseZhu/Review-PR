// common.mjs — 胶水层共用的小工具:跑命令、读写 JSON、调用 Cindy 脚本。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRIPTS = join(SKILL_ROOT, 'review-pr', 'scripts');
export const SHA_RE = /^[0-9a-f]{40}$/;
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const MODES = ['dry-run', 'sandbox', 'live'];

export function run(cmd, args, { cwd, env, input, timeoutMs = 120_000, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  const out = { ok: r.status === 0 && !r.error, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
  if (!out.ok && !allowFail) {
    const detail = (out.stderr || out.error || out.stdout || '').trim().split('\n').slice(-2).join(' | ').slice(0, 400);
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} 失败(exit ${r.status}):${detail}`);
  }
  return out;
}

/**
 * 跑一个脚本并解析 JSON 输出;非 0/2 退出码也把 JSON 带回来(脚本把失败写在字段里)。
 * script 是 review-pr/scripts 下的文件名,也可以是绝对路径(Mivo 自己的脚本)。
 */
export function runScript(script, args, { cwd, env, timeoutMs = 300_000, input } = {}) {
  const r = spawnSync(process.execPath, [resolve(SCRIPTS, script), ...args], {
    cwd, env, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
  });
  return toScriptResult(script, { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error });
}

/** runScript 的异步版:子进程运行期间不阻塞事件循环(滚动接单时跑 plan,别的轮次照常轮询)。 */
export function runScriptAsync(script, args, { cwd, env, timeoutMs = 300_000 } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(SCRIPTS, script), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); done(toScriptResult(script, { status: null, stdout, stderr, error })); });
    child.on('close', (status) => { clearTimeout(timer); done(toScriptResult(script, { status, stdout, stderr })); });
  });
}

function toScriptResult(script, { status, stdout, stderr, error }) {
  let value = null;
  const text = String(stdout ?? '').trim();
  try { value = JSON.parse(text); } catch {
    const last = text.split('\n').filter((line) => line.trim().startsWith('{')).pop();
    try { value = last ? JSON.parse(last) : null; } catch { value = null; }
  }
  if (!value) {
    const detail = String(stderr || error?.message || text || '').trim().split('\n').slice(-2).join(' | ').slice(0, 400);
    return { ok: false, error: `${script} 没有返回 JSON(exit ${status}):${detail}`, exitCode: status };
  }
  return { ...value, exitCode: status };
}

export function readJson(file, fallback = undefined) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Error(`读取 ${file} 失败:${error.message}`);
  }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function requireMatch(name, value, re) {
  const text = String(value ?? '').trim();
  if (!re.test(text)) throw new Error(`输入 ${name} 不合法:${text.slice(0, 80) || '(empty)'}`);
  return text;
}

export const nowIso = () => new Date().toISOString();
