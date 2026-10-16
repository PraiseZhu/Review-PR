import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./notify-author-resolve.mjs', import.meta.url)), 'utf8');
const start = src.indexOf('const protectedPathMode');
const protectedBlock = src.slice(start, src.indexOf('process.exit(0);', start));

test('受保护路径提醒改成新流程说法,不再让作者 @ 人工处理人', () => {
  assert.match(protectedBlock, /确认 issue/);
  assert.match(protectedBlock, /人工审核/);
  assert.match(protectedBlock, /同意放行/);
  assert.match(protectedBlock, /Approve/);
  assert.doesNotMatch(protectedBlock, /请在 PR 中 @\$\{contactLogin\}/);
  assert.doesNotMatch(protectedBlock, /受保护路径仍需人工处理/);
  assert.match(protectedBlock, /postComment/);
});
