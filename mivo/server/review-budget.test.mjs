// review.mjs 的 codex / publish 两段:读不到作业开始时间时不启动模型,结果记 error 交给 Mini 重试。
// 不碰 GitHub:没有 GitHub 令牌,check 写入被跳过;模型凭据是假的,一旦真去调模型就会报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inBusinessWindow } from '../lib/health.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const SHA = 'a'.repeat(40);

test('读不到作业开始时间:codex 阶段不启动模型,publish 记 error 并写明原因', { skip: !inBusinessWindow() && '06:00–07:00 维护窗口内服务器本来就不审' }, () => {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-budget-'));
  try {
    mkdirSync(join(work, 'input'), { recursive: true });
    mkdirSync(join(work, 'out'), { recursive: true });
    mkdirSync(join(work, 'repo'), { recursive: true });
    writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
    writeFileSync(join(work, 'input', 'pr.diff'), '');
    const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: SHA, base: SHA, tier: 'heavy', prevRunId: '', roundId: 'round-12345678',
      attempt: 1, mode: 'dry-run', action: 'review', skillSha: SHA, runId: '1', runUrl: '' };
    writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'heavy', warnings: [], errors: [],
      jobStart: { at: null, from: null, error: '读不到作业开始时间:HTTP 502' },
      context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff') },
      scope: { mode: 'full', reason: '没有上一轮审查记录', files: [] } }));
    const env = { ...process.env, MIVO_REVIEW_WORK: work, MIVO_REVIEW_HEALTH_MARKER: join(work, 'no-marker'),
      LITELLM_CREDENTIALS_JSON: '{}', CODEX_BIN: join(work, 'no-codex'), GH_TOKEN: '', CHECKS_TOKEN: '' };
    for (const phase of ['codex', 'publish']) {
      const r = spawnSync(process.execPath, [REVIEW, phase], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, `${phase}:${r.stderr}`);
    }
    const state = JSON.parse(readFileSync(join(work, 'state.json'), 'utf8'));
    assert.equal(state.codex.skipped, 'job-start-unknown');
    assert.deepEqual(state.codex.attempts, []);
    assert.equal(state.codex.budget.jobTimeoutMin, 110, '没传 MIVO_REVIEW_JOB_TIMEOUT_MIN 时按旧 workflow 的 110 分钟');
    const result = JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
    assert.equal(result.outcome, 'error');
    assert.equal(result.retry, true);
    assert.match(result.reason, /没有启动模型\(读不到作业开始时间:HTTP 502\)/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
