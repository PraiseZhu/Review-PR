// Real local Git repositories only. No GitHub, API writes or shared project worktrees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewWorktree, removeReviewWorktree, verifyReviewWorktree } from './review-worktree.mjs';

const script = fileURLToPath(new URL('./review-worktree.mjs', import.meta.url));
const norm = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
}

function removeFixture(root) {
  const absolute = realpathSync(root);
  assert.equal(norm(dirname(absolute)), norm(realpathSync(tmpdir())));
  assert.match(basename(absolute), /^review-worktree-test-/);
  assert.equal(lstatSync(absolute).isSymbolicLink(), false);
  rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-worktree-test-'));
  t.after(() => removeFixture(root));
  const repoRoot = join(root, 'repository with spaces');
  const remote = join(root, 'o', 'r.git');
  mkdirSync(repoRoot);
  mkdirSync(dirname(remote));
  git(root, ['init', '--bare', '--quiet', remote]);
  git(repoRoot, ['init', '--quiet']);
  git(repoRoot, ['config', 'user.name', 'Offline Test']);
  git(repoRoot, ['config', 'user.email', 'offline@example.invalid']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  git(repoRoot, ['remote', 'add', 'origin', remote]);
  writeFileSync(join(repoRoot, 'source.txt'), 'one\n');
  git(repoRoot, ['add', 'source.txt']);
  git(repoRoot, ['commit', '--quiet', '-m', 'first']);
  const head1 = git(repoRoot, ['rev-parse', 'HEAD']);
  writeFileSync(join(repoRoot, 'source.txt'), 'two\n');
  git(repoRoot, ['commit', '--quiet', '-am', 'second']);
  const head2 = git(repoRoot, ['rev-parse', 'HEAD']);
  git(repoRoot, ['push', '--quiet', 'origin', `${head1}:refs/pull/1/head`, `${head2}:refs/pull/2/head`]);
  const roundDir = join(root, 'state', 'round-one');
  mkdirSync(roundDir, { recursive: true });
  const planFile = join(roundDir, 'plan.json');
  const plan = { version: 1, runId: 'round-one', repo: 'o/r', roundDir,
    groups: [{ id: 1, prs: [{ pr: 1, head: head1 }, { pr: 2, head: head2 }] }] };
  writeFileSync(planFile, JSON.stringify(plan));
  const common = realpathSync(join(repoRoot, '.git'));
  const stateRoot = join(root, 'lock-state');
  const key = createHash('sha256').update(norm(common)).digest('hex').slice(0, 20);
  const lockDir = join(stateRoot, key);
  mkdirSync(lockDir, { recursive: true });
  let activeToken = 'first-review-lock';
  const setLock = (token) => {
    activeToken = token;
    writeFileSync(join(lockDir, 'lock.json'), JSON.stringify({ token, startedAt: new Date().toISOString() }));
  };
  setLock(activeToken);
  const options = (pr = 1, extra = {}) => ({ planFile, pr, repoRoot, lockToken: activeToken, ...extra });
  const dependencies = { assertLock: (token) => assert.equal(token, activeToken, 'not the active review lock') };
  const env = { ...process.env, REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_STATE_DIR: stateRoot };
  const cli = (action, pr = 1, extra = []) => spawnSync(process.execPath,
    [script, action, '--plan', planFile, '--pr', String(pr), '--lock-token', activeToken, ...extra],
    { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true });
  return { root, repoRoot, remote, common, roundDir, planFile, plan, head1, head2, env, setLock, options, dependencies, cli };
}

test('detached worktrees isolate PR heads, preserve FETCH_HEAD, and reuse only the same binding', async (t) => {
  const f = fixture(t);
  const fetchHead = join(f.common, 'FETCH_HEAD');
  writeFileSync(fetchHead, 'sentinel shared FETCH_HEAD\n');
  const [one, two] = await Promise.all([1, 2].map((pr) => createReviewWorktree(f.options(pr), f.dependencies)));
  assert.notEqual(one.path, two.path);
  assert.equal(git(one.path, ['rev-parse', 'HEAD']), f.head1);
  assert.equal(git(two.path, ['rev-parse', 'HEAD']), f.head2);
  assert.equal(readFileSync(join(one.path, 'source.txt'), 'utf8').trim(), 'one');
  assert.equal(readFileSync(join(two.path, 'source.txt'), 'utf8').trim(), 'two');
  assert.equal(readFileSync(fetchHead, 'utf8'), 'sentinel shared FETCH_HEAD\n');
  assert.equal(git(f.repoRoot, ['for-each-ref', 'refs/review-pr-worktrees/']), '');
  const reused = await createReviewWorktree(f.options(1), f.dependencies);
  assert.equal(reused.reused, true);
  const record = JSON.parse(readFileSync(one.ownershipFile, 'utf8'));
  assert.match(record.creationLockHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(record).includes('first-review-lock'), false);
  assert.equal((await verifyReviewWorktree(f.options(1, { expect: 'present' }), f.dependencies)).verified, true);
  await assert.rejects(verifyReviewWorktree(f.options(1), f.dependencies), /尚未清理/);
});

test('real CLI processes create separate PR worktrees concurrently and enforce the current lock', async (t) => {
  const f = fixture(t);
  const run = (pr) => new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, 'create', '--plan', f.planFile, '--pr', String(pr), '--lock-token', 'first-review-lock'],
      { cwd: f.repoRoot, env: f.env, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => { try { assert.equal(code, 0, stderr || stdout); resolvePromise(JSON.parse(stdout)); } catch (error) { reject(error); } });
  });
  const results = await Promise.all([run(1), run(2)]);
  assert.equal(results.every((result) => result.created && result.verified), true);
  f.setLock('resume-lock');
  for (const pr of [1, 2]) {
    const removed = f.cli('remove', pr, ['--agent-exited']);
    assert.equal(removed.status, 0, removed.stdout);
    assert.equal(JSON.parse(removed.stdout).removed, true);
    const verified = f.cli('verify', pr);
    assert.equal(verified.status, 0, verified.stdout);
    assert.equal(JSON.parse(verified.stdout).registrationAbsent, true);
  }
  const stale = spawnSync(process.execPath, [script, 'verify', '--plan', f.planFile, '--pr', '1', '--lock-token', 'first-review-lock'],
    { cwd: f.repoRoot, env: f.env, encoding: 'utf8', windowsHide: true });
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /活动锁/);
});

