// Shared persistence and process-result contracts. No GitHub mutations here.
import {
  openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync, readSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export function atomicWriteText(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, data, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

export function atomicWriteJson(file, value) {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(data);
  atomicWriteText(file, data);
}

/**
 * 读一个 fd 直到 EOF。spawnSync / 非阻塞管道上 readFileSync 会把 EAGAIN 直接抛出
 * (Mini 前置审查 finalize → run-log 的 stdin)。EAGAIN/EWOULDBLOCK 短等后重试。
 */
export function readFdSync(fd, { encoding = 'utf8', retryMs = 20, maxWaitMs = 30_000 } = {}) {
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    } catch (error) {
      if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') {
        if (Date.now() >= deadline) {
          throw new Error(`stdin 读取超时(${maxWaitMs}ms):${error.message}`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
        continue;
      }
      throw error;
    }
  }
  const bytes = Buffer.concat(chunks);
  return encoding === null ? bytes : bytes.toString(encoding);
}

export function parseApiJson(raw, source = 'GitHub API') {
  if (!String(raw ?? '').trim()) throw new Error(`${source}: empty JSON response`);
  try { return JSON.parse(raw); } catch {
    // Do not echo arbitrary response bodies (they may contain private content).
    const kind = /^\s*</.test(raw) ? 'HTML' : 'non-JSON';
    throw new Error(`${source}: ${kind} response (${Buffer.byteLength(raw)} bytes)`);
  }
}

export function parseScriptResult({ stdout, stderr = '', status, signal, error }) {
  if (error) return { ok: false, error: `子进程失败:${error.message}`, exitCode: status ?? null };
  let result;
  try { result = parseApiJson(stdout, '子进程'); } catch (e) {
    return { ok: false, error: `${e.message}${stderr ? `; ${stderr.trim().slice(0, 200)}` : ''}`, exitCode: status ?? null };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, error: '子进程输出非 JSON 对象', exitCode: status ?? null };
  }
  if (status !== 0 || signal) {
    return { ...result, ok: false, error: result.error || result.reason || `子进程退出码 ${status ?? signal}`, exitCode: status ?? null };
  }
  return result;
}
