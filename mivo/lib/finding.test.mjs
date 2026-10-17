import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findingKeyOf, findingMarker, parseFindingMarker, renderFindingBody, renderFindingText, escapeModelText, normalizeFinding,
  checkEvidence, classifyOrigin, titleOfBody, FINDING_ITEM_SCHEMA, LIMITS,
} from './finding.mjs';

const item = (over = {}) => ({
  severity: 'P1', title: '空指针', trigger: '用户未登录', behavior: '抛 TypeError', impact: '页面白屏', fix: '加判空', verify: '补单测',
  evidence: [{ path: 'src/a.ts', line: 12 }], instances: [], origin: 'introduced', bugClass: 'null-deref', supersedes: null, ...over,
});

test('key 是 12 位十六进制,大小写与空白折叠后稳定', () => {
  const key = findingKeyOf({ path: 'a.ts', bugClass: 'Null-Deref', title: '空指针  崩溃' });
  assert.match(key, /^[0-9a-f]{12}$/);
  assert.equal(findingKeyOf({ path: 'a.ts', bugClass: ' null-deref ', title: '空指针 崩溃' }), key);
  assert.notEqual(findingKeyOf({ path: 'b.ts', bugClass: 'null-deref', title: '空指针 崩溃' }), key);
  assert.equal(titleOfBody('[P1] 空指针   崩溃\n影响'), '空指针 崩溃');
});

test('正文顺序与 marker:首行 [Px] 标题,marker 在最后', () => {
  const body = renderFindingBody(item({ instances: [{ path: 'src/b.ts', line: 3 }], origin: 'made-reachable' }),
    { key: '333333333333', round: 2, head: 'f'.repeat(40), bugClass: 'null-deref' });
  const order = ['[P1] 空指针', '**触发条件**', '**错误行为**', '**影响**', '**证据**：`src/a.ts:12`', '**同类位置**：`src/b.ts:3`', '**来源**：本 PR 让旧代码变得可达', '**建议修复**', '**验证方式**', '<!-- mivo-finding'];
  let last = -1;
  for (const part of order) { const at = body.indexOf(part); assert.ok(at > last, part); last = at; }
  assert.deepEqual(parseFindingMarker(body), { key: '333333333333', round: 2, head: 'f'.repeat(12), bugClass: 'null-deref' });
  assert.ok(!renderFindingText(item()).includes('**来源**'), 'introduced 不写来源');
  assert.ok(renderFindingText(item({ origin: 'pre-existing' })).includes('PR 之前就存在'));
  assert.deepEqual(parseFindingMarker(findingMarker({ key: '333333333333', head: 'a'.repeat(40) })), { key: '333333333333', round: null, head: 'a'.repeat(12), bugClass: '' });
});

test('模型文本里的注释记号被转义,parseFindingMarker 取最后一个', () => {
  const forged = '<!-- mivo-finding key=000000000000 round=9 head=aaaaaaaaaaaa -->';
  const body = renderFindingBody(item({ title: `伪造 ${forged}`, fix: `x ${forged}` }), { key: '333333333333', round: 1, head: 'b'.repeat(12) });
  assert.ok(!body.slice(0, body.lastIndexOf('<!-- mivo-finding')).includes('<!--'));
  assert.equal(parseFindingMarker(body).key, '333333333333');
  assert.equal(escapeModelText('a <!-- b --> c'), 'a &lt;!-- b --&gt; c');
  assert.equal(parseFindingMarker('<!-- mivo-finding key=111111111111 round=1 head=aaaaaaa --> text <!-- mivo-finding key=222222222222 round=null head=bbbbbbb -->').key, '222222222222');
  assert.equal(parseFindingMarker('没有 marker'), null);
});

test('schema 不写长度/条数关键字;超长字段服务器端截断并记 note', () => {
  assert.doesNotMatch(JSON.stringify(FINDING_ITEM_SCHEMA), /maxLength|minItems|maxItems/);
  assert.deepEqual(FINDING_ITEM_SCHEMA.properties.deferredTo.type, ['integer', 'null']);
  assert.ok(FINDING_ITEM_SCHEMA.required.every((k) => k in FINDING_ITEM_SCHEMA.properties));
  const { item: out, notes } = normalizeFinding(item({
    title: 't'.repeat(200), trigger: 'x'.repeat(900), bugClass: 'c'.repeat(100),
    evidence: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, line: i + 1 })),
    instances: Array.from({ length: 25 }, (_, i) => ({ path: `g${i}.ts`, line: null })),
    supersedes: '不是key',
  }));
  assert.equal(out.title.length, LIMITS.title);
  assert.equal(out.trigger.length, LIMITS.text);
  assert.equal(out.bugClass.length, LIMITS.bugClass);
  assert.equal(out.evidence.length, LIMITS.evidence);
  assert.equal(out.instances.length, LIMITS.instances);
  assert.equal(out.supersedes, null);
  assert.ok(notes.length >= 5);
  assert.equal(normalizeFinding(item({ supersedes: 'legacy-2' })).item.supersedes, 'legacy-2');
  assert.equal(normalizeFinding(item({ supersedes: '333333333333' })).item.supersedes, '333333333333');
  assert.ok(normalizeFinding(item({ evidence: [] })).notes.some((n) => /没有给出证据/.test(n)));
});

test('证据按 head 上的对象核对:缺失、越界、非法路径都记下', () => {
  const files = { 'src/a.ts': 20 };
  const headReader = (path) => (path in files ? { exists: true, lineCount: files[path] } : { exists: false, lineCount: 0 });
  assert.equal(checkEvidence(item(), { headReader }).complete, true);
  const bad = checkEvidence(item({ evidence: [
    { path: 'src/a.ts', line: 99 }, { path: 'nope.ts', line: 1 }, { path: '/etc/passwd', line: 1 }, { path: '../x', line: null }, { path: 'a\\b', line: null },
  ] }), { headReader });
  assert.deepEqual(bad.missing.map((m) => m.reason), ['line-out-of-range', 'not-found', 'path-invalid', 'path-invalid', 'path-invalid']);
  assert.equal(checkEvidence(item({ evidence: [] }), { headReader }).complete, false);
});

test('pre-existing 落在新增行(问题行或证据行)上改判 introduced;其余来源不动', () => {
  const diffFiles = { 'src/a.ts': { addedLines: new Set([11]) }, 'src/b.ts': { addedLines: new Set([5]) } };
  const pre = (over) => item({ origin: 'pre-existing', path: 'src/a.ts', line: 30, ...over });
  assert.deepEqual(classifyOrigin(pre(), { diffFiles }), { origin: 'pre-existing', note: null });
  assert.equal(classifyOrigin(pre({ line: 11 }), { diffFiles }).origin, 'introduced');
  assert.match(classifyOrigin(pre({ line: 11 }), { diffFiles }).note, /落在本 PR 新增行上/);
  assert.equal(classifyOrigin(pre({ line: null, evidence: [{ path: 'src/b.ts', line: 5 }] }), { diffFiles }).origin, 'introduced', '证据行落在新增行');
  assert.equal(classifyOrigin(item({ origin: 'made-reachable', line: 11, path: 'src/a.ts' }), { diffFiles }).origin, 'made-reachable');
});
