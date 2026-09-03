#!/usr/bin/env node
// fix-session-state-disabled.test.mjs — 5.4 停用后 get 不投递、set 拒绝写盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshTempDir, initRepo, resolveStateDir } from './helpers.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fix-session-state.mjs');

function setupRepo() {
  const repo = freshTempDir('fix-session-disabled-');
  initRepo(repo, { gitignore: 'history/\n' });
  mkdirSync(join(repo, 'history', 'loops', 'review-pr', 'state'), { recursive: true });
  const { stateDir, status, stderr } = resolveStateDir(repo);
  assert.equal(status, 0, stderr);
  return { repo, stateDir };
}

function run(repo, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_PR_REPO_ROOT: repo },
  });
}

function parseJson(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`stdout 里没有 JSON:\n${stdout.slice(0, 800)}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

test('get: shouldDispatch 恒 false,不因无绑定而建议 create', () => {
  const { repo } = setupRepo();
  const r = run(repo, ['get', '12', '--fingerprint', 'abc']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = parseJson(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.shouldDispatch, false);
  assert.equal(out.sessionId, null);
  assert.match(out.reason, /5\.4 已停用/);
});

test('set: 失败退出且不写新绑定', () => {
  const { repo, stateDir } = setupRepo();
  const r = run(repo, ['set', '12', '--session', 'sess_x', '--fingerprint', 'abc']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = parseJson(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.error, /拒绝写绑定/);
  const stateFile = join(stateDir, 'fix-sessions.json');
  assert.equal(existsSync(stateFile), false);
});

test('sweep 仍可清掉已关闭 PR 的历史绑定', () => {
  const { repo, stateDir } = setupRepo();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'fix-sessions.json'), `${JSON.stringify({ 12: { sessionId: 'old', fingerprint: 'x', dispatchedAt: '2026-01-01T00:00:00.000Z' }, 13: { sessionId: 'keep', fingerprint: 'y', dispatchedAt: '2026-01-01T00:00:00.000Z' } }, null, 2)}\n`);
  const r = run(repo, ['sweep', '--open', '13']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = parseJson(r.stdout);
  assert.deepEqual(out.cleared, [12]);
  const saved = JSON.parse(readFileSync(join(stateDir, 'fix-sessions.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['13']);
});
