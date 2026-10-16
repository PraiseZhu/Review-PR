// auto-update.mjs 的命令行行为:临时 HOME 里放一个假的 skill 检出,PATH 最前面放 gh 替身,按场景文件回答。
// 不覆盖真正换版本那一步(要 ssh、launchctl),那一步由 deploy-tuple.mjs --selftest 和上线核对兜住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'auto-update.mjs');
const B = 'b'.repeat(40);
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8'));
const a = process.argv.slice(2).join(' ');
const out = (v) => process.stdout.write(String(v) + '\\n');
if (s.fail) { process.stderr.write('HTTP 502: Bad Gateway'); process.exit(1); }
if (a.startsWith('variable get MIVO_REVIEW_SKILL_SHA -R xindong/mivo-canvas-plugin')) out(s.variable);
else if (a.includes('/check-runs')) out(JSON.stringify(s.checks));
else if (a.includes('/compare/')) out(s.compare);
else if (a.startsWith('api repos/PraiseZhu/Review-PR/commits/main ')) out(s.main);
else { process.stderr.write('gh 替身没准备这个调用: ' + a); process.exit(1); }
`;

// helpers
function setup(t, toScenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-auto-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, 'home/mivo-prereview/skill');
  fs.mkdirSync(skill, { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', skill, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(toScenario(head)));
  const env = { ...process.env, HOME: path.join(root, 'home'), PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_SCENARIO: path.join(root, 'scenario.json') };
  return (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
}
const ok = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });

test('已是最新:前置检查跳过本轮(exit 2),检查完整成功时打印 CINDY_PRECHECK_OK', (t) => {
  const run = setup(t, (head) => ({ variable: head, main: head }));
  const r = run('--check');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /已是最新/);
  assert.match(r.stdout, /^CINDY_PRECHECK_OK$/m);
});

test('有新版本且 CI 全部成功:前置检查放行(exit 0)', (t) => {
  const run = setup(t, (head) => ({ variable: head, main: B, compare: 'ahead', checks: [ok('node-test'), ok('personal-ci', 'skipped')] }));
  const r = run('--check');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /→ bbbbbbb/);
  assert.match(r.stdout, /^CINDY_PRECHECK_OK$/m);
});

test('main 的 CI 还没跑完:前置检查跳过本轮,执行模式也只报「今天不换」', (t) => {
  const run = setup(t, (head) => ({ variable: head, main: B, compare: 'ahead', checks: [{ name: 'node-test', status: 'queued', conclusion: null }] }));
  const check = run('--check');
  assert.equal(check.status, 2, check.stderr);
  assert.match(check.stdout, /还没跑完/);
  const exec = run('--cindy-script');
  assert.equal(exec.status, 0, exec.stderr);
  assert.match(JSON.parse(exec.stdout).resultText, /今天不换.*还没跑完/);
});

test('Mini 检出和仓库变量不一致:前置检查放行,执行那一轮报错退出,stdout 不写东西', (t) => {
  const run = setup(t, () => ({ variable: 'a'.repeat(40), main: B }));
  const check = run('--check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /不一致/);
  const exec = run('--cindy-script');
  assert.equal(exec.status, 1);
  assert.equal(exec.stdout, '');
  assert.match(exec.stderr, /今天不自动换.*不一致/);
});

test('main 的 CI 没过或不是线上的后续提交:执行那一轮报错退出', (t) => {
  const failed = setup(t, (head) => ({ variable: head, main: B, compare: 'ahead', checks: [ok('node-test', 'failure')] }));
  const r = failed('--cindy-script');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /CI 没过:node-test=failure/);
  const diverged = setup(t, (head) => ({ variable: head, main: B, compare: 'diverged', checks: [ok('node-test')] }));
  assert.match(diverged('--cindy-script').stderr, /不是线上/);
});

test('读不到 GitHub:前置检查 exit 1,不打印 CINDY_PRECHECK_OK', (t) => {
  const run = setup(t, () => ({ fail: true }));
  const r = run('--check');
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /CINDY_PRECHECK_OK/);
  assert.match(r.stderr, /查不了.*HTTP 502/);
});

test('执行模式已是最新:stdout 只有一行 cindy-script/1 收尾帧', (t) => {
  const run = setup(t, (head) => ({ variable: head, main: head }));
  const r = run('--cindy-script');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  const frame = JSON.parse(lines[0]);
  assert.equal(frame.protocol, 'cindy-script/1');
  assert.equal(frame.type, 'complete');
  assert.match(frame.resultText, /今天不换:已是最新/);
});
