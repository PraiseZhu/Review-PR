import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Like the existing state-dir tests, state fixtures must live outside the skill repository.
const fixtures = tmpdir();
function setup(t) {
  const base = mkdtempSync(join(fixtures, 'review-pr-cli-file-input-'));
  const repo = join(base, 'target');
  const state = join(base, 'state');
  mkdirSync(repo); mkdirSync(state);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, repo, state };
}
function snapshot(path) {
  return Object.fromEntries(readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const name = join(entry.parentPath ?? entry.path, entry.name);
      return [name, readFileSync(name, 'utf8')];
    }));
}
const cases = [
  { script: 'run-log.mjs', flag: '--body-file', args: [], body: '{"processed":[],"draftSkipped":[]}', stateFile: 'last-run.json' },
  { script: 'record-convergence-round.mjs', flag: '--findings-file', args: ['7', '--head', 'head-one'], body: '[{"invariant":"missing check","severity":"P1"}]', stateFile: 'convergence-7.json' },
];
function run(c, f, extra = [], input = '', options = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', c.script), ...c.args, ...extra], {
    cwd: f.repo, env: { ...process.env, REVIEW_PR_REPO_ROOT: f.repo, REVIEW_PR_STATE_DIR: f.state },
    encoding: 'utf8', input, timeout: 10000, ...options,
  });
}
function persisted(f, name) {
  const file = Object.keys(snapshot(f.state)).find((p) => p.endsWith('/' + name));
  assert.ok(file, `missing ${name}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, normalize(v)]));
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? '<timestamp>' : value;
}
for (const c of cases) {
  test(`${c.script}: file and stdin preserve equivalent records`, (t) => {
    const stdin = setup(t), file = setup(t);
    const path = join(file.base, 'input with spaces.json'); writeFileSync(path, c.body);
    const a = run(c, stdin, [], c.body), b = run(c, file, [c.flag, path], ' \n');
    assert.equal(a.status, 0, a.stdout + a.stderr); assert.equal(b.status, 0, b.stdout + b.stderr);
    assert.deepEqual(normalize(persisted(stdin, c.stateFile)), normalize(persisted(file, c.stateFile)));
  });
  test(`${c.script}: file works with ignored stdin and equals syntax`, (t) => {
    const f = setup(t), path = join(f.base, 'input.json'); writeFileSync(path, c.body);
    const result = run(c, f, [`${c.flag}=${path}`], undefined, { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
  test(`${c.script}: explicit file ignores conflicting stdin`, (t) => {
    const f = setup(t), path = join(f.base, 'input.json'); writeFileSync(path, c.body);
    const result = run(c, f, [c.flag, path], '{invalid stdin');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    persisted(f, c.stateFile);
  });
  test(`${c.script}: file works with closed stdin fd`, (t) => {
    const f = setup(t), path = join(f.base, 'input.json'); writeFileSync(path, c.body);
    const result = spawnSync('/bin/sh', ['-c', 'exec 0<&-; exec "$@"', 'file-input-test',
      process.execPath, join(root, 'scripts', c.script), ...c.args, c.flag, path], {
      cwd: f.repo, env: { ...process.env, REVIEW_PR_REPO_ROOT: f.repo, REVIEW_PR_STATE_DIR: f.state },
      encoding: 'utf8', timeout: 3000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
  test(`${c.script}: file never waits for open stdin pipe`, async (t) => {
    const f = setup(t), path = join(f.base, 'input.json'); writeFileSync(path, c.body);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'scripts', c.script), ...c.args, c.flag, path], {
        cwd: f.repo, env: { ...process.env, REVIEW_PR_REPO_ROOT: f.repo, REVIEW_PR_STATE_DIR: f.state },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('file mode blocked on stdin')); }, 3000);
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, output }); });
      // Deliberately do not close/end the pipe. Any fd0 read would wait forever.
    });
    assert.equal(result.status, 0, result.output);
  });
  test(`${c.script}: rejected input preserves existing business state`, (t) => {
    const f = setup(t), path = join(f.base, 'input.json'); writeFileSync(path, c.body);
    assert.equal(run(c, f, [], c.body).status, 0);
    const before = snapshot(f.state);
    assert.ok(Object.keys(before).some((p) => p.endsWith('/' + c.stateFile)));
    const bad = [
      { args: [c.flag], input: c.body },
      { args: [c.flag, '--other'], input: c.body },
      { args: [`${c.flag}=`], input: c.body },
      { args: [c.flag, path, c.flag, path] },
      { args: [c.flag, path, `${c.flag}=${path}`] },
      { args: [c.flag, join(f.base, 'missing')] },
      { args: [c.flag, f.base] },
    ];
    for (const content of ['', '  \n', '{broken']) {
      const badPath = join(f.base, 'bad-' + bad.length); writeFileSync(badPath, content);
      bad.push({ args: [c.flag, badPath] });
    }
    if (c.flag === '--findings-file') {
      const invalid = join(f.base, 'schema.json'); writeFileSync(invalid, '{}');
      bad.push({ args: [c.flag, invalid] });
      for (const mode of ['--get', '--mark-notified', '--record-attempt']) bad.push({ args: [c.flag, path, mode] });
    }
    for (const entry of bad) {
      const result = run(c, f, entry.args, entry.input ?? '');
      assert.equal(result.status, 1, JSON.stringify(entry) + result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).ok, false);
      assert.deepEqual(snapshot(f.state), before);
    }
  });
  test(`${c.script}: unreadable file fails without writing state`, { skip: process.getuid?.() === 0 }, (t) => {
    const f = setup(t), path = join(f.base, 'private.json'); writeFileSync(path, c.body);
    chmodSync(path, 0); t.after(() => { try { chmodSync(path, 0o600); } catch {} });
    const result = run(c, f, [c.flag, path]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /EACCES|EPERM/);
    assert.deepEqual(snapshot(f.state), {});
  });
}
test('run-log file retains schema-warning behavior', (t) => {
  const f = setup(t), c = cases[0], path = join(f.base, 'null.json'); writeFileSync(path, 'null');
  const result = run(c, f, [c.flag, path]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(JSON.parse(result.stdout).warnings.some((w) => w.includes('顶层应为对象')));
});
