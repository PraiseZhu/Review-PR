// run-log.test.mjs — run-log.mjs 落盘校验与容错(F5-F7, R6, R8①)的固化重放。
//
// 跑法:node --test review-pr/tests/run-log.test.mjs
// 每个 test 用一次性临时目录(经 REVIEW_PR_STATE_DIR 直接指向,绕开 git-ignore
// 校验的复杂度——那部分由 state-dir.test.mjs 覆盖),不依赖任何签入仓库的
// 敏感数据。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshTempDir, resolveStateDir, runRunLog } from './helpers.mjs';

/**
 * 每个 test 独立的 REPO_ROOT + 状态根,互不干扰。
 *
 * 注意:`REVIEW_PR_STATE_DIR`(这里的 `stateDirBase`)只是"状态根"(见
 * `lib.mjs` 的 `resolvePersistentStateRoot`),真正的 `STATE_DIR` 还会在其下
 * 拼一层 `repoStateKey`(按目标仓库路径哈希隔离的子目录)。这里先用
 * `resolveStateDir` 实际跑一遍拿到真实叶子目录 `stateDir`,fixture 要写进
 * `stateDir`(run-log.mjs 真正读写的位置);调用 `runRunLog` 时环境变量仍传
 * `stateDirBase`(与 run-log.mjs 自己解析时用的是同一个值,才能落到同一个
 * `stateDir`)。
 */
function freshStateDir() {
  const base = freshTempDir();
  const stateDirBase = join(base, 'state-root');
  mkdirSync(stateDirBase, { recursive: true });
  const { stateDir } = resolveStateDir(base, { REVIEW_PR_STATE_DIR: stateDirBase });
  return { base, stateDirBase, stateDir };
}

