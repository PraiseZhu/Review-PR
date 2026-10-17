import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewComments, findingsMarker } from './review-comments.mjs';
import { createPrWriteGuard } from './pr-write-guard.mjs';

test('findings preserve real LEFT/RIGHT or file anchors and reject invented defaults', () => {
  const comments = [{ path: 'src/test.ts', line: 4, side: 'LEFT', body: '[P1] 删除了必要检查' },
    { path: 'src/test.ts', subject_type: 'file', body: '[P1] 文件整体缺少约束' }];
  assert.deepEqual(normalizeReviewComments(comments), comments);
  for (const value of [[], [{ path: 'x', body: 'problem' }], [{ path: 'x', line: 0, side: 'RIGHT', body: 'problem' }],
    [{ path: '../x', line: 3, side: 'RIGHT', body: 'problem' }], [{ ...comments[1], line: 1 }]]) assert.throws(() => normalizeReviewComments(value));
  assert.equal(findingsMarker('head', 'body', comments), findingsMarker('head', 'body', comments));
  assert.notEqual(findingsMarker('new-head', 'body', comments), findingsMarker('head', 'body', comments));
});

test('multi-step hold stops every subsequent write after lock/head/authority/viewer changes', () => {
  for (const change of ['lock', 'head', 'base', 'draft', 'authority', 'viewer', 'author', 'bound-viewer']) {
    let changed = false;
    let writes = 0;
    const guard = createPrWriteGuard({ owner: 'o', repo: 'r', pr: 1, lockToken: 'token', expectedHead: 'head', expectedAuthorityDigest: 'digest', purpose: 'hold',
      expectedBaseRef: 'feature', ...(change === 'bound-viewer' ? { expectedViewer: 'previous-viewer' } : {}) }, {
      assertActiveReviewLock: () => { if (changed && change === 'lock') throw new Error('lost'); },
      gh: (args, options) => {
        if (args[0] === 'api') return { stdout: changed && change === 'viewer' ? 'bob' : 'alice' };
        assert.equal(options.noCredFallback, true); writes++; return { ok: true };
      },
      ghJson: () => ({ state: 'OPEN', isDraft: changed && change === 'draft', headRefOid: changed && change === 'head' ? 'new' : 'head',
        baseRefName: changed && change === 'base' ? 'main' : 'feature', author: { login: 'contributor' } }),
      fetchMaintainerAuthority: () => ({ digest: changed && change === 'authority' ? 'new' : 'digest' }),
      evaluateMaintainerApprovalPolicy: () => ({ viewerIsMaintainer: true, authorIsMaintainer: changed && change === 'author' }),
    });
    if (change === 'bound-viewer') {
      assert.throws(() => guard(['issue', 'create']));
      assert.equal(writes, 0);
      continue;
    }
    guard(['issue', 'create']); changed = true;
    assert.throws(() => guard(['pr', 'comment']));
    assert.equal(writes, 1, change);
  }
});

test('guard forwards successful writes to the same head/lock receipt recorder without extra GitHub reads', () => {
  const receipts = [];
  const calls = [];
  const guard = createPrWriteGuard({ owner: 'o', repo: 'r', pr: 1, lockToken: 'token',
    expectedHead: 'a'.repeat(40), expectedAuthorityDigest: 'digest' }, {
    assertActiveReviewLock() {},
    gh(args) { calls.push(args); return { ok: true, stdout: args[1] === 'user' ? 'alice' : '{}' }; },
    ghJson: () => ({ state: 'OPEN', isDraft: false, headRefOid: 'a'.repeat(40), author: { login: 'bob' } }),
    fetchMaintainerAuthority: () => ({ digest: 'digest' }),
    evaluateMaintainerApprovalPolicy: () => ({ viewerIsMaintainer: true }),
    recordSelfWrite: (receipt) => receipts.push(receipt),
  });
  const args = ['api', '--method', 'POST', 'repos/o/r/issues/1/comments'];
  const response = guard(args);
  assert.equal(calls.length, 2);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].result, response);
  assert.deepEqual([receipts[0].repo, receipts[0].pr, receipts[0].head, receipts[0].scope],
    ['o/r', 1, 'a'.repeat(40), 'token']);
  assert.deepEqual(receipts[0].args, args);
});
