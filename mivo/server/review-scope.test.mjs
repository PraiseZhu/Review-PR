// review.mjs publish 的结果包带上 specDigest,下一轮 downloadPrevious 能原样读回(全量、增量、沿用三种模式)。
// dry-run 模式不写 GitHub;不调模型(答卷直接放进工作目录)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { previousFromResult } from '../lib/scope.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));
const SHA = 'a'.repeat(40);
const REPORT = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'pass —— 没有 P0/P1。'].join('\n');
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n');

for (const mode of ['full', 'incremental', 'reuse']) {
  test(`结果包往返:${mode} 模式的 result.json 带 specDigest,下一轮读得回`, () => {
    const work = mkdtempSync(join(tmpdir(), `mivo-review-scope-${mode}-`));
    try {
      for (const dir of ['input', 'out', 'repo', 'prev']) mkdirSync(join(work, dir), { recursive: true });
      writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
      writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
      const scope = mode === 'reuse' ? { mode, reason: '同一版本已审过,沿用上次结论', files: [], previousFindings: [], basedOn: SHA }
        : { mode, reason: mode === 'full' ? '没有上一轮审查记录' : '增量(基于 h0,本轮审 1 个文件)', files: ['src/a.ts'], previousFindings: [] };
      const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: SHA, base: SHA, tier: 'standard', prevRunId: mode === 'full' ? '' : '41',
        roundId: 'round-12345678', attempt: 1, mode: 'dry-run', action: 'review', skillSha: SHA, runId: '42', runUrl: '' };
      writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard', warnings: [], errors: [],
        context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
          evidence: { head: SHA, base: SHA, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
        current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
        previous: mode === 'full' ? null : { head: 'h0', runId: '41', lastFullReviewAt: '2026-10-10T12:00:00Z' },
        scope, deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] } }));
      writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: REPORT, findings: [] }));
      writeFileSync(join(work, 'prev', 'result.json'), JSON.stringify({ mivo: { findings: [], deferred: [], lastFullReviewAt: '2026-10-10T12:00:00Z' } }));
      writeFileSync(join(work, 'prev', 'report.md'), REPORT);
      const r = spawnSync(process.execPath, [REVIEW, 'publish'], { env: { ...process.env, MIVO_REVIEW_WORK: work, GH_TOKEN: '', CHECKS_TOKEN: '' }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const result = JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
      assert.equal(result.outcome, 'approval', JSON.stringify(result));
      assert.equal(result.mivo.specDigest, 'spec-xyz');
      assert.equal(result.mivo.scope.mode, mode);
      const back = previousFromResult(result, readFileSync(join(work, 'out', 'report.md'), 'utf8'));
      assert.equal(back.specDigest, 'spec-xyz');
      assert.equal(back.reportComplete, true);
      assert.ok(back.lastFullReviewAt);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
}

test('head fallback warns in result:规则文件回退到 head 时,结果包带 rulesSource 与告警;v1 上一轮结果的增量轮不报错', () => {
  const work = mkdtempSync(join(tmpdir(), 'mivo-review-rules-'));
  try {
    for (const dir of ['input', 'out', 'repo', 'prev']) mkdirSync(join(work, dir), { recursive: true });
    writeFileSync(join(work, 'input', 'context.json'), JSON.stringify({ pr: 7, meta: {} }));
    writeFileSync(join(work, 'input', 'pr.diff'), DIFF);
    const input = { targetRepo: 'o/r', workflowRepo: 'o/r', pr: 7, head: SHA, base: SHA, tier: 'standard', prevRunId: '41',
      roundId: 'round-12345678', attempt: 1, mode: 'dry-run', action: 'review', skillSha: SHA, runId: '42', runUrl: '' };
    // 上一轮结果是 v1 形状(没有 key / convergence):toPreviousRound 给出空清单,本轮照常发布。
    writeFileSync(join(work, 'state.json'), JSON.stringify({ version: 1, input, phase: 'prepared', tier: 'standard',
      warnings: ['规则文件 base 版本取不到,本轮按 head 读'], errors: [], rulesSource: 'head-fallback', rulesBaseDir: null,
      context: { file: join(work, 'input', 'context.json'), diffFile: join(work, 'input', 'pr.diff'), url: 'https://github.com/o/r/pull/7',
        evidence: { head: SHA, base: SHA, baseRefName: 'main', diffHash: 'd1' }, baseRefName: 'main', viewerIsAuthor: false },
      current: { specDigest: 'spec-xyz', filePatchHashes: { 'src/a.ts': 'h' }, totalDiffLines: 1, triggerKinds: [] },
      previousRound: { roundIndex: null, findings: [], keys: [] }, previous: { head: 'h0', runId: '41' },
      scope: { mode: 'incremental', reason: '增量(基于 h0,本轮审 1 个文件)', files: ['src/a.ts'], previousFindings: [{ path: 'src/a.ts', body: '[P1] 旧问题' }], changedFiles: ['src/a.ts'] },
      deferrals: { verified: [], rejected: [] }, codex: { attempts: [{ ok: true }] } }));
    writeFileSync(join(work, 'answer.json'), JSON.stringify({ report: REPORT, findings: [] }));
    const r = spawnSync(process.execPath, [REVIEW, 'publish'], { env: { ...process.env, MIVO_REVIEW_WORK: work, GH_TOKEN: '', CHECKS_TOKEN: '' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(readFileSync(join(work, 'out', 'result.json'), 'utf8'));
    assert.equal(result.outcome, 'approval', JSON.stringify(result));
    assert.equal(result.mivo.rulesSource, 'head-fallback');
    assert.ok(result.warnings.includes('规则文件 base 版本取不到,本轮按 head 读'));
    assert.equal(result.mivo.convergence.roundIndex, null, '有上一轮但数不出轮次,不猜');
  } finally { rmSync(work, { recursive: true, force: true }); }
});
