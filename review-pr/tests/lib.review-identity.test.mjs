import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReviewIdentity, validateReviewDispatch, resolveReviewRepoRoot, assertReviewIdentity, createDispatchReceipt, assertDispatchReceipt, assertReviewArtifactPaths } from '../scripts/lib.review-identity.mjs';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'review-identity-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'README.md'), 'x');
  spawnSync('git', ['-C', root, 'add', '.']);
  const commit = spawnSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  assert.equal(commit.status, 0, commit.stderr?.toString());
  return root;
}

test('identity binds repo, common-dir, skill root and linked worktree', (t) => {
  const root = repo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = join(root, 'review-wt');
  const add = spawnSync('git', ['-C', root, 'worktree', 'add', '-q', wt, '-b', 'review']);
  assert.equal(add.status, 0, add.stderr?.toString());
  const skill = join(root, 'skill'); mkdirSync(skill);
  const id = buildReviewIdentity({ repoRoot: root, skillRoot: skill, worktree: wt });
  assert.equal(id.worktree, realpathSync(wt));
  assert.equal(assertReviewArtifactPaths(id, [join(wt, 'task.json')]), true);
  assert.throws(() => assertReviewArtifactPaths(id, [join(root, 'outside.json')]), /输入输出文件/);
  symlinkSync(root, join(wt, 'escape'));
  assert.throws(() => assertReviewArtifactPaths(id, [join(wt, 'escape', 'outside.json')]), /输入输出文件/);
  symlinkSync(join(root, 'missing.json'), join(wt, 'dangling.json'));
  assert.throws(() => assertReviewArtifactPaths(id, [join(wt, 'dangling.json')]), /ENOENT/);
  assert.equal(validateReviewDispatch({ agent: 'general-purpose', provider: 'local', isolation: 'worktree', worktree: wt, expectedWorktree: wt, repoRoot: root, skillRoot: skill }).ok, true);
  assert.equal(validateReviewDispatch({ agent: 'typescript-reviewer', provider: 'x', isolation: 'worktree', worktree: wt, expectedWorktree: wt, repoRoot: root, skillRoot: skill }).ok, false);
  assert.equal(resolveReviewRepoRoot({ envRoot: root, cwd: wt }), realpathSync(root));
  assert.throws(() => resolveReviewRepoRoot({ envRoot: root, explicitRoot: wt, cwd: wt }), /不一致/);
  assert.throws(() => buildReviewIdentity({ repoRoot: skill, skillRoot: skill }), /根目录/);
  const request = { agent: 'general-purpose', provider: 'local', isolation: 'worktree', worktree: wt, expectedWorktree: wt, repoRoot: root, skillRoot: skill };
  for (const field of Object.keys(request)) assert.equal(validateReviewDispatch({ ...request, [field]: undefined }).ok, false, field);
  assert.equal(validateReviewDispatch({ ...request, isolation: 'none' }).ok, false);
  assert.equal(validateReviewDispatch({ ...request, agent: 'unrecognized-reviewer' }).ok, false);
  assert.equal(validateReviewDispatch({ ...request, expectedWorktree: root }).ok, false);
  assert.equal(validateReviewDispatch({ ...request, skillRoot: wt }).ok, false);
  assert.throws(() => assertReviewIdentity(null, id), /缺审查执行身份/);
  const receipt = createDispatchReceipt({ pr: 1, snapshotHash: 's', identity: id });
  assert.equal(assertDispatchReceipt(receipt, { pr: 1, snapshotHash: 's', identity: id }), true);
  assert.throws(() => assertDispatchReceipt({ ...receipt, snapshotHash: 'old' }, { pr: 1, snapshotHash: 's', identity: id }), /过期/);
  assert.throws(() => assertDispatchReceipt({ ...receipt, requestHash: 'bad' }, { pr: 1, snapshotHash: 's', identity: id }), /失败/);
  assert.throws(() => assertDispatchReceipt({ ...receipt, receiptId: 'bad' }, { pr: 1, snapshotHash: 's', identity: id }), /失败/);
  for (const field of Object.keys(id)) assert.throws(() => assertReviewIdentity({ ...id, [field]: 'wrong' }, id), /不一致/);
});

test('unrelated repository cannot serve as review worktree or cwd', (t) => {
  const first = repo();
  const second = repo();
  t.after(() => { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); });
  assert.throws(() => buildReviewIdentity({ repoRoot: first, skillRoot: first, worktree: second }), /common-dir 不一致/);
  assert.throws(() => resolveReviewRepoRoot({ envRoot: first, cwd: second }), /不是同一 Git 仓库/);
  assert.throws(() => resolveReviewRepoRoot({ envRoot: first, explicitRoot: second, cwd: first }), /不一致/);
});
