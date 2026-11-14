// runs.jsonl 超过 Node 单串上限后,run-log 整串读写会抛
// 「Cannot create a string longer than ...」,前置审查每轮收尾失败(PraiseZhu/Review-PR#254)。
// [MIVO-PATCH runs-log-stream-append] 的回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appendRunsLogLine, scanRunsLog } from './run-log-store.mjs';

const runLog = fileURLToPath(new URL('./run-log.mjs', import.meta.url));

function setupRepo() {
  const directory = mkdtempSync(join(tmpdir(), 'run-log-store-'));
  const repoRoot = join(directory, 'repo');
  const stateRoot = join(directory, 'state');
  mkdirSync(repoRoot);
  mkdirSync(stateRoot);
  for (const args of [
    ['init', '--quiet'],
    ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--allow-empty', '-qm', 'fixture'],
  ]) {
    const git = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
  }
  return { directory, repoRoot, stateRoot };
}

function runLogWith({ repoRoot, stateRoot }, payload) {
  const logged = spawnSync(process.execPath, [runLog], {
    cwd: repoRoot,
    env: { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_STATE_DIR: stateRoot },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  let out;
  try { out = JSON.parse(logged.stdout); } catch { out = { ok: false, error: logged.stdout + logged.stderr }; }
  return { status: logged.status, out, stderr: logged.stderr };
}

const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('SC1/SC5 runs.jsonl 超过 Node 单串上限时 run-log 仍能查重并追加', () => {
  const fixture = setupRepo();
  try {
    const first = runLogWith(fixture, { runId: 'seed-run', processed: [], generatedAt: '2026-11-14T00:00:00.000Z' });
    assert.equal(first.status, 0, first.out.error);
    const { runsFile } = first.out;
    const seedLoggedAt = first.out.loggedAt;

    // 用约 1 MB 的合法行把文件撑过单串上限(64 位 Node 约 512 MB)。
    const filler = Buffer.from(`${JSON.stringify({ runId: 'filler', pad: 'x'.repeat((1 << 20) - 40) })}\n`);
    const target = bufferConstants.MAX_STRING_LENGTH + filler.length;
    const fd = openSync(runsFile, 'a');
    try {
      for (let written = statSync(runsFile).size; written < target; written += filler.length) writeSync(fd, filler);
    } finally { closeSync(fd); }
    const sizeBefore = statSync(runsFile).size;
    assert.ok(sizeBefore > bufferConstants.MAX_STRING_LENGTH, `夹具 ${sizeBefore} 字节未超过上限`);

    const fresh = runLogWith(fixture, { runId: 'fresh-run', processed: [], generatedAt: '2026-11-14T00:00:00.000Z' });
    assert.equal(fresh.status, 0, fresh.out.error);
    assert.equal(fresh.out.ok, true);
    assert.doesNotMatch(String(fresh.out.error ?? ''), /Cannot create a string longer/);
    const sizeAfterFresh = statSync(runsFile).size;
    assert.ok(sizeAfterFresh > sizeBefore, '新记录必须追加到末尾');

    // 大文件里的查重仍然生效:同一 seed run 再写一次,复用原 loggedAt,不再追加。
    const replay = runLogWith(fixture, { runId: 'seed-run', processed: [], generatedAt: '2026-11-14T00:00:00.000Z' });
    assert.equal(replay.status, 0, replay.out.error);
    assert.equal(replay.out.loggedAt, seedLoggedAt);
    assert.equal(statSync(runsFile).size, sizeAfterFresh);

    // 末尾一行就是 fresh-run,不必把整份文件读成字符串。
    const tail = Buffer.alloc(sizeAfterFresh - sizeBefore);
    const rfd = openSync(runsFile, 'r');
    try { fs.readSync(rfd, tail, 0, tail.length, sizeBefore); } finally { closeSync(rfd); }
    assert.equal(JSON.parse(tail.toString('utf8')).runId, 'fresh-run');
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('SC2 同 runId 重复写入:内容相同复用 loggedAt,内容冲突报错,已有两条报错', () => {
  const fixture = setupRepo();
  try {
    const first = runLogWith(fixture, { runId: 'run-a', processed: [], generatedAt: '2026-11-14T00:00:00.000Z' });
    assert.equal(first.status, 0, first.out.error);
    const { runsFile } = first.out;

    const same = runLogWith(fixture, { runId: 'run-a', processed: [], generatedAt: '2026-11-14T00:00:00.000Z' });
    assert.equal(same.status, 0, same.out.error);
    assert.equal(same.out.loggedAt, first.out.loggedAt);
    assert.equal(lines(runsFile).length, 1);

    const conflict = runLogWith(fixture, { runId: 'run-a', processed: [], generatedAt: '2026-11-14T00:00:00.000Z', mode: 'different' });
    assert.equal(conflict.status, 1);
    assert.match(conflict.out.error, /run run-a 的运行日志冲突/);
    assert.equal(lines(runsFile).length, 1);

    const row = lines(runsFile)[0];
    writeFileSync(runsFile, `${row}\n${row}\n`);
    const duplicated = runLogWith(fixture, { runId: 'run-a', processed: [], generatedAt: '2026-11-14T00:00:00.000Z' });
    assert.equal(duplicated.status, 1);
    assert.match(duplicated.out.error, /run run-a 在 runs\.jsonl 中重复/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('SC3 新记录只追加,已有字节与 inode 不变', () => {
  const fixture = setupRepo();
  try {
    const first = runLogWith(fixture, { runId: 'run-1', processed: [], generatedAt: '2026-11-14T00:00:00.000Z' });
    assert.equal(first.status, 0, first.out.error);
    const { runsFile } = first.out;
    const before = readFileSync(runsFile);
    const inode = statSync(runsFile).ino;
    const second = runLogWith(fixture, { runId: 'run-2', processed: [], generatedAt: '2026-11-14T00:00:00.000Z' });
    assert.equal(second.status, 0, second.out.error);
    const after = readFileSync(runsFile);
    assert.equal(statSync(runsFile).ino, inode, '不能整份重写再换名');
    assert.deepEqual(after.subarray(0, before.length), before);
    assert.deepEqual(lines(runsFile).map((row) => JSON.parse(row).runId), ['run-1', 'run-2']);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('SC3 追加中途失败时截回原长度,已有内容不受损', () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-log-store-'));
  try {
    const file = join(directory, 'runs.jsonl');
    const original = '{"runId":"keep"}\n';
    writeFileSync(file, original);
    let calls = 0;
    const fsImpl = {
      ...fs,
      // 第一次只写一半就返回,第二次抛错:模拟磁盘满等中途失败。
      writeSync(fd, buffer, offset, length) {
        calls += 1;
        if (calls === 1) return fs.writeSync(fd, buffer, offset, Math.ceil(length / 2));
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      },
    };
    assert.throws(() => appendRunsLogLine(file, JSON.stringify({ runId: 'new', pad: 'y'.repeat(64) }), { fsImpl }), /ENOSPC/);
    assert.equal(calls, 2);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('末尾缺换行时先补换行再追加;拒绝多行内容', () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-log-store-'));
  try {
    const file = join(directory, 'nested', 'runs.jsonl');
    appendRunsLogLine(file, '{"runId":"a"}');
    writeFileSync(file, '{"runId":"a"}\n{"runId":"b"}');
    appendRunsLogLine(file, '{"runId":"c"}');
    assert.equal(readFileSync(file, 'utf8'), '{"runId":"a"}\n{"runId":"b"}\n{"runId":"c"}\n');
    assert.throws(() => appendRunsLogLine(file, '{"a":1}\n{"b":2}'), /单行/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('流式扫描:跨块的行、CRLF、空行、无结尾换行、损坏行号与旧口径一致', () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-log-store-'));
  try {
    const file = join(directory, 'runs.jsonl');
    assert.deepEqual(scanRunsLog(file, 'x'), { matches: [], rows: 0, size: 0, tornTail: null });
    const rows = [
      { runId: 'a', pad: 'p'.repeat(37) },
      { runId: 'b', note: '中文跨块' },
      { runId: 'a', other: true },
      { runId: 'c' },
    ];
    const text = `${JSON.stringify(rows[0])}\r\n\n${JSON.stringify(rows[1])}\n${JSON.stringify(rows[2])}\r\n${JSON.stringify(rows[3])}`;
    writeFileSync(file, text);
    for (const chunkBytes of [1, 3, 7, 16, 1 << 20]) {
      const result = scanRunsLog(file, 'a', { chunkBytes });
      assert.deepEqual(result.matches, [rows[0], rows[2]], `chunkBytes=${chunkBytes}`);
      assert.equal(result.rows, 4);
      assert.equal(result.size, Buffer.byteLength(text));
      assert.deepEqual(scanRunsLog(file, 'b', { chunkBytes }).matches, [rows[1]]);
      assert.deepEqual(scanRunsLog(file, undefined, { chunkBytes }).matches, []);
    }
    writeFileSync(file, `${JSON.stringify(rows[0])}\n\n{broken\n${JSON.stringify(rows[3])}\n`);
    assert.throws(() => scanRunsLog(file, 'a', { chunkBytes: 5 }), /runs\.jsonl 第 2 行损坏/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('撕裂尾行:上次追加被强杀留下半行,扫描不报损坏,下次追加先截掉半行再写', () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-log-store-'));
  try {
    const file = join(directory, 'runs.jsonl');
    const complete = `${JSON.stringify({ runId: 'a' })}\n${JSON.stringify({ runId: 'b', note: '中文' })}\n`;
    const torn = JSON.stringify({ runId: 'c', pad: 'z'.repeat(50) }).slice(0, 30);
    writeFileSync(file, complete + torn);
    for (const chunkBytes of [1, 4, 9, 1 << 20]) {
      const scanned = scanRunsLog(file, 'c', { chunkBytes });
      assert.equal(scanned.rows, 2, `chunkBytes=${chunkBytes}`);
      assert.deepEqual(scanned.matches, []);
      assert.deepEqual(scanned.tornTail, { offset: Buffer.byteLength(complete), bytes: Buffer.byteLength(torn) });
    }
    for (const chunkBytes of [3, 1 << 20]) {
      writeFileSync(file, complete + torn);
      const result = appendRunsLogLine(file, JSON.stringify({ runId: 'c' }), { chunkBytes });
      assert.deepEqual(result, { repairedTornTailBytes: Buffer.byteLength(torn) });
      assert.equal(readFileSync(file, 'utf8'), `${complete}${JSON.stringify({ runId: 'c' })}\n`);
    }
    // 整份文件只有半行(没有任何换行):截到 0 再写。
    writeFileSync(file, torn);
    assert.deepEqual(appendRunsLogLine(file, '{"runId":"only"}', { chunkBytes: 4 }), { repairedTornTailBytes: Buffer.byteLength(torn) });
    assert.equal(readFileSync(file, 'utf8'), '{"runId":"only"}\n');
    // 完整的末行(只是缺换行)不算撕裂,原样保留。
    writeFileSync(file, '{"runId":"x"}');
    assert.deepEqual(appendRunsLogLine(file, '{"runId":"y"}'), { repairedTornTailBytes: 0 });
    assert.equal(readFileSync(file, 'utf8'), '{"runId":"x"}\n{"runId":"y"}\n');
    // 中间行损坏仍报行号,不会被当成撕裂尾行吞掉。
    writeFileSync(file, `{"runId":"a"}\n{broken\n${torn}`);
    assert.throws(() => scanRunsLog(file, 'a', { chunkBytes: 5 }), /runs\.jsonl 第 2 行损坏/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('写到一半出错且回滚也失败时留下的半行,下一轮收尾能自愈', () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-log-store-'));
  try {
    const file = join(directory, 'runs.jsonl');
    const original = '{"runId":"keep"}\n';
    writeFileSync(file, original);
    const fsImpl = {
      ...fs,
      writeSync(fd, buffer, offset, length) {
        if (offset === 0) return fs.writeSync(fd, buffer, offset, Math.ceil(length / 2));
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      },
      ftruncateSync() { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); },
    };
    assert.throws(() => appendRunsLogLine(file, JSON.stringify({ runId: 'new', pad: 'y'.repeat(64) }), { fsImpl }),
      /ENOSPC.*回滚到 17 字节失败:EIO/);
    assert.notEqual(readFileSync(file, 'utf8'), original, '夹具应当留下半行');
    assert.ok(scanRunsLog(file, 'new').tornTail);
    appendRunsLogLine(file, JSON.stringify({ runId: 'new' }));
    assert.equal(readFileSync(file, 'utf8'), `${original}{"runId":"new"}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run-log 遇到撕裂尾行:照常收尾、报出修掉的字节数,同一轮重试不重复记', () => {
  const fixture = setupRepo();
  try {
    const payload = { runId: 'killed-run', processed: [], generatedAt: '2026-11-14T00:00:00.000Z' };
    const first = runLogWith(fixture, { runId: 'seed-run', processed: [], generatedAt: '2026-11-14T00:00:00.000Z' });
    assert.equal(first.status, 0, first.out.error);
    const { runsFile } = first.out;
    const seed = readFileSync(runsFile, 'utf8');
    // 模拟上一次写 killed-run 时进程被强杀:只落了前 40 个字节。
    writeFileSync(runsFile, seed + JSON.stringify(payload).slice(0, 40));

    const retry = runLogWith(fixture, payload);
    assert.equal(retry.status, 0, retry.out.error);
    assert.equal(retry.out.repairedTornTailBytes, 40);
    const rows = lines(runsFile).map((row) => JSON.parse(row));
    assert.deepEqual(rows.map((row) => row.runId), ['seed-run', 'killed-run']);
    assert.ok(readFileSync(runsFile, 'utf8').startsWith(seed));

    const again = runLogWith(fixture, payload);
    assert.equal(again.status, 0, again.out.error);
    assert.equal(again.out.loggedAt, retry.out.loggedAt);
    assert.equal(again.out.repairedTornTailBytes, undefined);
    assert.equal(lines(runsFile).length, 2);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
