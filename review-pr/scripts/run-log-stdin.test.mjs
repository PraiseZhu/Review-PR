// run-log 经 spawnSync input 接到的 stdin 是非阻塞管道:数据晚到时
// readFileSync(0) 会抛 EAGAIN。这里用真实非阻塞管道复现 Mini 前置审查 finalize 的失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const runLog = fileURLToPath(new URL('./run-log.mjs', import.meta.url));
const pythonProbe = spawnSync('python3', ['-c', 'import fcntl, os, subprocess'], { encoding: 'utf8' });

function setupRepo() {
  const directory = mkdtempSync(join(tmpdir(), 'run-log-stdin-'));
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

function runLogOnNonblockingPipe({ repoRoot, stateRoot, payload, delayMs }) {
  const feeder = `
import fcntl, os, subprocess, sys, time
node, script, delay_ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
payload = sys.stdin.buffer.read()
r, w = os.pipe()
flags = fcntl.fcntl(r, fcntl.F_GETFL)
fcntl.fcntl(r, fcntl.F_SETFL, flags | os.O_NONBLOCK)
proc = subprocess.Popen([node, script], stdin=r, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
os.close(r)
if delay_ms:
    time.sleep(delay_ms / 1000)
if payload:
    os.write(w, payload)
os.close(w)
out, err = proc.communicate(timeout=15)
sys.stdout.buffer.write(out)
sys.stderr.buffer.write(err)
raise SystemExit(proc.returncode or 0)
`;
  return spawnSync('python3', ['-c', feeder, process.execPath, runLog, String(delayMs)], {
    cwd: repoRoot,
    env: { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_STATE_DIR: stateRoot },
    input: payload,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
}

function runLogOnEmptyNonblockingPipe({ repoRoot, stateRoot }) {
  // 写端一直开着、不写字节:子进程立刻 read 到 EAGAIN。这是 Mini Node 26 上
  // spawnSync input 管道偶尔晚到时的确定性复现,不依赖调度延迟。
  const feeder = `
import fcntl, os, subprocess, sys, time
node, script = sys.argv[1], sys.argv[2]
r, w = os.pipe()
flags = fcntl.fcntl(r, fcntl.F_GETFL)
fcntl.fcntl(r, fcntl.F_SETFL, flags | os.O_NONBLOCK)
proc = subprocess.Popen([node, script], stdin=r, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
os.close(r)
time.sleep(0.05)
out, err = proc.communicate(timeout=5)
os.close(w)
sys.stdout.buffer.write(out)
sys.stderr.buffer.write(err)
raise SystemExit(proc.returncode or 0)
`;
  return spawnSync('python3', ['-c', feeder, process.execPath, runLog], {
    cwd: repoRoot,
    env: { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_STATE_DIR: stateRoot },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
}

function payload() {
  return JSON.stringify({ runId: 'fixture-eagain', processed: [] });
}

test('run-log 在非阻塞空管道上不能因 EAGAIN 失败', () => {
  assert.equal(pythonProbe.status, 0, `需要 python3 做非阻塞管道夹具: ${pythonProbe.stderr}`);
  const { directory, repoRoot, stateRoot } = setupRepo();
  try {
    const empty = runLogOnEmptyNonblockingPipe({ repoRoot, stateRoot });
    // EOF 后仍无字节:应报 stdin 非法 JSON,绝不能是 EAGAIN。
    assert.equal(empty.status, 1, empty.stdout + empty.stderr);
    const out = JSON.parse(empty.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error, /stdin 不是合法 JSON|empty JSON/);
    assert.doesNotMatch(out.error, /EAGAIN/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run-log 在非阻塞管道上数据晚到时不能因 EAGAIN 失败', () => {
  assert.equal(pythonProbe.status, 0, `需要 python3 做非阻塞管道夹具: ${pythonProbe.stderr}`);
  const { directory, repoRoot, stateRoot } = setupRepo();
  try {
    const delayed = runLogOnNonblockingPipe({ repoRoot, stateRoot, payload: payload(), delayMs: 50 });
    assert.equal(delayed.status, 0, delayed.stdout + delayed.stderr);
    const out = JSON.parse(delayed.stdout);
    assert.equal(out.ok, true);
    assert.equal(existsSync(out.lastRunFile), true);
    assert.match(readFileSync(out.runsFile, 'utf8'), /fixture-eagain/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run-log 仍接受 spawnSync input（finalize 现行路径）', () => {
  const { directory, repoRoot, stateRoot } = setupRepo();
  try {
    const logged = spawnSync(process.execPath, [runLog], {
      cwd: repoRoot,
      env: { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_STATE_DIR: stateRoot },
      input: payload(),
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(logged.status, 0, logged.stdout + logged.stderr);
    assert.equal(JSON.parse(logged.stdout).ok, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
