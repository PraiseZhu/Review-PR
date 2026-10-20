// app-read-route 补丁在 review.mjs 这一层:publish 的 child 脚本拿到分流日志路径,
// 结果包 result.json 里带出分流汇总(app / appFallback / user 和原因),部署后据此核对分流是否生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const SHA = 'b'.repeat(40);

function setup() {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-route-'));
  for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
  const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: SHA, base: SHA, tier: 'standard', prevRunId: '',
    roundId: 'round-12345678', attempt: 1, mode: 'dry-run', action: 'protected-approve', skillSha: SHA, runId: '9', runUrl: '' };
  const protectedApproval = { by: 'maintainer', via: 'github-approve', at: null, fingerprint: 'github-approve:maintainer:' };
  writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', warnings: [], errors: [],
    context: { url: 'https://github.com/o/r/pull/7', evidence: { head: SHA, base: SHA, diffHash: 'd1' }, baseRefName: 'main', protectedFiles: true },
    protectedApproval }));
  return work;
}
const publish = (work) => {
  const r = spawnSync(process.execPath, [REVIEW, 'publish'], { env: { ...process.env, MIVO_REVIEW_WORK: work }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
};

test('结果包带出分流汇总', () => {
  const work = setup();
  try {
    const rows = [{ route: 'app', reason: 'rest_get' }, { route: 'app', reason: 'graphql_query' },
      { route: 'app-fallback', reason: 'app_denied_retry_user' }, { route: 'user', reason: 'write_method' }];
    writeFileSync(join(work, 'out', 'gh-routes.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const ghRoute = publish(work).mivo.ghRoute;
    assert.deepEqual({ app: ghRoute.app, appFallback: ghRoute.appFallback, user: ghRoute.user }, { app: 2, appFallback: 1, user: 1 });
    assert.equal(ghRoute.reasons['app:rest_get'], 1);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('没有分流日志(没开分流)时结果包不带 ghRoute', () => {
  const work = setup();
  try {
    assert.equal('ghRoute' in publish(work).mivo, false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
