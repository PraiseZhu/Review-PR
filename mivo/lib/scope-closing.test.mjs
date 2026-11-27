// 链式收口(#262)的范围判定:小改动只审改动处;连续 2 轮只审改动、累计改动超限、没有上次全量记录 → 全量;
// 改动行数按两个版本之间真实增删的行数算;closing 缺省时行为与 #100(放行前一律收口全量)一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiffByFile, filePatchHashes, computeReviewScope, previousFromResult, loadClosingPolicy, parseNumstat, readSinceFull, nextSinceFull, readFinalFull } from './scope.mjs';

const SHA0 = 'a'.repeat(40);
const SHA1 = 'b'.repeat(40);
const ANCHOR = 'c'.repeat(40);
const CHAIN = { mode: 'chain', maxIncrementalRounds: 2, maxChangedLines: 400 };
const NOW = Date.parse('2026-11-27T12:00:00Z');
const patch = (path, body) => ['diff --git a/' + path + ' b/' + path, 'index 111..222 100644', '--- a/' + path, '+++ b/' + path, '@@ -1,1 +1,2 @@', ' keep', body].join('\n');
const hashesOf = (bodies) => filePatchHashes(splitDiffByFile(Object.entries(bodies).map(([path, body]) => patch(path, body)).join('\n')));
const since = (over = {}) => ({ head: ANCHOR, runId: '40', totalDiffLines: 1000, rounds: 0, changedLines: 0, ...over });
const FINDING = { path: 'src/a.ts', line: 2, body: '[P1] 旧问题', key: 'k1', severity: 'P1' };
// 上一轮:PR 有 a/b/c 三个文件,整份 diff 1000 行;默认带一条未修的问题(不是「已干净」)。
const previous = (over = {}) => ({
  head: SHA0, baseRefName: 'main', diffHash: 'd0', reviewed: true, reportComplete: true, outcome: 'findings', reviewClean: false, findings: [FINDING], deferred: [],
  filePatchHashes: hashesOf({ 'src/a.ts': '+a-old', 'src/b.ts': '+b', 'src/c.ts': '+c' }), totalDiffLines: 1000, tier: 'standard', triggerKinds: [],
  specDigest: 'spec-1', lastFullReviewAt: '2026-11-26T12:00:00Z', sinceFull: since(), ...over,
});
// 本轮:只有 a.ts 的补丁变了。a.ts 在整个 PR 里的补丁有 600 行(旧口径),两个版本之间真实只改了 40 行。
const current = (over = {}) => ({
  head: SHA1, baseRefName: 'main', diffHash: 'd1', filePatchHashes: hashesOf({ 'src/a.ts': '+a-new', 'src/b.ts': '+b', 'src/c.ts': '+c' }),
  fileChangedLines: { 'src/a.ts': 600, 'src/b.ts': 200, 'src/c.ts': 200 }, deltaLinesByFile: { 'src/a.ts': 40 }, totalDiffLines: 1000,
  tier: 'standard', triggerKinds: [], specDigest: 'spec-1', now: NOW, ...over,
});
const scopeOf = (prev, cur, closing = CHAIN) => computeReviewScope({ previous: prev, current: cur, headIsDescendant: true, closing });

test('SC1 链式:改动在限额内 → 增量,带「不再全量」的依据与本轮之后的链状态', () => {
  const scope = scopeOf(previous(), current());
  assert.equal(scope.mode, 'incremental');
  assert.deepEqual(scope.files, ['src/a.ts']);
  assert.deepEqual(scope.closing, { skipFinalFull: true, basedOn: { head: ANCHOR, runId: '40' }, anchorTotalDiffLines: 1000, rounds: 1, changedLines: 40, deltaLines: 40 });
  assert.equal(scope.finalFullExemption, undefined, '链式收口下不再用修复轮豁免');
});

test('SC1 链式:累计改动接着上一轮的数往上加', () => {
  const scope = scopeOf(previous({ sinceFull: since({ rounds: 1, changedLines: 120 }) }), current());
  assert.equal(scope.mode, 'incremental');
  assert.equal(scope.closing.rounds, 2);
  assert.equal(scope.closing.changedLines, 160);
});

test('SC2 链式:已连续 2 轮只审改动 → 全量', () => {
  const scope = scopeOf(previous({ sinceFull: since({ rounds: 2, changedLines: 80 }) }), current());
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /已连续 2 轮只审改动,本轮全量/);
  assert.equal(scope.closing, undefined);
  assert.deepEqual(scope.previousFindings.map((f) => f.key), ['k1'], '全量轮照常带着上一轮的问题');
});

