import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMarkerHistory, toPreviousRound, roundIndexOf, applyConvergence, renderConvergenceSection } from './convergence.mjs';
import { findingKeyOf, findingMarker, parseFindingMarker } from './finding.mjs';
import { collectRulings } from './rulings.mjs';

const HEAD = 'a'.repeat(40);
const H = (n) => String(n).repeat(12);
const v2 = (over = {}) => ({ severity: 'P1', title: '空指针', trigger: 't', behavior: 'b', impact: 'i', fix: 'f', verify: 'v', evidence: [{ path: 'src/a.ts', line: 1 }],
  instances: [], origin: 'introduced', bugClass: 'null-deref', supersedes: null, path: 'src/a.ts', line: 1, side: 'RIGHT', ...over });
const KEY = findingKeyOf({ path: 'src/a.ts', bugClass: 'null-deref', title: '空指针' });
const thread = (key, head, { author = 'bot', url = 'https://x/t', body } = {}) => ({ id: `T-${key}-${head}`, path: 'src/a.ts',
  comments: [{ author: { login: author }, url, body: body ?? `[P1] 空指针\n\n${findingMarker({ key, round: 1, head, bugClass: 'null-deref' })}` }] });
const history = (threads) => collectMarkerHistory({ threads, reviewer: 'bot', currentHead: HEAD });
const run = (over = {}) => applyConvergence({ findings: [v2()], scope: { mode: 'full' }, roundIndex: 1, previousRound: null, history: history([]), head: HEAD, ...over });

test('marker 历史:只看审查账号的 [P0]/[P1] thread;当前 head 的 marker 不计(重试幂等)', () => {
  const h = history([thread(KEY, H(1)), thread(KEY, H(2)), thread(KEY, HEAD.slice(0, 12)), thread('bbbbbbbbbbbb', H(3), { author: 'someone' }),
    thread(KEY, H(4), { body: '[P1] 旧 thread,没有 marker' })]);
  assert.deepEqual([...h.heads].sort(), [H(1), H(2)]);
  assert.equal(h.byKey.get(KEY).size, 2);
  assert.equal(h.reviewerThreads, 3);
  assert.equal(h.legacyThreads, 1);
  assert.equal(h.threadUrlByKey.get(KEY), 'https://x/t');
});

test('roundIndexOf 四种分支', () => {
  assert.equal(roundIndexOf({ previousRound: { roundIndex: 2 }, hasPrevious: true, history: history([]) }), 3, '沿上一轮结果链');
  assert.equal(roundIndexOf({ previousRound: null, hasPrevious: true, history: history([thread(KEY, H(1)), thread(KEY, H(2))]) }), 3, '数 thread marker');
  assert.equal(roundIndexOf({ previousRound: { roundIndex: null }, hasPrevious: true, history: history([]) }), null, '有历史但数不出,不猜');
  assert.equal(roundIndexOf({ previousRound: null, hasPrevious: false, history: history([]) }), 1);
  assert.equal(roundIndexOf({ previousRound: null, hasPrevious: false, history: history([thread(KEY, H(1), { body: '[P1] 旧' })]) }), null);
});

test('上一轮结果包 → previousRound;旧结果(没有 key/convergence)不报错', () => {
  const prev = toPreviousRound({ mivo: { findings: [{ key: KEY, seenRounds: 2, severity: 'P1' }, { body: '[P1] 旧' }], deferred: [{ key: 'cccccccccccc' }], preexisting: [], convergence: { roundIndex: 4 } } });
  assert.equal(prev.roundIndex, 4);
  assert.deepEqual(prev.findings, [{ key: KEY, seenRounds: 2, severity: 'P1' }]);
  assert.deepEqual([...prev.keys].sort(), [KEY, 'cccccccccccc'].sort());
  assert.deepEqual(toPreviousRound({ mivo: { findings: [{ body: '[P1] 旧' }] } }), { roundIndex: null, findings: [], keys: new Set() });
  assert.deepEqual(toPreviousRound({}), { roundIndex: null, findings: [], keys: new Set() });
});

test('seenRounds:沿结果链 +1;回退数 marker;legacy 记 2;新问题记 1', () => {
  const chain = run({ findings: [v2({ supersedes: KEY })], previousRound: { roundIndex: 1, findings: [{ key: KEY, seenRounds: 2 }], keys: new Set([KEY]) } });
  assert.equal(chain.findings[0].seenRounds, 3);
  assert.equal(chain.findings[0].key, KEY);
  const byMarker = run({ findings: [v2({ supersedes: KEY })], history: history([thread(KEY, H(1)), thread(KEY, H(2))]) });
  assert.equal(byMarker.findings[0].seenRounds, 3);
  const legacy = run({ findings: [v2({ supersedes: 'legacy-1' })], scope: { mode: 'incremental', previousFindings: [{ body: '[P1] x' }], changedFiles: ['src/a.ts'] } });
  assert.equal(legacy.findings[0].seenRounds, 2);
  assert.equal(run().findings[0].seenRounds, 1);
  assert.equal(run({ findings: [v2({ supersedes: 'abcdef012345' })] }).findings[0].key, KEY, '不认识的 key 退回按内容算');
});

