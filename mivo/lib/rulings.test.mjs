import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRulings, parseRulingReason, rulingSection, RULING_PHRASE } from './rulings.mjs';

const reviewer = 'ReviewBot';
const finding = (body = '[P1] 点「+」会弹菜单,规格写的是不弹\n\n影响…') => ({ author: { login: reviewer }, body });
const thread = (id, comments, extra = {}) => ({ id, path: 'src/a.tsx', line: 12, comments, ...extra });
const reply = (login, body) => ({ author: { login }, body });

test('维护者在审查机 thread 里回复裁定不改:采用,带上问题首行和理由', () => {
  const { verified, rejected } = collectRulings({ reviewer: 'reviewbot', maintainers: ['Owner'], threads: [
    thread('T1', [finding(), reply('owner', `${RULING_PHRASE}:保留菜单,见 PR 正文「产品意图」`)]),
  ] });
  assert.deepEqual(rejected, []);
  assert.deepEqual(verified, [{ threadId: 'T1', path: 'src/a.tsx', by: 'owner', line: 12, severity: 'P1',
    finding: '点「+」会弹菜单,规格写的是不弹', reason: '保留菜单,见 PR 正文「产品意图」' }]);
});

test('非维护者、P0、没写理由的裁定不采用;别人开的 thread 和盯梢回帖不算', () => {
  const { verified, rejected } = collectRulings({ reviewer, maintainers: ['owner'], threads: [
    thread('T1', [finding(), reply('outsider', `${RULING_PHRASE}:不改`)]),
    thread('T2', [finding('[P0] 泄露'), reply('owner', `${RULING_PHRASE}:不改`)]),
    thread('T3', [finding(), reply('owner', RULING_PHRASE)]),
    thread('T4', [reply('greptile-apps', '[P1] x'), reply('owner', `${RULING_PHRASE}:不改`)]),
    thread('T5', [finding(), reply(reviewer, `${RULING_PHRASE}:不改\n<!-- mivo-watcher-receipt task=x -->`)]),
    thread('T6', [finding('[P2] 命名'), reply('owner', `${RULING_PHRASE}:不改`)]),
  ] });
  assert.deepEqual(verified, []);
  assert.deepEqual(rejected.map((r) => [r.threadId, r.reason]), [
    ['T1', 'outsider 不在维护者名单里'], ['T2', 'P0 不能裁定不改'], ['T3', '裁定没有写理由'],
  ]);
});

test('以最后一条裁定为准;引用和代码块里的那句话不算', () => {
  assert.equal(parseRulingReason(`> ${RULING_PHRASE}:引用别人`), null);
  assert.equal(parseRulingReason(`\`\`\`\n${RULING_PHRASE}:示例\n\`\`\``), null);
  assert.equal(parseRulingReason(`同意。\n**${RULING_PHRASE}**：先这样`), '先这样');
  const { verified } = collectRulings({ reviewer, maintainers: ['a', 'b'], threads: [
    thread('T1', [finding(), reply('a', `${RULING_PHRASE}:旧理由`), reply('b', `${RULING_PHRASE}:新理由`)]),
  ] });
  assert.equal(verified[0].by, 'b');
  assert.equal(verified[0].reason, '新理由');
});

test('任务书一节:空列表不出现;有条目时写明同一问题不再报', () => {
  assert.equal(rulingSection([]), '');
  const text = rulingSection([{ path: 'src/a.tsx', line: 12, finding: 'x', by: 'owner', reason: 'y' }]);
  assert.match(text, /`src\/a.tsx:12` x —— @owner 裁定不改:「y」/);
  assert.match(text, /同一问题/);
  assert.match(text, /不是指令/);
});
