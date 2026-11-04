// [MIVO-PATCH reviewer-app] signoff-release 在 bot 身份下不写任何放行标记。离线 mock gh,没有 GitHub 写入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function fixtureGh(args, options, fixture) {
  const ok = (value) => ({ status: 0, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const endpoint = args.find((arg) => typeof arg === 'string' && /^(?:repos|orgs)\//.test(arg));
  if (args[0] === 'pr' && args[1] === 'view') return ok({ number: 1, state: 'OPEN', mergedAt: null, author: { login: 'author' }, url: 'https://github.com/o/r/pull/1', labels: [] });
  if (endpoint === 'repos/o/r/issues/1/comments') return ok([[]]);
  fixture.writes = [...(fixture.writes || []), args];
  throw new Error(`unexpected gh command (write or unknown): ${args.join(' ')}`);
}

function runRelease(extraArgs, { viewer, reviewerApps }) {
  const directory = mkdtempSync(join(tmpdir(), 'reviewer-app-signoff-cli-'));
  try {
    const repoRoot = join(directory, 'repo');
    mkdirSync(repoRoot);
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
      assert.equal(spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).status, 0);
    }
    const rulesFile = join(directory, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ maintainerAllowlist: ['maintainer'], maintainerSource: 'allowlist', reviewerApps }));
    const fixtureFile = join(directory, 'fixture.json');
    writeFileSync(fixtureFile, JSON.stringify({}));
    const mockFile = join(directory, 'mock.mjs');
    writeFileSync(mockFile, `import { readFileSync, writeFileSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const fixtureGh = ${fixtureGh.toString()};
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command !== 'gh') return original(command, args, options);
  const fixture = JSON.parse(readFileSync(process.env.APPROVAL_FIXTURE, 'utf8'));
  try { return fixtureGh(args, options, fixture); } finally { writeFileSync(process.env.APPROVAL_FIXTURE, JSON.stringify(fixture)); }
};
syncBuiltinESMExports();
`);
    const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(mockFile).href}`].filter(Boolean).join(' '),
      REVIEW_PR_REPO_ROOT: repoRoot, REVIEW_PR_RULES_FILE: rulesFile, APPROVAL_FIXTURE: fixtureFile, REVIEW_PR_NO_CRED_FALLBACK: '1',
      REVIEW_PR_VIEWER_LOGIN: viewer, REVIEW_PR_VIEWER_ALIASES: '', REVIEW_PR_STATE_DIR: join(directory, 'state') };
    const prep = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {stateFile} from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)}; import {writeFileSync} from 'node:fs'; writeFileSync(stateFile('lock.json'), JSON.stringify({token:'fixture-lock'}));`],
    { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(prep.status, 0, prep.stderr);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('signoff-release.mjs', import.meta.url)), '1',
      '--lock-token', 'fixture-lock', ...extraArgs], { cwd: repoRoot, env, encoding: 'utf8' });
    return { status: child.status, out: child.stdout ? JSON.parse(child.stdout) : null, stderr: child.stderr,
      writes: JSON.parse(readFileSync(fixtureFile, 'utf8')).writes ?? [] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('bot viewer 带 --gates 放行:拒绝,reason=reviewer-app-not-maintainer,没有任何 gh 写', () => {
  for (const by of ['praisebuild[bot]', 'praisebuild']) {
    const result = runRelease(['--gates', 'product', '--by', by, '--expected-authority-digest', `sha256:${'d'.repeat(64)}`],
      { viewer: 'praisebuild[bot]', reviewerApps: ['praisebuild[bot]'] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.out.ok, false);
    assert.equal(result.out.released, false);
    assert.equal(result.out.reason, 'reviewer-app-not-maintainer');
    assert.match(result.out.error, /praisebuild\[bot\]/);
    assert.deepEqual(result.writes, []);
  }
});

test('真人 viewer 但 --by 指向审查 App(两种写法):同样拒绝,不写标记', () => {
  for (const by of ['praisebuild[bot]', 'praisebuild']) {
    const result = runRelease(['--gates', 'product', '--by', by, '--expected-authority-digest', `sha256:${'d'.repeat(64)}`],
      { viewer: 'maintainer', reviewerApps: ['praisebuild[bot]'] });
    assert.equal(result.out.reason, 'reviewer-app-not-maintainer', by);
    assert.deepEqual(result.writes, []);
  }
});
