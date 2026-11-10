// #133:任务 issue 只读、只记。publish 把 prepare 写好的摘要带进结果包 mivo.taskIssue,结论与不读任务 issue 时相同;
// 读不到(unreadable)时也只多一笔摘要,不改结论。codex 阶段拿不到 GitHub 令牌,任务 issue 材料只能来自 task-issue.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runCodex } from './codex.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const SHA = 'b'.repeat(40);

function run(taskIssue) {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-task-issue-'));
  try {
    for (const dir of ['input', 'out', 'repo']) mkdirSync(join(work, dir), { recursive: true });
    const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: SHA, base: SHA, tier: 'standard', prevRunId: '',
      roundId: 'round-12345678', attempt: 1, mode: 'dry-run', action: 'protected-approve', skillSha: SHA, runId: '9', runUrl: '' };
    const protectedApproval = { by: 'maintainer', via: 'github-approve', at: null, fingerprint: 'github-approve:maintainer:' };
    writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', warnings: [], errors: [],
      context: { url: 'https://github.com/o/r/pull/7', evidence: { head: SHA, base: SHA, diffHash: 'd1' }, baseRefName: 'main', protectedFiles: true },
      protectedApproval, ...(taskIssue ? { taskIssue } : {}) }));
    const r = spawnSync(process.execPath, [REVIEW, 'publish'], { env: { ...process.env, MIVO_REVIEW_WORK: work }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
  } finally { rmSync(work, { recursive: true, force: true }); }
}
const verdict = (result) => ({ outcome: result.outcome, reason: result.reason, reviewed: result.reviewed, reviewClean: result.reviewClean, merged: result.merged });

test('有摘要时结果包带 mivo.taskIssue,结论与不读任务 issue 时相同', () => {
  const summary = { ref: 'o/r#12', digest: 'a'.repeat(64), trust: 'plan', scList: [{ sc: 'SC1', layer: 'unit' }],
    parent: { ref: 'o/r#100', via: 'api', trust: 'plan', digest: 'c'.repeat(64) }, baseRef: 'main', status: 'read', truncated: [] };
  const without = run(null);
  const withIssue = run({ mode: 'observe', file: '/x/task-issue.json', summary });
  assert.equal('taskIssue' in without.mivo, false);
  assert.deepEqual(withIssue.mivo.taskIssue, summary);
  assert.deepEqual(verdict(withIssue), verdict(without));
});

test('任务 issue 读不到时只多一笔 unreadable 摘要,结论不变', () => {
  const summary = { ref: null, digest: null, trust: null, scList: [], parent: null, baseRef: 'main', status: 'unreadable', truncated: [] };
  const without = run(null);
  const unreadable = run({ mode: 'observe', file: '/x/task-issue.json', summary });
  assert.equal(unreadable.mivo.taskIssue.status, 'unreadable');
  assert.deepEqual(verdict(unreadable), verdict(without));
});

test('SC6:codex 进程拿不到 GH_TOKEN / GITHUB_TOKEN,shell 子进程也排除这两个变量(进程边界,假 codex 记录实际拿到的环境)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mivo-codex-token-'));
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  try {
    process.env.GH_TOKEN = 'fixture-prepare-token';
    process.env.GITHUB_TOKEN = 'fixture-prepare-token';
    const seen = join(root, 'seen.json');
    const bin = join(root, 'codex');
    writeFileSync(bin, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ gh: process.env.GH_TOKEN ?? null, github: process.env.GITHUB_TOKEN ?? null, args: process.argv.slice(2) }));
process.exit(1);
`, { mode: 0o755 });
    mkdirSync(join(root, 'work'));
    await runCodex({ codexBin: bin, workdir: join(root, 'work'), prompt: 'p', schema: {}, model: 'openai/m', effort: 'low', timeoutMs: 60_000,
      credentials: { apiKey: 'sk-fixture-AAAAAAAAAAAA', baseUrl: 'https://gw.example.com/v1' }, tmpRoot: root, label: 't' });
    const got = JSON.parse(readFileSync(seen, 'utf8'));
    assert.deepEqual([got.gh, got.github], [null, null], 'codex 进程环境里没有 GitHub 令牌');
    const policy = got.args.find((a) => a.startsWith('shell_environment_policy.exclude='));
    assert.ok(policy && /GH_TOKEN/.test(policy) && /GITHUB_TOKEN/.test(policy), '模型起的 shell 也排除这两个变量');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  }
});
