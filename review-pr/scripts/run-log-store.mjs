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
 * 末尾没有换行、又解析不了的那一截视为上次追加被强杀留下的半行(撕裂尾行):不算损坏、
 * 不计行号,在 tornTail 里报出它的起点和字节数,由 appendRunsLogLine 截掉;
 * 中间行损坏仍按旧口径报「第 N 行损坏」。
 * 返回 { matches, rows, size, tornTail };文件不存在时 size=0,tornTail 为 null。
 */
export function scanRunsLog(file, runId, { chunkBytes = DEFAULT_CHUNK_BYTES, fsImpl = fs } = {}) {
  const result = { matches: [], rows: 0, size: 0, tornTail: null };
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
    const takeLine = (lineBuffer, { unterminated = false } = {}) => {
      let end = lineBuffer.length;
      if (end > 0 && lineBuffer[end - 1] === CARRIAGE_RETURN) end -= 1;
      if (end === 0) return;
      let row;
      try { row = JSON.parse(lineBuffer.toString('utf8', 0, end)); } catch {
        if (unterminated) {
          result.tornTail = { offset: result.size - lineBuffer.length, bytes: lineBuffer.length };
          return;
        }
        throw new Error(`runs.jsonl 第 ${result.rows + 1} 行损坏`);
      }
      result.rows += 1;
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
    if (pending.length) takeLine(Buffer.concat(pending), { unterminated: true });
    return result;
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * 把一行追加到 runs.jsonl 末尾,不动已有的完整行。
 * - 原文件末尾缺换行、最后一截是完整 JSON:先补一个换行再追加;
 * - 最后一截解析不了(上次追加被强杀留下的半行):先截到最后一个换行,再追加,
 *   返回 repairedTornTailBytes 让调用方把修复写进输出;
 * - 写入中途出错就截回追加前的长度(已修掉的半行不恢复),再把错误抛出。
 */
export function appendRunsLogLine(file, line, { fsImpl = fs, chunkBytes = DEFAULT_CHUNK_BYTES } = {}) {
  if (/[\r\n]/.test(line)) throw new Error('runs.jsonl 追加内容必须是单行');
  fsImpl.mkdirSync(dirname(file), { recursive: true });
  // a+:追加写,同时可读末尾判断要不要补换行或截掉半行。
  const fd = fsImpl.openSync(file, 'a+', 0o600);
  let keepSize;
  let repairedTornTailBytes = 0;
  try {
    const originalSize = fsImpl.fstatSync(fd).size;
    keepSize = originalSize;
    let prefix = '';
    const tailStart = originalSize > 0 ? findTailStart(fd, originalSize, { fsImpl, chunkBytes }) : 0;
    if (tailStart < originalSize) {
      const tail = Buffer.alloc(originalSize - tailStart);
      readFully(fd, tail, tailStart, fsImpl);
      let end = tail.length;
      if (end > 0 && tail[end - 1] === CARRIAGE_RETURN) end -= 1;
      let complete = end === 0;
      if (!complete) {
        try { JSON.parse(tail.toString('utf8', 0, end)); complete = true; } catch { complete = false; }
      }
      if (complete) prefix = '\n';
      else {
        fsImpl.ftruncateSync(fd, tailStart);
        keepSize = tailStart;
        repairedTornTailBytes = originalSize - tailStart;
      }
    }
    const data = Buffer.from(`${prefix}${line}\n`, 'utf8');
    let offset = 0;
    while (offset < data.length) offset += fsImpl.writeSync(fd, data, offset, data.length - offset);
    fsImpl.fsyncSync(fd);
    return { repairedTornTailBytes };
  } catch (error) {
    if (keepSize !== undefined) {
      try { fsImpl.ftruncateSync(fd, keepSize); } catch (rollback) {
        error.message = `${error.message};回滚到 ${keepSize} 字节失败:${rollback.message}`;
      }
    }
    throw error;
  } finally {
    fsImpl.closeSync(fd);
  }
}

// helpers

/** 从文件末尾往前按块找最后一个换行,返回它后面一个字节的位置;整份没有换行时返回 0。 */
function findTailStart(fd, size, { fsImpl, chunkBytes }) {
  const buffer = Buffer.alloc(Math.min(chunkBytes, size));
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - buffer.length);
    const length = end - start;
    readFully(fd, buffer.subarray(0, length), start, fsImpl);
    const newline = buffer.subarray(0, length).lastIndexOf(NEWLINE);
    if (newline !== -1) return start + newline + 1;
    end = start;
  }
  return 0;
}

function readFully(fd, target, position, fsImpl) {
  let offset = 0;
  while (offset < target.length) {
    const bytesRead = fsImpl.readSync(fd, target, offset, target.length - offset, position + offset);
    if (bytesRead === 0) throw new Error(`runs.jsonl 读到 ${position + offset} 字节时意外结束`);
    offset += bytesRead;
  }
}