test('全量轮看不到上一轮清单:算出的 key 命中上一轮 key 时按 supersedes 处理', () => {
  const r = run({ findings: [v2()], previousRound: { roundIndex: 1, findings: [{ key: KEY, seenRounds: 1 }], keys: new Set([KEY]) } });
  assert.equal(r.findings[0].seenRounds, 2);
});

test('第 3 轮同一 key 的 P0/P1 才出收敛提示;结论(阻断列表)不变', () => {
  const p = (seen) => ({ roundIndex: seen, findings: [{ key: KEY, seenRounds: seen }], keys: new Set([KEY]) });
  assert.equal(run({ findings: [v2({ supersedes: KEY })], previousRound: p(1) }).convergence.rethink, false, '第 2 轮不提示');
  const third = run({ findings: [v2({ supersedes: KEY }), v2({ title: '另一个新问题', supersedes: null })], previousRound: p(2), roundIndex: 3, history: history([thread(KEY, H(1))]) });
  assert.equal(third.convergence.rethink, true);
  assert.deepEqual(third.convergence.stuckKeys, [KEY]);
  assert.equal(third.findings.length, 2, '提示不改阻断');
  assert.equal(third.convergence.repeatCount, 1);
  const lines = renderConvergenceSection(third.convergence, third.stuck);
  assert.equal(lines[0], '## 收敛提示');
  assert.ok(lines.join('\n').includes('已连续 3 轮'));
  assert.ok(lines.join('\n').includes('[thread](https://x/t)'));
  assert.deepEqual(renderConvergenceSection(run().convergence, run().stuck), []);
});

test('deferred / preexisting / ruledKept 不计入 stuck,但都带 key 与 marker', () => {
  const prev = { roundIndex: 5, findings: [{ key: KEY, seenRounds: 5 }], keys: new Set([KEY]) };
  const r = run({ findings: [], preexisting: [v2({ origin: 'pre-existing', supersedes: KEY })], deferred: [{ ...v2({ supersedes: KEY }), deferredTo: 9 }], previousRound: prev });
  assert.equal(r.stuck.length, 0);
  assert.equal(r.convergence.rethink, false);
  assert.equal(parseFindingMarker(r.preexisting[0].body).key, KEY);
  assert.equal(parseFindingMarker(r.deferred[0].body).key, KEY);
  assert.equal(r.deferred[0].deferredTo, 9);
});

test('带 key 的裁定:P1 移入 ruledKept 并计 rulingViolations;同 key 的 P0 永不移出阻断', () => {
  const rulings = [{ key: KEY, by: 'owner', severity: 'P1' }];
  const p1 = run({ rulings });
  assert.equal(p1.findings.length, 0);
  assert.deepEqual(p1.ruledKept, [{ key: KEY, severity: 'P1', path: 'src/a.ts', line: 1, title: '空指针', rulingBy: 'owner' }]);
  assert.equal(p1.convergence.rulingViolations, 1);
  const p0 = run({ findings: [v2({ severity: 'P0' })], rulings });
  assert.equal(p0.findings.length, 1, 'P0 永不移出阻断');
  assert.equal(p0.ruledKept.length, 0);
  assert.equal(p0.convergence.rulingViolations, 1);
  assert.equal(run({ rulings: [{ by: 'owner' }] }).findings.length, 1, '没有 key 的裁定不参与复核');
});

test('late 只在增量轮、无 supersedes、文件本轮没改过时为 true', () => {
  const inc = (changedFiles, supersedes = null) => applyConvergence({ findings: [v2({ supersedes })], scope: { mode: 'incremental', changedFiles, previousFindings: [] }, roundIndex: 2,
    previousRound: null, history: history([]), head: HEAD }).findings[0].late;
  assert.equal(inc(['other.ts']), true);
  assert.equal(inc(['src/a.ts']), false);
  assert.equal(inc(['other.ts'], 'legacy-1'), false);
  assert.equal(run().findings[0].late, false);
});

test('v1 项(只有 body)也分配 key 并追加 marker', () => {
  const r = run({ findings: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: '[P1] 旧格式问题\n影响' }] });
  assert.match(r.findings[0].key, /^[0-9a-f]{12}$/);
  assert.equal(r.findings[0].severity, 'P1');
  assert.ok(r.findings[0].body.startsWith('[P1] 旧格式问题\n影响\n\n<!-- mivo-finding key='));
});

test('collectRulings 解析 thread 里的 marker key;没有 marker 时不加字段', () => {
  const first = (body) => ({ author: { login: 'bot' }, body });
  const reply = { author: { login: 'owner' }, body: '维护者裁定不改: 产品意图' };
  const out = collectRulings({ threads: [
    { id: 't1', path: 'a.ts', line: 1, comments: [first(`[P1] 有 key\n\n${findingMarker({ key: KEY, round: 1, head: H(1) })}`), reply] },
    { id: 't2', path: 'b.ts', line: 2, comments: [first('[P1] 老 thread'), reply] },
  ], reviewer: 'bot', maintainers: ['owner'] });
  assert.equal(out.verified[0].key, KEY);
  assert.equal('key' in out.verified[1], false);
});
