// approve-workflows-expected-head.test.mjs — approve-expected-head 补丁:带 --expected-head 时,
// PR 当前 head 不是它就不查、不批(退 2,headChanged);是它就只批这个 head 的 action_required run。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'approve-workflows.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// 假 gh:pr view 回当前 head;actions/runs 回一个待批 run;POST approve 记到文件。
function world(currentHead) {
  const root = mkdtempSync(join(tmpdir(), 'approve-expected-'));
  const bin = join(root, 'bin');
  const repo = join(root, 'repo');
  mkdirSync(bin);
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git']);
  const posts = join(root, 'posts.txt');
  const queried = join(root, 'queried.txt');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  "pr view"*) echo '{"headRefOid":"${currentHead}","isCrossRepository":true,"author":{"login":"x"},"files":[{"path":"src/a.js"}]}' ;;
  *"-X POST"*) echo "$*" >> "${posts}"; echo '{}' ;;
  *"actions/runs?head_sha="*) echo "$*" >> "${queried}"; echo '{"workflow_runs":[{"id":11,"name":"ci","status":"action_required","conclusion":null}]}' ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const runIt = (extra) => spawnSync(process.execPath, [SCRIPT, '7', ...extra], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REVIEW_PR_REPO_ROOT: repo, REVIEW_PR_STATE_DIR: join(root, 'state') } });
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  return { runIt, posts: () => read(posts), queried: () => read(queried) };
}

test('head 与 --expected-head 一致:只按这个 head 查待批 run 并批准', () => {
  const w = world(A);
  const r = w.runIt(['--expected-head', A]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).approved.map((x) => x.id), [11]);
  assert.match(w.queried(), new RegExp(`head_sha=${A}`));
  assert.match(w.posts(), /actions\/runs\/11\/approve/);
});

test('head 已变(判门后推了新提交):不查、不批,退 2 并写明', () => {
  const w = world(B);
  const r = w.runIt(['--expected-head', A]);
  assert.equal(r.status, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.headChanged, true);
  assert.equal(out.refused, true);
  assert.match(out.error, /head 已变为 bbbbbbbbbbbb/);
  assert.equal(w.posts(), '', '没有任何 approve 请求');
  assert.equal(w.queried(), '', '不查新 head 的 run');
});

test('不带 --expected-head:行为与改动前相同(批当前 head 的 run)', () => {
  const w = world(B);
  const r = w.runIt([]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).approved.map((x) => x.id), [11]);
});

test('--expected-head 不是 SHA:直接报错,不批', () => {
  const w = world(A);
  const r = w.runIt(['--expected-head', 'not-a-sha']);
  assert.notEqual(r.status, 0);
  assert.equal(w.posts(), '');
});
