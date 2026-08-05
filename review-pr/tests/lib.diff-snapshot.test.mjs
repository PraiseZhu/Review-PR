// SC-R8 行为测试:真实 temp git 仓构建 DiffSnapshot——身份四元组、正交文件模型、
// complete=false fail 方向、base 前进 head 不变反例、coverage keys 派生。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiffSnapshot, coverageKeysOf, computeSnapshotHash } from '../scripts/lib.diff-snapshot.mjs';

const git = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    // 显式禁签名:继承全局 commit.gpgsign 时,并发跑 temp-git 用例会撞 gpg
    // 「Cannot allocate memory」而随机红(核验席实测 409/414)。测试仓不需要签名。
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function repoWith() {
  const repo = mkdtempSync(join(tmpdir(), 'snap-'));
  git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(join(repo, 'a.txt'), 'l1\nl2\nl3\n');
  writeFileSync(join(repo, 'old.txt'), 'same\ncontent\nhere\nstays\n');
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  const base = git(['rev-parse', 'HEAD'], repo);
  writeFileSync(join(repo, 'a.txt'), 'l1\nl2-mod\nl3\nl4\n'); // modified text
  git(['mv', 'old.txt', 'renamed.txt'], repo); // rename (content unchanged → 零文本 hunk)
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([9, 9, 9, 9, 9])); // binary modified
  writeFileSync(join(repo, 'new.mjs'), 'export const x = 1;\n'); // added
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'head'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);
  return { repo, base, head };
}

test('R8:真实仓构建——四元身份、modified/renamed/binary/added 正交模型、hunk 解析', () => {
  const { repo, base, head } = repoWith();
  const s = buildDiffSnapshot({ repoRoot: repo, baseRefOid: base, headOid: head, fetchMissing: false });
  assert.equal(s.complete, true, s.reason);
  assert.equal(s.mergeBaseOid, base);
  assert.equal(s.snapshotHash, computeSnapshotHash(s));
  const byPath = Object.fromEntries(s.files.map((f) => [f.newPath ?? f.oldPath, f]));
  assert.equal(byPath['a.txt'].changeType, 'modified');
  assert.equal(byPath['a.txt'].contentKind, 'text');
  assert.ok(byPath['a.txt'].hunks.length >= 1);
  assert.equal(byPath['renamed.txt'].changeType, 'renamed');
  assert.equal(byPath['renamed.txt'].oldPath, 'old.txt');
  assert.equal(byPath['renamed.txt'].hunks.length, 0, 'rename 零文本 hunk');
  assert.equal(byPath['bin.dat'].contentKind, 'binary');
  assert.equal(byPath['new.mjs'].changeType, 'added');
  // coverage keys:text 有 hunk → hunk key;rename 零 hunk / binary → file key
  const keys = coverageKeysOf(s);
  assert.ok(keys.some((k) => k.kind === 'hunk' && k.fileId === byPath['a.txt'].fileId));
  assert.ok(keys.some((k) => k.kind === 'file' && k.fileId === byPath['renamed.txt'].fileId));
  assert.ok(keys.some((k) => k.kind === 'file' && k.fileId === byPath['bin.dat'].fileId));
});

test('R8:base 前进 head 不变 → mergeBase 变 → snapshotHash 变(旧证据 stale)', () => {
  const { repo, base, head } = repoWith();
  const s1 = buildDiffSnapshot({ repoRoot: repo, baseRefOid: base, headOid: head, fetchMissing: false });
  // main 前进一格(与 head 分叉):在 base 上另开提交
  git(['checkout', '-q', base], repo);
  writeFileSync(join(repo, 'other.txt'), 'x\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'base-advance'], repo);
  const base2 = git(['rev-parse', 'HEAD'], repo);
  const s2 = buildDiffSnapshot({ repoRoot: repo, baseRefOid: base2, headOid: head, fetchMissing: false });
  assert.equal(s2.complete, true, s2.reason);
  assert.notEqual(s2.snapshotHash, s1.snapshotHash, 'base 前进必须产生新 snapshot 身份');
});

test('R8 fail 方向:对象缺失/oid 非法/元数据对账不符 → complete=false', () => {
  const { repo, base, head } = repoWith();
  const missing = buildDiffSnapshot({ repoRoot: repo, baseRefOid: 'a'.repeat(40), headOid: head, fetchMissing: false });
  assert.equal(missing.complete, false);
  assert.match(missing.reason, /objects 缺失/);
  assert.equal(buildDiffSnapshot({ repoRoot: repo, baseRefOid: 'short', headOid: head, fetchMissing: false }).complete, false);
  const mism = buildDiffSnapshot({ repoRoot: repo, baseRefOid: base, headOid: head, fetchMissing: false, expectedPaths: ['a.txt'] });
  assert.equal(mism.complete, false);
  assert.match(mism.reason, /不一致/);
  const okAcc = buildDiffSnapshot({ repoRoot: repo, baseRefOid: base, headOid: head, fetchMissing: false, expectedPaths: ['a.txt', 'renamed.txt', 'bin.dat', 'new.mjs'] });
  assert.equal(okAcc.complete, true, okAcc.reason);
});

test('R8:submodule/mode-only 形态', () => {
  const repo = mkdtempSync(join(tmpdir(), 'snap-sm-'));
  git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(join(repo, 's.sh'), '#!/bin/sh\necho hi\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  const base = git(['rev-parse', 'HEAD'], repo);
  spawnSync('chmod', ['+x', join(repo, 's.sh')]);
  git(['add', '-A'], repo);
  git(['update-index', '--chmod=+x', 's.sh'], repo);
  git(['commit', '-q', '-m', 'mode'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);
  const s = buildDiffSnapshot({ repoRoot: repo, baseRefOid: base, headOid: head, fetchMissing: false });
  assert.equal(s.complete, true, s.reason);
  const f = s.files.find((x) => (x.newPath ?? x.oldPath) === 's.sh');
  assert.ok(f, 'mode-only 变更必须出现在文件模型里');
  assert.equal(f.oldMode, '100644');
  assert.equal(f.newMode, '100755');
  assert.equal(f.hunks.length, 0);
  assert.deepEqual(coverageKeysOf(s).filter((k) => k.fileId === f.fileId), [{ kind: 'file', fileId: f.fileId }], 'mode-only → file-receipt key');
});
