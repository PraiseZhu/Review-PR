// 链式收口(#262)在报告里的说明:只审改动并放行的轮次,写明没有再全量以及依据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalFullLine, finalizeReport } from './report.mjs';

const ANCHOR = 'c'.repeat(40);
const SKIPPED = { head: 'b'.repeat(40), runId: '42', outcome: 'skipped-small-delta', basedOn: { head: ANCHOR, runId: '40' }, rounds: 2, changedLines: 173 };

test('SC7 finalFullLine:写明只审了改动处、未再全量、上次全量所在版本、第几轮、累计行数', () => {
  assert.equal(finalFullLine({ finalFull: SKIPPED }),
    '收口全量:本轮改动小,只审了改动处,未再全量。上次全量审查在 `cccccccccccc`,这是之后第 2 轮,累计改动 173 行,在限额内。');
});

test('SC7 finalFullLine:依据字段不全(经 readFinalFull 读回的精简记录)时只写结论,不拼出 undefined', () => {
  const line = finalFullLine({ finalFull: { head: SKIPPED.head, runId: '42', outcome: 'skipped-small-delta' } });
  assert.equal(line, '收口全量:本轮改动小,只审了改动处,未再全量。');
});

test('SC7 其它收口说明不变', () => {
  assert.match(finalFullLine({ finalFull: { outcome: 'skipped-fix-round' } }), /本轮是修复轮/);
  assert.match(finalFullLine({ finalFull: { outcome: 'clean' }, kind: 'same-run' }), /同一次运行接着对完整 diff 做了放行前收口全量/);
  assert.match(finalFullLine({ finalFull: { outcome: 'clean' }, kind: 'direct-full' }), /本轮已审完整 diff/);
  assert.equal(finalFullLine({}), null);
});

test('SC7 finalizeReport:说明落在 Verification 一节的审查范围下面', () => {
  const report = ['## Findings', '无', '## Rule coverage', 'AGENTS.md', '## Verification', '未执行', '## Overall', 'pass —— 没有 P0/P1/P2。'].join('\n');
  const out = finalizeReport({ report, findings: [], pr: 7, url: 'u', head: SKIPPED.head, base: 'a'.repeat(40), diffHash: 'd', tier: 'standard',
    scope: { mode: 'incremental', reason: '增量(基于 aaaaaaaaaaaa,本轮审 1 个文件)' }, finalFull: SKIPPED, finalFullKind: null });
  assert.match(out, /## Verification\n\n审查范围:增量\(基于 aaaaaaaaaaaa,本轮审 1 个文件\)\n\n收口全量:本轮改动小,只审了改动处,未再全量。/);
});
