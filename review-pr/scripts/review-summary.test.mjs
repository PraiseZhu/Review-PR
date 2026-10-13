import { buildReviewSummary, formatReviewCard, formatReviewCards } from './review-summary.mjs';
import { formatLocalDisplay } from './local-time.mjs';

let failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) { failed += 1; console.error(`FAIL ${name}: ${a} !== ${e}`); }
  else console.log(`PASS ${name}`);
}

const summary = buildReviewSummary({
  runId: 'fixture-round',
  mode: 'auto',
  repo: 'o/r',
  generatedAt: '2026-09-17T07:25:02.811Z',
  scan: { totalOpen: 4, candidateCount: 3 },
  review: {
    eligibleCount: 3,
    unchangedCount: 1,
    entered: [{ pr: 12, title: 'changed', url: 'https://github.com/o/r/pull/12', head: 'abc' }],
    notEntered: [{ pr: 13, title: 'unchanged', reason: '代码相对上次成功 review 未变化' }, { pr: 14, reason: '存在未 resolve thread' }],
  },
  merge: {
    merged: [{ pr: 12, title: 'changed', url: 'https://github.com/o/r/pull/12', method: 'squash' }],
    notMerged: [{ pr: 14, reason: '存在未 resolve thread' }],
  },
});

eq('counts', {
  entered: summary.review.enteredCount,
  notEntered: summary.review.notEnteredCount,
  merged: summary.merge.mergedCount,
  notMerged: summary.merge.notMergedCount,
  complete: summary.review.coverageComplete,
}, { entered: 1, notEntered: 2, merged: 1, notMerged: 1, complete: true });
eq('run id is stable summary data', summary.runId, 'fixture-round');
eq('five card metrics', summary.metrics, {
  currentPrCount: 4,
  candidateCount: 3,
  enteredCount: 1,
  mergedCount: 1,
  enteredNotMergedCount: 0,
});
eq('dedupe and sort', buildReviewSummary({
  review: { entered: [{ pr: 4, title: 'later' }, { pr: 2, title: 'first' }, { pr: 4, title: 'updated' }] },
  merge: {},
}).review.entered.map((item) => item.pr), [2, 4]);
eq('legacy processed fallback', buildReviewSummary({
  candidateCount: 1,
  processed: [{ pr: 9, phase: 'review', merged: false, reason: 'CI pending' }],
}).review.entered.map((item) => item.pr), [9]);
eq('unchanged PRs are not-entered with an explicit reason', buildReviewSummary({
  review: { eligibleCount: 2, entered: [{ pr: 10 }], unchanged: [{ pr: 11 }] },
}).review.notEntered, [{
  pr: 11, title: '', url: '', head: '', reason: '代码相对上次成功 review 未变化', stage: '', method: '',
}]);
eq('missing merged flag is not treated as not-merged', buildReviewSummary({
  processed: [{ pr: 20, phase: 'review', reason: 'review complete' }],
}).merge.notMerged, []);
eq('review-only preserves merge fact and reports policy violation', (() => {
  const value = buildReviewSummary({ mode: 'review-only', merge: { merged: [{ pr: 21 }] } });
  return { merged: value.merge.mergedCount, violations: value.policyViolations.length };
})(), { merged: 1, violations: 1 });

const enteredNotMerged = buildReviewSummary({
  scan: { totalOpen: 3, candidateCount: 3 },
  review: { eligibleCount: 3, entered: [{ pr: 1 }, { pr: 2 }], notEntered: [{ pr: 3 }] },
  merge: { merged: [{ pr: 1 }], notMerged: [{ pr: 2 }, { pr: 3 }] },
});
eq('not merged metric only counts PRs that entered review', enteredNotMerged.metrics.enteredNotMergedCount, 1);

eq('summary keeps a parseable timestamp', Date.parse(summary.generatedAt), Date.parse('2026-09-17T07:25:02.811Z'));
const diagnostics = buildReviewSummary({
  runId: 'diagnostic-round', repo: 'o/r', scan: { totalOpen: 1, candidateCount: 1, candidateDiagnostics: {
    version: 1, candidateCount: 1, unchangedCount: 0, draftCount: 0, fingerprintChangedCount: 1,
    forcedRecheckCount: 0, baselineMissingCount: 0, baselinePartialCount: 0,
    unattributedFingerprintMismatchCount: 0, reasonCounts: { 'fingerprint-changed': 1 },
    changedFieldCounts: { ci: 1 }, rows: [{ pr: 1, reasonCodes: ['fingerprint-changed'],
      baseline: 'available', changedFields: ['ci'], previousFingerprint: 'a'.repeat(64), fingerprint: 'b'.repeat(64),
      before: { ci: 'SUCCESS' }, after: { ci: 'FAILURE' } }],
  } },
  review: { eligibleCount: 1, entered: [{ pr: 1 }], notEntered: [] },
  merge: { merged: [{ pr: 1 }], notMerged: [] },
});
eq('summary preserves candidate diagnostics for archive', diagnostics.candidateDiagnostics.changedFieldCounts, { ci: 1 });
eq('summary diagnostics preserve before and after fields', [diagnostics.candidateDiagnostics.rows[0].before.ci,
  diagnostics.candidateDiagnostics.rows[0].after.ci], ['SUCCESS', 'FAILURE']);