test('agent exit is required; untracked and ignored build output is reclaimed and cleanup is idempotent', async (t) => {
  const f = fixture(t);
  const created = await createReviewWorktree(f.options(), f.dependencies);
  await assert.rejects(removeReviewWorktree(f.options(), f.dependencies), /agent 已退出/);
  mkdirSync(join(created.path, 'node_modules', 'fixture'), { recursive: true });
  writeFileSync(join(created.path, 'node_modules', 'fixture', 'index.js'), 'build output');
  writeFileSync(join(created.path, 'review-output.log'), 'untracked log');
  writeFileSync(join(f.common, 'info', 'exclude'), 'node_modules/\n');
  f.setLock('resumed-review-lock');
  const removed = await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
  assert.equal(removed.physicalAbsent && removed.registrationAbsent && removed.verified, true);
  assert.equal(existsSync(created.path), false);
  assert.equal(git(f.repoRoot, ['worktree', 'list', '--porcelain']).includes(created.path.replaceAll('\\', '/')), false);
  const repeated = await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
  assert.equal(repeated.alreadyRemoved, true);
  assert.equal((await verifyReviewWorktree(f.options(), f.dependencies)).removed, true);
  assert.equal(existsSync(f.repoRoot), true);
});

test('a cleaned PR can start a new generation; the previous cleanup receipt cannot complete it', async (t) => {
  const f = fixture(t);
  const first = await createReviewWorktree(f.options(), f.dependencies);
  await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
  const second = await createReviewWorktree(f.options(), f.dependencies);
  assert.equal(second.path, first.path);
  assert.equal(second.generation, 2);
  const record = JSON.parse(readFileSync(second.ownershipFile, 'utf8'));
  assert.equal(record.removedAt, null);
  assert.equal(record.agentExited, false);
  assert.equal(record.previousGenerations.length, 1);
  await assert.rejects(verifyReviewWorktree(f.options(), f.dependencies), /尚未清理/);
  await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
  assert.equal((await verifyReviewWorktree(f.options(), f.dependencies)).generation, 2);
});

