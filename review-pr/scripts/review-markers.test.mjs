import assert from 'node:assert/strict';
import { gateReviewMarker, selectGateReviewsToDismiss } from './review-markers.mjs';

const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const marker = gateReviewMarker('format', old);
const reviews = [
  { id: 1, state: 'CHANGES_REQUESTED', user: { login: 'bot' }, commit_id: old, body: marker },
  { id: 2, state: 'CHANGES_REQUESTED', user: { login: 'bot' }, commit_id: old, body: '普通内容审查' },
  { id: 3, state: 'CHANGES_REQUESTED', user: { login: 'bot' }, commit_id: head, body: gateReviewMarker('security', head) },
];
assert.deepEqual(selectGateReviewsToDismiss(reviews, 'bot', head).map((r) => r.id), [1]);
assert.deepEqual(selectGateReviewsToDismiss(reviews, 'other', head), []);
console.log('review-markers.test.mjs: 全部通过');