const cardText = formatReviewCard(summary);
eq('markdown uses host wall clock', cardText.includes(formatLocalDisplay('2026-09-17T07:25:02.811Z')), true);
eq('markdown does not show UTC Z', cardText.includes('2026-09-17T07:25:02.811Z'), false);
eq('text summary is concise', [
  cardText.includes('当前 PR：4'),
  cardText.includes('本轮有变化：3'),
  cardText.includes('进入 Review：1'),
  cardText.includes('本轮已合并：1'),
  cardText.includes('本轮未合并：0'),
  cardText.includes('[#12 · changed](https://github.com/o/r/pull/12)'),
  cardText.includes('未进入 review（'),
  cardText.includes('原因：代码相对上次'),
], [true, true, true, true, true, true, false, false]);

const cards = formatReviewCards(summary);
const rich = cards[0]?.card;
const serialized = JSON.stringify(rich);
eq('single rich card', cards.length, 1);
eq('card title is stable', rich?.header?.title?.content, 'PR Review 汇总');
eq('rich metric rows', rich?.elements?.filter((item) => item.tag === 'column_set').length, 2);
eq('merged hyperlink includes number and title', serialized.includes('[#12 · changed](https://github.com/o/r/pull/12)'), true);
eq('rich card uses host wall clock', serialized.includes(formatLocalDisplay('2026-09-17T07:25:02.811Z')), true);
eq('rich card does not show UTC Z', serialized.includes('2026-09-17T07:25:02.811Z'), false);
const bracketTitleCard = formatReviewCards(buildReviewSummary({
  repo: 'o/r', scan: { totalOpen: 1, candidateCount: 1 },
  review: { eligibleCount: 1, entered: [{ pr: 22 }] },
  merge: { merged: [{ pr: 22, title: '[WIP] fix login', url: 'https://github.com/o/r/pull/22' }], notMerged: [] },
}))[0].card;
eq('lark markdown link escapes title brackets with entities',
  JSON.stringify(bracketTitleCard).includes('[#22 · &#91;WIP&#93; fix login](https://github.com/o/r/pull/22)'), true);
eq('old detail omitted from rich card', [
  serialized.includes('未进入 review（'),
  serialized.includes('本轮未合并（'),
  serialized.includes('原因：代码相对上次'),
  serialized.includes('方式：squash'),
], [false, false, false, false]);

const emptyCards = formatReviewCards(buildReviewSummary({
  runId: 'empty-round', repo: 'o/r', scan: { totalOpen: 1, candidateCount: 1 },
  review: { eligibleCount: 1, entered: [], notEntered: [{ pr: 1 }] },
  merge: { merged: [], notMerged: [{ pr: 1 }] },
}));
eq('zero merge state is explicit', JSON.stringify(emptyCards[0].card).includes('本轮没有合并 PR'), true);

const bulk = buildReviewSummary({
  runId: 'bulk-round', repo: 'o/r', scan: { totalOpen: 20, candidateCount: 20 },
  review: { eligibleCount: 20, entered: Array.from({ length: 20 }, (_, i) => ({ pr: i + 1 })) },
  merge: {
    merged: Array.from({ length: 20 }, (_, i) => ({
      pr: i + 1,
      title: `这是一个需要在卡片空间不足时安全缩短但仍然保留链接的很长标题 ${i + 1}`.repeat(3),
      url: `https://github.com/o/r/pull/${i + 1}`,
    })),
    notMerged: [],
  },
});
const compact = formatReviewCards(bulk, 3_000);
eq('byte pressure still produces one card', compact.length, 1);
eq('byte pressure preserves every merged PR URL',
  Array.from({ length: 20 }, (_, i) => JSON.stringify(compact[0].card).includes(`https://github.com/o/r/pull/${i + 1}`)).every(Boolean), true);
eq('byte pressure respects the requested limit', Buffer.byteLength(JSON.stringify(compact[0].card)) <= 3_000, true);

if (failed) { console.error(`${failed} 个用例失败`); process.exit(1); }
console.log('review-summary.test.mjs: 全部通过');