test('unowned, foreign-round and wrong-repository worktrees are never adopted or deleted', async (t) => {
  const f = fixture(t);
  const path = join(f.roundDir, 'worktrees', 'pr-1');
  mkdirSync(dirname(path));
  git(f.repoRoot, ['worktree', 'add', '--detach', path, f.head1]);
  await assert.rejects(createReviewWorktree(f.options(), f.dependencies), /归属凭据/);
  await assert.rejects(removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies), /归属凭据/);
  assert.equal(existsSync(path), true);
  git(f.repoRoot, ['worktree', 'remove', path]);
  const created = await createReviewWorktree(f.options(), f.dependencies);
  const raw = readFileSync(created.ownershipFile, 'utf8');
  for (const change of [{ runId: 'another-round' }, { path: f.repoRoot }, { commonDir: join(f.root, 'foreign.git') }, { pr: 2 }, { head: f.head2 }]) {
    writeFileSync(created.ownershipFile, JSON.stringify({ ...JSON.parse(raw), ...change }));
    await assert.rejects(removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies), /归属不符/);
    assert.equal(existsSync(created.path), true);
  }
  writeFileSync(created.ownershipFile, raw);
  writeFileSync(f.planFile, JSON.stringify({ ...f.plan, repo: 'other/repo' }));
  await assert.rejects(createReviewWorktree(f.options(), f.dependencies), /origin 不符/);
  writeFileSync(f.planFile, JSON.stringify(f.plan));
  const unrelated = join(f.root, 'fix-session');
  git(f.repoRoot, ['worktree', 'add', '--detach', unrelated, f.head2]);
  await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
  assert.equal(existsSync(unrelated), true);
  assert.equal(git(unrelated, ['rev-parse', 'HEAD']), f.head2);
});

test('a symlink or Windows junction cannot redirect the managed parent outside its round', async (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'unmanaged');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'must survive');
  symlinkSync(outside, join(f.roundDir, 'worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createReviewWorktree(f.options(), f.dependencies), /普通目录/);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'must survive');
});

test('tracked edits, changed HEAD and a locked worktree cannot be falsely marked removed', async (t) => {
  const f = fixture(t);
  const created = await createReviewWorktree(f.options(), f.dependencies);
  writeFileSync(join(created.path, 'source.txt'), 'user changes\n');
  await assert.rejects(removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies), /tracked 改动/);
  assert.equal(JSON.parse(readFileSync(created.ownershipFile, 'utf8')).removedAt, null);
  git(created.path, ['restore', 'source.txt']);
  git(created.path, ['checkout', '--detach', f.head2]);
  await assert.rejects(removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies), /detached/);
  git(created.path, ['checkout', '--detach', f.head1]);
  git(f.repoRoot, ['worktree', 'lock', created.path]);
  await assert.rejects(removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies), /未锁定/);
  assert.equal(existsSync(created.path), true);
  git(f.repoRoot, ['worktree', 'unlock', created.path]);
  await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
});

test('a changed fetched head fails safely and an absent directory does not hide a remaining registration', async (t) => {
  const f = fixture(t);
  git(f.repoRoot, ['push', '--quiet', '--force', 'origin', `${f.head2}:refs/pull/1/head`]);
  await assert.rejects(createReviewWorktree(f.options(), f.dependencies), /head 已变化/);
  await assert.rejects(verifyReviewWorktree(f.options(), f.dependencies), /尚无 agent/);
  await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
  git(f.repoRoot, ['push', '--quiet', '--force', 'origin', `${f.head1}:refs/pull/1/head`]);
  const created = await createReviewWorktree(f.options(), f.dependencies);
  const absolute = realpathSync(created.path);
  assert.equal(norm(absolute), norm(join(f.roundDir, 'worktrees', 'pr-1')));
  assert.equal(absolute.startsWith(realpathSync(f.root) + sep), true);
  rmSync(absolute, { recursive: true, force: true });
  await assert.rejects(verifyReviewWorktree(f.options(), f.dependencies), /尚未清理/);
  const removed = await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
  assert.equal(removed.registrationAbsent, true);
});

