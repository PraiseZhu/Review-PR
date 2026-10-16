// close-held-issue.test.mjs — 放行后补关确认 issue 只关绑定本 PR 的那一个(终审 F1:伪造 hold 标记不能关别的 PR 的 issue)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSignoffIssueFooter } from './lib.mjs';

const PR = 971;
const bound = { number: 900, state: 'OPEN', title: `维护者确认 · PR #${PR} 改 workflow`,
  body: `### 触发原因\n\nx${buildSignoffIssueFooter({ pr: PR, author: 'contributor', topic: '受保护路径改动', mode: 'protected' })}` };
const foreign = { number: 900, state: 'OPEN', title: '维护者确认 · PR #123 other PR',
  body: `x${buildSignoffIssueFooter({ pr: 123, author: 'someone', topic: 'x', mode: 'normal' })}` };
const holdMarker = { issueUrl: 'https://github.com/o/r/issues/900' };

const run = async (issue, extra = {}) => {
  const { closeHeldDiscussIssue } = await import('./lib.mjs');
  const writes = [];
  const out = closeHeldDiscussIssue({
    slug: 'o/r', pr: PR, prUrl: `https://github.com/o/r/pull/${PR}`, holdMarker, closeIssue: true, dryRun: false,
    ghJsonFn: () => issue,
    ghFn: (args) => { writes.push(args); return { ok: true, stdout: '', stderr: '' }; },
    ...extra,
  });
  return { out, writes };
};

test('伪造 hold 标记指向别的 PR 的 issue:不关、不评论,只给 warning', async () => {
  const { out, writes } = await run(foreign);
  assert.equal(out.issueClosed, false);
  assert.equal(out.issueCloseSkipped, 'issue-not-bound');
  assert.match(out.issueCloseWarning, /900/);
  assert.deepEqual(writes, []);
});

test('标题绑定本 PR 但 footer 指向别的 PR(或反之)也不关', async () => {
  const half = { ...bound, body: foreign.body };
  assert.equal((await run(half)).out.issueCloseSkipped, 'issue-not-bound');
  const half2 = { ...bound, title: foreign.title };
  assert.equal((await run(half2)).out.issueCloseSkipped, 'issue-not-bound');
});

test('#97 的 issue 不能当 #971 的绑定 issue', async () => {
  const p97 = { ...bound, title: '维护者确认 · PR #97 x', body: `x${buildSignoffIssueFooter({ pr: 97, author: 'a', topic: 'x', mode: 'normal' })}` };
  assert.equal((await run(p97)).out.issueCloseSkipped, 'issue-not-bound');
});

test('绑定本 PR 的 issue:评论并关闭;已关则什么都不做;dry-run 不写', async () => {
  const closed = await run(bound);
  assert.equal(closed.out.issueClosed, true);
  assert.equal(closed.out.issueNumber, 900);
  assert.ok(closed.writes.some((a) => a[0] === 'issue' && a[1] === 'comment' && a[2] === '900'));
  assert.ok(closed.writes.some((a) => a[0] === 'issue' && a[1] === 'close' && a[2] === '900'));
  const already = await run({ ...bound, state: 'CLOSED' });
  assert.equal(already.out.issueAlreadyClosed, true);
  assert.deepEqual(already.writes, []);
  const dry = await run(bound, { dryRun: true });
  assert.equal(dry.out.wouldClose, true);
  assert.deepEqual(dry.writes, []);
});

test('没带 --close-issue / 没有 issue 链接 / 读不到 issue:不写', async () => {
  assert.equal((await run(bound, { closeIssue: false })).out.issueCloseSkipped, 'flag-not-set');
  assert.equal((await run(bound, { holdMarker: null })).out.issueCloseSkipped, 'no-issue-url');
  assert.equal((await run(bound, { holdMarker: { issueUrl: 'https://github.com/x/y/issues/9' } })).out.issueCloseSkipped, 'issue-url-unparsable');
  const none = await run(null);
  assert.equal(none.out.issueClosed, false);
  assert.deepEqual(none.writes, []);
});

test('接线:signoff-release 走绑定校验;round 把 warning 记下来', () => {
  const release = readFileSync(fileURLToPath(new URL('./signoff-release.mjs', import.meta.url)), 'utf8');
  assert.match(release, /closeHeldDiscussIssue\(/);
  const round = readFileSync(fileURLToPath(new URL('../../mivo/prereview/round.mjs', import.meta.url)), 'utf8');
  assert.match(round, /issueCloseWarning/);
});