test('run-log: 合法输入(event=COMMENT)零告警,exit 0', () => {
  const { base, stateDirBase } = freshStateDir();
  const body = JSON.stringify({
    mode: 'auto',
    processed: [{ pr: 1, action: 'changes-requested', event: 'COMMENT' }],
    draftSkipped: [],
  });
  const { json, status } = runRunLog(base, body, { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 0);
  assert.deepEqual(json.warnings, []);
  rmSync(base, { recursive: true, force: true });
});

test('run-log: stdin 非法 JSON 仍然 exit 1(F5 不改变这条既有契约)', () => {
  const { base, stateDirBase } = freshStateDir();
  const { status, json } = runRunLog(base, 'not even json', { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 1);
  assert.equal(json.ok, false);
  rmSync(base, { recursive: true, force: true });
});

for (const [label, body] of [
  ['null', 'null'],
  ['array', '[1,2,3]'],
  ['string', '"hello"'],
  ['number', '42'],
]) {
  test(`run-log: F5 顶层是 ${label} 时只告警、照常落盘,不 throw 不 exit 1`, () => {
    const { base, stateDirBase } = freshStateDir();
    const { status, json, stderr } = runRunLog(base, body, { REVIEW_PR_STATE_DIR: stateDirBase });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.equal(json.ok, true);
    assert.ok(json.warnings.some((w) => w.includes('顶层应为对象')));
    rmSync(base, { recursive: true, force: true });
  });
}

test('run-log: F5 processed 不是数组 / 元素混入 null 与非对象,只告警不崩', () => {
  const { base, stateDirBase } = freshStateDir();
  // draftSkipped 显式给空数组,隔离掉 R6 的"整体缺失"告警,让这条 test 只关注 processed。
  const body = JSON.stringify({
    processed: [null, 5, 'x', { pr: 9, action: 'merged', event: 'APPROVE' }],
    draftSkipped: [],
  });
  const { status, json } = runRunLog(base, body, { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 0);
  // 三个非法条目(null/5/'x')各产生一条 event 缺失告警,合法的第四条不产生告警
  assert.equal(json.warnings.length, 3);
  rmSync(base, { recursive: true, force: true });
});

test('run-log: F5/R6 draftSkipped 整体缺失产生一条告警(字段口径要和 SKILL.md 6.1 对齐)', () => {
  const { base, stateDirBase } = freshStateDir();
  const { status, json } = runRunLog(base, JSON.stringify({ mode: 'auto' }), { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 0);
  assert.ok(json.warnings.some((w) => w.includes('draftSkipped 字段整体缺失')));
  rmSync(base, { recursive: true, force: true });
});

test('run-log: draftSkipped 显式写空数组时不告警(区别于整体缺失)', () => {
  const { base, stateDirBase } = freshStateDir();
  const { status, json } = runRunLog(base, JSON.stringify({ mode: 'auto', draftSkipped: [] }), { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 0);
  assert.ok(!json.warnings.some((w) => w.includes('draftSkipped')));
  rmSync(base, { recursive: true, force: true });
});

test('run-log: F5 draftSkipped 元素逐项校验 pr/reason/url,缺失各自告警', () => {
  const { base, stateDirBase } = freshStateDir();
  const body = JSON.stringify({
    draftSkipped: [
      { pr: 1, reason: 'x', url: 'https://y' }, // 完整,不告警
      { pr: 2, url: 'https://y' }, // 缺 reason
      { pr: 3 }, // 缺 reason + url
      {}, // 缺 pr + reason + url
    ],
  });
  const { status, json } = runRunLog(base, body, { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 0);
  assert.equal(json.warnings.length, 1 + 2 + 3);
  rmSync(base, { recursive: true, force: true });
});

test('run-log: F6 尾部损坏行被跳过,向前找到最近合法记录,reason=ok 且带 skip 提示', () => {
  const { base, stateDirBase, stateDir } = freshStateDir();
  const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
  writeFileSync(
    join(stateDir, 'runs.jsonl'),
    `${[
      JSON.stringify({ loggedAt: tenHoursAgo, mode: 'auto' }),
      'not even json',
      JSON.stringify({ loggedAt: 'not-a-date' }),
    ].join('\n')}\n`,
  );
  const { status, json } = runRunLog(base, JSON.stringify({ mode: 'auto', draftSkipped: [] }), { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 0);
  assert.equal(json.sinceLastRunReason, 'ok');
  assert.ok(
    json.sinceLastRunHours > 9.9 && json.sinceLastRunHours < 10.1,
    `期望约 10 小时,实际算出 ${json.sinceLastRunHours}`,
  );
  assert.ok(json.warnings.some((w) => w.includes('2 行解不出合法 loggedAt')));
  rmSync(base, { recursive: true, force: true });
});

test('run-log: F6 整份 runs.jsonl 全是坏行 → history-corrupted,区别于真首轮 first-run', () => {
  const { base, stateDirBase, stateDir } = freshStateDir();
  writeFileSync(join(stateDir, 'runs.jsonl'), 'garbage1\ngarbage2\n{"nope":"nope"}\n');
  const { status, json } = runRunLog(base, JSON.stringify({ mode: 'auto', draftSkipped: [] }), { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 0);
  assert.equal(json.sinceLastRunHours, null);
  assert.equal(json.sinceLastRunReason, 'history-corrupted');
  rmSync(base, { recursive: true, force: true });
});

test('run-log: 真首轮(runs.jsonl 不存在)→ first-run,不与 history-corrupted 混淆', () => {
  const { base, stateDirBase } = freshStateDir();
  const { status, json } = runRunLog(base, JSON.stringify({ mode: 'auto', draftSkipped: [] }), { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 0);
  assert.equal(json.sinceLastRunHours, null);
  assert.equal(json.sinceLastRunReason, 'first-run');
  rmSync(base, { recursive: true, force: true });
});

test('run-log: R8① loggedAt 为 null 的坏行不能被当成 epoch-0 的"合法"记录', () => {
  const { base, stateDirBase, stateDir } = freshStateDir();
  // new Date(null) 在 JS 里等价于 new Date(0)(epoch),旧版校验只检查
  // Number.isFinite(new Date(v).getTime()) 会把这一行误判为"合法的 1970 年
  // 记录",算出一个荒谬的超长间隔;正确行为是把它当坏行跳过,找更前面的合法行。
  const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
  writeFileSync(
    join(stateDir, 'runs.jsonl'),
    `${[
      JSON.stringify({ loggedAt: tenHoursAgo, mode: 'auto' }),
      JSON.stringify({ loggedAt: null, mode: 'auto' }),
    ].join('\n')}\n`,
  );
  const { status, json } = runRunLog(base, JSON.stringify({ mode: 'auto', draftSkipped: [] }), { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 0);
  assert.equal(json.sinceLastRunReason, 'ok');
  assert.ok(
    json.sinceLastRunHours > 9.9 && json.sinceLastRunHours < 10.1,
    `应该跳过 null 那行找到约 10 小时前的记录,实际算出 ${json.sinceLastRunHours}`,
  );
  assert.ok(json.warnings.some((w) => w.includes('1 行解不出合法 loggedAt')));
  rmSync(base, { recursive: true, force: true });
});

test('run-log: F7 调用方伪造 loggedAt/sinceLastRunHours/sinceLastRunReason 一律被真实值覆盖(落盘文件里也生效,不只是 stdout)', () => {
  const { base, stateDirBase, stateDir } = freshStateDir();
  const body = JSON.stringify({
    mode: 'auto',
    draftSkipped: [],
    loggedAt: '1999-01-01T00:00:00.000Z',
    sinceLastRunHours: 9999,
    sinceLastRunReason: 'ok',
  });
  const { status, json } = runRunLog(base, body, { REVIEW_PR_STATE_DIR: stateDirBase });
  assert.equal(status, 0);
  assert.notEqual(json.loggedAt, '1999-01-01T00:00:00.000Z');
  assert.equal(json.sinceLastRunHours, null); // 首轮真实值
  assert.equal(json.sinceLastRunReason, 'first-run');

  const persisted = JSON.parse(readFileSync(join(stateDir, 'last-run.json'), 'utf8'));
  assert.notEqual(persisted.loggedAt, '1999-01-01T00:00:00.000Z');
  assert.equal(persisted.sinceLastRunHours, null);
  assert.equal(persisted.sinceLastRunReason, 'first-run');

  rmSync(base, { recursive: true, force: true });
});
