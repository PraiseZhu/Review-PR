// 草稿 PR 上的 review:merge-ready 要摘(PraiseZhu/Review-PR#215,签名 stale-merge-ready-on-draft)。
// 2026-11-06 xindong/mivo-canvas-plugin#1927:标签挂上后转草稿,草稿不进送审名单,dropStaleMergeReady 永远轮不到它,标签挂了 1 小时 24 分。
// 做法同 stale-merge-ready.test.mjs:从 round.mjs 源码抽出具名函数放进 vm,gh / 日志用替身;判据函数用真的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { toDraftMergeReadyPrs } from '../lib/admission.mjs';

const source = readFileSync(new URL('./round.mjs', import.meta.url), 'utf8');
function extractFunction(name) {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(source);
  assert.ok(declaration, `round.mjs 里找不到函数 ${name}`);
  const closing = /^\}/m.exec(source.slice(declaration.index));
  assert.ok(closing, `${name} 没有顶格的结束括号`);
  return source.slice(declaration.index, declaration.index + closing.index + 1);
}

const LABEL = 'review:merge-ready';
const issue = (number, labels = [LABEL], pull = true) => ({ number, ...(pull ? { pull_request: {} } : {}), labels: labels.map((name) => ({ name })) });

function makeWorld({ mode = 'live', fenced = false, failures = {} } = {}) {
  const deletes = [];
  const logs = [];
  const sandbox = {
    toDraftMergeReadyPrs, MERGE_READY_LABEL: LABEL, encodeURIComponent, String,
    CONFIG: { targetRepo: 'o/r', repoRoot: '/repo', mode }, ENV: {}, FENCED: fenced,
    log: (event, detail) => logs.push({ event, ...detail }),
    run: (command, args) => {
      deletes.push(args.join(' '));
      const pr = /issues\/(\d+)\//.exec(args.at(-1))[1];
      if (failures[pr] === 'throw') throw new Error('spawn gh ENOENT');
      return failures[pr] ?? { ok: true, stdout: '', stderr: '' };
    },
  };
  vm.runInNewContext(`${extractFunction('dropDraftMergeReady')}\nglobalThis.api = { dropDraftMergeReady };`, sandbox);
  return { drop: (issues, draftPrs) => sandbox.api.dropDraftMergeReady(issues, draftPrs), deletes, logs };
}

test('SC1:草稿 PR 带标签:发一次 DELETE,日志写 merge-ready-dropped(reason draft);标签摘掉后下一轮的 issue 列表里没有它,不再 DELETE', () => {
  const world = makeWorld();
  world.drop([issue(1927)], [1927]);
  assert.equal(world.deletes.length, 1);
  assert.match(world.deletes[0], /DELETE repos\/o\/r\/issues\/1927\/labels\/review%3Amerge-ready$/);
  assert.deepEqual(world.logs, [{ event: 'merge-ready-dropped', pr: 1927, reason: 'draft' }]);
  world.drop([issue(1927, [])], [1927]);
  assert.equal(world.deletes.length, 1, '标签已摘,第二轮不重复 DELETE');
});

test('SC2:草稿没有标签 / 非草稿带标签 / 带标签的不是 PR:不发任何调用', () => {
  const world = makeWorld();
  world.drop([issue(1, ['status:ci-failed']), issue(2), issue(3, [LABEL], false)], [1, 3]);
  assert.deepEqual(world.deletes, []);
  assert.deepEqual(world.logs, []);
});

test('SC2:读不到输入(issue 列表读失败 / admit 没给 draftPrs)按不摘处理', () => {
  const world = makeWorld();
  world.drop(undefined, [1]);
  world.drop([issue(1)], undefined);
  assert.deepEqual(world.deletes, []);
});

test('SC3:一个 PR 摘标签失败(非 404)只记 merge-ready-drop-failed,其它草稿照摘;404 当已摘,不记失败', () => {
  const world = makeWorld({ failures: { 11: { ok: false, stdout: '', stderr: 'HTTP 502: Bad Gateway' }, 12: { ok: false, stdout: '', stderr: 'HTTP 404: Not Found' } } });
  world.drop([issue(11), issue(12), issue(13)], [11, 12, 13]);
  assert.equal(world.deletes.length, 3);
  assert.deepEqual(world.logs.map((l) => [l.event, l.pr]), [['merge-ready-drop-failed', 11], ['merge-ready-dropped', 13]]);
  assert.match(world.logs[0].error, /502/);
});

test('SC3:run 抛异常也不外溢(不影响接单),留一笔日志', () => {
  const world = makeWorld({ failures: { 5: 'throw' } });
  world.drop([issue(5)], [5]);
  assert.equal(world.logs.at(-1).event, 'merge-ready-drop-failed');
  assert.match(world.logs.at(-1).error, /ENOENT/);
});

test('只在 live 模式、且未被锁围栏时动手', () => {
  for (const options of [{ mode: 'dry-run' }, { fenced: true }]) {
    const world = makeWorld(options);
    world.drop([issue(1927)], [1927]);
    assert.deepEqual(world.deletes, [], JSON.stringify(options));
  }
});