test('SC2 链式:累计改动超过 400 行 → 全量;正好 400 行仍是增量', () => {
  const over = scopeOf(previous({ sinceFull: since({ rounds: 1, changedLines: 361 }) }), current());
  assert.equal(over.mode, 'full');
  assert.match(over.reason, /累计改动 401 行,超过 400 行上限/);
  const at = scopeOf(previous({ sinceFull: since({ rounds: 1, changedLines: 360 }) }), current());
  assert.equal(at.mode, 'incremental');
  assert.equal(at.closing.changedLines, 400);
});

test('SC2 链式:累计改动超过上次全量时 diff 的一半 → 全量', () => {
  const prev = previous({ totalDiffLines: 200, sinceFull: since({ totalDiffLines: 120, rounds: 1, changedLines: 30 }) });
  const scope = scopeOf(prev, current({ totalDiffLines: 200 }));
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /累计改动 70 行,超过当时 diff\(120 行\)的一半/);
});

test('SC2 链式:没有可用的上次全量记录 → 全量', () => {
  const scope = scopeOf(previous({ sinceFull: null }), current());
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /没有可用的上次全量记录/);
});

test('SC2 链式:上一轮已干净、本轮小改动 → 走同一套判定(增量),不再直接全量;旧行为下仍直接全量', () => {
  const clean = previous({ reviewClean: true, findings: [] });
  const chain = scopeOf(clean, current());
  assert.equal(chain.mode, 'incremental');
  assert.equal(chain.closing.skipFinalFull, true);
  const legacy = scopeOf(clean, current(), null);
  assert.equal(legacy.mode, 'full');
  assert.match(legacy.reason, /上一轮已干净,本轮代码有变化,直接全量/);
});

test('SC2 链式:代码没变(没有改动文件、没有旧问题)仍沿用上次结论,不算一轮', () => {
  const clean = previous({ reviewClean: true, findings: [], head: SHA1, diffHash: 'd1', filePatchHashes: current().filePatchHashes });
  const scope = computeReviewScope({ previous: clean, current: current(), headIsDescendant: null, closing: CHAIN });
  assert.equal(scope.mode, 'reuse');
});

test('SC3 #2887 形状:上版 diff 1006 行,本轮改 3 个文件真实共 73 行(这 3 个文件整份补丁共 822 行)→ 链式判增量;旧行为判全量', () => {
  const before = hashesOf({ 'src/x.ts': '+x0', 'src/y.ts': '+y0', 'docs/pr/2887/review.md': '+r0', 'src/z.ts': '+z' });
  const after = hashesOf({ 'src/x.ts': '+x1', 'src/y.ts': '+y1', 'docs/pr/2887/review.md': '+r1', 'src/z.ts': '+z' });
  const prev = previous({ filePatchHashes: before, totalDiffLines: 1006, sinceFull: since({ totalDiffLines: 1006 }) });
  const cur = current({ filePatchHashes: after, totalDiffLines: 1010,
    fileChangedLines: { 'src/x.ts': 500, 'src/y.ts': 250, 'docs/pr/2887/review.md': 72, 'src/z.ts': 188 },
    deltaLinesByFile: { 'src/x.ts': 41, 'src/y.ts': 20, 'docs/pr/2887/review.md': 12 } });
  const chain = scopeOf(prev, cur);
  assert.equal(chain.mode, 'incremental');
  assert.equal(chain.closing.deltaLines, 73);
  const legacy = scopeOf(prev, cur, null);
  assert.equal(legacy.mode, 'full');
  assert.match(legacy.reason, /变化行数 822 超过上一版 diff\(1006 行\)的一半/);
});

test('SC3 拿不到两个版本之间的行数 → 链式也退回按文件补丁行数算(只会更容易全量)', () => {
  const scope = scopeOf(previous(), current({ deltaLinesByFile: undefined }));
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /变化行数 600 超过上一版 diff\(1000 行\)的一半/);
});

test('SC3 单个文件没有行数(二进制,或两版内容没变但补丁变了)按它的补丁行数算', () => {
  const scope = scopeOf(previous(), current({ fileChangedLines: { 'src/a.ts': 90 }, deltaLinesByFile: { 'src/a.ts': null } }));
  assert.equal(scope.mode, 'incremental');
  assert.equal(scope.closing.deltaLines, 90);
  const missing = scopeOf(previous(), current({ fileChangedLines: { 'src/a.ts': 90 }, deltaLinesByFile: {} }));
  assert.equal(missing.closing.deltaLines, 90);
});

test('SC3 真实改动超过上一版 diff 的一半 → 全量(这条兜底在链式下照常生效)', () => {
  const scope = scopeOf(previous({ totalDiffLines: 60, sinceFull: since({ totalDiffLines: 60 }) }), current({ totalDiffLines: 60 }));
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /变化行数 40 超过上一版 diff\(60 行\)的一半/);
});