test('a dead lifecycle process can be resumed, while a live operation reservation is never stolen', async (t) => {
  const f = fixture(t);
  const reservationFile = join(f.roundDir, '.worktree-pr-1.operation');
  const reservation = { id: 'fixture-reservation', pid: process.pid, runId: f.plan.runId,
    pr: 1, head: f.head1, path: join(f.roundDir, 'worktrees', 'pr-1'), commonDir: f.common };
  writeFileSync(reservationFile, JSON.stringify(reservation));
  await assert.rejects(createReviewWorktree(f.options(), f.dependencies), /操作仍在运行/);
  assert.deepEqual(JSON.parse(readFileSync(reservationFile, 'utf8')), reservation);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0);
  writeFileSync(reservationFile, JSON.stringify({ ...reservation, pid: Number(child.stdout) }));
  const created = await createReviewWorktree(f.options(), f.dependencies);
  assert.equal(created.created, true);
  assert.equal(existsSync(reservationFile), false);
  await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
});

test('no-agent-started closes a pre-ownership crash only after verifying actual absence', async (t) => {
  const f = fixture(t);
  await assert.rejects(removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies), /归属凭据/);
  await assert.rejects(removeReviewWorktree(f.options(1, { noAgentStarted: true }), f.dependencies), /agent 已退出/);
  const fetchRef = `refs/review-pr-worktrees/${f.plan.runId}/pr-1`;
  git(f.repoRoot, ['update-ref', fetchRef, f.head1]);
  const removed = f.cli('remove', 1, ['--agent-exited', '--no-agent-started']);
  assert.equal(removed.status, 0, removed.stdout);
  const receipt = JSON.parse(removed.stdout);
  assert.equal(receipt.noWorktree && receipt.noAgentStarted && receipt.removed && receipt.verified, true);
  assert.equal(receipt.generation, 1);
  const record = JSON.parse(readFileSync(receipt.ownershipFile, 'utf8'));
  assert.equal(record.agentExited, true);
  assert.ok(record.removedAt);
  assert.equal(git(f.repoRoot, ['rev-parse', fetchRef]), f.head1, 'unowned ref must remain untouched');
  assert.equal((await verifyReviewWorktree(f.options(), f.dependencies)).noWorktree, true);
  const repeated = await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
  assert.equal(repeated.alreadyRemoved && repeated.noWorktree, true);
  const created = await createReviewWorktree(f.options(), f.dependencies);
  assert.equal(created.generation, 2);
  await assert.rejects(verifyReviewWorktree(f.options(), f.dependencies), /尚未清理/);
  await removeReviewWorktree(f.options(1, { agentExited: true }), f.dependencies);
});

test('no-agent-started cannot adopt an existing directory, registration or later unowned tree', async (t) => {
  const f = fixture(t);
  const path = join(f.roundDir, 'worktrees', 'pr-1');
  mkdirSync(dirname(path));
  git(f.repoRoot, ['worktree', 'add', '--detach', path, f.head1]);
  await assert.rejects(removeReviewWorktree(f.options(1, { agentExited: true, noAgentStarted: true }), f.dependencies), /归属凭据/);
  assert.equal(existsSync(path), true);
  const absolute = realpathSync(path);
  assert.equal(norm(absolute), norm(join(f.roundDir, 'worktrees', 'pr-1')));
  assert.equal(absolute.startsWith(realpathSync(f.root) + sep), true);
  rmSync(absolute, { recursive: true, force: true });
  await assert.rejects(removeReviewWorktree(f.options(1, { agentExited: true, noAgentStarted: true }), f.dependencies), /归属凭据/);
  git(f.repoRoot, ['worktree', 'remove', '--force', path]);
  await removeReviewWorktree(f.options(1, { agentExited: true, noAgentStarted: true }), f.dependencies);
  git(f.repoRoot, ['worktree', 'add', '--detach', path, f.head1]);
  await assert.rejects(removeReviewWorktree(f.options(1, { agentExited: true, noAgentStarted: true }), f.dependencies), /归属凭据/);
  assert.equal(existsSync(path), true, 'an absence receipt must never authorize deleting a later tree');
});
