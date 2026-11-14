// run-log-store.mjs — runs.jsonl 的流式查重与只追加写入。[MIVO-PATCH runs-log-stream-append]
//
// runs.jsonl 每轮追加一行(单行常见几十到上百 KB)。旧写法把整份文件读成一个字符串再 split,
// 写回时又 join 成一个字符串:文件超过 Node 单串上限(64 位约 512 MB)后读写都抛
// 「Cannot create a string longer than ...」,前置审查每轮收尾失败(PraiseZhu/Review-PR#254)。
// 这里按块读 Buffer、逐行解码,内存只放当前一行;新记录 O_APPEND 追加,不重写已有行。
import fs from 'node:fs';
import { dirname } from 'node:path';

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
export const DEFAULT_CHUNK_BYTES = 1 << 20;

/**
 * 逐行扫描 runs.jsonl,找出 runId 相同的已有记录。
 * 行号口径与旧实现一致:只数非空行(`split(/\r?\n/).filter(Boolean)` 后的下标 + 1)。
 * 返回 { matches, rows, size };文件不存在时 size=0。
 */
export function scanRunsLog(file, runId, { chunkBytes = DEFAULT_CHUNK_BYTES, fsImpl = fs } = {}) {
  const result = { matches: [], rows: 0, size: 0 };
  let fd;
  try {
    fd = fsImpl.openSync(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(chunkBytes);
    let pending = [];
    const takeLine = (lineBuffer) => {
      let end = lineBuffer.length;
      if (end > 0 && lineBuffer[end - 1] === CARRIAGE_RETURN) end -= 1;
      if (end === 0) return;
      result.rows += 1;
      let row;
      try { row = JSON.parse(lineBuffer.toString('utf8', 0, end)); } catch {
        throw new Error(`runs.jsonl 第 ${result.rows} 行损坏`);
      }
      if (runId && row?.runId === runId) result.matches.push(row);
    };
    for (;;) {
      const bytesRead = fsImpl.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      result.size += bytesRead;
      let start = 0;
      for (;;) {
        const newline = buffer.indexOf(NEWLINE, start);
        if (newline === -1 || newline >= bytesRead) break;
        const piece = buffer.subarray(start, newline);
        takeLine(pending.length ? Buffer.concat([...pending, piece]) : piece);
        pending = [];
        start = newline + 1;
      }
      // Copy: buffer is reused by the next read.
      if (start < bytesRead) pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
    }
    if (pending.length) takeLine(Buffer.concat(pending));
    return result;
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * 把一行追加到 runs.jsonl 末尾,不动已有字节。原文件末尾缺换行时先补一个换行。
 * 写入中途出错就把文件截回追加前的长度,再把错误抛出,已有内容保持原样。
 */
export function appendRunsLogLine(file, line, { fsImpl = fs } = {}) {
  if (/[\r\n]/.test(line)) throw new Error('runs.jsonl 追加内容必须是单行');
  fsImpl.mkdirSync(dirname(file), { recursive: true });
  // a+:追加写,同时可读末字节判断要不要补换行。
  const fd = fsImpl.openSync(file, 'a+', 0o600);
  let originalSize;
  try {
    originalSize = fsImpl.fstatSync(fd).size;
    let prefix = '';
    if (originalSize > 0) {
      const last = Buffer.alloc(1);
      fsImpl.readSync(fd, last, 0, 1, originalSize - 1);
      if (last[0] !== NEWLINE) prefix = '\n';
    }
    const data = Buffer.from(`${prefix}${line}\n`, 'utf8');
    let offset = 0;
    while (offset < data.length) offset += fsImpl.writeSync(fd, data, offset, data.length - offset);
    fsImpl.fsyncSync(fd);
  } catch (error) {
    if (originalSize !== undefined) {
      try { fsImpl.ftruncateSync(fd, originalSize); } catch (rollback) {
        error.message = `${error.message};回滚到 ${originalSize} 字节失败:${rollback.message}`;
      }
    }
    throw error;
  } finally {
    fsImpl.closeSync(fd);
  }
}