test('toDraftMergeReadyPrs:只返回挂着标签的草稿 PR,升序;labels 兼容字符串写法', () => {
  assert.deepEqual(toDraftMergeReadyPrs({ issues: [issue(9), issue(4), issue(6)], draftPrs: [4, 9, 100], label: LABEL }), [4, 9]);
  assert.deepEqual(toDraftMergeReadyPrs({ issues: [{ number: 2, pull_request: {}, labels: [LABEL] }], draftPrs: ['2'], label: LABEL }), [2]);
  assert.deepEqual(toDraftMergeReadyPrs({ issues: [issue(9)], draftPrs: [9], label: '' }), []);
});

test('接线:admitRound 在 admit-candidates 返回后(含 admit-none 的退出码 2)用 wakeHeldPrs 读到的 issue 列表和 draftPrs 摘标签', async () => {
  // #1927 的现场:草稿、带标签、候选名单为空(退出码 2)
  const calls = [];
  const sandbox = {
    wakeHeldPrs: () => [issue(1927)], busyPrs: () => new Set(),
    admitScript: (args) => (args[0] === '--authority-only' ? { ok: true, digest: 'd1' } : { ok: true, exitCode: 2, excludedPrs: [], draftPrs: [1927] }),
    dropDraftMergeReady: (issues, draftPrs) => calls.push([issues.map((i) => i.number), draftPrs]),
    log: (event) => calls.push(event), closeAdmission() {},
  };
  vm.runInNewContext(`${extractFunction('admitRound')}\nglobalThis.api = { admitRound };`, sandbox);
  await sandbox.api.admitRound('token', 'd1', [], 5);
  assert.deepEqual(calls, [[[1927], [1927]], 'admit-none']);
});

test('空闲路径(Review-PR#215 审查 P2):pre-check 没有候选时也摘——main 在 no-candidates 返回前,用启动时读到的 issue 列表和候选名单里 outcome=draft 的编号调 dropDraftMergeReady', () => {
  const body = extractFunction('main');
  const at = (text) => { const i = body.indexOf(text); assert.ok(i >= 0, `main 里找不到 ${text}`); return i; };
  assert.ok(at("const openIssues = busyAtStart ? wakeHeldPrs(busyAtStart) : undefined;") < at("runScript('pre-check.mjs'"));
  assert.ok(at("runScript('pre-check.mjs'") < at('dropDraftMergeReady(openIssues, readDraftPrs(pre.candidateList))'));
  assert.ok(at('dropDraftMergeReady(openIssues, readDraftPrs(pre.candidateList))') < at("log('no-candidates'"), '必须在 no-candidates 早退之前');
});

test('readDraftPrs:只取候选名单 skipped 里 outcome=draft 的编号;名单缺失 / 形状不对返回 undefined(不摘)', () => {
  const files = new Map([['/s/list.json', { candidates: [], skipped: [{ number: 1927, outcome: 'draft' }, { number: 7, outcome: 'base-not-gated' }, { number: 1858, outcome: 'draft' }] }], ['/s/bad.json', { skipped: 'x' }]]);
  const sandbox = { readJson: (file, fallback) => (files.has(file) ? structuredClone(files.get(file)) : fallback) };
  vm.runInNewContext(`${extractFunction('readDraftPrs')}\nglobalThis.api = { readDraftPrs };`, sandbox);
  assert.deepEqual(sandbox.api.readDraftPrs('/s/list.json'), [1927, 1858]);
  for (const input of [undefined, '/s/missing.json', '/s/bad.json']) assert.equal(sandbox.api.readDraftPrs(input), undefined, String(input));
});

test('端到端形状:pre-check 候选名单(createCandidateList 真实产物)里的草稿 → readDraftPrs → toDraftMergeReadyPrs 只挑出带标签的草稿', async () => {
  const { createCandidateList } = await import('../../review-pr/scripts/review-round.mjs');
  const row = (number, isDraft) => ({ number, title: `t${number}`, url: '', createdAt: '2026-11-06T00:00:00Z', author: 'a', baseRefName: 'main', headRefName: `b${number}`, headRepository: 'o/r',
    base: 'a'.repeat(40), head: number.toString(16).padStart(40, '0'), updatedAt: '2026-11-06T00:00:00Z', isDraft, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, unresolved: 0, ci: 'SUCCESS' });
  const manifest = createCandidateList({ repo: 'o/r', snapshot: [row(1927, true), row(1920, false), row(1858, true)], mode: 'review-only', now: Date.parse('2026-11-06T18:00:00Z') });
  const sandbox = { readJson: () => structuredClone(manifest) };
  vm.runInNewContext(`${extractFunction('readDraftPrs')}\nglobalThis.api = { readDraftPrs };`, sandbox);
  const drafts = sandbox.api.readDraftPrs('/s/list.json');
  assert.deepEqual(drafts.sort(), [1858, 1927]);
  assert.deepEqual(toDraftMergeReadyPrs({ issues: [issue(1927), issue(1920), issue(1858, [])], draftPrs: drafts, label: LABEL }), [1927]);
});
