import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGhWithPrViewCompat } from '../scripts/lib.gh-pr-view-compat.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ok = (value) => ({ ok: true, stdout: JSON.stringify(value), stderr: '', status: 0 });
const unsupported = (field = 'headRefOid') => ({ ok: false, stdout: '', stderr: `Unknown JSON field: "${field}"\nAvailable fields:\n  number\n`, status: 1 });
const argsFor = (fields) => ['pr', 'view', '42', '--repo', 'owner/repo', '--json', fields];
const issue = (number) => ({ number, title: `issue ${number}`, body: `body ${number}`, url: `https://github.com/owner/repo/issues/${number}`, repository: { nameWithOwner: 'owner/repo' } });
function pull(overrides = {}) {
  return { number: 42, headRefOid: HEAD, baseRefOid: BASE, body: 'PR evidence', updatedAt: '2026-09-17T03:00:00Z', ...overrides };
}
const graph = (overrides = {}, extra = {}) => ok({ data: { repository: { nameWithOwner: 'owner/repo', pullRequest: pull(overrides) } }, ...extra });
const connection = (nodes = [], more = false, cursor = null, total = nodes.length) => ({ nodes, totalCount: total, pageInfo: { hasNextPage: more, endCursor: cursor } });
function scripted(responses) {
  const calls = [];
  const runRaw = (args, opts) => {
    calls.push({ args, opts });
    assert.ok(responses.length, `unexpected request ${args.join(' ')}`);
    const next = responses.shift();
    return typeof next === 'function' ? next(args, opts) : next;
  };
  return { calls, runRaw };
}

test('modern CLI succeeds unchanged, including jq projection, with no extra request', () => {
  const result = { ok: true, stdout: `${HEAD}\n`, stderr: '', status: 0 };
  const mock = scripted([result]);
  const args = [...argsFor('headRefOid'), '--jq', '.headRefOid'];
  assert.equal(runGhWithPrViewCompat(args, { timeoutMs: 1200 }, mock), result);
  assert.deepEqual(mock.calls[0], { args, opts: { timeoutMs: 1200, allowFail: true } });
  assert.equal(mock.calls.length, 1);
});

test('non PR reads and write commands retain their original runner contract', () => {
  for (const args of [['api', 'user'], ['pr', 'edit', '42', '--body', 'x'], argsFor('title')]) {
    const result = ok({ any: true });
    const mock = scripted([result]);
    const opts = { allowFail: true, timeoutMs: 321, input: 'input' };
    assert.equal(runGhWithPrViewCompat(args, opts, mock), result);
    assert.equal(mock.calls[0].opts, opts);
  }
});

for (const failure of [
  { ok: false, stdout: '', stderr: 'HTTP 401: Bad credentials', status: 4 },
  { ok: false, stdout: '', stderr: 'network connection refused', status: 1 },
  { ok: false, stdout: '', stderr: 'spawn gh ENOENT', status: -1 },
  unsupported('unknownOtherField'),
  { ...unsupported(), stderr: 'not really an Unknown JSON field: "headRefOid"' },
]) {
  test(`unrelated error does not fall back: ${failure.stderr}`, () => {
    const mock = scripted([failure]);
    assert.throws(() => runGhWithPrViewCompat(argsFor('headRefOid'), {}, mock), /gh pr view/);
    assert.equal(mock.calls.length, 1);
    const tolerant = scripted([failure]);
    assert.equal(runGhWithPrViewCompat(argsFor('headRefOid'), { allowFail: true }, tolerant), failure);
  });
}

test('malformed modern output stays malformed rather than triggering a fallback', () => {
  const result = { ok: true, stdout: '{invalid', stderr: '', status: 0 };
  const mock = scripted([result]);
  assert.equal(runGhWithPrViewCompat(argsFor('headRefOid'), {}, mock), result);
  assert.equal(mock.calls.length, 1);
});

