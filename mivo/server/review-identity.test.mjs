// identity-env 补丁:沙箱仓检查镜像的跨仓派发用 REVIEW_PR_IDENTITY_TOKEN,没设时用 GH_TOKEN;
// 其余写入(本仓 check-runs)仍用 GH_TOKEN。gh 用 PATH 上的替身记录每次调用拿到的令牌。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const SHA = 'a'.repeat(40);
const FAKE_PUBLISH = 'fixture-publish';
const FAKE_ID = 'fixture-id';

function fakeGh(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'gh-calls.jsonl');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, seen: process.env.GH_TOKEN ?? null }) + '\\n');
process.stdout.write(JSON.stringify({ id: 5 }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

function setup({ mode, targetRepo }) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-identity-'));
  for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
  const input = { targetRepo, workflowRepo: 'o/r', pr: 971, head: SHA, base: SHA, tier: 'standard', prevRunId: '',
    roundId: 'round-12345678', attempt: 1, mode, action: 'protected-approve', skillSha: SHA, runId: '42', runUrl: '' };
  const protectedApproval = { by: 'kirozeng', via: 'github-approve', at: null, fingerprint: 'github-approve:kirozeng:' };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', warnings: [], errors: [],
    context: { url: `https://github.com/${targetRepo}/pull/971`, evidence: { head: SHA, base: SHA, diffHash: 'd1' }, baseRefName: 'main', protectedFiles: true },
    protectedApproval }));
  return work;
}

function publish(work, gh, extraEnv = {}) {
  const env = { ...process.env, MIVO_REVIEW_WORK: work, GH_TOKEN: FAKE_PUBLISH, CHECKS_TOKEN: 'y', PATH: `${gh.bin}${delimiter}${process.env.PATH}` };
  delete env.REVIEW_PR_IDENTITY_TOKEN;
  const r = spawnSync(process.execPath, [REVIEW, 'publish'], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

const dispatchCall = (gh) => gh.calls().find((c) => c.args[0] === 'workflow' && c.args[1] === 'run');

test('sandbox:跨仓派发检查镜像用 REVIEW_PR_IDENTITY_TOKEN', () => {
  const work = setup({ mode: 'sandbox', targetRepo: 'o/sandbox' });
  const gh = fakeGh(work);
  try {
    publish(work, gh, { REVIEW_PR_IDENTITY_TOKEN: FAKE_ID });
    const call = dispatchCall(gh);
    assert.ok(call, '应派发沙箱检查镜像');
    assert.ok(call.args.includes('o/sandbox'));
    assert.equal(call.seen, FAKE_ID);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('sandbox:没设 REVIEW_PR_IDENTITY_TOKEN(或为空)时仍用 GH_TOKEN', () => {
  for (const extra of [{}, { REVIEW_PR_IDENTITY_TOKEN: '  ' }]) {
    const work = setup({ mode: 'sandbox', targetRepo: 'o/sandbox' });
    const gh = fakeGh(work);
    try {
      publish(work, gh, extra);
      assert.equal(dispatchCall(gh)?.seen, FAKE_PUBLISH);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
});

test('live:本仓 check-runs 写入不受 REVIEW_PR_IDENTITY_TOKEN 影响(用 CHECKS_TOKEN)', () => {
  const work = setup({ mode: 'live', targetRepo: 'o/r' });
  const gh = fakeGh(work);
  try {
    publish(work, gh, { REVIEW_PR_IDENTITY_TOKEN: FAKE_ID });
    const check = gh.calls().find((c) => c.args.includes('repos/o/r/check-runs'));
    assert.ok(check, '应写 check run');
    assert.equal(check.seen, 'y');
    assert.ok(!gh.calls().some((c) => c.seen === FAKE_ID));
  } finally { rmSync(work, { recursive: true, force: true }); }
});
