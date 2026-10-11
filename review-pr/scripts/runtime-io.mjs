// Shared persistence and process-result contracts. No GitHub mutations here.
import {
  openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync,
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