test('old CLI obtains both object identities from authoritative GraphQL fields', () => {
  const mock = scripted([unsupported('baseRefOid'), graph()]);
  const result = runGhWithPrViewCompat(argsFor('headRefOid,baseRefOid'), { timeoutMs: 800 }, mock);
  assert.deepEqual(JSON.parse(result.stdout), { headRefOid: HEAD, baseRefOid: BASE });
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[1].opts.timeoutMs, 800);
  assert.match(mock.calls[1].opts.input, /number headRefOid baseRefOid body updatedAt/);
  assert.deepEqual(mock.calls[1].args.slice(0, 4), ['api', 'graphql', '-F', 'query=@-']);
});

test('closing references and body come from the same GraphQL response', () => {
  const mock = scripted([unsupported('closingIssuesReferences'), graph({ closingIssuesReferences: connection([issue(7)]) })]);
  const result = runGhWithPrViewCompat(argsFor('body,closingIssuesReferences'), {}, mock);
  assert.deepEqual(JSON.parse(result.stdout), { body: 'PR evidence', closingIssuesReferences: [issue(7)] });
  assert.equal(mock.calls.length, 2);
  assert.match(mock.calls[1].opts.input, /closingIssuesReferences\(first:100,after:\$cursor\)/);
});

test('remaining native fields are bracketed with PR identity verification', () => {
  const mock = scripted([unsupported(), graph(), ok({ number: 42, url: 'https://github.com/owner/repo/pull/42', title: 'title' }), graph()]);
  const result = runGhWithPrViewCompat(argsFor('title,body,headRefOid'), {}, mock);
  assert.deepEqual(JSON.parse(result.stdout), { title: 'title', body: 'PR evidence', headRefOid: HEAD });
  assert.equal(mock.calls[2].args.at(-1), 'title,number,url');
  assert.equal(mock.calls.length, 4);
});

test('repo flag aliases retain identity and unsupported output transforms fail explicitly', () => {
  for (const repoArgs of [['-R', 'owner/repo'], ['--repo=owner/repo']]) {
    const mock = scripted([unsupported(), graph()]);
    assert.equal(JSON.parse(runGhWithPrViewCompat(['pr', 'view', '42', ...repoArgs, '--json=headRefOid'], {}, mock).stdout).headRefOid, HEAD);
  }
  for (const extra of [['--jq', '.headRefOid'], ['--template', '{{.headRefOid}}']]) {
    const mock = scripted([unsupported()]);
    assert.throws(() => runGhWithPrViewCompat([...argsFor('headRefOid'), ...extra], {}, mock), /cannot safely preserve option/);
    assert.equal(mock.calls.length, 1);
  }
});

for (const response of [
  graph({ number: 43 }),
  ok({ data: { repository: { nameWithOwner: 'other/repo', pullRequest: pull() } } }),
  graph({ headRefOid: null }),
  graph({ baseRefOid: '' }),
  graph({ body: null }),
  graph({ updatedAt: null }),
  graph({}, { errors: [{ message: 'FORBIDDEN' }] }),
  { ok: true, stdout: '{broken', stderr: '', status: 0 },
]) {
  test(`invalid GraphQL response fails closed: ${response.stdout.slice(0, 70)}`, () => {
    const mock = scripted([unsupported(), response]);
    assert.throws(() => runGhWithPrViewCompat(argsFor('headRefOid'), {}, mock), /identity|invalid|errors|malformed/);
  });
}

test('fallback command failures preserve result for allowFail and remain errors otherwise', () => {
  const denied = { ok: false, stdout: 'denied', stderr: 'HTTP 403', status: 4 };
  const mock = scripted([unsupported(), denied]);
  assert.equal(runGhWithPrViewCompat(argsFor('headRefOid'), { allowFail: true }, mock), denied);
  const strict = scripted([unsupported(), denied]);
  assert.throws(() => runGhWithPrViewCompat(argsFor('headRefOid'), {}, strict), /HTTP 403/);
  const malformed = scripted([unsupported(), graph({ number: 7 })]);
  assert.equal(runGhWithPrViewCompat(argsFor('headRefOid'), { allowFail: true }, malformed).ok, false);
});

