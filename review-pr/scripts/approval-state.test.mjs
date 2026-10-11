import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalReceiptFromReview, existingMaintainerApprovalReceipt, validateApprovalDisposition } from './approval-state.mjs';

const head = 'a'.repeat(40);
const review = { id: 123, state: 'APPROVED', user: { login: 'maintainer' }, commit_id: head,
  submitted_at: '2026-09-08T00:00:00Z', html_url: 'https://github.com/o/r/pull/1#pullrequestreview-123' };

test('only a submitted review by the expected viewer on the reviewed head becomes a receipt', () => {
  const receipt = approvalReceiptFromReview(review, { viewer: 'Maintainer', head, now: 0 });
  assert.equal(receipt.reviewId, '123');
  assert.equal(receipt.reviewer, 'maintainer');
  assert.equal(receipt.verifiedAt, '1970-01-01T00:00:00.000Z');
  for (const patch of [{ id: null }, { state: 'PENDING' }, { state: 'DISMISSED' },
    { user: { login: 'someone-else' } }, { commit_id: 'b'.repeat(40) }, { submitted_at: null }]) {
    assert.equal(approvalReceiptFromReview({ ...review, ...patch }, { viewer: 'maintainer', head }), null);
  }
});

test('the round contract rejects bare success and incomplete receipts but preserves explicit pending and blocked states', () => {
  assert.throws(() => validateApprovalDisposition({ approved: true }, { head }), /回执/);
  const receipt = approvalReceiptFromReview(review, { viewer: 'maintainer', head });
  for (const patch of [{ reviewId: '' }, { reviewer: '' }, { head: 'b'.repeat(40) }, { verifiedAt: 'not a date' }]) {
    assert.throws(() => validateApprovalDisposition({ ...receipt, ...patch }, { head }), /回执/);
  }
  for (const status of ['pending', 'blocked']) {
    assert.throws(() => validateApprovalDisposition({ status }), /原因/);
    assert.deepEqual(validateApprovalDisposition({ status, reason: '明确原因' }), { status, reason: '明确原因' });
  }
});

test('an existing independent maintainer approval satisfies an author viewer without self-approving', () => {
  const currentHead = 'b'.repeat(40);
  const review = { id: 456, state: 'APPROVED', user: { login: 'zqchris' }, commit_id: 'a'.repeat(40),
    submitted_at: '2026-09-08T00:00:00Z', html_url: 'https://github.com/o/r/pull/1#pullrequestreview-456' };
  const receipt = existingMaintainerApprovalReceipt(review, {
    author: 'MagicLizi', maintainers: ['MagicLizi', 'zqchris'], reviewDecision: 'APPROVED', head: currentHead, now: 0,
  });
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.reviewer, 'zqchris');
  assert.equal(receipt.head, currentHead);
  assert.equal(receipt.reviewHead, 'a'.repeat(40));
  assert.equal(receipt.source, 'existing-maintainer-review');
  assert.equal(existingMaintainerApprovalReceipt({ ...review, user: { login: 'MagicLizi' } }, {
    author: 'MagicLizi', maintainers: ['MagicLizi', 'zqchris'], reviewDecision: 'APPROVED', head: currentHead,
  }), null);
});
