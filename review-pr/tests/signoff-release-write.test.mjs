#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSignoffReleaseWrite, applySignoffReleaseWrite } from '../scripts/signoff-release.mjs';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'signoff-release.mjs'),
  'utf8',
);

test('signoff-release.mjs 本体被测试加载', () => {
  assert.match(SRC, /planSignoffReleaseWrite/);
  assert.match(SRC, /applySignoffReleaseWrite/);
});

function fakeGh(handlers) {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args);
    for (const h of handlers) {
      if (h.match(args)) return h.result;
    }
    return { ok: true, stdout: '', stderr: '', status: 0 };
  };
  ghFn.calls = calls;
  return ghFn;
}

test('同意后摘标签+关 issue', () => {
  const plan = planSignoffReleaseWrite({
    number: 170,
    signoff: {
      released: true,
      label: 'awaiting-discussion',
      closeOnRelease: { shouldClose: true, reason: 'close', issueNumber: 176 },
    },
  });
  const ghFn = fakeGh([]);
  const r = applySignoffReleaseWrite(plan, {
    slug: 'xindong/mivo-canvas-plugin',
    pr: 170,
    currentLabels: ['awaiting-discussion'],
    ghFn,
  });
  assert.equal(r.released, true);
  assert.equal(r.close.closed, true);
  assert.ok(ghFn.calls.some((a) => a[0] === 'issue' && a[1] === 'close'));
});

test('already-closed 幂等：不关 issue', () => {
  const plan = planSignoffReleaseWrite({
    signoff: {
      released: true,
      closeOnRelease: { shouldClose: false, reason: 'already-closed', issueNumber: 176 },
    },
  });
  const ghFn = fakeGh([]);
  const r = applySignoffReleaseWrite(plan, {
    slug: 'xindong/mivo-canvas-plugin',
    pr: 170,
    currentLabels: [],
    ghFn,
  });
  assert.equal(r.close.closed, false);
  assert.equal(r.close.reason, 'already-closed');
  assert.ok(!ghFn.calls.some((a) => a[0] === 'issue' && a[1] === 'close'));
});

test('marker-author-rejected 不关 issue', () => {
  const plan = planSignoffReleaseWrite({
    signoff: {
      released: true,
      closeOnRelease: { shouldClose: false, reason: 'marker-author-rejected', issueNumber: 176 },
    },
  });
  const ghFn = fakeGh([]);
  applySignoffReleaseWrite(plan, {
    slug: 'xindong/mivo-canvas-plugin',
    pr: 170,
    currentLabels: ['awaiting-discussion'],
    ghFn,
  });
  assert.ok(!ghFn.calls.some((a) => a[0] === 'issue' && a[1] === 'close'));
});