test('SC3 parseNumstat:-z 输出按文件给增删行数之和;二进制记 null;路径里的空格和中文原样保留', () => {
  const out = ['3\t4\tsrc/a.ts', '-\t-\tassets/logo.png', '10\t0\tdocs/说明 文档.md', ''].join('\0');
  assert.deepEqual(parseNumstat(out), { 'src/a.ts': 7, 'assets/logo.png': null, 'docs/说明 文档.md': 10 });
  assert.deepEqual(parseNumstat(''), {});
  assert.deepEqual(parseNumstat(null), {});
});

test('SC4 其它兜底先于链判定:7 天、强推、档位升级照常全量', () => {
  const old = scopeOf(previous({ lastFullReviewAt: '2026-11-01T00:00:00Z' }), current());
  assert.match(old.reason, /距上次完整审查超过 7 天/);
  const forced = computeReviewScope({ previous: previous(), current: current(), headIsDescendant: false, closing: CHAIN });
  assert.match(forced.reason, /强制推送或 rebase/);
  const tier = scopeOf(previous(), current({ tier: 'heavy' }));
  assert.match(tier.reason, /档位升级/);
});

test('SC4 后来发现开关回退把增量改成全量时,不带「不再全量」标记', () => {
  const prev = previous({ lateFindings: [{ path: 'src/b.ts', line: 1, body: '[P2] 后来发现', key: 'late1', severity: 'P2' }] });
  const scope = computeReviewScope({ previous: prev, current: current(), headIsDescendant: true, closing: CHAIN, lateFindingsMode: 'off' });
  assert.equal(scope.mode, 'full');
  assert.equal(scope.closing, undefined);
});

test('SC4 loadClosingPolicy:缺块或 final-full → 旧行为且不告警;chain 取数值(缺省 2 轮 / 400 行)', () => {
  const load = (value) => loadClosingPolicy(() => JSON.stringify(value));
  assert.deepEqual(load({}), { mode: 'final-full', warning: null });
  assert.deepEqual(load({ closing: { mode: 'final-full' } }), { mode: 'final-full', warning: null });
  assert.deepEqual(load({ closing: { mode: 'chain', maxIncrementalRounds: 3, maxChangedLines: 250 } }), { mode: 'chain', maxIncrementalRounds: 3, maxChangedLines: 250, warning: null });
  assert.deepEqual(load({ closing: { mode: 'chain' } }), { mode: 'chain', maxIncrementalRounds: 2, maxChangedLines: 400, warning: null });
});

test('SC4 loadClosingPolicy:读不到、不是对象、字段不合法 → 旧行为 + 固定告警(不回显配置原文)', () => {
  const broken = loadClosingPolicy(() => { throw new Error('ENOENT secret-path'); });
  assert.equal(broken.mode, 'final-full');
  assert.match(broken.warning, /读不到或不合法/);
  assert.doesNotMatch(broken.warning, /secret-path/);
  for (const closing of ['chain', { mode: 'fast' }, { mode: 'chain', maxIncrementalRounds: 0 }, { mode: 'chain', maxIncrementalRounds: 1.5 },
    { mode: 'chain', maxChangedLines: '400' }, { mode: 'chain', maxChangedLines: 0 }, { mode: 'chain', maxIncrementalRounds: 11 }]) {
    const policy = loadClosingPolicy(() => JSON.stringify({ closing }));
    assert.equal(policy.mode, 'final-full', JSON.stringify(closing));
    assert.match(policy.warning, /closing 配置不合法/);
  }
  assert.equal(loadClosingPolicy(() => '[]').mode, 'final-full');
});

test('SC4 仓里的 review-features.json 启用了 chain,2 轮 / 400 行', async () => {
  const { readFileSync } = await import('node:fs');
  const policy = loadClosingPolicy(() => readFileSync(new URL('../config/review-features.json', import.meta.url), 'utf8'));
  assert.deepEqual(policy, { mode: 'chain', maxIncrementalRounds: 2, maxChangedLines: 400, warning: null });
});

test('SC4 closing 配置不完整(手工构造)按旧行为判定', () => {
  const scope = scopeOf(previous({ reviewClean: true, findings: [] }), current(), { mode: 'chain' });
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /上一轮已干净/);
});

test('SC5 readSinceFull:只认形状完整的值', () => {
  assert.deepEqual(readSinceFull(since({ rounds: 1, changedLines: 73 })), since({ rounds: 1, changedLines: 73 }));
  assert.deepEqual(readSinceFull({ ...since(), runId: 40 }), since(), 'runId 统一成字符串');
  for (const bad of [null, [], { ...since(), head: 'abc' }, { ...since(), rounds: -1 }, { ...since(), rounds: 1.5 }, { ...since(), changedLines: 'x' },
    { ...since(), totalDiffLines: -5 }, { ...since(), runId: 'run-1' }]) assert.equal(readSinceFull(bad), null, JSON.stringify(bad));
});

