import assert from 'node:assert/strict';
import { applyReviewedEntries, reviewSelection } from './review-state.mjs';

const headA = 'a'.repeat(40);
const headB = 'b'.repeat(40);
const snapshot = [
  { number: 1, head: headA, isDraft: false },
  { number: 2, head: headB, isDraft: false },
  { number: 3, head: headA, isDraft: true },
];

let state = applyReviewedEntries({ version: 1, prs: {} }, [
  { pr: 1, head: headA, reviewed: true },
  { pr: 2, head: headA, reviewed: false },
  { pr: 3, head: headA, reviewed: true },
]);
let selected = reviewSelection(snapshot, state);
assert.deepEqual(selected.reviewCandidates.map((p) => p.number), [2]);
assert.deepEqual(selected.reviewedUnchanged, [1]);

state = applyReviewedEntries(state, [{ pr: 2, head: headB, codeReview: true, outcome: 'reviewed-only' }]);
selected = reviewSelection(snapshot, state);
assert.deepEqual(selected.reviewCandidates, []);
assert.deepEqual(selected.reviewedUnchanged, [1, 2]);

console.log('review-state.test.mjs: 全部通过');
