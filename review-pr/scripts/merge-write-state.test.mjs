import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMergeRejection } from './merge-write-state.mjs';

test('a concrete mergePullRequest rejection is distinguished from an uncertain or unrelated failure', () => {
  const message = 'Required status check "ci" has failed.';
  const concrete = { ok: false, stdout: '', stderr: `GraphQL: ${message} (mergePullRequest)` };
  assert.equal(classifyMergeRejection(concrete).code, 'merge-checks-rejected');
  assert.equal(classifyMergeRejection({ ok: false, stdout: JSON.stringify({ data: { mergePullRequest: null },
    errors: [{ path: ['mergePullRequest'], message }] }) }).status, 'rejected');
  for (const response of [
    { ...concrete, ok: true },
    { ok: false, stderr: 'HTTP 403 Resource not accessible' },
    { ok: false, stderr: 'GraphQL: Unknown server failure (mergePullRequest)' },
    { ok: false, stderr: `GraphQL: ${message} (deleteRef)` },
    { ok: false, stderr: 'request timed out' },
    { ...concrete, stdout: 'ECONNRESET' },
    { ok: false, stdout: JSON.stringify({ data: { mergePullRequest: { pullRequest: { merged: true } } },
      errors: [{ path: ['mergePullRequest'], message }] }) },
  ]) assert.equal(classifyMergeRejection(response), null);
});