test('SC5 previousFromResult:有 sinceFull 用它;没有时从做完的收口/全量(clean/findings)推出起点;推不出为 null', () => {
  const result = (mivo) => ({ head: SHA0, reviewed: true, outcome: 'findings', mivo: { reportComplete: true, totalDiffLines: 500, ...mivo } });
  assert.deepEqual(previousFromResult(result({ sinceFull: since({ rounds: 2, changedLines: 90 }) })).sinceFull, since({ rounds: 2, changedLines: 90 }));
  for (const outcome of ['clean', 'findings']) {
    assert.deepEqual(previousFromResult(result({ finalFull: { head: SHA0, runId: '41', outcome } })).sinceFull,
      { head: SHA0, runId: '41', totalDiffLines: 500, rounds: 0, changedLines: 0 }, outcome);
  }
  // 沿用轮原样带着来源的 finalFull(来源 head 与本结果的 head 不同),同样能推出起点。
  assert.equal(previousFromResult(result({ finalFull: { head: ANCHOR, runId: '39', outcome: 'clean' } })).sinceFull.head, ANCHOR);
  for (const outcome of ['skipped-fix-round', 'skipped-small-delta', 'pending-budget', 'error', 'manual-review']) {
    assert.equal(previousFromResult(result({ finalFull: { head: SHA0, runId: '41', outcome } })).sinceFull, null, outcome);
  }
  assert.equal(previousFromResult(result({})).sinceFull, null, '增量里有问题没进收口的旧结果包:推不出');
  assert.equal(previousFromResult(result({ sinceFull: { head: 'bad' }, finalFull: { head: SHA0, runId: '41', outcome: 'clean' } })).sinceFull.runId, '41', '畸形的 sinceFull 当没有');
});

test('SC5 readFinalFull 认 skipped-small-delta', () => {
  assert.deepEqual(readFinalFull({ head: SHA0, runId: '41', outcome: 'skipped-small-delta', basedOn: { head: ANCHOR, runId: '40' }, rounds: 1, changedLines: 40 }),
    { head: SHA0, runId: '41', outcome: 'skipped-small-delta' });
});

test('SC5 nextSinceFull:全量(含同一次运行里的收口全量)归零;链式增量轮按 closing 里的数;其余没有可靠状态', () => {
  const zero = { head: SHA1, runId: '42', totalDiffLines: 1000, rounds: 0, changedLines: 0 };
  assert.deepEqual(nextSinceFull({ scope: { mode: 'full' }, head: SHA1, runId: '42', totalDiffLines: 1000 }), zero);
  assert.deepEqual(nextSinceFull({ scope: { mode: 'incremental' }, effectiveScope: { mode: 'full', purpose: 'final-full' }, head: SHA1, runId: '42', totalDiffLines: 1000 }), zero);
  const chain = scopeOf(previous({ sinceFull: since({ rounds: 1, changedLines: 120 }) }), current());
  assert.deepEqual(nextSinceFull({ scope: chain, head: SHA1, runId: '42', totalDiffLines: 1000 }), since({ rounds: 2, changedLines: 160 }));
  assert.equal(nextSinceFull({ scope: { mode: 'incremental' }, head: SHA1, runId: '42', totalDiffLines: 1000 }), null, '旧行为下的增量轮不记链状态');
  assert.equal(nextSinceFull({ scope: { mode: 'reuse' }, head: SHA1, runId: '42', totalDiffLines: 1000 }), null);
  assert.equal(nextSinceFull({ scope: { mode: 'full' }, head: 'not-a-sha', runId: '42', totalDiffLines: 1000 }), null);
});

test('SC5 一条 PR 走完四轮:全量 → 增量 → 增量 → 全量(超过 3 轮就全量)', () => {
  const rounds = [];
  let sinceFull = nextSinceFull({ scope: { mode: 'full' }, head: SHA0, runId: '1', totalDiffLines: 1000 });
  for (let i = 2; i <= 4; i += 1) {
    const scope = scopeOf(previous({ sinceFull }), current());
    rounds.push(scope.mode);
    sinceFull = nextSinceFull({ scope, head: SHA1, runId: String(i), totalDiffLines: 1000 });
  }
  assert.deepEqual(rounds, ['incremental', 'incremental', 'full']);
  assert.deepEqual(sinceFull, { head: SHA1, runId: '4', totalDiffLines: 1000, rounds: 0, changedLines: 0 }, '第 4 轮全量后重新起算');
});
