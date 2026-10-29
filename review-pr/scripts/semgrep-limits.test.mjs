// semgrep-limits.test.mjs — semgrep-limits 补丁:security-scan 调 semgrep 时限 4 路并行、2G 内存。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORK = mkdtempSync(join(tmpdir(), 'semgrep-limits-'));
const SHA = 'a'.repeat(40);

test('SC3 security-scan 调 semgrep 时带 --jobs 4 和 --max-memory 2048', () => {
  const bin = join(WORK, 'bin');
  const repo = join(WORK, 'repo');
  const argsFile = join(WORK, 'semgrep-args.txt');
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(bin, 'semgrep'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi
printf '%s\\n' "$@" > "${argsFile}"
echo '{"results":[],"errors":[]}'
`);
  chmodSync(join(bin, 'semgrep'), 0o755);
  const script = join(dirname(fileURLToPath(import.meta.url)), 'security-scan.mjs');
  const r = spawnSync(process.execPath, [script, '--base', SHA], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REVIEW_PR_REPO_ROOT: repo } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).semgrep.available, true, r.stdout);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  assert.equal(args[args.indexOf('--jobs') + 1], '4');
  assert.equal(args[args.indexOf('--max-memory') + 1], '2048');
});
