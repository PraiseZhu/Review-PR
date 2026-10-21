import test from 'node:test';
import assert from 'node:assert/strict';
import { finalFullLine, finalizeReport, pendingFinalFullReport } from './report.mjs';

const base = { pr: 1, url: 'https://github.com/o/r/pull/1', head: 'a'.repeat(40), base: 'b'.repeat(40), diffHash: 'c'.repeat(64), tier: 'standard' };
const body = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'pass —— 没有 P0/P1/P2。'].join('\n');

test('收口状态行:同一次运行收口 / 补跑 / 直接全量 / 修复轮免收口 / 待补 / 失败各有说法,没有记录不写', () => {
  assert.equal(finalFullLine({}), null);
  assert.match(finalFullLine({ finalFull: { outcome: 'clean' }, kind: 'same-run' }), /同一次运行接着对完整 diff 做了放行前收口全量/);
  assert.match(finalFullLine({ finalFull: { outcome: 'findings' }, kind: 'budget-retry' }), /补跑/);
  assert.match(finalFullLine({ finalFull: { outcome: 'clean' }, kind: 'direct-full' }), /不需要再做收口/);
  assert.equal(finalFullLine({ finalFull: { outcome: 'skipped-fix-round' } }), '收口全量:本轮是修复轮,改动只落在上次收口问题所在文件,未再收口。');
  assert.match(finalFullLine({ finalFull: { outcome: 'pending-budget' } }), /收口待补/);
  assert.match(finalFullLine({ finalFull: { outcome: 'error' } }), /收口未完成/);
});

test('finalizeReport 把收口状态写在 Verification 的审查范围行下面;没传时报告与之前一致', () => {
  const plain = finalizeReport({ ...base, report: body, findings: [], scope: { mode: 'full', reason: '没有上一轮审查记录' } });
  assert.ok(!plain.includes('收口全量'));
  const withLine = finalizeReport({ ...base, report: body, findings: [], scope: { mode: 'full', purpose: 'final-full', reason: '放行前收口全量' },
    finalFull: { outcome: 'skipped-fix-round' }, finalFullKind: null });
  assert.match(withLine, /## Verification\n\n审查范围:全量\(放行前收口全量\)\n\n收口全量:本轮是修复轮/);
});

test('收口待补的报告:Overall 写 pending,不能是 pass;写明剩余预算与门槛', () => {
  const text = pendingFinalFullReport({ ...base, scope: { reason: '增量(基于 h0,本轮审 1 个文件)' }, remainingMs: 50 * 60_000, requiredMs: 67 * 60_000, skillSha: 's'.repeat(40), specDigest: 'd'.repeat(64) });
  assert.match(text, /## Overall\n\npending —— 收口待补，尚未放行。/);
  assert.doesNotMatch(text, /pass —— /);
  assert.match(text, /剩余模型预算约 50 分钟,收口全量至少需要 67 分钟/);
  assert.match(text, /head `a{12}`/);
  for (const section of ['## Findings', '## Rule coverage', '## Verification', '## Overall']) assert.ok(text.includes(section), section);
});
