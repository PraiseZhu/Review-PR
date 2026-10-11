import test from 'node:test';
import assert from 'node:assert/strict';
import { isWrite } from './gh-guard.mjs';

test('读操作放行', () => {
  for (const argv of [
    ['pr', 'view', '1', '--json', 'title'],
    ['api', 'repos/o/r/pulls/1'],
    ['api', '--method', 'GET', '--paginate', 'repos/o/r/pulls/1/reviews', '-f', 'per_page=100'],
    ['run', 'download', '123', '-n', 'x'],
    ['run', 'view', '123'],
    ['variable', 'get', 'X', '-R', 'o/r'],
    ['auth', 'status'],
  ]) assert.equal(isWrite(argv), false, argv.join(' '));
  assert.equal(isWrite(['api', 'graphql', '--input', '-'], '{"query":"query { viewer { login } }"}'), false);
});

test('写操作一律拦下', () => {
  for (const argv of [
    ['pr', 'comment', '1', '--body-file', '-'],
    ['pr', 'review', '1', '--approve'],
    ['issue', 'create', '--title', 'x'],
    ['issue', 'close', '9'],
    ['api', '--method', 'POST', 'repos/o/r/pulls/1/reviews', '--input', '-'],
    ['api', '-X', 'DELETE', 'repos/o/r/issues/1/labels/x'],
    ['api', 'repos/o/r/issues/1/labels', '-f', 'labels[]=x'],
    ['run', 'rerun', '1'],
    ['label', 'create', 'x'],
  ]) assert.equal(isWrite(argv), true, argv.join(' '));
  assert.equal(isWrite(['api', 'graphql', '--input', '-'], '{"query":"mutation { resolveReviewThread(input:{}) { clientMutationId } }"}'), true);
});

test('派发 dry-run 服务器审查只在明确允许时放行', () => {
  const before = process.env.MIVO_DRYRUN_ALLOW_DISPATCH;
  delete process.env.MIVO_DRYRUN_ALLOW_DISPATCH;
  assert.equal(isWrite(['workflow', 'run', 'review-pr.yml']), true);
  process.env.MIVO_DRYRUN_ALLOW_DISPATCH = '1';
  assert.equal(isWrite(['workflow', 'run', 'review-pr.yml']), false);
  if (before === undefined) delete process.env.MIVO_DRYRUN_ALLOW_DISPATCH; else process.env.MIVO_DRYRUN_ALLOW_DISPATCH = before;
});