test('native remainder cannot hide another unsupported field, malformed JSON, or wrong PR', () => {
  const responses = [unsupported('unknownOtherField'), { ok: true, stdout: '{broken', stderr: '', status: 0 }, ok({ number: 43, url: 'https://github.com/owner/repo/pull/43', title: 'x' }), ok({ number: 42, url: 'https://github.com/owner/repo/pull/42' })];
  for (const response of responses) {
    const mock = scripted([unsupported(), graph(), response]);
    assert.throws(() => runGhWithPrViewCompat(argsFor('title,headRefOid'), {}, mock), /Unknown|malformed|identity|missing/);
    assert.equal(mock.calls.length, 3);
  }
});

test('paginated references are complete, cursor-bound, and checked after collection', () => {
  const mock = scripted([unsupported('closingIssuesReferences'), graph({ closingIssuesReferences: connection([issue(7)], true, 'page2', 2) }), graph({ closingIssuesReferences: connection([issue(8)], false, null, 2) }), graph()]);
  const result = runGhWithPrViewCompat(argsFor('body,closingIssuesReferences'), {}, mock);
  assert.deepEqual(JSON.parse(result.stdout).closingIssuesReferences, [issue(7), issue(8)]);
  assert.ok(mock.calls[2].args.includes('cursor=page2'));
});

test('pagination rejects missing metadata, truncation, duplicate issues and stalled cursors', () => {
  for (const value of [{ nodes: [] }, { ...connection(), pageInfo: {} }, connection([], false, null, 1), connection([issue(1)], true, '', 2), connection([], true, 'next', 2), connection([{ number: 1 }])]) {
    const mock = scripted([unsupported('closingIssuesReferences'), graph({ closingIssuesReferences: value })]);
    assert.throws(() => runGhWithPrViewCompat(argsFor('closingIssuesReferences'), {}, mock), /incomplete|truncated|cursor/);
  }
  const duplicate = scripted([unsupported('closingIssuesReferences'), graph({ closingIssuesReferences: connection([issue(7)], true, 'same', 3) }), graph({ closingIssuesReferences: connection([issue(7)], true, 'same', 3) })]);
  assert.throws(() => runGhWithPrViewCompat(argsFor('closingIssuesReferences'), {}, duplicate), /duplicate/);
  const stalled = scripted([unsupported('closingIssuesReferences'), graph({ closingIssuesReferences: connection([issue(7)], true, 'same', 3) }), graph({ closingIssuesReferences: connection([issue(8)], true, 'same', 3) })]);
  assert.throws(() => runGhWithPrViewCompat(argsFor('closingIssuesReferences'), {}, stalled), /cursor/);
});

test('PR/body drift across pages and after native remainder is rejected', () => {
  for (const drift of [{ headRefOid: 'c'.repeat(40) }, { baseRefOid: 'c'.repeat(40) }, { body: 'different evidence' }, { updatedAt: '2026-09-17T04:00:00Z' }]) {
    const pages = scripted([unsupported('closingIssuesReferences'), graph({ closingIssuesReferences: connection([issue(7)], true, 'next', 2) }), graph({ ...drift, closingIssuesReferences: connection([issue(8)], false, null, 2) })]);
    assert.throws(() => runGhWithPrViewCompat(argsFor('body,closingIssuesReferences'), {}, pages), /PR changed/);
    const native = scripted([unsupported(), graph(), ok({ number: 42, url: 'https://github.com/owner/repo/pull/42', title: 'x' }), graph(drift)]);
    assert.throws(() => runGhWithPrViewCompat(argsFor('title,headRefOid'), {}, native), /PR changed/);
  }
});

test('pagination bound fails instead of returning a partial issue list', () => {
  const responses = [unsupported('closingIssuesReferences'), ...Array.from({ length: 50 }, (_, i) => graph({ closingIssuesReferences: connection([issue(i + 1)], true, `cursor-${i}`, 51) }))];
  const mock = scripted(responses);
  assert.throws(() => runGhWithPrViewCompat(argsFor('closingIssuesReferences'), {}, mock), /pagination limit/);
});
